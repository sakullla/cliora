//! Cline session sources: the SQLite index plus per-session directories.
//!
//! [src] Evidence: cline/cline@main (2026-10-07). The CLI is not installed
//! locally, so exactly the shapes pinned by the source summary are parsed;
//! anything else fails the session as a parse error instead of being guessed.
//!
//! Layout under the data root (`~/.cline/data`, `CLINE_DATA_DIR`):
//!
//! * `db/sessions.db` — SQLite session index. The `sessions` table carries at
//!   least `session_id` and a `metadata_json` TEXT column whose JSON holds
//!   `usage`/`aggregateUsage`
//!   `{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,totalCost}`
//!   session aggregates. It is opened read-only and used for listing; a
//!   missing database falls back to enumerating session directories, a
//!   present-but-unreadable one fails the scan.
//! * `sessions/<id>/` — one directory per session:
//!   * `<id>.json` manifest (zod v1 schema: `session_id/source/pid/
//!     started_at/ended_at/exit_code/status/interactive/provider/model/cwd/
//!     workspace_root/prompt/metadata/messages_path/compaction_path`);
//!   * `<id>.messages.json` — an array file of `StoredMessageWithMetadata[]`;
//!     each message may carry `metrics{inputTokens,outputTokens,
//!     cacheReadTokens,cacheWriteTokens,cost}`;
//!   * `<id>.compaction.json` — compaction snapshot, preserved read-only and
//!     never counted as usage or transcript;
//!   * subagent/team stems `<agentId>__<teamTaskId>.*.messages.json` in the
//!     same directory: their billed metrics fold into the parent session's
//!     usage while their transcript stays out of the main timeline.
//!
//! Usage semantics: stored `metrics.inputTokens` EXCLUDES cache read/write
//! and both cache directions are explicit columns → `input_includes_cache`
//! is false on every event. `metrics.cost` has no channel in the shared
//! `UsageEvent` contract; it is cross-checked in module tests only. A session
//! whose message files yield no per-message metrics falls back to ONE
//! aggregate event from `metadata_json` (`request_count: None` marks the
//! aggregate/unknown semantics). providers.json never enters this pipeline.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde_json::Value;

use crate::history::usage;
use crate::history::{
    check_cancelled, text_content, timestamp, valid_native_id, AgentKind, ChildSession,
    HistoryMessage, HistoryMessageKind, HistorySource, MessageTimeSource, ParsedSession,
    UsageAttribution, UsageEvent, MAX_SOURCES,
};

pub fn sources(home: &Path) -> Result<Vec<HistorySource>, String> {
    sources_controlled(home, &|| false)
}

