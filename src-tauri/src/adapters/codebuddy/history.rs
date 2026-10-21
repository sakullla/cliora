use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::history::usage::{self, TokenCounts};
use crate::history::{
    check_cancelled, discover_jsonl_controlled_in, raw_string_after, read_jsonl_filtered,
    source_fingerprint_controlled, text_content, timestamp, valid_native_id, AgentKind,
    ChildSession, HistoryMessage, HistoryMessageKind, HistorySource, MessageTimeSource,
    ParsedSession, UsageAttribution, UsageEvent,
};

/// Sessions live in `~/.codebuddy/projects/<workspace-slug>/<session-id>.jsonl`
/// (verified on 2.161.1). The session's subagent streams live in the sibling
/// `<session-id>/subagents/agent-*.jsonl` wires and are folded into the parent
/// session for usage. The sibling `<session-id>/tool-results` directories
/// never hold session logs, and the top-level `history.jsonl` is a prompt
/// history, not a session transcript, so only uuid-named files are accepted.
pub fn sources(home: &Path) -> Result<Vec<HistorySource>, String> {
    sources_controlled(home, &|| false)
}

pub fn sources_controlled(
    home: &Path,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<HistorySource>, String> {
    let root = crate::accounts::selection::history_root("codebuddy", || {
        super::config_root(home).join("projects")
    });
    let mut sources = discover_jsonl_controlled_in(
        &root,
        |path| {
            path.extension().is_some_and(|value| value == "jsonl")
                && path
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .is_some_and(session_file_stem)
        },
        cancelled,
        // Child logs are not sessions. Listing them here would fail every
        // parent when that directory cannot be read.
        |path| path.file_name().is_none_or(|name| name != "subagents"),
    )?;
    // Adapter-local parser version: existing indexes are rebuilt once per
    // parser change even when the native file itself has not changed. The
    // fingerprint also covers the session's subagent wires, so a later
    // subagent run reindexes the parent session. A child listing or
    // fingerprint failure is not a parent fingerprint_error: the scan must
    // still parse the parent, and the extra changes when the child can be
    // read again.
    for source in &mut sources {
        if source.fingerprint_error.is_some() {
            continue;
        }
        let mut parts = vec![source.fingerprint.clone()];
        parts.extend(child_fingerprint_parts(&source.path, cancelled)?);
        source.fingerprint = format!("codebuddy-session-v5|{}", parts.join("|"));
    }
    Ok(sources)
}

fn child_fingerprint_parts(session_file: &Path, cancelled: &dyn Fn() -> bool) -> Result<Vec<String>, String> {
    let wires = match subagent_wires(session_file, cancelled) {
        Ok(wires) => wires,
        Err(error) if cancelled() || scan_cancelled(&error) => return Err(error),
        Err(_) => {
            let Some(directory) = subagent_directory(session_file) else {
                return Ok(Vec::new());
            };
            return Ok(vec![format!("children-unread:{}", unread_material_stamp(&directory))]);
        }
    };
    let mut parts = Vec::with_capacity(wires.len());
    for wire in wires {
        parts.push(child_material_stamp(&wire, cancelled)?);
    }
    Ok(parts)
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

fn child_material_stamp(path: &Path, cancelled: &dyn Fn() -> bool) -> Result<String, String> {
    check_cancelled(cancelled)?;
    // Attribute metadata can succeed while a sharing lock still blocks the
    // body. The unread prefix keeps the parent fingerprint different until
    // the body can be opened again. A readable wire keeps the historical
    // metadata stamp so an unchanged child does not force another rescan.
    let stamp = match source_fingerprint_controlled(path, cancelled) {
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

/// Subagent wires of one session: `projects/<slug>/<session-id>/subagents/
/// agent-*.jsonl`. Rows inside carry the subagent's own session id, so the
/// parent linkage is positional (the session-id directory name).
fn subagent_directory(session_file: &Path) -> Option<PathBuf> {
    let stem = session_file.file_stem().and_then(|value| value.to_str())?;
    Some(session_file.parent()?.join(stem).join("subagents"))
}

fn subagent_wires(session_file: &Path, cancelled: &dyn Fn() -> bool) -> Result<Vec<PathBuf>, String> {
    check_cancelled(cancelled)?;
    let Some(directory) = subagent_directory(session_file) else {
        return Ok(Vec::new());
    };
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    let mut wires = Vec::new();
    for entry in fs::read_dir(&directory).map_err(|error| error.to_string())? {
        check_cancelled(cancelled)?;
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if entry.file_type().map_err(|error| error.to_string())?.is_file()
            && path.extension().is_some_and(|value| value == "jsonl")
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("agent-"))
        {
            wires.push(path);
        }
    }
    wires.sort();
    Ok(wires)
}

pub fn parse(source: &HistorySource) -> Result<ParsedSession, String> {
    parse_controlled(source, &|| false)
}

/// Rows that never carry conversation text or per-call usage on any verified
/// 2.161.1 session (6.4k+ usage rows sampled locally): tool results, reasoning
/// blobs, file snapshots, per-turn aggregates and duplicate summaries.
/// `function_call` rows MUST be parsed: the tool loop's intermediate API calls
/// log their `providerData.usage` only there, while assistant messages carry
/// the turn-final call. `turn-metrics.tokenDelta` equals the sum of all usage
/// rows (parent plus subagent wires) on verified sessions, but stays a
/// cross-check only: it is an aggregate without per-call model/cache detail.
fn skip_row(raw: &[u8]) -> bool {
    let Some(kind) = raw_string_after(raw, b"\"type\":\"") else {
        return false;
    };
    matches!(
        kind,
        b"function_call_result"
            | b"reasoning"
            | b"file-history-snapshot"
            | b"turn-metrics"
            | b"summary"
    )
}

/// Usage is per API call and may sit on any row carrying `providerData.usage`
/// (assistant messages and `function_call` rows). Row ids are unique per call,
/// so forked copies of the same row collapse to one usage event.
/// `conversationRequestId` is a turn id shared by many billed rows. Together
/// with `messageId` it identifies one call, including the same call repeated
/// in a child log. Without that pair, the row id stays the identity.
fn record_usage(
    session: &mut ParsedSession,
    records: &mut HashSet<String>,
    calls: &mut HashMap<String, usize>,
    event: String,
    provider: Option<&Value>,
    model: Option<String>,
    time: Option<i64>,
    attribution: UsageAttribution,
) {
    let Some(counts) = provider
        .and_then(|data| data.get("usage"))
        .and_then(usage_counts)
        .map(usage::clamp_cache_inside_input)
        .filter(|counts| usage::active(*counts))
    else {
        return;
    };
    let identity = call_identity(provider, &event);
    if let Some(&index) = calls.get(&identity) {
        attach(&mut session.usage[index], attribution);
        return;
    }
    if !records.insert(event.clone()) {
        if let Some(index) = session.usage.iter().position(|item| item.id == event) {
            attach(&mut session.usage[index], attribution);
            calls.insert(identity, index);
        }
        return;
    }
    let index = session.usage.len();
    session.usage.push(UsageEvent {
        native_usage: None,
        request_count: Some(1),
        id: event,
        model,
        timestamp: time,
        input: Some(counts.input),
        output: Some(counts.output),
        cache_read: Some(counts.read),
        cache_write: Some(counts.write),
        input_includes_cache: true,
        attributions: vec![attribution],
    });
    calls.insert(identity, index);
}

fn call_identity(provider: Option<&Value>, event: &str) -> String {
    let request = provider
        .and_then(|data| data.get("conversationRequestId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty());
    let message = provider
        .and_then(|data| data.get("messageId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty());
    match (request, message) {
        (Some(request), Some(message)) => format!("request:{request}:{message}"),
        _ => format!("row:{event}"),
    }
}

fn attach(event: &mut UsageEvent, attribution: UsageAttribution) {
    if !event.attributions.iter().any(|item| item == &attribution) {
        event.attributions.push(attribution);
    }
}

fn agent_name(provider: Option<&Value>) -> Option<String> {
    provider
        .and_then(|data| data.get("agent"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| name.chars().take(256).collect())
}

fn distinct_session_id(row: &Value, parent: Option<&str>) -> Option<String> {
    let id = row.get("sessionId").and_then(Value::as_str)?;
    if !valid_native_id(id) || parent == Some(id) {
        return None;
    }
    Some(id.to_owned())
}

fn wire_key(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty() && name.len() <= 512)
        .unwrap_or("child")
        .to_owned()
}

fn push_child_message(messages: &mut Vec<HistoryMessage>, id: String, role: &str, text: String, time: Option<i64>) {
    if text.trim().is_empty() {
        return;
    }
    messages.push(HistoryMessage {
        id,
        role: role.to_owned(),
        text,
        timestamp: time,
        timestamp_source: if time.is_some() { MessageTimeSource::Native } else { MessageTimeSource::Unknown },
        kind: HistoryMessageKind::Conversation,
    });
}

fn retarget_child(session: &mut ParsedSession, from_key: &str, to_key: &str, name: Option<&str>) {
    for event in &mut session.usage {
        for item in &mut event.attributions {
            if item.kind == AgentKind::Subagent && item.session_key.as_deref() == Some(from_key) {
                item.session_key = Some(to_key.to_owned());
                if item.name.is_none() {
                    item.name = name.map(str::to_owned);
                }
            }
        }
        let mut kept = Vec::new();
        for item in event.attributions.drain(..) {
            if !kept.iter().any(|other: &UsageAttribution| other == &item) {
                kept.push(item);
            }
        }
        event.attributions = kept;
    }
}

/// Normalized provider usage on assistant messages (verified shape):
/// `{inputTokens, outputTokens, inputTokensDetails[{cached_tokens}],
/// outputTokensDetails[{reasoning_tokens}]}`. `inputTokens` includes the
/// cached share and `outputTokens` includes reasoning (OpenAI-style), matching
/// the on-disk totals on the verified session.
fn usage_counts(value: &Value) -> Option<TokenCounts> {
    if !value.is_object() {
        return None;
    }
    let read = value.get("inputTokensDetails").and_then(Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(|item| usage::field(item, "cached_tokens"))
            .sum::<u64>()
    });
    usage::from_optional(
        usage::field(value, "inputTokens"),
        usage::field(value, "outputTokens"),
        read,
        None,
    )
}

/// Session files are named `<uuid>.jsonl` (36 chars, hyphens at 8/13/18/23);
/// the charset check alone would also accept free-form names like "notes".
fn session_file_stem(name: &str) -> bool {
    const UUID_SHAPE: [usize; 4] = [8, 13, 18, 23];
    name.len() == 36
        && UUID_SHAPE.iter().all(|at| name.as_bytes()[*at] == b'-')
        && valid_native_id(name)
}

pub fn parse_controlled(
    source: &HistorySource,
    cancelled: &dyn Fn() -> bool,
) -> Result<ParsedSession, String> {
    let mut session = ParsedSession::new();
    let mut model: Option<String> = None;
    let mut records = HashSet::<String>::new();
    let mut calls = HashMap::<String, usize>::new();
    let partial = read_jsonl_filtered(source, cancelled, skip_row, |line, row| {
        let time = row.get("timestamp").and_then(timestamp);
        let provider = row.get("providerData");
        // Per-call usage is counted from every row carrying providerData.usage,
        // not only assistant messages: the tool loop's intermediate calls log
        // their usage on the function_call rows.
        let id = row
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("{}:line-{line}", source.key()));
        let row_model = provider
            .and_then(|data| data.get("model"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| model.clone());
        record_usage(
            &mut session,
            &mut records,
            &mut calls,
            format!("codebuddy:usage:{id}"),
            provider,
            row_model,
            time,
            UsageAttribution { kind: AgentKind::Main, name: agent_name(provider), session_key: None },
        );
        match row.get("type").and_then(Value::as_str) {
            Some("message") => {
                let role = row.get("role").and_then(Value::as_str).unwrap_or("");
                if role != "user" && role != "assistant" {
                    return;
                }
                // providerData.skipRun marks local command echoes (for example
                // /model round trips), not conversation turns.
                if provider
                    .and_then(|data| data.get("skipRun"))
                    .and_then(Value::as_bool)
                    == Some(true)
                {
                    return;
                }
                if let Some(id) = row
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .filter(|id| valid_native_id(id))
                {
                    session.native_id = Some(id.to_owned());
                }
                if let Some(cwd) = row.get("cwd").and_then(Value::as_str) {
                    session.cwd = Some(cwd.to_owned());
                }
                if let Some(current) = provider
                    .and_then(|data| data.get("model"))
                    .and_then(Value::as_str)
                {
                    model = Some(current.to_owned());
                    session.model = model.clone();
                }
                let body = row.get("content").map(text_content).unwrap_or_default();
                session.add_message(id, role, body, time);
            }
            Some("ai-title") => {
                if let Some(id) = row
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .filter(|id| valid_native_id(id))
                {
                    session.native_id = Some(id.to_owned());
                }
                if let Some(title) = row
                    .get("aiTitle")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .filter(|title| !title.trim().is_empty())
                {
                    session.title = title.chars().take(96).collect();
                }
            }
            _ => {}
        }
    })?;
    session.partial |= partial;
    // Subagent wires keep their own session id and body. Usage still joins the
    // parent total. A call already seen on the parent (same conversation
    // request and message id, or the same row id) is not counted again.
    let mut used_keys = HashSet::new();
    let wires = match subagent_wires(&source.path, cancelled) {
        Ok(wires) => wires,
        Err(error) if cancelled() || scan_cancelled(&error) => return Err(error),
        Err(_) => {
            session.partial = true;
            let key = claim_child_key(&mut used_keys, None, "child".into());
            session.children.push(ChildSession {
                key,
                name: None,
                messages: Vec::new(),
                readable: false,
                children: Vec::new(),
            });
            Vec::new()
        }
    };
    for wire in wires {
        check_cancelled(cancelled)?;
        let agent = wire
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("agent")
            .to_owned();
        let path_key = wire_key(&wire);
        let wire_source = HistorySource {
            native_title: None,
            path: wire,
            native_id: None,
            fingerprint: String::new(),
            fingerprint_error: None,
        };
        let mut messages = Vec::new();
        let mut native_key = None;
        let mut native_name = None;
        let parent_id = session.native_id.clone();
        let read = read_jsonl_filtered(&wire_source, cancelled, skip_row, |line, row| {
            let provider = row.get("providerData");
            if native_key.is_none() {
                native_key = distinct_session_id(&row, parent_id.as_deref());
            }
            if native_name.is_none() {
                native_name = agent_name(provider);
            }
            let row_model = provider
                .and_then(|data| data.get("model"))
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| session.model.clone());
            let id = row
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| format!("{}:line-{line}", wire_source.key()));
            record_usage(
                &mut session,
                &mut records,
                &mut calls,
                format!("{agent}:usage:{id}"),
                provider,
                row_model,
                row.get("timestamp").and_then(timestamp),
                UsageAttribution {
                    kind: AgentKind::Subagent,
                    name: native_name.clone(),
                    session_key: Some(path_key.clone()),
                },
            );
            if row.get("type").and_then(Value::as_str) != Some("message") {
                return;
            }
            let role = row.get("role").and_then(Value::as_str).unwrap_or("");
            if role != "user" && role != "assistant" {
                return;
            }
            if provider.and_then(|data| data.get("skipRun")).and_then(Value::as_bool) == Some(true) {
                return;
            }
            let body = row.get("content").map(text_content).unwrap_or_default();
            push_child_message(&mut messages, id, role, body, row.get("timestamp").and_then(timestamp));
        });
        match read {
            Ok(agent_partial) => {
                session.partial |= agent_partial;
                let key = claim_child_key(&mut used_keys, native_key.clone(), path_key.clone());
                retarget_child(&mut session, &path_key, &key, native_name.as_deref());
                session.children.push(ChildSession {
                    key,
                    name: native_name,
                    messages,
                    readable: true,
                    children: Vec::new(),
                });
            }
            Err(error) => {
                if cancelled() || scan_cancelled(&error) {
                    return Err(error);
                }
                session.partial = true;
                let key = claim_child_key(&mut used_keys, None, path_key);
                session.children.push(ChildSession {
                    key,
                    name: None,
                    messages: Vec::new(),
                    readable: false,
                    children: Vec::new(),
                });
            }
        }
    }
    session.finish(source)
}

fn claim_child_key(used: &mut HashSet<String>, native: Option<String>, fallback: String) -> String {
    let preferred = native.filter(|key| !key.is_empty() && key.len() <= 512).unwrap_or_else(|| fallback.clone());
    if used.insert(preferred.clone()) {
        return preferred;
    }
    if used.insert(fallback.clone()) {
        return fallback;
    }
    let mut n = 2u32;
    loop {
        let key = format!("{fallback}#{n}");
        if used.insert(key.clone()) {
            return key;
        }
        n += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn fixtures() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/history")
    }

    fn fixture_source() -> HistorySource {
        HistorySource { native_title: None,
            path: fixtures().join("codebuddy-2.161.1-session.jsonl"),
            native_id: None,
            fingerprint: "test".into(),
            fingerprint_error: None,
        }
    }

    #[test]
    fn association_descriptor_is_available() {
        let published = crate::adapters::PublishedDescriptor::from_adapter(&crate::adapters::codebuddy::CodeBuddy);
        assert_eq!(published.association.expect("association").state, "available");
    }

    #[test]
    fn sources_discover_only_uuid_named_session_files() {
        let home = tempfile::tempdir().unwrap();
        let projects = home.path().join(".codebuddy/projects/demo-workspace");
        fs::create_dir_all(&projects).unwrap();
        fs::write(
            projects.join("0aa0fb40-0b9c-74c9-8d7c-cd5d630dc6f0.jsonl"),
            "{\"type\":\"message\"}\n",
        )
        .unwrap();
        fs::write(projects.join("notes.jsonl"), "{}\n").unwrap();
        fs::write(projects.join("scratch.txt"), "{}\n").unwrap();
        let sources = sources(home.path()).unwrap();
        assert_eq!(sources.len(), 1);
        assert!(sources[0].fingerprint.starts_with("codebuddy-session-v5|"));
        assert!(sources[0]
            .path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("0aa0fb40"));
    }

    #[test]
    fn fixture_session_counts_usage_from_all_usage_rows() {
        let parsed = parse(&fixture_source()).unwrap();
        assert_eq!(
            parsed.native_id.as_deref(),
            Some("01a0c8f7-ef95-76a2-9503-6dbc8341a38f")
        );
        assert_eq!(parsed.title, "调整表格展示样式");
        assert_eq!(parsed.model.as_deref(), Some("kimi-k3-2"));
        assert_eq!(
            parsed.cwd.as_deref(),
            Some(r"c:\Users\example\project\demo")
        );
        let roles: Vec<&str> = parsed.messages.iter().map(|m| m.role.as_str()).collect();
        // The three skipRun local-command echoes stay out of the transcript.
        assert_eq!(
            roles,
            vec!["user", "user", "assistant", "assistant", "user", "assistant"]
        );
        // The fixture (real 2.161.1 session, sanitized) holds one full turn:
        // 17 parent usage rows (16 function_call + the turn-final assistant
        // message) plus 7 rows from the Explore subagent wire (6 function_call
        // + the wire-final assistant message).
        assert_eq!(parsed.usage.len(), 24);
        assert_eq!(parsed.children.len(), 1);
        assert_eq!(parsed.children[0].name.as_deref(), Some("Explore"));
        assert_eq!(parsed.children[0].key, "01a0c8f8-e7f1-7396-a7c4-025157353f8d");
        assert!(parsed.children[0].readable);
        assert!(parsed.children[0].messages.iter().any(|message| message.text.contains("助手回复占位")));
        assert!(parsed.usage.iter().filter(|event| event.id.starts_with("codebuddy:usage:")).all(|event| {
            event.attributions.iter().any(|item| item.kind == AgentKind::Main && item.name.as_deref() == Some("cli") && item.session_key.is_none())
        }));
        assert!(parsed.usage.iter().filter(|event| event.id.starts_with("agent-")).all(|event| {
            event.attributions.iter().any(|item| item.kind == AgentKind::Subagent && item.name.as_deref() == Some("Explore") && item.session_key.as_deref() == Some("01a0c8f8-e7f1-7396-a7c4-025157353f8d"))
        }));
        let parent = parsed
            .usage
            .iter()
            .filter(|event| event.id.starts_with("codebuddy:usage:"))
            .count();
        let wire = parsed
            .usage
            .iter()
            .filter(|event| event.id.starts_with("agent-f46656a6963a4e4c:usage:"))
            .count();
        assert_eq!(parent, 17);
        assert_eq!(wire, 7);
        let mut ids: Vec<&str> = parsed.usage.iter().map(|event| event.id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), parsed.usage.len(), "行 id 去重后不得有重复事件");
        // First tool-loop call: usage sits on a function_call row.
        let first_call = parsed
            .usage
            .iter()
            .find(|event| event.id == "codebuddy:usage:01a0c8f8-b32c-702b-905f-9ed485e0289c")
            .unwrap();
        assert_eq!(first_call.input, Some(27523));
        assert_eq!(first_call.output, Some(139));
        assert_eq!(first_call.cache_read, Some(14336));
        assert_eq!(first_call.cache_write, Some(0));
        assert!(first_call.input_includes_cache);
        assert_eq!(first_call.request_count, Some(1));
        assert_eq!(first_call.model.as_deref(), Some("kimi-k3-2"));
        // Turn-final assistant message usage.
        let turn_final = parsed
            .usage
            .iter()
            .find(|event| event.id == "codebuddy:usage:01a0c900-74dc-77e3-8554-f459260e97ce")
            .unwrap();
        assert_eq!(turn_final.input, Some(47092));
        assert_eq!(turn_final.output, Some(123));
        assert_eq!(turn_final.cache_read, Some(46336));
        // Subagent wire's first intermediate call.
        let wire_call = parsed
            .usage
            .iter()
            .find(|event| event.id == "agent-f46656a6963a4e4c:usage:01a0c8f9-0dc8-73c5-90ee-1443977196ff")
            .unwrap();
        assert_eq!(wire_call.input, Some(17617));
        assert_eq!(wire_call.output, Some(241));
        assert_eq!(wire_call.cache_read, Some(512));
        assert_eq!(wire_call.model.as_deref(), Some("kimi-k3-2"));
        // Cross-check against turn-metrics: the sum over ALL usage rows
        // (parent + subagent wire, input + output) equals tokenDelta.
        let total: u64 = parsed
            .usage
            .iter()
            .map(|event| event.input.unwrap_or(0) + event.output.unwrap_or(0))
            .sum();
        assert_eq!(total, fixture_token_delta_sum(), "全 usage 行和必须与 tokenDelta 相等");
        assert!(!parsed.partial);
    }

    /// `turn-metrics.tokenDelta` values of the fixture session, used only as a
    /// cross-check of the all-rows usage sum.
    fn fixture_token_delta_sum() -> u64 {
        let raw = fs::read_to_string(fixtures().join("codebuddy-2.161.1-session.jsonl")).unwrap();
        raw.lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|row| row.get("type").and_then(Value::as_str) == Some("turn-metrics"))
            .filter_map(|row| row.get("tokenDelta").and_then(Value::as_u64))
            .sum()
    }

    #[test]
    fn tool_and_metric_rows_are_skipped_without_parsing() {
        // function_call rows carry the tool loop's per-call usage and must be
        // parsed; only rows that never carry usage are skipped raw.
        assert!(!skip_row(
            br#"{"id":"x","type":"function_call","name":"read_file","arguments":"{}"}"#
        ));
        assert!(skip_row(
            br#"{"id":"x","type":"function_call_result","callId":"c","output":"{}"}"#
        ));
        assert!(skip_row(br#"{"id":"x","type":"reasoning","rawContent":[]}"#));
        assert!(skip_row(br#"{"type":"file-history-snapshot","snapshot":{}}"#));
        assert!(skip_row(
            br#"{"type":"turn-metrics","durationMs":1,"tokenDelta":6}"#
        ));
        assert!(skip_row(br#"{"type":"summary","summary":"s"}"#));
        assert!(!skip_row(
            br#"{"id":"x","type":"message","role":"user","content":[]}"#
        ));
        assert!(!skip_row(br#"{"id":"x"}"#));
    }

    #[test]
    fn subagent_wire_usage_joins_the_parent_session_total() {
        let temp = tempfile::tempdir().unwrap();
        let projects = temp.path().join(".codebuddy/projects/demo-workspace");
        let session_id = "0aa0fb40-0b9c-74c9-8d7c-cd5d630dc6f0";
        fs::create_dir_all(projects.join(format!("{session_id}/subagents"))).unwrap();
        fs::write(
            projects.join(format!("{session_id}.jsonl")),
            format!(
                concat!(
                    r#"{{"type":"ai-title","aiTitle":"主会话","sessionId":"{sid}"}}"#,
                    "\n",
                    r#"{{"id":"m1","type":"message","role":"user","timestamp":1789000000000,"sessionId":"{sid}","cwd":"c:\\work\\demo","content":[{{"type":"text","text":"查一下"}}]}}"#,
                    "\n",
                    r#"{{"id":"f1","type":"function_call","timestamp":1789000000500,"name":"Grep","arguments":{{}},"providerData":{{"model":"kimi-k3-2","usage":{{"requests":1,"inputTokens":500,"outputTokens":25,"totalTokens":525,"inputTokensDetails":[{{"cached_tokens":100}}],"outputTokensDetails":[]}}}},"sessionId":"{sid}","cwd":"c:\\work\\demo"}}"#,
                    "\n",
                    r#"{{"id":"a1","type":"message","role":"assistant","timestamp":1789000001000,"sessionId":"{sid}","providerData":{{"model":"kimi-k3-2","usage":{{"requests":1,"inputTokens":1000,"outputTokens":50,"totalTokens":1050,"inputTokensDetails":[{{"cached_tokens":900}}],"outputTokensDetails":[]}}}},"content":[{{"type":"text","text":"结论"}}]}}"#,
                    "\n",
                ),
                sid = session_id
            ),
        )
        .unwrap();
        // The subagent wire carries its own session id; only its usage folds
        // in, and the wire follows the same all-rows rule (its function_call
        // rows carry the subagent's intermediate calls' usage).
        fs::write(
            projects.join(format!("{session_id}/subagents/agent-0a2dcb4f1b794a44.jsonl")),
            format!(
                concat!(
                    r#"{{"id":"s-user","type":"message","role":"user","timestamp":1789000002000,"sessionId":"subagent-own-id","cwd":"c:\\work\\demo","content":[{{"type":"text","text":"子代理输入不该进主会话"}}]}}"#,
                    "\n",
                    r#"{{"id":"s-f1","type":"function_call","timestamp":1789000002400,"name":"Read","arguments":{{}},"providerData":{{"model":"kimi-k3-2","usage":{{"requests":1,"inputTokens":300,"outputTokens":40,"totalTokens":340,"inputTokensDetails":[{{"cached_tokens":60}}],"outputTokensDetails":[]}}}},"sessionId":"subagent-own-id","cwd":"c:\\work\\demo"}}"#,
                    "\n",
                    r#"{{"id":"s-a1","type":"message","role":"assistant","timestamp":1789000003000,"sessionId":"subagent-own-id","providerData":{{"model":"kimi-k3-2","usage":{{"requests":1,"inputTokens":2000,"outputTokens":80,"totalTokens":2080,"inputTokensDetails":[{{"cached_tokens":1500}}],"outputTokensDetails":[]}}}},"content":[{{"type":"text","text":"子代理输出"}}]}}"#,
                    "\n",
                    r#"{{"type":"turn-metrics","durationMs":9,"tokenDelta":99}}"#,
                    "\n",
                ),
            ),
        )
        .unwrap();
        let sources = sources(temp.path()).unwrap();
        assert_eq!(sources.len(), 1);
        assert!(sources[0].fingerprint.starts_with("codebuddy-session-v5|"));
        let parsed = parse(&sources[0]).unwrap();
        assert_eq!(
            parsed.native_id.as_deref(),
            Some("0aa0fb40-0b9c-74c9-8d7c-cd5d630dc6f0"),
            "子代理自己的 sessionId 不得改写主会话身份"
        );
        assert_eq!(parsed.messages.len(), 2, "{:?}", parsed.messages);
        assert!(parsed
            .messages
            .iter()
            .all(|message| !message.text.contains("子代理")));
        assert_eq!(parsed.usage.len(), 4, "{:?}", parsed.usage);
        let mut ids: Vec<&str> = parsed.usage.iter().map(|event| event.id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), parsed.usage.len(), "子代理事件 id 不得与主会话冲突");
        assert_eq!(
            ids,
            vec![
                "agent-0a2dcb4f1b794a44:usage:s-a1",
                "agent-0a2dcb4f1b794a44:usage:s-f1",
                "codebuddy:usage:a1",
                "codebuddy:usage:f1"
            ]
        );
        let parent_input: u64 = parsed
            .usage
            .iter()
            .filter(|event| event.id.starts_with("codebuddy:"))
            .map(|event| event.input.unwrap_or(0))
            .sum();
        let wire_input: u64 = parsed
            .usage
            .iter()
            .filter(|event| event.id.starts_with("agent-"))
            .map(|event| event.input.unwrap_or(0))
            .sum();
        assert_eq!(parent_input, 1500, "父会话取全 usage 行(含 function_call)");
        assert_eq!(wire_input, 2300, "子代理线内同样取全 usage 行");
        assert!(parsed.usage.iter().all(|event| event.input_includes_cache));
        assert!(parsed.messages.iter().all(|message| !message.text.contains("子代理")));
        assert_eq!(parsed.children.len(), 1);
        assert_eq!(parsed.children[0].key, "subagent-own-id");
        assert!(parsed.children[0].name.is_none(), "没有原生代理名时不拿文件名当名称");
        assert!(parsed.children[0].readable);
        assert!(parsed.children[0].messages.iter().any(|message| message.text.contains("子代理输入")));
        assert!(parsed.children[0].messages.iter().any(|message| message.text == "子代理输出"));
        assert!(parsed.usage.iter().filter(|event| event.id.starts_with("codebuddy:")).all(|event| {
            event.attributions.iter().any(|item| item.kind == AgentKind::Main && item.session_key.is_none())
        }));
        assert!(parsed.usage.iter().filter(|event| event.id.starts_with("agent-")).all(|event| {
            event.attributions.iter().any(|item| item.kind == AgentKind::Subagent && item.session_key.as_deref() == Some("subagent-own-id"))
        }));
    }

    #[test]
    fn same_conversation_request_and_message_id_is_one_usage_event() {
        let temp = tempfile::tempdir().unwrap();
        let projects = temp.path().join(".codebuddy/projects/demo-workspace");
        let session_id = "0aa0fb40-0b9c-74c9-8d7c-cd5d630dc6f0";
        fs::create_dir_all(projects.join(format!("{session_id}/subagents"))).unwrap();
        let usage = |tokens: u64| {
            format!(r#"{{"requests":1,"inputTokens":{tokens},"outputTokens":1,"totalTokens":{tokens},"inputTokensDetails":[],"outputTokensDetails":[]}}"#)
        };
        fs::write(
            projects.join(format!("{session_id}.jsonl")),
            format!(
                r#"{{"id":"parent-row","type":"message","role":"assistant","timestamp":1789000001000,"sessionId":"{session_id}","providerData":{{"agent":"cli","conversationRequestId":"turn-1","messageId":"call-1","model":"kimi-k3-2","usage":{usage}}},"content":[{{"type":"text","text":"父回复"}}]}}
{{"id":"parent-other","type":"function_call","timestamp":1789000001100,"sessionId":"{session_id}","providerData":{{"agent":"cli","conversationRequestId":"turn-1","messageId":"call-2","model":"kimi-k3-2","usage":{other}}}}}
"#,
                usage = usage(10),
                other = usage(20),
            ),
        )
        .unwrap();
        fs::write(
            projects.join(format!("{session_id}/subagents/agent-same.jsonl")),
            format!(
                r#"{{"id":"child-row","type":"message","role":"assistant","timestamp":1789000002000,"sessionId":"child-session-id","providerData":{{"agent":"Explore","isSubAgent":true,"conversationRequestId":"turn-1","messageId":"call-1","model":"kimi-k3-2","usage":{usage}}},"content":[{{"type":"text","text":"子日志正文"}}]}}
{{"id":"child-other","type":"function_call","timestamp":1789000002100,"sessionId":"child-session-id","providerData":{{"agent":"Explore","conversationRequestId":"turn-1","messageId":"call-9","usage":{other}}}}}
"#,
                usage = usage(99),
                other = usage(7),
            ),
        )
        .unwrap();
        let parsed = parse(&sources(temp.path()).unwrap().remove(0)).unwrap();
        assert_eq!(parsed.native_id.as_deref(), Some(session_id));
        assert_eq!(parsed.usage.len(), 3, "同一 messageId 不新增；同一 turn 里的另一调用仍保留");
        let shared = parsed.usage.iter().find(|event| event.id == "codebuddy:usage:parent-row").unwrap();
        assert_eq!(shared.input, Some(10), "重复观察不把子日志用量再加一次");
        assert_eq!(shared.attributions.len(), 2);
        assert!(shared.attributions.iter().any(|item| item.kind == AgentKind::Main && item.name.as_deref() == Some("cli")));
        assert!(shared.attributions.iter().any(|item| {
            item.kind == AgentKind::Subagent && item.name.as_deref() == Some("Explore") && item.session_key.as_deref() == Some("child-session-id")
        }));
        assert!(parsed.messages.iter().all(|message| message.text != "子日志正文"));
        assert_eq!(parsed.children.len(), 1);
        assert_eq!(parsed.children[0].name.as_deref(), Some("Explore"));
        assert!(parsed.children[0].messages.iter().any(|message| message.text == "子日志正文"));
    }

    #[test]
    fn unreadable_child_keeps_the_parent_without_inventing_a_body() {
        let temp = tempfile::tempdir().unwrap();
        let projects = temp.path().join(".codebuddy/projects/demo-workspace");
        let session_id = "0aa0fb40-0b9c-74c9-8d7c-cd5d630dc6f0";
        fs::create_dir_all(projects.join(format!("{session_id}/subagents"))).unwrap();
        fs::write(
            projects.join(format!("{session_id}.jsonl")),
            format!(
                r#"{{"id":"m1","type":"message","role":"user","timestamp":1789000000000,"sessionId":"{session_id}","providerData":{{"agent":"cli"}},"content":[{{"type":"text","text":"父会话仍在"}}]}}"#
            ),
        )
        .unwrap();
        let locked = projects.join(format!("{session_id}/subagents/agent-locked.jsonl"));
        fs::write(&locked, r#"{"id":"c1","type":"message","role":"assistant","content":[{"type":"text","text":"不可读正文"}]}"#).unwrap();
        let _lock = lock_exclusive(&locked);
        let found = sources(temp.path()).unwrap();
        assert_eq!(found.len(), 1);
        assert!(found[0].fingerprint_error.is_none(), "{:?}", found[0].fingerprint_error);
        assert!(found[0].fingerprint.starts_with("codebuddy-session-v5|"));
        assert!(found[0].fingerprint.contains("unread:"), "不可读子文件仍要进入父指纹，恢复可读后才能重扫");
        let parsed = parse(&found[0]).unwrap();
        assert!(parsed.messages.iter().any(|message| message.text == "父会话仍在"));
        assert!(parsed.messages.iter().all(|message| !message.text.contains("不可读")));
        assert!(parsed.usage.is_empty());
        assert_eq!(parsed.children.len(), 1);
        assert!(!parsed.children[0].readable);
        assert!(parsed.children[0].messages.is_empty());
        assert!(parsed.children[0].name.is_none());
    }

    fn lock_exclusive(path: &Path) -> fs::File {
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            return fs::OpenOptions::new().read(true).share_mode(0).open(path).unwrap();
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            let file = fs::File::open(path).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0)).unwrap();
            file
        }
    }

    #[test]
    fn subagent_wire_change_flips_the_source_fingerprint() {
        let temp = tempfile::tempdir().unwrap();
        let projects = temp.path().join(".codebuddy/projects/demo-workspace");
        let session_id = "0aa0fb40-0b9c-74c9-8d7c-cd5d630dc6f0";
        fs::create_dir_all(&projects).unwrap();
        fs::write(projects.join(format!("{session_id}.jsonl")), "{}\n").unwrap();
        let before = sources(temp.path()).unwrap().remove(0).fingerprint;
        fs::create_dir_all(projects.join(format!("{session_id}/subagents"))).unwrap();
        fs::write(
            projects.join(format!("{session_id}/subagents/agent-x.jsonl")),
            "{}\n",
        )
        .unwrap();
        let after = sources(temp.path()).unwrap().remove(0).fingerprint;
        assert_ne!(before, after, "子代理线文件变化必须触发重扫");
    }

    struct DenyList { path: PathBuf }

    impl DenyList {
        fn new(path: &Path) -> Self {
            #[cfg(windows)]
            {
                let user = std::env::var("USERNAME").expect("USERNAME");
                let status = std::process::Command::new("icacls").arg(path).arg("/inheritance:r").status().unwrap();
                assert!(status.success());
                let status = std::process::Command::new("icacls").arg(path).arg("/deny").arg(format!("{user}:(OI)(CI)(RX)")).status().unwrap();
                assert!(status.success());
            }
            #[cfg(not(windows))]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(path, fs::Permissions::from_mode(0)).unwrap();
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

    fn refresh(db: &crate::database::Database, home: &Path, tool: &str) -> Vec<crate::history::HistoryDetail> {
        let registry = crate::adapters::Registry::builtins();
        let reports = crate::history::refresh_controlled(db, &registry, home, &[tool.to_owned()], &|| false).unwrap();
        let report = reports.iter().find(|item| item.tool_id == tool).expect("scan report");
        assert!(!report.incomplete, "{}", report.detail);
        assert_eq!(report.failed_count, 0, "{}", report.detail);
        crate::history::list(db, &crate::history::HistoryFilter { tool_id: Some(tool.to_owned()), ..crate::history::HistoryFilter::default() })
            .unwrap()
            .into_iter()
            .map(|session| {
                assert!(!session.stale, "{}", session.title);
                crate::history::detail(db, &session.id).unwrap()
            })
            .collect()
    }

    #[test]
    fn unlistable_child_directory_keeps_every_parent() {
        let temp = tempfile::tempdir().unwrap();
        let projects = temp.path().join(".codebuddy/projects/demo-workspace");
        let session_id = "0aa0fb40-0b9c-74c9-8d7c-cd5d630dc6f0";
        let other = "11111111-1111-4111-8111-111111111111";
        let wires = projects.join(format!("{session_id}/subagents"));
        fs::create_dir_all(&wires).unwrap();
        fs::write(projects.join(format!("{session_id}.jsonl")), format!(
            r#"{{"id":"m1","type":"message","role":"user","timestamp":1789000000000,"sessionId":"{session_id}","providerData":{{"agent":"cli","conversationRequestId":"turn-1","messageId":"call-1"}},"content":[{{"type":"text","text":"父会话仍在"}}]}}
{{"id":"parent-row","type":"message","role":"assistant","timestamp":1789000001000,"sessionId":"{session_id}","providerData":{{"agent":"cli","conversationRequestId":"turn-1","messageId":"call-1","model":"kimi-k3-2","usage":{{"requests":1,"inputTokens":10,"outputTokens":1,"totalTokens":11,"inputTokensDetails":[],"outputTokensDetails":[]}}}},"content":[{{"type":"text","text":"父回复"}}]}}"#
        )).unwrap();
        fs::write(wires.join("agent-hidden.jsonl"), r#"{"id":"c1","type":"message","role":"assistant","content":[{"type":"text","text":"子日志正文"}]}"#).unwrap();
        fs::write(projects.join(format!("{other}.jsonl")), format!(
            r#"{{"id":"o1","type":"message","role":"user","timestamp":1789000000000,"sessionId":"{other}","content":[{{"type":"text","text":"另一父会话"}}]}}"#
        )).unwrap();
        let _deny = DenyList::new(&wires);
        let found = sources(temp.path()).unwrap();
        assert_eq!(found.len(), 2, "子目录列举失败不能让本次发现整体失败");
        assert!(found.iter().all(|item| item.fingerprint_error.is_none() && item.fingerprint.starts_with("codebuddy-session-v5|")));
        let parent = found.iter().find(|item| item.path.ends_with(format!("{session_id}.jsonl"))).unwrap();
        assert!(parent.fingerprint.contains("children-unread"));
        let parsed = parse(parent).unwrap();
        assert!(parsed.messages.iter().any(|message| message.text == "父会话仍在"));
        assert!(parsed.messages.iter().all(|message| message.text != "子日志正文"));
        assert!(parsed.usage.iter().any(|event| event.attributions.iter().any(|item| item.kind == AgentKind::Main && item.name.as_deref() == Some("cli"))));
        let unread = parsed.children.iter().find(|child| !child.readable).unwrap();
        assert!(unread.messages.is_empty() && unread.name.is_none());
    }

    #[test]
    fn locked_child_is_indexed_on_the_parent_and_reread_when_it_unlocks() {
        let temp = tempfile::tempdir().unwrap();
        let projects = temp.path().join(".codebuddy/projects/demo-workspace");
        let session_id = "0aa0fb40-0b9c-74c9-8d7c-cd5d630dc6f0";
        let wires = projects.join(format!("{session_id}/subagents"));
        fs::create_dir_all(&wires).unwrap();
        let usage = |tokens: u64| {
            format!(r#"{{"requests":1,"inputTokens":{tokens},"outputTokens":1,"totalTokens":{tokens},"inputTokensDetails":[],"outputTokensDetails":[]}}"#)
        };
        fs::write(projects.join(format!("{session_id}.jsonl")), format!(
            r#"{{"id":"m1","type":"message","role":"user","timestamp":1789000000000,"sessionId":"{session_id}","providerData":{{"agent":"cli"}},"content":[{{"type":"text","text":"父会话仍在"}}]}}
{{"id":"parent-row","type":"message","role":"assistant","timestamp":1789000001000,"sessionId":"{session_id}","providerData":{{"agent":"cli","conversationRequestId":"turn-1","messageId":"call-1","model":"kimi-k3-2","usage":{usage}}},"content":[{{"type":"text","text":"父回复"}}]}}
{{"id":"parent-other","type":"function_call","timestamp":1789000001100,"sessionId":"{session_id}","providerData":{{"agent":"cli","conversationRequestId":"turn-1","messageId":"call-2","model":"kimi-k3-2","usage":{other}}}}}
"#,
            usage = usage(10),
            other = usage(20),
        )).unwrap();
        let locked = wires.join("agent-locked.jsonl");
        fs::write(&locked, format!(
            r#"{{"id":"child-row","type":"message","role":"assistant","timestamp":1789000002000,"sessionId":"child-session-id","providerData":{{"agent":"Explore","isSubAgent":true,"conversationRequestId":"turn-1","messageId":"call-1","model":"kimi-k3-2","usage":{usage}}},"content":[{{"type":"text","text":"子日志正文"}}]}}
{{"id":"child-other","type":"function_call","timestamp":1789000002100,"sessionId":"child-session-id","providerData":{{"agent":"Explore","conversationRequestId":"turn-1","messageId":"call-9","usage":{other}}}}}
"#,
            usage = usage(99),
            other = usage(7),
        )).unwrap();
        let db = crate::database::Database::open(&temp.path().join("index.db")).unwrap();
        let blocked = {
            let _lock = lock_exclusive(&locked);
            let parent = sources(temp.path()).unwrap().remove(0);
            assert!(parent.fingerprint_error.is_none(), "{:?}", parent.fingerprint_error);
            let details = refresh(&db, temp.path(), "codebuddy");
            assert_eq!(details.len(), 1);
            let detail = &details[0];
            assert_eq!(detail.session.native_id.as_deref(), Some(session_id));
            assert!(detail.messages.iter().any(|message| message.text == "父会话仍在"));
            assert!(detail.messages.iter().all(|message| message.text != "子日志正文"));
            assert!(detail.usage.iter().any(|event| event.attributions.iter().any(|item| item.kind == AgentKind::Main && item.name.as_deref() == Some("cli"))));
            assert!(detail.usage.iter().all(|event| !event.id.contains("child-other")));
            let unread = detail.children.iter().find(|child| !child.readable).unwrap();
            assert!(unread.messages.is_empty() && unread.name.is_none());
            parent.fingerprint
        };
        let parent = sources(temp.path()).unwrap().remove(0);
        assert_ne!(parent.fingerprint, blocked, "子文件恢复可读后父指纹必须变化");
        let details = refresh(&db, temp.path(), "codebuddy");
        let detail = &details[0];
        assert!(detail.messages.iter().all(|message| message.text != "子日志正文"));
        assert_eq!(detail.usage.len(), 3, "同一 messageId 不新增用量");
        let shared = detail.usage.iter().find(|event| event.id == "codebuddy:usage:parent-row").unwrap();
        assert_eq!(shared.input, Some(10));
        assert!(shared.attributions.iter().any(|item| item.kind == AgentKind::Main));
        assert!(shared.attributions.iter().any(|item| item.kind == AgentKind::Subagent && item.name.as_deref() == Some("Explore") && item.session_key.as_deref() == Some("child-session-id")));
        let child = detail.children.iter().find(|child| child.readable).unwrap();
        assert!(child.messages.iter().any(|message| message.text == "子日志正文"));
    }
}
