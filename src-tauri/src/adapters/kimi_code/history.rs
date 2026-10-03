//! Kimi Code session indexing: `sessions/<workDirKey>/<sessionId>/state.json`
//! plus the append-only `agents/<agentId>/wire.jsonl` event streams. Field
//! shapes verified on the local 0.31.1 install: state.json carries title,
//! workDir and RFC3339 timestamps; the wire stream records user prompts as
//! `context.append_message`, assistant text as `content.part` loop events and
//! per-call token totals as `usage.record` with `inputOther`/`output`/
//! `inputCacheRead`/`inputCacheCreation` (cache buckets separate from input).

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::config_dir;
use crate::history::usage;
use crate::history::{
    check_cancelled, read_jsonl_controlled, source_fingerprint, source_fingerprint_controlled,
    text_content, timestamp, valid_native_id, HistorySource, ParsedSession, UsageEvent,
    MAX_SOURCES,
};

pub fn sources(home: &Path) -> Result<Vec<HistorySource>, String> {
    sources_with(home, source_fingerprint, &|| false)
}

pub fn sources_controlled(
    home: &Path,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<HistorySource>, String> {
    sources_with(
        home,
        |path| source_fingerprint_controlled(path, cancelled),
        cancelled,
    )
}

fn sources_with(
    home: &Path,
    fingerprint: impl Fn(&Path) -> Result<String, String>,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<HistorySource>, String> {
    check_cancelled(cancelled)?;
    let root = config_dir(home).join("sessions");
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut result = Vec::new();
    for work in fs::read_dir(&root).map_err(|error| error.to_string())? {
        check_cancelled(cancelled)?;
        let work = work.map_err(|error| error.to_string())?;
        if !work.file_type().map_err(|error| error.to_string())?.is_dir() {
            continue;
        }
        for session in fs::read_dir(work.path()).map_err(|error| error.to_string())? {
            check_cancelled(cancelled)?;
            let session = session.map_err(|error| error.to_string())?;
            let path = session.path();
            if !session.file_type().map_err(|error| error.to_string())?.is_dir() {
                continue;
            }
            let state = path.join("state.json");
            if !state.is_file() || state.is_symlink() {
                continue;
            }
            let mut parts = vec![fingerprint(&state)];
            for wire in agent_wires(&path, cancelled)? {
                parts.push(fingerprint(&wire));
            }
            let checked = parts
                .into_iter()
                .collect::<Result<Vec<_>, _>>()
                .map(|parts| parts.join("|"));
            let native_id = path
                .file_name()
                .and_then(|value| value.to_str())
                .filter(|id| valid_native_id(id))
                .map(str::to_owned);
            result.push(HistorySource {
                path,
                native_id,
                fingerprint: checked.as_ref().map(|value| value.as_str()).unwrap_or("").into(),
                fingerprint_error: checked.err(),
            });
            if result.len() > MAX_SOURCES {
                return Err("Kimi Code 会话源超过 5000 个，本次未删除旧索引".into());
            }
        }
    }
    Ok(result)
}

fn agent_wires(session: &Path, cancelled: &dyn Fn() -> bool) -> Result<Vec<PathBuf>, String> {
    check_cancelled(cancelled)?;
    let agents = session.join("agents");
    let mut wires = Vec::new();
    if !agents.is_dir() {
        return Ok(wires);
    }
    for agent in fs::read_dir(&agents).map_err(|error| error.to_string())? {
        let agent = agent.map_err(|error| error.to_string())?;
        if !agent.file_type().map_err(|error| error.to_string())?.is_dir() {
            continue;
        }
        let wire = agent.path().join("wire.jsonl");
        if wire.is_file() && !wire.is_symlink() {
            wires.push(wire);
        }
    }
    wires.sort();
    Ok(wires)
}

fn read_json(path: &Path) -> Result<Value, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.is_symlink() {
        return Err("Kimi Code 会话资料为链接".into());
    }
    if metadata.len() > 64 * 1024 * 1024 {
        return Err("Kimi Code 会话资料过大".into());
    }
    serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
        .map_err(|_| "Kimi Code 会话资料格式无法识别".into())
}

/// One assistant turn accumulates consecutive `content.part` events of the
/// same turnId so a segmented reply stays a single message.
struct AssistantTurn {
    turn: Option<String>,
    time: Option<i64>,
    text: String,
}

pub fn parse(source: &HistorySource) -> Result<ParsedSession, String> {
    parse_controlled(source, &|| false)
}

pub fn parse_controlled(
    source: &HistorySource,
    cancelled: &dyn Fn() -> bool,
) -> Result<ParsedSession, String> {
    check_cancelled(cancelled)?;
    let state = read_json(&source.path.join("state.json"))?;
    let mut session = ParsedSession::new();
    session.native_id = source.native_id.clone();
    session.title = state
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .chars()
        .take(96)
        .collect();
    session.cwd = state
        .get("workDir")
        .and_then(Value::as_str)
        .map(str::to_owned);
    session.started_at = state.get("createdAt").and_then(timestamp);
    session.updated_at = state.get("updatedAt").and_then(timestamp);
    for wire in agent_wires(&source.path, cancelled)? {
        check_cancelled(cancelled)?;
        let is_main = wire.parent().and_then(Path::file_name).and_then(|name| name.to_str())
            == Some("main");
        let wire_source = HistorySource {
            path: wire,
            native_id: None,
            fingerprint: String::new(),
            fingerprint_error: None,
        };
        let mut assistant_turns: Vec<AssistantTurn> = Vec::new();
        let mut usage_index = 0usize;
        let read = read_jsonl_controlled(&wire_source, cancelled, |line, row| {
            match row.get("type").and_then(Value::as_str) {
                // The user conversation lives in the main agent stream.
                Some("context.append_message") if is_main => {
                    let message = row.get("message").unwrap_or(&Value::Null);
                    if message.get("role").and_then(Value::as_str) == Some("user") {
                        let text = message
                            .get("content")
                            .map(text_content)
                            .unwrap_or_default();
                        session.add_message(
                            format!("line-{line}"),
                            "user",
                            text,
                            row.get("time").and_then(timestamp),
                        );
                    }
                }
                Some("context.append_loop_event") if is_main => {
                    let event = row.get("event").unwrap_or(&Value::Null);
                    if event.get("type").and_then(Value::as_str) == Some("content.part")
                        && event
                            .get("part")
                            .and_then(|part| part.get("type"))
                            .and_then(Value::as_str)
                            == Some("text")
                    {
                        let text = event
                            .get("part")
                            .and_then(|part| part.get("text"))
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        if text.trim().is_empty() {
                            return;
                        }
                        let turn = event
                            .get("turnId")
                            .and_then(Value::as_str)
                            .map(str::to_owned);
                        match assistant_turns.last_mut() {
                            Some(last) if last.turn == turn => last.text.push('\n'),
                            _ => assistant_turns.push(AssistantTurn {
                                turn,
                                time: row.get("time").and_then(timestamp),
                                text: String::new(),
                            }),
                        }
                        if let Some(last) = assistant_turns.last_mut() {
                            last.text.push_str(text);
                        }
                    }
                }
                // Usage records appear in every agent stream; subagent calls
                // belong to the session total. inputOther excludes the cache
                // buckets, so the event is recorded with a split breakdown.
                Some("usage.record") => {
                    let counts = usage::from_optional(
                        usage::field(row.get("usage").unwrap_or(&Value::Null), "inputOther"),
                        usage::field(row.get("usage").unwrap_or(&Value::Null), "output"),
                        usage::field(row.get("usage").unwrap_or(&Value::Null), "inputCacheRead"),
                        usage::field(
                            row.get("usage").unwrap_or(&Value::Null),
                            "inputCacheCreation",
                        ),
                    );
                    let Some(counts) = counts.filter(|counts| usage::active(*counts)) else {
                        return;
                    };
                    if session.model.is_none() {
                        session.model = row
                            .get("model")
                            .and_then(Value::as_str)
                            .map(str::to_owned);
                    }
                    session.usage.push(UsageEvent {
                        id: format!("{}:usage-{usage_index}", source.key()),
                        model: row.get("model").and_then(Value::as_str).map(str::to_owned),
                        timestamp: row.get("time").and_then(timestamp),
                        input: Some(counts.input),
                        output: Some(counts.output),
                        cache_read: Some(counts.read),
                        cache_write: Some(counts.write),
                        input_includes_cache: false,
                    });
                    usage_index += 1;
                }
                _ => {}
            }
        });
        match read {
            Ok(partial) => session.partial |= partial,
            Err(_) => session.partial = true,
        }
        for (index, turn) in assistant_turns.into_iter().enumerate() {
            session.add_message(
                format!("{}:assistant-{index}", wire_source.key()),
                "assistant",
                turn.text,
                turn.time,
            );
        }
    }
    check_cancelled(cancelled)?;
    session.finish(source)
}

#[cfg(test)]
mod tests {
    use super::*;

    const WIRE_FIXTURE: &str =
        include_str!("../../../../tests/fixtures/history/kimi-code-0.31.1-wire.jsonl");

    fn session_tree(root: &Path) -> PathBuf {
        let session = root
            .join(".kimi-code/sessions")
            .join("wd_example_000000000000")
            .join("session_930b8796-7d77-4e70-a8ba-6209ff1272e8");
        std::fs::create_dir_all(session.join("agents/main")).unwrap();
        std::fs::write(
            session.join("state.json"),
            r#"{"createdAt":"2026-08-02T03:22:11.567Z","updatedAt":"2026-08-02T03:25:41.000Z","title":"帮我把示例项目整理成两个目录","isCustomTitle":false,"agents":{"main":{"type":"main","parentAgentId":null}},"custom":{},"workDir":"C:/Users/example/project"}"#,
        )
        .unwrap();
        std::fs::write(session.join("agents/main/wire.jsonl"), WIRE_FIXTURE).unwrap();
        session
    }

    #[test]
    fn sources_discover_state_sessions_under_the_kimi_root() {
        let temp = tempfile::tempdir().unwrap();
        assert!(sources(temp.path()).unwrap().is_empty());
        let session = session_tree(temp.path());
        // A directory without state.json is not a session.
        std::fs::create_dir_all(
            temp.path()
                .join(".kimi-code/sessions/wd_example_000000000000/bare-dir"),
        )
        .unwrap();
        let found = sources(temp.path()).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, session);
        assert_eq!(
            found[0].native_id.as_deref(),
            Some("session_930b8796-7d77-4e70-a8ba-6209ff1272e8")
        );
        assert!(found[0].fingerprint.contains('|'), "指纹应覆盖 state 与 wire 文件");
        assert!(found[0].fingerprint_error.is_none());
    }

    #[test]
    fn wire_fixture_parses_messages_and_split_token_usage() {
        let temp = tempfile::tempdir().unwrap();
        let session = session_tree(temp.path());
        let source = sources(temp.path()).unwrap().remove(0);
        assert_eq!(source.path, session);
        let parsed = parse(&source).unwrap();
        assert_eq!(
            parsed.native_id.as_deref(),
            Some("session_930b8796-7d77-4e70-a8ba-6209ff1272e8")
        );
        assert_eq!(parsed.cwd.as_deref(), Some("C:/Users/example/project"));
        assert!(parsed.title.contains("示例项目"));
        assert_eq!(parsed.model.as_deref(), Some("kimi-code/k3"));
        assert_eq!(parsed.messages.len(), 3, "{:?}", parsed.messages);
        assert_eq!(parsed.messages[0].role, "user");
        assert_eq!(parsed.messages[1].role, "assistant");
        assert!(
            parsed.messages[1].text.contains("我先查看目录结构")
                && parsed.messages[1].text.contains("已完成整理"),
            "同回合的分段回复应合并为一条：{:?}",
            parsed.messages[1].text
        );
        assert_eq!(parsed.messages[2].role, "assistant");
        assert_eq!(parsed.usage.len(), 2);
        let first = &parsed.usage[0];
        assert_eq!(first.input, Some(13976));
        assert_eq!(first.output, Some(327));
        assert_eq!(first.cache_read, Some(10496));
        assert_eq!(first.cache_write, Some(0));
        assert!(!first.input_includes_cache);
        assert_eq!(first.model.as_deref(), Some("kimi-code/k3"));
        assert!(first.timestamp.is_some());
        let total: u64 = parsed.usage.iter().map(|event| event.input.unwrap_or(0)).sum();
        assert_eq!(total, 13976 + 1104);
    }

    #[test]
    fn missing_agents_directory_still_finishes_the_session() {
        let temp = tempfile::tempdir().unwrap();
        let session = session_tree(temp.path());
        std::fs::remove_dir_all(session.join("agents")).unwrap();
        let source = sources(temp.path()).unwrap().remove(0);
        let parsed = parse(&source).unwrap();
        assert!(parsed.messages.is_empty() && parsed.usage.is_empty());
        assert_eq!(
            parsed.native_id.as_deref(),
            Some("session_930b8796-7d77-4e70-a8ba-6209ff1272e8")
        );
    }
}
