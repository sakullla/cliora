//! Remote records use the same native history parsers as the local machine.
//! Each adapter names the files under the remote login home. This module
//! copies a bounded slice of that tree and parses it in a temporary home.
//! Parsed sessions stay in memory; they are not written into the local index.

use std::fs;
use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

use super::{model_label, present_children, present_usage, HistoryDetail, HistorySession, EMPTY_SESSION};
use super::report::UsageTotals;
use crate::adapters::{CliAdapter, Registry, RemoteHistoryLayout, RemoteHistoryOrder};
use crate::remote::RemoteTarget;

const FILE_CAP: usize = 12 * 1024 * 1024;
const ARCHIVE_CAP: usize = 48 * 1024 * 1024;
const ROLLOUT_CAP: usize = 60;
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFailure { pub tool_id: String, pub message: String, pub remote: Option<crate::remote::operations::Failure> }

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySnapshot { pub sessions: Vec<HistorySession>, pub source_failures: Vec<SourceFailure> }

pub fn list(registry: &Registry, target: &RemoteTarget, refresh: bool) -> Result<Vec<HistorySession>, String> {
    let snapshot = list_snapshot(registry, target, refresh)?;
    if snapshot.sessions.is_empty() && !snapshot.source_failures.is_empty() {
        return Err(snapshot.source_failures.into_iter().map(|failure| format!("{}: {}", failure.tool_id, failure.message)).collect::<Vec<_>>().join("；"));
    }
    Ok(snapshot.sessions)
}

pub fn list_snapshot(registry: &Registry, target: &RemoteTarget, refresh: bool) -> Result<HistorySnapshot, String> {
    let (details, source_failures) = snapshot(registry, target, refresh)?;
    Ok(HistorySnapshot { sessions: details.into_iter().map(|detail| detail.session).collect(), source_failures })
}

pub fn detail(registry: &Registry, target: &RemoteTarget, id: &str) -> Result<HistoryDetail, String> {
    let tool = id.strip_prefix(&format!("remote-native:{}:", target.id)).and_then(|suffix| suffix.split(':').next()).ok_or("会话不属于当前主机")?;
    let adapter = registry.get(tool).filter(|adapter| adapter.history_supported() && adapter.remote_history_layout().is_some()).ok_or("当前历史来源不可用")?;
    let owned = target.clone();
    let details = crate::remote::read_cache::read(target, &format!("history:{}", adapter.id()), false, move || {
        fetch_source(adapter, &owned).map_err(crate::remote::RemoteError::Storage)
    }).map_err(|error| error.to_string())?;
    details.into_iter().find(|item| item.session.id == id).ok_or_else(|| "会话已从当前主机的记录中移除".to_owned())
}

fn snapshot(registry: &Registry, target: &RemoteTarget, refresh: bool) -> Result<(Vec<HistoryDetail>, Vec<SourceFailure>), String> {
    snapshot_with_loader(registry, target, refresh, std::sync::Arc::new(fetch_source))
}

