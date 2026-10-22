use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::history::usage::{self, RequestUsage};
use crate::history::{
    check_cancelled, contains_bytes, discover_jsonl_controlled_in, discover_jsonl_with_control,
    read_jsonl_filtered, source_fingerprint_controlled, text_content, timestamp, valid_native_id,
    AgentKind, ChildSession, HistoryMessage, HistoryMessageKind, HistorySource, MessageTimeSource,
    ParsedSession, UsageAttribution, UsageEvent,
};

pub fn sources(home: &Path) -> Result<Vec<HistorySource>, String> {
    sources_controlled(home, &|| false)
}

fn projects_root(home: &Path) -> PathBuf {
    crate::accounts::selection::history_root("claude_code", || home.join(".claude/projects"))
}

fn session_transcript(path: &Path) -> bool {
    path.extension().is_some_and(|value| value == "jsonl")
        && !path
            .components()
            .any(|part| part.as_os_str() == "subagents")
}

/// Child logs are not sessions. Listing them here would fail every parent
/// when that directory cannot be read.
fn descend_sessions(path: &Path) -> bool {
    path.file_name().is_none_or(|name| name != "subagents")
}

/// Paths memory must keep away from. Same files as `sources`, without opening
/// or fingerprinting transcripts and child logs.
pub fn exclusion_paths(home: &Path) -> Result<Vec<PathBuf>, String> {
    let sources = discover_jsonl_with_control(
        &projects_root(home),
        session_transcript,
        |_| Ok(String::new()),
        &|| false,
        &descend_sessions,
    )?;
    Ok(sources.into_iter().map(|source| source.path).collect())
}

pub fn sources_controlled(
    home: &Path,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<HistorySource>, String> {
    let mut sources = discover_jsonl_controlled_in(
        &projects_root(home),
        session_transcript,
        cancelled,
        descend_sessions,
    )?;
    for source in &mut sources {
        // v2 rereads sessions once so stored rows gain child bodies and attribution.
        source.fingerprint = format!("claude-title-v2|{}", source.fingerprint);
        if source.fingerprint_error.is_some() {
            continue;
        }
        // A child fingerprint or listing failure stays out of fingerprint_error
        // so the scan still parses this parent. The extra still changes when
        // the child material changes or becomes readable again.
        if let Some(extra) = subagent_fingerprint(&source.path, cancelled)? {
            source.fingerprint = format!("{}|{extra}", source.fingerprint);
        }
    }
    Ok(sources)
}

fn subagent_root(session_file: &Path) -> Option<PathBuf> {
    let stem = session_file.file_stem()?.to_str()?;
    let root = session_file.parent()?.join(stem).join("subagents");
    (root.is_dir() && !root.is_symlink()).then_some(root)
}

struct ListedSubagents {
    files: Vec<PathBuf>,
    unlistable: Vec<PathBuf>,
}

fn list_subagents(session_file: &Path, cancelled: &dyn Fn() -> bool) -> Result<ListedSubagents, String> {
    let Some(root) = subagent_root(session_file) else {
        return Ok(ListedSubagents { files: Vec::new(), unlistable: Vec::new() });
    };
    let mut files = Vec::new();
    let mut unlistable = Vec::new();
    let mut pending = vec![(root, 0usize)];
    while let Some((directory, depth)) = pending.pop() {
        check_cancelled(cancelled)?;
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) => {
                if scan_cancelled(&error.to_string()) {
                    return Err(error.to_string());
                }
                unlistable.push(directory);
                continue;
            }
        };
        for entry in entries {
            check_cancelled(cancelled)?;
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    if scan_cancelled(&error.to_string()) {
                        return Err(error.to_string());
                    }
                    if !unlistable.iter().any(|item| item == &directory) {
                        unlistable.push(directory.clone());
                    }
                    continue;
                }
            };
            let kind = match entry.file_type() {
                Ok(kind) => kind,
                Err(_) => {
                    if !unlistable.iter().any(|item| item == &directory) {
                        unlistable.push(directory.clone());
                    }
                    continue;
                }
            };
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
    unlistable.sort();
    Ok(ListedSubagents { files, unlistable })
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
    // the body can be opened again.
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