pub fn sources_controlled(
    home: &Path,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<HistorySource>, String> {
    check_cancelled(cancelled)?;
    let sessions_root = super::data_root(home).join("sessions");
    let database = super::sessions_db(home);
    let mut revisions = std::collections::HashMap::new();
    let ids: Vec<String> = if database.is_file() {
        let connection = open(&database)?;
        let mut statement = connection
            .prepare("SELECT session_id, json_array(title,started_at,ended_at,metadata_json) FROM sessions ORDER BY rowid DESC LIMIT ?1")
            .map_err(|error| format!("Cline 会话库结构无法识别：{error}"))?;
        let rows = statement
            .query_map([MAX_SOURCES as i64 + 1], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(|error| error.to_string())?;
        let mut ids = Vec::new();
        for row in rows {
            check_cancelled(cancelled)?;
            let (id, metadata) = row.map_err(|error| error.to_string())?;
            revisions.insert(id.clone(), hex(&md5_hex(metadata.as_bytes())));
            ids.push(id);
        }
        drop(statement);
        ids
    } else if sessions_root.is_dir() {
        // No index database yet: enumerate the verified session-directory
        // layout directly.
        let mut ids = Vec::new();
        for entry in fs::read_dir(&sessions_root).map_err(|error| error.to_string())? {
            check_cancelled(cancelled)?;
            let entry = entry.map_err(|error| error.to_string())?;
            if !entry.file_type().map_err(|error| error.to_string())?.is_dir() {
                continue;
            }
            let id = entry.file_name().to_string_lossy().into_owned();
            if valid_native_id(&id) {
                ids.push(id);
            }
        }
        ids
    } else {
        return Ok(Vec::new());
    };
    if ids.len() > MAX_SOURCES {
        return Err("Cline 会话源超过 5000 个，本次未删除旧索引".into());
    }
    let mut sources = Vec::new();
    for id in ids {
        check_cancelled(cancelled)?;
        if !valid_native_id(&id) {
            continue;
        }
        let manifest = sessions_root.join(&id).join(format!("{id}.json"));
        let checked = if manifest.is_file() {
            fingerprint_directory(manifest.parent().unwrap(), cancelled)
                .map(|stamp| format!("{stamp}|{}", revisions.get(&id).map(String::as_str).unwrap_or("no-index")))
        } else {
            Err("Cline 会话目录或清单缺失".into())
        };
        sources.push(HistorySource {
            native_title: None,
            path: manifest,
            native_id: Some(id),
            fingerprint: checked.as_ref().cloned().unwrap_or_default(),
            fingerprint_error: checked.err(),
        });
    }
    Ok(sources)
}

fn open(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("Cline 会话库无法只读打开：{error}"))?;
    connection
        .busy_timeout(std::time::Duration::from_millis(500))
        .map_err(|error| error.to_string())?;
    let tables = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sessions'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("Cline 会话库结构无法识别：{error}"))?;
    if tables != 1 {
        return Err("Cline 会话库缺少 sessions 表".into());
    }
    Ok(connection)
}

fn md5_hex(bytes: &[u8]) -> [u8; 16] {
    // A stable, dependency-free digest is enough here: the fingerprint only
    // needs to change when the underlying files change, not resist attacks.
    let mut hash: [u8; 16] = [0u8; 16];
    for (index, byte) in bytes.iter().enumerate() {
        hash[index % 16] ^= *byte;
        hash[(index + 7) % 16] = hash[(index + 7) % 16].wrapping_add(*byte);
        hash[(index * 3 + 1) % 16] = hash[(index * 3 + 1) % 16].rotate_left(1);
    }
    hash
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Folds name and shared change-time revision of every regular file in the session directory
/// into one order-independent digest, so any append to the messages file, a
/// new subagent stem or a rewritten manifest reindexes that session only.
/// A child-file stamp or a directory listing failure stays in that digest.
/// The manifest and the main transcript still fail the parent fingerprint.
fn fingerprint_directory(dir: &Path, cancelled: &dyn Fn() -> bool) -> Result<String, String> {
    check_cancelled(cancelled)?;
    let session_id = dir.file_name().and_then(|name| name.to_str()).unwrap_or("");
    let mut rows = Vec::new();
    let mut list_failed = false;
    match fs::read_dir(dir) {
        Ok(entries) => {
            for entry in entries {
                check_cancelled(cancelled)?;
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(error) if cancelled() || scan_cancelled(&error.to_string()) => {
                        return Err(error.to_string())
                    }
                    Err(_) => {
                        list_failed = true;
                        continue;
                    }
                };
                let kind = match entry.file_type() {
                    Ok(kind) => kind,
                    Err(error) if cancelled() || scan_cancelled(&error.to_string()) => {
                        return Err(error.to_string())
                    }
                    Err(_) => {
                        list_failed = true;
                        continue;
                    }
                };
                if !kind.is_file() {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                rows.push(fingerprint_row(&entry.path(), &name, session_id, cancelled)?);
            }
        }
        Err(error) if cancelled() || scan_cancelled(&error.to_string()) => return Err(error.to_string()),
        Err(_) => list_failed = true,
    }
    if list_failed {
        rows.push(format!("children-unread:{}", unread_material_stamp(dir)));
        for name in known_parent_files(session_id) {
            if rows.iter().any(|row| row.starts_with(&format!("{name}:"))) {
                continue;
            }
            let path = dir.join(&name);
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                continue;
            }
            let stamp = crate::history::source_fingerprint_controlled(&path, cancelled)?;
            rows.push(format!("{name}:{stamp}"));
        }
    }
    fold_fingerprint(rows)
}

fn known_parent_files(session_id: &str) -> [String; 3] {
    [
        format!("{session_id}.json"),
        format!("{session_id}.messages.json"),
        format!("{session_id}.compaction.json"),
    ]
}

fn child_messages_name(name: &str, session_id: &str) -> bool {
    name.strip_suffix(".messages.json")
        .is_some_and(|stem| stem != session_id && stem.contains("__"))
}

fn fingerprint_row(
    path: &Path,
    name: &str,
    session_id: &str,
    cancelled: &dyn Fn() -> bool,
) -> Result<String, String> {
    let child = child_messages_name(name, session_id);
    let stamp = match crate::history::source_fingerprint_controlled(path, cancelled) {
        Ok(stamp) => stamp,
        Err(error) if cancelled() || scan_cancelled(&error) => return Err(error),
        Err(_) if child => return Ok(format!("{name}:{}", unread_material_stamp(path))),
        Err(error) => return Err(error),
    };
    if child && fs::File::open(path).is_err() {
        if cancelled() {
            return Err("扫描已取消，原索引已保留".into());
        }
        return Ok(format!("{name}:unread:{stamp}"));
    }
    Ok(format!("{name}:{stamp}"))
}

fn fold_fingerprint(rows: Vec<String>) -> Result<String, String> {
    if rows.is_empty() {
        return Err("Cline 会话目录没有可指纹的文件".into());
    }
    let mut combined = [0u8; 16];
    let mut count = 0usize;
    for row in rows {
        for (slot, byte) in combined.iter_mut().zip(md5_hex(row.as_bytes())) {
            *slot ^= byte;
        }
        count += 1;
    }
    Ok(format!("cline-session-v3|{count}|{}", hex(&combined)))
}

fn scan_cancelled(error: &str) -> bool {
    error.contains("扫描已取消")
}

fn unread_material_stamp(path: &Path) -> String {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return format!("unread:{}", path.display());
    };
    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    format!("unread:{}:{modified}:{}", metadata.len(), path.display())
}

/// The index database path for a session directory:
/// `<data>/sessions/<id>` → `<data>/db/sessions.db`.
struct ChildMessages {
    files: Vec<(String, PathBuf)>,
    unread_keys: Vec<String>,
    layer_unread: bool,
}

fn unreadable_child(key: &str) -> ChildSession {
    ChildSession {
        key: key.to_owned(),
        name: None,
        messages: Vec::new(),
        readable: false,
        children: Vec::new(),
    }
}

fn child_message_files(
    session_dir: &Path,
    id: &str,
    cancelled: &dyn Fn() -> bool,
) -> Result<ChildMessages, String> {
    check_cancelled(cancelled)?;
    let entries = match fs::read_dir(session_dir) {
        Ok(entries) => entries,
        Err(error) if cancelled() || scan_cancelled(&error.to_string()) => return Err(error.to_string()),
        Err(error) => return Err(error.to_string()),
    };
    let mut files = Vec::new();
    let mut unread_keys = Vec::new();
    let mut layer_unread = false;
    for entry in entries {
        check_cancelled(cancelled)?;
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) if cancelled() || scan_cancelled(&error.to_string()) => return Err(error.to_string()),
            Err(_) => {
                layer_unread = true;
                continue;
            }
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(stem) = name.strip_suffix(".messages.json") else {
            continue;
        };
        if stem == id || !stem.contains("__") {
            continue;
        }
        let kind = match entry.file_type() {
            Ok(kind) => kind,
            Err(error) if cancelled() || scan_cancelled(&error.to_string()) => return Err(error.to_string()),
            Err(_) => {
                unread_keys.push(stem.to_owned());
                continue;
            }
        };
        if !kind.is_file() {
            continue;
        }
        match fs::symlink_metadata(entry.path()) {
            Ok(metadata) if !metadata.file_type().is_symlink() && metadata.is_file() => {
                files.push((stem.to_owned(), entry.path()));
            }
            Ok(_) => {}
            Err(error) if cancelled() || scan_cancelled(&error.to_string()) => return Err(error.to_string()),
            Err(_) => unread_keys.push(stem.to_owned()),
        }
    }
    files.sort();
    unread_keys.sort();
    unread_keys.dedup();
    Ok(ChildMessages { files, unread_keys, layer_unread })
}

