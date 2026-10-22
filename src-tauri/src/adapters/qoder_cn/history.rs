//! Qoder CN 1.1.74: projects/<slug>/<uuid>.jsonl and sibling subagent wires.
//! Credits are native usage, not currency or remaining balance. Zero token
//! buckets in this release are placeholders and cannot establish a token price.
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::history::{self, AgentKind, ChildSession, HistoryMessage, HistoryMessageKind, HistorySource, MessageTimeSource, NativeUsage, ParsedSession, UsageAttribution, UsageEvent};

#[path = "history_transcript.rs"]
mod transcript;

fn session_stem(value: &str) -> bool {
    value.len() == 36 && value.bytes().enumerate().all(|(index, byte)| {
        if [8, 13, 18, 23].contains(&index) { byte == b'-' } else { byte.is_ascii_hexdigit() }
    })
}

pub fn sources(home: &Path, cancelled: &dyn Fn() -> bool) -> Result<Vec<HistorySource>, String> {
    let root = super::QODER_CN.config_root(home)?.join("projects");
    history::check_source_path(&root)?;
    let mut sources = history::discover_jsonl_controlled_in(&root, |path| {
        path.strip_prefix(&root).is_ok_and(|relative| relative.components().count() == 2)
            && path.extension().is_some_and(|extension| extension == "jsonl")
            && path.file_stem().and_then(|stem| stem.to_str()).is_some_and(session_stem)
    }, cancelled, |path| path.file_name().is_none_or(|name| name != "subagents"))?;
    for source in &mut sources {
        source.native_id = source.path.file_stem().and_then(|stem| stem.to_str()).map(str::to_owned);
        // The parent file's own fingerprint failure still skips the scan.
        // Child listing and fingerprint failures do not: they stay in the
        // parent stamp so a later readable child is rescanned.
        if source.fingerprint_error.is_some() {
            continue;
        }
        let mut parts = vec![source.fingerprint.clone()];
        parts.extend(child_fingerprint_parts(&source.path, cancelled)?);
        history::check_cancelled(cancelled)?;
        source.fingerprint = format!("qoder-cn-session-v4|{}", parts.join("|"));
    }
    Ok(sources)
}

fn child_fingerprint_parts(path: &Path, cancelled: &dyn Fn() -> bool) -> Result<Vec<String>, String> {
    match subagents(path, cancelled) {
        Ok(wires) => {
            let mut parts = Vec::with_capacity(wires.len());
            for wire in wires {
                if let Some(error) = &wire.fingerprint_error {
                    if cancelled() || scan_cancelled(error) {
                        return Err(error.clone());
                    }
                    parts.push(format!("{}:{}", wire.key(), unread_material_stamp(&wire.path)));
                } else if fs::File::open(&wire.path).is_err() {
                    // Metadata can be stamped while the body is still locked.
                    if cancelled() { return Err("扫描已取消，原索引已保留".into()); }
                    parts.push(format!("{}:unread:{}", wire.key(), wire.fingerprint));
                } else {
                    parts.push(format!("{}:{}", wire.key(), wire.fingerprint));
                }
            }
            Ok(parts)
        }
        Err(error) if cancelled() || scan_cancelled(&error) => Err(error),
        Err(_) => {
            let directory = subagent_directory(path).unwrap_or_else(|| path.to_path_buf());
            Ok(vec![format!("children-unread:{}", unread_material_stamp(&directory))])
        }
    }
}

fn scan_cancelled(error: &str) -> bool {
    error.contains("扫描已取消")
}

fn unread_material_stamp(path: &Path) -> String {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return format!("unread:{}", path.display());
    };
    let modified = metadata.modified().ok().and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok()).map(|value| value.as_nanos()).unwrap_or(0);
    format!("unread:{}:{modified}:{}", metadata.len(), path.display())
}

fn subagent_directory(path: &Path) -> Option<PathBuf> {
    let parent = path.parent()?;
    let stem = path.file_stem().and_then(|stem| stem.to_str()).filter(|stem| session_stem(stem))?;
    Some(parent.join(stem).join("subagents"))
}

fn subagents(path: &Path, cancelled: &dyn Fn() -> bool) -> Result<Vec<HistorySource>, String> {
    let parent = path.parent().ok_or("Qoder CN 会话目录无效")?;
    let stem = path.file_stem().and_then(|stem| stem.to_str()).filter(|stem| session_stem(stem)).ok_or("Qoder CN 会话 ID 无效")?;
    let root: PathBuf = parent.join(stem).join("subagents");
    history::check_source_path(&root)?;
    // Direct agent wires only. Nested directories are not child sessions, and
    // listing one of them must not hide the wires that can be read.
    let mut wires = history::discover_jsonl_controlled_in(&root, |path| {
        path.parent() == Some(root.as_path()) && path.extension().is_some_and(|extension| extension == "jsonl")
            && path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with("agent-"))
    }, cancelled, |_| false)?;
    wires.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(wires)
}

fn text(content: &Value) -> String {
    if let Some(value) = content.as_str() { return value.to_owned(); }
    content.as_array().into_iter().flatten()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>().join("\n")
}

struct UsageObservation {
    index: usize,
    credits: Option<f64>,
    original: Option<f64>,
    billable: Option<bool>,
}

