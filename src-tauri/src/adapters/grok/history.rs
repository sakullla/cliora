use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde_json::Value;

use crate::history::usage;
use crate::history::{
    check_cancelled, read_jsonl_controlled, source_fingerprint, source_fingerprint_controlled,
    text_content, timestamp, valid_native_id, HistorySource, MessageTimeSource, ParsedSession,
    UsageEvent, MAX_SOURCES,
};

pub fn sources(home: &Path) -> Result<Vec<HistorySource>, String> {
    sources_with_fingerprint(home, source_fingerprint)
}

pub fn sources_controlled(
    home: &Path,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<HistorySource>, String> {
    sources_with_control(
        home,
        |path| source_fingerprint_controlled(path, cancelled),
        cancelled,
    )
}

pub(crate) fn sources_with_fingerprint(
    home: &Path,
    fingerprint: impl Fn(&Path) -> Result<String, String>,
) -> Result<Vec<HistorySource>, String> {
    sources_with_control(home, fingerprint, &|| false)
}

fn sources_with_control(
    home: &Path,
    fingerprint: impl Fn(&Path) -> Result<String, String>,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<HistorySource>, String> {
    check_cancelled(cancelled)?;
    let root = home.join(".grok/sessions");
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut result = Vec::new();
    for project in fs::read_dir(&root).map_err(|error| error.to_string())? {
        check_cancelled(cancelled)?;
        let project = project.map_err(|error| error.to_string())?;
        if !project
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            continue;
        }
        for session in fs::read_dir(project.path()).map_err(|error| error.to_string())? {
            check_cancelled(cancelled)?;
            let session = session.map_err(|error| error.to_string())?;
            if !session
                .file_type()
                .map_err(|error| error.to_string())?
                .is_dir()
            {
                continue;
            }
            let path = session.path();
            let summary = path.join("summary.json");
            if !summary.is_file() || summary.is_symlink() {
                continue;
            }
            let checked = [
                "summary.json",
                "chat_history.jsonl",
                "usage.json",
                "events.jsonl",
            ]
            .iter()
            .map(|name| {
                check_cancelled(cancelled)?;
                let file = path.join(name);
                if file.exists() {
                    fingerprint(&file)
                } else {
                    Ok("missing".into())
                }
            })
            .collect::<Result<Vec<_>, _>>();
            check_cancelled(cancelled)?;
            let native_id = path
                .file_name()
                .and_then(|value| value.to_str())
                .filter(|id| valid_native_id(id))
                .map(str::to_owned);
            result.push(HistorySource {
                native_title: None,
                path,
                native_id,
                fingerprint: checked
                    .as_ref()
                    .map(|parts| format!("grok-accuracy-v2|{}", parts.join("|")))
                    .unwrap_or_default(),
                fingerprint_error: checked.err(),
            });
            if result.len() > MAX_SOURCES {
                return Err("Grok 会话源超过 5000 个，本次未删除旧索引".into());
            }
        }
    }
    Ok(result)
}

fn row_timestamp(row: &Value) -> Option<i64> {
    ["timestamp", "created_at", "createdAt", "time"]
        .iter()
        .find_map(|key| row.get(*key).and_then(timestamp))
}

// Chat prompt_index and event turn_number are zero-based. usage.turnNumber is
// one-based and is deliberately not used to assign message clocks.
struct MessageStamp {
    index: usize,
    prompt: bool,
    turn: Option<u64>,
    synthetic: bool,
}

fn assign_missing_message_times(
    session: &mut ParsedSession,
    dir: &Path,
    stamps: &[MessageStamp],
    cancelled: &dyn Fn() -> bool,
) {
    let path = dir.join("events.jsonl");
    if !path.exists() {
        return;
    }
    if path.is_symlink() {
        session.partial = true;
        return;
    }
    let source = HistorySource {
        native_title: None,
        path,
        native_id: None,
        fingerprint: String::new(),
        fingerprint_error: None,
    };
    let mut turns = BTreeMap::<u64, Option<i64>>::new();
    let mut legacy = Vec::new();
    let mut overflow = false;
    let result = read_jsonl_controlled(&source, cancelled, |_line, row| {
        session.updated_at = session.updated_at.max(
            row.get("ts")
                .or_else(|| row.get("timestamp"))
                .and_then(timestamp),
        );
        if row.get("type").and_then(Value::as_str) != Some("turn_started") {
            return;
        }
        if turns.len() + legacy.len() >= 10_000 {
            overflow = true;
            return;
        }
        let time = row
            .get("ts")
            .or_else(|| row.get("timestamp"))
            .and_then(timestamp);
        session.updated_at = session.updated_at.max(time);
        if let Some(number) = row.get("turn_number").and_then(Value::as_u64) {
            turns
                .entry(number)
                .and_modify(|previous| {
                    if *previous != time {
                        *previous = None;
                        overflow = true;
                    }
                })
                .or_insert(time);
        } else {
            legacy.push(time);
        }
    });
    session.partial |= result.unwrap_or(true) || overflow;
    let prompts = stamps.iter().filter(|stamp| stamp.prompt).count();
    // Old transcripts are inferred only when every turn is present and ordered.
    // Compacted transcripts and mixed explicit/legacy references stay unknown.
    let ordered: Vec<_> = if legacy.is_empty() && turns.keys().copied().eq(0..turns.len() as u64) {
        turns.values().copied().collect()
    } else if turns.is_empty() {
        legacy
    } else {
        Vec::new()
    };
    let infer = !session.partial
        && prompts > 0
        && ordered.len() == prompts
        && stamps.iter().all(|stamp| stamp.turn.is_none());
    let mut prompt_index = 0;
    let mut current = None;
    for stamp in stamps {
        if stamp.synthetic {
            continue;
        }
        if stamp.prompt {
            current = stamp
                .turn
                .and_then(|turn| turns.get(&turn).copied().flatten());
            if infer {
                current = ordered[prompt_index];
            }
            prompt_index += 1;
        }
        let time = if let Some(turn) = stamp.turn {
            turns.get(&turn).copied().flatten()
        } else {
            current
        };
        let message = &mut session.messages[stamp.index];
        if message.timestamp.is_none() && time.is_some() {
            message.timestamp = time;
            message.timestamp_source = MessageTimeSource::Turn;
        }
    }
}

fn read_json(path: &Path) -> Result<Value, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if metadata.len() > 64 * 1024 * 1024 || path.is_symlink() {
        return Err("Grok 会话资料过大或为链接".into());
    }
    serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
        .map_err(|_| "Grok 会话资料格式无法识别".into())
}

