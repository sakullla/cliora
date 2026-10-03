use std::collections::HashSet;
use std::path::Path;

use serde_json::Value;

use crate::history::usage::{self, TokenCounts};
use crate::history::{
    discover_jsonl_controlled, raw_string_after, read_jsonl_filtered, text_content, timestamp,
    valid_native_id, HistorySource, ParsedSession, UsageEvent,
};

/// Sessions live in `~/.codebuddy/projects/<workspace-slug>/<session-id>.jsonl`
/// (verified on 2.161.1). The sibling `<session-id>/tool-results` directories
/// never hold session logs, and the top-level `history.jsonl` is a prompt
/// history, not a session transcript, so only uuid-named files are accepted.
pub fn sources(home: &Path) -> Result<Vec<HistorySource>, String> {
    sources_controlled(home, &|| false)
}

pub fn sources_controlled(
    home: &Path,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<HistorySource>, String> {
    let root = crate::accounts::selection::history_root("codebuddy", || {
        super::config_root(home).join("projects")
    });
    let mut sources = discover_jsonl_controlled(
        &root,
        |path| {
            path.extension().is_some_and(|value| value == "jsonl")
                && path
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .is_some_and(session_file_stem)
        },
        cancelled,
    )?;
    // Adapter-local parser version: existing indexes are rebuilt once per
    // parser change even when the native file itself has not changed.
    for source in &mut sources {
        source.fingerprint = format!("codebuddy-session-v1|{}", source.fingerprint);
    }
    Ok(sources)
}

pub fn parse(source: &HistorySource) -> Result<ParsedSession, String> {
    parse_controlled(source, &|| false)
}

/// Rows that never carry conversation text or per-message usage: tool calls and
/// results, reasoning blobs, file snapshots, per-turn metrics and duplicate
/// summaries. `turn-metrics.tokenDelta` is not a billing counter (it exceeds the
/// summed provider usage on verified sessions), so usage comes only from the
/// assistant messages' normalized `providerData.usage`.
fn skip_row(raw: &[u8]) -> bool {
    let Some(kind) = raw_string_after(raw, b"\"type\":\"") else {
        return false;
    };
    matches!(
        kind,
        b"function_call"
            | b"function_call_result"
            | b"reasoning"
            | b"file-history-snapshot"
            | b"turn-metrics"
            | b"summary"
    )
}

/// Normalized provider usage on assistant messages (verified shape):
/// `{inputTokens, outputTokens, inputTokensDetails[{cached_tokens}],
/// outputTokensDetails[{reasoning_tokens}]}`. `inputTokens` includes the
/// cached share and `outputTokens` includes reasoning (OpenAI-style), matching
/// the on-disk totals on the verified session.
fn usage_counts(value: &Value) -> Option<TokenCounts> {
    if !value.is_object() {
        return None;
    }
    let read = value.get("inputTokensDetails").and_then(Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(|item| usage::field(item, "cached_tokens"))
            .sum::<u64>()
    });
    usage::from_optional(
        usage::field(value, "inputTokens"),
        usage::field(value, "outputTokens"),
        read,
        None,
    )
}

/// Session files are named `<uuid>.jsonl` (36 chars, hyphens at 8/13/18/23);
/// the charset check alone would also accept free-form names like "notes".
fn session_file_stem(name: &str) -> bool {
    const UUID_SHAPE: [usize; 4] = [8, 13, 18, 23];
    name.len() == 36
        && UUID_SHAPE.iter().all(|at| name.as_bytes()[*at] == b'-')
        && valid_native_id(name)
}

