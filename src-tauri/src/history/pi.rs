use std::path::Path;

use serde_json::Value;

use super::{
    discover_jsonl, read_jsonl, text_content, timestamp, valid_native_id, HistorySource,
    ParsedSession, UsageEvent,
};

pub fn sources(home: &Path) -> Result<Vec<HistorySource>, String> {
    discover_jsonl(&home.join(".pi/agent/sessions"), |path| {
        path.extension().is_some_and(|value| value == "jsonl")
    })
}

fn usage_event(
    id: String,
    model: Option<String>,
    time: Option<i64>,
    usage: &Value,
) -> Option<UsageEvent> {
    Some(UsageEvent {
        id,
        model,
        timestamp: time,
        input: usage.get("input").and_then(Value::as_u64),
        output: usage.get("output").and_then(Value::as_u64),
        cache_read: usage.get("cacheRead").and_then(Value::as_u64),
        cache_write: usage.get("cacheWrite").and_then(Value::as_u64),
        input_includes_cache: false,
    })
}

pub fn parse(source: &HistorySource) -> Result<ParsedSession, String> {
    let mut session = ParsedSession::new();
    let mut model: Option<String> = None;
    let partial = read_jsonl(source, |line, row| {
        let time = row.get("timestamp").and_then(timestamp);
        match row.get("type").and_then(Value::as_str) {
            Some("session") => {
                if row
                    .get("version")
                    .and_then(Value::as_u64)
                    .is_some_and(|version| version > 3)
                {
                    session.partial = true;
                    return;
                }
                session.native_id = row
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| valid_native_id(id))
                    .map(str::to_owned);
                session.cwd = row.get("cwd").and_then(Value::as_str).map(str::to_owned);
                session.started_at = time;
            }
            Some("model_change") => {
                model = row
                    .get("modelId")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                session.model = model.clone();
            }
            Some("message") => {
                let message = row.get("message").unwrap_or(&Value::Null);
                let role = message.get("role").and_then(Value::as_str).unwrap_or("");
                let id = row
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("line-{line}"));
                let effective_time = message.get("timestamp").and_then(timestamp).or(time);
                if role == "user" || role == "assistant" {
                    session.add_message(
                        id.clone(),
                        role,
                        message.get("content").map(text_content).unwrap_or_default(),
                        effective_time,
                    );
                }
                let event_model = message
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| model.clone());
                if event_model.is_some() {
                    session.model = event_model.clone();
                }
                if let Some(usage) = message.get("usage") {
                    if let Some(event) = usage_event(id, event_model, effective_time, usage) {
                        session.usage.push(event);
                    }
                }
            }
            Some("usage") | Some("compaction") => {
                if let Some(usage) = row.get("usage") {
                    let id = row
                        .get("id")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("line-{line}"));
                    let event_model = row
                        .get("model")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .or_else(|| model.clone());
                    if let Some(event) = usage_event(id, event_model, time, usage) {
                        session.usage.push(event);
                    }
                }
            }
            _ => {}
        }
    })?;
    session.partial |= partial;
    session.finish(source)
}
