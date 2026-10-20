//! MiniMax Code (`mcode`) sessions, read-only.
//!
//! Verified layout under the data directory (`MINIMAX_DATA_DIR`, else
//! `MAVIS_DATA_DIR`, else `~/.minimax`):
//! `v2/sessions/YYYY/MM/DD/<stamp>-session_<token>/`.
//!
//! `manifest.json` is schema 1, layout `v2-final-dated-session`, source
//! `local-runtime`. `sessionId` is `mvs_` plus 32 hex digits and is the id
//! `--session` accepts. `messages.jsonl` rows are `{message_id, message}`.
//! User text is `canonicalTextRange` inside the text blocks. The surrounding
//! `system-reminder`, `agent-context`, `media-output-reminder`, and
//! `mcode-tools-master-reminder` tags are wrappers, not the request.
//! Assistant `thinking` blocks are not shown.
//!
//! Token buckets live on the assistant message `usage` object: `input`,
//! `output`, `cacheRead`, and `cacheWrite`. On the checked file they sum to
//! `totalTokens`, so input does not include cache. `usage.cost` is all zeros
//! and is not a price. A message without those four buckets contributes no
//! usage row, so the usage tab stays unknown instead of showing 0.
//!
//! Title and working directory are not in the transcript. They are
//! `local_runtime_sessions.title` and `workspace_dir` (else
//! `project_workspace_dir`) in `v2/sqlite/runtime-state.sqlite`, opened
//! read-only. Only those identity columns are selected. Archived, hidden,
//! non-conversation, and child rows stay out of the list. `auth/`,
//! `llm-call.json`, and the runtime token table are not opened.

use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{data_dir, DataDir};
use crate::history::usage;
use crate::history::source_cache::RevisionCache;
use crate::history::{
    check_cancelled, read_jsonl_filtered, source_fingerprint_controlled, timestamp, valid_native_id,
    HistorySource, ParsedSession, UsageEvent, MAX_SOURCES,
};

const PARSER_VERSION: &str = "minimax-code-session-v2";
const LAYOUT: &str = "v2-final-dated-session";
const LOCAL_SOURCE: &str = "local-runtime";
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;

const WRAPPERS: [&str; 4] = [
    "system-reminder",
    "agent-context",
    "media-output-reminder",
    "mcode-tools-master-reminder",
];

struct Manifest {
    id: String,
    created_at: Option<i64>,
    updated_at: Option<i64>,
}

struct Identity {
    title: Option<String>,
    cwd: Option<String>,
    include: bool,
}

pub fn sources(home: &Path) -> Result<Vec<HistorySource>, String> {
    sources_controlled(home, &|| false)
}

