//! Remote records use the same native history parsers as the local machine.
//! Each adapter names the directory under the remote login home. This module
//! copies a bounded slice of that tree and parses it in a temporary home.
//! Parsed sessions stay in memory; they are not written into the local index.

use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use super::{model_label, present_children, present_usage, HistoryDetail, HistorySession, EMPTY_SESSION};
use super::report::UsageTotals;
use crate::adapters::{CliAdapter, Registry};
use crate::remote::RemoteTarget;

const FILE_CAP: usize = 12 * 1024 * 1024;
const ARCHIVE_CAP: usize = 48 * 1024 * 1024;
const ROLLOUT_CAP: usize = 60;
const CACHE_TTL: Duration = Duration::from_secs(45);

struct Snapshot {
    at: Instant,
    details: Vec<HistoryDetail>,
}

fn cache() -> &'static Mutex<HashMap<String, Snapshot>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Snapshot>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn list(registry: &Registry, target: &RemoteTarget, refresh: bool) -> Result<Vec<HistorySession>, String> {
    Ok(snapshot(registry, target, refresh)?
        .into_iter()
        .map(|detail| detail.session)
        .collect())
}

pub fn detail(registry: &Registry, target: &RemoteTarget, id: &str) -> Result<HistoryDetail, String> {
    snapshot(registry, target, false)?
        .into_iter()
        .find(|item| item.session.id == id)
        .ok_or_else(|| "会话已从当前主机的记录中移除".to_owned())
}

fn snapshot(registry: &Registry, target: &RemoteTarget, refresh: bool) -> Result<Vec<HistoryDetail>, String> {
    if !refresh {
        if let Some(hit) = cache().lock().unwrap_or_else(|error| error.into_inner()).get(&target.id) {
            if hit.at.elapsed() < CACHE_TTL {
                return Ok(hit.details.clone());
            }
        }
    }
    let details = fetch(registry, target)?;
    cache()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(target.id.clone(), Snapshot { at: Instant::now(), details: details.clone() });
    Ok(details)
}

fn fetch(registry: &Registry, target: &RemoteTarget) -> Result<Vec<HistoryDetail>, String> {
    let home = std::env::temp_dir().join(format!("cliora-remote-history-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&home).map_err(|error| format!("无法准备远程历史临时目录：{error}"))?;
    let _cleanup = TempHome(home.clone());
    let mut details = Vec::new();
    for adapter in registry.iter() {
        if !adapter.history_supported() {
            continue;
        }
        let Some(relative) = adapter.native_history_relative() else { continue };
        let command = archive_command(relative)?;
        let bytes = crate::remote::run_command_bytes(target, &command).map_err(|error| error.to_string())?;
        let files = decode_archive(&bytes, relative)?;
        write_tree(&home, &files)?;
        details.extend(sessions_from_home(adapter, &home, &target.id)?);
    }
    details.sort_by(|left, right| right.session.updated_at.cmp(&left.session.updated_at).then_with(|| left.session.id.cmp(&right.session.id)));
    Ok(details)
}

struct TempHome(PathBuf);
impl Drop for TempHome {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(crate) fn archive_command(relative: &str) -> Result<String, String> {
    if !valid_relative(relative) {
        return Err("远程历史目录无效".into());
    }
    let quoted = crate::remote::shell_quote(relative);
    let awk = format!("/\\/session_index\\.jsonl$/ {{ print; next }} /\\/state_[^\\/]*\\.sqlite$/ {{ print; next }} /\\/rollout-.*\\.jsonl$/ {{ if (roll < {ROLLOUT_CAP}) {{ print; roll++ }} }}");
    let command = format!(
        "cd -- \"$HOME\" && if [ ! -d {quoted} ]; then exit 0; fi; list=$(mktemp) && trap 'rm -f \"$list\" \"$list.sorted\"' EXIT && find {quoted} -type f \\( -name 'rollout-*.jsonl' -o -name 'session_index.jsonl' -o -name 'state_*.sqlite' \\) -size -{file_cap}c -print | sort -r > \"$list.sorted\" && awk '{awk}' \"$list.sorted\" > \"$list\" && budget={archive_cap}; while IFS= read -r path; do case \"$path\" in {relative}/*|{relative}) ;; *) continue ;; esac; case \"$path\" in *..*) continue ;; esac; size=$(wc -c < \"$path\" | tr -d ' '); [ -n \"$size\" ] || continue; [ \"$size\" -le \"$budget\" ] || continue; budget=$((budget - size)); printf 'F\\n%s\\n%s\\n' \"$path\" \"$size\"; cat \"$path\" || exit 1; done < \"$list\"; printf 'Z\\n'",
        file_cap = FILE_CAP + 1,
        archive_cap = ARCHIVE_CAP,
    );
    if command.chars().any(|ch| ch.is_control()) || command.len() > 32_000 {
        return Err("远程历史读取命令无效".into());
    }
    Ok(command)
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
    fn archive_command_stays_a_single_quoted_shell_line() {
        let command = archive_command(".codex").unwrap();
        assert!(command.contains("'.codex'"));
        assert!(command.contains("rollout-*.jsonl"));
        assert!(command.contains("session_index.jsonl"));
        assert!(command.contains("printf 'F\\n%s\\n%s\\n'"));
        assert!(!command.chars().any(|ch| ch.is_control()));
        assert!(command.len() < 32_000);
        assert!(archive_command("../.codex").is_err());
        assert!(archive_command("/root/.codex").is_err());
        assert!(archive_command(".codex/../../etc").is_err());
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
}
