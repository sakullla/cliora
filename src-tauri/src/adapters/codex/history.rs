use std::path::Path;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use sha2::{Digest, Sha256};

use serde_json::Value;

use crate::history::usage::{self, TokenCounts};
use crate::history::{
    discover_jsonl_controlled, raw_string_after, read_jsonl_filtered, text_content, timestamp,
    valid_native_id, HistoryMessageKind, HistorySource, ParsedSession, UsageEvent,
};

pub fn sources(home: &Path) -> Result<Vec<HistorySource>, String> {
    sources_controlled(home, &|| false)
}

pub fn sources_controlled(
    home: &Path,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<HistorySource>, String> {
    let root = crate::accounts::selection::config_root("codex", || {
        if dirs::home_dir().as_deref() == Some(home) {
            std::env::var_os("CODEX_HOME").map(Into::into).unwrap_or_else(|| home.join(".codex"))
        } else { home.join(".codex") }
    });
    let mut sources = discover_jsonl_controlled(
        &crate::accounts::selection::history_root("codex", || {
            // Keep the established source path spelling so existing stable IDs
            // and favorites survive the title-catalog upgrade on Windows.
            if root == home.join(".codex") { home.join(".codex/sessions") }
            else { root.join("sessions") }
        }),
        |path| {
            path.extension().is_some_and(|value| value == "jsonl")
                && path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| value.starts_with("rollout-"))
        },
        cancelled,
    )?;
    if let Some(context) = crate::accounts::selection::current("codex") {
        for root in context.history_roots.iter().skip(1) {
            sources.extend(discover_jsonl_controlled(
                root,
                |path| path.extension().is_some_and(|ext| ext == "jsonl"),
                cancelled,
            )?);
        }
    }
    // Adapter-local parser version: existing indexes are rebuilt once, even if
    // the original rollout has not changed. Other CLIs keep their own cache.
    let titles = native_titles(&root, cancelled)?;
    for source in &mut sources {
        let id = source.path.file_stem().and_then(|stem| stem.to_str()).and_then(|stem| stem.get(stem.len().saturating_sub(36)..));
        source.native_title = id.and_then(|id| titles.get(id)).cloned();
        let title_hash = format!("{:x}", Sha256::digest(source.native_title.as_deref().unwrap_or("").as_bytes()));
        source.fingerprint = format!("codex-context-v2|{title_hash}|{}", source.fingerprint);
    }
    Ok(sources)
}

// Native display names are stored outside rollouts. Read each catalog once,
// and bind only the matching thread title into its incremental fingerprint.
fn native_titles(root: &Path, cancelled: &dyn Fn() -> bool) -> Result<HashMap<String, String>, String> {
    let mut titles = HashMap::new();
    let mut databases = std::fs::read_dir(root).ok().into_iter().flatten().filter_map(Result::ok)
        .map(|entry| entry.path()).filter(|path| !path.is_symlink()).filter(|path| path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with("state_") && name.ends_with(".sqlite"))).collect::<Vec<_>>();
    databases.sort_by_key(|path| path.file_stem().and_then(|stem| stem.to_str()).and_then(|stem| stem.strip_prefix("state_")).and_then(|v| v.parse::<u32>().ok()).unwrap_or(0));
    if let Some(path) = databases.last() {
        if let Ok(db) = rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) {
            let _ = db.busy_timeout(std::time::Duration::from_millis(100));
            if let Ok(mut statement) = db.prepare("SELECT id,title FROM threads") {
                if let Ok(rows) = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))) {
                    for row in rows {
                        crate::history::check_cancelled(cancelled)?;
                        if let Ok((id, title)) = row { if valid_native_id(&id) && !title.trim().is_empty() { titles.insert(id, title); } }
                    }
                }
            }
        }
    }
    let path = root.join("session_index.jsonl");
    if !path.is_symlink() {
        if let Ok(file) = std::fs::File::open(path) {
            let mut reader = BufReader::new(file);
            let mut line = String::new();
            loop {
                crate::history::check_cancelled(cancelled)?;
                line.clear();
                let Ok(count) = reader.by_ref().take(1024 * 1024 + 1).read_line(&mut line) else { break; };
                if count == 0 || count > 1024 * 1024 { break; }
                let Ok(row) = serde_json::from_str::<Value>(&line) else { continue; };
                if let (Some(id), Some(title)) = (row.get("id").and_then(Value::as_str), row.get("thread_name").and_then(Value::as_str)) {
                    if valid_native_id(id) && !title.trim().is_empty() { titles.insert(id.into(), title.trim().into()); }
                }
            }
        }
    }
    Ok(titles)
}

fn environment_context(text: &str) -> bool {
    text.strip_prefix("<environment_context>")
        .and_then(|rest| rest.split_once("</environment_context>"))
        .is_some_and(|(_, tail)| tail.trim().is_empty())
}

fn message_kind(role: &str, text: &str) -> HistoryMessageKind {
    if role != "user" {
        return HistoryMessageKind::Conversation;
    }
    let text = text.trim();
    if environment_context(text) {
        return HistoryMessageKind::EnvironmentContext;
    }
    if let Some(rest) = text.strip_prefix("# AGENTS.md instructions for ") {
        if let Some((path, body)) = rest.split_once('\n') {
            if !path.trim().is_empty() {
                if let Some((_, tail)) = body
                    .trim_start()
                    .strip_prefix("<INSTRUCTIONS>")
                    .and_then(|value| value.split_once("</INSTRUCTIONS>"))
                {
                    if tail.trim().is_empty() || environment_context(tail.trim()) {
                        return HistoryMessageKind::ProjectContext;
                    }
                }
            }
        }
    }
    HistoryMessageKind::Conversation
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
        b"response_item" => raw_string_after(raw, b"\"payload\":{\"type\":\"")
            .is_some_and(|payload| payload != b"message"),
        b"event_msg" => raw_string_after(raw, b"\"payload\":{\"type\":\"")
            .is_some_and(|payload| payload != b"token_count"),
        _ => false,
    }
}

pub fn parse_controlled(
    source: &HistorySource,
    cancelled: &dyn Fn() -> bool,
) -> Result<ParsedSession, String> {
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
                    let kind = message_kind(role, &body);
                    session.add_classified_message(id, role, body, time, kind);
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
                    request_count: Some(1),
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
                if payload.get("type").and_then(Value::as_str) == Some("token_count")
                    && records.is_empty() =>
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
                    usage::clamp_cache_inside_input(usage::cumulative_delta(
                        &mut high_water,
                        request,
                    ))
                };
                if !usage::active(delta) {
                    return;
                }
                session.usage.push(UsageEvent {
                    request_count: last.filter(|counts| usage::active(*counts)).map(|_| 1),
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
