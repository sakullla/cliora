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
            let native_id = path
                .file_name()
                .and_then(|value| value.to_str())
                .filter(|id| valid_native_id(id))
                .map(str::to_owned);
            // state.json and agents/main/wire.jsonl are the parent material.
            // A main-wire stamp or read failure is this session's fingerprint
            // error so the scan does not replace a stored parent with an empty
            // one. Child wires and agents listing failures stay in the stamp.
            // Cancellation still stops the scan.
            let source = match fingerprint(&state) {
                Ok(state_stamp) => {
                    let mut parts = vec![state_stamp];
                    let loaded = match load_agent_wires(&path, cancelled) {
                        Ok(loaded) => loaded,
                        Err(error) if cancelled() || scan_cancelled(&error) => return Err(error),
                        Err(error) => {
                            result.push(HistorySource {
                                native_title: None,
                                path,
                                native_id,
                                fingerprint: String::new(),
                                fingerprint_error: Some(error),
                            });
                            if result.len() > MAX_SOURCES {
                                return Err("Kimi Code 会话源超过 5000 个，本次未删除旧索引".into());
                            }
                            continue;
                        }
                    };
                    let (wires, unlistable) = loaded;
                    let mut parent_error = None;
                    for wire in &wires {
                        if is_main_wire(wire) {
                            match parent_wire_stamp(wire, &fingerprint, cancelled) {
                                Ok(stamp) => parts.push(stamp),
                                Err(error) if cancelled() || scan_cancelled(&error) => return Err(error),
                                Err(error) => {
                                    parent_error = Some(error);
                                    break;
                                }
                            }
                        } else {
                            parts.push(wire_stamp(wire, &fingerprint, cancelled)?);
                        }
                    }
                    if unlistable {
                        parts.push(format!(
                            "children-unread:{}",
                            unread_material_stamp(&path.join("agents"))
                        ));
                    }
                    if let Some(error) = parent_error {
                        HistorySource {
                            native_title: None,
                            path,
                            native_id,
                            fingerprint: String::new(),
                            fingerprint_error: Some(error),
                        }
                    } else {
                        HistorySource {
                            native_title: None,
                            path,
                            native_id,
                            fingerprint: format!("kimi-session-v4|{}", parts.join("|")),
                            fingerprint_error: None,
                        }
                    }
                }
                Err(error) if cancelled() || scan_cancelled(&error) => return Err(error),
                Err(error) => HistorySource {
                    native_title: None,
                    path,
                    native_id,
                    fingerprint: String::new(),
                    fingerprint_error: Some(error),
                },
            };
            result.push(source);
            if result.len() > MAX_SOURCES {
                return Err("Kimi Code 会话源超过 5000 个，本次未删除旧索引".into());
            }
        }
    }
    Ok(result)
}

struct AgentListing {
    wires: Vec<PathBuf>,
    unlistable: bool,
}

fn main_wire_path(session: &Path) -> PathBuf {
    session.join("agents").join("main").join("wire.jsonl")
}

fn is_main_wire(path: &Path) -> bool {
    path.file_name().and_then(|name| name.to_str()) == Some("wire.jsonl")
        && path
            .parent()
            .and_then(|dir| dir.file_name())
            .and_then(|name| name.to_str())
            == Some("main")
}

/// `Ok(false)` is a missing path or a non-file. Stat failures of `agents/main/wire.jsonl`
/// are parent-material failures: the scan must not commit an empty parent.
fn regular_file(path: &Path, cancelled: &dyn Fn() -> bool) -> Result<bool, String> {
    check_cancelled(cancelled)?;
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) if cancelled() || scan_cancelled(&error.to_string()) => Err(error.to_string()),
        Err(error) => Err(error.to_string()),
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => Ok(false),
        Ok(_) => Ok(true),
    }
}

