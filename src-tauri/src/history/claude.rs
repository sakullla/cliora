use std::collections::BTreeMap;
use std::path::Path;

use serde_json::Value;

use super::{
    discover_jsonl, read_jsonl, text_content, timestamp, valid_native_id, HistorySource,
    ParsedSession, UsageEvent,
};

pub fn sources(home: &Path) -> Result<Vec<HistorySource>, String> {
    discover_jsonl(&home.join(".claude/projects"), |path| {
        path.extension().is_some_and(|value| value == "jsonl")
            && !path
                .components()
                .any(|part| part.as_os_str() == "subagents")
    })
}

pub fn parse(source: &HistorySource) -> Result<ParsedSession, String> {
    let mut session = ParsedSession::new();
    let mut events = BTreeMap::<String, UsageEvent>::new();
    let mut seen = std::collections::HashSet::new();
    let partial = read_jsonl(source, |line, row| {
        let kind = row.get("type").and_then(Value::as_str).unwrap_or("");
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
        let model = message
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if model.is_some() {
            session.model = model.clone();
        }
        let Some(usage) = message.get("usage") else {
            return;
        };
        let Some(input) = usage.get("input_tokens").and_then(Value::as_u64) else {
            return;
        };
        let Some(output) = usage.get("output_tokens").and_then(Value::as_u64) else {
            return;
        };
        let key = message
            .get("id")
            .and_then(Value::as_str)
            .or_else(|| row.get("requestId").and_then(Value::as_str));
        let Some(key) = key else {
            session.partial = true;
            return;
        };
        let event = UsageEvent {
            id: key.to_owned(),
            model,
            timestamp: time,
            input: Some(input),
            output: Some(output),
            cache_read: usage.get("cache_read_input_tokens").and_then(Value::as_u64),
            cache_write: usage
                .get("cache_creation_input_tokens")
                .and_then(Value::as_u64),
            input_includes_cache: false,
        };
        let old = events.get(key);
        if old.and_then(|event| event.output).unwrap_or(0) <= output {
            events.insert(key.to_owned(), event);
        }
    })?;
    session.partial |= partial;
    session.usage = events.into_values().collect();
    session.finish(source)
}
