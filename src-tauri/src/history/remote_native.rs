//! Remote records use the same native history parsers as the local machine.
//! Each adapter names the files under the remote login home. This module
//! copies a bounded slice of that tree and parses it in a temporary home.
//! Parsed sessions stay in memory; they are not written into the local index.

use std::fs;
use std::io::Read;
use std::sync::Arc;
use base64::Engine;
use std::path::{Component, Path};

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
pub struct HistorySnapshot { pub sessions: Vec<HistorySession>, pub source_failures: Vec<SourceFailure>, pub available_sources: Vec<String> }

#[derive(Clone, serde::Serialize)]
struct SourceSnapshot {
    fingerprint: String,
    details: Arc<Vec<HistoryDetail>>,
    warning: Option<String>,
}

impl From<Vec<HistoryDetail>> for SourceSnapshot {
    fn from(details: Vec<HistoryDetail>) -> Self {
        Self { fingerprint: String::new(), details: Arc::new(details), warning: None }
    }
}

pub fn list(registry: &Registry, target: &RemoteTarget, refresh: bool) -> Result<Vec<HistorySession>, String> {
    let snapshot = list_snapshot(registry, target, refresh)?;
    if snapshot.sessions.is_empty() && !snapshot.source_failures.is_empty() {
        return Err(snapshot.source_failures.into_iter().map(|failure| format!("{}: {}", failure.tool_id, failure.message)).collect::<Vec<_>>().join("；"));
    }
    Ok(snapshot.sessions)
}

pub fn list_snapshot(registry: &Registry, target: &RemoteTarget, refresh: bool) -> Result<HistorySnapshot, String> {
    let (sessions, source_failures) = snapshot(registry, target, refresh)?;
    let available_sources = registry.iter().filter(|adapter| adapter.history_supported() && adapter.remote_history_layout().is_some()).map(|adapter| adapter.id().to_owned()).collect();
    Ok(HistorySnapshot { sessions, source_failures, available_sources })
}

pub fn detail(registry: &Registry, target: &RemoteTarget, id: &str) -> Result<HistoryDetail, String> {
    let tool = id.strip_prefix(&format!("remote-native:{}:", target.id)).and_then(|suffix| suffix.split(':').next()).ok_or("会话不属于当前主机")?;
    let adapter = registry.get(tool).filter(|adapter| adapter.history_supported() && adapter.remote_history_layout().is_some()).ok_or("当前历史来源不可用")?;
    let owned = target.clone();
    let details = crate::remote::read_cache::read_shared(target, &format!("history:{}", adapter.id()), false, move || {
        fetch_source(adapter, &owned).map_err(crate::remote::RemoteError::Storage)
    }).map_err(|error| error.to_string())?;
    details.details.iter().find(|item| item.session.id == id).cloned().ok_or_else(|| "会话已从当前主机的记录中移除".to_owned())
}

fn snapshot(registry: &Registry, target: &RemoteTarget, refresh: bool) -> Result<(Vec<HistorySession>, Vec<SourceFailure>), String> {
    // One small read excludes absent roots, rather than opening an SSH channel
    // per installed adapter just to discover that it has no data on this host.
    let present = source_presence(registry, target, refresh).unwrap_or_default();
    snapshot_with_loader(registry, target, refresh, Arc::new(move |adapter, target| {
        if present.get(adapter.id()) == Some(&false) { Ok(Vec::new().into()) }
        else { fetch_source(adapter, target) }
    }))
}

