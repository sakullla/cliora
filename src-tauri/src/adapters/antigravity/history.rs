//! Antigravity session sources: `conversation_summaries.db` index,
//! `brain/<id>/transcript_full.jsonl` transcripts and per-conversation
//! `conversations/<id>.db` usage rows.
//!
//! [RE] evidence: third-party reverse engineering (codeburn against `agy`
//! 1.2.x; the local machine runs 1.3.1 but has never produced data, so every
//! fixture is hand-built from the documented schema — 02 ADR-2 evidence
//! policy). Layout under the `~/.gemini/antigravity` data root:
//!
//! * `conversation_summaries.db` — SQLite index with `conversation_summaries`
//!   rows (`id`, `title`, `workspace`, `status`, `parent_conversation_id`);
//!   rows with a parent stay with their host conversation and are never
//!   listed as independent sessions.
//! * `brain/<conversation-id>/.system_generated/logs/transcript_full.jsonl` —
//!   one JSON object per line: `{step_index, source, type, status,
//!   created_at, content, thinking?}` with `type` ∈ `USER_INPUT` /
//!   `PLANNER_RESPONSE` / `AGENT_RESPONSE`. The three documented row types
//!   map to user/assistant/assistant; other types and `thinking` stay out of
//!   the timeline.
//! * `conversations/<id>.db` — SQLite with a `gen_metadata` table of protobuf
//!   blobs (see [`protobuf`]): field 1 `ChatModel` → field 4
//!   `ModelUsageStats` (`exa.codeium_common_pb`: 2 input_tokens UNCACHED,
//!   3 output_tokens = 9 + 10, 4 cache_write_tokens, 5 cache_read_tokens,
//!   9 thinking_output_tokens, 10 response_output_tokens, 11 response_id),
//!   ChatModel 19 model config id, 21 display name, 9 → 4 timestamp; row
//!   field 2 stepIndices varint, field 4 generation uuid.
//!
//! Usage semantics: stored `input_tokens` EXCLUDES cache read/write →
//! `input_includes_cache` is false on every event; stored `output_tokens`
//! already includes thinking output (field 3 = field 9 + field 10,
//! verified per row and treated as drift when it disagrees); duplicates are
//! dropped by `response_id`. Strict degradation per the [RE] policy: any
//! structural mismatch (missing stats/response_id, unexpected wire type,
//! truncated blob, malformed transcript line, missing conversation database)
//! skips that row and marks the session partial — fields are never guessed.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde_json::Value;

use super::protobuf::{Mismatch, Reader};
use crate::history::{
    check_cancelled, text_content, timestamp as parse_timestamp, valid_native_id, HistorySource,
    ParsedSession, UsageEvent, MAX_SOURCES,
};

const MAX_TRANSCRIPT_LINES: usize = 4_000;

pub fn sources(home: &Path) -> Result<Vec<HistorySource>, String> {
    sources_controlled(home, &|| false)
}