pub fn sources_controlled(
    home: &Path,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<HistorySource>, String> {
    check_cancelled(cancelled)?;
    match data_dir(home) {
        DataDir::Unavailable => Err("MiniMax Code 数据目录不是安全的绝对路径".into()),
        DataDir::Directory(root) => sources_in(&root, cancelled),
    }
}

fn sources_in(root: &Path, cancelled: &dyn Fn() -> bool) -> Result<Vec<HistorySource>, String> {
    check_cancelled(cancelled)?;
    let sessions = root.join("v2").join("sessions");
    if !sessions.exists() {
        return Ok(Vec::new());
    }
    if !is_real_dir(&sessions) {
        return Err("MiniMax Code 会话目录不可读取".into());
    }
    let mut directories = Vec::new();
    collect_sessions(&sessions, cancelled, &mut directories)?;
    directories.sort();
    let identities = runtime_database(&sessions)
        .map(|path| identities(&path, cancelled))
        .transpose()?
        .unwrap_or_default();
    let mut result = Vec::new();
    for directory in directories {
        check_cancelled(cancelled)?;
        let manifest_path = directory.join("manifest.json");
        if !is_real_file(&manifest_path) {
            continue;
        }
        match read_manifest(&manifest_path) {
            Ok(None) => continue,
            Ok(Some(manifest)) => {
                let identity = identities.get(&manifest.id);
                if identity.is_some_and(|item| !item.include) {
                    continue;
                }
                let messages = directory.join("messages.jsonl");
                let path = if is_real_file(&messages) {
                    messages
                } else {
                    manifest_path
                };
                let title = identity.and_then(|item| item.title.clone());
                let cwd = identity.and_then(|item| item.cwd.clone());
                let (fingerprint, fingerprint_error) = match source_fingerprint_controlled(&path, cancelled) {
                    Ok(value) => (format!("{PARSER_VERSION}|{value}|{}", identity_stamp(title.as_deref(), cwd.as_deref())), None),
                    Err(error) => (String::new(), Some(error)),
                };
                result.push(HistorySource {
                    native_title: title,
                    path,
                    native_id: Some(manifest.id),
                    fingerprint,
                    fingerprint_error,
                });
            }
            Err(error) => result.push(HistorySource {
                native_title: None,
                path: manifest_path,
                native_id: None,
                fingerprint: String::new(),
                fingerprint_error: Some(error),
            }),
        }
        if result.len() > MAX_SOURCES {
            return Err("MiniMax Code 会话源超过 5000 个，本次未删除旧索引".into());
        }
    }
    Ok(result)
}

pub fn parse(source: &HistorySource) -> Result<ParsedSession, String> {
    parse_controlled(source, &|| false)
}

pub fn parse_controlled(
    source: &HistorySource,
    cancelled: &dyn Fn() -> bool,
) -> Result<ParsedSession, String> {
    check_cancelled(cancelled)?;
    if source.path.is_symlink() {
        return Err("MiniMax Code 会话文件为符号链接，已跳过".into());
    }
    let directory = session_directory(&source.path).ok_or("MiniMax Code 会话目录无法定位")?;
    let manifest = read_manifest(&directory.join("manifest.json"))
        .map_err(|error| format!("MiniMax Code 会话清单无法读取：{error}"))?
        .ok_or("MiniMax Code 会话清单版本未核对")?;
    if source
        .native_id
        .as_deref()
        .is_some_and(|id| id != manifest.id)
    {
        return Err("会话 ID 与清单不一致".into());
    }
    let identities = runtime_database(directory)
        .map(|path| identities(&path, cancelled))
        .transpose()?
        .unwrap_or_default();
    let identity = identities.get(&manifest.id);
    let mut session = ParsedSession::new();
    session.native_id = Some(manifest.id);
    session.started_at = manifest.created_at;
    session.updated_at = manifest.updated_at;
    if let Some(identity) = identity.as_ref() {
        session.title = identity.title.clone().unwrap_or_default();
        session.cwd = identity.cwd.clone();
    }
    if source.path.file_name().and_then(|name| name.to_str()) == Some("messages.jsonl") {
        let partial = read_jsonl_filtered(source, cancelled, |_| false, |index, row| {
            consume_row(&mut session, index, &row);
        })?;
        session.partial |= partial;
    }
    session.finish(source)
}

fn collect_sessions(
    sessions: &Path,
    cancelled: &dyn Fn() -> bool,
    found: &mut Vec<PathBuf>,
) -> Result<(), String> {
    for year in read_children(sessions)? {
        check_cancelled(cancelled)?;
        if !is_digits(&year, 4) {
            continue;
        }
        let year_path = sessions.join(&year);
        if !is_real_dir(&year_path) {
            continue;
        }
        for month in read_children(&year_path)? {
            check_cancelled(cancelled)?;
            if !is_digits(&month, 2) {
                continue;
            }
            let month_path = year_path.join(&month);
            if !is_real_dir(&month_path) {
                continue;
            }
            for day in read_children(&month_path)? {
                check_cancelled(cancelled)?;
                if !is_digits(&day, 2) {
                    continue;
                }
                let day_path = month_path.join(&day);
                if !is_real_dir(&day_path) {
                    continue;
                }
                for name in read_children(&day_path)? {
                    let path = day_path.join(&name);
                    if is_real_dir(&path) && name.contains("-session_") {
                        found.push(path);
                    }
                }
            }
        }
    }
    Ok(())
}

fn consume_row(session: &mut ParsedSession, index: usize, row: &Value) {
    let message = row.get("message").filter(|value| value.is_object()).unwrap_or(row);
    let role = message.get("role").and_then(Value::as_str).unwrap_or("");
    if role != "user" && role != "assistant" {
        if !role.is_empty() {
            session.partial = true;
        }
        return;
    }
    let id = row
        .get("message_id")
        .and_then(Value::as_str)
        .filter(|id| valid_native_id(id))
        .map(str::to_owned)
        .unwrap_or_else(|| format!("{}:line-{index}", session.native_id.as_deref().unwrap_or("unknown")));
    let time = message.get("timestamp").and_then(timestamp);
    let text = if role == "user" {
        user_text(session, message)
    } else {
        joined_text(message.get("content").unwrap_or(&Value::Null))
    };
    session.add_message(id.clone(), role, text, time);
    if role == "assistant" {
        add_usage(session, &id, time, message);
    }
}

fn add_usage(session: &mut ParsedSession, id: &str, time: Option<i64>, message: &Value) {
    let Some(usage) = message.get("usage") else {
        return;
    };
    if !usage.is_object() {
        session.partial = true;
        return;
    }
    let input = usage::field(usage, "input");
    let output = usage::field(usage, "output");
    let read = usage::field(usage, "cacheRead");
    let write = usage::field(usage, "cacheWrite");
    // A missing bucket would be stored as NULL and later displayed as 0.
    // Keep the event only when the file itself has all four disjoint buckets.
    let (Some(input), Some(output), Some(read), Some(write)) = (input, output, read, write) else {
        session.partial = true;
        return;
    };
    if let Some(total) = usage::field(usage, "totalTokens") {
        if input.saturating_add(output).saturating_add(read).saturating_add(write) != total {
            session.partial = true;
        }
    }
    let model = message
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(str::to_owned);
    if session.model.is_none() {
        session.model.clone_from(&model);
    }
    session.usage.push(UsageEvent { native_usage: None,
        request_count: Some(1),
        id: id.to_owned(),
        model,
        timestamp: time,
        input: Some(input),
        output: Some(output),
        cache_read: Some(read),
        cache_write: Some(write),
        input_includes_cache: false,
    });
}

fn user_text(session: &mut ParsedSession, message: &Value) -> String {
    let full = joined_text(message.get("content").unwrap_or(&Value::Null));
    let Some(span) = message.get("canonicalTextRange") else {
        return outside_wrappers(&full).trim().to_owned();
    };
    match canonical_slice(&full, span) {
        Some(text) => text.trim().to_owned(),
        None => {
            session.partial = true;
            String::new()
        }
    }
}

fn canonical_slice(text: &str, span: &Value) -> Option<String> {
    let start = offset(span.get("startOffset")?)?;
    let end = offset(span.get("endOffset")?)?;
    let count = text.chars().count();
    if start > end || end > count {
        return None;
    }
    Some(text.chars().skip(start).take(end - start).collect())
}

fn offset(value: &Value) -> Option<usize> {
    value.as_u64().and_then(|value| usize::try_from(value).ok())
}

fn joined_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| {
                let kind = part.get("type").and_then(Value::as_str).unwrap_or("");
                if matches!(kind, "text" | "input_text" | "output_text") {
                    part.get("text").and_then(Value::as_str)
                } else {
                    None
                }
            })
            .collect(),
        _ => String::new(),
    }
}