fn counts(values: &Value) -> Option<usage::TokenCounts> {
    // Missing/invalid primary counters cannot establish a complete subtotal.
    let input = values.get("inputTokens").and_then(Value::as_u64)?;
    let output = values.get("outputTokens").and_then(Value::as_u64)?;
    let read = values
        .get("cachedReadTokens")
        .map(Value::as_u64)
        .unwrap_or(Some(0))?;
    let write = values
        .get("cacheCreationTokens")
        .map(Value::as_u64)
        .unwrap_or(Some(0))?;
    if read > input || write > input - read {
        return None;
    }
    Some(usage::TokenCounts {
        input: input - read - write,
        output,
        read,
        write,
    })
}

fn push_usage(
    events: &mut Vec<UsageEvent>,
    id: String,
    model: Option<String>,
    time: Option<i64>,
    values: &Value,
) -> bool {
    let Some(counts) = counts(values) else {
        return false;
    };
    let request_count = values
        .get("modelCalls")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0);
    if usage::active(counts) || request_count.is_some() {
        events.push(UsageEvent {
            id,
            model,
            timestamp: time,
            request_count,
            input: Some(counts.input),
            output: Some(counts.output),
            cache_read: Some(counts.read),
            cache_write: Some(counts.write),
            input_includes_cache: false,
        });
    }
    true
}

fn sum(events: &[UsageEvent]) -> [u64; 4] {
    let mut total = [0u64; 4];
    for event in events {
        for (slot, value) in total.iter_mut().zip([
            event.input,
            event.cache_read,
            event.cache_write,
            event.output,
        ]) {
            *slot = slot.saturating_add(value.unwrap_or(0));
        }
    }
    total
}

