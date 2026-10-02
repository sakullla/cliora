use std::path::Path;

use serde_json::Value;

use super::usage::{self, TokenCounts};
use super::{
    discover_jsonl_controlled, raw_string_after, read_jsonl_filtered, text_content, timestamp, valid_native_id,
    HistorySource, ParsedSession, UsageEvent,
};

pub fn sources(home: &Path) -> Result<Vec<HistorySource>, String> {
    sources_controlled(home, &|| false)
}

pub fn sources_controlled(home: &Path, cancelled: &dyn Fn() -> bool) -> Result<Vec<HistorySource>, String> {
    discover_jsonl_controlled(&home.join(".codex/sessions"), |path| {
        path.extension().is_some_and(|value| value == "jsonl")
            && path
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.starts_with("rollout-"))
    }, cancelled)
}

fn token_counts(value: &Value) -> Option<TokenCounts> {
    if !value.is_object() {
        return None;
    }
    usage::from_optional(
        usage::field(value, "input_tokens"),
        usage::field(value, "output_tokens"),
        usage::field(value, "cached_input_tokens"),
        usage::field(value, "cache_write_input_tokens"),
    )
}

pub fn parse(source: &HistorySource) -> Result<ParsedSession, String> {
    parse_controlled(source, &|| false)
}

/// Rows that never carry visible text or usage. Tool output, reasoning blobs and
/// compaction snapshots make up most of a long rollout, so they are dropped from the
/// leading bytes without being parsed. Unknown shapes are always parsed.
fn skip_row(raw: &[u8]) -> bool {
    let Some(kind) = raw_string_after(raw, b"\"type\":\"") else {
        return false;
    };
    match kind {
        b"compacted" | b"world_state" => true,
        b"response_item" => raw_string_after(raw, b"\"payload\":{\"type\":\"").is_some_and(|payload| payload != b"message"),
        b"event_msg" => raw_string_after(raw, b"\"payload\":{\"type\":\"").is_some_and(|payload| payload != b"token_count"),
        _ => false,
    }
}

pub fn parse_controlled(source: &HistorySource, cancelled: &dyn Fn() -> bool) -> Result<ParsedSession, String> {
    let mut session = ParsedSession::new();
    let mut high_water: Option<TokenCounts> = None;
    let mut previous_snapshot: Option<(TokenCounts, TokenCounts)> = None;
    let mut model: Option<String> = None;
    let mut records = std::collections::HashSet::<String>::new();
    let partial = read_jsonl_filtered(source, cancelled, skip_row, |line, row| {
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
            // Newer rollouts write one record per model response. The response id is
            // global, so forked or resumed copies of the same call collapse to one.
            Some("token_usage_record") => {
                let Some(counts) = payload.get("usage").and_then(token_counts) else {
                    return;
                };
                let counts = usage::clamp_cache_inside_input(counts);
                let id = payload
                    .get("response_id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .map(|id| format!("codex:response:{id}"))
                    .unwrap_or_else(|| format!("{}:record-{line}", source.key()));
                if !usage::active(counts) || !records.insert(id.clone()) {
                    return;
                }
                session.usage.push(UsageEvent {
                    id,
                    model: model.clone(),
                    timestamp: time,
                    input: Some(counts.input),
                    output: Some(counts.output),
                    cache_read: Some(counts.read),
                    cache_write: Some(counts.write),
                    input_includes_cache: true,
                });
            }
            // `token_count` repeats the record above; it is only the source of truth
            // for rollouts written before per-response records existed.
            Some("event_msg")
                if payload.get("type").and_then(Value::as_str) == Some("token_count") && records.is_empty() =>
            {
                let info = payload.get("info").unwrap_or(&Value::Null);
                let last = info.get("last_token_usage").and_then(token_counts);
                let total = info.get("total_token_usage").and_then(token_counts);
                let Some(request) = last.filter(|counts| usage::active(*counts)).or(total) else {
                    return;
                };
                let snapshot = (last.unwrap_or(request), total.unwrap_or(request));
                if previous_snapshot == Some(snapshot) {
                    return;
                }
                previous_snapshot = Some(snapshot);
                // `last_token_usage` is this request. `total_token_usage` is a running
                // counter shared across turns, so subtracting it recounts or drops
                // everything after the counter stalls.
                let delta = if last.is_some_and(usage::active) {
                    if let Some(total) = total {
                        if high_water.is_some_and(|high| total.input < high.input) {
                            high_water = Some(total);
                        } else {
                            let _ = usage::cumulative_delta(&mut high_water, total);
                        }
                    }
                    usage::clamp_cache_inside_input(request)
                } else {
                    usage::clamp_cache_inside_input(usage::cumulative_delta(&mut high_water, request))
                };
                if !usage::active(delta) {
                    return;
                }
                session.usage.push(UsageEvent {
                    id: format!("{}:token-{line}", source.key()),
                    model: model.clone(),
                    timestamp: time,
                    input: Some(delta.input),
                    output: Some(delta.output),
                    cache_read: Some(delta.read),
                    cache_write: Some(delta.write),
                    input_includes_cache: true,
                });
            }
            _ => {}
        }
    })?;
    session.partial |= partial;
    session.finish(source)
}