fn load_agent_wires(
    session: &Path,
    cancelled: &dyn Fn() -> bool,
) -> Result<(Vec<PathBuf>, bool), String> {
    let (mut wires, unlistable) = match agent_wires(session, cancelled) {
        Ok(listing) => (listing.wires, listing.unlistable),
        Err(error) if cancelled() || scan_cancelled(&error) => return Err(error),
        Err(_) => (Vec::new(), true),
    };
    // Listing can fail while the known main path is still readable.
    if unlistable && !wires.iter().any(|wire| is_main_wire(wire))
        && regular_file(&main_wire_path(session), cancelled)? {
            wires.push(main_wire_path(session));
        }
    wires.sort();
    Ok((wires, unlistable))
}

fn agent_wires(session: &Path, cancelled: &dyn Fn() -> bool) -> Result<AgentListing, String> {
    check_cancelled(cancelled)?;
    let agents = session.join("agents");
    match fs::symlink_metadata(&agents) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(AgentListing { wires: Vec::new(), unlistable: false });
        }
        Err(error) if cancelled() || scan_cancelled(&error.to_string()) => return Err(error.to_string()),
        Err(error) => return Err(error.to_string()),
        Ok(metadata) => {
            let directory = if metadata.file_type().is_symlink() {
                agents.is_dir()
            } else {
                metadata.is_dir()
            };
            if !directory {
                return Ok(AgentListing { wires: Vec::new(), unlistable: false });
            }
        }
    }
    let mut wires = Vec::new();
    let mut unlistable = false;
    let entries = match fs::read_dir(&agents) {
        Ok(entries) => entries,
        Err(error) if cancelled() || scan_cancelled(&error.to_string()) => return Err(error.to_string()),
        Err(error) => return Err(error.to_string()),
    };
    for agent in entries {
        check_cancelled(cancelled)?;
        let agent = match agent {
            Ok(agent) => agent,
            Err(error) if cancelled() || scan_cancelled(&error.to_string()) => return Err(error.to_string()),
            Err(_) => {
                unlistable = true;
                continue;
            }
        };
        let kind = match agent.file_type() {
            Ok(kind) => kind,
            Err(error) if cancelled() || scan_cancelled(&error.to_string()) => return Err(error.to_string()),
            Err(_) => {
                unlistable = true;
                continue;
            }
        };
        if !kind.is_dir() {
            continue;
        }
        let wire = agent.path().join("wire.jsonl");
        if agent.file_name().to_str() == Some("main") {
            // A stat failure here is the parent log, not a missing child.
            match regular_file(&wire, cancelled) {
                Ok(true) => wires.push(wire),
                Ok(false) => {}
                Err(error) => return Err(error),
            }
        } else {
            // NotFound and non-files are absent. Any other stat error keeps
            // agents/{id}/wire.jsonl so the unread stamp and empty child survive.
            match regular_file(&wire, cancelled) {
                Ok(true) => wires.push(wire),
                Ok(false) => {}
                Err(error) if cancelled() || scan_cancelled(&error) => return Err(error),
                Err(_) if agent.file_name().to_str().is_some() => wires.push(wire),
                Err(_) => unlistable = true,
            }
        }
    }
    wires.sort();
    Ok(AgentListing { wires, unlistable })
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

fn wire_stamp(
    path: &Path,
    fingerprint: &impl Fn(&Path) -> Result<String, String>,
    cancelled: &dyn Fn() -> bool,
) -> Result<String, String> {
    check_cancelled(cancelled)?;
    // Attribute metadata can succeed while a sharing lock still blocks the
    // body. The unread prefix keeps the parent fingerprint different until
    // the body can be opened again. A readable wire keeps the historical stamp.
    // Main wires do not use this path: their failure is a parent fingerprint error.
    let stamp = match fingerprint(path) {
        Ok(stamp) => stamp,
        Err(error) if cancelled() || scan_cancelled(&error) => return Err(error),
        Err(_) => return Ok(unread_material_stamp(path)),
    };
    if fs::File::open(path).is_ok() {
        Ok(stamp)
    } else if cancelled() {
        Err("扫描已取消，原索引已保留".into())
    } else {
        Ok(format!("unread:{stamp}"))
    }
}