fn outside_wrappers(text: &str) -> String {
    let mut current = text.to_owned();
    for tag in WRAPPERS {
        let open = format!("<{tag}>");
        let close = format!("</{tag}>");
        let mut next = String::new();
        let mut rest = current.as_str();
        while let Some(start) = rest.find(&open) {
            next.push_str(&rest[..start]);
            let after = &rest[start + open.len()..];
            if let Some(end) = after.find(&close) {
                rest = &after[end + close.len()..];
            } else {
                rest = "";
                break;
            }
        }
        next.push_str(rest);
        current = next;
    }
    current
}

fn read_manifest(path: &Path) -> Result<Option<Manifest>, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Ok(None);
    }
    if metadata.len() > MAX_MANIFEST_BYTES {
        return Err("会话清单过大，未读取".into());
    }
    let text = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let value: Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(_) => return Err("会话清单无法解析".into()),
    };
    if value.get("schemaVersion").and_then(Value::as_i64) != Some(1)
        || value.get("layout").and_then(Value::as_str) != Some(LAYOUT)
        || value.get("source").and_then(Value::as_str) != Some(LOCAL_SOURCE)
    {
        return Ok(None);
    }
    let id = value.get("sessionId").and_then(Value::as_str).unwrap_or("");
    if !valid_session_id(id) {
        return Err("会话 ID 无效".into());
    }
    Ok(Some(Manifest {
        id: id.to_owned(),
        created_at: value.get("createdAtMs").and_then(timestamp),
        updated_at: value.get("updatedAtMs").and_then(timestamp),
    }))
}

fn valid_session_id(id: &str) -> bool {
    let Some(rest) = id.strip_prefix("mvs_") else {
        return false;
    };
    valid_native_id(id) && rest.len() == 32 && rest.chars().all(|character| character.is_ascii_hexdigit())
}

fn runtime_database(start: &Path) -> Option<PathBuf> {
    let mut current = start;
    loop {
        if current.file_name().and_then(|name| name.to_str()) == Some("v2") {
            let database = current.join("sqlite").join("runtime-state.sqlite");
            return is_real_file(&database).then_some(database);
        }
        current = current.parent()?;
    }
}

fn session_directory(path: &Path) -> Option<&Path> {
    let directory = path.parent()?;
    let name = directory.file_name().and_then(|name| name.to_str())?;
    name.contains("-session_").then_some(directory)
}

fn identities(database: &Path, cancelled: &dyn Fn() -> bool) -> Result<Arc<HashMap<String, Identity>>, String> {
    // Discovery primes this shared cache before the concurrent session parsers.
    // Arc avoids copying every identity for each transcript. The shared cache
    // checks both DB and WAL revisions and never retains failed reads.
    static CACHE: LazyLock<RevisionCache<Arc<HashMap<String, Identity>>>> = LazyLock::new(RevisionCache::new);
    let result = CACHE.read(database, cancelled, || read_identities(database, cancelled).map(Arc::new));
    check_cancelled(cancelled)?;
    // Identity is optional: preserve transcript access when SQLite is busy or
    // unavailable, and retry the metadata on the next read.
    Ok(result.unwrap_or_default())
}