pub fn parse_controlled(
    source: &HistorySource,
    cancelled: &dyn Fn() -> bool,
) -> Result<ParsedSession, String> {
    let mut session = ParsedSession::new();
    let mut model: Option<String> = None;
    let mut records = HashSet::<String>::new();
    let partial = read_jsonl_filtered(source, cancelled, skip_row, |line, row| {
        let time = row.get("timestamp").and_then(timestamp);
        match row.get("type").and_then(Value::as_str) {
            Some("message") => {
                let role = row.get("role").and_then(Value::as_str).unwrap_or("");
                if role != "user" && role != "assistant" {
                    return;
                }
                // providerData.skipRun marks local command echoes (for example
                // /model round trips), not conversation turns.
                if row
                    .get("providerData")
                    .and_then(|data| data.get("skipRun"))
                    .and_then(Value::as_bool)
                    == Some(true)
                {
                    return;
                }
                if let Some(id) = row
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .filter(|id| valid_native_id(id))
                {
                    session.native_id = Some(id.to_owned());
                }
                if let Some(cwd) = row.get("cwd").and_then(Value::as_str) {
                    session.cwd = Some(cwd.to_owned());
                }
                let provider = row.get("providerData");
                if let Some(current) = provider
                    .and_then(|data| data.get("model"))
                    .and_then(Value::as_str)
                {
                    model = Some(current.to_owned());
                    session.model = model.clone();
                }
                let id = row
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("line-{line}"));
                if role == "assistant" {
                    let counts = provider
                        .and_then(|data| data.get("usage"))
                        .and_then(usage_counts)
                        .map(usage::clamp_cache_inside_input);
                    if let Some(counts) = counts.filter(|counts| usage::active(*counts)) {
                        // Message ids are unique per response, so forked copies
                        // of the same call collapse to one usage event.
                        let event = format!("codebuddy:message:{id}");
                        if records.insert(event.clone()) {
                            session.usage.push(UsageEvent {
                                id: event,
                                model: model.clone(),
                                timestamp: time,
                                input: Some(counts.input),
                                output: Some(counts.output),
                                cache_read: Some(counts.read),
                                cache_write: Some(counts.write),
                                input_includes_cache: true,
                            });
                        }
                    }
                }
                let body = row.get("content").map(text_content).unwrap_or_default();
                session.add_message(id, role, body, time);
            }
            Some("ai-title") => {
                if let Some(id) = row
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .filter(|id| valid_native_id(id))
                {
                    session.native_id = Some(id.to_owned());
                }
                if let Some(title) = row
                    .get("aiTitle")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .filter(|title| !title.trim().is_empty())
                {
                    session.title = title.chars().take(96).collect();
                }
            }
            _ => {}
        }
    })?;
    session.partial |= partial;
    session.finish(source)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn fixtures() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/history")
    }

    fn fixture_source() -> HistorySource {
        HistorySource {
            path: fixtures().join("codebuddy-2.161.1-session.jsonl"),
            native_id: None,
            fingerprint: "test".into(),
            fingerprint_error: None,
        }
    }

    #[test]
    fn sources_discover_only_uuid_named_session_files() {
        let home = tempfile::tempdir().unwrap();
        let projects = home.path().join(".codebuddy/projects/demo-workspace");
        fs::create_dir_all(&projects).unwrap();
        fs::write(
            projects.join("0aa0fb40-0b9c-74c9-8d7c-cd5d630dc6f0.jsonl"),
            "{\"type\":\"message\"}\n",
        )
        .unwrap();
        fs::write(projects.join("notes.jsonl"), "{}\n").unwrap();
        fs::write(projects.join("scratch.txt"), "{}\n").unwrap();
        let sources = sources(home.path()).unwrap();
        assert_eq!(sources.len(), 1);
        assert!(sources[0].fingerprint.starts_with("codebuddy-session-v1|"));
        assert!(sources[0]
            .path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("0aa0fb40"));
    }

    #[test]
    fn fixture_session_parses_identity_title_messages_and_usage() {
        let parsed = parse(&fixture_source()).unwrap();
        assert_eq!(
            parsed.native_id.as_deref(),
            Some("0aa0fb40-0b9c-74c9-8d7c-cd5d630dc6f0")
        );
        assert_eq!(parsed.title, "梳理模块结构并给出重构建议");
        assert_eq!(parsed.model.as_deref(), Some("kimi-k3-2"));
        assert_eq!(
            parsed.cwd.as_deref(),
            Some(r"c:\Users\example\project\demo")
        );
        let roles: Vec<&str> = parsed.messages.iter().map(|m| m.role.as_str()).collect();
        // The two skipRun local-command echoes stay out of the transcript.
        assert_eq!(roles, vec!["user", "assistant", "user", "assistant"]);
        assert!(parsed.messages[0].text.contains("梳理"));
        assert_eq!(parsed.usage.len(), 2);
        let first = &parsed.usage[0];
        assert_eq!(first.input, Some(134819));
        assert_eq!(first.output, Some(364));
        assert_eq!(first.cache_read, Some(134656));
        assert_eq!(first.cache_write, Some(0));
        assert!(first.input_includes_cache);
        assert_eq!(first.model.as_deref(), Some("kimi-k3-2"));
        let second = &parsed.usage[1];
        assert_eq!(second.input, Some(268917));
        assert_eq!(second.cache_read, Some(268706));
        assert!(!parsed.partial);
    }

    #[test]
    fn tool_and_metric_rows_are_skipped_without_parsing() {
        assert!(skip_row(
            br#"{"id":"x","type":"function_call","name":"read_file","arguments":"{}"}"#
        ));
        assert!(skip_row(
            br#"{"type":"turn-metrics","durationMs":1,"tokenDelta":6}"#
        ));
        assert!(skip_row(br#"{"type":"summary","summary":"s"}"#));
        assert!(!skip_row(
            br#"{"id":"x","type":"message","role":"user","content":[]}"#
        ));
        assert!(!skip_row(br#"{"id":"x"}"#));
    }
}
