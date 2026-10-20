//! Qoder CN 1.1.74: projects/<slug>/<uuid>.jsonl and sibling subagent wires.
//! Credits are native usage, not currency or remaining balance. Zero token
//! buckets in this release are placeholders and cannot establish a token price.
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::history::{self, HistorySource, NativeUsage, ParsedSession, UsageEvent};

fn session_stem(value: &str) -> bool {
    value.len() == 36 && value.bytes().enumerate().all(|(index, byte)| {
        if [8, 13, 18, 23].contains(&index) { byte == b'-' } else { byte.is_ascii_hexdigit() }
    })
}

pub fn sources(home: &Path, cancelled: &dyn Fn() -> bool) -> Result<Vec<HistorySource>, String> {
    let root = super::QODER_CN.config_root(home)?.join("projects");
    history::check_source_path(&root)?;
    let mut sources = history::discover_jsonl_controlled(&root, |path| {
        path.strip_prefix(&root).is_ok_and(|relative| relative.components().count() == 2)
            && path.extension().is_some_and(|extension| extension == "jsonl")
            && path.file_stem().and_then(|stem| stem.to_str()).is_some_and(session_stem)
    }, cancelled)?;
    for source in &mut sources {
        source.native_id = source.path.file_stem().and_then(|stem| stem.to_str()).map(str::to_owned);
        let mut parts = vec![source.fingerprint.clone()];
        let wires = subagents(&source.path, cancelled);
        match wires {
            Ok(wires) => for wire in wires {
                match &wire.fingerprint_error {
                    None => parts.push(format!("{}:{}", wire.key(), wire.fingerprint)),
                    Some(error) => source.fingerprint_error = Some(error.clone()),
                }
            },
            Err(error) => source.fingerprint_error = Some(error),
        }
        history::check_cancelled(cancelled)?;
        source.fingerprint = if source.fingerprint_error.is_some() { String::new() }
            else { format!("qoder-cn-session-v1|{}", parts.join("|")) };
    }
    Ok(sources)
}

fn subagents(path: &Path, cancelled: &dyn Fn() -> bool) -> Result<Vec<HistorySource>, String> {
    let parent = path.parent().ok_or("Qoder CN 会话目录无效")?;
    let stem = path.file_stem().and_then(|stem| stem.to_str()).filter(|stem| session_stem(stem)).ok_or("Qoder CN 会话 ID 无效")?;
    let root: PathBuf = parent.join(stem).join("subagents");
    history::check_source_path(&root)?;
    let mut wires = history::discover_jsonl_controlled(&root, |path| {
        path.parent() == Some(root.as_path()) && path.extension().is_some_and(|extension| extension == "jsonl")
            && path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with("agent-"))
    }, cancelled)?;
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

fn record_usage(session: &mut ParsedSession, seen: &mut HashSet<String>, row: &Value, source: &HistorySource, line: usize, time: Option<i64>, model: Option<String>) {
    let Some(message) = row.get("message") else { return; };
    let Some(usage) = message.get("usage").filter(|value| value.is_object()) else { return; };
    let number = |field| usage.get(field).and_then(Value::as_f64).filter(|value| value.is_finite() && *value >= 0.0);
    let native_usage = number("credits").map(|value| NativeUsage {
        unit: "credits".into(), value, original_value: number("original_credits"), billable: usage.get("billable").and_then(Value::as_bool),
    });
    if ["credits", "original_credits"].iter().any(|field| usage.get(field).is_some_and(|value| !value.is_null()) && number(field).is_none()) {
        session.partial = true;
    }
    let fields = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];
    let mut tokens = fields.map(|field| usage.get(field).and_then(Value::as_u64));
    // Only positive native token evidence disambiguates placeholder buckets.
    if !tokens.iter().flatten().any(|value| *value > 0) { tokens = [None; 4]; }
    if native_usage.is_none() && tokens.iter().all(Option::is_none) { return; }
    let request = usage.get("request_id").and_then(Value::as_str).filter(|id| !id.trim().is_empty());
    let message_id = message.get("id").and_then(Value::as_str).filter(|id| !id.trim().is_empty());
    let native_session = row.get("sessionId").and_then(Value::as_str).filter(|id| history::valid_native_id(id))
        .or(source.native_id.as_deref());
    let (id, request_count) = if let Some(request) = request { (format!("request:{request}"), Some(1)) }
        // Message counters are not assumed globally unique across sessions.
        else if let (Some(id), Some(native_session)) = (message_id, native_session) { (format!("message:{native_session}:{id}"), Some(1)) }
        else {
            let identity = row.get("uuid").and_then(Value::as_str).map(str::to_owned).unwrap_or_else(|| format!("line-{line}"));
            (format!("{}:{identity}", source.key()), None)
        };
    if seen.insert(id.clone()) {
        session.usage.push(UsageEvent { native_usage, request_count, id, model, timestamp: time,
            input: tokens[0], output: tokens[1], cache_read: tokens[2], cache_write: tokens[3], input_includes_cache: false });
    }
}