fn source_presence(registry: &Registry, target: &RemoteTarget, refresh: bool) -> Result<std::collections::HashMap<String, bool>, String> {
    let roots = registry.iter().filter(|adapter| adapter.history_supported()).filter_map(|adapter| adapter.remote_history_layout().map(|layout| (adapter.id(), std::iter::once(layout.relative).chain(layout.fallbacks.iter().copied()).collect::<Vec<_>>()))).collect::<Vec<_>>();
    if roots.iter().any(|(_, paths)| paths.iter().any(|relative| !valid_relative(relative))) { return Err("远程历史来源无效".into()); }
    if roots.is_empty() { return Ok(Default::default()); }
    let encoded = base64::engine::general_purpose::STANDARD.encode(serde_json::to_vec(&roots).map_err(|error| error.to_string())?);
    let script = r#"import base64,json,os,stat,sys
result={}
for name,alternatives in json.loads(base64.b64decode(sys.argv[1])):
    result[name]=False
    for relative in alternatives:
        current=os.path.expanduser('~')
        present=True
        for segment in relative.split('/'):
            current=os.path.join(current,segment)
            try:
                info=os.lstat(current)
                if not stat.S_ISDIR(info.st_mode) or not os.access(current,os.R_OK|os.X_OK): break
            except FileNotFoundError:
                present=False
                break
            except OSError: break
        if present:
            result[name]=True
            break
print(json.dumps(result))"#;
    let code = base64::engine::general_purpose::STANDARD.encode(script);
    let command = format!("if command -v python3 >/dev/null 2>&1; then python3 -c {} {}; else printf '{{}}'; fi", crate::remote::shell_quote(&format!("import base64;exec(base64.b64decode('{code}'))")), crate::remote::shell_quote(&encoded));
    let owned = target.clone();
    crate::remote::read_cache::read(target, "history:source-presence", refresh, move || {
        let result = crate::remote::run_command(&owned, &command)?;
        serde_json::from_str(&result.stdout).map_err(|_| crate::remote::RemoteError::Storage("远程历史目录响应无效".into()))
    }).map_err(|error| error.to_string())
}

type SourceLoader = std::sync::Arc<dyn Fn(&dyn CliAdapter, &RemoteTarget) -> Result<SourceSnapshot, String> + Send + Sync>;
fn snapshot_with_loader(registry: &Registry, target: &RemoteTarget, refresh: bool, loader: SourceLoader) -> Result<(Vec<HistorySession>, Vec<SourceFailure>), String> {
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
                    crate::remote::read_cache::read_shared(target, &format!("history:{}", adapter.id()), refresh, move || {
                        loader(adapter, &target_owned).map_err(crate::remote::RemoteError::Storage)
                    }).map_err(|error| error.to_string())
                }))
            }).collect();
            jobs.into_iter().map(|job| job.join().unwrap_or_else(|_| Err("历史来源读取意外中断".into()))).collect::<Vec<_>>()
        });
        for (adapter, result) in batch.iter().zip(results) {
            match result { Ok(rows) => {
                details.extend(rows.details.iter().map(|row| row.session.clone()));
                if let Some(message) = &rows.warning { failures.push(SourceFailure { tool_id: adapter.id().into(), message: message.clone(), remote: None }); }
            }, Err(message) => {
                let remote = message.strip_prefix("cliora:remote:").and_then(|encoded| serde_json::from_str::<crate::remote::operations::Failure>(encoded).ok());
                let message = remote.as_ref().map(|failure| format!("{} {}", failure.message, failure.action)).unwrap_or(message);
                if let Some(previous) = crate::remote::read_cache::previous_shared::<SourceSnapshot>(target, &format!("history:{}", adapter.id())) {
                    details.extend(previous.details.iter().map(|detail| { let mut session = detail.session.clone(); session.stale = true; session }));
                }
                failures.push(SourceFailure { tool_id: adapter.id().into(), message, remote });
            } }
        }
        context.check().map_err(|error| error.to_string())?;
    }
    details.sort_by(|left, right| right.updated_at.cmp(&left.updated_at).then_with(|| left.id.cmp(&right.id)));
    Ok((details, failures))
}

fn fetch_source(adapter: &dyn CliAdapter, target: &RemoteTarget) -> Result<SourceSnapshot, String> {
    let layout = adapter.remote_history_layout().ok_or("未声明远程历史来源")?;
    let previous = crate::remote::read_cache::previous_shared::<SourceSnapshot>(target, &format!("history:{}", adapter.id()));
    let stamp = previous.as_ref().filter(|previous| previous.warning.is_none()).map(|previous| previous.fingerprint.as_str()).unwrap_or("");
    let command = export_command(layout, stamp)?;
    let bytes = crate::remote::run_command_bytes(target, &command).map_err(|error| error.to_string())?;
    decode_source(adapter, target, &bytes, previous.as_deref())
}

