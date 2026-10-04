//! ZCode session sources: the internal session database, the bundled agent's
//! model-io rollout logs and the legacy task snapshot files.
//!
//! Three on-disk artifacts are indexed read-only:
//!
//! * `~/.zcode/cli/db/db.sqlite` — the CLI's own session store (`session` +
//!   `model_usage` tables, verified on a real install). It is the complete
//!   session list with real working directories (`session.directory`) and the
//!   authoritative per-request usage: `computed_total_tokens = input +
//!   output` with cached input inside `input_tokens`, and cancelled/error
//!   rows are exactly the all-zero rows. Reading is fail-soft: a missing,
//!   locked or unrecognized database falls back to the rollout/snapshot
//!   discovery below instead of failing the scan.
//! * `~/.zcode/cli/rollout/model-io-sess_<id>.jsonl` — one file per session,
//!   one JSON row per model call with `sessionId`, `startedAt`,
//!   `model.modelId`, the request body and `response.usage`
//!   (`inputTokens`/`outputTokens`/`totalTokens`/`cacheReadTokens`/
//!   `cacheWriteTokens`, matching the official `ZCodeUsage` fields). Rollouts
//!   proved incomplete and transient on real machines (files are pruned while
//!   the internal database keeps every billed request), so for database-known
//!   sessions they contribute only the conversation transcript.
//! * `~/.zcode/v2/sessions/{workspaceHash}/{taskId}.json` — the legacy task
//!   snapshot format (`ZCodeSessionFile`: `meta` + `messages`), still written
//!   for imported/legacy tasks. Snapshots carry no token counters, so a
//!   snapshot-only session lists without usage instead of inventing numbers.
//!
//! `~/.zcode/v2/tasks-index.sqlite` is deliberately not read (ADR-10: avoid
//! coupling the internal schema).

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde_json::Value;

use crate::history::usage::{self, RequestUsage};
use crate::history::{
    check_cancelled, discover_jsonl_controlled, read_jsonl_filtered, source_fingerprint_controlled,
    timestamp, valid_native_id, HistorySource, ParsedSession, UsageEvent, MAX_SOURCES,
};

const ROLLOUT_PREFIX: &str = "model-io-";

pub fn sources(home: &Path) -> Result<Vec<HistorySource>, String> {
    sources_controlled(home, &|| false)
}

pub fn sources_controlled(
    home: &Path,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<HistorySource>, String> {
    let root = super::data_root(home);
    let mut sources = Vec::new();
    let mut seen = HashSet::new();
    // The internal database wins when readable: it knows every session with
    // its real working directory and the complete billed usage.
    let database = root.join("cli").join("db").join("db.sqlite");
    if let Ok(index) = internal_index(&database, cancelled) {
        for (id, updated) in index.sessions {
            if seen.insert(id.clone()) {
                sources.push(HistorySource {
                    path: database.clone(),
                    native_id: Some(id),
                    fingerprint: format!("zcode-session-v2|{}|{updated}", index.stamp),
                    fingerprint_error: None,
                });
                if sources.len() > MAX_SOURCES {
                    return Err("ZCode 会话源超过 5000 个，本次未删除旧索引".into());
                }
            }
        }
    }
    // Rollout logs come next: they carry the conversation transcript, and they
    // stand in completely when the internal database is unreadable. They win
    // over a legacy snapshot with the same native id.
    for mut source in discover_jsonl_controlled(
        &root.join("cli").join("rollout"),
        |path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(ROLLOUT_PREFIX) && name.ends_with(".jsonl"))
        },
        cancelled,
    )? {
        source.native_id = rollout_native_id(&source.path);
        if source
            .native_id
            .as_deref()
            .is_some_and(|id| seen.insert(id.to_owned()))
        {
            sources.push(source);
        }
    }
    for mut source in discover_jsonl_controlled(
        &root.join("v2").join("sessions"),
        |path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".json") && !name.ends_with(".deleted.json"))
        },
        cancelled,
    )? {
        source.native_id = source
            .path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .filter(|id| valid_native_id(id))
            .map(str::to_owned);
        if source
            .native_id
            .as_deref()
            .is_some_and(|id| seen.insert(id.to_owned()))
        {
            sources.push(source);
        }
    }
    Ok(sources)
}