type SourceLoader = std::sync::Arc<dyn Fn(&dyn CliAdapter, &RemoteTarget) -> Result<Vec<HistoryDetail>, String> + Send + Sync>;
fn snapshot_with_loader(registry: &Registry, target: &RemoteTarget, refresh: bool, loader: SourceLoader) -> Result<(Vec<HistoryDetail>, Vec<SourceFailure>), String> {
    let context = crate::remote::operations::current().unwrap_or_else(|| crate::remote::operations::Context::local(crate::remote::operations::Kind::Read, std::time::Duration::from_secs(40)));
    context.bind(target).map_err(|error| error.to_string())?;
    let adapters: Vec<_> = registry.iter().filter(|adapter| adapter.history_supported() && adapter.remote_history_layout().is_some()).collect();
    let mut details = Vec::new();
    let mut failures = Vec::new();
    // Two independent sources at a time; the shared SSH scheduler still enforces
    // destination/global fairness. A failed source never discards another one.
    for batch in adapters.chunks(2) {
        let results = std::thread::scope(|scope| {
            let jobs: Vec<_> = batch.iter().map(|adapter| {
                let context = context.read_child(std::time::Duration::from_secs(15).min(context.remaining() / 2));
                let loader = loader.clone();
                let adapter = *adapter;
                scope.spawn(move || crate::remote::operations::scoped(context, || {
                    let target_owned = target.clone();
                    crate::remote::read_cache::read(target, &format!("history:{}", adapter.id()), refresh, move || {
                        loader(adapter, &target_owned).map_err(crate::remote::RemoteError::Storage)
                    }).map_err(|error| error.to_string())
                }))
            }).collect();
            jobs.into_iter().map(|job| job.join().unwrap_or_else(|_| Err("历史来源读取意外中断".into()))).collect::<Vec<_>>()
        });
        for (adapter, result) in batch.iter().zip(results) {
            match result { Ok(mut rows) => details.append(&mut rows), Err(message) => {
                let remote = message.strip_prefix("cliora:remote:").and_then(|encoded| serde_json::from_str::<crate::remote::operations::Failure>(encoded).ok());
                let message = remote.as_ref().map(|failure| format!("{} {}", failure.message, failure.action)).unwrap_or(message);
                if let Some(mut previous) = crate::remote::read_cache::previous::<Vec<HistoryDetail>>(target, &format!("history:{}", adapter.id())) {
                    for detail in &mut previous { detail.session.stale = true; }
                    details.append(&mut previous);
                }
                failures.push(SourceFailure { tool_id: adapter.id().into(), message, remote });
            } }
        }
        context.check().map_err(|error| error.to_string())?;
    }
    details.sort_by(|left, right| right.session.updated_at.cmp(&left.session.updated_at).then_with(|| left.session.id.cmp(&right.session.id)));
    Ok((details, failures))
}

