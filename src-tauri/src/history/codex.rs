use std::path::Path;

use serde_json::Value;

use super::{
    at, discover_jsonl, read_jsonl, text_content, timestamp, valid_native_id, HistorySource,
    ParsedSession, UsageEvent,
};

pub fn sources(home: &Path) -> Result<Vec<HistorySource>, String> {
    discover_jsonl(&home.join(".codex/sessions"), |path| {
        path.extension().is_some_and(|value| value == "jsonl")
            && path
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.starts_with("rollout-"))
    })
}

fn count(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(Value::as_u64)
}

pub fn parse(source: &HistorySource) -> Result<ParsedSession, String> {
    let mut session = ParsedSession::new();
    let mut totals: Option<(u64, u64, u64, u64)> = None;
    let mut model: Option<String> = None;
    let partial = read_jsonl(source, |line, row| {
        let time = row.get("timestamp").and_then(timestamp);
        let payload = row.get("payload").unwrap_or(&Value::Null);
        match row.get("type").and_then(Value::as_str) {
            Some("session_meta") => {
                let id = payload
                    .get("id")
                    .or_else(|| payload.get("session_id"))
                    .and_then(Value::as_str);
                session.native_id = id.filter(|id| valid_native_id(id)).map(str::to_owned);
                session.cwd = payload
                    .get("cwd")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                session.started_at = payload.get("timestamp").and_then(timestamp).or(time);
            }
            Some("turn_context") => {
                model = payload
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or(model.take());
                session.model = model.clone();
            }
            Some("response_item")
                if payload.get("type").and_then(Value::as_str) == Some("message") =>
            {
                let role = payload.get("role").and_then(Value::as_str).unwrap_or("");
                if role == "user" || role == "assistant" {
                    let body = payload.get("content").map(text_content).unwrap_or_default();
                    let id = payload
                        .get("id")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("line-{line}"));
                    session.add_message(id, role, body, time);
                }
            }
            Some("event_msg")
                if payload.get("type").and_then(Value::as_str) == Some("token_count") =>
            {
                let Some(total) = at(payload, &["info", "total_token_usage"]) else {
                    return;
                };
                let Some((input, output)) =
                    count(&total, "input_tokens").zip(count(&total, "output_tokens"))
                else {
                    return;
                };
                let read = count(&total, "cached_input_tokens").unwrap_or(0);
                let write = count(&total, "cache_write_input_tokens").unwrap_or(0);
                let before = totals.unwrap_or((0, 0, 0, 0));
                if input >= before.0 && output >= before.1 && read >= before.2 && write >= before.3
                {
                    if (input, output, read, write) != before {
                        session.usage.push(UsageEvent {
                            id: format!("{}:token-{line}", source.key()),
                            model: model.clone(),
                            timestamp: time,
                            input: Some(input - before.0),
                            output: Some(output - before.1),
                            cache_read: Some(read - before.2),
                            cache_write: Some(write - before.3),
                            input_includes_cache: true,
                        });
                    }
                    totals = Some((input, output, read, write));
                } else {
                    session.partial = true;
                }
            }
            _ => {}
        }
    })?;
    session.partial |= partial;
    session.finish(source)
}