fn rollout_native_id(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let id = name
        .strip_prefix(ROLLOUT_PREFIX)?
        .strip_suffix(".jsonl")?;
    valid_native_id(id).then(|| id.to_owned())
}

struct InternalIndex {
    stamp: String,
    sessions: Vec<(String, i64)>,
}

fn open_internal(database: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("ZCode 内部数据库无法只读打开：{error}"))
}

/// Read the internal session store's session list. Any failure (missing file,
/// lock, schema drift) is reported as an error so discovery can fall back to
/// the rollout/snapshot artifacts instead of failing the whole scan.
fn internal_index(database: &Path, cancelled: &dyn Fn() -> bool) -> Result<InternalIndex, String> {
    check_cancelled(cancelled)?;
    if !database.is_file() {
        return Err("ZCode 内部数据库不存在".into());
    }
    let stamp = source_fingerprint_controlled(database, cancelled)?;
    let connection = open_internal(database)?;
    connection
        .busy_timeout(std::time::Duration::from_millis(500))
        .map_err(|error| error.to_string())?;
    let tables = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('session','model_usage')",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("ZCode 内部数据库结构无法识别：{error}"))?;
    if tables != 2 {
        return Err("ZCode 内部数据库缺少 session/model_usage 表".into());
    }
    let mut statement = connection
        .prepare("SELECT id, time_updated FROM session")
        .map_err(|error| format!("ZCode 内部数据库结构无法识别：{error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<i64>>(1)?.unwrap_or(0),
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut sessions = Vec::new();
    for row in rows {
        check_cancelled(cancelled)?;
        let (id, updated) = row.map_err(|error| error.to_string())?;
        if valid_native_id(&id) {
            sessions.push((id, updated));
        }
    }
    sessions.sort();
    Ok(InternalIndex { stamp, sessions })
}

pub fn parse(source: &HistorySource) -> Result<ParsedSession, String> {
    parse_controlled(source, &|| false)
}

pub fn parse_controlled(
    source: &HistorySource,
    cancelled: &dyn Fn() -> bool,
) -> Result<ParsedSession, String> {
    let name = source
        .path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    if name.starts_with(ROLLOUT_PREFIX) {
        parse_rollout(source, cancelled)
    } else if name == "db.sqlite" {
        parse_internal(source, cancelled)
    } else {
        parse_snapshot(source, cancelled)
    }
}

/// Internal-database session: identity, working directory and the billed
/// per-request usage come from `session`/`model_usage`; a sibling rollout log
/// (when one survives on disk) contributes the conversation transcript.
fn parse_internal(source: &HistorySource, cancelled: &dyn Fn() -> bool) -> Result<ParsedSession, String> {
    check_cancelled(cancelled)?;
    let id = source
        .native_id
        .clone()
        .ok_or("ZCode 内部数据库会话缺少 id")?;
    let connection = open_internal(&source.path)?;
    let (directory, title, created, updated) = connection
        .query_row(
            "SELECT directory, title, time_created, time_updated FROM session WHERE id = ?1",
            [&id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                ))
            },
        )
        .map_err(|_| "ZCode 内部数据库 session 行缺失或结构变化".to_string())?;
    let mut session = ParsedSession::new();
    session.native_id = Some(id.clone());
    if let Some(title) = title.filter(|title| !title.trim().is_empty()) {
        session.title = title.chars().take(96).collect();
    }
    session.cwd = directory.filter(|directory| !directory.trim().is_empty());
    session.started_at = created;
    session.updated_at = updated;
    {
        let mut statement = connection
            .prepare(
                "SELECT id, model_id, started_at, input_tokens, output_tokens,
                        cache_read_input_tokens, cache_creation_input_tokens
                 FROM model_usage WHERE session_id = ?1 ORDER BY started_at",
            )
            .map_err(|_| "ZCode 内部数据库 model_usage 结构变化".to_string())?;
        let rows = statement
            .query_map([&id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                    row.get::<_, Option<i64>>(6)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            check_cancelled(cancelled)?;
            let (usage_id, model, started, input, output, read, write) =
                row.map_err(|error| error.to_string())?;
            let count = |value: Option<i64>| value.map(|value| value.max(0) as u64);
            let Some(counts) = usage::from_optional(
                count(input),
                count(output),
                count(read),
                count(write),
            )
            .map(usage::clamp_cache_inside_input) else {
                continue;
            };
            // Cancelled/error requests are exactly the all-zero rows, so the
            // active check drops them without trusting the status column.
            if !usage::active(counts) {
                continue;
            }
            if session.model.is_none() {
                session.model.clone_from(&model);
            }
            session.usage.push(UsageEvent {
                id: usage_id,
                timestamp: started,
                model,
                input: Some(counts.input),
                output: Some(counts.output),
                cache_read: Some(counts.read),
                cache_write: Some(counts.write),
                // computed_total_tokens = input_tokens + output_tokens, so the
                // cached share is inside input_tokens.
                input_includes_cache: true,
            });
        }
    }
    if let Some(rollout) = rollout_sibling(&source.path, &id).filter(|path| path.is_file()) {
        let partial = rollout_transcript(&rollout, cancelled, &mut session)?;
        session.partial |= partial;
    }
    session.finish(source)
}

/// `db.sqlite` lives at `<root>/cli/db/db.sqlite` and the rollout logs at
/// `<root>/cli/rollout/`, so the sibling log for a database session is one
/// ancestors() hop away from the database root.
fn rollout_sibling(database: &Path, id: &str) -> Option<PathBuf> {
    database
        .ancestors()
        .nth(3)
        .map(|root| root.join("cli").join("rollout").join(format!("{ROLLOUT_PREFIX}{id}.jsonl")))
}

/// Legacy task snapshot (`ZCodeSessionFile`): meta + persisted messages. The
/// format has no token counters, so usage stays empty.
fn parse_snapshot(source: &HistorySource, cancelled: &dyn Fn() -> bool) -> Result<ParsedSession, String> {
    check_cancelled(cancelled)?;
    let text = std::fs::read_to_string(&source.path).map_err(|error| error.to_string())?;
    let value: Value =
        serde_json::from_str(&text).map_err(|error| format!("ZCode 任务快照不是有效 JSON：{error}"))?;
    let meta = value
        .get("meta")
        .ok_or("ZCode 任务快照缺少 meta 字段")?;
    let mut session = ParsedSession::new();
    session.native_id = meta
        .get("taskId")
        .and_then(Value::as_str)
        .filter(|id| valid_native_id(id))
        .map(str::to_owned)
        .or_else(|| source.native_id.clone());
    if let Some(title) = meta.get("title").and_then(Value::as_str) {
        session.title = title.to_owned();
    }
    session.cwd = meta
        .get("workspacePath")
        .and_then(Value::as_str)
        .map(str::to_owned);
    session.model = meta
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_owned);
    session.started_at = meta.get("createdAt").and_then(timestamp);
    session.updated_at = meta.get("updatedAt").and_then(timestamp);
    if let Some(messages) = value.get("messages").and_then(Value::as_array) {
        for (index, message) in messages.iter().enumerate() {
            let role = message.get("role").and_then(Value::as_str).unwrap_or("");
            if role != "user" && role != "assistant" {
                continue;
            }
            let Some(content) = message.get("content").and_then(Value::as_str) else {
                continue;
            };
            let id = message
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| format!("message-{index}"));
            session.add_message(id, role, content.to_owned(), message.get("timestamp").and_then(timestamp));
            if session.model.is_none() {
                session.model = message
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
            }
        }
    } else {
        session.partial = true;
    }
    session.finish(source)
}