fn database_for(session_dir: &Path) -> Option<PathBuf> {
    session_dir
        .parent()
        .and_then(Path::parent)
        .map(|data| data.join("db").join("sessions.db"))
}

fn message_id(session: &str, stem: &str, fallback_index: usize, explicit: Option<&str>) -> String {
    explicit
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("{session}#{stem}#{fallback_index}"))
}

fn push_child_message(
    messages: &mut Vec<HistoryMessage>,
    id: String,
    role: &str,
    text: String,
    time: Option<i64>,
) {
    if text.trim().is_empty() {
        return;
    }
    messages.push(HistoryMessage {
        id,
        role: role.to_owned(),
        text,
        timestamp: time,
        timestamp_source: if time.is_some() {
            MessageTimeSource::Native
        } else {
            MessageTimeSource::Unknown
        },
        kind: HistoryMessageKind::Conversation,
    });
}

/// Verified message rows have no agent display name. The stem is only the path key.
fn path_attribution(main_line: bool, stem: &str) -> Vec<UsageAttribution> {
    vec![UsageAttribution {
        kind: if main_line { AgentKind::Main } else { AgentKind::Subagent },
        name: None,
        session_key: if main_line { None } else { Some(stem.to_owned()) },
    }]
}

/// One messages array file → transcript entries (main line or one child) and
/// billed usage events. Subagent stems do not join the parent transcript.
fn read_messages(
    session: &mut ParsedSession,
    path: &Path,
    stem: &str,
    main_line: bool,
    model: &Option<String>,
    mut child_messages: Option<&mut Vec<HistoryMessage>>,
    cancelled: &dyn Fn() -> bool,
) -> Result<(), String> {
    check_cancelled(cancelled)?;
    let id = session
        .native_id
        .clone()
        .unwrap_or_else(|| stem.to_owned());
    let text = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let Ok(rows) = serde_json::from_str::<Vec<Value>>(&text) else {
        return Err("Cline messages 文件不是 JSON 数组".into());
    };
    for (index, message) in rows.into_iter().enumerate() {
        check_cancelled(cancelled)?;
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let time = message.get("ts").and_then(timestamp);
        if role == "user" || role == "assistant" {
            let body = match &message {
                Value::Object(fields) => fields
                    .get("text")
                    .cloned()
                    .unwrap_or_else(|| fields.get("content").cloned().unwrap_or(Value::Null)),
                _ => Value::Null,
            };
            let body = if body.is_string() {
                body.as_str().unwrap_or_default().to_owned()
            } else {
                text_content(&body)
            };
            if !body.trim().is_empty() {
                let message_key = message_id(
                    &id,
                    stem,
                    index,
                    message.get("id").and_then(Value::as_str),
                );
                if main_line {
                    session.add_message(message_key, &role, body, time);
                } else if let Some(bucket) = child_messages.as_mut() {
                    push_child_message(bucket, message_key, &role, body, time);
                }
            }
        }
        let Some(metrics) = message.get("metrics") else {
            continue;
        };
        let Some(counts) = usage::from_optional(
            usage::field(metrics, "inputTokens"),
            usage::field(metrics, "outputTokens"),
            usage::field(metrics, "cacheReadTokens"),
            usage::field(metrics, "cacheWriteTokens"),
        ) else {
            continue;
        };
        if !usage::active(counts) {
            continue;
        }
        // metrics.cost has no shared-pipeline channel; see the module docs.
        session.usage.push(UsageEvent { native_usage: None,
            request_count: Some(1),
            id: message_id(&id, stem, index, message.get("id").and_then(Value::as_str)),
            model: message
                .get("model")
                .and_then(Value::as_str)
                .filter(|model| !model.is_empty())
                .map(str::to_owned)
                .or_else(|| model.clone()),
            timestamp: time,
            input: Some(counts.input),
            output: Some(counts.output),
            cache_read: Some(counts.read),
            cache_write: Some(counts.write),
            // Verified source semantics: input excludes cache read/write.
            // Rows have no native request id, so each metrics object stays one event.
            input_includes_cache: false,
            attributions: path_attribution(main_line, stem),
        });
    }
    Ok(())
}

pub fn parse(source: &HistorySource) -> Result<ParsedSession, String> {
    parse_controlled(source, &|| false)
}