fn fetch_source(adapter: &dyn CliAdapter, target: &RemoteTarget) -> Result<Vec<HistoryDetail>, String> {
    let home = std::env::temp_dir().join(format!("cliora-remote-history-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&home).map_err(|error| format!("无法准备远程历史临时目录：{error}"))?;
    let _cleanup = TempHome(home.clone());
    let layout = adapter.remote_history_layout().ok_or("未声明远程历史来源")?;
    let command = archive_command(layout)?;
    let bytes = crate::remote::run_command_bytes(target, &command).map_err(|error| error.to_string())?;
    let files = decode_archive(&bytes, layout.relative)?;
    write_tree(&home, &files)?;
    sessions_from_home(adapter, &home, &target.id)
}

struct TempHome(PathBuf);
impl Drop for TempHome {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(crate) fn archive_command(layout: RemoteHistoryLayout) -> Result<String, String> {
    if !valid_relative(layout.relative) || layout.sessions.is_empty() || layout.sessions.len() > 8 || layout.pinned.len() > 8 {
        return Err("远程历史目录无效".into());
    }
    let session_names = name_clause(layout.sessions)?;
    let quoted = crate::remote::shell_quote(layout.relative);
    let size_limit = FILE_CAP + 1;
    let exclude = match layout.companion {
        Some(name) => {
            if !valid_segment(name) {
                return Err("远程历史目录无效".into());
            }
            format!(" ! -path {}", crate::remote::shell_quote(&format!("*/{name}/*")))
        }
        None => String::new(),
    };
    let session_find = match layout.order {
        RemoteHistoryOrder::PathDesc => format!(
            "find {quoted} -type f \\( {session_names} \\) -size -{size_limit}c{exclude} -print > \"$scan\" || exit 1; sort -r \"$scan\" > \"$ordered\" || exit 1"
        ),
        RemoteHistoryOrder::MtimeDesc => format!(
            "find {quoted} -type f \\( {session_names} \\) -size -{size_limit}c{exclude} -printf '%T@ %p\\n' > \"$scan\" || exit 1; sort -nr \"$scan\" | cut -d ' ' -f2- > \"$ordered\" || exit 1"
        ),
    };
    let prepare_pick = if layout.pinned.is_empty() {
        ": > \"$pick\"; ".to_owned()
    } else {
        let pinned_names = name_clause(layout.pinned)?;
        format!("find {quoted} -type f \\( {pinned_names} \\) -size -{size_limit}c -print > \"$pick\" || exit 1; ")
    };
    let companion = match layout.companion {
        Some(name) => format!(
            "stem=$(basename -- \"$path\"); stem=${{stem%.*}}; dir=$(dirname -- \"$path\"); comp=\"$dir/$stem/{name}\"; if [ -d \"$comp\" ]; then find \"$comp\" -type f \\( {session_names} \\) -size -{size_limit}c -print || exit 1; fi; "
        ),
        None => String::new(),
    };
    let relative = layout.relative;
    let mut ancestor = String::new();
    let ancestors: Vec<_> = relative.split('/').collect();
    let mut ancestor_checks = String::new();
    for segment in ancestors.iter().take(ancestors.len().saturating_sub(1)) {
        if !ancestor.is_empty() { ancestor.push('/'); }
        ancestor.push_str(segment);
        let quoted = crate::remote::shell_quote(&ancestor);
        ancestor_checks.push_str(&format!("if [ -e {quoted} ] && {{ [ ! -d {quoted} ] || [ ! -x {quoted} ]; }}; then printf 'remote history ancestor: Permission denied or not a directory\\n' >&2; exit 73; fi; "));
    }
    let command = format!(
        "cd -- \"$HOME\" || exit 1; {ancestor_checks}if [ ! -e {quoted} ] && [ ! -L {quoted} ]; then exit 0; fi; [ -d {quoted} ] && [ -r {quoted} ] && [ -x {quoted} ] || {{ printf 'remote history source: Permission denied or not a directory\\n' >&2; exit 73; }}; pick=; scan=; ordered=; trap 'rm -f \"$pick\" \"$scan\" \"$ordered\"' EXIT; pick=$(mktemp) && scan=$(mktemp) && ordered=$(mktemp) || exit 1; {prepare_pick}{session_find}; count=0; while IFS= read -r path; do [ \"$count\" -ge {cap} ] && break; case \"$path\" in {relative}/*|{relative}) ;; *) continue ;; esac; case \"$path\" in *..*) continue ;; esac; printf '%s\\n' \"$path\"; {companion}count=$((count + 1)); done < \"$ordered\" >> \"$pick\"; budget={archive}; while IFS= read -r path; do case \"$path\" in {relative}/*|{relative}) ;; *) continue ;; esac; case \"$path\" in *..*) continue ;; esac; size=$(wc -c < \"$path\") || exit 1; size=$(printf '%s' \"$size\" | tr -d '[:space:]'); [ -n \"$size\" ] || exit 1; [ \"$size\" -le \"$budget\" ] || continue; budget=$((budget - size)); printf 'F\\n%s\\n%s\\n' \"$path\" \"$size\"; cat \"$path\" || exit 1; done < \"$pick\"; printf 'Z\\n'",
        cap = ROLLOUT_CAP,
        archive = ARCHIVE_CAP,
    );
    if command.chars().any(|ch| ch.is_control()) || command.len() > 32_000 {
        return Err("远程历史读取命令无效".into());
    }
    Ok(command)
}

fn name_clause(globs: &[&str]) -> Result<String, String> {
    if globs.is_empty() {
        return Err("远程历史文件名无效".into());
    }
    let mut parts = Vec::with_capacity(globs.len());
    for glob in globs {
        if !valid_history_glob(glob) {
            return Err("远程历史文件名无效".into());
        }
        parts.push(format!("-name {}", crate::remote::shell_quote(glob)));
    }
    Ok(parts.join(" -o "))
}

fn valid_history_glob(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-' | '*' | '?'))
}

fn valid_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
}

fn valid_relative(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && !value.starts_with('/')
        && !value.contains('\\')
        && value.split('/').all(|segment| {
            !segment.is_empty()
                && segment != "."
                && segment != ".."
                && segment.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
        })
}

pub(crate) fn decode_archive(bytes: &[u8], relative: &str) -> Result<Vec<(String, Vec<u8>)>, String> {
    if !valid_relative(relative) {
        return Err("远程历史目录无效".into());
    }
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    let mut rest = bytes;
    let mut total = 0usize;
    loop {
        if rest.is_empty() || rest.starts_with(b"Z\n") {
            break;
        }
        if !rest.starts_with(b"F\n") {
            return Err("远程历史归档格式无效".into());
        }
        rest = &rest[2..];
        let path_end = rest.iter().position(|byte| *byte == b'\n').ok_or("远程历史归档被截断")?;
        let path = std::str::from_utf8(&rest[..path_end]).map_err(|_| "远程历史路径无效".to_owned())?;
        if !archive_path_allowed(path, relative) {
            return Err("远程历史路径无效".into());
        }
        rest = &rest[path_end + 1..];
        let size_end = rest.iter().position(|byte| *byte == b'\n').ok_or("远程历史归档被截断")?;
        let size_text = std::str::from_utf8(&rest[..size_end]).map_err(|_| "远程历史归档格式无效".to_owned())?;
        let size: usize = size_text.parse().map_err(|_| "远程历史归档格式无效".to_owned())?;
        if size > FILE_CAP {
            return Err("远程历史文件超出读取上限".into());
        }
        rest = &rest[size_end + 1..];
        if rest.len() < size {
            return Err("远程历史归档被截断".into());
        }
        total = total.saturating_add(size);
        if total > ARCHIVE_CAP {
            return Err("远程历史超出读取上限".into());
        }
        files.push((path.to_owned(), rest[..size].to_vec()));
        rest = &rest[size..];
    }
    Ok(files)
}

fn archive_path_allowed(path: &str, relative: &str) -> bool {
    if path.contains('\\') || path.starts_with('/') || path.contains('\0') {
        return false;
    }
    if path.split('/').any(|segment| segment.is_empty() || segment == "." || segment == "..") {
        return false;
    }
    path == relative || path.starts_with(&format!("{relative}/"))
}

fn write_tree(home: &Path, files: &[(String, Vec<u8>)]) -> Result<(), String> {
    for (path, bytes) in files {
        let relative = Path::new(path);
        if relative.is_absolute() || relative.components().any(|component| matches!(component, Component::ParentDir | Component::RootDir | Component::Prefix(_))) {
            return Err("远程历史路径无效".into());
        }
        let destination = home.join(relative);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("无法写入远程历史：{error}"))?;
        }
        fs::write(&destination, bytes).map_err(|error| format!("无法写入远程历史：{error}"))?;
    }
    Ok(())
}