// Only a monotonic difference is knowable. Never assign a missing model or
// session-level remainder to the current model or the session's last active day.
fn reconcile(
    events: &mut Vec<UsageEvent>,
    total: &Value,
    id: String,
    time: Option<i64>,
    partial: &mut bool,
) {
    let Some(counts) = counts(total) else {
        if total.get("inputTokens").is_some() || total.get("outputTokens").is_some() {
            *partial = true;
        }
        return;
    };
    let expected = [counts.input, counts.read, counts.write, counts.output];
    let actual = sum(events);
    if actual
        .iter()
        .zip(expected)
        .any(|(actual, total)| *actual > total)
    {
        *partial = true;
        return;
    }
    // A single missing count can be recovered from a complete native subtotal;
    // multiple missing model counts cannot be distributed without guessing.
    if actual == expected {
        let unknown: Vec<_> = events
            .iter()
            .enumerate()
            .filter(|(_, event)| event.request_count.is_none())
            .map(|(index, _)| index)
            .collect();
        if unknown.len() == 1 {
            let known = events
                .iter()
                .filter_map(|event| event.request_count)
                .sum::<u64>();
            if let Some(remaining) = total
                .get("modelCalls")
                .and_then(Value::as_u64)
                .and_then(|count| count.checked_sub(known))
                .filter(|count| *count > 0)
            {
                events[unknown[0]].request_count = Some(remaining);
            }
        }
    }
    let known_calls = events
        .iter()
        .try_fold(0u64, |sum, event| sum.checked_add(event.request_count?));
    let total_calls = total.get("modelCalls").and_then(Value::as_u64);
    let remaining_calls = total_calls
        .zip(known_calls)
        .and_then(|(total, known)| total.checked_sub(known));
    if total_calls
        .zip(known_calls)
        .is_some_and(|(total, known)| total < known)
    {
        *partial = true;
    }
    if expected == actual && remaining_calls.unwrap_or(0) == 0 {
        return;
    }
    *partial = true;
    events.push(UsageEvent {
        id,
        model: None,
        timestamp: time,
        request_count: remaining_calls.filter(|value| *value > 0),
        input: Some(expected[0] - actual[0]),
        cache_read: Some(expected[1] - actual[1]),
        cache_write: Some(expected[2] - actual[2]),
        output: Some(expected[3] - actual[3]),
        input_includes_cache: false,
    });
}

fn parse_usage(
    session: &mut ParsedSession,
    source: &HistorySource,
    data: &Value,
    cancelled: &dyn Fn() -> bool,
) -> Result<(), String> {
    let total = data.get("session").unwrap_or(&Value::Null);
    session.updated_at = session
        .updated_at
        .max(data.get("updatedAt").and_then(timestamp));
    let mut snapshots = BTreeMap::<String, Vec<UsageEvent>>::new();
    if let Some(turns) = data
        .get("turns")
        .and_then(Value::as_array)
        .filter(|turns| !turns.is_empty())
    {
        for (index, turn) in turns.iter().enumerate() {
            check_cancelled(cancelled)?;
            let time = turn.get("endedAt").and_then(timestamp);
            session.updated_at = session.updated_at.max(time);
            let key = turn
                .get("turnNumber")
                .and_then(Value::as_u64)
                .map(|number| format!("turn-{number}"))
                .unwrap_or_else(|| format!("row-{index}"));
            let id = format!("{}:{key}", source.key());
            let mut events = Vec::new();
            if let Some(models) = turn
                .get("modelUsage")
                .and_then(Value::as_object)
                .filter(|models| !models.is_empty())
            {
                for (model, values) in models {
                    session.partial |= !push_usage(
                        &mut events,
                        format!("{id}:{model}"),
                        Some(model.clone()),
                        time,
                        values,
                    );
                }
                reconcile(
                    &mut events,
                    turn,
                    format!("{id}:remainder"),
                    time,
                    &mut session.partial,
                );
            } else {
                let model = turn
                    .get("primaryModelId")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                session.partial |= !push_usage(&mut events, id.clone(), model, time, turn);
            }
            if let Some(previous) = snapshots.get(&key) {
                // Repeated snapshots represent the same turn. Keep a monotonic
                // terminal snapshot; incomparable snapshots retain reliable data.
                if sum(&events)
                    .iter()
                    .zip(sum(previous))
                    .any(|(next, old)| *next < old)
                {
                    session.partial = true;
                    continue;
                }
            }
            snapshots.insert(key, events);
        }
        session.usage = snapshots.into_values().flatten().collect();
        reconcile(
            &mut session.usage,
            total,
            format!("{}:session-remainder", source.key()),
            None,
            &mut session.partial,
        );
    } else if let Some(models) = total
        .get("modelUsage")
        .and_then(Value::as_object)
        .filter(|models| !models.is_empty())
    {
        for (model, values) in models {
            session.partial |= !push_usage(
                &mut session.usage,
                format!("{}:model-{model}", source.key()),
                Some(model.clone()),
                None,
                values,
            );
        }
        reconcile(
            &mut session.usage,
            total,
            format!("{}:session-remainder", source.key()),
            None,
            &mut session.partial,
        );
    } else if total.is_object() {
        session.partial |= !push_usage(
            &mut session.usage,
            format!("{}:session-total", source.key()),
            None,
            None,
            total,
        );
    }
    Ok(())
}