pub fn parse_controlled(
    source: &HistorySource,
    cancelled: &dyn Fn() -> bool,
) -> Result<ParsedSession, String> {
    check_cancelled(cancelled)?;
    let id = source
        .native_id
        .clone()
        .ok_or("Cline 会话缺少会话 ID")?;
    let session_dir = source
        .path
        .parent()
        .ok_or("Cline 会话源缺少目录")?
        .to_path_buf();
    let manifest_text =
        fs::read_to_string(&source.path).map_err(|error| format!("Cline 会话清单缺失：{error}"))?;
    let manifest = serde_json::from_str::<Value>(&manifest_text)
        .map_err(|_| "Cline 会话清单不是 JSON 对象".to_string())?;
    if manifest.get("session_id").and_then(Value::as_str) != Some(id.as_str()) {
        return Err("Cline 清单 session_id 与会话目录不一致".into());
    }
    // Optional index row: richer title/times and the metadata_json aggregate.
    let mut row_title = None;
    let mut row_metadata: Option<Value> = None;
    let mut row_times: (Option<i64>, Option<i64>) = (None, None);
    if let Some(database) = database_for(&session_dir) {
        if database.is_file() {
            let connection = open(&database)?;
            let mut statement = connection
                .prepare("SELECT title, started_at, ended_at, metadata_json FROM sessions WHERE session_id = ?1")
                .map_err(|error| format!("Cline 会话库结构无法识别：{error}"))?;
            let row = statement
                .query_row([&id], |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                })
                .map_err(|error| error.to_string());
            if let Ok((title, started, ended, metadata)) = row {
                row_title = title.filter(|title| !title.trim().is_empty());
                row_times = (started, ended);
                row_metadata = metadata
                    .and_then(|text| serde_json::from_str::<Value>(&text).ok());
            }
        }
    }
    let mut session = ParsedSession::new();
    session.native_id = Some(id.clone());
    let prompt_title = manifest
        .get("prompt")
        .and_then(Value::as_str)
        .map(|prompt| {
            prompt
                .lines()
                .find(|line| !line.trim().is_empty())
                .unwrap_or("")
                .chars()
                .take(96)
                .collect::<String>()
        })
        .filter(|title| !title.is_empty());
    session.title = row_title.or(prompt_title).unwrap_or_default();
    session.cwd = manifest
        .get("cwd")
        .or_else(|| manifest.get("workspace_root"))
        .and_then(Value::as_str)
        .filter(|cwd| !cwd.trim().is_empty())
        .map(str::to_owned);
    session.started_at = manifest
        .get("started_at")
        .and_then(timestamp)
        .or(row_times.0);
    session.updated_at = manifest
        .get("ended_at")
        .and_then(timestamp)
        .or(row_times.1);
    session.model = manifest
        .get("model")
        .and_then(Value::as_str)
        .filter(|model| !model.trim().is_empty())
        .map(str::to_owned);
    // messages_path/compaction_path values are recorded by the product with
    // unverified semantics; the pinned same-directory layout is used instead.
    let messages = session_dir.join(format!("{id}.messages.json"));
    let manifest_model = session.model.clone();
    if messages.is_file() {
        read_messages(&mut session, &messages, &id, true, &manifest_model, None, cancelled)
            .map_err(|error| format!("Cline 主消息文件无法解析：{error}"))?;
    } else {
        session.partial = true;
    }
    // Subagent/team stems: usage folds into this conversation; the transcript
    // of the internal task line stays out of the main timeline. Failing to
    // list this directory keeps the parent messages already read.
    let listed = match child_message_files(&session_dir, &id, cancelled) {
        Ok(listed) => listed,
        Err(error) if cancelled() || scan_cancelled(&error) => return Err(error),
        Err(_) => {
            session.partial = true;
            session.children.push(unreadable_child("child"));
            ChildMessages { files: Vec::new(), unread_keys: Vec::new(), layer_unread: false }
        }
    };
    if listed.layer_unread {
        session.partial = true;
        session.children.push(unreadable_child("child"));
    }
    for key in listed.unread_keys {
        session.partial = true;
        session.children.push(unreadable_child(&key));
    }
    for (stem, path) in listed.files {
        let mut child_messages = Vec::new();
        let readable = match read_messages(
            &mut session,
            &path,
            &stem,
            false,
            &manifest_model,
            Some(&mut child_messages),
            cancelled,
        ) {
            Ok(()) => true,
            Err(error) if cancelled() || scan_cancelled(&error) => return Err(error),
            Err(_) => false,
        };
        if !readable {
            session.partial = true;
            child_messages.clear();
        }
        session.children.push(ChildSession {
            key: stem,
            name: None,
            messages: child_messages,
            readable,
            children: Vec::new(),
        });
    }
    check_cancelled(cancelled)?;
    // Aggregate fallback: a session whose message files carry no per-message
    // metrics still reports the sessions.db aggregate as ONE event.
    if session.usage.is_empty() {
        if let Some(aggregate) = row_metadata
            .as_ref()
            .and_then(|metadata| metadata.get("aggregateUsage").or_else(|| metadata.get("usage")))
        {
            if let Some(counts) = usage::from_optional(
                usage::field(aggregate, "inputTokens"),
                usage::field(aggregate, "outputTokens"),
                usage::field(aggregate, "cacheReadTokens"),
                usage::field(aggregate, "cacheWriteTokens"),
            ) {
                if usage::active(counts) {
                    session.usage.push(UsageEvent { native_usage: None,
                        request_count: None,
                        id: format!("cline-aggregate-{id}"),
                        model: session.model.clone(),
                        timestamp: session.updated_at,
                        input: Some(counts.input),
                        output: Some(counts.output),
                        cache_read: Some(counts.read),
                        cache_write: Some(counts.write),
                        input_includes_cache: false, attributions: Vec::new(),
                    });
                }
            }
        }
    }
    session.finish(source)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::AgentKind;
    use rusqlite::params;

    const SESSION_DIR_FIXTURE: &str = "tests/fixtures/history/cline-3.0-session";
    const MAIN_ID: &str = "ses_20261007_1042_a1b2c3d4e5f6";
    const AGGREGATE_ONLY_ID: &str = "ses_20261007_1108_z9y8x7w6v5u4";
    const STALE_ID: &str = "ses_stale_db_row_0000000001";

    /// Rebuilds the sanitized fixture layout under an isolated home: session
    /// directories are copied verbatim from the committed fixture, sessions.db
    /// is synthesized deterministically from sessions.json (mimo/zcode
    /// in-test pattern) and a plaintext providers.json is planted to prove
    /// its values never reach any output.
    fn fixture_home() -> tempfile::TempDir {
        let home = tempfile::tempdir().unwrap();
        // CARGO_MANIFEST_DIR is src-tauri; the fixtures live at the repository
        // root like every other history fixture.
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(SESSION_DIR_FIXTURE);
        let data = super::super::data_root(home.path());
        for id in [MAIN_ID, AGGREGATE_ONLY_ID] {
            let from = root.join(id);
            let to = data.join("sessions").join(id);
            for name in ["manifest.json", "messages.json"] {
                if let Ok(text) = fs::read_to_string(from.join(name)) {
                    fs::create_dir_all(&to).unwrap();
                    let file_name = if name == "manifest.json" {
                        format!("{id}.json")
                    } else {
                        format!("{id}.messages.json")
                    };
                    fs::write(to.join(file_name), text).unwrap();
                }
            }
            if id == MAIN_ID {
                fs::copy(
                    from.join("main-compaction.json"),
                    to.join(format!("{id}.compaction.json")),
                )
                .unwrap();
                fs::copy(
                    from.join("explore__task_0001.messages.json"),
                    to.join("explore__task_0001.messages.json"),
                )
                .unwrap();
            }
        }
        let rows: Value = serde_json::from_str(&fs::read_to_string(root.join("sessions.json")).unwrap())
            .unwrap();
        let database = super::super::sessions_db(home.path());
        fs::create_dir_all(database.parent().unwrap()).unwrap();
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE sessions (
                    session_id TEXT PRIMARY KEY, title TEXT,
                    started_at INTEGER, ended_at INTEGER, metadata_json TEXT NOT NULL);",
            )
            .unwrap();
        for row in rows["sessions"].as_array().unwrap() {
            connection
                .execute(
                    "INSERT INTO sessions (session_id, title, started_at, ended_at, metadata_json)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        row["session_id"].as_str().unwrap(),
                        row["title"].as_str().unwrap(),
                        row["started_at"].as_i64(),
                        row["ended_at"].as_i64(),
                        row["metadata_json"].to_string(),
                    ],
                )
                .unwrap();
        }
        drop(connection);
        // Plaintext provider keys exist on real machines; nothing in this
        // pipeline may ever surface them.
        let providers = data.join("settings");
        fs::create_dir_all(&providers).unwrap();
        fs::write(
            providers.join("providers.json"),
            r#"{"anthropic":{"label":"example","accessToken":"sk-cline-fixture-secret"}}"#,
        )
        .unwrap();
        home
    }

    fn source_of(home: &Path, id: &str) -> HistorySource {
        sources(home)
            .unwrap()
            .into_iter()
            .find(|source| source.native_id.as_deref() == Some(id))
            .unwrap()
    }

    #[test]
    fn aggregate_database_changes_invalidate_only_the_affected_session() {
        let home = fixture_home();
        let before = source_of(home.path(), AGGREGATE_ONLY_ID);
        let main = source_of(home.path(), MAIN_ID);
        let connection = Connection::open(super::super::sessions_db(home.path())).unwrap();
        connection.execute("UPDATE sessions SET metadata_json = json_set(metadata_json, '$.usage.inputTokens', 7654) WHERE session_id=?1", [AGGREGATE_ONLY_ID]).unwrap();
        assert_ne!(before.fingerprint, source_of(home.path(), AGGREGATE_ONLY_ID).fingerprint);
        assert_eq!(main.fingerprint, source_of(home.path(), MAIN_ID).fingerprint);
    }

    #[test]
    fn fixture_layout_lists_sessions_with_stable_fingerprints() {
        let home = fixture_home();
        let listed = sources(home.path()).unwrap();
        let ids: Vec<&str> = listed
            .iter()
            .map(|source| source.native_id.as_deref().unwrap())
            .collect();
        assert_eq!(ids.len(), 3, "{listed:?}");
        assert!(ids.contains(&MAIN_ID));
        assert!(ids.contains(&AGGREGATE_ONLY_ID));
        assert!(ids.contains(&STALE_ID), "陈旧索引行以失败形式呈现而非消失");
        let stale = listed.iter().find(|s| s.native_id.as_deref() == Some(STALE_ID)).unwrap();
        assert_eq!(
            stale.fingerprint_error.as_deref(),
            Some("Cline 会话目录或清单缺失")
        );
        assert!(stale.fingerprint.is_empty());
        let main = source_of(home.path(), MAIN_ID);
        assert!(main.fingerprint.starts_with("cline-session-v3|"));
        assert!(main.path.ends_with(format!("{MAIN_ID}.json")));
        // A length change in the messages file must change the fingerprint.
        let before = main.fingerprint.clone();
        let messages = main.path.parent().unwrap().join(format!("{MAIN_ID}.messages.json"));
        let text = fs::read_to_string(&messages).unwrap();
        fs::write(&messages, format!("{text} ")).unwrap();
        let after = source_of(home.path(), MAIN_ID);
        assert_ne!(before, after.fingerprint, "消息文件追加必须改变指纹");
    }

    #[test]
    fn main_session_parses_identity_transcript_and_split_metrics() {
        let home = fixture_home();
        let source = source_of(home.path(), MAIN_ID);
        let session = parse(&source).unwrap();
        assert_eq!(session.native_id.as_deref(), Some(MAIN_ID));
        // Title prefers the sessions.db row.
        assert_eq!(session.title, "帮我把构建脚本改成跨平台版本");
        assert_eq!(
            session.cwd.as_deref(),
            Some(r"C:\Users\example\cline-demo")
        );
        assert_eq!(session.started_at, Some(1791000000000));
        assert_eq!(session.updated_at, Some(1791000900000));
        assert_eq!(session.model.as_deref(), Some("claude-sonnet-4-5"));
        let roles: Vec<&str> = session
            .messages
            .iter()
            .map(|message| message.role.as_str())
            .collect();
        // Main timeline only: subagent stems and the compaction snapshot stay
        // out; the metrics-less trailing assistant message stays in chat.
        assert_eq!(roles, vec!["user", "assistant", "assistant", "user", "assistant"]);
        assert!(session.messages.iter().all(|message| !message.text.is_empty()));
        assert!(!session.partial, "完整会话不应标记 partial：{session:?}");
        // 2 main billed calls + 1 folded subagent call, in file order.
        assert_eq!(session.usage.len(), 3, "{:?}", session.usage);
        let first = &session.usage[0];
        assert_eq!(first.id, "msg_0002");
        assert_eq!(first.model.as_deref(), Some("claude-sonnet-4-5"));
        assert_eq!(first.input, Some(1_200));
        assert_eq!(first.output, Some(300));
        assert_eq!(first.cache_read, Some(0));
        assert_eq!(first.cache_write, Some(0));
        assert!(!first.input_includes_cache, "stored input excludes cache");
        assert_eq!(first.request_count, Some(1));
        let second = &session.usage[1];
        assert_eq!(second.input, Some(500));
        assert_eq!(second.output, Some(120));
        assert_eq!(second.cache_read, Some(8_000));
        assert_eq!(second.cache_write, Some(3_000));
        assert!(!second.input_includes_cache);
        // Subagent stem: usage folded with its own model, transcript excluded.
        let sub = &session.usage[2];
        assert_eq!(sub.id, "msg_sub_0001");
        assert_eq!(sub.model.as_deref(), Some("claude-haiku-4-5"));
        assert_eq!(sub.input, Some(200));
        assert_eq!(sub.output, Some(50));
        assert!(!session
            .messages
            .iter()
            .any(|message| message.text.contains("子代理")));
        assert!(session.usage[..2].iter().all(|event| {
            event.attributions.len() == 1
                && event.attributions[0].kind == AgentKind::Main
                && event.attributions[0].name.is_none()
                && event.attributions[0].session_key.is_none()
        }));
        assert_eq!(session.children.len(), 1);
        let child = &session.children[0];
        assert_eq!(child.key, "explore__task_0001");
        assert!(child.name.is_none(), "文件名里的代理 id 不是显示名");
        assert!(child.readable && child.children.is_empty());
        assert!(child.messages.iter().any(|message| message.text.contains("子代理")));
        assert_eq!(sub.attributions.len(), 1);
        assert_eq!(sub.attributions[0].kind, AgentKind::Subagent);
        assert!(sub.attributions[0].name.is_none());
        assert_eq!(sub.attributions[0].session_key.as_deref(), Some(child.key.as_str()));
        // Audit baseline: per-message sums equal the metadata_json aggregate.
        let totals: (u64, u64, u64, u64) = session.usage.iter().fold(
            (0, 0, 0, 0),
            |(input, output, read, write), event| {
                (
                    input + event.input.unwrap_or(0),
                    output + event.output.unwrap_or(0),
                    read + event.cache_read.unwrap_or(0),
                    write + event.cache_write.unwrap_or(0),
                )
            },
        );
        assert_eq!(totals, (1_900, 470, 8_000, 3_000));
    }

    #[test]
    fn aggregate_only_session_falls_back_to_metadata_totals() {
        let home = fixture_home();
        let source = source_of(home.path(), AGGREGATE_ONLY_ID);
        let session = parse(&source).unwrap();
        assert!(session.partial, "消息文件缺失标记 partial");
        assert_eq!(session.usage.len(), 1);
        let event = &session.usage[0];
        assert_eq!(event.id, format!("cline-aggregate-{AGGREGATE_ONLY_ID}"));
        assert_eq!(event.request_count, None, "聚合事件不虚构请求次数");
        assert!(event.attributions.is_empty(), "聚合行没有已核对的代理路径");
        assert_eq!(event.input, Some(80));
        assert_eq!(event.output, Some(20));
        assert_eq!(event.cache_read, Some(0));
        assert_eq!(event.cache_write, Some(0));
        assert!(!event.input_includes_cache);
        // Title falls back to the manifest prompt when the row has none.
        assert_eq!(session.title, "快速核对一个依赖版本");
    }

    #[test]
    fn subagent_events_stay_separate_and_a_bad_file_stays_unreadable() {
        let home = fixture_home();
        let source = source_of(home.path(), MAIN_ID);
        let directory = source.path.parent().unwrap();
        let path = directory.join("explore__task_0001.messages.json");
        let mut rows: Vec<Value> = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        rows.push(serde_json::json!({
            "id": "msg_sub_0002",
            "ts": 1791000110000i64,
            "role": "assistant",
            "text": "子代理第二条，仍不进主对话。",
            "metrics": {
                "inputTokens": 9,
                "outputTokens": 1,
                "cacheReadTokens": 0,
                "cacheWriteTokens": 0
            }
        }));
        fs::write(&path, serde_json::to_string(&rows).unwrap()).unwrap();
        fs::write(directory.join("planner__task_0002.messages.json"), "not-json").unwrap();
        let session = parse(&source_of(home.path(), MAIN_ID)).unwrap();
        assert!(session.messages.iter().all(|message| !message.text.contains("子代理")));
        assert_eq!(session.native_id.as_deref(), Some(MAIN_ID));
        let sub: Vec<_> = session
            .usage
            .iter()
            .filter(|event| event.attributions.iter().any(|item| item.kind == AgentKind::Subagent))
            .collect();
        assert_eq!(sub.len(), 2, "{:?}", session.usage);
        assert_ne!(sub[0].id, sub[1].id);
        assert_eq!(
            sub[0].attributions[0].session_key.as_deref(),
            Some("explore__task_0001")
        );
        assert_eq!(sub[1].attributions[0].session_key.as_deref(), Some("explore__task_0001"));
        assert!(sub.iter().all(|event| event.attributions[0].name.is_none()));
        assert_eq!(session.children.len(), 2);
        let open = session
            .children
            .iter()
            .find(|child| child.key == "explore__task_0001")
            .unwrap();
        assert!(open.readable);
        assert_eq!(open.messages.len(), 2);
        assert!(open.name.is_none());
        let closed = session
            .children
            .iter()
            .find(|child| child.key == "planner__task_0002")
            .unwrap();
        assert!(!closed.readable);
        assert!(closed.messages.is_empty());
        assert!(closed.name.is_none());
        assert!(session.partial);
    }

    #[test]
    fn plaintext_provider_secrets_never_reach_any_output() {
        let home = fixture_home();
        let listed = sources(home.path()).unwrap();
        let rendered = format!("{listed:?}");
        assert!(!rendered.contains("sk-cline-fixture-secret"), "{rendered}");
        for source in &listed {
            if source.fingerprint_error.is_some() {
                continue;
            }
            if let Ok(session) = parse(source) {
                let rendered = format!("{session:?}");
                assert!(
                    !rendered.contains("sk-cline-fixture-secret"),
                    "会话输出不得携带 providers.json 值"
                );
                assert!(!rendered.contains("accessToken"));
            }
        }
    }

    #[test]
    fn missing_index_falls_back_to_the_directory_layout() {
        let home = tempfile::tempdir().unwrap();
        assert!(sources(home.path()).unwrap().is_empty());
        // Session directory without any database still lists.
        let data = super::super::data_root(home.path());
        let dir = data.join("sessions").join(MAIN_ID);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(format!("{MAIN_ID}.json")), "{}").unwrap();
        let listed = sources(home.path()).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].native_id.as_deref(), Some(MAIN_ID));
        // A present-but-corrupt database fails the scan instead of guessing.
        let database = super::super::sessions_db(home.path());
        fs::create_dir_all(database.parent().unwrap()).unwrap();
        fs::write(&database, b"not a sqlite database").unwrap();
        assert!(sources(home.path()).is_err());
    }

    #[test]
    fn manifest_identity_mismatch_fails_instead_of_guessing() {
        let home = fixture_home();
        let mut source = source_of(home.path(), MAIN_ID);
        source.native_id = Some("ses_20261007_1042_deadbeef0000".into());
        assert!(parse(&source).is_err());
    }

    #[test]
    fn md5_hex_is_stable_for_identical_rows() {
        assert_eq!(md5_hex(b"abc"), md5_hex(b"abc"));
        assert_ne!(md5_hex(b"abc"), md5_hex(b"abd"));
    }

    /// Windows holds a sharing lock. Unix has no equivalent that blocks a later
    /// open, so the stand-in removes permissions and puts them back on drop.
    struct ExclusiveLock {
        _file: fs::File,
        #[cfg(not(windows))]
        path: PathBuf,
        #[cfg(not(windows))]
        mode: u32,
    }

    fn lock_exclusive(path: &Path) -> ExclusiveLock {
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            ExclusiveLock {
                _file: fs::OpenOptions::new().read(true).share_mode(0).open(path).unwrap(),
            }
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(path).unwrap().permissions().mode() & 0o7777;
            let file = fs::File::open(path).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o0)).unwrap();
            ExclusiveLock { _file: file, path: path.to_path_buf(), mode }
        }
    }

    #[cfg(not(windows))]
    impl Drop for ExclusiveLock {
        fn drop(&mut self) {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&self.path, fs::Permissions::from_mode(self.mode));
        }
    }

    /// Denies directory listing only. Files already named in the session can
    /// still be opened, which is the parent-message path.
    struct DenyList { path: PathBuf }

    impl DenyList {
        fn new(path: &Path) -> Self {
            #[cfg(windows)]
            {
                let user = std::env::var("USERNAME").expect("USERNAME");
                let status = std::process::Command::new("icacls").arg(path).arg("/deny").arg(format!("{user}:(RD)")).status().unwrap();
                assert!(status.success());
            }
            #[cfg(not(windows))]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = fs::metadata(path).unwrap().permissions().mode();
                // Read lists a directory; execute traverses it. Drop read only,
                // so files already named in the session can still be opened.
                fs::set_permissions(path, fs::Permissions::from_mode(mode & !0o444)).unwrap();
            }
            Self { path: path.to_path_buf() }
        }
    }

    impl Drop for DenyList {
        fn drop(&mut self) {
            #[cfg(windows)]
            {
                let _ = std::process::Command::new("icacls").arg(&self.path).arg("/reset").status();
                let _ = std::process::Command::new("icacls").arg(&self.path).arg("/inheritance:e").status();
            }
            #[cfg(not(windows))]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(&self.path, fs::Permissions::from_mode(0o755));
            }
        }
    }

    #[test]
    fn locked_child_file_keeps_the_parent_without_its_usage() {
        let home = fixture_home();
        let source = source_of(home.path(), MAIN_ID);
        let locked = source.path.parent().unwrap().join("explore__task_0001.messages.json");
        let blocked = {
            let _lock = lock_exclusive(&locked);
            let parent = source_of(home.path(), MAIN_ID);
            assert!(parent.fingerprint_error.is_none(), "{:?}", parent.fingerprint_error);
            assert!(parent.fingerprint.starts_with("cline-session-v3|"), "{}", parent.fingerprint);
            assert_ne!(parent.fingerprint, source.fingerprint, "子文件读不到时父指纹仍要带上未读戳");
            let session = parse(&parent).unwrap();
            assert!(session.messages.iter().any(|message| message.text.contains("构建")));
            assert!(session.messages.iter().all(|message| !message.text.contains("子代理")));
            assert!(session.usage.iter().all(|event| event.attributions.iter().all(|item| item.kind == AgentKind::Main)));
            let unread = session.children.iter().find(|child| child.key == "explore__task_0001").unwrap();
            assert!(!unread.readable);
            assert!(unread.messages.is_empty() && unread.name.is_none());
            parent.fingerprint
        };
        let parent = source_of(home.path(), MAIN_ID);
        assert_ne!(parent.fingerprint, blocked, "子文件恢复可读后父指纹必须变化");
        let session = parse(&parent).unwrap();
        let child = session.children.iter().find(|child| child.key == "explore__task_0001").unwrap();
        assert!(child.readable);
        assert!(child.messages.iter().any(|message| message.text.contains("子代理")));
        assert!(session.messages.iter().all(|message| !message.text.contains("子代理")));
        assert!(session.usage.iter().any(|event| event.attributions.iter().any(|item| item.kind == AgentKind::Subagent)));
    }

    /// Denies attribute reads on one file. The session directory can still list it,
    /// and sibling transcripts can still be opened.
    struct DenyStat { path: PathBuf }

    impl DenyStat {
        fn new(path: &Path) -> Self {
            #[cfg(windows)]
            {
                let user = std::env::var("USERNAME").expect("USERNAME");
                let status = std::process::Command::new("icacls").arg(path).arg("/inheritance:r").status().unwrap();
                assert!(status.success(), "icacls inheritance");
                let status = std::process::Command::new("icacls")
                    .arg(path)
                    .arg("/deny")
                    .arg(format!("{user}:(RA,RD,REA)"))
                    .status()
                    .unwrap();
                assert!(status.success(), "icacls deny");
            }
            #[cfg(not(windows))]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(path, fs::Permissions::from_mode(0o0)).unwrap();
            }
            Self { path: path.to_path_buf() }
        }
    }

    impl Drop for DenyStat {
        fn drop(&mut self) {
            #[cfg(windows)]
            {
                let _ = std::process::Command::new("icacls").arg(&self.path).arg("/reset").status();
                let _ = std::process::Command::new("icacls").arg(&self.path).arg("/inheritance:e").status();
            }
            #[cfg(not(windows))]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(&self.path, fs::Permissions::from_mode(0o644));
            }
        }
    }

    #[test]
    fn one_unreadable_child_keeps_its_sibling() {
        let home = fixture_home();
        let source = source_of(home.path(), MAIN_ID);
        let directory = source.path.parent().unwrap();
        fs::write(
            directory.join("planner__task_0002.messages.json"),
            r#"[{"id":"c2","role":"assistant","text":"兄弟子日志","ts":1791000111000,"metrics":{"inputTokens":4,"outputTokens":1,"cacheReadTokens":0,"cacheWriteTokens":0}}]"#,
        )
        .unwrap();
        let blocked = directory.join("explore__task_0001.messages.json");
        let _deny = DenyStat::new(&blocked);
        let parent = source_of(home.path(), MAIN_ID);
        assert!(parent.fingerprint_error.is_none(), "{:?}", parent.fingerprint_error);
        let session = parse(&parent).unwrap();
        assert!(session.messages.iter().any(|message| message.text.contains("构建")));
        assert!(session.messages.iter().all(|message| !message.text.contains("兄弟子日志") && !message.text.contains("子代理")));
        let sibling = session.children.iter().find(|child| child.key == "planner__task_0002").unwrap();
        assert!(sibling.readable, "{:?}", session.children.iter().map(|child| (&child.key, child.readable)).collect::<Vec<_>>());
        assert!(sibling.messages.iter().any(|message| message.text == "兄弟子日志"));
        assert!(sibling.name.is_none());
        let unread = session.children.iter().find(|child| child.key == "explore__task_0001").unwrap();
        assert!(!unread.readable);
        assert!(unread.messages.is_empty() && unread.name.is_none());
    }

    #[test]
    fn unlistable_session_directory_keeps_parent_messages() {
        let home = tempfile::tempdir().unwrap();
        let id = "ses_20261022_1200_parent0001";
        let directory = super::super::data_root(home.path()).join("sessions").join(id);
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join(format!("{id}.json")),
            format!(r#"{{"session_id":"{id}","prompt":"父会话仍在","cwd":"C:/demo","model":"fixture"}}"#),
        )
        .unwrap();
        fs::write(
            directory.join(format!("{id}.messages.json")),
            r#"[{"id":"m1","role":"user","text":"父会话正文","ts":1791000000000}]"#,
        )
        .unwrap();
        fs::write(
            directory.join("explore__task_0009.messages.json"),
            r#"[{"id":"c1","role":"assistant","text":"子代理正文","ts":1791000001000,"metrics":{"inputTokens":3,"outputTokens":1,"cacheReadTokens":0,"cacheWriteTokens":0}}]"#,
        )
        .unwrap();
        let before = sources(home.path()).unwrap().remove(0).fingerprint;
        let _deny = DenyList::new(&directory);
        let found = sources(home.path()).unwrap();
        assert_eq!(found.len(), 1, "{found:?}");
        assert!(found[0].fingerprint_error.is_none(), "{:?}", found[0].fingerprint_error);
        assert_ne!(found[0].fingerprint, before, "会话目录列举失败要改变父指纹，恢复后才能重扫");
        let session = parse(&found[0]).unwrap();
        assert!(session.messages.iter().any(|message| message.text == "父会话正文"));
        assert!(session.messages.iter().all(|message| message.text != "子代理正文"));
        assert!(session.usage.iter().all(|event| event.attributions.iter().all(|item| item.session_key.is_none())));
        let unread = session.children.iter().find(|child| !child.readable).unwrap();
        assert!(unread.messages.is_empty() && unread.name.is_none());
    }
}