pub fn parse(source: &HistorySource, cancelled: &dyn Fn() -> bool) -> Result<ParsedSession, String> {
    history::check_source_path(&source.path)?;
    let mut session = ParsedSession::new();
    session.native_id = source.path.file_stem().and_then(|stem| stem.to_str()).filter(|stem| session_stem(stem)).map(str::to_owned);
    let mut seen = HashSet::new();
    let mut messages = HashSet::new();
    let mut title = None;
    let mut recognized = false;
    let partial = history::read_jsonl_controlled(source, cancelled, |line, row| {
        let kind = row.get("type").and_then(Value::as_str).unwrap_or_default();
        let time = row.get("timestamp").and_then(history::timestamp);
        match kind {
            "runtime-config" => { session.model = row.get("model").and_then(Value::as_str).map(str::to_owned); recognized = true; }
            "ai-title" => { title = row.get("aiTitle").and_then(Value::as_str).filter(|title| !title.trim().is_empty()).map(|title| title.chars().take(96).collect::<String>()); recognized = true; }
            "system" if row.get("isCompactSummary").and_then(Value::as_bool) == Some(true) || row.get("subtype").and_then(Value::as_str) == Some("compact_boundary") => { session.partial = true; }
            "user" | "assistant" => {
                recognized = true;
                let model = row.pointer("/message/model").and_then(Value::as_str).map(str::to_owned).or_else(|| session.model.clone());
                if model.is_some() { session.model = model.clone(); }
                if let Some(cwd) = row.get("cwd").and_then(Value::as_str) { session.cwd = Some(cwd.into()); }
                if let Some(time) = time {
                    session.started_at = Some(session.started_at.map_or(time, |old| old.min(time)));
                    session.updated_at = Some(session.updated_at.map_or(time, |old| old.max(time)));
                }
                if kind == "assistant" { record_usage(&mut session, &mut seen, &row, source, line, time, model); }
                if row.get("isCompactSummary").and_then(Value::as_bool) == Some(true) { session.partial = true; }
                if ["isMeta", "isSidechain", "isCompactSummary"].iter().any(|key| row.get(key).and_then(Value::as_bool) == Some(true)) { return; }
                let id = row.get("uuid").and_then(Value::as_str).map(str::to_owned).unwrap_or_else(|| format!("line-{line}"));
                if messages.insert(id.clone()) {
                    session.add_message(id, kind, row.pointer("/message/content").map(text).unwrap_or_default(), time);
                }
            }
            _ => {}
        }
    })?;
    session.partial |= partial;
    if !recognized { return Err("未识别到 Qoder CN 会话记录".into()); }
    if let Some(title) = title { session.title = title; }
    for wire in subagents(&source.path, cancelled)? {
        history::check_source_path(&wire.path)?;
        if let Some(error) = &wire.fingerprint_error { return Err(error.clone()); }
        let partial = history::read_jsonl_controlled(&wire, cancelled, |line, row| {
            if row.get("type").and_then(Value::as_str) != Some("assistant") { return; }
            let time = row.get("timestamp").and_then(history::timestamp);
            let model = row.pointer("/message/model").and_then(Value::as_str).map(str::to_owned);
            record_usage(&mut session, &mut seen, &row, &wire, line, time, model);
        })?;
        session.partial |= partial;
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
        let mut seen = HashSet::new();
        let row = serde_json::json!({"uuid":"row-one","message":{"usage":{"credits":2.0,"original_credits":-1,"input_tokens":0}}});
        record_usage(&mut parsed, &mut seen, &row, &source, 1, None, None);
        assert!(parsed.partial);
        assert_eq!(parsed.usage[0].request_count, None);
        assert_eq!(parsed.usage[0].native_usage.as_ref().unwrap().original_value, None);
        let row = serde_json::json!({"uuid":"row-two","sessionId":"native-one","message":{"id":"message-two","usage":{"credits":-2,"input_tokens":30,"output_tokens":5}}});
        record_usage(&mut parsed, &mut seen, &row, &source, 2, None, None);
        assert!(parsed.usage[1].native_usage.is_none());
        assert_eq!(parsed.usage[1].input, Some(30));
        assert_eq!(parsed.usage[1].request_count, Some(1));
        let mut other_session = row.clone();
        other_session["sessionId"] = "native-two".into();
        record_usage(&mut parsed, &mut seen, &other_session, &source, 3, None, None);
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

    #[test]
    #[ignore = "read-only native Qoder evidence; no inference, native writes, or private conversation output"]
    fn qoder_local_readonly_evidence() {
        let home = dirs::home_dir().unwrap();
        let sources = sources(&home, &|| false).unwrap();
        let mut messages = 0; let mut records = 0; let mut unknown_tokens = 0;
        let mut independent_records = 0;
        for source in &sources {
            let parsed = parse(source, &|| false).unwrap();
            assert!(parsed.native_id.as_deref().is_some_and(session_stem));
            messages += parsed.messages.len(); records += parsed.usage.len();
            unknown_tokens += parsed.usage.iter().filter(|event| event.input.is_none()).count();
            assert!(parsed.usage.iter().all(|event| event.native_usage.as_ref().is_none_or(NativeUsage::valid)));
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
                    let Some(credits) = usage.get("credits").and_then(Value::as_f64) else { continue; };
                    requests.entry(request.to_owned()).or_insert(credits);
                }
            }
            independent_records += requests.len();
            assert_eq!(requests.len(), parsed.usage.len());
            let expected: f64 = requests.values().sum();
            let actual: f64 = parsed.usage.iter().map(|event| event.native_usage.as_ref().unwrap().value).sum();
            assert!((expected - actual).abs() < 1e-8);
        }
        eprintln!("Qoder read-only: sessions={} conversation_messages={messages} usage_records={records} independent_request_count={independent_records} unknown_token_records={unknown_tokens}", sources.len());
        assert!(!sources.is_empty());
    }
}