fn read_identities(database: &Path, cancelled: &dyn Fn() -> bool) -> Result<HashMap<String, Identity>, String> {
    let mut found = HashMap::new();
    let connection = Connection::open_with_flags(
        database,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ).map_err(|error| error.to_string())?;
    connection.busy_timeout(Duration::from_millis(500)).map_err(|error| error.to_string())?;
    connection.pragma_update(None, "query_only", 1).map_err(|error| error.to_string())?;
    let mut statement = connection.prepare(
        "SELECT session_id, title, workspace_dir, project_workspace_dir, session_kind, visibility, archived, parent_session_id
         FROM local_runtime_sessions",
    ).map_err(|error| error.to_string())?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, Option<i64>>(6)?,
            row.get::<_, Option<String>>(7)?,
        ))
    }).map_err(|error| error.to_string())?;
    for row in rows {
        check_cancelled(cancelled)?;
        let (id, title, workspace, project, kind, visibility, archived, parent) = match row {
            Ok(row) => row,
            // Preserve the previous per-row tolerance without caching actual
            // database read failures or losing other rows' visibility rules.
            Err(rusqlite::Error::InvalidColumnType(..)
                | rusqlite::Error::FromSqlConversionFailure(..)
                | rusqlite::Error::IntegralValueOutOfRange(..)) => continue,
            Err(error) => return Err(error.to_string()),
        };
        if !valid_session_id(&id) {
            continue;
        }
        found.insert(
            id,
            Identity {
                title: clean_title(title),
                cwd: safe_workspace(workspace).or_else(|| safe_workspace(project)),
                include: include_session(kind.as_deref(), visibility.as_deref(), archived, parent.as_deref()),
            },
        );
    }
    Ok(found)
}

fn include_session(kind: Option<&str>, visibility: Option<&str>, archived: Option<i64>, parent: Option<&str>) -> bool {
    if parent.is_some_and(|value| !value.trim().is_empty()) || archived.unwrap_or(0) != 0 {
        return false;
    }
    if visibility.is_some_and(|value| {
        let value = value.trim();
        !value.is_empty() && value != "visible"
    }) {
        return false;
    }
    if kind.is_some_and(|value| {
        let value = value.trim();
        !value.is_empty() && value != "conversation"
    }) {
        return false;
    }
    true
}

fn clean_title(value: Option<String>) -> Option<String> {
    let value = value?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(512).collect())
}

fn safe_workspace(value: Option<String>) -> Option<String> {
    let value = value?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = Path::new(trimmed);
    if !path.is_absolute() || path.components().any(|part| matches!(part, Component::ParentDir)) {
        return None;
    }
    Some(trimmed.to_owned())
}

fn identity_stamp(title: Option<&str>, cwd: Option<&str>) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("{}\n{}", title.unwrap_or(""), cwd.unwrap_or("")).as_bytes())
    )
}

fn read_children(path: &Path) -> Result<Vec<String>, String> {
    let mut names = Vec::new();
    for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if let Some(name) = entry.file_name().to_str() {
            names.push(name.to_owned());
        }
    }
    Ok(names)
}

fn is_digits(name: &str, length: usize) -> bool {
    name.len() == length && name.chars().all(|character| character.is_ascii_digit())
}

fn is_real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .ok()
        .is_some_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
}