pub fn sources_controlled(
    home: &Path,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<HistorySource>, String> {
    check_cancelled(cancelled)?;
    let root = super::data_root(home);
    let index = root.join("conversation_summaries.db");
    if !index.is_file() {
        return Ok(Vec::new());
    }
    let connection = open_summaries(&index)?;
    let mut statement = connection
        .prepare(
            "SELECT id, title, workspace, status, parent_conversation_id
             FROM conversation_summaries WHERE parent_conversation_id IS NULL
             ORDER BY rowid DESC LIMIT ?1",
        )
        .map_err(|error| format!("Antigravity 会话索引结构无法识别：{error}"))?;
    let rows = statement
        .query_map([MAX_SOURCES as i64 + 1], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|error| format!("Antigravity 会话索引结构无法识别：{error}"))?;
    let mut out = Vec::new();
    for row in rows {
        check_cancelled(cancelled)?;
        let (id, title, workspace, status) = row.map_err(|error| error.to_string())?;
        if !valid_native_id(&id) {
            continue;
        }
        if out.len() >= MAX_SOURCES {
            return Err("Antigravity 会话源超过 5000 个，本次未删除旧索引".into());
        }
        // Discovery reads only revisions, never every transcript/protobuf blob.
        // Include WAL commits and explicit missing markers; parsing still reports
        // absent or malformed native data through its existing partial state.
        let checked = (|| -> Result<String, String> {
            let transcript = crate::history::source_cache::optional_stamp(&transcript_path(&root, &id), cancelled)?;
            let database = conversation_db(&root, &id);
            let usage = if database.exists() {
                crate::history::source_cache::database_stamp(&database, cancelled)?
            } else { "missing".into() };
            Ok(format!("antigravity-session-v2|{id}|{title:?}|{workspace:?}|{status:?}|{transcript}|{usage}"))
        })();
        out.push(HistorySource {
            native_title: title.filter(|title| !title.trim().is_empty()),
            path: index.clone(), native_id: Some(id),
            fingerprint: checked.as_ref().cloned().unwrap_or_default(),
            fingerprint_error: checked.err(),
        });
    }
    Ok(out)
}

fn transcript_path(root: &Path, id: &str) -> PathBuf {
    root.join("brain")
        .join(id)
        .join(".system_generated")
        .join("logs")
        .join("transcript_full.jsonl")
}

fn conversation_db(root: &Path, id: &str) -> PathBuf {
    root.join("conversations").join(format!("{id}.db"))
}

fn open_summaries(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("Antigravity 会话索引无法只读打开：{error}"))?;
    connection
        .busy_timeout(std::time::Duration::from_millis(500))
        .map_err(|error| error.to_string())?;
    let tables = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='conversation_summaries'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("Antigravity 会话索引结构无法识别：{error}"))?;
    if tables != 1 {
        return Err("Antigravity 会话索引缺少 conversation_summaries 表".into());
    }
    Ok(connection)
}