fn export_command(layout: RemoteHistoryLayout, previous: &str) -> Result<String, String> {
    if !valid_relative(layout.relative) || layout.fallbacks.len() > 4 || layout.fallbacks.iter().any(|path| !valid_relative(path)) || previous.len() > 64 || !previous.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("远程历史来源无效".into());
    }
    let encode = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
    let script = encode(include_bytes!("remote_export.py"));
    let spec = encode(&serde_json::to_vec(&layout).map_err(|error| error.to_string())?);
    let fallback = if layout.sqlite.is_some() {
        "printf 'Remote SQLite history requires python3\\n' >&2; exit 127".to_owned()
    } else { archive_command(layout)? };
    let command = format!("if command -v python3 >/dev/null 2>&1; then python3 -c {} {} {}; else {fallback}; fi",
        crate::remote::shell_quote(&format!("import base64;exec(base64.b64decode('{script}'))")),
        crate::remote::shell_quote(&spec), crate::remote::shell_quote(previous));
    if command.len() > 32_000 || command.chars().any(char::is_control) { return Err("远程历史脚本超出上限".into()); }
    Ok(command)
}

#[derive(serde::Deserialize)]
struct ExportMetadata { fingerprint: String, partial: Vec<String>, #[serde(default)] unread: Vec<String> }

fn decode_source(adapter: &dyn CliAdapter, target: &RemoteTarget, bytes: &[u8], previous: Option<&SourceSnapshot>) -> Result<SourceSnapshot, String> {
    if let Some(stamp) = bytes.strip_prefix(b"U\n") {
        let stamp = std::str::from_utf8(stamp).map_err(|_| "远程历史版本无效")?.trim();
        return previous.filter(|previous| previous.fingerprint == stamp).cloned().ok_or_else(|| "远程历史缓存已失效，请刷新".into());
    }
    let mut archive = Vec::new();
    let mut fingerprint = String::new();
    let mut partial = Vec::new();
    let mut unread = Vec::new();
    let payload = if let Some(rest) = bytes.strip_prefix(b"V\n") {
        let end = rest.iter().position(|byte| *byte == b'\n').filter(|end| *end < 32_768).ok_or("远程历史归档头无效")?;
        let metadata: ExportMetadata = serde_json::from_slice(&rest[..end]).map_err(|_| "远程历史归档头无效")?;
        if metadata.fingerprint.len() != 64 || !metadata.fingerprint.bytes().all(|byte| byte.is_ascii_hexdigit()) { return Err("远程历史版本无效".into()); }
        fingerprint = metadata.fingerprint;
        partial = metadata.partial;
        unread = metadata.unread;
        let limit = ARCHIVE_CAP + 1024 * 1024;
        flate2::read::GzDecoder::new(&rest[end + 1..]).take(limit as u64 + 1).read_to_end(&mut archive).map_err(|error| format!("远程历史解压失败：{error}"))?;
        if archive.len() > limit { return Err("远程历史解压超出上限".into()); }
        &archive[..]
    } else { bytes };
    let home = tempfile::Builder::new().prefix("cliora-remote-history-").tempdir().map_err(|error| error.to_string())?;
    let layout = adapter.remote_history_layout().ok_or("未声明远程历史来源")?;
    let files = decode_archive(payload, layout.relative)?;
    write_tree(home.path(), &files)?;
    let (mut details, errors) = sessions_from_home_report(adapter, home.path(), &target.id, &partial)?;
    if !errors.is_empty() {
        if let Some(previous) = previous {
            let found = details.iter().map(|detail| detail.session.id.clone()).collect::<std::collections::HashSet<_>>();
            details.extend(previous.details.iter().filter(|detail| !found.contains(&detail.session.id)).map(|detail| {
                let mut retained = detail.clone();
                retained.session.stale = true;
                retained
            }));
        }
    }
    Ok(SourceSnapshot { fingerprint, details: Arc::new(details), warning: errors.first().map(|error| format!("{} 条会话读取失败：{error}", errors.len())).or_else(|| unread.first().map(|path| format!("{} 个历史附属文件未能读取：{path}", unread.len()))) })
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

pub(crate) fn decode_archive<'a>(bytes: &'a [u8], relative: &str) -> Result<Vec<(String, &'a [u8])>, String> {
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
        files.push((path.to_owned(), &rest[..size]));
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

fn write_tree(home: &Path, files: &[(String, &[u8])]) -> Result<(), String> {
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

#[cfg(test)]
fn sessions_from_home(adapter: &dyn CliAdapter, home: &Path, target_id: &str) -> Result<Vec<HistoryDetail>, String> {
    sessions_from_home_report(adapter, home, target_id, &[]).map(|(details, _)| details)
}

fn sessions_from_home_report(adapter: &dyn CliAdapter, home: &Path, target_id: &str, truncated: &[String]) -> Result<(Vec<HistoryDetail>, Vec<String>), String> {
    // A local account context must never redirect a remote mirror into local files.
    let _account_context = crate::accounts::selection::enter(None);
    let context = crate::remote::operations::current();
    let cancelled = || context.as_ref().is_some_and(|context| context.check().is_err());
    let sources = adapter.history_sources_controlled(home, &cancelled)?;
    let mut details = Vec::new();
    let mut errors = Vec::new();
    for source in sources {
        if let Some(context) = &context {
            context.check().map_err(|error| error.to_string())?;
        }
        if !source.path.starts_with(home) { errors.push("会话源不属于远程快照".into()); continue; }
        if let Some(error) = &source.fingerprint_error { errors.push(error.clone()); continue; }
        let parsed = adapter.parse_history_controlled(&source, &cancelled);
        if let Some(context) = &context {
            context.check().map_err(|error| error.to_string())?;
        }
        let mut parsed = match parsed {
            Ok(parsed) => parsed,
            Err(error) if error == EMPTY_SESSION => continue,
            Err(error) => { errors.push(error); continue; },
        };
        let relative = source.path.strip_prefix(home).unwrap_or(source.path.as_path());
        let relative_key = relative.components().map(|part| part.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
        let identities = parsed.native_id.iter().map(String::as_str).chain(parsed.children.iter().map(|child| child.key.as_str())).collect::<Vec<_>>();
        let clipped = truncated.iter().any(|path| path == &relative_key
            || path.split('/').any(|segment| identities.contains(&segment) || identities.contains(&segment.trim_end_matches(".db"))));
        parsed.partial |= clipped;
        // A clipped JSONL can lose model switches and cumulative baselines.
        // Never turn its head/tail into invented per-model billing. Separate,
        // complete SQLite usage rows (e.g. agy) remain authoritative.
        if clipped && adapter.remote_history_layout().is_some_and(|layout| layout.sqlite.is_none()) { parsed.usage.clear(); }
        let key = parsed.native_id.clone().unwrap_or(relative_key);
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
    Ok((details, errors))
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
        if let Some(cost) = event.native_cost_usd {
            *totals.native_cost_usd.get_or_insert(0.0) += cost;
        } else {
            totals.unpriced_tokens += fresh + event.output.unwrap_or(0) + cache_read + cache_write;
        }
        totals.input += fresh;
        totals.output += event.output.unwrap_or(0);
        totals.cache_read += cache_read;
        totals.cache_write += cache_write;
    }
    totals.total = totals.input + totals.output + totals.cache_read + totals.cache_write;
    totals.cost = totals.native_cost_usd;
    totals
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn exported(layout: RemoteHistoryLayout, home: &Path, previous: &str) -> Vec<u8> {
        let spec = base64::engine::general_purpose::STANDARD.encode(serde_json::to_vec(&layout).unwrap());
        let output = std::process::Command::new("python3").args(["-c", include_str!("remote_export.py"), &spec, previous])
            .env("HOME", home).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        output.stdout
    }

    #[cfg(unix)]
    fn fixture_target() -> RemoteTarget {
        RemoteTarget { id: uuid::Uuid::new_v4().to_string(), name: "history fixture".into(), host: "fixture.invalid".into(), port: 22, user: "fixture".into(), auth_method: "key".into(), identity_file: None, ssh_config: None, default_path: None, enabled: true, created_at: 1, updated_at: 1 }
    }

    #[test]
    #[cfg(unix)]
    fn modern_agy_snapshot_reads_live_wal_and_reuses_unchanged_parsed_content() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join(".gemini/antigravity-cli");
        fs::create_dir_all(root.join("brain/fixture-id/.system_generated/logs")).unwrap();
        fs::create_dir_all(root.join("conversations")).unwrap();
        fs::write(root.join("antigravity-oauth-token"), "must never be exported").unwrap();
        let db = rusqlite::Connection::open(root.join("conversation_summaries.db")).unwrap();
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, workspace_uris TEXT, status TEXT, parent_conversation_id TEXT, last_modified_time TEXT); INSERT INTO conversation_summaries VALUES ('fixture-id','Modern fixture','[\"file:///srv/demo%20project\"]','CASCADE_RUN_STATUS_IDLE','','2026-11-15 16:00:00+00:00');").unwrap();
        let usage = rusqlite::Connection::open(root.join("conversations/fixture-id.db")).unwrap();
        usage.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER); CREATE TABLE unrelated_private(value TEXT); INSERT INTO unrelated_private VALUES ('must never be exported');").unwrap();
        fs::write(root.join("brain/fixture-id/.system_generated/logs/transcript_full.jsonl"), "{\"type\":\"USER_INPUT\",\"content\":\"fixture question\",\"created_at\":\"2026-11-15T16:00:00Z\"}\n{\"type\":\"PLANNER_RESPONSE\",\"content\":\"fixture answer\",\"model\":\"fixture-model\",\"created_at\":\"2026-11-15T16:00:01Z\"}\n").unwrap();
        let adapter = &crate::adapters::ANTIGRAVITY;
        let target = fixture_target();
        let layout = adapter.remote_history_layout().unwrap();
        let cold = exported(layout, home.path(), "");
        let snapshot = decode_source(adapter, &target, &cold, None).unwrap();
        assert_eq!(snapshot.details.len(), 1);
        assert_eq!(snapshot.details[0].messages.len(), 2);
        assert_eq!(snapshot.details[0].session.cwd.as_deref(), Some("/srv/demo project"));
        assert_eq!(snapshot.details[0].session.model.as_deref(), Some("fixture-model"));
        assert!(snapshot.warning.is_none());
        let hot = exported(layout, home.path(), &snapshot.fingerprint);
        assert!(hot.len() < 80 && hot.len() < cold.len());
        let reused = decode_source(adapter, &target, &hot, Some(&snapshot)).unwrap();
        assert!(Arc::ptr_eq(&snapshot.details, &reused.details));
        db.execute("UPDATE conversation_summaries SET title='changed in WAL'", []).unwrap();
        let changed = decode_source(adapter, &target, &exported(layout, home.path(), &snapshot.fingerprint), Some(&snapshot)).unwrap();
        assert_eq!(changed.details[0].session.title, "changed in WAL");
        assert_ne!(changed.fingerprint, snapshot.fingerprint);
        assert!(!Arc::ptr_eq(&changed.details, &snapshot.details));
        drop(usage);
        drop(db);
        fs::rename(&root, home.path().join(".gemini/antigravity")).unwrap();
        let legacy_root = decode_source(adapter, &target, &exported(layout, home.path(), ""), None).unwrap();
        assert_eq!(legacy_root.details[0].session.id, snapshot.details[0].session.id);
        assert_eq!(legacy_root.details[0].session.title, "changed in WAL");
    }

    #[test]
    #[cfg(unix)]
    fn file_exports_cover_registered_jsonl_sources_and_unchanged_reads_are_small() {
        for (adapter, relative, fixture) in [
            (&crate::adapters::CODEX as &dyn CliAdapter, ".codex/sessions/rollout-fixture.jsonl", include_str!("../../../tests/fixtures/history/codex-0.158.jsonl")),
            (&crate::adapters::CLAUDE, ".claude/projects/demo/fixture.jsonl", include_str!("../../../tests/fixtures/history/claude-2.1.jsonl")),
            (&crate::adapters::CODEBUDDY, ".codebuddy/projects/demo/11111111-2222-3333-4444-555555555555.jsonl", include_str!("../../../tests/fixtures/history/codebuddy-2.161.1-session.jsonl")),
            (&crate::adapters::PI, ".pi/agent/sessions/demo/fixture.jsonl", include_str!("../../../tests/fixtures/history/pi-0.87-v3.jsonl")),
        ] {
            let home = tempfile::tempdir().unwrap();
            let path = home.path().join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, fixture).unwrap();
            let target = fixture_target();
            let layout = adapter.remote_history_layout().unwrap();
            let bytes = exported(layout, home.path(), "");
            let snapshot = decode_source(adapter, &target, &bytes, None).unwrap();
            assert_eq!(snapshot.details.len(), 1, "{}: {:?}", adapter.id(), snapshot.warning);
            assert!(!snapshot.details[0].messages.is_empty(), "{}", adapter.id());
            let hot = exported(layout, home.path(), &snapshot.fingerprint);
            assert!(hot.len() < 80, "{}", adapter.id());
            assert!(export_command(layout, &snapshot.fingerprint).unwrap().len() < 32_000);
        }
    }

