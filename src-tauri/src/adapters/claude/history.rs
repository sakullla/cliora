use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::history::usage::{self, RequestUsage};
use crate::history::{
    check_cancelled, contains_bytes, discover_jsonl_controlled, read_jsonl_filtered,
    source_fingerprint_controlled, text_content, timestamp, valid_native_id, AgentKind,
    ChildSession, HistoryMessage, HistoryMessageKind, HistorySource, MessageTimeSource,
    ParsedSession, UsageAttribution, UsageEvent,
};

pub fn sources(home: &Path) -> Result<Vec<HistorySource>, String> {
    sources_controlled(home, &|| false)
}

pub fn sources_controlled(
    home: &Path,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<HistorySource>, String> {
    let mut sources = discover_jsonl_controlled(
        &crate::accounts::selection::history_root("claude_code", || home.join(".claude/projects")),
        |path| {
            path.extension().is_some_and(|value| value == "jsonl")
                && !path
                    .components()
                    .any(|part| part.as_os_str() == "subagents")
        },
        cancelled,
    )?;
    for source in &mut sources {
        // v2 rereads sessions once so stored rows gain child bodies and attribution.
        source.fingerprint = format!("claude-title-v2|{}", source.fingerprint);
        if source.fingerprint_error.is_some() {
            continue;
        }
        match subagent_fingerprint(&source.path, cancelled) {
            Ok(Some(extra)) => source.fingerprint = format!("{}|{extra}", source.fingerprint),
            Ok(None) => {}
            Err(error) => source.fingerprint_error = Some(error),
        }
    }
    Ok(sources)
}

fn subagent_root(session_file: &Path) -> Option<PathBuf> {
    let stem = session_file.file_stem()?.to_str()?;
    let root = session_file.parent()?.join(stem).join("subagents");
    (root.is_dir() && !root.is_symlink()).then_some(root)
}

fn subagent_files(session_file: &Path) -> Result<Vec<PathBuf>, String> {
    let Some(root) = subagent_root(session_file) else {
        return Ok(Vec::new());
    };
    let mut files = Vec::new();
    let mut pending = vec![(root, 0usize)];
    while let Some((directory, depth)) = pending.pop() {
        for entry in fs::read_dir(&directory).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let kind = entry.file_type().map_err(|error| error.to_string())?;
            if kind.is_symlink() {
                continue;
            }
            let path = entry.path();
            if kind.is_dir() && depth < 6 {
                pending.push((path, depth + 1));
            } else if kind.is_file() && path.extension().is_some_and(|value| value == "jsonl") {
                files.push(path);
            }
        }
    }
    files.sort();
    Ok(files)
}

fn subagent_fingerprint(
    session_file: &Path,
    cancelled: &dyn Fn() -> bool,
) -> Result<Option<String>, String> {
    let files = subagent_files(session_file)?;
    if files.is_empty() {
        return Ok(None);
    }
    let mut digest = Sha256::new();
    for path in files {
        check_cancelled(cancelled)?;
        digest.update(path.to_string_lossy().as_bytes());
        digest.update(source_fingerprint_controlled(&path, cancelled)?.as_bytes());
    }
    Ok(Some(format!("{:x}", digest.finalize())))
}

pub fn parse(source: &HistorySource) -> Result<ParsedSession, String> {
    parse_controlled(source, &|| false)
}

/// Tool results are user rows whose content is only `tool_result` blocks. They hold most
/// of a transcript's bytes but never visible text or usage, so they are not parsed.
fn skip_row(raw: &[u8]) -> bool {
    contains_bytes(raw, b"\"type\":\"user\"")
        && contains_bytes(raw, b"\"type\":\"tool_result\"")
        && !contains_bytes(raw, b"\"type\":\"text\"")
}