fn open_conversation(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("Antigravity 会话用量库无法只读打开：{error}"))?;
    connection
        .busy_timeout(std::time::Duration::from_millis(500))
        .map_err(|error| error.to_string())?;
    let tables = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='gen_metadata'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("Antigravity 会话用量库结构无法识别：{error}"))?;
    if tables != 1 {
        return Err("Antigravity 会话用量库缺少 gen_metadata 表".into());
    }
    Ok(connection)
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
        .ok_or("Antigravity 会话缺少 conversation id")?;
    let connection = open_summaries(&source.path)?;
    let (title, workspace): (Option<String>, Option<String>) = connection
        .query_row(
            "SELECT title, workspace FROM conversation_summaries
             WHERE id = ?1 AND parent_conversation_id IS NULL",
            [&id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "Antigravity 会话索引行缺失或结构变化".to_string())?;
    let mut session = ParsedSession::new();
    session.native_id = Some(id.clone());
    if let Some(title) = title.filter(|title| !title.trim().is_empty()) {
        session.title = title.chars().take(96).collect();
    }
    session.cwd = workspace.filter(|workspace| !workspace.trim().is_empty());
    // The source path is <data root>/conversation_summaries.db; transcripts and
    // the usage database live beside it under the same root.
    let root = source
        .path
        .parent()
        .ok_or("Antigravity 会话索引路径无效")?
        .to_path_buf();
    // Transcript: only the three documented row types enter the timeline.
    let transcript = transcript_path(&root, &id);
    if !transcript.is_file() {
        // The index knows the conversation but its transcript is gone: the
        // session degrades to partial instead of failing wholesale.
        session.partial = true;
    } else {
        let text = std::fs::read_to_string(&transcript)
            .map_err(|error| format!("Antigravity 会话记录无法读取：{error}"))?;
        for (index, line) in text.lines().enumerate() {
            check_cancelled(cancelled)?;
            if index >= MAX_TRANSCRIPT_LINES {
                session.partial = true;
                break;
            }
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(row) = serde_json::from_str::<Value>(line) else {
                session.partial = true;
                continue;
            };
            let role = match row.get("type").and_then(Value::as_str) {
                Some("USER_INPUT") => "user",
                Some("PLANNER_RESPONSE") | Some("AGENT_RESPONSE") => "assistant",
                _ => continue,
            };
            let content = row.get("content").cloned().unwrap_or(Value::Null);
            session.add_message(
                format!("{id}:{index}"),
                role,
                text_content(&content),
                row.get("created_at").and_then(parse_timestamp),
            );
        }
    }
    check_cancelled(cancelled)?;
    // Usage: protobuf rows in conversations/<id>.db, strictly validated.
    let usage_db = conversation_db(&root, &id);
    if !usage_db.is_file() {
        session.partial = true;
    } else {
        let usage = open_conversation(&usage_db)?;
        let mut statement = usage
            .prepare("SELECT data FROM gen_metadata ORDER BY rowid")
            .map_err(|_| "Antigravity 会话用量库 gen_metadata 结构变化".to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, Vec<u8>>(0))
            .map_err(|error| error.to_string())?;
        let mut seen = HashSet::new();
        for blob in rows.flatten() {
            check_cancelled(cancelled)?;
            match parse_generation(&blob) {
                // Ok(None): a gen_metadata row that carries no usage stats is
                // not a billed call; it stays out without degrading anything.
                Ok(None) => {}
                Ok(Some(event)) => {
                    if !seen.insert(event.response_id.clone()) {
                        // response_id repeats across stores of the same
                        // generation: documented dedup, not degradation.
                        continue;
                    }
                    let response_id = event.response_id.clone();
                    // The session-level model label keeps the first seen
                    // generation's model; per-event models stay authoritative.
                    if session.model.is_none() {
                        session.model.clone_from(&event.model);
                    }
                    session.usage.push(UsageEvent {
                        request_count: Some(1),
                        id: response_id,
                        model: event.model,
                        timestamp: event.timestamp,
                        input: Some(event.input),
                        output: Some(event.output),
                        cache_read: Some(event.cache_read),
                        cache_write: Some(event.cache_write),
                        // Verified [RE] semantics: field 2 counts only the
                        // uncached share; cache read/write are separate fields.
                        input_includes_cache: false,
                    });
                }
                Err(Mismatch) => session.partial = true,
            }
        }
    }
    check_cancelled(cancelled)?;
    session.finish(source)
}

/// A strictly parsed `gen_metadata` usage row.
#[derive(Debug, PartialEq)]
struct GenerationUsage {
    response_id: String,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    model: Option<String>,
    timestamp: Option<i64>,
}