fn is_real_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .ok()
        .is_some_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn missing_message_ids_do_not_collide_between_sessions() {
        let mut ids = Vec::new();
        for native_id in ["session-a", "session-b"] {
            let mut session = ParsedSession::new();
            session.native_id = Some(native_id.into());
            let mut row: Value = serde_json::from_str(&assistant_line(Some(json!({"input":100,"output":20,"cacheRead":10,"cacheWrite":0})))).unwrap();
            row.as_object_mut().unwrap().remove("message_id");
            consume_row(&mut session, 1, &row);
            assert_eq!(session.usage.len(), 1);
            ids.push(session.usage[0].id.clone());
        }
        assert_ne!(ids[0], ids[1]);
    }

    #[test]
    #[ignore = "synthetic performance measurement; writes only temporary fixtures"]
    fn performance_minimax_history() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        write_runtime(home, &[]);
        let database = home.join(".minimax/v2/sqlite/runtime-state.sqlite");
        let mut connection = Connection::open(&database).unwrap();
        let tx = connection.transaction().unwrap();
        for index in 0..300 {
            let id = format!("mvs_{index:032x}");
            tx.execute("INSERT INTO local_runtime_sessions (session_id,title,session_kind,visibility,archived) VALUES (?1,'Benchmark','conversation','visible',0)", [&id]).unwrap();
            let directory = home.join(format!(".minimax/v2/sessions/2026/10/11/01-00-00-{index:03}-session_{index}"));
            fs::create_dir_all(&directory).unwrap();
            write_manifest(&directory, &id, LOCAL_SOURCE);
            fs::write(directory.join("messages.jsonl"), format!("{}\n", assistant_line(Some(json!({"input":100,"output":20,"cacheRead":10,"cacheWrite":0}))))).unwrap();
        }
        tx.commit().unwrap();
        drop(connection);
        for pass in 0..3 {
            let start = std::time::Instant::now();
            let sources = sources_in(&home.join(".minimax"), &|| false).unwrap();
            assert_eq!(sources.len(), 300);
            let discovered = start.elapsed();
            let records: usize = sources.iter().map(|source| parse(source).unwrap().usage.len()).sum();
            assert_eq!(records, 300);
            eprintln!("BENCH minimax pass={pass} sources=300 discover_ms={:.2} discover_parse_ms={:.2}", discovered.as_secs_f64()*1000.0, start.elapsed().as_secs_f64()*1000.0);
        }
    }

    const SESSION: &str = "mvs_0123456789abcdef0123456789abcdef";
    const EMPTY: &str = "mvs_abcdef0123456789abcdef0123456789";
    const SECRET: &str = "sk-test-minimax-secret";

    #[test]
    fn identity_cache_reuses_snapshot_and_tracks_wal_changes() {
        let temp = tempfile::tempdir().unwrap();
        write_runtime(temp.path(), &[(SESSION, Some("old"), None, "conversation", "visible", 0, None)]);
        let database = temp.path().join(".minimax/v2/sqlite/runtime-state.sqlite");
        let connection = Connection::open(&database).unwrap();
        connection.execute_batch("PRAGMA journal_mode=WAL").unwrap();
        // Materialize the WAL before measuring reuse; opening the first reader
        // of a newly switched database can itself change the source revision.
        connection.execute("UPDATE local_runtime_sessions SET title='old'", []).unwrap();
        let first = identities(&database, &|| false).unwrap();
        let again = identities(&database, &|| false).unwrap();
        assert!(Arc::ptr_eq(&first, &again));
        connection.execute("UPDATE local_runtime_sessions SET title='new', archived=1", []).unwrap();
        let changed = identities(&database, &|| false).unwrap();
        assert!(!Arc::ptr_eq(&first, &changed));
        assert_eq!(changed[SESSION].title.as_deref(), Some("new"));
        assert!(!changed[SESSION].include);
        assert_eq!(first[SESSION].title.as_deref(), Some("old"));
        connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
        assert_eq!(identities(&database, &|| false).unwrap()[SESSION].title.as_deref(), Some("new"));
        assert!(identities(&database, &|| true).is_err());
    }

    #[test]
    fn unavailable_identity_schema_is_retried() {
        let temp = tempfile::tempdir().unwrap();
        let database = temp.path().join(".minimax/v2/sqlite/runtime-state.sqlite");
        fs::create_dir_all(database.parent().unwrap()).unwrap();
        drop(Connection::open(&database).unwrap());
        assert!(identities(&database, &|| false).unwrap().is_empty());
        write_runtime(temp.path(), &[(SESSION, Some("recovered"), None, "conversation", "visible", 0, None)]);
        assert_eq!(identities(&database, &|| false).unwrap()[SESSION].title.as_deref(), Some("recovered"));
    }

    #[test]
    fn malformed_identity_does_not_discard_valid_titles_or_visibility() {
        let temp = tempfile::tempdir().unwrap();
        write_runtime(temp.path(), &[
            (SESSION, Some("visible"), None, "conversation", "visible", 0, None),
            (EMPTY, Some("archived"), None, "conversation", "visible", 1, None),
        ]);
        let database = temp.path().join(".minimax/v2/sqlite/runtime-state.sqlite");
        let connection = Connection::open(&database).unwrap();
        connection.execute("INSERT INTO local_runtime_sessions (session_id, title) VALUES ('mvs_11111111111111111111111111111111', x'ff')", []).unwrap();
        let found = identities(&database, &|| false).unwrap();
        assert_eq!(found.len(), 2);
        assert_eq!(found[SESSION].title.as_deref(), Some("visible"));
        assert!(found[SESSION].include);
        assert!(!found[EMPTY].include);
    }

    fn write_manifest(dir: &Path, id: &str, source: &str) {
        let manifest = json!({
            "schemaVersion": 1,
            "layout": LAYOUT,
            "source": source,
            "sessionId": id,
            "createdAtMs": 1_791_680_461_858_i64,
            "updatedAtMs": 1_791_680_468_481_i64,
            "paths": {
                "messages": dir.join("..").join("llm-call.json")
            }
        });
        fs::write(dir.join("manifest.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
    }

    fn write_runtime(home: &Path, rows: &[( &str, Option<&str>, Option<&str>, &str, &str, i64, Option<&str>)]) {
        let directory = home.join(".minimax").join("v2").join("sqlite");
        fs::create_dir_all(&directory).unwrap();
        let database = directory.join("runtime-state.sqlite");
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE local_runtime_sessions (
                    session_id TEXT,
                    title TEXT,
                    workspace_dir TEXT,
                    project_workspace_dir TEXT,
                    session_kind TEXT,
                    visibility TEXT,
                    archived INTEGER,
                    parent_session_id TEXT,
                    record_json TEXT
                );
                CREATE TABLE local_runtime_token_usage (session_id TEXT, secret TEXT);",
            )
            .unwrap();
        for (id, title, workspace, kind, visibility, archived, parent) in rows {
            connection
                .execute(
                    "INSERT INTO local_runtime_sessions
                     (session_id, title, workspace_dir, project_workspace_dir, session_kind, visibility, archived, parent_session_id, record_json)
                     VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?8)",
                    rusqlite::params![id, title, workspace, kind, visibility, archived, parent, SECRET],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO local_runtime_token_usage (session_id, secret) VALUES (?1, ?2)",
                    [id, &SECRET],
                )
                .unwrap();
        }
    }

    fn user_line(text_prefix: &str, query: &str) -> String {
        let text = format!("{text_prefix}{query}");
        let start = text_prefix.chars().count();
        let end = text.chars().count();
        serde_json::to_string(&json!({
            "message_id": "user-1",
            "message": {
                "role": "user",
                "timestamp": 1_791_680_461_858_i64,
                "canonicalTextRange": { "startOffset": start, "endOffset": end },
                "content": [{ "type": "text", "text": text }]
            }
        }))
        .unwrap()
    }

    fn assistant_line(usage: Option<Value>) -> String {
        let mut message = json!({
            "role": "assistant",
            "timestamp": 1_791_680_462_000_i64,
            "model": "MiniMax-M3-Test",
            "provider": "minimax",
            "content": [
                { "type": "thinking", "thinking": SECRET },
                { "type": "text", "text": "已记下用量。" }
            ]
        });
        if let Some(usage) = usage {
            message["usage"] = usage;
        }
        serde_json::to_string(&json!({
            "message_id": "assistant-1",
            "message": message
        }))
        .unwrap()
    }

    fn plant_secrets(home: &Path, session: &Path) {
        let auth = home.join(".minimax").join("auth");
        fs::create_dir_all(&auth).unwrap();
        fs::write(auth.join("token"), SECRET).unwrap();
        fs::write(session.join("llm-call.json"), SECRET).unwrap();
        fs::write(home.join(".minimax").join("v2").join("sqlite").join("runtime-state.sqlite-secret"), SECRET).unwrap();
    }

    fn contains_secret(session: &ParsedSession) -> bool {
        session.title.contains(SECRET)
            || session.cwd.as_deref().unwrap_or("").contains(SECRET)
            || session.model.as_deref().unwrap_or("").contains(SECRET)
            || session.native_id.as_deref().unwrap_or("").contains(SECRET)
            || session.messages.iter().any(|message| message.text.contains(SECRET))
            || session.usage.iter().any(|event| event.model.as_deref().unwrap_or("").contains(SECRET))
    }

    #[test]
    fn indexed_session_keeps_title_directory_and_disjoint_tokens() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let directory = home
            .join(".minimax")
            .join("v2")
            .join("sessions")
            .join("2026")
            .join("10")
            .join("11")
            .join("01-00-00-000-session_one");
        fs::create_dir_all(&directory).unwrap();
        write_manifest(&directory, SESSION, LOCAL_SOURCE);
        let prefix = "<system-reminder>包装</system-reminder>\n<agent-context>上下文</agent-context>\n";
        let query = "修复索引显示";
        let usage = json!({
            "input": 13404,
            "output": 98,
            "cacheRead": 370,
            "cacheWrite": 0,
            "totalTokens": 13872,
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 999 }
        });
        let messages = format!("{}\n{}\n", user_line(prefix, query), assistant_line(Some(usage)));
        let messages_path = directory.join("messages.jsonl");
        fs::write(&messages_path, &messages).unwrap();
        let workspace = home.join("work").join("demo");
        write_runtime(
            home,
            &[(SESSION, Some("清单标题"), Some(workspace.to_str().unwrap()), "conversation", "visible", 0, None)],
        );
        plant_secrets(home, &directory);
        let before_messages = fs::read(&messages_path).unwrap();
        let before_manifest = fs::read(directory.join("manifest.json")).unwrap();
        let before_auth = fs::read(home.join(".minimax").join("auth").join("token")).unwrap();
        let before_call = fs::read(directory.join("llm-call.json")).unwrap();
        let database = home.join(".minimax").join("v2").join("sqlite").join("runtime-state.sqlite");
        let before_database = fs::read(&database).unwrap();

        let listed = sources(home).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].native_id.as_deref(), Some(SESSION));
        assert_eq!(listed[0].native_title.as_deref(), Some("清单标题"));
        assert!(listed[0].fingerprint.starts_with("minimax-code-session-v2|"));
        let parsed = parse(&listed[0]).unwrap();

        assert_eq!(fs::read(&messages_path).unwrap(), before_messages);
        assert_eq!(fs::read(directory.join("manifest.json")).unwrap(), before_manifest);
        assert_eq!(fs::read(home.join(".minimax").join("auth").join("token")).unwrap(), before_auth);
        assert_eq!(fs::read(directory.join("llm-call.json")).unwrap(), before_call);
        assert_eq!(fs::read(&database).unwrap(), before_database);
        assert!(!contains_secret(&parsed));
        assert_eq!(parsed.native_id.as_deref(), Some(SESSION));
        assert_eq!(parsed.title, "清单标题");
        assert_eq!(parsed.cwd.as_deref(), Some(workspace.to_str().unwrap()));
        assert_eq!(parsed.started_at, Some(1_791_680_461_858));
        assert_eq!(parsed.updated_at, Some(1_791_680_468_481));
        assert_eq!(parsed.model.as_deref(), Some("MiniMax-M3-Test"));
        assert!(!parsed.partial);
        let texts: Vec<_> = parsed.messages.iter().map(|item| (item.role.as_str(), item.text.as_str())).collect();
        assert_eq!(texts, vec![("user", query), ("assistant", "已记下用量。")]);
        assert_eq!(parsed.usage.len(), 1);
        let event = &parsed.usage[0];
        assert_eq!(event.input, Some(13404));
        assert_eq!(event.output, Some(98));
        assert_eq!(event.cache_read, Some(370));
        assert_eq!(event.cache_write, Some(0));
        assert!(!event.input_includes_cache);
        assert_eq!(event.model.as_deref(), Some("MiniMax-M3-Test"));
        assert_eq!(event.request_count, Some(1));
    }

    #[test]
    fn missing_tokens_stay_unknown_and_empty_identity_still_lists() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let day = home.join(".minimax").join("v2").join("sessions").join("2026").join("10").join("11");
        let filled = day.join("01-00-00-000-session_one");
        let empty = day.join("02-00-00-000-session_two");
        fs::create_dir_all(&filled).unwrap();
        fs::create_dir_all(&empty).unwrap();
        write_manifest(&filled, SESSION, LOCAL_SOURCE);
        write_manifest(&empty, EMPTY, LOCAL_SOURCE);
        fs::write(
            filled.join("messages.jsonl"),
            format!("{}\n", assistant_line(None)),
        )
        .unwrap();
        fs::write(empty.join("messages.jsonl"), b"").unwrap();
        let workspace = home.join("work").join("empty");
        write_runtime(
            home,
            &[
                (SESSION, None, Some(workspace.to_str().unwrap()), "conversation", "visible", 0, None),
                (EMPTY, None, None, "conversation", "visible", 0, None),
            ],
        );
        connection_project_only(home, EMPTY, workspace.to_str().unwrap());

        let listed = sources(home).unwrap();
        assert_eq!(listed.len(), 2);
        let filled_source = listed.iter().find(|source| source.native_id.as_deref() == Some(SESSION)).unwrap();
        let empty_source = listed.iter().find(|source| source.native_id.as_deref() == Some(EMPTY)).unwrap();
        let filled_session = parse(filled_source).unwrap();
        let empty_session = parse(empty_source).unwrap();
        assert!(filled_session.usage.is_empty());
        assert!(filled_session.model.is_none());
        assert_eq!(filled_session.messages.len(), 1);
        assert_eq!(filled_session.cwd.as_deref(), Some(workspace.to_str().unwrap()));
        assert_eq!(empty_session.native_id.as_deref(), Some(EMPTY));
        assert!(empty_session.usage.is_empty());
        assert!(empty_session.model.is_none());
        assert!(empty_session.messages.is_empty());
        assert_eq!(empty_session.title, "未命名会话");
        assert_eq!(empty_session.cwd.as_deref(), Some(workspace.to_str().unwrap()));
    }

    fn connection_project_only(home: &Path, id: &str, project: &str) {
        let database = home.join(".minimax").join("v2").join("sqlite").join("runtime-state.sqlite");
        let connection = Connection::open(&database).unwrap();
        connection
            .execute(
                "UPDATE local_runtime_sessions SET workspace_dir = NULL, project_workspace_dir = ?1 WHERE session_id = ?2",
                [project, id],
            )
            .unwrap();
    }

    #[test]
    fn damaged_manifest_does_not_hide_a_complete_session() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let day = home.join(".minimax").join("v2").join("sessions").join("2026").join("10").join("11");
        let good = day.join("01-00-00-000-session_one");
        let bad = day.join("02-00-00-000-session_two");
        fs::create_dir_all(&good).unwrap();
        fs::create_dir_all(&bad).unwrap();
        write_manifest(&good, SESSION, LOCAL_SOURCE);
        fs::write(good.join("messages.jsonl"), format!("{}\n{{not json}}\n", user_line("<system-reminder>x</system-reminder>", "完整会话"))).unwrap();
        fs::write(bad.join("manifest.json"), b"{").unwrap();
        fs::write(
            bad.join("messages.jsonl"),
            "{\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"隐藏\"}]}}\n",
        )
        .unwrap();
        write_runtime(home, &[(SESSION, Some("完整"), None, "conversation", "visible", 0, None)]);

        let listed = sources(home).unwrap();
        assert_eq!(listed.len(), 2);
        let good_source = listed.iter().find(|source| source.native_id.as_deref() == Some(SESSION)).unwrap();
        let bad_source = listed.iter().find(|source| source.fingerprint_error.is_some()).unwrap();
        assert!(bad_source.fingerprint_error.as_deref().unwrap().contains("无法解析"));
        let parsed = parse(good_source).unwrap();
        assert_eq!(parsed.title, "完整");
        assert!(parsed.partial);
        assert_eq!(parsed.messages[0].text, "完整会话");
        assert!(parsed.usage.is_empty());
    }

    #[test]
    fn side_archived_and_remote_sessions_stay_out() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let day = home.join(".minimax").join("v2").join("sessions").join("2026").join("10").join("11");
        let names: [(&str, &str, &str, &str, i64, Option<&str>); 4] = [
            ("01-00-00-000-session_child", "mvs_11111111111111111111111111111111", "conversation", "visible", 0, Some(SESSION)),
            ("02-00-00-000-session_archived", "mvs_22222222222222222222222222222222", "conversation", "visible", 1, None),
            ("03-00-00-000-session_hidden", "mvs_33333333333333333333333333333333", "conversation", "hidden", 0, None),
            ("04-00-00-000-session_side", "mvs_44444444444444444444444444444444", "side", "visible", 0, None),
        ];
        let mut rows = Vec::new();
        for (name, id, kind, visibility, archived, parent) in names {
            let directory = day.join(name);
            fs::create_dir_all(&directory).unwrap();
            write_manifest(&directory, id, LOCAL_SOURCE);
            fs::write(directory.join("messages.jsonl"), format!("{}\n", user_line("", "旁路"))).unwrap();
            rows.push((id, Some("旁路"), None, kind, visibility, archived, parent));
        }
        let remote = day.join("05-00-00-000-session_remote");
        fs::create_dir_all(&remote).unwrap();
        write_manifest(&remote, "mvs_55555555555555555555555555555555", "remote");
        fs::write(remote.join("messages.jsonl"), b"{}\n").unwrap();
        write_runtime(home, &rows);
        assert!(sources(home).unwrap().is_empty());
    }

    #[test]
    fn unsafe_workspace_stays_unknown_and_title_changes_rescan() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let directory = home
            .join(".minimax")
            .join("v2")
            .join("sessions")
            .join("2026")
            .join("10")
            .join("11")
            .join("01-00-00-000-session_one");
        fs::create_dir_all(&directory).unwrap();
        write_manifest(&directory, SESSION, LOCAL_SOURCE);
        fs::write(directory.join("messages.jsonl"), b"").unwrap();
        let escaped = home.join("..").join("secret");
        write_runtime(home, &[(SESSION, Some("原标题"), Some(escaped.to_str().unwrap()), "conversation", "visible", 0, None)]);
        let listed = sources(home).unwrap();
        let parsed = parse(&listed[0]).unwrap();
        assert_eq!(parsed.title, "原标题");
        assert!(parsed.cwd.is_none());
        let first = listed[0].fingerprint.clone();
        let database = home.join(".minimax").join("v2").join("sqlite").join("runtime-state.sqlite");
        let connection = Connection::open(&database).unwrap();
        connection
            .execute("UPDATE local_runtime_sessions SET title = ?1 WHERE session_id = ?2", ["新标题", SESSION])
            .unwrap();
        drop(connection);
        let again = sources(home).unwrap();
        assert_ne!(again[0].fingerprint, first);
        assert_eq!(parse(&again[0]).unwrap().title, "新标题");
        assert!(sources(Path::new("/home/example")).unwrap().is_empty());
        assert!(sources_controlled(home, &|| true).unwrap_err().contains("取消"));
    }

    #[test]
    fn mismatched_total_is_partial_and_wrapper_without_range_is_dropped() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let directory = home
            .join(".minimax")
            .join("v2")
            .join("sessions")
            .join("2026")
            .join("10")
            .join("11")
            .join("01-00-00-000-session_one");
        fs::create_dir_all(&directory).unwrap();
        write_manifest(&directory, SESSION, LOCAL_SOURCE);
        let wrapped = "<mcode-tools-master-reminder>工具说明</mcode-tools-master-reminder>\n只留这句";
        let row = json!({
            "message_id": "user-2",
            "message": {
                "role": "user",
                "content": [{ "type": "text", "text": wrapped }]
            }
        });
        let usage = json!({
            "input": 10, "output": 2, "cacheRead": 3, "cacheWrite": 4, "totalTokens": 1
        });
        fs::write(
            directory.join("messages.jsonl"),
            format!("{}\n{}\n", serde_json::to_string(&row).unwrap(), assistant_line(Some(usage))),
        )
        .unwrap();
        let parsed = parse(&sources(home).unwrap()[0]).unwrap();
        assert!(parsed.partial);
        assert_eq!(parsed.messages[0].text, "只留这句");
        assert!(!parsed.messages.iter().any(|message| message.text.contains("工具说明")));
        assert_eq!(parsed.usage[0].input, Some(10));
        assert_eq!(parsed.usage[0].cache_read, Some(3));
        assert!(!parsed.usage[0].input_includes_cache);
    }
}