fn subagent_fingerprint(
    session_file: &Path,
    cancelled: &dyn Fn() -> bool,
) -> Result<Option<String>, String> {
    let listed = list_subagents(session_file, cancelled)?;
    if listed.files.is_empty() && listed.unlistable.is_empty() {
        return Ok(None);
    }
    let mut digest = Sha256::new();
    for path in &listed.unlistable {
        check_cancelled(cancelled)?;
        digest.update(b"unread-dir");
        digest.update(path.to_string_lossy().as_bytes());
        digest.update(unread_material_stamp(path).as_bytes());
    }
    for path in &listed.files {
        check_cancelled(cancelled)?;
        digest.update(path.to_string_lossy().as_bytes());
        digest.update(child_material_stamp(path, cancelled)?.as_bytes());
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
    let listed = list_subagents(&source.path, cancelled)?;
    let root = subagent_root(&source.path);
    for path in listed.files {
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
    for _path in listed.unlistable {
        session.partial = true;
        let key = claim_child_key(&mut used_keys, None, "child".into());
        session.children.push(ChildSession {
            key,
            name: None,
            messages: Vec::new(),
            readable: false,
            children: Vec::new(),
        });
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
    fn exclusion_paths_match_session_files_and_skip_child_logs() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = home.join(".claude").join("projects").join("slug");
        let child = project
            .join("22222222-2222-4222-8222-222222222222")
            .join("subagents");
        fs::create_dir_all(&child).unwrap();
        let parent = project.join("22222222-2222-4222-8222-222222222222.jsonl");
        fs::write(&parent, "{\"cwd\":\"C:\\\\work\"}\n").unwrap();
        fs::write(child.join("agent.jsonl"), "{\"cwd\":\"C:\\\\hidden\"}\n").unwrap();
        fs::write(project.join("notes.txt"), "not a session\n").unwrap();
        let mut excluded = exclusion_paths(&home).unwrap();
        let mut discovered = sources(&home)
            .unwrap()
            .into_iter()
            .map(|source| source.path)
            .collect::<Vec<_>>();
        excluded.sort();
        discovered.sort();
        assert_eq!(excluded, discovered);
        assert_eq!(excluded, vec![parent]);
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
            return ExclusiveLock {
                _file: fs::OpenOptions::new().read(true).share_mode(0).open(path).unwrap(),
            };
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

    fn deny_list(path: &Path) -> DenyList {
        DenyList::new(path)
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
                fs::set_permissions(path, fs::Permissions::from_mode(0o0)).unwrap();
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
        let projects = temp.path().join(".claude/projects/demo");
        let id = "22222222-2222-4222-8222-222222222222";
        let other = "44444444-4444-4444-8444-444444444444";
        let wires = projects.join(id).join("subagents");
        fs::create_dir_all(&wires).unwrap();
        fs::write(projects.join(format!("{id}.jsonl")), format!(
            r#"{{"type":"user","uuid":"u1","sessionId":"{id}","timestamp":"2026-09-29T08:00:00Z","message":{{"role":"user","content":"父会话正文"}}}}
{{"type":"assistant","uuid":"a1","requestId":"req-main","sessionId":"{id}","timestamp":"2026-09-29T08:00:01Z","message":{{"id":"msg-main","model":"claude-opus","content":"父回复","usage":{{"input_tokens":5,"output_tokens":4,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}}}}
"#
        )).unwrap();
        fs::write(wires.join("agent-hidden.jsonl"), "{\"type\":\"user\",\"message\":{\"content\":\"子日志正文\"}}\n").unwrap();
        fs::write(projects.join(format!("{other}.jsonl")), format!(
            r#"{{"type":"user","uuid":"u2","sessionId":"{other}","timestamp":"2026-09-29T08:00:00Z","message":{{"role":"user","content":"另一父会话"}}}}"#
        )).unwrap();
        let _deny = deny_list(&wires);
        let found = sources_controlled(temp.path(), &|| false).unwrap();
        assert_eq!(found.len(), 2, "子目录列举失败不能让本次发现整体失败");
        assert!(found.iter().all(|item| item.fingerprint_error.is_none() && !item.fingerprint.is_empty()));
        let parent = found.iter().find(|item| item.path.ends_with(format!("{id}.jsonl"))).unwrap();
        let parsed = parse(parent).unwrap();
        assert!(parsed.messages.iter().any(|message| message.text == "父会话正文"));
        assert!(parsed.messages.iter().all(|message| message.text != "子日志正文"));
        assert!(parsed.usage.iter().any(|event| event.attributions.iter().any(|item| item.kind == AgentKind::Main)));
        let unread = parsed.children.iter().find(|child| !child.readable).unwrap();
        assert!(unread.messages.is_empty());
        assert!(unread.name.is_none());
    }

    #[test]
    fn locked_child_is_indexed_on_the_parent_and_reread_when_it_unlocks() {
        let temp = tempfile::tempdir().unwrap();
        let projects = temp.path().join(".claude/projects/demo");
        let id = "22222222-2222-4222-8222-222222222222";
        let child_id = "33333333-3333-4333-8333-333333333333";
        let wires = projects.join(id).join("subagents");
        fs::create_dir_all(&wires).unwrap();
        fs::write(projects.join(format!("{id}.jsonl")), format!(
            r#"{{"type":"user","uuid":"u1","sessionId":"{id}","timestamp":"2026-09-29T08:00:00Z","message":{{"role":"user","content":"父会话正文"}}}}
{{"type":"assistant","uuid":"a1","requestId":"req-shared","sessionId":"{id}","timestamp":"2026-09-29T08:00:01Z","message":{{"id":"msg-shared","model":"claude-opus","content":"父回复","usage":{{"input_tokens":5,"output_tokens":4,"cache_read_input_tokens":1,"cache_creation_input_tokens":0}}}}}}
"#
        )).unwrap();
        let locked = wires.join("agent-locked.jsonl");
        fs::write(&locked, format!(
            r#"{{"type":"user","uuid":"c-user","sessionId":"{child_id}","agentName":"审查","timestamp":"2026-09-29T08:00:02Z","message":{{"role":"user","content":"子日志正文"}}}}
{{"type":"assistant","uuid":"c1","requestId":"req-shared","sessionId":"{child_id}","agentName":"审查","timestamp":"2026-09-29T08:00:03Z","message":{{"id":"msg-shared","model":"claude-sonnet","content":"子日志回复","usage":{{"input_tokens":9,"output_tokens":8,"cache_read_input_tokens":2,"cache_creation_input_tokens":0}}}}}}
{{"type":"assistant","uuid":"c2","requestId":"req-only","sessionId":"{child_id}","timestamp":"2026-09-29T08:00:04Z","message":{{"id":"msg-only","model":"claude-sonnet","content":"仅子日志","usage":{{"input_tokens":3,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}}}}
"#
        )).unwrap();
        let db = crate::database::Database::open(&temp.path().join("index.db")).unwrap();
        let blocked = {
            let _lock = lock_exclusive(&locked);
            let found = sources_controlled(temp.path(), &|| false).unwrap();
            let parent = found.iter().find(|item| item.path.ends_with(format!("{id}.jsonl"))).unwrap();
            assert!(parent.fingerprint_error.is_none(), "{:?}", parent.fingerprint_error);
            assert!(!parent.fingerprint.is_empty());
            let details = refresh(&db, temp.path(), "claude_code");
            let detail = details.iter().find(|item| item.session.native_id.as_deref() == Some(id)).unwrap();
            assert!(detail.messages.iter().any(|message| message.text == "父会话正文"));
            assert!(detail.messages.iter().all(|message| !message.text.contains("子日志")));
            assert!(detail.usage.iter().any(|event| event.attributions.iter().any(|item| item.kind == AgentKind::Main && item.session_key.is_none())));
            assert!(detail.usage.iter().all(|event| event.id != "msg-only:req-only"));
            let unread = detail.children.iter().find(|child| !child.readable).unwrap();
            assert!(unread.messages.is_empty() && unread.name.is_none());
            parent.fingerprint.clone()
        };
        let found = sources_controlled(temp.path(), &|| false).unwrap();
        let parent = found.iter().find(|item| item.path.ends_with(format!("{id}.jsonl"))).unwrap();
        assert_ne!(parent.fingerprint, blocked, "子文件恢复可读后父指纹必须变化");
        let details = refresh(&db, temp.path(), "claude_code");
        let detail = details.iter().find(|item| item.session.native_id.as_deref() == Some(id)).unwrap();
        assert!(detail.messages.iter().all(|message| !message.text.contains("子日志")));
        assert_eq!(detail.usage.len(), 2, "同一请求不新增用量");
        let shared = detail.usage.iter().find(|event| event.id == "msg-shared:req-shared").unwrap();
        assert!(shared.attributions.iter().any(|item| item.kind == AgentKind::Main));
        assert!(shared.attributions.iter().any(|item| item.kind == AgentKind::Subagent && item.name.as_deref() == Some("审查")));
        let child = detail.children.iter().find(|child| child.key == child_id).unwrap();
        assert!(child.readable);
        assert!(child.messages.iter().any(|message| message.text == "子日志正文"));
    }
}