/// Walks one `gen_metadata` blob. `Ok(None)` means the row carries no usage
/// stats; `Err(Mismatch)` means structural drift — the caller skips the row
/// and marks the session partial, never guessing a field.
fn parse_generation(blob: &[u8]) -> Result<Option<GenerationUsage>, Mismatch> {
    let mut chat_model: Option<&[u8]> = None;
    let mut reader = Reader::new(blob);
    while !reader.done() {
        let (number, _, field) = reader.next()?;
        // Documented row fields: 1 ChatModel (message), 2 stepIndices
        // (varint), 4 generation uuid (string). A documented number arriving
        // with the wrong wire type is drift even when the value is unused.
        match number {
            1 => chat_model = Some(field.as_bytes()?),
            2 => {
                field.as_varint()?;
            }
            4 => {
                field.as_bytes()?;
            }
            _ => {}
        }
    }
    let Some(chat_model) = chat_model else {
        // No ChatModel wrapper: nothing billable in this row.
        return Ok(None);
    };
    let mut stats: Option<&[u8]> = None;
    let mut timestamp_wrapper: Option<&[u8]> = None;
    let mut model_id: Option<String> = None;
    let mut display_name: Option<String> = None;
    let mut reader = Reader::new(chat_model);
    while !reader.done() {
        let (number, _, field) = reader.next()?;
        match number {
            4 => stats = Some(field.as_bytes()?),
            9 => timestamp_wrapper = Some(field.as_bytes()?),
            19 => model_id = Some(decode_string(field.as_bytes()?)?),
            21 => display_name = Some(decode_string(field.as_bytes()?)?),
            _ => {}
        }
    }
    let Some(stats) = stats else {
        return Ok(None);
    };
    let mut input_tokens = None;
    let mut output_tokens = None;
    let mut cache_write_tokens = None;
    let mut cache_read_tokens = None;
    let mut thinking_output_tokens = None;
    let mut response_output_tokens = None;
    let mut response_id = None;
    let mut reader = Reader::new(stats);
    while !reader.done() {
        let (number, _, field) = reader.next()?;
        match number {
            2 => input_tokens = Some(field.as_varint()?),
            3 => output_tokens = Some(field.as_varint()?),
            4 => cache_write_tokens = Some(field.as_varint()?),
            5 => cache_read_tokens = Some(field.as_varint()?),
            9 => thinking_output_tokens = Some(field.as_varint()?),
            10 => response_output_tokens = Some(field.as_varint()?),
            11 => response_id = Some(decode_string(field.as_bytes()?)?),
            _ => {}
        }
    }
    if input_tokens.is_none()
        && output_tokens.is_none()
        && cache_write_tokens.is_none()
        && cache_read_tokens.is_none()
    {
        // The stats submessage exists but holds none of the documented token
        // counters: drift, not a zero-cost call.
        return Err(Mismatch);
    }
    // Documented identity: field 3 = field 9 + field 10. Disagreement means
    // the [RE] schema no longer holds for this row.
    if let (Some(output), Some(thinking), Some(response)) =
        (output_tokens, thinking_output_tokens, response_output_tokens)
    {
        if output != thinking.saturating_add(response) {
            return Err(Mismatch);
        }
    }
    // The response_id is the documented dedup key; without it the row cannot
    // be accounted for honestly.
    let Some(response_id) = response_id.filter(|id| !id.is_empty()) else {
        return Err(Mismatch);
    };
    let mut timestamp = None;
    if let Some(wrapper) = timestamp_wrapper {
        let mut reader = Reader::new(wrapper);
        while !reader.done() {
            let (number, _, field) = reader.next()?;
            if number == 4 {
                timestamp = Some(field.as_varint()? as i64);
            }
        }
    }
    let model = model_id
        .filter(|id| !id.is_empty())
        .or_else(|| display_name.filter(|name| !name.is_empty()));
    Ok(Some(GenerationUsage {
        response_id,
        input: input_tokens.unwrap_or(0),
        output: output_tokens.unwrap_or(0),
        cache_read: cache_read_tokens.unwrap_or(0),
        cache_write: cache_write_tokens.unwrap_or(0),
        model,
        timestamp,
    }))
}

fn decode_string(bytes: &[u8]) -> Result<String, Mismatch> {
    String::from_utf8(bytes.to_vec()).map_err(|_| Mismatch)
}


#[cfg(test)]
mod tests {
    use super::*;
    use super::super::protobuf::encode;
    use rusqlite::params;
    use serde_json::json;

    /// Hand-built sanitized row set following the documented [RE] schema
    /// (codeburn against agy 1.2.x; no local agy data exists to desensitize).
    /// Tests rebuild conversation_summaries.db, conversations/<id>.db and the
    /// transcript jsonl deterministically from these rows (the mimo_code
    /// in-test database pattern; no committed binaries).
    const ROWS_FIXTURE: &str =
        include_str!("../../../../tests/fixtures/history/antigravity-cli-1.3/sessions.json");

