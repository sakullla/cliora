use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::Value;

use crate::history::usage;
use crate::history::{
    check_cancelled, text_content, valid_native_id, HistorySource, ParsedSession, UsageEvent,
    MAX_SOURCES,
};

fn database(home: &Path) -> PathBuf {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".local/share"));
    crate::accounts::selection::history_root("open_code", || base.join("opencode"))
        .join("opencode.db")
}

fn open(path: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("OpenCode 历史库不可读取：{error}"))
}

/// The session index tables that decide the storage generation. 1.x writes
/// `session`; 2.x writes `session_v2` with `session_message` rows (verified on
/// a real @opencode/cli 2.0.29 database). A database holding neither shape is
/// not silently treated as an empty history.
fn storage_tables(db: &Connection) -> Result<(bool, bool), String> {
    let mut statement = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .map_err(|error| format!("OpenCode 历史库格式未知：{error}"))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let mut v1 = false;
    let mut v2 = false;
    for row in rows {
        match row.map_err(|error| error.to_string())?.as_str() {
            "session" => v1 = true,
            "session_v2" => v2 = true,
            _ => {}
        }
    }
    if !v1 && !v2 {
        return Err("OpenCode 会话存储版本尚未验证".into());
    }
    Ok((v1, v2))
}

fn index_rows(
    db: &Connection,
    table: &str,
    limit: i64,
) -> Result<Vec<(String, Option<i64>)>, String> {
    let sql = format!(
        "SELECT id, time_updated FROM {table} ORDER BY time_updated DESC LIMIT {limit}"
    );
    let mut statement = db
        .prepare(&sql)
        .map_err(|error| format!("OpenCode 会话索引格式未知：{error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?))
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn sources(home: &Path) -> Result<Vec<HistorySource>, String> {
    sources_controlled(home, &|| false)
}

pub fn sources_controlled(
    home: &Path,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<HistorySource>, String> {
    check_cancelled(cancelled)?;
    let path = database(home);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let db = open(&path)?;
    let (v1, v2) = storage_tables(&db)?;
    // Both generations may coexist while a 1.x database is being migrated;
    // each index row stays its own source and the parse branch is chosen per id.
    // Each table can contain the same complete catalog during migration.
    // Apply the source limit after merging, never truncate each half silently.
    let limit = MAX_SOURCES as i64 + 1;
    let mut indexed = Vec::new();
    // Migrated rows coexist in both tables with the same native ID. The v2
    // transcript wins, even if its original 1.x version/timestamp is retained.
    if v2 {
        indexed.extend(index_rows(&db, "session_v2", limit)?.into_iter().map(|(id, time)| (id, time, "v2")));
    }
    if v1 {
        indexed.extend(index_rows(&db, "session", limit)?.into_iter().map(|(id, time)| (id, time, "v1")));
    }
    let mut result: Vec<HistorySource> = Vec::new();
    let mut seen = std::collections::HashMap::new();
    for (id, updated, generation) in indexed {
        check_cancelled(cancelled)?;
        if !valid_native_id(&id) {
            continue;
        }
        let fingerprint = updated.filter(|time| *time > 0)
            .map(|time| format!("opencode-session-v3|{generation}|{time}"))
            .unwrap_or_else(|| "0".into());
        if let Some(&index) = seen.get(&id) {
            let source: &mut HistorySource = &mut result[index];
            source.fingerprint = if source.fingerprint == "0" || fingerprint == "0" {
                "0".into()
            } else { format!("{}|{fingerprint}", source.fingerprint) };
            continue;
        }
        seen.insert(id.clone(), result.len());
        result.push(HistorySource { native_title: None,
            path: path.clone(),
            native_id: Some(id),
            fingerprint,
            fingerprint_error: None,
        });
    }
    if result.len() > MAX_SOURCES {
        return Err("OpenCode 会话超过 5000 个，本次未删除旧索引".into());
    }
    Ok(result)
}

fn token(value: &Value, key: &str) -> Option<u64> {
    usage::field(value, key)
}

/// Newer OpenCode stores the selected model as `{"id","providerID"}` on the session row.
/// Assistant messages still use `modelID`. Both should display as the model id.
fn model_id(raw: &str) -> String {
    crate::history::usage::stored_model_id(raw)
}

fn message_model(message: &Value) -> Option<String> {
    message
        .get("modelID")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            message.get("model").and_then(|model| {
                model.as_str().map(model_id).or_else(|| {
                    model
                        .get("modelID")
                        .or_else(|| model.get("id"))
                        .and_then(Value::as_str)
                        .filter(|id| !id.is_empty())
                        .map(str::to_owned)
                })
            })
        })
}

/// 2.x stores the selected model as `{"id","providerID","variant"}` on both the
/// session row and assistant messages (verified on a real 2.0.29 database).
/// The `#variant` part stays in the displayed reference.
fn v2_model_ref(model: &Value) -> Option<String> {
    let id = model
        .get("id")
        .or_else(|| model.get("modelID"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())?;
    match model
        .get("variant")
        .and_then(Value::as_str)
        .filter(|variant| !variant.is_empty())
    {
        Some(variant) => Some(format!("{id}#{variant}")),
        None => Some(id.to_owned()),
    }
}

fn v2_stored_model(raw: &str) -> Option<String> {
    match serde_json::from_str::<Value>(raw) {
        Ok(value) => v2_model_ref(&value),
        Err(_) => {
            let id = model_id(raw);
            (!id.is_empty()).then_some(id)
        }
    }
}

fn recorded_time(message: &Value, row_time: Option<i64>) -> Option<i64> {
    message
        .get("time")
        .and_then(|time| time.get("created"))
        .and_then(Value::as_i64)
        .or(row_time)
}

/// The shared shape of a `session`/`session_v2` index row.
struct SessionRow {
    title: Option<String>,
    cwd: Option<String>,
    started: Option<i64>,
    updated: Option<i64>,
    version: Option<String>,
    model: Option<String>,
}

fn session_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionRow> {
    Ok(SessionRow {
        title: row.get(0)?,
        cwd: row.get(1)?,
        started: row.get(2)?,
        updated: row.get(3)?,
        version: row.get(4)?,
        model: row.get(5)?,
    })
}

pub fn parse(source: &HistorySource) -> Result<ParsedSession, String> {
    parse_controlled(source, &|| false)
}

pub fn parse_controlled(
    source: &HistorySource,
    cancelled: &dyn Fn() -> bool,
) -> Result<ParsedSession, String> {
    check_cancelled(cancelled)?;
    let id = source.native_id.as_deref().ok_or("OpenCode 会话 ID 缺失")?;
    let db = open(&source.path)?;
    let (v1, v2) = storage_tables(&db)?;
    if v2 {
        let stored = db
            .query_row(
                "SELECT title, directory, time_created, time_updated, version, model FROM session_v2 WHERE id = ?1",
                [id],
                session_row,
            )
            .optional()
            .map_err(|error| format!("OpenCode 会话格式未知：{error}"))?;
        if let Some(row) = stored {
            let mut session = parse_v2(&db, source, id, row, cancelled)?;
            if v1 { append_unmigrated_usage(&db, id, &mut session, cancelled)?; }
            return Ok(session);
        }
    }
    if v1 {
        return parse_v1(&db, source, id, cancelled);
    }
    Err("OpenCode 会话不存在或格式未知".into())
}

// Native migration can omit a billed legacy message while retaining its
// counters in session_v2. Preserve only IDs absent from the new transcript;
// converted messages continue to use the authoritative v2 usage exactly once.
fn append_unmigrated_usage(db: &Connection, id: &str, session: &mut ParsedSession, cancelled: &dyn Fn() -> bool) -> Result<(), String> {
    let mut statement = db.prepare(
        "SELECT m.id, m.data, m.time_created FROM message m
         WHERE m.session_id = ?1 AND NOT EXISTS (SELECT 1 FROM session_message v WHERE v.id = m.id)"
    ).map_err(|error| error.to_string())?;
    let rows = statement.query_map([id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<i64>>(2)?)))
        .map_err(|error| error.to_string())?;
    for row in rows {
        check_cancelled(cancelled)?;
        let (id, data, time) = row.map_err(|error| error.to_string())?;
        let Ok(message) = serde_json::from_str::<Value>(&data) else { session.partial = true; continue; };
        if let Some(event) = legacy_usage(id, &message, time) { session.usage.push(event); }
    }
    Ok(())
}

fn legacy_usage(id: String, message: &Value, time: Option<i64>) -> Option<UsageEvent> {
    if message.get("role").and_then(Value::as_str) != Some("assistant") { return None; }
    let tokens = message.get("tokens")?;
    let cache = tokens.get("cache").unwrap_or(&Value::Null);
    Some(UsageEvent { native_usage: None,
        request_count: Some(1), id, model: message_model(message), timestamp: time,
        input: token(tokens, "input"),
        output: usage::generated(token(tokens, "output"), token(tokens, "reasoning")),
        cache_read: token(cache, "read"), cache_write: token(cache, "write"), input_includes_cache: false,
    })
}

fn parse_v2(
    db: &Connection,
    source: &HistorySource,
    id: &str,
    row: SessionRow,
    cancelled: &dyn Fn() -> bool,
) -> Result<ParsedSession, String> {
    let SessionRow { title, cwd, started, updated, version, model } = row;
    if !version
        .as_deref()
        .is_some_and(|value| semver::Version::parse(value).is_ok_and(|v| matches!(v.major, 1 | 2)))
    {
        return Err("OpenCode 会话格式版本尚未验证".into());
    }
    let mut session = ParsedSession::new();
    session.native_id = Some(id.to_owned());
    session.title = title.unwrap_or_default().chars().take(96).collect();
    session.cwd = cwd;
    session.started_at = started;
    session.updated_at = updated;
    session.model = model.as_deref().and_then(v2_stored_model);
    // 2.x keeps the whole transcript in `session_message` rows typed
    // `user`/`assistant`/`idle`/... (verified on a real 2.0.29 database);
    // non-conversation rows are skipped without failing the session.
    let mut statement = db
        .prepare("SELECT id, type, data, time_created FROM session_message WHERE session_id = ?1 ORDER BY seq, id")
        .map_err(|error| format!("OpenCode 会话格式未知：{error}"))?;
    let rows = statement
        .query_map([id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<i64>>(3)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    for row in rows {
        check_cancelled(cancelled)?;
        let (message_id, kind, data, time) = row.map_err(|error| error.to_string())?;
        let Ok(message) = serde_json::from_str::<Value>(&data) else {
            session.partial = true;
            continue;
        };
        match kind.as_str() {
            "user" => {
                session.add_message(
                    message_id,
                    "user",
                    message.get("text").map(text_content).unwrap_or_default(),
                    recorded_time(&message, time),
                );
            }
            "assistant" => {
                let model = message.get("model").and_then(v2_model_ref);
                if model.is_some() {
                    session.model = model.clone();
                }
                if let Some(tokens) = message.get("tokens") {
                    // Same accounting as 1.x: stored input already excludes
                    // cache; reasoning is generated and counted into output.
                    let cache = tokens.get("cache").unwrap_or(&Value::Null);
                    session.usage.push(UsageEvent { native_usage: None,
                        request_count: Some(1),
                        id: message_id.clone(),
                        model,
                        timestamp: recorded_time(&message, time),
                        input: token(tokens, "input"),
                        output: usage::generated(token(tokens, "output"), token(tokens, "reasoning")),
                        cache_read: token(cache, "read"),
                        cache_write: token(cache, "write"),
                        input_includes_cache: false,
                    });
                }
                let text = message
                    .get("content")
                    .and_then(Value::as_array)
                    .map(|parts| {
                        parts
                            .iter()
                            .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
                            .filter_map(|part| part.get("text").map(text_content))
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .unwrap_or_default();
                session.add_message(message_id, "assistant", text, recorded_time(&message, time));
            }
            _ => {}
        }
    }
    check_cancelled(cancelled)?;
    session.finish(source)
}

fn parse_v1(
    db: &Connection,
    source: &HistorySource,
    id: &str,
    cancelled: &dyn Fn() -> bool,
) -> Result<ParsedSession, String> {
    let SessionRow { title, cwd, started, updated, version, model } = db.query_row(
        "SELECT title, directory, time_created, time_updated, version, model FROM session WHERE id = ?1", [id],
        session_row,
    ).map_err(|error| format!("OpenCode 会话不存在或格式未知：{error}"))?;
    if !version
        .as_deref()
        .is_some_and(|value| value.starts_with("1."))
    {
        return Err("OpenCode 会话格式版本尚未验证".into());
    }
    let mut session = ParsedSession::new();
    session.native_id = Some(id.to_owned());
    session.title = title.unwrap_or_default().chars().take(96).collect();
    session.cwd = cwd;
    session.started_at = started;
    session.updated_at = updated;
    session.model = model
        .as_deref()
        .map(model_id)
        .filter(|id| !id.is_empty());
    let mut roles = std::collections::HashMap::<String, (String, Option<i64>)>::new();
    // Every assistant message carries usage, so messages are never truncated here;
    // visible text is capped separately by `add_message`.
    let mut statement = db.prepare("SELECT id, data, time_created FROM message WHERE session_id = ?1 ORDER BY time_created, id")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<i64>>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    for row in rows {
        check_cancelled(cancelled)?;
        let (message_id, data, time) = row.map_err(|error| error.to_string())?;
        let Ok(message) = serde_json::from_str::<Value>(&data) else {
            session.partial = true;
            continue;
        };
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        roles.insert(message_id.clone(), (role.clone(), time));
        if role == "assistant" {
            let model = message_model(&message);
            if model.is_some() {
                session.model = model.clone();
            }
            if let Some(event) = legacy_usage(message_id, &message, time) {
                // `step-finish` parts repeat this same object; the message is the call.
                // Stored input already excludes cache. Reasoning is generated and is not inside output.
                session.usage.push(event);
            }
        }
    }
    let mut statement = db.prepare("SELECT id, message_id, data, time_created FROM part WHERE session_id = ?1 ORDER BY time_created, id LIMIT 4001")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<i64>>(3)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    for (index, row) in rows.enumerate() {
        check_cancelled(cancelled)?;
        if index >= 4000 {
            session.partial = true;
            break;
        }
        let (part_id, message_id, data, time) = row.map_err(|error| error.to_string())?;
        let Ok(part) = serde_json::from_str::<Value>(&data) else {
            session.partial = true;
            continue;
        };
        if part.get("type").and_then(Value::as_str) != Some("text") {
            continue;
        }
        let (role, message_time) = roles.get(&message_id).cloned().unwrap_or_default();
        if role == "user" || role == "assistant" {
            session.add_message(
                part_id,
                &role,
                part.get("text").map(text_content).unwrap_or_default(),
                time.or(message_time),
            );
        }
    }
    check_cancelled(cancelled)?;
    session.finish(source)
}
