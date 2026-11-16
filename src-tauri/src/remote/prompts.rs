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
    // The shared transaction service holds the writer lock through both reads and
    // rejects unrecovered receipts before any bytes can enter the snapshot/cache.
    let script = concat!(
        r#"if [ -e "$HOME/.cliora" ] || [ -L "$HOME/.cliora" ]; then [ ! -L "$HOME/.cliora" ] && [ -d "$HOME/.cliora" ] && [ -r "$HOME/.cliora" ] && [ -x "$HOME/.cliora" ] || { printf '%s\n' 'cliora:directory-access: 提示词资料目录不可读取或不是普通目录。' >&2; exit 46; }; fi; "#,
        r#"read_prompt_file() { prompt_file=$1; if [ -e "$prompt_file" ] || [ -L "$prompt_file" ]; then [ ! -L "$prompt_file" ] && [ -f "$prompt_file" ] && [ -r "$prompt_file" ] || { printf '%s\n' 'cliora:directory-access: 提示词资料不是可读取的普通文件。' >&2; return 46; }; prompt_encoded=$(base64 < "$prompt_file") || return 46; printf %s "$prompt_encoded" | tr -d '\n'; else printf %s __MISSING__; fi; }; "#,
        r#"printf '%s\n' __PROMPT_LIBRARY__; read_prompt_file "$HOME/.cliora/library.json" || exit 46; printf '\n'; printf '%s\n' __PROMPT_STATE__; read_prompt_file "$HOME/.cliora/prompts-v1.json" || exit 46; printf '\n';"#,
    );
    parse_snapshot(&transactions::read_consistent(target, script)?)
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
    fn install_read_lock_fixture(home: &str) {
        // macOS lacks util-linux flock. Exercise the actual OS flock on inherited FD9;
        // this fixture is not evidence of GNU transaction tooling or live SSH support.
        #[cfg(target_os = "macos")]
        {
            use std::os::unix::fs::PermissionsExt;
            let bin = std::path::Path::new(home).join(".local/bin");
            std::fs::create_dir_all(&bin).unwrap();
            let path = bin.join("flock");
            std::fs::write(&path, "#!/usr/bin/python3\nimport fcntl, sys\nfcntl.flock(int(sys.argv[-1]), fcntl.LOCK_EX)\n").unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let _ = home;
    }
    #[cfg(unix)]
    fn read_target() -> RemoteTarget {
        RemoteTarget {
            id: Uuid::new_v4().to_string(), name: "fixture".into(),
            host: "fixture.invalid".into(), port: 22, user: "fixture".into(),
            auth_method: "key".into(), identity_file: None, ssh_config: None,
            default_path: None, enabled: true, created_at: 1, updated_at: 1,
        }
    }
    #[cfg(unix)]
    fn interrupted_pair(home: &str) -> (std::path::PathBuf, RemotePromptState) {
        let root = std::path::Path::new(home).join(".cliora");
        let tx = root.join("transactions").join(Uuid::new_v4().to_string());
        std::fs::create_dir_all(&tx).unwrap();
        let item = crate::library::LibraryItem {
            id: "project-prompt".into(), kind: crate::library::LibraryKind::Prompt,
            title: "Project only".into(), body: "private project instructions".into(),
            category: String::new(), project_id: None, version: 1, updated_at: 1,
        };
        let mut state = RemotePromptState::default();
        state.metadata.insert(item.id.clone(), crate::prompts::PromptMetadata {
            scope: crate::prompts::PromptScope::Workspace { workspace_id: "workspace".into() }, tags: vec![],
        });
        // The first destination has been replaced, but metadata still has the old value.
        std::fs::write(root.join("library.json"), serde_json::to_vec(&vec![item]).unwrap()).unwrap();
        std::fs::write(root.join("prompts-v1.json"), serde_json::to_vec(&RemotePromptState::default()).unwrap()).unwrap();
        let receipt = tx.join("receipt");
        std::fs::write(&receipt, format!("cliora-tx-v1\n{}\nfixture\n1\ncommitting\n{}\tmissing\t{}\tapplying\n", tx.file_name().unwrap().to_str().unwrap(), base64::engine::general_purpose::STANDARD.encode(LIBRARY_PATH), "a".repeat(64))).unwrap();
        (receipt, state)
    }
    #[cfg(unix)]
    #[test]
    fn active_pair_write_never_exposes_project_prompt_as_global() {
        let target = read_target();
        super::super::tests::with_local_transport(&target, |home| {
            install_read_lock_fixture(home);
            let (receipt, state) = interrupted_pair(home);
            let lock = std::fs::File::create(format!("{home}/.cliora/transactions/lock")).unwrap();
            lock.lock().unwrap();
            let (sender, receiver) = std::sync::mpsc::channel();
            let reader_target = target.clone();
            let reader = std::thread::spawn(move || sender.send(read_snapshot(&reader_target)).unwrap());
            let early = receiver.recv_timeout(std::time::Duration::from_millis(500));
            std::fs::write(format!("{home}/.cliora/prompts-v1.json"), serde_json::to_vec(&state).unwrap()).unwrap();
            let text = std::fs::read_to_string(&receipt).unwrap().replace("committing", "committed").replace("applying", "committed");
            std::fs::write(receipt, text).unwrap();
            lock.unlock().unwrap();
            let returned_early = early.is_ok();
            let snapshot = match early { Ok(value) => value, Err(_) => receiver.recv_timeout(std::time::Duration::from_secs(10)).unwrap() };
            reader.join().unwrap();
            assert!(!returned_early, "reader crossed the writer's active lock");
            let docs = documents(&snapshot.unwrap());
            assert_eq!(docs[0].scope, state.metadata["project-prompt"].scope);
            assert_eq!(prompts::query_documents(&docs, &BTreeMap::new(), &PromptQuery::default()).total, 0);
        });
    }
    #[cfg(unix)]
    #[test]
    fn interrupted_pair_write_is_rejected_after_lock_release_and_not_cached() {
        let target = read_target();
        super::super::tests::with_local_transport(&target, |home| {
            install_read_lock_fixture(home);
            let (receipt, state) = interrupted_pair(home);
            // Simulate the post-crash state: the OS lock is free, receipt still applying.
            assert!(cached_snapshot(&target).is_err(), "mixed body/scope must not enter the success cache");
            std::fs::write(format!("{home}/.cliora/prompts-v1.json"), serde_json::to_vec(&state).unwrap()).unwrap();
            let text = std::fs::read_to_string(&receipt).unwrap().replace("committing", "committed").replace("applying", "committed");
            std::fs::write(receipt, text).unwrap();
            let docs = documents(&cached_snapshot(&target).unwrap());
            assert_eq!(docs[0].scope, state.metadata["project-prompt"].scope);
            assert_eq!(prompts::query_documents(&docs, &BTreeMap::new(), &PromptQuery::default()).total, 0);
        });
    }
    #[cfg(unix)]
    #[test]
    fn recovery_barrier_accepts_terminal_receipts_and_genuine_legacy_metadata_absence() {
        let target = read_target();
        super::super::tests::with_local_transport(&target, |home| {
            install_read_lock_fixture(home);
            let (receipt, _) = interrupted_pair(home);
            std::fs::remove_file(format!("{home}/.cliora/prompts-v1.json")).unwrap();
            let original = std::fs::read_to_string(&receipt).unwrap();
            for outcome in ["committed", "rolled_back", "conflict_before_commit", "prepare_failed"] {
                std::fs::write(&receipt, original.replace("committing", outcome).replace("applying", outcome)).unwrap();
                let docs = documents(&read_snapshot(&target).unwrap());
                assert_eq!(docs[0].scope, crate::prompts::PromptScope::Global);
                assert_eq!(docs[0].body, "private project instructions");
            }
            for outcome in ["preparing", "committing", "recovering", "recovery_required", "unknown"] {
                std::fs::write(&receipt, original.replace("committing", outcome)).unwrap();
                let error = read_snapshot(&target).err().expect("unfinished receipt must block reads");
                assert!(error.to_string().contains("写入恢复"), "{error}");
            }
            std::fs::write(&receipt, "malformed\ncommitted\n").unwrap();
            assert!(read_snapshot(&target).is_err());
            std::fs::remove_file(receipt).unwrap();
            assert!(read_snapshot(&target).is_ok());
        });
    }
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
        super::super::tests::with_local_transport(&target, |home| {
            install_read_lock_fixture(home);
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