    const ROOT_ID: &str = "conv_root_20261005_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6";
    const CHILD_ID: &str = "conv_child_20261005_z9y8x7w6v5u4t3s2r1q0p1o2n3m2l1k0";

    fn fixture() -> Value {
        serde_json::from_str(ROWS_FIXTURE).unwrap()
    }

    /// Encodes one structured fixture generation into its protobuf blob.
    fn encode_generation(row: &Value) -> Vec<u8> {
        if row["malformed"] == "wrong_wire" {
            // Documented varint field 2 arrives length-delimited: drift.
            let mut blob = encode::bytes_field(2, b"150");
            blob.extend(encode::string_field(
                4,
                row["generation_uuid"].as_str().unwrap_or(""),
            ));
            return blob;
        }
        if row["malformed"] == "truncated" {
            // Cut the blob inside the stats submessage.
            let full = encode_well_formed_generation(row);
            return full[..full.len() - 4].to_vec();
        }
        encode_well_formed_generation(row)
    }

    fn encode_well_formed_generation(row: &Value) -> Vec<u8> {
        let mut stats = Vec::new();
        if let Some(value) = row["input_tokens"].as_u64() {
            stats.extend(encode::varint_field(2, value));
        }
        if let Some(value) = row["output_tokens"].as_u64() {
            stats.extend(encode::varint_field(3, value));
        }
        if let Some(value) = row["cache_write_tokens"].as_u64() {
            stats.extend(encode::varint_field(4, value));
        }
        if let Some(value) = row["cache_read_tokens"].as_u64() {
            stats.extend(encode::varint_field(5, value));
        }
        if let Some(value) = row["thinking_output_tokens"].as_u64() {
            stats.extend(encode::varint_field(9, value));
        }
        if let Some(value) = row["response_output_tokens"].as_u64() {
            stats.extend(encode::varint_field(10, value));
        }
        if let Some(value) = row["response_id"].as_str() {
            stats.extend(encode::string_field(11, value));
        }
        if row["no_stats"] == true {
            // A ChatModel wrapper without the ModelUsageStats submessage.
            let mut chat_model = Vec::new();
            if let Some(value) = row["display_name"].as_str() {
                chat_model.extend(encode::string_field(21, value));
            }
            return encode::bytes_field(1, &chat_model);
        }
        let mut chat_model = encode::bytes_field(4, &stats);
        if let Some(value) = row["timestamp"].as_u64() {
            chat_model.extend(encode::bytes_field(9, &encode::varint_field(4, value)));
        }
        if let Some(value) = row["model_id"].as_str() {
            chat_model.extend(encode::string_field(19, value));
        }
        if let Some(value) = row["display_name"].as_str() {
            chat_model.extend(encode::string_field(21, value));
        }
        let mut blob = encode::bytes_field(1, &chat_model);
        if let Some(indices) = row["step_indices"].as_array() {
            for index in indices {
                blob.extend(encode::varint_field(2, index.as_u64().unwrap()));
            }
        }
        if let Some(value) = row["generation_uuid"].as_str() {
            blob.extend(encode::string_field(4, value));
        }
        blob
    }

