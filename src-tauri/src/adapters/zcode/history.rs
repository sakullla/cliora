//! ZCode session sources: the bundled agent's model-io rollout logs and the
//! legacy task snapshot files.
//!
//! Two on-disk artifacts are indexed read-only:
//!
//! * `~/.zcode/cli/rollout/model-io-sess_<id>.jsonl` — one file per session,
//!   one JSON row per model call with `sessionId`, `startedAt`,
//!   `model.modelId`, the request body and `response.usage`
//!   (`inputTokens`/`outputTokens`/`totalTokens`/`cacheReadTokens`/
//!   `cacheWriteTokens`, matching the official `ZCodeUsage` fields). The
//!   bundled agent of the desktop app writes these for every session
//!   (verified on a real 3.14.4 install).
//! * `~/.zcode/v2/sessions/{workspaceHash}/{taskId}.json` — the legacy task
//!   snapshot format (`ZCodeSessionFile`: `meta` + `messages`), still written
//!   for imported/legacy tasks. Snapshots carry no token counters, so a
//!   snapshot-only session lists without usage instead of inventing numbers.
//!
//! `~/.zcode/v2/tasks-index.sqlite` is deliberately not read (ADR-10: avoid
//! coupling the internal schema).

use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use serde_json::Value;

use crate::history::usage::{self, RequestUsage};
use crate::history::{
    check_cancelled, discover_jsonl_controlled, read_jsonl_filtered, timestamp, valid_native_id,
    HistorySource, ParsedSession, UsageEvent,
};

const ROLLOUT_PREFIX: &str = "model-io-";

pub fn sources(home: &Path) -> Result<Vec<HistorySource>, String> {
    sources_controlled(home, &|| false)
}

pub fn sources_controlled(
    home: &Path,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<HistorySource>, String> {
    let root = super::data_root(home);
    // Rollout logs first: they carry the token usage, so they win when a task
    // also has a legacy snapshot with the same native id.
    let mut sources = discover_jsonl_controlled(
        &root.join("cli").join("rollout"),
        |path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(ROLLOUT_PREFIX) && name.ends_with(".jsonl"))
        },
        cancelled,
    )?;
    let mut seen = HashSet::new();
    for source in &mut sources {
        source.native_id = rollout_native_id(&source.path);
        if let Some(id) = source.native_id.as_deref() {
            seen.insert(id.to_owned());
        }
    }
    for mut source in discover_jsonl_controlled(
        &root.join("v2").join("sessions"),
        |path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".json") && !name.ends_with(".deleted.json"))
        },
        cancelled,
    )? {
        source.native_id = source
            .path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .filter(|id| valid_native_id(id))
            .map(str::to_owned);
        if source
            .native_id
            .as_deref()
            .is_some_and(|id| seen.insert(id.to_owned()))
        {
            sources.push(source);
        }
    }
    Ok(sources)
}

fn rollout_native_id(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let id = name
        .strip_prefix(ROLLOUT_PREFIX)?
        .strip_suffix(".jsonl")?;
    valid_native_id(id).then(|| id.to_owned())
}

pub fn parse(source: &HistorySource) -> Result<ParsedSession, String> {
    parse_controlled(source, &|| false)
}

pub fn parse_controlled(
    source: &HistorySource,
    cancelled: &dyn Fn() -> bool,
) -> Result<ParsedSession, String> {
    let rollout = source
        .path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(ROLLOUT_PREFIX));
    if rollout {
        parse_rollout(source, cancelled)
    } else {
        parse_snapshot(source, cancelled)
    }
}

/// Legacy task snapshot (`ZCodeSessionFile`): meta + persisted messages. The
/// format has no token counters, so usage stays empty.
fn parse_snapshot(source: &HistorySource, cancelled: &dyn Fn() -> bool) -> Result<ParsedSession, String> {
    check_cancelled(cancelled)?;
    let text = std::fs::read_to_string(&source.path).map_err(|error| error.to_string())?;
    let value: Value =
        serde_json::from_str(&text).map_err(|error| format!("ZCode 任务快照不是有效 JSON：{error}"))?;
    let meta = value
        .get("meta")
        .ok_or("ZCode 任务快照缺少 meta 字段")?;
    let mut session = ParsedSession::new();
    session.native_id = meta
        .get("taskId")
        .and_then(Value::as_str)
        .filter(|id| valid_native_id(id))
        .map(str::to_owned)
        .or_else(|| source.native_id.clone());
    if let Some(title) = meta.get("title").and_then(Value::as_str) {
        session.title = title.to_owned();
    }
    session.cwd = meta
        .get("workspacePath")
        .and_then(Value::as_str)
        .map(str::to_owned);
    session.model = meta
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_owned);
    session.started_at = meta.get("createdAt").and_then(timestamp);
    session.updated_at = meta.get("updatedAt").and_then(timestamp);
    if let Some(messages) = value.get("messages").and_then(Value::as_array) {
        for (index, message) in messages.iter().enumerate() {
            let role = message.get("role").and_then(Value::as_str).unwrap_or("");
            if role != "user" && role != "assistant" {
                continue;
            }
            let Some(content) = message.get("content").and_then(Value::as_str) else {
                continue;
            };
            let id = message
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| format!("message-{index}"));
            session.add_message(id, role, content.to_owned(), message.get("timestamp").and_then(timestamp));
            if session.model.is_none() {
                session.model = message
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
            }
        }
    } else {
        session.partial = true;
    }
    session.finish(source)
}