fn sessions_from_home(adapter: &dyn CliAdapter, home: &Path, target_id: &str) -> Result<Vec<HistoryDetail>, String> {
    let sources = adapter.history_sources(home)?;
    let mut details = Vec::new();
    for source in sources {
        if !source.path.starts_with(home) || source.fingerprint_error.is_some() {
            continue;
        }
        let parsed = match adapter.parse_history(&source) {
            Ok(parsed) => parsed,
            Err(error) if error == EMPTY_SESSION => continue,
            Err(_) => continue,
        };
        let relative = source.path.strip_prefix(home).unwrap_or(source.path.as_path());
        let key = parsed.native_id.clone().unwrap_or_else(|| relative.to_string_lossy().into_owned());
        let digest = format!("{:x}", Sha256::digest(format!("{}:{key}", adapter.id()).as_bytes()));
        let id = format!("remote-native:{target_id}:{}:{digest}", adapter.id());
        let message_count = parsed.messages.len();
        let usage_count = parsed.usage.len();
        let totals = totals_of(&parsed.usage);
        details.push(HistoryDetail {
            session: HistorySession {
                id,
                tool_id: adapter.id().to_owned(),
                native_id: parsed.native_id,
                title: parsed.title,
                cwd: parsed.cwd,
                model: model_label(parsed.model),
                project_id: None,
                started_at: parsed.started_at,
                updated_at: parsed.updated_at,
                favorite: false,
                partial: parsed.partial,
                stale: false,
                message_count,
                usage_count,
            },
            messages: parsed.messages,
            usage: present_usage(parsed.usage),
            children: present_children(parsed.children),
            resume_reason: None,
            totals,
        });
    }
    Ok(details)
}