fn record_usage(session: &mut ParsedSession, seen: &mut HashMap<String, UsageObservation>, row: &Value, source: &HistorySource, line: usize, time: Option<i64>, model: Option<String>, attribution: UsageAttribution) {
    let Some(message) = row.get("message") else { return; };
    let Some(usage) = message.get("usage").filter(|value| value.is_object()) else { return; };
    let number = |field: &str| usage.get(field).and_then(Value::as_f64).filter(|value| value.is_finite() && *value >= 0.0);
    if ["credits", "original_credits"].iter().any(|field| usage.get(field).is_some_and(|value| !value.is_null()) && number(field).is_none()) {
        session.partial = true;
    }
    let fields = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];
    let mut tokens = fields.map(|field| usage.get(field).and_then(Value::as_u64));
    // Only positive native token evidence disambiguates placeholder buckets.
    if !tokens.iter().flatten().any(|value| *value > 0) { tokens = [None; 4]; }
    let request = usage.get("request_id").and_then(Value::as_str).filter(|id| !id.trim().is_empty());
    let message_id = message.get("id").and_then(Value::as_str).filter(|id| !id.trim().is_empty());
    let native_session = row.get("sessionId").and_then(Value::as_str).filter(|id| history::valid_native_id(id))
        .or(source.native_id.as_deref());
    if number("credits").is_none() && tokens.iter().all(Option::is_none)
        && request.is_none() && (message_id.is_none() || native_session.is_none()) { return; }
    let (id, request_count) = if let Some(request) = request { (format!("request:{request}"), Some(1)) }
        // Message counters are not assumed globally unique across sessions.
        else if let (Some(id), Some(native_session)) = (message_id, native_session) { (format!("message:{native_session}:{id}"), Some(1)) }
        else {
            let identity = row.get("uuid").and_then(Value::as_str).map(str::to_owned).unwrap_or_else(|| format!("line-{line}"));
            (format!("{}:{identity}", source.key()), None)
        };
    let observed = seen.entry(id.clone()).or_insert_with(|| {
        let index = session.usage.len();
        session.usage.push(UsageEvent { native_usage: None, request_count, id, model, timestamp: time,
            input: None, output: None, cache_read: None, cache_write: None, input_includes_cache: false, attributions: Vec::new() });
        UsageObservation { index, credits: None, original: None, billable: None }
    });
    // Each field is an independent observation, including metadata arriving
    // before Credits. Missing/null fields never erase earlier known values;
    // explicit zero/false remain updates. Main and subagents share this map.
    observed.credits = number("credits").or(observed.credits);
    observed.original = number("original_credits").or(observed.original);
    observed.billable = usage.get("billable").and_then(Value::as_bool).or(observed.billable);
    let event = &mut session.usage[observed.index];
    if !event.attributions.iter().any(|item| item == &attribution) { event.attributions.push(attribution); }
    event.native_usage = observed.credits.map(|value| NativeUsage {
        unit: "credits".into(), value, original_value: observed.original, billable: observed.billable,
    });
    event.input = tokens[0].or(event.input); event.output = tokens[1].or(event.output);
    event.cache_read = tokens[2].or(event.cache_read); event.cache_write = tokens[3].or(event.cache_write);
}

fn qoder_agent_name(row: &Value) -> Option<String> {
    for key in ["agentName", "subagentName"] {
        if let Some(name) = row.get(key).and_then(Value::as_str).map(str::trim).filter(|name| !name.is_empty()) {
            return Some(name.chars().take(256).collect());
        }
    }
    None
}

fn distinct_session_id(row: &Value, parent: Option<&str>) -> Option<String> {
    let id = row.get("sessionId").and_then(Value::as_str).filter(|id| history::valid_native_id(id))?;
    if parent == Some(id) { return None; }
    Some(id.to_owned())
}

fn wire_key(path: &Path) -> String {
    path.file_name().and_then(|name| name.to_str()).filter(|name| !name.is_empty() && name.len() <= 512).unwrap_or("child").to_owned()
}

fn claim_child_key(used: &mut HashSet<String>, native: Option<String>, fallback: String) -> String {
    let preferred = native.filter(|key| !key.is_empty() && key.len() <= 512).unwrap_or_else(|| fallback.clone());
    if used.insert(preferred.clone()) { return preferred; }
    if used.insert(fallback.clone()) { return fallback; }
    let mut n = 2u32;
    loop {
        let key = format!("{fallback}#{n}");
        if used.insert(key.clone()) { return key; }
        n += 1;
    }
}

fn push_child_message(messages: &mut Vec<HistoryMessage>, id: String, role: &str, text: String, time: Option<i64>) {
    if text.trim().is_empty() { return; }
    messages.push(HistoryMessage {
        id, role: role.to_owned(), text, timestamp: time,
        timestamp_source: if time.is_some() { MessageTimeSource::Native } else { MessageTimeSource::Unknown },
        kind: HistoryMessageKind::Conversation,
    });
}

fn retarget_child(session: &mut ParsedSession, from_key: &str, to_key: &str, name: Option<&str>) {
    for event in &mut session.usage {
        for item in &mut event.attributions {
            if item.kind == AgentKind::Subagent && item.session_key.as_deref() == Some(from_key) {
                item.session_key = Some(to_key.to_owned());
                if item.name.is_none() { item.name = name.map(str::to_owned); }
            }
        }
        let mut kept = Vec::new();
        for item in event.attributions.drain(..) {
            if !kept.iter().any(|other: &UsageAttribution| other == &item) { kept.push(item); }
        }
        event.attributions = kept;
    }
}