/// Fold a rollout log's conversation into `session`. Request bodies repeat the
/// whole conversation on every model call, so only each row's newest user
/// prompt is recorded, plus non-empty assistant response texts.
fn rollout_transcript(
    path: &Path,
    cancelled: &dyn Fn() -> bool,
    session: &mut ParsedSession,
) -> Result<bool, String> {
    let source = HistorySource {
        path: path.to_path_buf(),
        native_id: None,
        fingerprint: String::new(),
        fingerprint_error: None,
    };
    let mut seen_prompts = HashSet::new();
    read_jsonl_filtered(&source, cancelled, |_| false, |line, row| {
        if row.get("type").and_then(Value::as_str) != Some("model_io") {
            return;
        }
        let time = row.get("startedAt").and_then(timestamp);
        if let Some(prompt) = newest_user_prompt(&row) {
            if seen_prompts.insert(prompt.clone()) {
                session.add_message(format!("line-{line}-user"), "user", prompt, time);
            }
        }
        if let Some(text) = row
            .pointer("/response/text")
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
        {
            session.add_message(
                format!("line-{line}-assistant"),
                "assistant",
                text.to_owned(),
                time,
            );
        }
    })
}

/// Model-io rollout log standing in for the whole session: transcript plus
/// usage. Every row with a non-empty `response.usage` becomes one usage event.
/// `inputTokens` already contains the cached input (`totalTokens = input +
/// output`), which the shared report normalizes through
/// `input_includes_cache`.
fn parse_rollout(source: &HistorySource, cancelled: &dyn Fn() -> bool) -> Result<ParsedSession, String> {
    let mut session = ParsedSession::new();
    session.native_id = source.native_id.clone();
    let partial = rollout_transcript(&source.path, cancelled, &mut session)?;
    session.partial |= partial;
    let mut events: BTreeMap<String, RequestUsage> = BTreeMap::new();
    let partial = read_jsonl_filtered(source, cancelled, |_| false, |line, row| {
        if row.get("type").and_then(Value::as_str) != Some("model_io") {
            return;
        }
        let model = row
            .get("model")
            .and_then(|model| model.get("modelId"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        if model.is_some() {
            session.model.clone_from(&model);
        }
        let response = row.get("response").unwrap_or(&Value::Null);
        let Some(counts) = response.get("usage").and_then(usage_counts) else {
            return;
        };
        if !usage::active(counts) {
            return;
        }
        let key = row
            .get("requestId")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("line-{line}"));
        usage::keep_largest_output(
            &mut events,
            key,
            RequestUsage {
                counts,
                model,
                timestamp: row.get("startedAt").and_then(timestamp),
            },
        );
    })?;
    session.partial |= partial;
    session.usage = events
        .into_iter()
        .map(|(id, event)| UsageEvent {
            id,
            model: event.model,
            timestamp: event.timestamp,
            input: Some(event.counts.input),
            output: Some(event.counts.output),
            cache_read: Some(event.counts.read),
            cache_write: Some(event.counts.write),
            input_includes_cache: true,
        })
        .collect();
    session.finish(source)
}

fn usage_counts(usage: &Value) -> Option<crate::history::usage::TokenCounts> {
    // An empty usage object (failed/streaming row) is not a billed call.
    if !usage.as_object().is_some_and(|fields| !fields.is_empty()) {
        return None;
    }
    usage::from_optional(
        usage::field(usage, "inputTokens"),
        usage::field(usage, "outputTokens"),
        usage::field(usage, "cacheReadTokens"),
        usage::field(usage, "cacheWriteTokens"),
    )
}

/// The newest user text of a row's request body: the last `user` message whose
/// content has a plain text block (tool results and nested history are not
/// re-recorded).
fn newest_user_prompt(row: &Value) -> Option<String> {
    let messages = row
        .get("request")
        .and_then(|request| request.get("body"))
        .and_then(|body| body.get("messages"))
        .and_then(Value::as_array)?;
    messages.iter().rev().find_map(|message| {
        if message.get("role").and_then(Value::as_str) != Some("user") {
            return None;
        }
        match message.get("content") {
            Some(Value::String(text)) => (!text.trim().is_empty()).then(|| text.clone()),
            Some(Value::Array(blocks)) => blocks.iter().find_map(|block| {
                if block.get("type").and_then(Value::as_str) != Some("text") {
                    return None;
                }
                block
                    .get("text")
                    .and_then(Value::as_str)
                    .filter(|text| !text.trim().is_empty())
                    .map(str::to_owned)
            }),
            _ => None,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    const ROLLOUT_FIXTURE: &str = include_str!(
        "../../../../tests/fixtures/history/zcode-3.14.4-model-io.jsonl"
    );
    const SNAPSHOT_FIXTURE: &str =
        include_str!("../../../../tests/fixtures/history/zcode-3.14.4-task.json");

    #[test]
    fn rollout_log_yields_the_session_list_with_token_usage() {
        let temp = tempfile::tempdir().unwrap();
        let rollout = temp.path().join(".zcode/cli/rollout");
        std::fs::create_dir_all(&rollout).unwrap();
        std::fs::write(
            rollout.join("model-io-sess_fixture-2026_10_03-a1b2c3.jsonl"),
            ROLLOUT_FIXTURE,
        )
        .unwrap();
        let sources = sources(temp.path()).unwrap();
        assert_eq!(sources.len(), 1, "{sources:?}");
        assert_eq!(
            sources[0].native_id.as_deref(),
            Some("sess_fixture-2026_10_03-a1b2c3")
        );
        let session = parse(&sources[0]).unwrap();
        assert_eq!(
            session.native_id.as_deref(),
            Some("sess_fixture-2026_10_03-a1b2c3")
        );
        assert_eq!(session.model.as_deref(), Some("GLM-5.3"));
        assert_eq!(
            session.title, "帮我在仓库里加上每日构建脚本",
            "标题取首条用户输入"
        );
        let roles: Vec<&str> = session
            .messages
            .iter()
            .map(|message| message.role.as_str())
            .collect();
        assert_eq!(roles, vec!["user", "assistant", "user"]);
        assert_eq!(session.usage.len(), 3);
        let first = &session.usage[0];
        assert_eq!(first.model.as_deref(), Some("GLM-5.3"));
        assert_eq!(first.input, Some(115_507));
        assert_eq!(first.output, Some(1_941));
        assert_eq!(first.cache_read, Some(19_456));
        assert_eq!(first.cache_write, Some(0));
        assert!(first.input_includes_cache);
        let total: u64 = session
            .usage
            .iter()
            .map(|event| event.input.unwrap_or(0) + event.output.unwrap_or(0))
            .sum();
        assert_eq!(total, 115_507 + 1_941 + 139_638 + 1_117 + 140_865 + 100);
    }

    #[test]
    fn legacy_task_snapshot_lists_messages_without_invented_usage() {
        let temp = tempfile::tempdir().unwrap();
        let sessions = temp.path().join(".zcode/v2/sessions/1a2b3c4d5e6f");
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::write(
            sessions.join("sess_imported-2026_09_28-deadbeef.json"),
            SNAPSHOT_FIXTURE,
        )
        .unwrap();
        // A deleted marker must not surface as a session.
        std::fs::write(
            sessions.join("sess_imported-2026_09_28-gone.json.deleted.json"),
            "{}",
        )
        .unwrap();
        let sources = sources(temp.path()).unwrap();
        assert_eq!(sources.len(), 1, "{sources:?}");
        assert_eq!(
            sources[0].native_id.as_deref(),
            Some("sess_imported-2026_09_28-deadbeef")
        );
        let session = parse(&sources[0]).unwrap();
        assert_eq!(session.title, "导入的历史任务");
        assert_eq!(
            session.cwd.as_deref(),
            Some("C:\\Users\\user\\project\\demo")
        );
        assert_eq!(session.messages.len(), 2);
        assert_eq!(session.messages[0].role, "user");
        assert_eq!(session.messages[1].role, "assistant");
        assert_eq!(session.model.as_deref(), Some("GLM-5.3"));
        assert!(
            session.usage.is_empty(),
            "快照格式没有 token 字段，不得伪造用量"
        );
    }

    #[test]
    fn rollout_wins_when_a_task_has_both_artifacts() {
        let temp = tempfile::tempdir().unwrap();
        let rollout = temp.path().join(".zcode/cli/rollout");
        std::fs::create_dir_all(&rollout).unwrap();
        std::fs::write(
            rollout.join("model-io-sess_both-2026_10_03-1.jsonl"),
            ROLLOUT_FIXTURE,
        )
        .unwrap();
        let sessions = temp.path().join(".zcode/v2/sessions/1a2b3c4d5e6f");
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::write(sessions.join("sess_both-2026_10_03-1.json"), SNAPSHOT_FIXTURE).unwrap();
        let sources = sources(temp.path()).unwrap();
        assert_eq!(sources.len(), 1, "{sources:?}");
        assert!(sources[0]
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap()
            .starts_with("model-io-"));
    }

    #[test]
    fn newest_user_prompt_skips_tool_results_and_history() {
        let row: Value = serde_json::from_str(
            r#"{"request":{"body":{"messages":[
                {"role":"user","content":[{"type":"text","text":"第一条"}]},
                {"role":"assistant","content":[]},
                {"role":"user","content":[{"type":"tool_result","tool_use_id":"c1","content":"out"}]},
                {"role":"user","content":[{"type":"text","text":"最新一条"}]}
            ]}}}"#,
        )
        .unwrap();
        assert_eq!(newest_user_prompt(&row).as_deref(), Some("最新一条"));
    }

    /// Desensitized from the real CLI's internal store: same tables and column
    /// shapes, rewritten ids/directories/counts.
    fn write_internal_db(database: &Path) {
        let connection = Connection::open(database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE session (
                    id TEXT PRIMARY KEY, directory TEXT, path TEXT, title TEXT,
                    task_type TEXT, time_created INTEGER, time_updated INTEGER);
                 CREATE TABLE model_usage (
                    id TEXT PRIMARY KEY, session_id TEXT, model_id TEXT, started_at INTEGER,
                    input_tokens INTEGER, output_tokens INTEGER,
                    cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER,
                    computed_total_tokens INTEGER, status TEXT, attempt_index INTEGER,
                    logical_request_id TEXT);",
            )
            .unwrap();
        for (id, directory, title, created, updated) in [
            ("sess_fixture-2026_10_03-a1b2c3", r"C:\Users\example\zcode-demo", "数据库里的会话标题", 1791000000000i64, 1791000900000i64),
            ("sess_930b8796-7d77-4e70-a8ba-6209ff1272e8", r"C:\Users\example\other", "仅有数据库记录的会话", 1791001000000, 1791001100000),
        ] {
            connection
                .execute(
                    "INSERT INTO session (id, directory, path, title, task_type, time_created, time_updated)
                     VALUES (?1, ?2, ?2, ?3, 'interactive', ?4, ?5)",
                    params![id, directory, title, created, updated],
                )
                .unwrap();
        }
        for (id, session, model, started, input, output, read, write, status) in [
            ("usage_model_main_turn_first_0001", "sess_fixture-2026_10_03-a1b2c3", "GLM-5.3", 1791000010000i64, 144201i64, 112i64, 144064i64, 0i64, "completed"),
            ("usage_model_main_turn_second_0002", "sess_fixture-2026_10_03-a1b2c3", "GLM-5.3", 1791000020000, 1000, 10, 900, 0, "completed"),
            ("usage_model_main_turn_cancelled_0003", "sess_fixture-2026_10_03-a1b2c3", "GLM-5.3", 1791000030000, 0, 0, 0, 0, "cancelled"),
            ("usage_model_main_turn_dbonly_0004", "sess_930b8796-7d77-4e70-a8ba-6209ff1272e8", "GLM-5.3", 1791001010000, 500, 5, 400, 0, "completed"),
        ] {
            connection
                .execute(
                    "INSERT INTO model_usage (id, session_id, model_id, started_at, input_tokens, output_tokens,
                                              cache_read_input_tokens, cache_creation_input_tokens,
                                              computed_total_tokens, status, attempt_index, logical_request_id)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?5 + ?6, ?9, 0, ?1)",
                    params![id, session, model, started, input, output, read, write, status],
                )
                .unwrap();
        }
    }

    #[test]
    fn internal_db_lists_sessions_with_directory_usage_and_rollout_transcript() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".zcode");
        let rollout = root.join("cli").join("rollout");
        std::fs::create_dir_all(&rollout).unwrap();
        std::fs::write(
            rollout.join("model-io-sess_fixture-2026_10_03-a1b2c3.jsonl"),
            ROLLOUT_FIXTURE,
        )
        .unwrap();
        let database = root.join("cli").join("db").join("db.sqlite");
        std::fs::create_dir_all(database.parent().unwrap()).unwrap();
        write_internal_db(&database);
        let sources = sources(temp.path()).unwrap();
        // The database is the session list; the rollout no longer doubles as
        // its own source.
        assert_eq!(sources.len(), 2, "{sources:?}");
        assert!(sources
            .iter()
            .all(|source| source.fingerprint.starts_with("zcode-session-v2|")));
        let source = sources
            .iter()
            .find(|source| source.native_id.as_deref() == Some("sess_fixture-2026_10_03-a1b2c3"))
            .unwrap();
        let session = parse(source).unwrap();
        assert_eq!(
            session.native_id.as_deref(),
            Some("sess_fixture-2026_10_03-a1b2c3")
        );
        // The working directory comes from the database even though rollout
        // rows carry none anywhere.
        assert_eq!(session.cwd.as_deref(), Some(r"C:\Users\example\zcode-demo"));
        assert_eq!(session.title, "数据库里的会话标题");
        assert_eq!(session.started_at, Some(1791000000000));
        assert_eq!(session.updated_at, Some(1791000900000));
        // The sibling rollout log still contributes the transcript.
        assert_eq!(session.messages.len(), 3);
        // Usage is authoritative from model_usage: two active rows survive and
        // the cancelled all-zero row drops.
        assert_eq!(session.usage.len(), 2, "{:?}", session.usage);
        assert_eq!(session.usage[0].input, Some(144_201));
        assert_eq!(session.usage[0].output, Some(112));
        assert_eq!(session.usage[0].cache_read, Some(144_064));
        assert_eq!(session.usage[0].cache_write, Some(0));
        assert_eq!(session.usage[0].timestamp, Some(1791000010000));
        assert!(session.usage.iter().all(|event| event.input_includes_cache));
        let total: u64 = session
            .usage
            .iter()
            .map(|event| event.input.unwrap_or(0) + event.output.unwrap_or(0))
            .sum();
        assert_eq!(total, 144_201 + 112 + 1000 + 10);
        // A database-only session indexes without any rollout on disk.
        let only = sources
            .iter()
            .find(|source| source.native_id.as_deref() == Some("sess_930b8796-7d77-4e70-a8ba-6209ff1272e8"))
            .unwrap();
        let only = parse(only).unwrap();
        assert_eq!(only.cwd.as_deref(), Some(r"C:\Users\example\other"));
        assert_eq!(only.usage.len(), 1);
        assert!(only.messages.is_empty());
    }

    #[test]
    fn unreadable_internal_db_falls_back_to_rollout_discovery() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".zcode");
        let database = root.join("cli").join("db").join("db.sqlite");
        std::fs::create_dir_all(database.parent().unwrap()).unwrap();
        std::fs::write(&database, b"not a sqlite database").unwrap();
        let rollout = root.join("cli").join("rollout");
        std::fs::create_dir_all(&rollout).unwrap();
        std::fs::write(
            rollout.join("model-io-sess_fixture-2026_10_03-a1b2c3.jsonl"),
            ROLLOUT_FIXTURE,
        )
        .unwrap();
        let sources = sources(temp.path()).unwrap();
        assert_eq!(sources.len(), 1, "{sources:?}");
        assert!(!sources[0].fingerprint.starts_with("zcode-session-v2"));
        let session = parse(&sources[0]).unwrap();
        assert_eq!(session.usage.len(), 3);
    }
}