fn totals_of(usage: &[super::UsageEvent]) -> UsageTotals {
    let mut totals = UsageTotals { sessions: 1, ..UsageTotals::default() };
    for event in usage {
        totals.usage_records += 1;
        totals.requests += event.request_count.unwrap_or(1);
        let input = event.input.unwrap_or(0);
        let cache_read = event.cache_read.unwrap_or(0);
        let cache_write = event.cache_write.unwrap_or(0);
        let fresh = if event.input_includes_cache {
            input.saturating_sub(cache_read).saturating_sub(cache_write)
        } else {
            input
        };
        totals.input += fresh;
        totals.output += event.output.unwrap_or(0);
        totals.cache_read += cache_read;
        totals.cache_write += cache_write;
    }
    totals.total = totals.input + totals.output + totals.cache_read + totals.cache_write;
    totals.unpriced_tokens = totals.total;
    totals
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn independent_sources_keep_success_report_failure_reuse_detail_and_reject_replaced_host() {
        use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
        let home = tempfile::tempdir().unwrap();
        let sessions = home.path().join(".codex/sessions");
        fs::create_dir_all(&sessions).unwrap();
        fs::write(sessions.join("rollout-cache.jsonl"), "{\"type\":\"session_meta\",\"payload\":{\"id\":\"cache-session\",\"cwd\":\"/fixture\"}}\n{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"nonempty source\"}]}}\n").unwrap();
        let target = RemoteTarget { id: uuid::Uuid::new_v4().to_string(), name: "history fixture".into(),
            host: "fixture.invalid".into(), port: 22, user: "fixture".into(), auth_method: "key".into(),
            identity_file: None, ssh_config: None, default_path: None, enabled: true, created_at: 1, updated_at: 1 };
        let codex = Arc::new(AtomicUsize::new(0));
        let claude = Arc::new(AtomicUsize::new(0));
        let codex_calls = codex.clone(); let claude_calls = claude.clone();
        let path = home.path().to_owned();
        let loader: SourceLoader = Arc::new(move |adapter, target| {
            if adapter.id() == "codex" { codex_calls.fetch_add(1, Ordering::SeqCst); sessions_from_home(adapter, &path, &target.id) }
            else { claude_calls.fetch_add(1, Ordering::SeqCst); Err("fixture permission failure".into()) }
        });
        let registry = Registry::builtins();
        let (cold, failures) = snapshot_with_loader(&registry, &target, false, loader.clone()).unwrap();
        assert_eq!(cold.len(), 1); assert!(cold[0].messages.iter().any(|row| row.text.contains("nonempty source")));
        assert_eq!(failures.len(), 1); assert_eq!(failures[0].tool_id, "claude_code");
        assert!(failures[0].message.contains("permission failure"));
        assert_eq!(detail(&registry, &target, &cold[0].session.id).unwrap().messages.len(), cold[0].messages.len());
        let (hot, _) = snapshot_with_loader(&registry, &target, false, loader.clone()).unwrap();
        assert_eq!(hot.len(), 1); assert_eq!(codex.load(Ordering::SeqCst), 1); assert_eq!(claude.load(Ordering::SeqCst), 2);
        let failing: SourceLoader = Arc::new(|_, _| Err("refresh failed".into()));
        let (stale, failed) = snapshot_with_loader(&registry, &target, true, failing).unwrap();
        assert_eq!(stale.len(), 1); assert!(stale[0].session.stale); assert_eq!(failed.len(), 2);
        let mut changed = target.clone(); changed.host = "replacement.invalid".into(); changed.updated_at += 1;
        let (replaced, _) = snapshot_with_loader(&registry, &changed, false, Arc::new(|_, _| Err("offline replacement".into()))).unwrap();
        assert!(replaced.is_empty(), "same ID cannot expose the old host's cached history");
        crate::remote::read_cache::invalidate(&target.id);
        assert!(crate::remote::read_cache::previous::<Vec<HistoryDetail>>(&target, "history:codex").is_none());
    }

    #[test]
    fn structured_source_failures_keep_outer_subscriber_identity() {
        use crate::remote::operations::{self, Kind, Priority, Request};
        let target = RemoteTarget { id: uuid::Uuid::new_v4().to_string(), name: "source identity".into(),
            host: "fixture.invalid".into(), port: 22, user: "fixture".into(), auth_method: "key".into(),
            identity_file: None, ssh_config: None, default_path: None, enabled: true, created_at: 1, updated_at: 17 };
        for reason in ["authentication", "permission"] {
            let request_id = uuid::Uuid::new_v4().to_string();
            let lease = operations::register("source-test", Request {
                request_id: request_id.clone(), cancel_token: uuid::Uuid::new_v4().to_string(), target_id: target.id.clone(),
                target_revision: Some(17), kind: Kind::Read, priority: Priority::Interactive, refresh: true,
                deadline_unix_ms: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64 + 3000,
            }, Kind::Read).unwrap();
            let loader: SourceLoader = std::sync::Arc::new(move |_, _| {
                let context = operations::current().unwrap(); context.dispatched();
                Err(context.failure(reason, "source denied").to_string())
            });
            let (_, failures) = operations::scoped(lease.context.clone(), || snapshot_with_loader(&Registry::builtins(), &target, true, loader)).unwrap();
            assert_eq!(failures.len(), 2);
            for source in failures {
                let failure = source.remote.expect("structured source failure");
                assert_eq!(failure.stage, reason); assert_eq!(failure.reason, reason);
                assert_eq!(failure.request_id.as_deref(), Some(request_id.as_str()));
                assert_eq!(failure.target_id.as_deref(), Some(target.id.as_str())); assert_eq!(failure.target_revision, Some(17));
            }
            lease.context.cancel();
            let crate::remote::RemoteError::Operation(failure) = lease.context.check().unwrap_err() else { panic!("structured cancellation") };
            assert_eq!(failure.stage, "process_wait"); assert_eq!(failure.request_id, Some(request_id));
        }
    }

    #[test]
    fn archive_command_stays_a_single_quoted_shell_line() {
        let command = archive_command(crate::adapters::CODEX.remote_history_layout().unwrap()).unwrap();
        assert!(command.contains("'.codex'"));
        assert!(command.contains("rollout-*.jsonl"));
        assert!(command.contains("session_index.jsonl"));
        assert!(command.contains("state_*.sqlite"));
        assert!(command.contains("printf 'F\\n%s\\n%s\\n'"));
        assert!(command.contains("sort -r"));
        assert!(!command.contains("%T@"));
        assert!(!command.chars().any(|ch| ch.is_control()));
        assert!(command.len() < 32_000);
        let claude = archive_command(crate::adapters::CLAUDE.remote_history_layout().unwrap()).unwrap();
        assert!(claude.contains("'.claude/projects'"));
        assert!(claude.contains("'*.jsonl'"));
        assert!(claude.contains("subagents"));
        assert!(claude.contains("%T@"));
        assert!(!claude.contains("rollout-"));
        assert!(!claude.chars().any(|ch| ch.is_control()));
        let layout = crate::adapters::CODEX.remote_history_layout().unwrap();
        for relative in ["../.codex", "/root/.codex", ".codex/../../etc"] {
            assert!(archive_command(RemoteHistoryLayout { relative, ..layout }).is_err());
        }
        assert!(archive_command(RemoteHistoryLayout { companion: Some("sub;agents"), ..layout }).is_err());
        assert!(archive_command(RemoteHistoryLayout { sessions: &["*.jsonl;rm"], ..layout }).is_err());
    }

    #[test]
    fn archive_round_trip_keeps_bytes_and_rejects_escape_paths() {
        let payload = b"hello\n\0world".to_vec();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"F\n.codex/sessions/rollout-one.jsonl\n");
        bytes.extend_from_slice(payload.len().to_string().as_bytes());
        bytes.push(b'\n');
        bytes.extend_from_slice(&payload);
        bytes.extend_from_slice(b"Z\n");
        let files = decode_archive(&bytes, ".codex").unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].1, payload);

        let mut escaped = b"F\n.codex/../secrets\n1\nxZ\n".to_vec();
        assert!(decode_archive(&escaped, ".codex").is_err());
        escaped = b"F\n/root/.codex/sessions/rollout-one.jsonl\n1\nxZ\n".to_vec();
        assert!(decode_archive(&escaped, ".codex").is_err());
        assert!(decode_archive(b"", ".codex").unwrap().is_empty());
    }

    #[test]
    fn mirrored_codex_tree_keeps_the_native_title_and_transcript() {
        let home = tempfile::tempdir().unwrap();
        let sessions = home.path().join(".codex/sessions");
        fs::create_dir_all(&sessions).unwrap();
        let id = "11111111-2222-4333-8444-555555555555";
        let log = format!(
            "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{id}\",\"cwd\":\"/srv/app\"}}}}\n{{\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"user\",\"content\":[{{\"type\":\"input_text\",\"text\":\"fix the remote history\"}}]}}}}\n{{\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{{\"type\":\"output_text\",\"text\":\"parsed transcript\"}}]}}}}\n"
        );
        fs::write(sessions.join(format!("rollout-2026-10-26-{id}.jsonl")), log).unwrap();
        fs::write(
            home.path().join(".codex/session_index.jsonl"),
            serde_json::json!({"id": id, "thread_name": "Native generated title"}).to_string(),
        )
        .unwrap();
        let details = sessions_from_home(&crate::adapters::CODEX, home.path(), "target-1").unwrap();
        assert_eq!(details.len(), 1);
        assert_eq!(details[0].session.title, "Native generated title");
        assert_eq!(details[0].session.cwd.as_deref(), Some("/srv/app"));
        assert_eq!(details[0].session.tool_id, "codex");
        assert!(details[0].session.message_count >= 2);
        assert!(details[0].messages.iter().any(|message| message.text.contains("fix the remote history")));
        assert!(details[0].messages.iter().any(|message| message.text.contains("parsed transcript")));
        assert!(details[0].session.id.starts_with("remote-native:target-1:codex:"));
        assert!(details[0].resume_reason.is_none());
    }

    #[test]
    fn mirrored_claude_tree_keeps_the_transcript_and_child_log() {
        let home = tempfile::tempdir().unwrap();
        let id = "22222222-2222-4222-8222-222222222222";
        let child_id = "33333333-3333-4333-8333-333333333333";
        let project = home.path().join(".claude/projects/-src-project");
        let wires = project.join(id).join("subagents");
        fs::create_dir_all(&wires).unwrap();
        fs::write(project.join(format!("{id}.jsonl")), format!(
            "{{\"type\":\"custom-title\",\"customTitle\":\"远端 Claude 会话\"}}\n{{\"type\":\"user\",\"uuid\":\"u1\",\"sessionId\":\"{id}\",\"cwd\":\"/src/project\",\"timestamp\":\"2026-10-31T08:00:00Z\",\"message\":{{\"role\":\"user\",\"content\":\"远端会话正文\"}}}}\n{{\"type\":\"assistant\",\"uuid\":\"a1\",\"requestId\":\"req-main\",\"sessionId\":\"{id}\",\"timestamp\":\"2026-10-31T08:00:01Z\",\"message\":{{\"id\":\"msg-main\",\"model\":\"claude-opus\",\"content\":\"远端回复\",\"usage\":{{\"input_tokens\":5,\"output_tokens\":4,\"cache_read_input_tokens\":0,\"cache_creation_input_tokens\":0}}}}}}\n"
        )).unwrap();
        fs::write(wires.join("agent.jsonl"), format!(
            "{{\"type\":\"user\",\"uuid\":\"c-user\",\"sessionId\":\"{child_id}\",\"timestamp\":\"2026-10-31T08:00:02Z\",\"message\":{{\"role\":\"user\",\"content\":\"子日志正文\"}}}}\n"
        )).unwrap();
        let details = sessions_from_home(&crate::adapters::CLAUDE, home.path(), "target-1").unwrap();
        assert_eq!(details.len(), 1);
        assert_eq!(details[0].session.title, "远端 Claude 会话");
        assert_eq!(details[0].session.cwd.as_deref(), Some("/src/project"));
        assert_eq!(details[0].session.tool_id, "claude_code");
        assert!(details[0].messages.iter().any(|message| message.text.contains("远端会话正文")));
        assert!(details[0].messages.iter().any(|message| message.text.contains("远端回复")));
        assert!(details[0].messages.iter().all(|message| !message.text.contains("子日志正文")));
        assert!(details[0].children.iter().any(|child| child.messages.iter().any(|message| message.text.contains("子日志正文"))));
        assert!(details[0].session.id.starts_with("remote-native:target-1:claude_code:"));
    }
}