pub fn parse(source: &HistorySource) -> Result<ParsedSession, String> {
    parse_controlled(source, &|| false)
}

pub fn parse_controlled(
    source: &HistorySource,
    cancelled: &dyn Fn() -> bool,
) -> Result<ParsedSession, String> {
    check_cancelled(cancelled)?;
    let summary = read_json(&source.path.join("summary.json"))?;
    let mut session = ParsedSession::new();
    session.native_id = summary
        .get("info")
        .and_then(|v| v.get("id"))
        .and_then(Value::as_str)
        .filter(|id| valid_native_id(id))
        .map(str::to_owned)
        .or_else(|| source.native_id.clone());
    session.cwd = summary
        .get("info")
        .and_then(|v| v.get("cwd"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    session.title = summary
        .get("generated_title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .chars()
        .take(96)
        .collect();
    session.model = summary
        .get("current_model_id")
        .and_then(Value::as_str)
        .map(str::to_owned);
    session.started_at = summary.get("created_at").and_then(timestamp);
    session.updated_at = summary
        .get("updated_at")
        .or_else(|| summary.get("last_active_at"))
        .and_then(timestamp);
    let chat = source.path.join("chat_history.jsonl");
    let mut stamps = Vec::new();
    if chat.is_file() && !chat.is_symlink() {
        let chat_source = HistorySource {
            native_title: None,
            path: chat,
            native_id: None,
            fingerprint: String::new(),
            fingerprint_error: None,
        };
        match read_jsonl_controlled(&chat_source, cancelled, |line, row| {
            let role = row.get("type").and_then(Value::as_str).unwrap_or("");
            if role == "user" || role == "assistant" {
                let text = row.get("content").map(text_content).unwrap_or_default();
                let before = session.messages.len();
                session.add_message(format!("line-{line}"), role, text, row_timestamp(&row));
                if session.messages.len() > before {
                    let prompt = role == "user"
                        && row
                            .get("synthetic_reason")
                            .and_then(Value::as_str)
                            .is_none();
                    stamps.push(MessageStamp {
                        index: session.messages.len() - 1,
                        prompt,
                        turn: row.get("prompt_index").and_then(Value::as_u64),
                        synthetic: row.get("synthetic_reason").is_some(),
                    });
                }
            }
        }) {
            Ok(partial) => session.partial |= partial,
            Err(_) => session.partial = true,
        }
    } else {
        session.partial = true;
    }
    assign_missing_message_times(&mut session, &source.path, &stamps, cancelled);
    let usage_path = source.path.join("usage.json");
    check_cancelled(cancelled)?;
    if usage_path.is_file() {
        match read_json(&usage_path) {
            Ok(usage) => parse_usage(&mut session, source, &usage, cancelled)?,
            Err(_) => session.partial = true,
        }
    }
    check_cancelled(cancelled)?;
    session.finish(source)
}
