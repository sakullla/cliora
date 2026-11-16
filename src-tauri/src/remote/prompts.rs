//! Prompt metadata and idempotency receipts live beside the legacy library on the same host.
//! Both files are observed and committed together through the existing remote transaction service.
use super::*;
use crate::prompts::{
    self, BatchAction, BatchResult, PromptBatch, PromptDocument, PromptPage, PromptQuery,
    PromptUsage, RemotePromptState,
};

const LIBRARY_PATH: &str = "$HOME/.cliora/library.json";
const STATE_PATH: &str = "$HOME/.cliora/prompts-v1.json";
#[derive(Clone, Serialize)]
struct Snapshot {
    items: Vec<crate::library::LibraryItem>,
    state: RemotePromptState,
}
fn parse_snapshot(output: &str) -> Result<Snapshot, RemoteError> {
    let mut lines = output.lines();
    if lines.next() != Some("__PROMPT_LIBRARY__") {
        return Err(RemoteError::Storage("远程提示词读取结果不完整".into()));
    }
    let library = lines
        .next()
        .ok_or_else(|| RemoteError::Storage("远程资料库读取结果不完整".into()))?;
    if lines.next() != Some("__PROMPT_STATE__") {
        return Err(RemoteError::Storage("远程提示词范围读取结果不完整".into()));
    }
    let state = lines
        .next()
        .ok_or_else(|| RemoteError::Storage("远程提示词范围读取结果不完整".into()))?;
    if lines.any(|line| !line.trim().is_empty()) {
        return Err(RemoteError::Storage("远程提示词读取结果含未知内容".into()));
    }
    observe_encoded(LIBRARY_PATH, library);
    observe_encoded(STATE_PATH, state);
    let items = if library == "__MISSING__" {
        Vec::new()
    } else {
        serde_json::from_str(
            &decode_b64_text(library)
                .ok_or_else(|| RemoteError::Storage("远程资料库不是有效 UTF-8 内容".into()))?,
        )
        .map_err(|e| RemoteError::Storage(format!("远程资料库格式无效：{e}")))?
    };
    let state: RemotePromptState = if state == "__MISSING__" {
        RemotePromptState::default()
    } else {
        serde_json::from_str(
            &decode_b64_text(state)
                .ok_or_else(|| RemoteError::Storage("远程提示词范围不是有效 UTF-8 内容".into()))?,
        )
        .map_err(|e| RemoteError::Storage(format!("远程提示词范围格式无效，未覆盖：{e}")))?
    };
    if state.schema_version != 1 {
        return Err(RemoteError::Storage(
            "远程提示词范围版本不受支持，未覆盖".into(),
        ));
    }
    Ok(Snapshot { items, state })
}
fn read_snapshot(target: &RemoteTarget) -> Result<Snapshot, RemoteError> {
    // run_command accepts a bounded single command line; literal newlines are rejected
    // by its control-character guard. Keep this constant script single-line as well.
    let script = concat!(
        r#"if [ -e "$HOME/.cliora" ] || [ -L "$HOME/.cliora" ]; then [ ! -L "$HOME/.cliora" ] && [ -d "$HOME/.cliora" ] && [ -r "$HOME/.cliora" ] && [ -x "$HOME/.cliora" ] || { printf '%s\n' 'cliora:directory-access: 提示词资料目录不可读取或不是普通目录。' >&2; exit 46; }; fi; "#,
        r#"read_prompt_file() { prompt_file=$1; if [ -e "$prompt_file" ] || [ -L "$prompt_file" ]; then [ ! -L "$prompt_file" ] && [ -f "$prompt_file" ] && [ -r "$prompt_file" ] || { printf '%s\n' 'cliora:directory-access: 提示词资料不是可读取的普通文件。' >&2; return 46; }; prompt_encoded=$(base64 < "$prompt_file") || return 46; printf %s "$prompt_encoded" | tr -d '\n'; else printf %s __MISSING__; fi; }; "#,
        r#"printf '%s\n' __PROMPT_LIBRARY__; read_prompt_file "$HOME/.cliora/library.json" || exit 46; printf '\n'; printf '%s\n' __PROMPT_STATE__; read_prompt_file "$HOME/.cliora/prompts-v1.json" || exit 46; printf '\n';"#,
    );
    parse_snapshot(&run_command(target, script)?.stdout)
}
fn cached_snapshot(target: &RemoteTarget) -> Result<Snapshot, RemoteError> {
    let owned = target.clone();
    read_cache::read(target, "prompt_snapshot", false, move || {
        read_snapshot(&owned)
    })
}
fn documents(snapshot: &Snapshot) -> Vec<PromptDocument> {
    snapshot
        .items
        .iter()
        .filter(|item| item.kind == crate::library::LibraryKind::Prompt)
        .map(|item| prompts::remote_document(item, &snapshot.state))
        .collect()
}
pub fn list(target: &RemoteTarget) -> Result<Vec<PromptDocument>, RemoteError> {
    Ok(documents(&cached_snapshot(target)?))
}
pub fn query(
    target: &RemoteTarget,
    query: &PromptQuery,
    usage: &BTreeMap<String, PromptUsage>,
) -> Result<PromptPage, RemoteError> {
    Ok(prompts::query_documents(&list(target)?, usage, query))
}
pub fn get(
    target: &RemoteTarget,
    id: &str,
    version: Option<u64>,
) -> Result<PromptDocument, RemoteError> {
    let snapshot = read_snapshot(target)?;
    let item = documents(&snapshot)
        .into_iter()
        .find(|item| item.id == id)
        .ok_or(RemoteError::NotFound)?;
    if version.is_some_and(|v| v != item.version) {
        return Err(RemoteError::Storage(
            "提示词已更新，请重新选择后预览".into(),
        ));
    }
    Ok(item)
}
pub fn apply_batch(
    target: &RemoteTarget,
    db: &Database,
    batch: &PromptBatch,
) -> Result<BatchResult, RemoteError> {
    prompts::validate_batch(batch).map_err(RemoteError::Storage)?;
    let mut snapshot = read_snapshot(target)?;
    let mut results = Vec::new();
    let mut changed = false;
    for item in &batch.items {
        let key = format!("{}:{}", batch.operation_id, item.item_id);
        match prompts::replay_receipt(item, snapshot.state.receipts.get(&key)) {
            Ok(Some(result)) => {
                results.push(result);
                continue;
            }
            Err(error) => {
                results.push(prompts::remote_failure(item, error));
                continue;
            }
            Ok(None) => {}
        }
        if item.action != BatchAction::Skip {
            if let Err(error) = prompts::validate_draft_scope(db, &item.draft) {
                results.push(prompts::remote_failure(item, error));
                continue;
            }
        }
        match prompts::apply_remote_item(
            &mut snapshot.items,
            &mut snapshot.state,
            &batch.operation_id,
            item,
        ) {
            Ok(result) => {
                changed = true;
                results.push(result);
            }
            Err(error) => results.push(prompts::remote_failure(item, error)),
        }
    }
    // Per-item validation/receipts, one shared-file transaction. A second commit under the
    // same operation would conflict with that operation's immutable original expected_files.
    // No predicted Saved result escapes until the complete file pair actually commits.
    if changed {
        let files = vec![
            (
                LIBRARY_PATH.into(),
                serde_json::to_vec(&snapshot.items)
                    .map_err(|e| RemoteError::Storage(e.to_string()))?,
            ),
            (
                STATE_PATH.into(),
                serde_json::to_vec(&snapshot.state)
                    .map_err(|e| RemoteError::Storage(e.to_string()))?,
            ),
        ];
        apply_upload(target, &prepare_upload(&[], &files)?)?;
    }
    Ok(BatchResult {
        operation_id: batch.operation_id.clone(),
        items: results,
        write_applied: changed,
    })
}

