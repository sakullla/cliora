use std::fs;
use std::path::Path;

use serde_json::Value;

use super::usage;
use super::{
    check_cancelled, read_jsonl_controlled, source_fingerprint, source_fingerprint_controlled, text_content, timestamp, valid_native_id, HistorySource,
    ParsedSession, UsageEvent, MAX_SOURCES,
};

pub fn sources(home: &Path) -> Result<Vec<HistorySource>, String> {
    sources_with_fingerprint(home, source_fingerprint)
}

pub fn sources_controlled(home: &Path, cancelled: &dyn Fn() -> bool) -> Result<Vec<HistorySource>, String> {
    sources_with_control(home, |path| source_fingerprint_controlled(path, cancelled), cancelled)
}

pub(super) fn sources_with_fingerprint(
    home: &Path,
    fingerprint: impl Fn(&Path) -> Result<String, String>,
) -> Result<Vec<HistorySource>, String> {
    sources_with_control(home, fingerprint, &|| false)
}

fn sources_with_control(home: &Path, fingerprint: impl Fn(&Path) -> Result<String, String>, cancelled: &dyn Fn() -> bool) -> Result<Vec<HistorySource>, String> {
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
            let checked = ["summary.json", "chat_history.jsonl", "usage.json"]
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
                path,
                native_id,
                fingerprint: checked
                    .as_ref()
                    .map(|parts| parts.join("|"))
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

fn read_json(path: &Path) -> Result<Value, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if metadata.len() > 64 * 1024 * 1024 || path.is_symlink() {
        return Err("Grok 会话资料过大或为链接".into());
    }
    serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
        .map_err(|_| "Grok 会话资料格式无法识别".into())
}

fn token(value: &Value, key: &str) -> Option<u64> {
    usage::field(value, key)
}

fn push_turn(session: &mut ParsedSession, id: String, model: Option<String>, time: Option<i64>, values: &Value) {
    // Grok's inputTokens already include cache. reasoningTokens are already inside outputTokens.
    // `usage.json` turns partition the session; summing `updates.jsonl` turn_completed snapshots would recount.
    let Some(counts) = usage::from_optional(
        token(values, "inputTokens"),
        token(values, "outputTokens"),
        token(values, "cachedReadTokens"),
        token(values, "cacheCreationTokens"),
    ) else {
        return;
    };
    let counts = usage::clamp_cache_inside_input(counts);
    if !usage::active(counts) {
        return;
    }
    session.usage.push(UsageEvent {
        id,
        model,
        timestamp: time,
        input: Some(counts.input),
        output: Some(counts.output),
        cache_read: Some(counts.read),
        cache_write: Some(counts.write),
        input_includes_cache: true,
    });
}

pub fn parse(source: &HistorySource) -> Result<ParsedSession, String> {
    parse_controlled(source, &|| false)
}

pub fn parse_controlled(source: &HistorySource, cancelled: &dyn Fn() -> bool) -> Result<ParsedSession, String> {
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
    if chat.is_file() && !chat.is_symlink() {
        let chat_source = HistorySource {
            path: chat,
            native_id: None,
            fingerprint: String::new(),
            fingerprint_error: None,
        };
        match read_jsonl_controlled(&chat_source, cancelled, |line, row| {
            let role = row.get("type").and_then(Value::as_str).unwrap_or("");
            if role == "user" || role == "assistant" {
                let text = row.get("content").map(text_content).unwrap_or_default();
                session.add_message(
                    format!("line-{line}"),
                    role,
                    text,
                    row.get("timestamp").and_then(timestamp),
                );
            }
        }) {
            Ok(partial) => session.partial |= partial,
            Err(_) => session.partial = true,
        }
    } else {
        session.partial = true;
    }
    let usage_path = source.path.join("usage.json");
    check_cancelled(cancelled)?;
    if usage_path.is_file() {
        match read_json(&usage_path) {
            Ok(usage) => {
                let total = usage.get("session").unwrap_or(&Value::Null);
                let turns = usage
                    .get("turns")
                    .and_then(Value::as_array)
                    .filter(|turns| !turns.is_empty());
                if let Some(turns) = turns {
                    for (index, turn) in turns.iter().enumerate() {
                        check_cancelled(cancelled)?;
                        let time = turn.get("endedAt").and_then(timestamp);
                        let turn_id = turn
                            .get("turnNumber")
                            .and_then(Value::as_u64)
                            .unwrap_or(index as u64);
                        if let Some(models) = turn
                            .get("modelUsage")
                            .and_then(Value::as_object)
                            .filter(|models| !models.is_empty())
                        {
                            for (model, values) in models {
                                check_cancelled(cancelled)?;
                                push_turn(
                                    &mut session,
                                    format!("{}:turn-{turn_id}:{model}", source.key()),
                                    Some(model.clone()),
                                    time,
                                    values,
                                );
                            }
                        } else {
                            let model = turn
                                .get("primaryModelId")
                                .and_then(Value::as_str)
                                .map(str::to_owned)
                                .or_else(|| session.model.clone());
                            push_turn(
                                &mut session,
                                format!("{}:turn-{turn_id}", source.key()),
                                model,
                                time,
                                turn,
                            );
                        }
                    }
                } else if let Some(models) = total
                    .get("modelUsage")
                    .and_then(Value::as_object)
                    .filter(|models| !models.is_empty())
                {
                    let updated = session.updated_at;
                    for (model, values) in models {
                        check_cancelled(cancelled)?;
                        push_turn(
                            &mut session,
                            format!("{}:model-{model}", source.key()),
                            Some(model.clone()),
                            updated,
                            values,
                        );
                    }
                } else if total.is_object() {
                    let model = session.model.clone();
                    let updated = session.updated_at;
                    push_turn(
                        &mut session,
                        format!("{}:session-total", source.key()),
                        model,
                        updated,
                        total,
                    );
                }
            }
            Err(_) => session.partial = true,
        }
    }
    check_cancelled(cancelled)?;
    session.finish(source)
}