/// Model-io rollout log: one JSON row per model call. Request bodies repeat the
/// whole conversation, so only each row's newest user prompt is recorded; every
/// row with a non-empty `response.usage` becomes one usage event. `inputTokens`
/// already contains the cached input (`totalTokens = input + output`), which
/// the shared report normalizes through `input_includes_cache`.
fn parse_rollout(source: &HistorySource, cancelled: &dyn Fn() -> bool) -> Result<ParsedSession, String> {
    let mut session = ParsedSession::new();
    session.native_id = source.native_id.clone();
    let mut events: BTreeMap<String, RequestUsage> = BTreeMap::new();
    let mut seen_prompts = HashSet::new();
    let partial = read_jsonl_filtered(source, cancelled, |_| false, |line, row| {
        if row.get("type").and_then(Value::as_str) != Some("model_io") {
            return;
        }
        let model = row
            .get("model")
            .and_then(|model| model.get("modelId"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        if model.is_some() {
            session.model.clone_from(&model);
        }
        let time = row.get("startedAt").and_then(timestamp);
        if let Some(prompt) = newest_user_prompt(&row) {
            if seen_prompts.insert(prompt.clone()) {
                session.add_message(format!("line-{line}-user"), "user", prompt, time);
            }
        }
        let response = row.get("response").unwrap_or(&Value::Null);
        if let Some(text) = response
            .get("text")
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
        {
            session.add_message(
                format!("line-{line}-assistant"),
                "assistant",
                text.to_owned(),
                time,
            );
        }
        let Some(counts) = response.get("usage").and_then(usage_counts) else {
            return;
        };
        if !usage::active(counts) {
            return;
        }
        let key = row
            .get("requestId")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("line-{line}"));
        usage::keep_largest_output(
            &mut events,
            key,
            RequestUsage {
                counts,
                model,
                timestamp: time,
            },
        );
    })?;
    session.partial |= partial;
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
            input_includes_cache: true,
        })
        .collect();
    session.finish(source)
}

fn usage_counts(usage: &Value) -> Option<crate::history::usage::TokenCounts> {
    // An empty usage object (failed/streaming row) is not a billed call.
    if !usage.as_object().is_some_and(|fields| !fields.is_empty()) {
        return None;
    }
    usage::from_optional(
        usage::field(usage, "inputTokens"),
        usage::field(usage, "outputTokens"),
        usage::field(usage, "cacheReadTokens"),
        usage::field(usage, "cacheWriteTokens"),
    )
}

