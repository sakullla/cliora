//! Kimi Code session indexing: `sessions/<workDirKey>/<sessionId>/state.json`
//! plus the append-only `agents/<agentId>/wire.jsonl` event streams. Field
//! shapes verified on the local 0.31.1 install: state.json carries title,
//! workDir (`cwd` in older schemas) and RFC3339 timestamps; the wire stream
//! records user prompts as
//! `context.append_message`, assistant text as `content.part` loop events and
//! per-call token totals as `usage.record` with `inputOther`/`output`/
//! `inputCacheRead`/`inputCacheCreation` (cache buckets separate from input).

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::config_dir;
use crate::history::usage;
use crate::history::{
    check_cancelled, read_jsonl_filtered, source_fingerprint, source_fingerprint_controlled,
    text_content, timestamp, valid_native_id, AgentKind, ChildSession, HistoryMessage,
    HistoryMessageKind, HistorySource, MessageTimeSource, ParsedSession, UsageAttribution,
    UsageEvent, MAX_SOURCES,
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
            // Adapter-local parser version: existing indexes are rebuilt once
            // per parser change even when the native files themselves have not
            // changed.
            let checked = parts
                .into_iter()
                .collect::<Result<Vec<_>, _>>()
                .map(|parts| format!("kimi-session-v4|{}", parts.join("|")));
            let native_id = path
                .file_name()
                .and_then(|value| value.to_str())
                .filter(|id| valid_native_id(id))
                .map(str::to_owned);
            result.push(HistorySource { native_title: None,
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

/// Verified wires have no agent display name. The directory name stays a path key only.
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

fn agent_attribution(main: bool, child_key: Option<&str>) -> Vec<UsageAttribution> {
    vec![UsageAttribution {
        kind: if main { AgentKind::Main } else { AgentKind::Subagent },
        name: None,
        session_key: child_key.map(str::to_owned),
    }]
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
    // Older state.json schema recorded the working directory as `cwd` before
    // the field was renamed to `workDir`; both shapes are accepted so legacy
    // sessions do not list as unattributed.
    session.cwd = state
        .get("workDir")
        .and_then(Value::as_str)
        .or_else(|| state.get("cwd").and_then(Value::as_str))
        .filter(|cwd| !cwd.trim().is_empty())
        .map(str::to_owned);
    session.started_at = state.get("createdAt").and_then(timestamp);
    session.updated_at = state.get("updatedAt").and_then(timestamp);
    for wire in agent_wires(&source.path, cancelled)? {
        check_cancelled(cancelled)?;
        let agent_dir = wire
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str());
        let is_main = agent_dir == Some("main");
        // Non-main wires are direct children. parentAgentId is not a verified link.
        let child_key = agent_dir
            .filter(|_| !is_main)
            .map(|name| format!("agents/{name}"));
        let wire_source = HistorySource { native_title: None,
            path: wire,
            native_id: None,
            fingerprint: String::new(),
            fingerprint_error: None,
        };
        let mut assistant_turns: Vec<AssistantTurn> = Vec::new();
        let mut child_messages: Vec<HistoryMessage> = Vec::new();
        let mut usage_index = 0usize;
        let read = read_jsonl_filtered(&wire_source, cancelled, |prefix| {
            // Skip the known repeated request/context snapshots before JSON
            // allocation; unknown and differently formatted rows still parse.
            let prefix = prefix.trim_ascii_start();
            let kind = prefix.strip_prefix(b"{\"type\":\"")
                .and_then(|rest| rest.split(|byte| *byte == b'"').next());
            matches!(kind, Some(b"llm.request" | b"llm.tools_snapshot" | b"mcp.tools_discovered"))
        }, |line, row| {
            match row.get("type").and_then(Value::as_str) {
                Some("profile.bind" | "config.update") if session.model.is_none() => {
                    session.model = row.get("modelAlias").or_else(|| row.get("model"))
                        .and_then(Value::as_str).map(str::to_owned);
                }
                // Parent transcript is the main agent stream. Other streams stay on the child.
                Some("context.append_message") => {
                    let message = row.get("message").unwrap_or(&Value::Null);
                    if message.get("role").and_then(Value::as_str) == Some("user") {
                        let text = message
                            .get("content")
                            .map(text_content)
                            .unwrap_or_default();
                        let id = format!("line-{line}");
                        let time = row.get("time").and_then(timestamp);
                        if is_main {
                            session.add_message(id, "user", text, time);
                        } else if child_key.is_some() {
                            push_child_message(&mut child_messages, id, "user", text, time);
                        }
                    }
                }
                Some("context.append_loop_event") => {
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
                // No native request id: each usage.record stays its own event.
                // inputOther excludes the cache buckets.
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
                    // Wire-scoped ids: history_usage keys on (session_id,
                    // event_id) with INSERT OR REPLACE, so a session-level id
                    // would let one agent stream silently overwrite another's
                    // token events.
                    session.usage.push(UsageEvent { native_usage: None,
                        request_count: Some(1),
                        id: format!("{}:usage-{usage_index}", wire_source.key()),
                        model: row.get("model").and_then(Value::as_str).map(str::to_owned),
                        timestamp: row.get("time").and_then(timestamp),
                        input: Some(counts.input),
                        output: Some(counts.output),
                        cache_read: Some(counts.read),
                        cache_write: Some(counts.write),
                        input_includes_cache: false,
                        attributions: agent_attribution(is_main, child_key.as_deref()),
                    });
                    usage_index += 1;
                }
                _ => {}
            }
        });
        let readable = match read {
            Ok(partial) => {
                session.partial |= partial;
                true
            }
            Err(_) => {
                session.partial = true;
                false
            }
        };
        if is_main {
            for (index, turn) in assistant_turns.into_iter().enumerate() {
                session.add_message(
                    format!("{}:assistant-{index}", wire_source.key()),
                    "assistant",
                    turn.text,
                    turn.time,
                );
            }
        } else if let Some(key) = child_key {
            if readable {
                for (index, turn) in assistant_turns.into_iter().enumerate() {
                    push_child_message(
                        &mut child_messages,
                        format!("{}:assistant-{index}", wire_source.key()),
                        "assistant",
                        turn.text,
                        turn.time,
                    );
                }
            } else {
                child_messages.clear();
            }
            session.children.push(ChildSession {
                key,
                name: None,
                messages: child_messages,
                readable,
                children: Vec::new(),
            });
        }
    }
    check_cancelled(cancelled)?;
    session.finish(source)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::AgentKind;

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
        assert!(parsed.children.is_empty());
        assert!(parsed.usage.iter().all(|event| {
            event.attributions.len() == 1
                && event.attributions[0].kind == AgentKind::Main
                && event.attributions[0].name.is_none()
                && event.attributions[0].session_key.is_none()
        }));
    }

    #[test]
    fn subagent_wire_usage_events_keep_distinct_ids_and_join_the_total() {
        let temp = tempfile::tempdir().unwrap();
        let session = session_tree(temp.path());
        std::fs::create_dir_all(session.join("agents/researcher")).unwrap();
        std::fs::write(
            session.join("agents/researcher/wire.jsonl"),
            concat!(
                "{\"type\":\"context.append_message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"子代理检索输入\"}]},\"time\":\"2026-08-02T03:23:00.000Z\"}\n",
                "{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"content.part\",\"turnId\":\"0\",\"part\":{\"type\":\"text\",\"text\":\"子代理检索结论\"}},\"time\":\"2026-08-02T03:23:30.000Z\"}\n",
                "{\"type\":\"usage.record\",\"time\":\"2026-08-02T03:24:00.000Z\",\"model\":\"kimi-code/k3\",\"usage\":{\"inputOther\":42,\"output\":7,\"inputCacheRead\":0,\"inputCacheCreation\":0}}\n",
                "{\"type\":\"usage.record\",\"time\":\"2026-08-02T03:24:05.000Z\",\"model\":\"kimi-code/k3\",\"usage\":{\"inputOther\":8,\"output\":1,\"inputCacheRead\":0,\"inputCacheCreation\":0}}\n",
            ),
        )
        .unwrap();
        let source = sources(temp.path()).unwrap().remove(0);
        let parsed = parse(&source).unwrap();
        // The main fixture wire contributes two usage events. Each subagent
        // record stays beside them; nothing merges on a missing request id.
        assert_eq!(parsed.usage.len(), 4, "{:?}", parsed.usage);
        let mut ids: Vec<&str> = parsed
            .usage
            .iter()
            .map(|event| event.id.as_str())
            .collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), parsed.usage.len(), "多 agent 流 usage 事件 id 不得冲突");
        let total: u64 = parsed.usage.iter().map(|event| event.input.unwrap_or(0)).sum();
        assert_eq!(total, 13976 + 1104 + 42 + 8, "子代理 token 应计入会话总量");
        assert!(parsed.messages.iter().all(|message| !message.text.contains("子代理")));
        assert_eq!(parsed.children.len(), 1);
        let child = &parsed.children[0];
        assert_eq!(child.key, "agents/researcher");
        assert!(child.name.is_none(), "目录名不是已核对的显示名");
        assert!(child.readable);
        assert!(child.children.is_empty());
        let child_text: Vec<&str> = child.messages.iter().map(|message| message.text.as_str()).collect();
        assert_eq!(child_text, vec!["子代理检索输入", "子代理检索结论"]);
        let sub: Vec<_> = parsed
            .usage
            .iter()
            .filter(|event| event.attributions.iter().any(|item| item.kind == AgentKind::Subagent))
            .collect();
        assert_eq!(sub.len(), 2);
        assert!(sub.iter().all(|event| {
            event.attributions.len() == 1
                && event.attributions[0].name.is_none()
                && event.attributions[0].session_key.as_deref() == Some("agents/researcher")
        }));
        assert_ne!(sub[0].id, sub[1].id);
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

    #[test]
    fn legacy_state_schema_cwd_field_still_attributes_the_project() {
        let temp = tempfile::tempdir().unwrap();
        let session = session_tree(temp.path());
        std::fs::write(
            session.join("state.json"),
            r#"{"id":"session_930b8796-7d77-4e70-a8ba-6209ff1272e8","version":1,"cwd":"C:/Legacy/project","createdAt":"2026-08-02T03:22:11.567Z","updatedAt":"2026-08-02T03:25:41.000Z","archived":false,"agents":{},"custom":{}}"#,
        )
        .unwrap();
        let source = sources(temp.path()).unwrap().remove(0);
        assert!(source.fingerprint.starts_with("kimi-session-v4|"));
        let parsed = parse(&source).unwrap();
        assert_eq!(parsed.cwd.as_deref(), Some("C:/Legacy/project"));
    }
}