fn parent_wire_stamp(
    path: &Path,
    fingerprint: &impl Fn(&Path) -> Result<String, String>,
    cancelled: &dyn Fn() -> bool,
) -> Result<String, String> {
    check_cancelled(cancelled)?;
    let stamp = fingerprint(path)?;
    match fs::File::open(path) {
        Ok(_) => Ok(stamp),
        Err(_) if cancelled() => Err("扫描已取消，原索引已保留".into()),
        Err(error) => Err(error.to_string()),
    }
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
    let (wires, unlistable) = load_agent_wires(&source.path, cancelled)?;
    for wire in wires {
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
            Err(error) if cancelled() || scan_cancelled(&error) || is_main => return Err(error),
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
    if unlistable {
        session.partial = true;
        session.children.push(ChildSession {
            key: "child".into(),
            name: None,
            messages: Vec::new(),
            readable: false,
            children: Vec::new(),
        });
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

    /// Denies directory listing only. A file already named under the directory
    /// can still be opened, which is the main-wire path.
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
    fn unlistable_agents_directory_keeps_every_parent() {
        let temp = tempfile::tempdir().unwrap();
        let blocked = session_tree(temp.path());
        std::fs::create_dir_all(blocked.join("agents/researcher")).unwrap();
        std::fs::write(
            blocked.join("agents/researcher/wire.jsonl"),
            "{\"type\":\"context.append_message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"子代理检索输入\"}]}}\n",
        )
        .unwrap();
        let other = temp
            .path()
            .join(".kimi-code/sessions/wd_example_000000000000/session_other_0001");
        std::fs::create_dir_all(other.join("agents/main")).unwrap();
        std::fs::write(other.join("state.json"), r#"{"title":"另一父会话","createdAt":"2026-08-02T03:22:11.567Z"}"#).unwrap();
        std::fs::write(other.join("agents/main/wire.jsonl"), "{\"type\":\"context.append_message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"另一父会话正文\"}]}}\n").unwrap();
        let _deny = DenyList::new(&blocked.join("agents"));
        let found = sources(temp.path()).unwrap();
        assert_eq!(found.len(), 2, "一个 agents 目录列举失败不能让本次发现整体失败");
        assert!(found.iter().all(|item| item.fingerprint_error.is_none() && item.fingerprint.starts_with("kimi-session-v4|")));
        let parent = found.iter().find(|item| item.path == blocked).unwrap();
        assert!(parent.fingerprint.contains("children-unread"), "{}", parent.fingerprint);
        let parsed = parse(parent).unwrap();
        assert!(parsed.title.contains("示例项目"));
        assert!(parsed.messages.iter().any(|message| message.text.contains("帮我把示例项目整理成两个目录")));
        assert!(parsed.messages.iter().all(|message| !message.text.contains("子代理")));
        assert_eq!(parsed.usage.len(), 2, "列举失败时仍要读到已知主日志用量");
        assert!(parsed.usage.iter().all(|event| event.attributions.iter().all(|item| item.kind == AgentKind::Main)));
        let unread = parsed.children.iter().find(|child| !child.readable).unwrap();
        assert!(unread.messages.is_empty() && unread.name.is_none());
        let other_source = found.iter().find(|item| item.native_id.as_deref() == Some("session_other_0001")).unwrap();
        let other_parsed = parse(other_source).unwrap();
        assert!(other_parsed.messages.iter().any(|message| message.text == "另一父会话正文"));
    }

    #[test]
    fn locked_main_wire_does_not_commit_an_empty_parent() {
        let temp = tempfile::tempdir().unwrap();
        let session = session_tree(temp.path());
        std::fs::create_dir_all(session.join("agents/researcher")).unwrap();
        std::fs::write(
            session.join("agents/researcher/wire.jsonl"),
            "{\"type\":\"context.append_message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"子代理检索输入\"}]}}\n",
        )
        .unwrap();
        let other = temp
            .path()
            .join(".kimi-code/sessions/wd_example_000000000000/session_other_0001");
        std::fs::create_dir_all(other.join("agents/main")).unwrap();
        std::fs::write(other.join("state.json"), r#"{"title":"另一父会话","createdAt":"2026-08-02T03:22:11.567Z"}"#).unwrap();
        std::fs::write(
            other.join("agents/main/wire.jsonl"),
            "{\"type\":\"context.append_message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"另一父会话正文\"}]}}\n",
        )
        .unwrap();
        let locked = session.join("agents/main/wire.jsonl");
        let _lock = lock_exclusive(&locked);
        let found = sources(temp.path()).unwrap();
        assert_eq!(found.len(), 2, "主日志不可读不能让本次发现整体失败");
        let parent = found.iter().find(|item| item.path == session).unwrap();
        assert!(parent.fingerprint_error.is_some(), "主日志失败必须写入 fingerprint_error：{parent:?}");
        assert!(parent.fingerprint.is_empty(), "{}", parent.fingerprint);
        assert!(parse(parent).is_err(), "主日志读失败不能提交空父会话");
        let other_source = found.iter().find(|item| item.native_id.as_deref() == Some("session_other_0001")).unwrap();
        assert!(other_source.fingerprint_error.is_none(), "{:?}", other_source.fingerprint_error);
        let other_parsed = parse(other_source).unwrap();
        assert!(other_parsed.messages.iter().any(|message| message.text == "另一父会话正文"));
    }

    #[test]
    fn locked_child_wire_keeps_the_parent_and_known_key() {
        let temp = tempfile::tempdir().unwrap();
        let session = session_tree(temp.path());
        std::fs::create_dir_all(session.join("agents/researcher")).unwrap();
        let locked = session.join("agents/researcher/wire.jsonl");
        std::fs::write(
            &locked,
            concat!(
                "{\"type\":\"context.append_message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"子代理检索输入\"}]},\"time\":\"2026-08-02T03:23:00.000Z\"}\n",
                "{\"type\":\"usage.record\",\"time\":\"2026-08-02T03:24:00.000Z\",\"model\":\"kimi-code/k3\",\"usage\":{\"inputOther\":42,\"output\":7,\"inputCacheRead\":0,\"inputCacheCreation\":0}}\n",
            ),
        )
        .unwrap();
        let blocked = {
            let _lock = lock_exclusive(&locked);
            let parent = sources(temp.path()).unwrap().remove(0);
            assert!(parent.fingerprint_error.is_none(), "{:?}", parent.fingerprint_error);
            assert!(parent.fingerprint.contains("unread:"), "{}", parent.fingerprint);
            let parsed = parse(&parent).unwrap();
            assert!(parsed.messages.iter().any(|message| message.role == "user"));
            assert!(parsed.messages.iter().all(|message| !message.text.contains("子代理")));
            assert_eq!(parsed.usage.len(), 2, "锁住的子日志不新增用量");
            assert!(parsed.usage.iter().all(|event| event.attributions.iter().all(|item| item.kind == AgentKind::Main)));
            let unread = parsed.children.iter().find(|child| child.key == "agents/researcher").unwrap();
            assert!(!unread.readable);
            assert!(unread.messages.is_empty() && unread.name.is_none());
            parent.fingerprint
        };
        let parent = sources(temp.path()).unwrap().remove(0);
        assert_ne!(parent.fingerprint, blocked, "子文件恢复可读后父指纹必须变化");
        let parsed = parse(&parent).unwrap();
        assert_eq!(parsed.usage.len(), 3, "没有原生请求 id 的子日志用量保持分开");
        let child = parsed.children.iter().find(|child| child.key == "agents/researcher").unwrap();
        assert!(child.readable);
        assert_eq!(child.messages[0].text, "子代理检索输入");
        assert!(parsed.messages.iter().all(|message| !message.text.contains("子代理")));
    }

    /// Denies traverse on one agent directory. Listing `agents` still returns
    /// that directory, while `wire.jsonl` metadata fails with access denied.
    /// Denying the file itself does not fail attribute reads on this Windows.
    struct DenyStat {
        path: PathBuf,
        #[cfg(not(windows))]
        mode: u32,
    }

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
                    .arg(format!("{user}:(RX)"))
                    .status()
                    .unwrap();
                assert!(status.success(), "icacls deny");
                Self { path: path.to_path_buf() }
            }
            #[cfg(not(windows))]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = fs::metadata(path).unwrap().permissions().mode() & 0o7777;
                fs::set_permissions(path, fs::Permissions::from_mode(0o0)).unwrap();
                Self { path: path.to_path_buf(), mode }
            }
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
                let _ = fs::set_permissions(&self.path, fs::Permissions::from_mode(self.mode));
            }
        }
    }

    #[test]
    fn child_wire_stat_failure_keeps_the_named_unread_node() {
        let temp = tempfile::tempdir().unwrap();
        let session = session_tree(temp.path());
        std::fs::create_dir_all(session.join("agents/researcher")).unwrap();
        std::fs::create_dir_all(session.join("agents/scribe")).unwrap();
        std::fs::create_dir_all(session.join("agents/absent")).unwrap();
        std::fs::create_dir_all(session.join("agents/not-a-file/wire.jsonl")).unwrap();
        let blocked = session.join("agents/researcher/wire.jsonl");
        std::fs::write(
            &blocked,
            concat!(
                "{\"type\":\"context.append_message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"被拒绝的子正文\"}]},\"time\":\"2026-08-02T03:23:00.000Z\"}\n",
                "{\"type\":\"usage.record\",\"time\":\"2026-08-02T03:24:00.000Z\",\"model\":\"kimi-code/k3\",\"usage\":{\"inputOther\":99,\"output\":1,\"inputCacheRead\":0,\"inputCacheCreation\":0}}\n",
            ),
        )
        .unwrap();
        std::fs::write(
            session.join("agents/scribe/wire.jsonl"),
            concat!(
                "{\"type\":\"context.append_message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"兄弟子正文\"}]},\"time\":\"2026-08-02T03:23:10.000Z\"}\n",
                "{\"type\":\"usage.record\",\"time\":\"2026-08-02T03:24:10.000Z\",\"model\":\"kimi-code/k3\",\"usage\":{\"inputOther\":3,\"output\":1,\"inputCacheRead\":0,\"inputCacheCreation\":0}}\n",
            ),
        )
        .unwrap();
        let blocked_fingerprint = {
            let _deny = DenyStat::new(&session.join("agents/researcher"));
            let stat_error = fs::symlink_metadata(&blocked).expect_err("测试必须让 wire.jsonl 的属性读取失败");
            assert_ne!(stat_error.kind(), std::io::ErrorKind::NotFound, "{stat_error}");
            let parent = sources(temp.path()).unwrap().remove(0);
            assert!(parent.fingerprint_error.is_none(), "{:?}", parent.fingerprint_error);
            assert!(
                parent.fingerprint.contains("agents") && parent.fingerprint.contains("unread:"),
                "{}",
                parent.fingerprint
            );
            let parsed = parse(&parent).unwrap();
            assert!(parsed.messages.iter().any(|message| message.text.contains("示例项目")));
            assert!(parsed.messages.iter().all(|message| {
                !message.text.contains("被拒绝") && !message.text.contains("兄弟")
            }));
            assert_eq!(parsed.usage.len(), 3, "属性失败的子日志不新增用量：{:?}", parsed.usage);
            let denied = parsed.children.iter().find(|child| child.key == "agents/researcher").unwrap();
            assert!(!denied.readable);
            assert!(denied.messages.is_empty() && denied.name.is_none() && denied.children.is_empty());
            let sibling = parsed.children.iter().find(|child| child.key == "agents/scribe").unwrap();
            assert!(sibling.readable);
            assert_eq!(sibling.messages[0].text, "兄弟子正文");
            assert!(parsed.children.iter().all(|child| child.key != "agents/absent" && child.key != "agents/not-a-file"));
            parent.fingerprint
        };
        let parent = sources(temp.path()).unwrap().remove(0);
        assert_ne!(parent.fingerprint, blocked_fingerprint, "属性恢复后父指纹必须变化");
        let parsed = parse(&parent).unwrap();
        let denied = parsed.children.iter().find(|child| child.key == "agents/researcher").unwrap();
        assert!(denied.readable);
        assert_eq!(denied.messages[0].text, "被拒绝的子正文");
        assert_eq!(parsed.usage.len(), 4, "没有原生请求 id 的子日志用量保持分开");
        assert!(parsed.messages.iter().all(|message| !message.text.contains("被拒绝") && !message.text.contains("兄弟")));
    }
}
