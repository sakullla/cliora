use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde_json::Value;

use super::usage;
use super::{check_cancelled, text_content, valid_native_id, HistorySource, ParsedSession, UsageEvent, MAX_SOURCES};

fn database(home: &Path) -> PathBuf {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".local/share"));
    base.join("opencode/opencode.db")
}

fn open(path: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("OpenCode 历史库不可读取：{error}"))
}

pub fn sources(home: &Path) -> Result<Vec<HistorySource>, String> {
    sources_controlled(home, &|| false)
}

pub fn sources_controlled(home: &Path, cancelled: &dyn Fn() -> bool) -> Result<Vec<HistorySource>, String> {
    check_cancelled(cancelled)?;
    let path = database(home);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let db = open(&path)?;
    let mut statement = db
        .prepare("SELECT id, time_updated FROM session ORDER BY time_updated DESC LIMIT ?1")
        .map_err(|error| format!("OpenCode 会话索引格式未知：{error}"))?;
    let rows = statement
        .query_map([MAX_SOURCES as i64 + 1], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?))
        })
        .map_err(|error| error.to_string())?;
    let mut result = Vec::new();
    for row in rows {
        check_cancelled(cancelled)?;
        let (id, updated) = row.map_err(|error| error.to_string())?;
        if !valid_native_id(&id) {
            continue;
        }
        result.push(HistorySource {
            path: path.clone(),
            native_id: Some(id),
            fingerprint: updated.unwrap_or(0).to_string(),
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
pub(super) fn model_id(raw: &str) -> String {
    let trimmed = raw.trim();
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        if let Some(id) = value
            .get("id")
            .or_else(|| value.get("modelID"))
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        {
            return id.to_owned();
        }
    }
    trimmed.to_owned()
}

fn message_model(message: &Value) -> Option<String> {
    message
        .get("modelID")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            message.get("model").and_then(|model| {
                model
                    .as_str()
                    .map(model_id)
                    .or_else(|| {
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

pub fn parse(source: &HistorySource) -> Result<ParsedSession, String> {
    parse_controlled(source, &|| false)
}

pub fn parse_controlled(source: &HistorySource, cancelled: &dyn Fn() -> bool) -> Result<ParsedSession, String> {
    check_cancelled(cancelled)?;
    let id = source.native_id.as_deref().ok_or("OpenCode 会话 ID 缺失")?;
    let db = open(&source.path)?;
    let (title, cwd, started, updated, version, fallback_model): (String, Option<String>, Option<i64>, Option<i64>, Option<String>, Option<String>) = db.query_row(
        "SELECT title, directory, time_created, time_updated, version, model FROM session WHERE id = ?1", [id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?))
    ).map_err(|error| format!("OpenCode 会话不存在或格式未知：{error}"))?;
    if !version
        .as_deref()
        .is_some_and(|value| value.starts_with("1."))
    {
        return Err("OpenCode 会话格式版本尚未验证".into());
    }
    let mut session = ParsedSession::new();
    session.native_id = Some(id.to_owned());
    session.title = title.chars().take(96).collect();
    session.cwd = cwd;
    session.started_at = started;
    session.updated_at = updated;
    session.model = fallback_model.as_deref().map(model_id).filter(|id| !id.is_empty());
    let mut roles = std::collections::HashMap::<String, (String, Option<i64>)>::new();
    let mut statement = db.prepare("SELECT id, data, time_created FROM message WHERE session_id = ?1 ORDER BY time_created, id LIMIT 3001")
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
    for (index, row) in rows.enumerate() {
        check_cancelled(cancelled)?;
        if index >= 3000 {
            session.partial = true;
            break;
        }
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
            if let Some(tokens) = message.get("tokens") {
                // `step-finish` parts repeat this same object; the message is the call.
                // Stored input already excludes cache. Reasoning is generated and is not inside output.
                let cache = tokens.get("cache").unwrap_or(&Value::Null);
                session.usage.push(UsageEvent {
                    id: message_id,
                    model,
                    timestamp: time,
                    input: token(tokens, "input"),
                    output: usage::generated(token(tokens, "output"), token(tokens, "reasoning")),
                    cache_read: token(cache, "read"),
                    cache_write: token(cache, "write"),
                    input_includes_cache: false,
                });
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