    #[test]
    #[cfg(unix)]
    fn malformed_remote_record_retains_last_readable_body_until_clean_refresh() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join(".codex/sessions");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("rollout-fixture.jsonl");
        fs::write(&path, include_str!("../../../tests/fixtures/history/codex-0.158.jsonl")).unwrap();
        let adapter = &crate::adapters::CODEX;
        let target = fixture_target();
        let layout = adapter.remote_history_layout().unwrap();
        let previous = decode_source(adapter, &target, &exported(layout, home.path(), ""), None).unwrap();
        fs::write(&path, "{broken JSON").unwrap();
        let failed = decode_source(adapter, &target, &exported(layout, home.path(), ""), Some(&previous)).unwrap();
        assert!(failed.warning.is_some());
        assert_eq!(failed.details.len(), 1);
        assert!(failed.details[0].session.stale);
        assert_eq!(failed.details[0].messages.len(), previous.details[0].messages.len());
        fs::remove_file(path).unwrap();
        let removed = decode_source(adapter, &target, &exported(layout, home.path(), ""), Some(&failed)).unwrap();
        assert!(removed.warning.is_none());
        assert!(removed.details.is_empty());
    }

    #[test]
    #[cfg(unix)]
    fn unreadable_optional_catalog_keeps_codex_transcripts_and_reports_the_gap() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join(".codex");
        fs::create_dir_all(root.join("sessions")).unwrap();
        fs::write(root.join("sessions/rollout-fixture.jsonl"), include_str!("../../../tests/fixtures/history/codex-0.158.jsonl")).unwrap();
        fs::write(root.join("state_5.sqlite"), "broken optional catalog").unwrap();
        let adapter = &crate::adapters::CODEX;
        let snapshot = decode_source(adapter, &fixture_target(), &exported(adapter.remote_history_layout().unwrap(), home.path(), ""), None).unwrap();
        assert_eq!(snapshot.details.len(), 1);
        assert!(!snapshot.details[0].messages.is_empty());
        assert!(snapshot.warning.as_deref().unwrap().contains("state_5.sqlite"));
    }

    #[test]
    #[cfg(unix)]
    fn oversized_jsonl_keeps_readable_context_without_inventing_usage_totals() {
        use std::io::Write;
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join(".codex/sessions");
        fs::create_dir_all(&root).unwrap();
        let fixture = include_str!("../../../tests/fixtures/history/codex-0.158.jsonl");
        let mut file = fs::File::create(root.join("rollout-large.jsonl")).unwrap();
        file.write_all(fixture.as_bytes()).unwrap();
        file.write_all(b"\n{\"type\":\"debug\",\"blob\":\"").unwrap();
        for _ in 0..13 { file.write_all(&vec![b'x'; 1024 * 1024]).unwrap(); }
        file.write_all(b"\"}\n").unwrap();
        file.write_all(fixture.as_bytes()).unwrap();
        drop(file);
        let adapter = &crate::adapters::CODEX;
        let snapshot = decode_source(adapter, &fixture_target(), &exported(adapter.remote_history_layout().unwrap(), home.path(), ""), None).unwrap();
        assert_eq!(snapshot.details.len(), 1);
        assert!(!snapshot.details[0].messages.is_empty());
        assert!(snapshot.details[0].session.partial);
        assert!(snapshot.details[0].usage.is_empty());
    }

    #[test]
    #[cfg(unix)]
    fn sqlite_projection_keeps_recent_opencode_sessions_and_related_rows() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join(".local/share/opencode");
        fs::create_dir_all(&root).unwrap();
        let db = rusqlite::Connection::open(root.join("opencode.db")).unwrap();
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE session_v2 (id TEXT PRIMARY KEY,title TEXT,directory TEXT,time_created INTEGER,time_updated INTEGER,version TEXT,model TEXT); CREATE TABLE session_message (id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,data TEXT,time_created INTEGER,time_updated INTEGER); CREATE TABLE private_credentials (value TEXT); INSERT INTO private_credentials VALUES ('never export');").unwrap();
        for index in 0..65 {
            let id = format!("session-{index}");
            db.execute("INSERT INTO session_v2 VALUES (?1,?1,'/srv/project',?2,?2,'2.0.29','{\"id\":\"fixture-model\"}')", rusqlite::params![id, index + 100]).unwrap();
            db.execute("INSERT INTO session_message VALUES (?1,?2,'user',1,'{\"text\":\"fixture question\"}',100,100)", rusqlite::params![format!("message-{index}"), id]).unwrap();
        }
        let adapter = &crate::adapters::OPENCODE;
        let bytes = exported(adapter.remote_history_layout().unwrap(), home.path(), "");
        let snapshot = decode_source(adapter, &fixture_target(), &bytes, None).unwrap();
        assert_eq!(snapshot.details.len(), 60, "{:?}", snapshot.warning);
        assert!(snapshot.details.iter().all(|detail| !detail.messages.is_empty()));
        assert!(snapshot.details.iter().all(|detail| detail.session.native_id.as_deref() != Some("session-0")));
        assert!(snapshot.details.iter().any(|detail| detail.session.native_id.as_deref() == Some("session-64")));
    }

    #[test]
    #[cfg(unix)]
    fn sqlite_export_contract_accepts_new_table_names_without_service_dispatch() {
        use crate::adapters::{RemoteHistorySqlite, RemoteHistoryTable};
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join(".extension/history");
        fs::create_dir_all(&root).unwrap();
        let db = rusqlite::Connection::open(root.join("catalog.db")).unwrap();
        db.execute_batch("CREATE TABLE runs (run_key TEXT PRIMARY KEY,updated INTEGER,unused_secret TEXT); CREATE TABLE wires (run_key TEXT,body TEXT); CREATE TABLE credentials (secret TEXT); INSERT INTO runs VALUES ('one',1,'never export'); INSERT INTO wires VALUES ('one','selected'),('unselected','excluded'); INSERT INTO credentials VALUES ('never export');").unwrap();
        let layout = RemoteHistoryLayout { relative: ".extension/history", fallbacks: &[], pinned: &[], sessions: &["catalog.db"], companion: None, order: RemoteHistoryOrder::MtimeDesc, catalogs: &[], sqlite: Some(RemoteHistorySqlite { index: "catalog.db", files: &[], file_tables: &[], tables: &[
            RemoteHistoryTable { name: "runs", query: "SELECT run_key,updated FROM runs ORDER BY updated DESC LIMIT :limit", required_columns: &["run_key", "updated"], id: Some("run_key"), link: None },
            RemoteHistoryTable { name: "wires", query: "", required_columns: &["run_key"], id: None, link: Some("run_key") },
        ] }) };
        let bytes = exported(layout, home.path(), "");
        let rest = bytes.strip_prefix(b"V\n").unwrap();
        let start = rest.iter().position(|byte| *byte == b'\n').unwrap() + 1;
        let mut raw = Vec::new();
        flate2::read::GzDecoder::new(&rest[start..]).read_to_end(&mut raw).unwrap();
        let mirror = tempfile::tempdir().unwrap();
        write_tree(mirror.path(), &decode_archive(&raw, layout.relative).unwrap()).unwrap();
        let copied = rusqlite::Connection::open(mirror.path().join(".extension/history/catalog.db")).unwrap();
        assert_eq!(copied.query_row("SELECT body FROM wires", [], |row| row.get::<_, String>(0)).unwrap(), "selected");
        assert_eq!(copied.query_row("SELECT count(*) FROM sqlite_master WHERE name='credentials'", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        assert!(copied.prepare("SELECT unused_secret FROM runs").is_err());
    }

    #[test]
    #[ignore = "explicit read-only native SSH history measurement; set CLIORA_HISTORY_HOST and CLIORA_HISTORY_USER"]
    #[cfg(unix)]
    fn performance_remote_history_readonly() {
        let mut target = fixture_target();
        target.host = std::env::var("CLIORA_HISTORY_HOST").expect("explicit host required");
        target.user = std::env::var("CLIORA_HISTORY_USER").expect("explicit user required");
        for adapter in Registry::builtins().iter().filter(|adapter| adapter.remote_history_layout().is_some()) {
            let layout = adapter.remote_history_layout().unwrap();
            let start = std::time::Instant::now();
            let command = export_command(layout, "").unwrap();
            let bytes = crate::remote::operations::scoped(crate::remote::operations::Context::local(crate::remote::operations::Kind::Read, std::time::Duration::from_secs(40)), || crate::remote::run_command_bytes(&target, &command)).unwrap();
            let parsed = decode_source(adapter, &target, &bytes, None).unwrap();
            eprintln!("remote history {} cold: {}ms wire_bytes={} sessions={} messages={} usage={} partial={} warnings={}", adapter.id(), start.elapsed().as_millis(), bytes.len(), parsed.details.len(), parsed.details.iter().map(|item| item.messages.len()).sum::<usize>(), parsed.details.iter().map(|item| item.usage.len()).sum::<usize>(), parsed.details.iter().filter(|item| item.session.partial).count(), parsed.warning.is_some());
            let start = std::time::Instant::now();
            let command = export_command(layout, &parsed.fingerprint).unwrap();
            let bytes = crate::remote::operations::scoped(crate::remote::operations::Context::local(crate::remote::operations::Kind::Read, std::time::Duration::from_secs(40)), || crate::remote::run_command_bytes(&target, &command)).unwrap();
            let warmed = decode_source(adapter, &target, &bytes, Some(&parsed)).unwrap();
            eprintln!("remote history {} warm: {}ms wire_bytes={} reused={}", adapter.id(), start.elapsed().as_millis(), bytes.len(), Arc::ptr_eq(&parsed.details, &warmed.details));
        }
        for refresh in [true, false] {
            let start = std::time::Instant::now();
            let snapshot = list_snapshot(&Registry::builtins(), &target, refresh).unwrap();
            eprintln!("remote history whole-list refresh={refresh}: {}ms sessions={} failures={}", start.elapsed().as_millis(), snapshot.sessions.len(), snapshot.source_failures.len());
            assert!(snapshot.source_failures.is_empty());
        }
    }

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
            if adapter.id() == "codex" { codex_calls.fetch_add(1, Ordering::SeqCst); sessions_from_home(adapter, &path, &target.id).map(Into::into) }
            else if adapter.id() == "claude_code" { claude_calls.fetch_add(1, Ordering::SeqCst); Err("fixture permission failure".into()) }
            else { Ok(Vec::new().into()) }
        });
        let registry = Registry::builtins();
        let (cold, failures) = snapshot_with_loader(&registry, &target, false, loader.clone()).unwrap();
        assert_eq!(cold.len(), 1); assert!(cold[0].message_count > 0);
        assert_eq!(failures.len(), 1); assert_eq!(failures[0].tool_id, "claude_code");
        assert!(failures[0].message.contains("permission failure"));
        assert_eq!(detail(&registry, &target, &cold[0].id).unwrap().messages.len(), cold[0].message_count);
        let (hot, _) = snapshot_with_loader(&registry, &target, false, loader.clone()).unwrap();
        assert_eq!(hot.len(), 1); assert_eq!(codex.load(Ordering::SeqCst), 1); assert_eq!(claude.load(Ordering::SeqCst), 2);
        let failing: SourceLoader = Arc::new(|_, _| Err("refresh failed".into()));
        let (stale, failed) = snapshot_with_loader(&registry, &target, true, failing).unwrap();
        assert_eq!(stale.len(), 1); assert!(stale[0].stale); assert_eq!(failed.len(), registry.iter().filter(|adapter| adapter.remote_history_layout().is_some()).count());
        let mut changed = target.clone(); changed.host = "replacement.invalid".into(); changed.updated_at += 1;
        let (replaced, _) = snapshot_with_loader(&registry, &changed, false, Arc::new(|_, _| Err("offline replacement".into()))).unwrap();
        assert!(replaced.is_empty(), "same ID cannot expose the old host's cached history");
        crate::remote::read_cache::invalidate(&target.id);
        assert!(crate::remote::read_cache::previous::<SourceSnapshot>(&target, "history:codex").is_none());
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
                expected_files: std::collections::BTreeMap::new(), request_id: request_id.clone(), cancel_token: uuid::Uuid::new_v4().to_string(), target_id: target.id.clone(),
                target_revision: Some(17), kind: Kind::Read, priority: Priority::Interactive, refresh: true,
                deadline_unix_ms: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64 + 3000,
                deadline_ceiling_ms: None,
            }, Kind::Read).unwrap();
            let loader: SourceLoader = std::sync::Arc::new(move |_, _| {
                let context = operations::current().unwrap(); context.dispatched();
                Err(context.failure(reason, "source denied").to_string())
            });
            let (_, failures) = operations::scoped(lease.context.clone(), || snapshot_with_loader(&Registry::builtins(), &target, true, loader)).unwrap();
            assert_eq!(failures.len(), Registry::builtins().iter().filter(|adapter| adapter.remote_history_layout().is_some()).count());
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
        let start = files[0].1.as_ptr() as usize;
        assert!((bytes.as_ptr() as usize..bytes.as_ptr() as usize + bytes.len()).contains(&start), "archive payload must borrow the input buffer");

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