/// The newest user text of a row's request body: the last `user` message whose
/// content has a plain text block (tool results and nested history are not
/// re-recorded).
fn newest_user_prompt(row: &Value) -> Option<String> {
    let messages = row
        .get("request")
        .and_then(|request| request.get("body"))
        .and_then(|body| body.get("messages"))
        .and_then(Value::as_array)?;
    messages.iter().rev().find_map(|message| {
        if message.get("role").and_then(Value::as_str) != Some("user") {
            return None;
        }
        match message.get("content") {
            Some(Value::String(text)) => (!text.trim().is_empty()).then(|| text.clone()),
            Some(Value::Array(blocks)) => blocks.iter().find_map(|block| {
                if block.get("type").and_then(Value::as_str) != Some("text") {
                    return None;
                }
                block
                    .get("text")
                    .and_then(Value::as_str)
                    .filter(|text| !text.trim().is_empty())
                    .map(str::to_owned)
            }),
            _ => None,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROLLOUT_FIXTURE: &str = include_str!(
        "../../../../tests/fixtures/history/zcode-3.14.4-model-io.jsonl"
    );
    const SNAPSHOT_FIXTURE: &str =
        include_str!("../../../../tests/fixtures/history/zcode-3.14.4-task.json");

    #[test]
    fn rollout_log_yields_the_session_list_with_token_usage() {
        let temp = tempfile::tempdir().unwrap();
        let rollout = temp.path().join(".zcode/cli/rollout");
        std::fs::create_dir_all(&rollout).unwrap();
        std::fs::write(
            rollout.join("model-io-sess_fixture-2026_10_03-a1b2c3.jsonl"),
            ROLLOUT_FIXTURE,
        )
        .unwrap();
        let sources = sources(temp.path()).unwrap();
        assert_eq!(sources.len(), 1, "{sources:?}");
        assert_eq!(
            sources[0].native_id.as_deref(),
            Some("sess_fixture-2026_10_03-a1b2c3")
        );
        let session = parse(&sources[0]).unwrap();
        assert_eq!(
            session.native_id.as_deref(),
            Some("sess_fixture-2026_10_03-a1b2c3")
        );
        assert_eq!(session.model.as_deref(), Some("GLM-5.3"));
        assert_eq!(
            session.title, "帮我在仓库里加上每日构建脚本",
            "标题取首条用户输入"
        );
        let roles: Vec<&str> = session
            .messages
            .iter()
            .map(|message| message.role.as_str())
            .collect();
        assert_eq!(roles, vec!["user", "assistant", "user"]);
        assert_eq!(session.usage.len(), 3);
        let first = &session.usage[0];
        assert_eq!(first.model.as_deref(), Some("GLM-5.3"));
        assert_eq!(first.input, Some(115_507));
        assert_eq!(first.output, Some(1_941));
        assert_eq!(first.cache_read, Some(19_456));
        assert_eq!(first.cache_write, Some(0));
        assert!(first.input_includes_cache);
        let total: u64 = session
            .usage
            .iter()
            .map(|event| event.input.unwrap_or(0) + event.output.unwrap_or(0))
            .sum();
        assert_eq!(total, 115_507 + 1_941 + 139_638 + 1_117 + 140_865 + 100);
    }

    #[test]
    fn legacy_task_snapshot_lists_messages_without_invented_usage() {
        let temp = tempfile::tempdir().unwrap();
        let sessions = temp.path().join(".zcode/v2/sessions/1a2b3c4d5e6f");
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::write(
            sessions.join("sess_imported-2026_09_28-deadbeef.json"),
            SNAPSHOT_FIXTURE,
        )
        .unwrap();
        // A deleted marker must not surface as a session.
        std::fs::write(
            sessions.join("sess_imported-2026_09_28-gone.json.deleted.json"),
            "{}",
        )
        .unwrap();
        let sources = sources(temp.path()).unwrap();
        assert_eq!(sources.len(), 1, "{sources:?}");
        assert_eq!(
            sources[0].native_id.as_deref(),
            Some("sess_imported-2026_09_28-deadbeef")
        );
        let session = parse(&sources[0]).unwrap();
        assert_eq!(session.title, "导入的历史任务");
        assert_eq!(
            session.cwd.as_deref(),
            Some("C:\\Users\\user\\project\\demo")
        );
        assert_eq!(session.messages.len(), 2);
        assert_eq!(session.messages[0].role, "user");
        assert_eq!(session.messages[1].role, "assistant");
        assert_eq!(session.model.as_deref(), Some("GLM-5.3"));
        assert!(
            session.usage.is_empty(),
            "快照格式没有 token 字段，不得伪造用量"
        );
    }

    #[test]
    fn rollout_wins_when_a_task_has_both_artifacts() {
        let temp = tempfile::tempdir().unwrap();
        let rollout = temp.path().join(".zcode/cli/rollout");
        std::fs::create_dir_all(&rollout).unwrap();
        std::fs::write(
            rollout.join("model-io-sess_both-2026_10_03-1.jsonl"),
            ROLLOUT_FIXTURE,
        )
        .unwrap();
        let sessions = temp.path().join(".zcode/v2/sessions/1a2b3c4d5e6f");
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::write(sessions.join("sess_both-2026_10_03-1.json"), SNAPSHOT_FIXTURE).unwrap();
        let sources = sources(temp.path()).unwrap();
        assert_eq!(sources.len(), 1, "{sources:?}");
        assert!(sources[0]
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap()
            .starts_with("model-io-"));
    }

    #[test]
    fn newest_user_prompt_skips_tool_results_and_history() {
        let row: Value = serde_json::from_str(
            r#"{"request":{"body":{"messages":[
                {"role":"user","content":[{"type":"text","text":"第一条"}]},
                {"role":"assistant","content":[]},
                {"role":"user","content":[{"type":"tool_result","tool_use_id":"c1","content":"out"}]},
                {"role":"user","content":[{"type":"text","text":"最新一条"}]}
            ]}}}"#,
        )
        .unwrap();
        assert_eq!(newest_user_prompt(&row).as_deref(), Some("最新一条"));
    }
}