    fn write_fixture(home: &std::path::Path) {
        let rows = fixture();
        let root = super::super::data_root(home);
        let summaries = root.join("conversation_summaries.db");
        std::fs::create_dir_all(&root).unwrap();
        let index = Connection::open(&summaries).unwrap();
        index
            .execute_batch(
                "CREATE TABLE conversation_summaries (
                    id TEXT PRIMARY KEY, title TEXT, workspace TEXT,
                    status TEXT, parent_conversation_id TEXT);",
            )
            .unwrap();
        for row in rows["conversations"].as_array().unwrap() {
            index
                .execute(
                    "INSERT INTO conversation_summaries
                        (id, title, workspace, status, parent_conversation_id)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        row["id"].as_str().unwrap(),
                        row["title"].as_str(),
                        row["workspace"].as_str(),
                        row["status"].as_str(),
                        row["parent_conversation_id"].as_str(),
                    ],
                )
                .unwrap();
            if let Some(generations) = row["generations"].as_array() {
                let db = conversation_db(&root, row["id"].as_str().unwrap());
                std::fs::create_dir_all(db.parent().unwrap()).unwrap();
                let usage = Connection::open(&db).unwrap();
                usage
                    .execute_batch(
                        "CREATE TABLE gen_metadata (key TEXT, data BLOB);",
                    )
                    .unwrap();
                for generation in generations {
                    usage
                        .execute(
                            "INSERT INTO gen_metadata (key, data) VALUES (?1, ?2)",
                            params![
                                generation["generation_uuid"].as_str().unwrap_or(""),
                                encode_generation(generation),
                            ],
                        )
                        .unwrap();
                }
            }
            if let Some(lines) = row["transcript"].as_array() {
                let transcript = transcript_path(&root, row["id"].as_str().unwrap());
                std::fs::create_dir_all(transcript.parent().unwrap()).unwrap();
                let text = lines
                    .iter()
                    .map(|line| line.to_string())
                    .collect::<Vec<_>>()
                    .join("\n");
                std::fs::write(&transcript, format!("{text}\n")).unwrap();
            }
        }
    }

    #[test]
    fn fixture_index_lists_root_conversations_with_fingerprinted_sources() {
        let home = tempfile::tempdir().unwrap();
        write_fixture(home.path());
        let found = sources(home.path()).unwrap();
        // Only the root conversation is a source; the child row stays with its
        // host and is never listed independently.
        assert_eq!(found.len(), 1, "{found:?}");
        assert!(found
            .iter()
            .all(|source| source.native_id.as_deref() != Some(CHILD_ID)));
        assert_eq!(found[0].native_id.as_deref(), Some(ROOT_ID));
        assert_eq!(found[0].native_title.as_deref(), Some("帮我把部署脚本改成幂等版本"));
        assert!(found[0].fingerprint.starts_with("antigravity-session-v2|"));
        let before = found[0].fingerprint.clone();
        // A new usage row in the conversation database changes the fingerprint.
        let usage = Connection::open(&conversation_db(
            &super::super::data_root(home.path()),
            ROOT_ID,
        ))
        .unwrap();
        let row = json!({
            "response_id": "resp_added_0000000001",
            "generation_uuid": "cascade_added:resp_added_0000000001",
            "input_tokens": 9, "output_tokens": 3,
            "thinking_output_tokens": 1, "response_output_tokens": 2,
            "cache_write_tokens": 0, "cache_read_tokens": 0,
            "model_id": "gemini-3-pro-preview", "timestamp": 1791000090000u64
        });
        usage
            .execute(
                "INSERT INTO gen_metadata (key, data) VALUES (?1, ?2)",
                params!["cascade_added:resp_added_0000000001", encode_well_formed_generation(&row)],
            )
            .unwrap();
        drop(usage);
        let after = sources(home.path()).unwrap();
        assert_ne!(before, after[0].fingerprint);
    }

    #[test]
    fn root_conversation_parses_identity_transcript_and_split_token_usage() {
        let home = tempfile::tempdir().unwrap();
        write_fixture(home.path());
        let found = sources(home.path()).unwrap();
        let session = parse(&found[0]).unwrap();
        assert_eq!(session.native_id.as_deref(), Some(ROOT_ID));
        assert_eq!(session.title, "帮我把部署脚本改成幂等版本");
        assert_eq!(
            session.cwd.as_deref(),
            Some(r"C:\Users\example\agy-demo")
        );
        assert_eq!(session.model.as_deref(), Some("gemini-3-pro-preview"));
        let roles: Vec<&str> = session
            .messages
            .iter()
            .map(|message| message.role.as_str())
            .collect();
        // USER_INPUT/PLANNER_RESPONSE/AGENT_RESPONSE map to the timeline; the
        // undocumented TOOL_CALL row type stays out.
        assert_eq!(roles, vec!["user", "assistant", "assistant"]);
        assert!(session.messages.iter().all(|message| !message.text.is_empty()));
        assert_eq!(session.messages[0].timestamp, Some(1791000005000));
        // Two documented generations survive: the duplicate response_id row is
        // deduped, the two malformed rows skip with partial degradation, and
        // the stats-free row stays out silently.
        assert_eq!(session.usage.len(), 2, "{:?}", session.usage);
        assert!(session.partial, "malformed rows must degrade to partial");
        let first = &session.usage[0];
        assert_eq!(first.id, "resp_0001_agy_fixture");
        assert_eq!(first.model.as_deref(), Some("gemini-3-pro-preview"));
        // input_tokens counts only the uncached share; cache read/write are
        // explicit sibling fields.
        assert_eq!(first.input, Some(1_200));
        assert_eq!(first.cache_read, Some(8_000));
        assert_eq!(first.cache_write, Some(3_000));
        // output_tokens includes thinking (field 3 = field 9 + field 10).
        assert_eq!(first.output, Some(300));
        assert!(!first.input_includes_cache, "stored input excludes cache");
        assert_eq!(first.timestamp, Some(1791000010000));
        let second = &session.usage[1];
        assert_eq!(second.id, "resp_0002_agy_fixture");
        assert_eq!(second.input, Some(500));
        assert_eq!(second.output, Some(150));
        assert_eq!(second.cache_read, Some(0));
        assert_eq!(second.cache_write, Some(0));
        // Model display name (field 21) is the fallback when the config id is
        // absent.
        assert_eq!(second.model.as_deref(), Some("Gemini 3 Pro"));
        assert!(session.usage.iter().all(|event| event.request_count == Some(1)));
    }

    #[test]
    fn missing_or_unrecognized_index_yields_no_sources_or_errors() {
        let home = tempfile::tempdir().unwrap();
        assert!(sources(home.path()).unwrap().is_empty());
        let root = super::super::data_root(home.path());
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("conversation_summaries.db"), b"not a database").unwrap();
        assert!(sources(home.path()).is_err());
    }

    #[test]
    fn missing_usage_database_degrades_to_partial_without_usage() {
        let home = tempfile::tempdir().unwrap();
        write_fixture(home.path());
        let found = sources(home.path()).unwrap();
        std::fs::remove_file(conversation_db(
            &super::super::data_root(home.path()),
            ROOT_ID,
        ))
        .unwrap();
        let session = parse(&found[0]).unwrap();
        assert!(session.usage.is_empty());
        // The transcript still shows; the session is flagged partial because
        // its usage cannot be verified.
        assert_eq!(session.messages.len(), 3);
        assert!(session.partial);
    }

    #[test]
    fn parse_generation_rejects_schema_drift_strictly() {
        // output_tokens disagreeing with thinking + response is drift.
        let drifted = encode_well_formed_generation(&json!({
            "response_id": "resp_drift", "input_tokens": 10, "output_tokens": 9,
            "thinking_output_tokens": 4, "response_output_tokens": 6
        }));
        assert_eq!(parse_generation(&drifted), Err(Mismatch));
        // Missing response_id: no dedup key, no event.
        let no_id = encode_well_formed_generation(&json!({
            "input_tokens": 10, "output_tokens": 5
        }));
        assert_eq!(parse_generation(&no_id), Err(Mismatch));
        // A blob without the ChatModel wrapper is not a usage row.
        assert_eq!(parse_generation(&encode::varint_field(2, 7)), Ok(None));
        // Truncated and wrong-wire blobs fail as mismatches.
        let truncated = encode_well_formed_generation(&json!({
            "response_id": "resp_cut", "input_tokens": 10, "output_tokens": 5
        }));
        assert_eq!(
            parse_generation(&truncated[..truncated.len() - 3]),
            Err(Mismatch)
        );
    }
}
