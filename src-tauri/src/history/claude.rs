use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::usage::{self, RequestUsage};
use super::{
    check_cancelled, contains_bytes, discover_jsonl_controlled, read_jsonl_filtered, source_fingerprint_controlled, text_content,
    timestamp, valid_native_id, HistorySource, ParsedSession, UsageEvent,
};

pub fn sources(home: &Path) -> Result<Vec<HistorySource>, String> {
    sources_controlled(home, &|| false)
}

pub fn sources_controlled(home: &Path, cancelled: &dyn Fn() -> bool) -> Result<Vec<HistorySource>, String> {
    let mut sources = discover_jsonl_controlled(&crate::accounts::selection::history_root("claude_code", || home.join(".claude/projects")), |path| {
        path.extension().is_some_and(|value| value == "jsonl")
            && !path
                .components()
                .any(|part| part.as_os_str() == "subagents")
    }, cancelled)?;
    for source in &mut sources {
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

fn subagent_fingerprint(session_file: &Path, cancelled: &dyn Fn() -> bool) -> Result<Option<String>, String> {
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

pub fn parse_controlled(source: &HistorySource, cancelled: &dyn Fn() -> bool) -> Result<ParsedSession, String> {
    let mut session = ParsedSession::new();
    let mut events = BTreeMap::<String, RequestUsage>::new();
    let mut seen = std::collections::HashSet::new();
    let partial = read_jsonl_filtered(source, cancelled, skip_row, |line, row| {
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
        if !fold_assistant(&mut events, "", &row, &mut session.model) {
            session.partial = true;
        }
    })?;
    session.partial |= partial;
    match subagent_files(&source.path) {
        Ok(files) => {
            for path in files {
                let prefix = path
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .unwrap_or("subagent")
                    .to_owned();
                let nested = HistorySource {
                    path,
                    native_id: None,
                    fingerprint: String::new(),
                    fingerprint_error: None,
                };
                match read_jsonl_filtered(&nested, cancelled, skip_row, |_line, row| {
                    if row.get("type").and_then(Value::as_str) != Some("assistant") {
                        return;
                    }
                    if !fold_assistant(&mut events, &prefix, &row, &mut session.model) {
                        session.partial = true;
                    }
                }) {
                    Ok(nested_partial) => session.partial |= nested_partial,
                    Err(_) => session.partial = true,
                }
            }
        }
        Err(_) => session.partial = true,
    }
    session.usage = events
        .into_iter()
        .map(|(id, event)| UsageEvent {
            id,
            model: event.model,
            timestamp: event.timestamp,
            input: Some(event.counts.input),
            output: Some(event.counts.output),
            cache_read: Some(event.counts.read),
            cache_write: Some(event.counts.write),
            input_includes_cache: false,
        })
        .collect();
    session.finish(source)
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
) -> bool {
    let message = row.get("message").unwrap_or(&Value::Null);
    let model = message.get("model").and_then(Value::as_str).map(str::to_owned);
    if model.as_deref() == Some("<synthetic>") {
        return true;
    }
    if let Some(model) = model.clone() {
        *session_model = Some(model);
    }
    let Some(usage) = message.get("usage") else {
        return true;
    };
    let Some(key) = request_key(
        message.get("id").and_then(Value::as_str),
        row.get("requestId").and_then(Value::as_str),
    ) else {
        return usage
            .as_object()
            .is_none_or(|fields| fields.is_empty());
    };
    let key = if prefix.is_empty() {
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
        usage::keep_largest_output(
            events,
            format!("{key}:advisor:{advisor}"),
            RequestUsage {
                counts,
                model: advisor_model,
                timestamp: time,
            },
        );
        advisor += 1;
    }
    true
}
