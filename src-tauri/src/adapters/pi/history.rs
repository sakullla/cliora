use std::collections::BTreeMap;
use std::path::Path;

use serde_json::Value;

use crate::history::usage::{self, RequestUsage};
use crate::history::{
    discover_jsonl_controlled, read_jsonl_controlled, text_content, timestamp, valid_native_id,
    HistorySource, ParsedSession, UsageEvent,
};

pub fn sources(home: &Path) -> Result<Vec<HistorySource>, String> {
    sources_controlled(home, &|| false)
}

pub fn sources_controlled(
    home: &Path,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<HistorySource>, String> {
    let mut sources = discover_jsonl_controlled(
        &crate::accounts::selection::history_root("pi", || home.join(".pi/agent/sessions")),
        |path| path.extension().is_some_and(|value| value == "jsonl"),
        cancelled,
    )?;
    for source in &mut sources { source.fingerprint = format!("pi-title-v1|{}", source.fingerprint); }
    Ok(sources)
}

fn remember(
    events: &mut BTreeMap<String, RequestUsage>,
    id: String,
    model: Option<String>,
    time: Option<i64>,
    usage: &Value,
) {
    // Pi follows Anthropic: input excludes cache, and reasoning is already inside output.
    let Some(counts) = usage::from_optional(
        usage::field(usage, "input"),
        usage::field(usage, "output"),
        usage::field(usage, "cacheRead"),
        usage::field(usage, "cacheWrite"),
    ) else {
        return;
    };
    if !usage::active(counts) {
        return;
    }
    usage::keep_largest_output(
        events,
        id,
        RequestUsage {
            counts,
            model,
            timestamp: time,
        },
    );
}

pub fn parse(source: &HistorySource) -> Result<ParsedSession, String> {
    parse_controlled(source, &|| false)
}

pub fn parse_controlled(
    source: &HistorySource,
    cancelled: &dyn Fn() -> bool,
) -> Result<ParsedSession, String> {
    let mut session = ParsedSession::new();
    let mut events = BTreeMap::<String, RequestUsage>::new();
    let mut model: Option<String> = None;
    let partial = read_jsonl_controlled(source, cancelled, |line, row| {
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
            Some("session_info") => {
                if let Some(name) = row.get("name").and_then(Value::as_str).filter(|name| !name.trim().is_empty()) { session.title = name.trim().to_owned(); }
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
                    remember(&mut events, id, event_model, effective_time, usage);
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
                    remember(&mut events, id, event_model, time, usage);
                }
            }
            _ => {}
        }
    })?;
    session.partial |= partial;
    // Pi row ids are only unique inside one file; usage ids must be unique across files.
    let key = source.key();
    session.usage = events
        .into_iter()
        .map(|(id, event)| UsageEvent { native_usage: None,
            request_count: Some(1),
            id: format!("{key}:{id}"),
            model: event.model,
            timestamp: event.timestamp,
            input: Some(event.counts.input),
            output: Some(event.counts.output),
            cache_read: Some(event.counts.read),
            cache_write: Some(event.counts.write),
            input_includes_cache: false, attributions: Vec::new(),
        })
        .collect();
    session.finish(source)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn assert_unlinked(session: &ParsedSession) {
        assert!(session.children.is_empty(), "不得新增子会话");
        assert!(
            session.usage.iter().all(|event| event.attributions.is_empty()),
            "不得新增归属跳转"
        );
    }

    #[test]
    fn declares_no_parent_child_association() {
        use crate::adapters::{CliAdapter, HISTORY_ASSOCIATION_UNAVAILABLE_REASON, PublishedDescriptor};

        let facet = super::super::Pi
            .history_association()
            .expect("pi declares association");
        assert_eq!(facet.state, "unavailable");
        assert_eq!(facet.reason, HISTORY_ASSOCIATION_UNAVAILABLE_REASON);
        let published = PublishedDescriptor::from_adapter(&super::super::Pi);
        assert_eq!(published.descriptor.history.state, "available");
        assert_eq!(
            published.association.as_ref().map(|item| (item.state, item.reason)),
            Some(("unavailable", HISTORY_ASSOCIATION_UNAVAILABLE_REASON))
        );
    }

    #[test]
    fn verified_fixture_stays_viewable_without_parent_child_link() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join(".pi/agent/sessions");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("fixture.jsonl"),
            include_str!("../../../../tests/fixtures/history/pi-0.87-v3.jsonl"),
        )
        .unwrap();
        let sources = sources(home.path()).unwrap();
        assert_eq!(sources.len(), 1);
        let session = parse(&sources[0]).unwrap();
        assert_eq!(
            session.native_id.as_deref(),
            Some("33333333-3333-4333-8333-333333333333")
        );
        assert_eq!(session.usage.len(), 2, "原有用量仍可查看");
        assert!(!session.messages.is_empty());
        assert_unlinked(&session);
    }

    #[test]
    fn unread_fields_do_not_create_parent_child_links() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join(".pi/agent/sessions");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("unread.jsonl"),
            concat!(
                r#"{"type":"session","version":3,"id":"44444444-4444-4444-8444-444444444444","timestamp":"2026-09-29T08:00:00Z","cwd":"/fixture/project","parentId":"33333333-3333-4333-8333-333333333333","querySource":"subagent","agentId":"explore","delegationDepth":2,"agentPreset":"plan","source":"agent"}"#,
                "\n",
                r#"{"type":"message","id":"user-1","timestamp":"2026-09-29T08:00:02Z","querySource":"main_turn","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"Build tests"}],"agent":{"name":"explore"}}}"#,
                "\n",
                r#"{"type":"message","id":"assistant-1","timestamp":"2026-09-29T08:00:03Z","querySource":"subagent","message":{"role":"assistant","content":[{"type":"text","text":"Done."}],"model":"gpt-5","parentAgentId":"main","usage":{"input":11,"output":7,"cacheRead":3,"cacheWrite":2,"totalTokens":23}}}"#,
                "\n",
            ),
        )
        .unwrap();
        let sources = sources(home.path()).unwrap();
        assert_eq!(sources.len(), 1);
        let session = parse(&sources[0]).unwrap();
        assert_eq!(
            session.native_id.as_deref(),
            Some("44444444-4444-4444-8444-444444444444")
        );
        assert_ne!(
            session.native_id.as_deref(),
            Some("33333333-3333-4333-8333-333333333333")
        );
        assert_eq!(session.messages.len(), 2);
        assert_eq!(session.usage.len(), 1);
        assert_eq!(session.usage[0].input, Some(11));
        assert_eq!(session.usage[0].output, Some(7));
        assert_ne!(session.title, "explore");
        assert_unlinked(&session);
    }
}
