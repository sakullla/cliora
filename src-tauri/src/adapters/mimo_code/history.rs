//! MiMo Code session sources: the single SQLite store `mimocode.db`.
//!
//! [src] Evidence: XiaomiMiMo/MiMo-Code 0.1.15
//! `packages/cli/src/storage/schema.ts` + `session/session.sql.ts`
//! (`session`/`message`/`part` tables), `session/session.ts` (`fromRow`,
//! root sessions are `parent_id IS NULL`; child sessions exist only for peer
//! actor subagents, the checkpoint-writer host and the `/ask` fork-query host —
//! `Session.fork` does NOT set `parent_id`) and `session/message-v2.ts`
//! (`message.data` JSON: role/modelID/providerID/agent/cost and
//! `tokens{total?,input,output,reasoning,cache{read,write}}`).
//!
//! Usage semantics, pinned by `session/processor.ts` (`stepTokensIn =
//! tokens.input + tokens.cache.read + tokens.cache.write`) and
//! `session/session.ts getUsage` (`adjustedInputTokens = inputTokens −
//! cacheRead − cacheWrite`; `output = outputTokens − reasoningTokens`):
//!
//! * stored `tokens.input` EXCLUDES cache read/write → `input_includes_cache`
//!   is false on every event;
//! * stored `tokens.output` EXCLUDES reasoning; both are generated tokens and
//!   are summed through `usage::generated`, matching the shared OpenCode
//!   normalization;
//! * `message.data.cost` accumulates the per-step provider cost of the message
//!   (provider price table × token split). The shared `UsageEvent` contract has
//!   no cost channel, so cost is verified in the module tests and deliberately
//!   not surfaced into the usage pipeline;
//! * `step-finish` parts repeat the message's token object; parts never
//!   contribute usage, each assistant message row is one billed call.
//!
//! Attribution: `message.agent_id` (column, default "main") tags in-session
//! subagent calls; child sessions (`session.parent_id`) fold their billed
//! messages into the parent session's usage while their transcripts stay with
//! the child (root transcripts only). The database is opened read-only and any
//! schema drift fails that session as a parse error instead of guessing.

use std::collections::HashMap;
use std::path::Path;

use rusqlite::{Connection, OpenFlags};
use serde_json::Value;

use crate::history::usage;
use crate::history::{
    check_cancelled, text_content, valid_native_id, HistorySource, ParsedSession, UsageEvent,
    MAX_SOURCES,
};

pub fn sources(home: &Path) -> Result<Vec<HistorySource>, String> {
    sources_controlled(home, &|| false)
}