pub fn delete(target: &RemoteTarget, id: &str, version: u64) -> Result<(), RemoteError> {
    let mut snapshot = read_snapshot(target)?;
    let index = snapshot
        .items
        .iter()
        .position(|item| item.id == id && item.kind == crate::library::LibraryKind::Prompt)
        .ok_or(RemoteError::NotFound)?;
    if snapshot.items[index].version != version {
        return Err(RemoteError::Storage(
            "提示词版本已变化，请刷新后重试".into(),
        ));
    }
    snapshot.items.remove(index);
    snapshot.state.metadata.remove(id);
    let files = vec![
        (
            LIBRARY_PATH.into(),
            serde_json::to_vec(&snapshot.items).map_err(|e| RemoteError::Storage(e.to_string()))?,
        ),
        (
            STATE_PATH.into(),
            serde_json::to_vec(&snapshot.state).map_err(|e| RemoteError::Storage(e.to_string()))?,
        ),
    ];
    apply_upload(target, &prepare_upload(&[], &files)?)
}

pub fn namespace(target: &RemoteTarget) -> String {
    format!(
        "remote:{}:{}:{}:{}",
        target.id, target.host, target.port, target.user
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn real_read_transport_distinguishes_missing_from_wrong_type_and_invalid_data() {
        let target = RemoteTarget {
            id: Uuid::new_v4().to_string(),
            name: "fixture".into(),
            host: "fixture.invalid".into(),
            port: 22,
            user: "fixture".into(),
            auth_method: "key".into(),
            identity_file: None,
            ssh_config: None,
            default_path: None,
            enabled: true,
            created_at: 1,
            updated_at: 1,
        };
        super::super::tests::with_local_transport(&target, |_| {
            assert!(read_snapshot(&target).unwrap().items.is_empty());
            run_command(&target, "mkdir -p \"$HOME/.cliora/library.json\"").unwrap();
            assert!(read_snapshot(&target).is_err());
            run_command(&target,"rmdir \"$HOME/.cliora/library.json\"; printf '[]' > \"$HOME/.cliora/library.json\"; mkdir \"$HOME/.cliora/prompts-v1.json\"").unwrap();
            assert!(read_snapshot(&target).is_err());
            run_command(&target,"rmdir \"$HOME/.cliora/prompts-v1.json\"; printf invalid > \"$HOME/.cliora/prompts-v1.json\"").unwrap();
            assert!(read_snapshot(&target).is_err());
        });
    }
    #[test]
    fn strict_snapshot_preserves_metadata_and_rejects_unknown_schema() {
        let item = crate::library::LibraryItem {
            id: "prompt".into(),
            kind: crate::library::LibraryKind::Prompt,
            title: "标题".into(),
            body: "正文".into(),
            category: String::new(),
            project_id: None,
            version: 1,
            updated_at: 1,
        };
        let mut state = RemotePromptState::default();
        state.metadata.insert(
            "prompt".into(),
            crate::prompts::PromptMetadata {
                scope: crate::prompts::PromptScope::Workspace {
                    workspace_id: "workspace".into(),
                },
                tags: vec!["review".into()],
            },
        );
        let encode = |value: &[u8]| base64::engine::general_purpose::STANDARD.encode(value);
        let snapshot = format!(
            "__PROMPT_LIBRARY__\n{}\n__PROMPT_STATE__\n{}\n",
            encode(&serde_json::to_vec(&vec![item]).unwrap()),
            encode(&serde_json::to_vec(&state).unwrap())
        );
        let parsed = parse_snapshot(&snapshot).unwrap();
        assert_eq!(documents(&parsed)[0].scope, state.metadata["prompt"].scope);
        state.schema_version = 99;
        let invalid = format!(
            "__PROMPT_LIBRARY__\n__MISSING__\n__PROMPT_STATE__\n{}\n",
            encode(&serde_json::to_vec(&state).unwrap())
        );
        assert!(parse_snapshot(&invalid).is_err());
        assert!(
            parse_snapshot("__PROMPT_LIBRARY__\nnot-base64\n__PROMPT_STATE__\n__MISSING__\n")
                .is_err()
        );
    }
}

// The production remote transaction deliberately requires GNU stat/flock. The local POSIX
// transport verifies the real paired-file commit on Linux CI, not a live SSH host on macOS.
#[cfg(all(test, target_os = "linux"))]
mod transaction_tests {
    use super::*;
    fn target() -> RemoteTarget {
        RemoteTarget {
            id: Uuid::new_v4().to_string(),
            name: "fixture".into(),
            host: "fixture.invalid".into(),
            port: 22,
            user: "fixture".into(),
            auth_method: "key".into(),
            identity_file: None,
            ssh_config: None,
            default_path: None,
            enabled: true,
            created_at: 1,
            updated_at: 1,
        }
    }
    fn batch() -> PromptBatch {
        PromptBatch {
            operation_id: Uuid::new_v4().to_string(),
            items: ["first", "", "second"]
                .into_iter()
                .map(|title| crate::prompts::BatchItem {
                    item_id: Uuid::new_v4().to_string(),
                    action: BatchAction::Create,
                    draft: crate::prompts::PromptDraft {
                        id: None,
                        title: title.into(),
                        body: "body".into(),
                        scope: crate::prompts::PromptScope::Global,
                        tags: vec!["test".into()],
                        expected_version: None,
                    },
                })
                .collect(),
        }
    }
    #[test]
    fn mixed_batch_commits_both_files_once_and_retries_without_self_conflict() {
        let target = target();
        super::super::tests::with_local_transport(&target, |_| {
            let db = Database::open(Path::new(":memory:")).unwrap();
            let batch = batch();
            let expected =
                transactions::versions(&target, &[LIBRARY_PATH.into(), STATE_PATH.into()]).unwrap();
            super::super::tests::write_with_versions(&target, expected, || {
                let result = apply_batch(&target, &db, &batch).unwrap();
                assert!(result.write_applied);
                assert_eq!(
                    result
                        .items
                        .iter()
                        .filter(|r| r.status == crate::prompts::BatchStatus::Saved)
                        .count(),
                    2
                );
                assert_eq!(result.items[1].status, crate::prompts::BatchStatus::Failed);
            });
            let after = read_snapshot(&target).unwrap();
            assert_eq!(after.items.len(), 2);
            assert_eq!(after.state.receipts.len(), 2);
            let expected =
                transactions::versions(&target, &[LIBRARY_PATH.into(), STATE_PATH.into()]).unwrap();
            let before = expected.clone();
            super::super::tests::write_with_versions(&target, expected, || {
                let replay = apply_batch(&target, &db, &batch).unwrap();
                assert!(!replay.write_applied);
            });
            assert_eq!(
                transactions::versions(&target, &[LIBRARY_PATH.into(), STATE_PATH.into()]).unwrap(),
                before
            );
        });
    }
    #[test]
    fn stale_pair_baseline_never_reports_saved_or_publishes_metadata() {
        let target = target();
        super::super::tests::with_local_transport(&target, |_| {
            let db = Database::open(Path::new(":memory:")).unwrap();
            let expected =
                transactions::versions(&target, &[LIBRARY_PATH.into(), STATE_PATH.into()]).unwrap();
            run_command(
                &target,
                "mkdir -p \"$HOME/.cliora\"; printf '[]' > \"$HOME/.cliora/library.json\"",
            )
            .unwrap();
            super::super::tests::write_with_versions(&target, expected, || {
                assert!(apply_batch(&target, &db, &batch()).is_err());
            });
            let current = read_snapshot(&target).unwrap();
            assert!(current.items.is_empty());
            assert!(current.state.metadata.is_empty());
            assert!(current.state.receipts.is_empty());
        });
    }
}