pub fn parse_controlled(
    source: &HistorySource,
    cancelled: &dyn Fn() -> bool,
) -> Result<ParsedSession, String> {
    let mut session = ParsedSession::new();
    let mut events = BTreeMap::<String, RequestUsage>::new();
    let mut attributions = BTreeMap::<String, Vec<UsageAttribution>>::new();
    let mut seen = HashSet::new();
    let partial = read_jsonl_filtered(source, cancelled, skip_row, |line, row| {
        let kind = row.get("type").and_then(Value::as_str).unwrap_or("");
        if matches!(kind, "ai-title" | "custom-title") {
            if let Some(title) = row.get("customTitle").or_else(|| row.get("aiTitle")).and_then(Value::as_str).filter(|title| !title.trim().is_empty()) {
                session.title = title.trim().to_owned();
            }
            return;
        }
        if kind != "user" && kind != "assistant" {
            return;
        }
        let time = row.get("timestamp").and_then(timestamp);
        let message = row.get("message").unwrap_or(&Value::Null);
        let body = message.get("content").map(text_content).unwrap_or_default();
        let id = row
            .get("uuid")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("line-{line}"));
        if seen.insert(id.clone()) {
            session.add_message(id, kind, body, time);
        }
        if session.native_id.is_none() {
            session.native_id = row
                .get("sessionId")
                .and_then(Value::as_str)
                .filter(|id| valid_native_id(id))
                .map(str::to_owned);
        }
        if session.cwd.is_none() {
            session.cwd = row.get("cwd").and_then(Value::as_str).map(str::to_owned);
        }
        if kind != "assistant" {
            return;
        }
        let attribution = UsageAttribution {
            kind: AgentKind::Main,
            name: claude_agent_name(&row),
            session_key: None,
        };
        if !fold_assistant(&mut events, "", &row, &mut session.model, &mut attributions, &attribution) {
            session.partial = true;
        }
    })?;
    session.partial |= partial;
    let mut used_keys = HashSet::new();
    match subagent_files(&source.path) {
        Ok(files) => {
            let root = subagent_root(&source.path);
            for path in files {
                let path_key = root
                    .as_ref()
                    .map(|root| relative_key(root, &path))
                    .filter(|key| valid_child_key(key))
                    .unwrap_or_else(|| "child".into());
                let nested = HistorySource {
                    native_title: None,
                    path,
                    native_id: None,
                    fingerprint: String::new(),
                    fingerprint_error: None,
                };
                let mut messages = Vec::new();
                let mut seen_ids = HashSet::new();
                let mut native_key = None;
                let mut native_name = None;
                let parent_id = session.native_id.clone();
                let read = read_jsonl_filtered(&nested, cancelled, skip_row, |line, row| {
                    if native_key.is_none() {
                        native_key = distinct_session_id(&row, parent_id.as_deref());
                    }
                    if native_name.is_none() {
                        native_name = claude_agent_name(&row);
                    }
                    let kind = row.get("type").and_then(Value::as_str).unwrap_or("");
                    if kind == "user" || kind == "assistant" {
                        let time = row.get("timestamp").and_then(timestamp);
                        let message = row.get("message").unwrap_or(&Value::Null);
                        let body = message.get("content").map(text_content).unwrap_or_default();
                        let id = row
                            .get("uuid")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                            .unwrap_or_else(|| format!("line-{line}"));
                        if seen_ids.insert(id.clone()) {
                            push_child_message(&mut messages, id, kind, body, time);
                        }
                    }
                    if kind != "assistant" {
                        return;
                    }
                    let attribution = UsageAttribution {
                        kind: AgentKind::Subagent,
                        name: native_name.clone(),
                        session_key: Some(path_key.clone()),
                    };
                    if !fold_assistant(&mut events, &path_key, &row, &mut session.model, &mut attributions, &attribution) {
                        session.partial = true;
                    }
                });
                match read {
                    Ok(nested_partial) => {
                        session.partial |= nested_partial;
                        let key = claim_child_key(&mut used_keys, native_key.clone(), path_key.clone());
                        retarget_child(&mut attributions, &path_key, &key, native_name.as_deref());
                        session.children.push(ChildSession {
                            key,
                            name: native_name,
                            messages,
                            readable: true,
                            children: Vec::new(),
                        });
                    }
                    Err(_) => {
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
        }
        Err(_) => session.partial = true,
    }
    session.usage = events
        .into_iter()
        .map(|(id, event)| UsageEvent {
            native_usage: None,
            request_count: Some(1),
            id: id.clone(),
            model: event.model,
            timestamp: event.timestamp,
            input: Some(event.counts.input),
            output: Some(event.counts.output),
            cache_read: Some(event.counts.read),
            cache_write: Some(event.counts.write),
            input_includes_cache: false,
            attributions: attributions.remove(&id).unwrap_or_default(),
        })
        .collect();
    session.finish(source)
}

fn valid_child_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 512 && key.chars().all(|ch| !ch.is_control())
}

fn relative_key(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|part| part.as_os_str().to_string_lossy().replace('\\', "/"))
        .collect::<Vec<_>>()
        .join("/")
}

/// A child session id is its own identity. The parent id is not a child key,
/// and a file name is never used as the display name.
fn distinct_session_id(row: &Value, parent: Option<&str>) -> Option<String> {
    let id = row.get("sessionId").and_then(Value::as_str)?;
    if !valid_native_id(id) || parent == Some(id) {
        return None;
    }
    Some(id.to_owned())
}

/// Verified child rows have no agent name. Only an explicit native name is kept.
fn claude_agent_name(row: &Value) -> Option<String> {
    for key in ["agentName", "subagentName", "subagent_type"] {
        if let Some(name) = row.get(key).and_then(Value::as_str).map(str::trim).filter(|name| !name.is_empty()) {
            return Some(name.chars().take(256).collect());
        }
    }
    None
}