pub fn sources_controlled(
    home: &Path,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<HistorySource>, String> {
    check_cancelled(cancelled)?;
    let path = super::data_root(home).join("mimocode.db");
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let connection = open(&path)?;
    let mut sources = Vec::new();
    // Root sessions only: child rows are peer actor hosts folded into their
    // parent below, never listed as independent conversations.
    let mut statement = connection
        .prepare(
            "SELECT id, json_array(id, project_id, parent_id, directory, title, version,
                                    time_created, time_updated)
             FROM session WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT ?1",
        )
        .map_err(|error| format!("MiMo Code 会话库结构无法识别：{error}"))?;
    let rows = statement
        .query_map([MAX_SOURCES as i64 + 1], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut hashes = std::collections::BTreeMap::<String, (u64, [u8; 16])>::new();
    for row in rows {
        check_cancelled(cancelled)?;
        let (id, metadata) = row.map_err(|error| error.to_string())?;
        if valid_native_id(&id) {
            if hashes.len() >= MAX_SOURCES {
                return Err("MiMo Code 会话源超过 5000 个，本次未删除旧索引".into());
            }
            let hash = md5_hex(metadata.as_bytes());
            hashes.insert(id, (0, hash));
        }
    }
    drop(statement);
    // Fold message digests into the owning root session (a session and its
    // direct children share one fingerprint) so a change to one conversation
    // never reparses the others.
    let mut statement = connection
        .prepare(
            "SELECT s.parent_id, m.session_id, json_array(m.id, m.agent_id, m.data, m.time_created)
             FROM message m JOIN session s ON s.id = m.session_id
             ORDER BY m.session_id, m.time_created, m.id",
        )
        .map_err(|error| format!("MiMo Code 会话库结构无法识别：{error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    for row in rows {
        check_cancelled(cancelled)?;
        let (parent, session, digest) = row.map_err(|error| error.to_string())?;
        let owner = parent.unwrap_or(session);
        if let Some((count, hash)) = hashes.get_mut(&owner) {
            *count += 1;
            for (slot, byte) in hash.iter_mut().zip(md5_hex(digest.as_bytes())) {
                *slot ^= byte;
            }
        }
    }
    drop(statement);
    for (id, (count, hash)) in hashes {
        sources.push(HistorySource {
            native_title: None,
            path: path.clone(),
            native_id: Some(id),
            fingerprint: format!("mimo-session-v1|{count}|{}", hex(&hash)),
            fingerprint_error: None,
        });
    }
    Ok(sources)
}

fn open(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("MiMo Code 会话库无法只读打开：{error}"))?;
    connection
        .busy_timeout(std::time::Duration::from_millis(500))
        .map_err(|error| error.to_string())?;
    let tables = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('session','message','part')",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("MiMo Code 会话库结构无法识别：{error}"))?;
    if tables != 3 {
        return Err("MiMo Code 会话库缺少 session/message/part 表".into());
    }
    Ok(connection)
}

fn md5_hex(bytes: &[u8]) -> [u8; 16] {
    // A stable, dependency-free digest is enough here: the fingerprint only
    // needs to change when the underlying rows change, not to resist attacks.
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
        .ok_or("MiMo Code 会话缺少 id")?;
    let connection = open(&source.path)?;
    let (title, directory, created, updated): (String, Option<String>, Option<i64>, Option<i64>) =
        connection
            .query_row(
                "SELECT title, directory, time_created, time_updated FROM session WHERE id = ?1 AND parent_id IS NULL",
                [&id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                    ))
                },
            )
            .map_err(|_| "MiMo Code 会话行缺失或结构变化".to_string())?;
    let mut session = ParsedSession::new();
    session.native_id = Some(id.clone());
    if !title.trim().is_empty() {
        session.title = title.chars().take(96).collect();
    }
    session.cwd = directory.filter(|directory| !directory.trim().is_empty());
    session.started_at = created;
    session.updated_at = updated;
    // Root session plus direct children (peer actor subagents). One billed
    // assistant message row is one usage event; the message primary key is
    // globally unique so parent and child events never collide.
    let mut statement = connection
        .prepare(
            "SELECT m.id, m.agent_id, m.data, m.time_created
             FROM message m
             WHERE m.session_id = ?1 OR m.session_id IN
                   (SELECT id FROM session WHERE parent_id = ?1)
             ORDER BY m.time_created, m.id",
        )
        .map_err(|_| "MiMo Code 会话库 message 结构变化".to_string())?;
    let rows = statement
        .query_map([&id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<i64>>(3)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut roles = HashMap::<String, (String, Option<i64>)>::new();
    for row in rows {
        check_cancelled(cancelled)?;
        let (message_id, _agent_id, data, time) = row.map_err(|error| error.to_string())?;
        let Ok(message) = serde_json::from_str::<Value>(&data) else {
            session.partial = true;
            continue;
        };
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        // agent_id attribution: the column (default "main") names the actor
        // that produced the row — "main" for the primary line, the subagent
        // name for actor calls. In-session subagent rows and folded child rows
        // both count as billed calls of this conversation.
        if role == "user" || role == "assistant" {
            roles.insert(message_id.clone(), (role.clone(), time));
        }
        if role != "assistant" {
            continue;
        }
        let model = message
            .get("modelID")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_owned);
        if model.is_some() {
            session.model.clone_from(&model);
        }
        let Some(tokens) = message.get("tokens") else {
            continue;
        };
        let cache = tokens.get("cache").unwrap_or(&Value::Null);
        let Some(counts) = usage::from_optional(
            usage::field(tokens, "input"),
            usage::generated(usage::field(tokens, "output"), usage::field(tokens, "reasoning")),
            usage::field(cache, "read"),
            usage::field(cache, "write"),
        ) else {
            continue;
        };
        if !usage::active(counts) {
            continue;
        }
        // message.data.cost (per-message provider cost accumulation) has no
        // channel in the shared UsageEvent contract; see the module docs.
        session.usage.push(UsageEvent {
            request_count: Some(1),
            id: message_id,
            model,
            timestamp: time,
            input: Some(counts.input),
            output: Some(counts.output),
            cache_read: Some(counts.read),
            cache_write: Some(counts.write),
            // Verified source semantics: stored input already excludes cache.
            input_includes_cache: false,
        });
    }
    drop(statement);
    // Transcript from the root session's parts only; child transcripts stay
    // with their actor hosts. Non-text parts (including step-finish rows that
    // repeat token counters) never enter the transcript or the usage.
    let mut statement = connection
        .prepare(
            "SELECT id, message_id, data, time_created FROM part WHERE session_id = ?1
             ORDER BY time_created, id LIMIT 4001",
        )
        .map_err(|_| "MiMo Code 会话库 part 结构变化".to_string())?;
    let rows = statement
        .query_map([&id], |row| {
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

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    /// Sanitized row set desensitized from the 0.1.15 schema: same tables and
    /// column shapes, rewritten ids/titles/directories/counts. The synthetic
    /// `mimocode.db` is rebuilt deterministically from this fixture in every
    /// test run (zcode's in-test database pattern; no committed binary).
    const ROWS_FIXTURE: &str =
        include_str!("../../../../tests/fixtures/history/mimo-code-0.1.15/sessions.json");

    fn write_database(path: &std::path::Path) {
        let rows: Value = serde_json::from_str(ROWS_FIXTURE).unwrap();
        let connection = Connection::open(path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE session (
                    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT,
                    parent_id TEXT, context_from TEXT, context_watermark TEXT,
                    slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL,
                    title_source TEXT NOT NULL DEFAULT 'user', title_revision INTEGER NOT NULL DEFAULT 0,
                    version TEXT NOT NULL, share_url TEXT, summary_additions INTEGER,
                    summary_deletions INTEGER, summary_files INTEGER, summary_diffs TEXT,
                    revert TEXT, permission TEXT, prompt TEXT,
                    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
                    time_compacting INTEGER, time_archived INTEGER,
                    last_checkpoint_message_id TEXT, auto_worktree_hint_sent INTEGER);
                 CREATE TABLE message (
                    id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
                    agent_id TEXT NOT NULL DEFAULT 'main',
                    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
                    data TEXT NOT NULL);
                 CREATE TABLE part (
                    id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
                    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
                    data TEXT NOT NULL);",
            )
            .unwrap();
        for row in rows["sessions"].as_array().unwrap() {
            connection
                .execute(
                    "INSERT INTO session (id, project_id, parent_id, slug, directory, title, version,
                                          time_created, time_updated)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![
                        row["id"].as_str().unwrap(),
                        row["project_id"].as_str().unwrap(),
                        row["parent_id"].as_str(),
                        row["slug"].as_str().unwrap(),
                        row["directory"].as_str().unwrap(),
                        row["title"].as_str().unwrap(),
                        row["version"].as_str().unwrap(),
                        row["time_created"].as_i64().unwrap(),
                        row["time_updated"].as_i64().unwrap(),
                    ],
                )
                .unwrap();
        }
        for row in rows["messages"].as_array().unwrap() {
            connection
                .execute(
                    "INSERT INTO message (id, session_id, agent_id, time_created, time_updated, data)
                     VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                    params![
                        row["id"].as_str().unwrap(),
                        row["session_id"].as_str().unwrap(),
                        row["agent_id"].as_str().unwrap(),
                        row["time_created"].as_i64().unwrap(),
                        row["data"].to_string(),
                    ],
                )
                .unwrap();
        }
        for row in rows["parts"].as_array().unwrap() {
            connection
                .execute(
                    "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
                     VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                    params![
                        row["id"].as_str().unwrap(),
                        row["message_id"].as_str().unwrap(),
                        row["session_id"].as_str().unwrap(),
                        row["time_created"].as_i64().unwrap(),
                        row["data"].to_string(),
                    ],
                )
                .unwrap();
        }
    }

    #[test]
    fn fixture_database_lists_root_sessions_with_fingerprinted_sources() {
        let home = tempfile::tempdir().unwrap();
        let database = super::super::data_root(home.path()).join("mimocode.db");
        std::fs::create_dir_all(database.parent().unwrap()).unwrap();
        write_database(&database);
        let sources = sources(home.path()).unwrap();
        // Only the root session is a source; the actor child and the fork-style
        // session (which sets no parent) would both fold/list accordingly.
        assert_eq!(sources.len(), 1, "{sources:?}");
        assert_eq!(
            sources[0].native_id.as_deref(),
            Some("ses_root_2026_10_05_a1b2c3d4e5f6g7h8i9j0k1l2m")
        );
        assert!(sources[0].fingerprint.starts_with("mimo-session-v1|"));
        let before = sources[0].fingerprint.clone();
        // A new billed message in the child session changes the parent fingerprint.
        let connection = Connection::open(&database).unwrap();
        connection
            .execute(
                "INSERT INTO message (id, session_id, agent_id, time_created, time_updated, data)
                 VALUES ('msg_child_extra_0000000000000000', 'ses_actor_2026_10_05_z9y8x7w6v5u4t3s2r1q0p1o2n',
                         'explore', 1791000300000, 1791000300000,
                         '{\"role\":\"assistant\",\"modelID\":\"mimo-v2.5\",\"tokens\":{\"input\":11,\"output\":2,\"reasoning\":0,\"cache\":{\"read\":0,\"write\":0}},\"cost\":0.0001}')",
                [],
            )
            .unwrap();
        drop(connection);
        let after = super::sources(home.path()).unwrap();
        assert_ne!(before, after[0].fingerprint);
    }

    #[test]
    fn root_session_parses_identity_transcript_and_split_token_usage() {
        let home = tempfile::tempdir().unwrap();
        let database = super::super::data_root(home.path()).join("mimocode.db");
        std::fs::create_dir_all(database.parent().unwrap()).unwrap();
        write_database(&database);
        let sources = sources(home.path()).unwrap();
        let session = parse(&sources[0]).unwrap();
        assert_eq!(
            session.native_id.as_deref(),
            Some("ses_root_2026_10_05_a1b2c3d4e5f6g7h8i9j0k1l2m")
        );
        assert_eq!(session.title, "帮我把构建脚本改成跨平台版本");
        assert_eq!(
            session.cwd.as_deref(),
            Some(r"C:\Users\example\mimo-demo")
        );
        assert_eq!(session.started_at, Some(1791000000000));
        assert_eq!(session.updated_at, Some(1791000900000));
        assert_eq!(session.model.as_deref(), Some("mimo-v2.5"));
        let roles: Vec<&str> = session
            .messages
            .iter()
            .map(|message| message.role.as_str())
            .collect();
        // Root transcript keeps the main line and the in-session subagent turn;
        // only the actor child's transcript stays out of the timeline.
        assert_eq!(roles, vec!["user", "assistant", "assistant", "assistant"]);
        assert_eq!(session.messages.len(), 4);
        assert!(session.messages.iter().all(|message| !message.text.is_empty()));
        // 3 root assistant calls (main, in-session subagent, main) + 1 folded
        // child-session call = 4 billed events, in time order.
        assert_eq!(session.usage.len(), 4, "{:?}", session.usage);
        let first = &session.usage[0];
        assert_eq!(first.model.as_deref(), Some("mimo-v2.5"));
        assert_eq!(first.input, Some(1_200));
        // output 288 + reasoning 12 = 300 generated tokens.
        assert_eq!(first.output, Some(300));
        assert_eq!(first.cache_read, Some(0));
        assert_eq!(first.cache_write, Some(0));
        assert!(!first.input_includes_cache, "stored input excludes cache");
        // In-session subagent turn (message.agent_id = "explore").
        assert_eq!(session.usage[1].input, Some(200));
        assert_eq!(session.usage[1].output, Some(50));
        let third = &session.usage[2];
        assert_eq!(third.input, Some(500));
        assert_eq!(third.output, Some(120));
        assert_eq!(third.cache_read, Some(8_000));
        assert_eq!(third.cache_write, Some(3_000));
        assert!(!third.input_includes_cache);
        // Fresh input (uncached share) is input alone; the report derives
        // cache-exclusive buckets from input_includes_cache=false.
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
        assert_eq!(totals, (1_911, 472, 8_000, 3_000));
        // Cost stays off the shared pipeline: no UsageEvent field carries it.
        assert!(session.usage.iter().all(|event| event.request_count == Some(1)));
    }

    #[test]
    fn step_finish_parts_repeat_tokens_but_never_double_count() {
        let home = tempfile::tempdir().unwrap();
        let database = super::super::data_root(home.path()).join("mimocode.db");
        std::fs::create_dir_all(database.parent().unwrap()).unwrap();
        write_database(&database);
        let sources = sources(home.path()).unwrap();
        let session = parse(&sources[0]).unwrap();
        // The fixture's step-finish part carries the same token object as the
        // assistant message; usage events come only from message rows.
        assert_eq!(session.usage.len(), 4);
        assert_eq!(session.messages.len(), 4);
    }

    #[test]
    fn missing_or_unrecognized_database_yields_no_sources() {
        let home = tempfile::tempdir().unwrap();
        assert!(sources(home.path()).unwrap().is_empty());
        let database = super::super::data_root(home.path()).join("mimocode.db");
        std::fs::create_dir_all(database.parent().unwrap()).unwrap();
        std::fs::write(&database, b"not a sqlite database").unwrap();
        assert!(sources(home.path()).is_err());
    }

    #[test]
    fn md5_hex_is_stable_for_identical_rows() {
        assert_eq!(md5_hex(b"abc"), md5_hex(b"abc"));
        assert_ne!(md5_hex(b"abc"), md5_hex(b"abd"));
    }
}