pub fn parse(source: &HistorySource, cancelled: &dyn Fn() -> bool) -> Result<ParsedSession, String> {
    history::check_source_path(&source.path)?;
    let mut session = ParsedSession::new();
    session.native_id = source.path.file_stem().and_then(|stem| stem.to_str()).filter(|stem| session_stem(stem)).map(str::to_owned);
    let mut seen = HashMap::new();
    let mut transcript = transcript::Transcript::default();
    let mut title = None;
    let mut recognized = false;
    let partial = history::read_jsonl_controlled(source, cancelled, |line, row| {
        let kind = row.get("type").and_then(Value::as_str).unwrap_or_default();
        if !transcript::valid_row(&row) { session.partial = true; return; }
        recognized = true;
        transcript.record(&row, line);
        let time = row.get("timestamp").and_then(history::timestamp);
        match kind {
            "runtime-config" => { session.model = row.get("model").and_then(Value::as_str).map(str::to_owned); recognized = true; }
            "ai-title" => { title = row.get("aiTitle").and_then(Value::as_str).filter(|title| !title.trim().is_empty()).map(|title| title.chars().take(96).collect::<String>()); recognized = true; }
            "user" | "assistant" => {
                recognized = true;
                let model = row.pointer("/message/model").and_then(Value::as_str).map(str::to_owned).or_else(|| session.model.clone());
                if model.is_some() { session.model = model.clone(); }
                if let Some(cwd) = row.get("cwd").and_then(Value::as_str) { session.cwd = Some(cwd.into()); }
                if let Some(time) = time {
                    session.started_at = Some(session.started_at.map_or(time, |old| old.min(time)));
                    session.updated_at = Some(session.updated_at.map_or(time, |old| old.max(time)));
                }
                if kind == "assistant" {
                    record_usage(&mut session, &mut seen, &row, source, line, time, model, UsageAttribution {
                        kind: AgentKind::Main, name: qoder_agent_name(&row), session_key: None,
                    });
                }
            }
            _ => {}
        }
    })?;
    session.partial |= partial;
    if !recognized { return Err("未识别到 Qoder CN 会话记录".into()); }
    transcript.append(&mut session, cancelled)?;
    if let Some(title) = title { session.title = title; }
    let mut used_keys = HashSet::new();
    let wires = match subagents(&source.path, cancelled) {
        Ok(wires) => wires,
        Err(error) if cancelled() || scan_cancelled(&error) => return Err(error),
        Err(_) => {
            session.partial = true;
            let key = claim_child_key(&mut used_keys, None, "child".into());
            session.children.push(ChildSession { key, name: None, messages: Vec::new(), readable: false, children: Vec::new() });
            Vec::new()
        }
    };
    for wire in wires {
        if history::check_source_path(&wire.path).is_err() {
            session.partial = true;
            let key = claim_child_key(&mut used_keys, None, wire_key(&wire.path));
            session.children.push(ChildSession { key, name: None, messages: Vec::new(), readable: false, children: Vec::new() });
            continue;
        }
        let path_key = wire_key(&wire.path);
        if wire.fingerprint_error.is_some() {
            session.partial = true;
            let key = claim_child_key(&mut used_keys, None, path_key);
            session.children.push(ChildSession { key, name: None, messages: Vec::new(), readable: false, children: Vec::new() });
            continue;
        }
        let mut messages = Vec::new();
        let mut native_key = None;
        let mut native_name = None;
        let parent_id = session.native_id.clone();
        let read = history::read_jsonl_controlled(&wire, cancelled, |line, row| {
            if !transcript::valid_row(&row) { session.partial = true; return; }
            if native_key.is_none() { native_key = distinct_session_id(&row, parent_id.as_deref()); }
            if native_name.is_none() { native_name = qoder_agent_name(&row); }
            let kind = row.get("type").and_then(Value::as_str).unwrap_or("");
            if matches!(kind, "user" | "assistant") && !["isMeta", "isSidechain", "isCompactSummary"].iter().any(|key| row.get(*key).and_then(Value::as_bool) == Some(true)) {
                let id = row.get("uuid").and_then(Value::as_str).map(str::to_owned).unwrap_or_else(|| format!("line-{line}"));
                push_child_message(&mut messages, id, kind, row.pointer("/message/content").map(text).unwrap_or_default(), row.get("timestamp").and_then(history::timestamp));
            }
            if kind != "assistant" { return; }
            let time = row.get("timestamp").and_then(history::timestamp);
            let model = row.pointer("/message/model").and_then(Value::as_str).map(str::to_owned);
            record_usage(&mut session, &mut seen, &row, &wire, line, time, model, UsageAttribution {
                kind: AgentKind::Subagent, name: native_name.clone(), session_key: Some(path_key.clone()),
            });
        });
        match read {
            Ok(partial) => {
                session.partial |= partial;
                let key = claim_child_key(&mut used_keys, native_key.clone(), path_key.clone());
                retarget_child(&mut session, &path_key, &key, native_name.as_deref());
                session.children.push(ChildSession { key, name: native_name, messages, readable: true, children: Vec::new() });
            }
            Err(error) => {
                if cancelled() || scan_cancelled(&error) {
                    return Err(error);
                }
                session.partial = true;
                let key = claim_child_key(&mut used_keys, None, path_key);
                session.children.push(ChildSession { key, name: None, messages: Vec::new(), readable: false, children: Vec::new() });
            }
        }
    }
    if let Some(time) = session.usage.iter().filter_map(|event| event.timestamp).max() {
        session.updated_at = Some(session.updated_at.map_or(time, |old| old.max(time)));
    }
    if session.messages.is_empty() && session.usage.is_empty() {
        return Err(if recognized && !session.partial { history::EMPTY_SESSION } else { "未识别到 Qoder CN 会话记录" }.into());
    }
    session.finish(source)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    const ID: &str = "11111111-2222-4333-8444-555555555555";
    const MAIN: &str = include_str!("../../../../tests/fixtures/history/qoder-cn-1.1.74-session.jsonl");
    const SUB: &str = include_str!("../../../../tests/fixtures/history/qoder-cn-1.1.74-subagent.jsonl");

    fn fixture(home: &Path) -> PathBuf {
        let project = home.join(".qoder-cn/projects/synthetic");
        fs::create_dir_all(project.join(format!("{ID}/subagents"))).unwrap();
        fs::write(project.join(format!("{ID}.jsonl")), MAIN).unwrap();
        fs::write(project.join(format!("{ID}/subagents/agent-demo.jsonl")), SUB).unwrap();
        // UUID-looking descendants and ordinary filenames are not parent sessions.
        fs::write(project.join(format!("{ID}/subagents/{ID}.jsonl")), MAIN).unwrap();
        fs::write(project.join("history.jsonl"), MAIN).unwrap();
        project
    }

    #[test]
    fn qoder_sessions_fold_subagent_credits_without_transcript_or_token_fabrication() {
        let temp = tempfile::tempdir().unwrap();
        fixture(temp.path());
        let sources = sources(temp.path(), &|| false).unwrap();
        assert_eq!(sources.len(), 1);
        let parsed = parse(&sources[0], &|| false).unwrap();
        assert_eq!(parsed.native_id.as_deref(), Some(ID));
        assert_eq!(parsed.title, "Synthetic Qoder session");
        assert_eq!(parsed.cwd.as_deref(), Some("C:/Synthetic/Qoder"));
        assert_eq!(parsed.model.as_deref(), Some("qfmodel"));
        assert_eq!(parsed.messages.len(), 2);
        assert_eq!(parsed.messages[1].text, "Synthetic answer");
        assert_eq!(parsed.usage.len(), 3);
        assert!(parsed.usage.iter().all(|event| event.input.is_none() && event.output.is_none() && event.cache_read.is_none() && event.cache_write.is_none()));
        assert_eq!(parsed.usage.iter().map(|event| event.native_usage.as_ref().unwrap().value).sum::<f64>(), 2.5);
        assert!(parsed.usage.iter().all(|event| event.request_count == Some(1)));
        assert!(!parsed.partial);
        assert!(parsed.messages.iter().all(|message| message.text != "Hidden subagent answer"));
        assert_eq!(parsed.children.len(), 1);
        assert!(parsed.children[0].readable);
        assert!(parsed.children[0].name.is_none(), "没有原生代理名时不拿文件名当名称");
        assert_ne!(parsed.children[0].key, ID, "子行的 sessionId 等于父会话时不把它当成子会话键");
        assert!(parsed.children[0].messages.iter().any(|message| message.text == "Hidden subagent answer"));
        let shared = parsed.usage.iter().find(|event| event.id == "request:request-one").unwrap();
        assert_eq!(shared.attributions.len(), 2);
        assert!(shared.attributions.iter().any(|item| item.kind == AgentKind::Main && item.session_key.is_none()));
        assert!(shared.attributions.iter().any(|item| item.kind == AgentKind::Subagent && item.session_key.as_deref() == Some(parsed.children[0].key.as_str())));
        assert!(parsed.usage.iter().filter(|event| event.id != "request:request-one").all(|event| {
            event.attributions.len() == 1 && event.attributions[0].kind == AgentKind::Subagent
        }));
    }

    #[test]
    fn association_descriptor_is_available() {
        let published = crate::adapters::PublishedDescriptor::from_adapter(&super::super::QODER_CN);
        assert_eq!(published.association.expect("association").state, "available");
    }

    #[test]
    fn unreadable_child_keeps_the_parent_and_does_not_invent_a_body() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join(".qoder-cn/projects/synthetic");
        fs::create_dir_all(project.join(format!("{ID}/subagents"))).unwrap();
        fs::write(project.join(format!("{ID}.jsonl")), MAIN).unwrap();
        let locked = project.join(format!("{ID}/subagents/agent-locked.jsonl"));
        fs::write(&locked, r#"{"type":"assistant","uuid":"x","timestamp":"2026-10-20T08:00:00Z","sessionId":"99999999-9999-4999-8999-999999999999","message":{"content":[{"type":"text","text":"不可读正文"}],"usage":{"request_id":"request-hidden","credits":9}}}"#).unwrap();
        let _lock = lock_exclusive(&locked);
        let sources = sources(temp.path(), &|| false).unwrap();
        assert_eq!(sources.len(), 1);
        assert!(sources[0].fingerprint_error.is_none(), "{:?}", sources[0].fingerprint_error);
        assert!(sources[0].fingerprint.starts_with("qoder-cn-session-v4|"));
        assert!(sources[0].fingerprint.contains("unread:"), "不可读子文件仍要进入父指纹，恢复可读后才能重扫");
        let parsed = parse(&sources[0], &|| false).unwrap();
        assert_eq!(parsed.messages.len(), 2);
        assert!(parsed.messages.iter().all(|message| !message.text.contains("不可读")));
        assert!(parsed.usage.iter().all(|event| event.id != "request:request-hidden"));
        assert!(parsed.children.iter().any(|child| !child.readable && child.messages.is_empty() && child.name.is_none()));
        assert!(parsed.usage.iter().any(|event| event.attributions.iter().any(|item| item.kind == AgentKind::Main)));
    }

    fn main_attribution() -> UsageAttribution {
        UsageAttribution { kind: AgentKind::Main, name: None, session_key: None }
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

    #[test]
    fn qoder_subagents_invalidate_parent_fingerprint_and_cancel_before_reading() {
        let temp = tempfile::tempdir().unwrap();
        let project = fixture(temp.path());
        let before = sources(temp.path(), &|| false).unwrap().remove(0);
        fs::write(project.join(format!("{ID}/subagents/agent-new.jsonl")), "{broken}\n").unwrap();
        let after = sources(temp.path(), &|| false).unwrap().remove(0);
        assert_ne!(before.fingerprint, after.fingerprint);
        assert!(parse(&after, &|| false).unwrap().partial);
        assert!(sources(temp.path(), &|| true).unwrap_err().contains("取消"));
        assert!(parse(&after, &|| true).unwrap_err().contains("取消"));
    }

    #[test]
    fn qoder_usage_rejects_invalid_numbers_and_preserves_unknown_requests() {
        let source = HistorySource { native_title: None, path: PathBuf::from("synthetic"), native_id: None, fingerprint: String::new(), fingerprint_error: None };
        let mut parsed = ParsedSession::new();
        let mut seen = HashMap::new();
        let row = serde_json::json!({"uuid":"row-one","message":{"usage":{"credits":2.0,"original_credits":-1,"input_tokens":0}}});
        record_usage(&mut parsed, &mut seen, &row, &source, 1, None, None, main_attribution());
        assert!(parsed.partial);
        assert_eq!(parsed.usage[0].request_count, None);
        assert_eq!(parsed.usage[0].native_usage.as_ref().unwrap().original_value, None);
        let row = serde_json::json!({"uuid":"row-two","sessionId":"native-one","message":{"id":"message-two","usage":{"credits":-2,"input_tokens":30,"output_tokens":5}}});
        record_usage(&mut parsed, &mut seen, &row, &source, 2, None, None, main_attribution());
        assert!(parsed.usage[1].native_usage.is_none());
        assert_eq!(parsed.usage[1].input, Some(30));
        assert_eq!(parsed.usage[1].request_count, Some(1));
        let mut other_session = row.clone();
        other_session["sessionId"] = "native-two".into();
        record_usage(&mut parsed, &mut seen, &other_session, &source, 3, None, None, main_attribution());
        assert_eq!(parsed.usage.len(), 3, "session-local message IDs must not collapse independent calls");
    }

    #[test]
    fn qoder_unknown_format_fails_instead_of_creating_empty_session() {
        let temp = tempfile::tempdir().unwrap();
        let project = fixture(temp.path());
        let path = project.join("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl");
        fs::write(&path, "{\"futureUnknownFormat\":true}\n").unwrap();
        let source = sources(temp.path(), &|| false).unwrap().into_iter().find(|source| source.path == path).unwrap();
        assert!(parse(&source, &|| false).unwrap_err().contains("未识别"));
    }

    fn parse_rows(rows: &[Value]) -> Result<ParsedSession, String> {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(format!("{ID}.jsonl"));
        fs::write(&path, rows.iter().map(Value::to_string).collect::<Vec<_>>().join("\n")).unwrap();
        parse(&HistorySource { path, native_title: None, native_id: Some(ID.into()), fingerprint: String::new(), fingerprint_error: None }, &|| false)
    }

    fn message(id: &str, parent: Option<&str>, role: &str, content: &str) -> Value {
        serde_json::json!({"type":role,"uuid":id,"parentUuid":parent,"sessionId":ID,"timestamp":"2026-10-20T08:00:00Z","message":{"id":id,"content":content}})
    }

    fn active(leaf: Option<&str>) -> Value {
        serde_json::json!({"type":"active-leaf","sessionId":ID,"leafUuid":leaf,"timestamp":1792483200000_i64,"explicit":true,"rewound":true})
    }

    #[test]
    fn qoder_rewind_selects_native_chain_but_accounts_for_every_branch() {
        let user = message("u", None, "user", "question");
        let mut a = message("a", Some("u"), "assistant", "abandoned answer");
        a["message"]["usage"] = serde_json::json!({"request_id":"call-a","credits":1});
        let mut b = message("b", Some("u"), "assistant", "draft answer");
        b["message"]["usage"] = serde_json::json!({"request_id":"call-b","credits":2});
        let mut revised = b.clone(); revised["message"]["content"] = "final answer".into();
        let rows = vec![user, a, active(Some("u")), b, revised, active(Some("b"))];
        let parsed = parse_rows(&rows).unwrap();
        assert_eq!(parsed.messages.iter().map(|message| message.text.as_str()).collect::<Vec<_>>(), ["question", "final answer"]);
        assert_eq!(parsed.usage.len(), 2);
        assert_eq!(parsed.usage.iter().map(|event| event.native_usage.as_ref().unwrap().value).sum::<f64>(), 3.0);
        assert!(!parsed.partial);
        let mut rewound = rows.clone(); rewound.push(active(Some("u")));
        assert_eq!(parse_rows(&rewound).unwrap().messages.len(), 1);
        rewound.push(active(None));
        let empty = parse_rows(&rewound).unwrap();
        assert!(empty.messages.is_empty()); assert_eq!(empty.usage.len(), 2);
        let mut fallback = rows; fallback.push(active(Some("missing")));
        let fallback = parse_rows(&fallback).unwrap();
        assert!(fallback.partial);
        assert_eq!(fallback.messages[1].text, "final answer");
    }

    #[test]
    fn qoder_chain_handles_default_leaf_chunks_compaction_aliases_and_damage() {
        let user = message("u", None, "user", "question");
        let mut first = message("a1", Some("u"), "assistant", "first chunk");
        first["message"]["id"] = "response".into();
        let mut second = message("a2", Some("u"), "assistant", "second chunk");
        second["message"]["id"] = "response".into();
        let compact = serde_json::json!({"type":"system","subtype":"compact_boundary","uuid":"compact","parentUuid":null,"logicalParentUuid":"a2","timestamp":"2026-10-20T08:00:01Z"});
        let mut summary = message("summary", Some("compact"), "user", "hidden summary"); summary["isCompactSummary"] = true.into();
        let last = message("last", Some("summary"), "assistant", "after compaction");
        let parsed = parse_rows(&[user.clone(), first, second, compact, summary, last]).unwrap();
        assert_eq!(parsed.messages.iter().map(|message| message.text.as_str()).collect::<Vec<_>>(), ["question", "first chunk", "second chunk", "after compaction"]);
        assert!(!parsed.partial);
        let mut alias = message("a", Some("u"), "assistant", "answer"); alias["message"]["id"] = "response-id".into();
        let next = message("next", Some("response-id"), "user", "followup");
        assert_eq!(parse_rows(&[user.clone(), alias, next]).unwrap().messages.len(), 3);
        for parent in ["missing", "a"] {
            let damaged = message("a", Some(parent), "assistant", "answer");
            let parsed = parse_rows(&[user.clone(), damaged, active(Some("a"))]).unwrap();
            assert!(parsed.partial); assert_eq!(parsed.messages.len(), 2, "bounded timestamp recovery");
        }
        let mut old = user; old["timestamp"] = "2026-10-20T07:00:00Z".into();
        let parsed = parse_rows(&[old, message("a", Some("missing"), "assistant", "answer"), active(Some("a"))]).unwrap();
        assert!(parsed.partial); assert_eq!(parsed.messages.len(), 1, "never bridge a large timestamp gap");
    }

    #[test]
    fn qoder_known_calls_survive_missing_null_and_zero_amounts() {
        for credits in [None, Some(Value::Null)] {
            let mut row = message("a", None, "assistant", "answer");
            row["message"]["usage"] = serde_json::json!({"request_id":"known-call","input_tokens":0,"output_tokens":0});
            if let Some(value) = credits { row["message"]["usage"]["credits"] = value; }
            let parsed = parse_rows(&[row.clone()]).unwrap();
            assert_eq!(parsed.usage.len(), 1);
            assert_eq!(parsed.usage[0].request_count, Some(1));
            assert!(parsed.usage[0].native_usage.is_none() && parsed.usage[0].input.is_none());
            row["message"]["usage"].as_object_mut().unwrap().remove("request_id");
            assert_eq!(parse_rows(&[row.clone()]).unwrap().usage[0].request_count, Some(1), "reliable message identity also proves a call");
            row["message"].as_object_mut().unwrap().remove("id");
            assert!(parse_rows(&[row]).unwrap().usage.is_empty(), "no numeric evidence or reliable call identity");
        }
    }

    #[test]
    fn qoder_duplicate_requests_merge_native_fields_without_erasing_known_values() {
        let cases = [
            (serde_json::json!({"credits":1,"original_credits":2,"billable":false}), serde_json::json!({"credits":1.5}), 1.5, Some(2.0), Some(false)),
            (serde_json::json!({"credits":1}), serde_json::json!({"credits":2,"original_credits":3,"billable":true}), 2.0, Some(3.0), Some(true)),
            (serde_json::json!({"credits":1,"original_credits":2,"billable":true}), serde_json::json!({"credits":0,"original_credits":0,"billable":false}), 0.0, Some(0.0), Some(false)),
            (serde_json::json!({"credits":0,"original_credits":0,"billable":false}), serde_json::json!({"credits":1,"billable":true}), 1.0, Some(0.0), Some(true)),
            (serde_json::json!({"credits":1,"original_credits":2,"billable":false}), serde_json::json!({"credits":null,"original_credits":null,"billable":null}), 1.0, Some(2.0), Some(false)),
            (serde_json::json!({"credits":1,"original_credits":2,"billable":true}), serde_json::json!({"original_credits":0,"billable":false}), 1.0, Some(0.0), Some(false)),
            (serde_json::json!({"original_credits":2,"billable":false}), serde_json::json!({"credits":1}), 1.0, Some(2.0), Some(false)),
        ];
        for (mut first, mut last, value, original, billable) in cases {
            first["request_id"] = "same-call".into(); last["request_id"] = "same-call".into();
            let mut a = message("a", None, "assistant", "first chunk"); a["message"]["usage"] = first;
            let mut b = message("b", Some("a"), "assistant", "last chunk"); b["message"]["usage"] = last;
            let parsed = parse_rows(&[a, b]).unwrap();
            assert_eq!(parsed.usage.len(), 1);
            assert_eq!(parsed.usage[0].request_count, Some(1));
            let native = parsed.usage[0].native_usage.as_ref().unwrap();
            assert_eq!((native.value, native.original_value, native.billable), (value, original, billable));
            assert!(!parsed.partial);
        }
    }

    #[test]
    fn qoder_invalid_native_shapes_fail_or_mark_partial_while_valid_empty_is_skipped() {
        for invalid in [serde_json::json!({"type":"assistant"}), serde_json::json!({"type":"user","uuid":"u","timestamp":123,"message":{}}), serde_json::json!({"type":"active-leaf"}), serde_json::json!({"type":"runtime-config"})] {
            assert_ne!(parse_rows(&[invalid.clone()]).unwrap_err(), history::EMPTY_SESSION);
            let parsed = parse_rows(&[message("u", None, "user", "valid body"), invalid]).unwrap();
            assert!(parsed.partial); assert_eq!(parsed.messages.len(), 1);
        }
        assert_eq!(parse_rows(&[active(None)]).unwrap_err(), history::EMPTY_SESSION);
        assert_eq!(parse_rows(&[serde_json::json!({"type":"runtime-config","sessionId":ID,"timestamp":0})]).unwrap_err(), history::EMPTY_SESSION);
    }

    #[test]
    #[ignore = "read-only native Qoder evidence; no inference, native writes, or private conversation output"]
    fn qoder_local_readonly_evidence() {
        let home = dirs::home_dir().unwrap();
        let sources = sources(&home, &|| false).unwrap();
        let mut messages = 0; let mut records = 0; let mut unknown_tokens = 0;
        let mut independent_records = 0;
        let bundle = std::env::var_os("QODER_CN_EVIDENCE_BUNDLE").map(PathBuf::from).unwrap_or_else(|| home.join("AppData/Roaming/npm/node_modules/@qodercn-ai/qoderclicn/bundle/qoderclicn.js"));
        let oracle = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/native/helpers/qoder-native-transcript.mjs");
        for source in &sources {
            let parsed = parse(source, &|| false).unwrap();
            assert!(parsed.native_id.as_deref().is_some_and(session_stem));
            messages += parsed.messages.len(); records += parsed.usage.len();
            unknown_tokens += parsed.usage.iter().filter(|event| event.input.is_none()).count();
            assert!(parsed.usage.iter().all(|event| event.native_usage.as_ref().is_none_or(NativeUsage::valid)));
            // Independent native Hjn/MBo/IBo functions extracted from the local
            // bundle run in a pure VM. Compare privately; never log raw text,
            // paths, UUIDs or native request IDs on either success or failure.
            let output = std::process::Command::new("node").arg(&oracle).arg(&bundle).arg(&source.path).output().unwrap();
            assert!(output.status.success(), "native projection oracle failed");
            let native: Vec<Value> = serde_json::from_slice(&output.stdout).expect("native projection returned JSON");
            assert_eq!(native.len(), parsed.messages.len(), "native and imported display message counts differ");
            assert!(native.iter().zip(&parsed.messages).all(|(native, parsed)| native["id"].as_str() == Some(parsed.id.as_str()) && native["text"].as_str() == Some(parsed.text.as_str())), "native and imported active chain IDs/text differ");
            // Independent straightforward recount of request IDs and Credits;
            // no shared record_usage/token/report helpers or private text output.
            let mut requests = std::collections::BTreeMap::new();
            let mut paths = vec![source.path.clone()];
            paths.extend(subagents(&source.path, &|| false).unwrap().into_iter().map(|source| source.path));
            for path in paths {
                let text = fs::read_to_string(path).unwrap();
                for line in text.lines() {
                    let Ok(row) = serde_json::from_str::<Value>(line) else { continue; };
                    if row.get("type").and_then(Value::as_str) != Some("assistant") { continue; }
                    let Some(usage) = row.pointer("/message/usage") else { continue; };
                    let Some(request) = usage.get("request_id").and_then(Value::as_str) else { continue; };
                    let credits = usage.get("credits").and_then(Value::as_f64);
                    let amount = requests.entry(request.to_owned()).or_insert(None);
                    if credits.is_some() { *amount = credits; }
                }
            }
            independent_records += requests.len();
            assert_eq!(requests.len(), parsed.usage.len());
            let expected: f64 = requests.values().flatten().sum();
            let actual: f64 = parsed.usage.iter().filter_map(|event| event.native_usage.as_ref().map(|usage| usage.value)).sum();
            assert!((expected - actual).abs() < 1e-8);
        }
        eprintln!("Qoder read-only native-chain comparison: sessions={} matched_conversation_messages={messages} usage_records={records} independent_request_count={independent_records} unknown_token_records={unknown_tokens}", sources.len());
        assert!(!sources.is_empty());
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
        let project = temp.path().join(".qoder-cn/projects/synthetic");
        let other = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        let wires = project.join(format!("{ID}/subagents"));
        fs::create_dir_all(&wires).unwrap();
        fs::write(project.join(format!("{ID}.jsonl")), MAIN).unwrap();
        fs::write(wires.join("agent-hidden.jsonl"), r#"{"type":"assistant","uuid":"x","timestamp":"2026-10-20T08:00:00Z","sessionId":"99999999-9999-4999-8999-999999999999","message":{"content":[{"type":"text","text":"子日志正文"}],"usage":{"request_id":"request-hidden","credits":9}}}"#).unwrap();
        fs::write(project.join(format!("{other}.jsonl")), format!(
            r#"{{"type":"user","uuid":"u","sessionId":"{other}","timestamp":"2026-10-20T08:00:00Z","message":{{"content":"另一父会话"}}}}
{{"type":"assistant","uuid":"a","parentUuid":"u","sessionId":"{other}","timestamp":"2026-10-20T08:00:01Z","message":{{"id":"a","content":"另一回复","usage":{{"request_id":"other-call","credits":1}}}}}}"#
        )).unwrap();
        let _deny = DenyList::new(&wires);
        let found = sources(temp.path(), &|| false).unwrap();
        assert_eq!(found.len(), 2, "子目录列举失败不能让本次发现整体失败");
        assert!(found.iter().all(|item| item.fingerprint_error.is_none() && item.fingerprint.starts_with("qoder-cn-session-v4|")));
        let parent = found.iter().find(|item| item.native_id.as_deref() == Some(ID)).unwrap();
        assert!(parent.fingerprint.contains("children-unread"));
        let parsed = parse(parent, &|| false).unwrap();
        assert!(parsed.messages.iter().any(|message| message.text == "Synthetic answer"));
        assert!(parsed.messages.iter().all(|message| message.text != "子日志正文"));
        assert!(parsed.usage.iter().all(|event| event.id != "request:request-hidden"));
        assert!(parsed.usage.iter().any(|event| event.attributions.iter().any(|item| item.kind == AgentKind::Main)));
        let unread = parsed.children.iter().find(|child| !child.readable).unwrap();
        assert!(unread.messages.is_empty() && unread.name.is_none());
    }

    #[test]
    fn locked_child_is_indexed_on_the_parent_and_reread_when_it_unlocks() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join(".qoder-cn/projects/synthetic");
        fs::create_dir_all(project.join(format!("{ID}/subagents"))).unwrap();
        fs::write(project.join(format!("{ID}.jsonl")), MAIN).unwrap();
        let locked = project.join(format!("{ID}/subagents/agent-locked.jsonl"));
        let child = r#"{"type":"user","uuid":"cu","timestamp":"2026-10-20T08:00:02Z","sessionId":"99999999-9999-4999-8999-999999999999","message":{"content":[{"type":"text","text":"子日志正文"}]}}
{"type":"assistant","uuid":"x","timestamp":"2026-10-20T08:00:03Z","sessionId":"99999999-9999-4999-8999-999999999999","message":{"content":[{"type":"text","text":"子日志回复"}],"usage":{"request_id":"request-hidden","credits":9}}}"#;
        fs::write(&locked, child).unwrap();
        let db = crate::database::Database::open(&temp.path().join("index.db")).unwrap();
        let blocked = {
            let _lock = lock_exclusive(&locked);
            let parent = sources(temp.path(), &|| false).unwrap().remove(0);
            assert!(parent.fingerprint_error.is_none(), "{:?}", parent.fingerprint_error);
            let details = refresh(&db, temp.path(), "qoder_cn");
            assert_eq!(details.len(), 1);
            let detail = &details[0];
            assert_eq!(detail.session.native_id.as_deref(), Some(ID));
            assert!(!detail.session.stale);
            assert!(detail.messages.iter().all(|message| !message.text.contains("子日志")));
            assert!(detail.usage.iter().all(|event| event.id != "request:request-hidden"));
            assert!(detail.usage.iter().any(|event| event.attributions.iter().any(|item| item.kind == AgentKind::Main)));
            let unread = detail.children.iter().find(|child| !child.readable).unwrap();
            assert!(unread.messages.is_empty() && unread.name.is_none());
            parent.fingerprint
        };
        let parent = sources(temp.path(), &|| false).unwrap().remove(0);
        assert_ne!(parent.fingerprint, blocked, "子文件恢复可读后父指纹必须变化");
        let details = refresh(&db, temp.path(), "qoder_cn");
        let detail = &details[0];
        assert!(detail.messages.iter().all(|message| !message.text.contains("子日志")));
        assert_eq!(detail.usage.iter().filter(|event| event.id == "request:request-hidden").count(), 1);
        let child_session = detail.children.iter().find(|child| child.readable).unwrap();
        assert!(child_session.messages.iter().any(|message| message.text == "子日志正文"));
        assert!(child_session.messages.iter().any(|message| message.text == "子日志回复"));
    }
}