fn claim_child_key(used: &mut HashSet<String>, native: Option<String>, fallback: String) -> String {
    let preferred = native.filter(|key| valid_child_key(key)).unwrap_or_else(|| fallback.clone());
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

fn retarget_child(attributions: &mut BTreeMap<String, Vec<UsageAttribution>>, from_key: &str, to_key: &str, name: Option<&str>) {
    for items in attributions.values_mut() {
        for item in items.iter_mut() {
            if item.kind == AgentKind::Subagent && item.session_key.as_deref() == Some(from_key) {
                item.session_key = Some(to_key.to_owned());
                if item.name.is_none() {
                    item.name = name.map(str::to_owned);
                }
            }
        }
        let mut kept = Vec::new();
        for item in items.drain(..) {
            if !kept.iter().any(|other: &UsageAttribution| other == &item) {
                kept.push(item);
            }
        }
        *items = kept;
    }
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

fn remember(attributions: &mut BTreeMap<String, Vec<UsageAttribution>>, key: &str, attribution: &UsageAttribution) {
    let items = attributions.entry(key.to_owned()).or_default();
    if !items.iter().any(|item| item == attribution) {
        items.push(attribution.clone());
    }
}

fn request_key(message_id: Option<&str>, request_id: Option<&str>) -> Option<String> {
    match (message_id, request_id) {
        (Some(message), Some(request)) => Some(format!("{message}:{request}")),
        (Some(message), None) => Some(message.to_owned()),
        (None, Some(request)) => Some(request.to_owned()),
        (None, None) => None,
    }
}

fn cache_write(usage: &Value) -> Option<u64> {
    let flat = usage::field(usage, "cache_creation_input_tokens");
    let nested = usage.get("cache_creation").map(|value| {
        usage::field(value, "ephemeral_5m_input_tokens").unwrap_or(0)
            + usage::field(value, "ephemeral_1h_input_tokens").unwrap_or(0)
    });
    match (flat, nested) {
        (None, None) => None,
        (flat, nested) => Some(flat.unwrap_or(0).max(nested.unwrap_or(0))),
    }
}

/// Returns false when an assistant row has usage but no request identity.
fn fold_assistant(
    events: &mut BTreeMap<String, RequestUsage>,
    prefix: &str,
    row: &Value,
    session_model: &mut Option<String>,
    attributions: &mut BTreeMap<String, Vec<UsageAttribution>>,
    attribution: &UsageAttribution,
) -> bool {
    let message = row.get("message").unwrap_or(&Value::Null);
    let model = message
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if model.as_deref() == Some("<synthetic>") {
        return true;
    }
    if let Some(model) = model.clone() {
        *session_model = Some(model);
    }
    let Some(usage) = message.get("usage") else {
        return true;
    };
    let request_id = row.get("requestId").and_then(Value::as_str).filter(|id| !id.trim().is_empty());
    let Some(key) = request_key(message.get("id").and_then(Value::as_str), request_id) else {
        return usage.as_object().is_none_or(|fields| fields.is_empty());
    };
    // requestId is one call even when the child log repeats it. Without that
    // id, the file key keeps a different log from collapsing into this one.
    let key = if prefix.is_empty() || request_id.is_some() {
        key
    } else {
        format!("{prefix}:{key}")
    };
    let time = row.get("timestamp").and_then(timestamp);
    if let Some(counts) = usage::from_optional(
        usage::field(usage, "input_tokens"),
        usage::field(usage, "output_tokens"),
        usage::field(usage, "cache_read_input_tokens"),
        cache_write(usage),
    ) {
        if usage::active(counts) {
            usage::keep_largest_output(
                events,
                key.clone(),
                RequestUsage {
                    counts,
                    model: model.clone(),
                    timestamp: time,
                },
            );
            remember(attributions, &key, attribution);
        }
    }
    // `iterations[].type == "message"` is already inside the top-level counters.
    // Each `advisor_message` is a separate billed call and is not.
    let Some(iterations) = usage.get("iterations").and_then(Value::as_array) else {
        return true;
    };
    let mut advisor = 0u32;
    for iteration in iterations {
        if iteration.get("type").and_then(Value::as_str) != Some("advisor_message") {
            continue;
        }
        let Some(counts) = usage::from_optional(
            usage::field(iteration, "input_tokens"),
            usage::field(iteration, "output_tokens"),
            usage::field(iteration, "cache_read_input_tokens"),
            cache_write(iteration),
        ) else {
            continue;
        };
        if !usage::active(counts) {
            continue;
        }
        let advisor_model = iteration
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| model.clone());
        let advisor_key = format!("{key}:advisor:{advisor}");
        usage::keep_largest_output(
            events,
            advisor_key.clone(),
            RequestUsage {
                counts,
                model: advisor_model,
                timestamp: time,
            },
        );
        remember(attributions, &advisor_key, attribution);
        advisor += 1;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(path: PathBuf) -> HistorySource {
        HistorySource {
            native_title: None,
            path,
            native_id: None,
            fingerprint: "test".into(),
            fingerprint_error: None,
        }
    }

    #[test]
    fn association_descriptor_is_available() {
        let published = crate::adapters::PublishedDescriptor::from_adapter(&crate::adapters::claude::Claude);
        let facet = published.association.expect("association");
        assert_eq!(facet.state, "available");
    }

    #[test]
    fn shared_request_stays_one_event_and_child_text_stays_out_of_the_parent() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        let id = "22222222-2222-4222-8222-222222222222";
        let child_id = "33333333-3333-4333-8333-333333333333";
        let wires = root.join(id).join("subagents");
        fs::create_dir_all(wires.join("nested")).unwrap();
        fs::write(
            root.join(format!("{id}.jsonl")),
            format!(
                r#"{{"type":"user","uuid":"u1","sessionId":"{id}","timestamp":"2026-09-29T08:00:00Z","message":{{"role":"user","content":"父会话正文"}}}}
{{"type":"assistant","uuid":"a1","requestId":"req-shared","sessionId":"{id}","timestamp":"2026-09-29T08:00:01Z","message":{{"id":"msg-shared","model":"claude-opus","content":"父回复","usage":{{"input_tokens":5,"output_tokens":4,"cache_read_input_tokens":1,"cache_creation_input_tokens":0}}}}}}
"#
            ),
        )
        .unwrap();
        fs::write(
            wires.join("agent-named.jsonl"),
            format!(
                r#"{{"type":"user","uuid":"c-user","sessionId":"{child_id}","agentName":"审查","timestamp":"2026-09-29T08:00:02Z","message":{{"role":"user","content":"子日志正文"}}}}
{{"type":"assistant","uuid":"c1","requestId":"req-shared","sessionId":"{child_id}","agentName":"审查","timestamp":"2026-09-29T08:00:03Z","message":{{"id":"msg-shared","model":"claude-sonnet","content":"子日志回复","usage":{{"input_tokens":9,"output_tokens":8,"cache_read_input_tokens":2,"cache_creation_input_tokens":0}}}}}}
{{"type":"assistant","uuid":"c2","requestId":"req-only","sessionId":"{child_id}","timestamp":"2026-09-29T08:00:04Z","message":{{"id":"msg-only","model":"claude-sonnet","content":"仅子日志","usage":{{"input_tokens":3,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}}}}
"#
            ),
        )
        .unwrap();
        let locked = wires.join("nested").join("agent-locked.jsonl");
        fs::write(&locked, "{\"type\":\"assistant\",\"message\":{\"content\":\"不可读正文\"}}\n").unwrap();
        let _lock = lock_exclusive(&locked);
        let parsed = parse(&source(root.join(format!("{id}.jsonl")))).unwrap();
        assert!(parsed.messages.iter().any(|message| message.text == "父会话正文"));
        assert!(parsed.messages.iter().all(|message| !message.text.contains("子日志") && !message.text.contains("不可读")));
        assert_eq!(parsed.usage.len(), 2, "{:?}", parsed.usage.iter().map(|event| &event.id).collect::<Vec<_>>());
        let shared = parsed.usage.iter().find(|event| event.id == "msg-shared:req-shared").unwrap();
        assert_eq!(shared.output, Some(8), "同一请求保留较大的输出，不另计一条");
        assert!(shared.attributions.iter().any(|item| item.kind == AgentKind::Main && item.session_key.is_none()));
        assert!(shared.attributions.iter().any(|item| {
            item.kind == AgentKind::Subagent && item.name.as_deref() == Some("审查") && item.session_key.as_deref() == Some(child_id)
        }));
        let only = parsed.usage.iter().find(|event| event.id == "msg-only:req-only").unwrap();
        assert!(only.attributions.iter().all(|item| item.kind == AgentKind::Subagent));
        let child = parsed.children.iter().find(|child| child.key == child_id).unwrap();
        assert!(child.readable);
        assert_eq!(child.name.as_deref(), Some("审查"));
        assert!(child.messages.iter().any(|message| message.text == "子日志正文"));
        assert!(child.messages.iter().any(|message| message.text == "仅子日志"));
        let unread = parsed.children.iter().find(|child| !child.readable).unwrap();
        assert!(unread.messages.is_empty());
        assert!(unread.name.is_none());
        assert!(!unread.key.contains("不可读"));
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
}
