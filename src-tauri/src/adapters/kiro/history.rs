//! Kiro CLI session sources: legacy `sessions/cli/<uuid>.jsonl`, V2
//! `<data-root>/<workspace>/sess_<id>/messages.jsonl` and V3
//! `<data-root>/sessions/<workspace-hash>/sess_<id>/messages.jsonl`
//! (recursive discovery covers both current layouts unchanged).
//!
//! [RE] Evidence class: the legacy and V2 layouts come from community
//! reverse engineering (agentsview kiro.go, threadle) cross-checked with AWS
//! Builder blog material; the V3 shapes below were read off a real local
//! install (kiro-cli 2.34.2, `chat.agentEngine: v3`; 01-exploration.md §2)
//! and are recorded as observed evidence. Per the [RE] policy an unknown row
//! kind or malformed shape degrades to `partial` and is never guessed;
//! compatibility is declared only for the shapes recorded here.
//!
//! * Legacy sessions live in `<root>/sessions/cli/<uuid>.jsonl` with a sibling
//!   `<uuid>.json` metadata file `{session_id, cwd, title, created_at,
//!   updated_at}`; rows are `{kind, data}` with kind ∈ Prompt |
//!   AssistantMessage | ToolResults and content blocks text | toolUse |
//!   toolResult. Only text blocks are conversation turns.
//! * Current sessions (V2 and V3) hold `messages.jsonl` plus a sibling
//!   `session.json` `{title, createdAt, lastModifiedAt, workspacePaths,
//!   modelId}`; rows are `{id, payload, timestamp}` with payload types user |
//!   assistant | tool_call | tool_result | session_metadata | usage_summary
//!   plus the structural kinds below. The assistant model rides in
//!   `reasoningModelId`; `session.json.modelId` is only the fallback when no
//!   row ever carried one.
//! * V3 `session_metadata` rows `{key, value, executionId}` with key
//!   `contextUsage` carry `value.usagePercentage`, the context occupancy
//!   percent of the session; it is emitted as a native usage event with unit
//!   `context-usage-percent` (never converted to tokens or money). No token
//!   field exists in any format, so no token usage is ever produced. Other
//!   `session_metadata` keys have no recorded shape.
//! * V3 `usage_summary` rows `{promptTurnSummaries: [{unit, unitPlural,
//!   usage, usedTools}], elapsedTime, status, ...}` carry per-turn native
//!   credit consumption; each entry with a usable `unit`/`usage` becomes a
//!   native usage event (aggregate, request count unknown). No token or
//!   monetary field exists in any format.
//! * V3 structural/metadata rows that never enter the conversation timeline
//!   and are ignored as known shapes: `agent_note` (internal session-context
//!   snapshot), `turn_start`, `turn_end`, `session_start` (system prompt),
//!   `session_event`, `steering_inclusion`, `pending_interaction`,
//!   `interaction_resolved`.
//! * `.history` and `.snapshots` directories are internal rollups, never
//!   session sources. The V3 snapshot rollup is a dotless `snapshots/`
//!   directory of hash-named subdirectories holding file snapshots and a
//!   `.hash` marker; observed shapes contain no `messages.jsonl`, so they
//!   never become session sources.
//! * `data.sqlite3` (`conversations_v2`) is a persistent archive; its table
//!   shape (key/conversation_id/value/created_at/updated_at) was read off a
//!   real Windows install, but that install holds zero rows, so the `value`
//!   payload shape has no evidence. It is deliberately NOT indexed (known
//!   limitation recorded in the adapter descriptor; never guessed).

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::history::{
    check_cancelled, discover_jsonl_controlled, read_jsonl_controlled,
    source_fingerprint_controlled, text_content, timestamp, valid_native_id, HistorySource,
    NativeUsage, ParsedSession, UsageEvent,
};

/// Parser/fingerprint version: existing indexes are rebuilt once per parser
/// change even when the native files themselves have not changed. v2 adds the
/// V3 `session_metadata` row kind (contextUsage native usage) and the
/// `session.json.modelId` fallback.
const FINGERPRINT_PREFIX: &str = "kiro-session-v2";

pub fn sources(home: &Path) -> Result<Vec<HistorySource>, String> {
    sources_controlled(home, &|| false)
}

pub fn sources_controlled(
    home: &Path,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<HistorySource>, String> {
    check_cancelled(cancelled)?;
    // Both formats hang off one data root (see `data_root` in the adapter
    // module for the Windows candidate resolution).
    let root = crate::accounts::selection::history_root("kiro", || super::data_root(home));
    let mut sources = discover_jsonl_controlled(
        &root.join("sessions").join("cli"),
        |path| {
            path.extension().is_some_and(|value| value == "jsonl")
                && path
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .is_some_and(legacy_session_stem)
                && !inside_excluded_directory(path)
        },
        cancelled,
    )?;
    sources.extend(discover_jsonl_controlled(
        &root,
        |path| {
            path.file_name().and_then(|value| value.to_str()) == Some("messages.jsonl")
                && path
                    .parent()
                    .and_then(|parent| parent.file_name())
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("sess_"))
                && !inside_excluded_directory(path)
        },
        cancelled,
    )?);
    annotate(&mut sources, cancelled)?;
    Ok(sources)
}

/// Internal rollup directories that never hold session sources.
fn inside_excluded_directory(path: &Path) -> bool {
    path.components().any(|component| {
        matches!(
            component.as_os_str().to_str(),
            Some(".history") | Some(".snapshots")
        )
    })
}

/// Legacy session files are named `<uuid>.jsonl` (36 chars, hyphens at
/// 8/13/18/23); the charset check alone would also accept free-form names.
fn legacy_session_stem(name: &str) -> bool {
    const UUID_SHAPE: [usize; 4] = [8, 13, 18, 23];
    name.len() == 36
        && UUID_SHAPE.iter().all(|at| name.as_bytes()[*at] == b'-')
        && valid_native_id(name)
}

/// Fold the sibling metadata file into the fingerprint so a metadata change
/// (title/cwd/timestamps) reindexes the session, and attach the native id
/// (legacy metadata `session_id`, otherwise the file or `sess_<id>` identity).
fn annotate(sources: &mut [HistorySource], cancelled: &dyn Fn() -> bool) -> Result<(), String> {
    for source in sources.iter_mut() {
        check_cancelled(cancelled)?;
        source.native_id = native_id_of(&source.path);
        let mut parts = vec![source.fingerprint.clone()];
        let mut error = source.fingerprint_error.take();
        if let Some(metadata) = metadata_path(&source.path).filter(|path| path.is_file()) {
            match source_fingerprint_controlled(&metadata, cancelled) {
                Ok(stamp) => parts.push(stamp),
                Err(message) => error = Some(message),
            }
        }
        if let Some(message) = error {
            source.fingerprint = String::new();
            source.fingerprint_error = Some(message);
        } else {
            source.fingerprint = format!("{FINGERPRINT_PREFIX}|{}", parts.join("|"));
        }
    }
    Ok(())
}

/// Sibling metadata of one session log: `sess_<id>/session.json` for the
/// current format, `<uuid>.json` for the legacy format.
fn metadata_path(log: &Path) -> Option<PathBuf> {
    if is_current_log(log) {
        return log.parent().map(|parent| parent.join("session.json"));
    }
    let stem = log.file_stem()?.to_str()?;
    log.parent().map(|parent| parent.join(format!("{stem}.json")))
}

fn is_current_log(log: &Path) -> bool {
    log.file_name().and_then(|name| name.to_str()) == Some("messages.jsonl")
}

/// Native session identity: the `sess_<id>` directory for the current format,
/// the uuid file stem for the legacy format (the metadata `session_id`
/// refines the legacy id at parse time when present).
fn native_id_of(log: &Path) -> Option<String> {
    let candidate = if is_current_log(log) {
        log.parent()
            .and_then(|parent| parent.file_name())
            .and_then(|name| name.to_str())
        } else {
            log.file_stem().and_then(|stem| stem.to_str())
    }?;
    valid_native_id(candidate).then(|| candidate.to_owned())
}

pub fn parse(source: &HistorySource) -> Result<ParsedSession, String> {
    parse_controlled(source, &|| false)
}

pub fn parse_controlled(
    source: &HistorySource,
    cancelled: &dyn Fn() -> bool,
) -> Result<ParsedSession, String> {
    if is_current_log(&source.path) {
        parse_current(source, cancelled)
    } else {
        parse_legacy(source, cancelled)
    }
}

/// Conversation text of one row payload: content blocks keep only text
/// blocks; toolUse/toolResult blocks never enter the transcript.
fn block_text(data: &Value) -> String {
    if let Some(text) = data.as_str() {
        return text.to_owned();
    }
    data.get("content").map(text_content).unwrap_or_default()
}

/// `None` when no sibling metadata file exists (older sessions wrote none);
/// `Some(None)` when a file is present but unreadable or malformed, which
/// degrades the session to partial instead of being guessed.
fn read_metadata(log: &Path) -> Option<Option<Value>> {
    let path = metadata_path(log)?;
    if !path.is_file() {
        return None;
    }
    Some(
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok()),
    )
}

fn parse_legacy(source: &HistorySource, cancelled: &dyn Fn() -> bool) -> Result<ParsedSession, String> {
    check_cancelled(cancelled)?;
    let mut session = ParsedSession::new();
    match read_metadata(&source.path) {
        Some(Some(meta)) => {
            if let Some(id) = meta
                .get("session_id")
                .and_then(Value::as_str)
                .filter(|id| valid_native_id(id))
            {
                session.native_id = Some(id.to_owned());
            }
            if let Some(title) = meta
                .get("title")
                .and_then(Value::as_str)
                .filter(|title| !title.trim().is_empty())
            {
                session.title = title.chars().take(96).collect();
            }
            if let Some(cwd) = meta
                .get("cwd")
                .and_then(Value::as_str)
                .filter(|cwd| !cwd.trim().is_empty())
            {
                session.cwd = Some(cwd.to_owned());
            }
            session.started_at = meta.get("created_at").and_then(timestamp);
            session.updated_at = meta.get("updated_at").and_then(timestamp);
        }
        Some(None) => session.partial = true,
        None => {}
    }
    if session.native_id.is_none() {
        session.native_id = native_id_of(&source.path);
    }
    let partial = read_jsonl_controlled(source, cancelled, |line, row| {
        let kind = row.get("kind").and_then(Value::as_str).unwrap_or("");
        let data = row.get("data").unwrap_or(&Value::Null);
        match kind {
            "Prompt" => session.add_message(
                format!("line-{line}"),
                "user",
                block_text(data),
                None,
            ),
            "AssistantMessage" => session.add_message(
                format!("line-{line}"),
                "assistant",
                block_text(data),
                None,
            ),
            // Tool results never carry conversation turns.
            "ToolResults" => {}
            // Unknown kinds are future/native shapes without [RE] evidence.
            _ => session.partial = true,
        }
    })?;
    session.partial |= partial;
    check_cancelled(cancelled)?;
    session.finish(source)
}

fn parse_current(source: &HistorySource, cancelled: &dyn Fn() -> bool) -> Result<ParsedSession, String> {
    check_cancelled(cancelled)?;
    let mut session = ParsedSession::new();
    session.native_id = native_id_of(&source.path);
    match read_metadata(&source.path) {
        Some(Some(meta)) => {
            if let Some(title) = meta
                .get("title")
                .and_then(Value::as_str)
                .filter(|title| !title.trim().is_empty())
            {
                session.title = title.chars().take(96).collect();
            }
            if let Some(cwd) = meta
                .get("workspacePaths")
                .and_then(Value::as_array)
                .and_then(|paths| paths.first())
                .and_then(Value::as_str)
                .filter(|cwd| !cwd.trim().is_empty())
            {
                session.cwd = Some(cwd.to_owned());
            }
            session.started_at = meta.get("createdAt").and_then(timestamp);
            session.updated_at = meta.get("lastModifiedAt").and_then(timestamp);
            // Fallback only: a later `reasoningModelId` row overwrites it.
            if session.model.is_none() {
                if let Some(model) = meta
                    .get("modelId")
                    .and_then(Value::as_str)
                    .filter(|model| !model.trim().is_empty())
                {
                    session.model = Some(model.to_owned());
                }
            }
        }
        Some(None) => session.partial = true,
        None => {}
    }
    let partial = read_jsonl_controlled(source, cancelled, |line, row| {
        let time = row.get("timestamp").and_then(timestamp);
        let Some(payload) = row.get("payload") else {
            session.partial = true;
            return;
        };
        let kind = payload.get("type").and_then(Value::as_str).unwrap_or("");
        match kind {
            "user" => session.add_message(
                format!("line-{line}"),
                "user",
                block_text(payload),
                time,
            ),
            "assistant" => {
                if let Some(model) = payload
                    .get("reasoningModelId")
                    .and_then(Value::as_str)
                    .filter(|model| !model.is_empty())
                {
                    session.model = Some(model.to_owned());
                }
                session.add_message(
                    format!("line-{line}"),
                    "assistant",
                    block_text(payload),
                    time,
                )
            }
            // Tool traffic never carries conversation turns.
            "tool_call" | "tool_result" => {}
            // V3 structural rows: internal snapshots, turn/session
            // boundaries, system prompts and approval bookkeeping. Known
            // shapes that never enter the conversation timeline.
            "agent_note" | "turn_start" | "turn_end" | "session_start"
            | "session_event" | "steering_inclusion" | "pending_interaction"
            | "interaction_resolved" => {}
            // V3 session-level metadata; only the contextUsage shape is
            // recorded (see the module header for its evidence class).
            "session_metadata" => match payload.get("key").and_then(Value::as_str) {
                Some("contextUsage") => match payload
                    .get("value")
                    .and_then(|value| value.get("usagePercentage"))
                    .and_then(Value::as_f64)
                    .filter(|value| value.is_finite() && *value >= 0.0)
                {
                    Some(percent) => {
                        // Row ids are session-scoped counters, never assumed
                        // globally unique across sessions.
                        let scope = session
                            .native_id
                            .clone()
                            .unwrap_or_else(|| source.key());
                        let row_id = row
                            .get("id")
                            .and_then(Value::as_str)
                            .filter(|id| valid_native_id(id))
                            .map(str::to_owned)
                            .unwrap_or_else(|| format!("line-{line}"));
                        session.usage.push(UsageEvent {
                            native_usage: Some(NativeUsage {
                                unit: "context-usage-percent".into(),
                                value: percent,
                                original_value: None,
                                billable: None,
                            }),
                            request_count: None,
                            id: format!("context:{scope}:{row_id}"),
                            model: None,
                            timestamp: time,
                            input: None,
                            output: None,
                            cache_read: None,
                            cache_write: None,
                            input_includes_cache: false,
                            attributions: Vec::new(),
                        });
                    }
                    // A contextUsage row without a finite percentage is a new
                    // native shape; never guessed.
                    None => session.partial = true,
                },
                // Other metadata keys have no recorded shape.
                _ => session.partial = true,
            },
            // V3 per-turn native credit consumption; an aggregate summary, so
            // the request count stays unknown. Each entry needs a usable
            // native `unit` and finite non-negative `usage`; anything else is
            // a new native shape and is never guessed.
            "usage_summary" => match payload.get("promptTurnSummaries") {
                Some(Value::Array(summaries)) => {
                    for (index, entry) in summaries.iter().enumerate() {
                        let unit = entry.get("unit").and_then(Value::as_str);
                        let value = entry
                            .get("usage")
                            .and_then(Value::as_f64)
                            .filter(|value| value.is_finite() && *value >= 0.0);
                        match (unit.filter(|unit| !unit.trim().is_empty()), value) {
                            (Some(unit), Some(value)) => {
                                // Row ids are session-scoped counters, never
                                // assumed globally unique across sessions.
                                let scope = session
                                    .native_id
                                    .clone()
                                    .unwrap_or_else(|| source.key());
                                let row_id = row
                                    .get("id")
                                    .and_then(Value::as_str)
                                    .filter(|id| valid_native_id(id))
                                    .map(str::to_owned)
                                    .unwrap_or_else(|| format!("line-{line}"));
                                session.usage.push(UsageEvent {
                                    native_usage: Some(NativeUsage {
                                        unit: unit.to_owned(),
                                        value,
                                        original_value: None,
                                        billable: None,
                                    }),
                                    request_count: None,
                                    id: format!("usage:{scope}:{row_id}-{index}"),
                                    model: None,
                                    timestamp: time,
                                    input: None,
                                    output: None,
                                    cache_read: None,
                                    cache_write: None,
                                    input_includes_cache: false,
                                    attributions: Vec::new(),
                                });
                            }
                            _ => session.partial = true,
                        }
                    }
                }
                _ => session.partial = true,
            },
            // Unknown payload types are future/native shapes without [RE]
            // evidence.
            _ => session.partial = true,
        }
    })?;
    session.partial |= partial;
    check_cancelled(cancelled)?;
    session.finish(source)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fixtures() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/history/kiro-cli-sessions")
    }

    fn copy_tree(from: &Path, to: &Path) {
        fs::create_dir_all(to).unwrap();
        for entry in fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            let target = to.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy_tree(&entry.path(), &target);
            } else {
                fs::copy(entry.path(), target).unwrap();
            }
        }
    }

    fn fixture_home() -> tempfile::TempDir {
        let home = tempfile::tempdir().unwrap();
        copy_tree(&fixtures().join("legacy"), &home.path().join(".kiro/sessions/cli"));
        copy_tree(
            &fixtures().join("demo-workspace"),
            &home.path().join(".kiro/demo-workspace"),
        );
        // V3 workspace-hash layout sits directly under `sessions/`.
        copy_tree(&fixtures().join("v3-workspace"), &home.path().join(".kiro/sessions"));
        home
    }

    fn assert_unlinked(session: &ParsedSession) {
        assert!(session.children.is_empty(), "不得新增子会话");
        assert!(
            session.usage.iter().all(|event| event.attributions.is_empty()),
            "不得新增归属跳转"
        );
    }

    fn source_for(path: PathBuf) -> HistorySource {
        HistorySource {
            native_title: None,
            path,
            native_id: None,
            fingerprint: "test".into(),
            fingerprint_error: None,
        }
    }

    #[test]
    fn sources_discover_both_formats_and_skip_internal_directories() {
        let home = fixture_home();
        // Non-uuid logs in the legacy directory and internal rollup copies of
        // the current format must never become sources.
        fs::write(
            home.path().join(".kiro/sessions/cli/notes.jsonl"),
            "{\"kind\":\"Prompt\",\"data\":{}}\n",
        )
        .unwrap();
        fs::create_dir_all(home.path().join(".kiro/demo-workspace/.history/sess_old0000000000")).unwrap();
        fs::write(
            home.path()
                .join(".kiro/demo-workspace/.history/sess_old0000000000/messages.jsonl"),
            "{\"payload\":{\"type\":\"user\",\"content\":[]}}\n",
        )
        .unwrap();
        fs::create_dir_all(home.path().join(".kiro/demo-workspace/.snapshots/sess_old0000000001")).unwrap();
        fs::write(
            home.path()
                .join(".kiro/demo-workspace/.snapshots/sess_old0000000001/messages.jsonl"),
            "{\"payload\":{\"type\":\"user\",\"content\":[]}}\n",
        )
        .unwrap();
        let sources = sources(home.path()).unwrap();
        assert_eq!(sources.len(), 3, "{sources:?}");
        let ids: Vec<&str> = sources
            .iter()
            .filter_map(|source| source.native_id.as_deref())
            .collect();
        assert!(ids.contains(&"6f5813aa-9d04-4d7b-b3e2-5c1f0a67d2e4"), "{ids:?}");
        assert!(ids.contains(&"sess_a1b2c3d4e5f67890"), "{ids:?}");
        assert!(
            ids.contains(&"sess_3f2a9c81-6b4d-4e8f-9a21-7c5d0b8e4f13"),
            "{ids:?}"
        );
        assert!(sources
            .iter()
            .all(|source| source.fingerprint.starts_with("kiro-session-v2|")));
        // The V3 dotless `snapshots` rollup directory is not an excluded name;
        // its observed hash-named subdirectories hold no `messages.jsonl`, so
        // it must still never produce a session source.
        assert!(
            sources.iter().all(|source| !source.path.components().any(
                |component| component.as_os_str().to_str() == Some("snapshots")
            )),
            "无点 snapshots 目录不得产生会话源：{sources:?}"
        );
    }

    #[test]
    fn missing_roots_yield_no_sources() {
        let home = tempfile::tempdir().unwrap();
        assert!(sources(home.path()).unwrap().is_empty());
    }

    #[test]
    fn metadata_change_flips_the_source_fingerprint() {
        let home = fixture_home();
        let before = sources(home.path()).unwrap().remove(0).fingerprint;
        let metadata = home
            .path()
            .join(".kiro/sessions/cli/6f5813aa-9d04-4d7b-b3e2-5c1f0a67d2e4.json");
        let mut text = fs::read_to_string(&metadata).unwrap();
        text = text.replace("跨平台构建脚本调整", "跨平台构建脚本调整（改）");
        // mtime-only edits can be invisible to the change-time fingerprint, so
        // also bump the size like a real native rewrite of the metadata.
        text.push(' ');
        fs::write(&metadata, text).unwrap();
        let after = sources(home.path()).unwrap().remove(0).fingerprint;
        assert_ne!(before, after, "元数据变化必须触发重扫");
    }

    #[test]
    fn legacy_fixture_parses_identity_title_cwd_and_transcript() {
        let source = source_for(
            fixtures()
                .join("legacy/6f5813aa-9d04-4d7b-b3e2-5c1f0a67d2e4.jsonl"),
        );
        let session = parse(&source).unwrap();
        assert_eq!(
            session.native_id.as_deref(),
            Some("6f5813aa-9d04-4d7b-b3e2-5c1f0a67d2e4")
        );
        assert_eq!(session.title, "跨平台构建脚本调整");
        assert_eq!(
            session.cwd.as_deref(),
            Some(r"C:\Users\example\kiro-demo")
        );
        assert_eq!(session.started_at, Some(1790586900000));
        assert_eq!(session.updated_at, Some(1790587920000));
        let roles: Vec<&str> = session
            .messages
            .iter()
            .map(|message| message.role.as_str())
            .collect();
        // Prompt rows are user turns, AssistantMessage rows assistant turns,
        // and the ToolResults row never enters the transcript.
        assert_eq!(roles, vec!["user", "assistant", "assistant"]);
        assert!(session
            .messages
            .iter()
            .all(|message| !message.text.is_empty()));
        assert!(!session.partial);
        // The legacy format carries no usage fields of any kind.
        assert!(session.usage.is_empty());
        assert_unlinked(&session);
    }

    #[test]
    fn current_fixture_parses_identity_model_cwd_and_timestamps() {
        let source = source_for(fixtures().join(
            "demo-workspace/sess_a1b2c3d4e5f67890/messages.jsonl",
        ));
        let session = parse(&source).unwrap();
        assert_eq!(session.native_id.as_deref(), Some("sess_a1b2c3d4e5f67890"));
        assert_eq!(session.title, "仓库模块结构梳理");
        assert_eq!(
            session.cwd.as_deref(),
            Some(r"C:\Users\example\kiro-demo")
        );
        assert_eq!(session.model.as_deref(), Some("claude-sonnet-4-5"));
        assert_eq!(session.started_at, Some(1790755200000));
        assert_eq!(session.updated_at, Some(1790755320000));
        let roles: Vec<&str> = session
            .messages
            .iter()
            .map(|message| message.role.as_str())
            .collect();
        // tool_call/tool_result rows never enter the transcript.
        assert_eq!(roles, vec!["user", "assistant", "assistant"]);
        assert_eq!(session.messages.len(), 3);
        assert!(session
            .messages
            .iter()
            .all(|message| !message.text.is_empty()));
        assert!(session.messages.iter().all(|message| message.timestamp.is_some()));
        assert!(!session.partial);
        assert!(session.usage.is_empty(), "无 session_metadata 行的会话不产生用量");
        assert_unlinked(&session);
    }

    #[test]
    fn v3_fixture_parses_context_usage_without_partial() {
        let source = source_for(fixtures().join(
            "v3-workspace/4a7c1e92b3d05f68/sess_3f2a9c81-6b4d-4e8f-9a21-7c5d0b8e4f13/messages.jsonl",
        ));
        let session = parse(&source).unwrap();
        assert_eq!(
            session.native_id.as_deref(),
            Some("sess_3f2a9c81-6b4d-4e8f-9a21-7c5d0b8e4f13")
        );
        assert_eq!(session.title, "界面改版方案讨论");
        assert_eq!(session.cwd.as_deref(), Some(r"C:\Users\example\project\demo"));
        // 行内 reasoningModelId 优先于 session.json 的 modelId 回退。
        assert_eq!(session.model.as_deref(), Some("qdev::claude-opus-5.5"));
        assert_eq!(session.started_at, Some(1793088000000));
        assert_eq!(session.updated_at, Some(1793088180000));
        assert!(
            !session.partial,
            "session_metadata/contextUsage、usage_summary 与结构行都是已核对形状，不得标 partial"
        );
        let roles: Vec<&str> = session
            .messages
            .iter()
            .map(|message| message.role.as_str())
            .collect();
        // 结构行（agent_note/turn_*/session_start/session_event/
        // steering_inclusion/pending_interaction/interaction_resolved）不进时间线。
        assert_eq!(roles, vec!["user", "assistant", "user", "assistant"]);
        let expected: [(&str, &str, f64, i64); 5] = [
            (
                "context:sess_3f2a9c81-6b4d-4e8f-9a21-7c5d0b8e4f13:a1b2c3d4-2222-4aaa-8bbb-cccc2222dddd",
                "context-usage-percent",
                3.2563,
                1793088030888,
            ),
            (
                "context:sess_3f2a9c81-6b4d-4e8f-9a21-7c5d0b8e4f13:a1b2c3d4-4444-4aaa-8bbb-cccc4444dddd",
                "context-usage-percent",
                30.2031,
                1793088090000,
            ),
            (
                "usage:sess_3f2a9c81-6b4d-4e8f-9a21-7c5d0b8e4f13:05f2547e-70a9-47fa-b7a7-000000000001-usage-0",
                "credit",
                0.9504849316749585,
                1793088100000,
            ),
            (
                "usage:sess_3f2a9c81-6b4d-4e8f-9a21-7c5d0b8e4f13:1c8a4030-6c80-40f7-91da-000000000002-usage-0",
                "credit",
                45.54515652271972,
                1793088175000,
            ),
            (
                "context:sess_3f2a9c81-6b4d-4e8f-9a21-7c5d0b8e4f13:a1b2c3d4-7777-4aaa-8bbb-cccc7777dddd",
                "context-usage-percent",
                42.5,
                1793088180000,
            ),
        ];
        assert_eq!(session.usage.len(), expected.len());
        for (event, (id, unit, value, time)) in session.usage.iter().zip(expected) {
            assert_eq!(event.id, id);
            assert_eq!(event.model, None, "原生单位用量不携带模型");
            assert_eq!(event.timestamp, Some(time), "取行时间");
            assert_eq!(event.request_count, None, "聚合摘要的请求数未知");
            let usage = event
                .native_usage
                .as_ref()
                .expect("每条用量行都有原生用量");
            assert_eq!(usage.unit, unit);
            assert!((usage.value - value).abs() < 1e-9);
            assert_eq!(usage.original_value, None);
            assert_eq!(usage.billable, None);
        }
        assert_unlinked(&session);
    }

    #[test]
    fn v3_model_falls_back_to_session_model_id() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp
            .path()
            .join(".kiro/sessions/4a7c1e92b3d05f68/sess_9d8e7f6a-5b4c-4d3e-9f01-87654321abcd");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("session.json"),
            concat!(
                r#"{"title":"无行内模型的会话","createdAt":"2026-10-27T08:00:00Z","lastModifiedAt":"2026-10-27T08:00:10Z","#,
                r#""workspacePaths":["C:\\work\\demo"],"modelId":"claude-opus-5.5"}"#
            ),
        )
        .unwrap();
        fs::write(
            dir.join("messages.jsonl"),
            concat!(
                r#"{"id":"b1b2c3d4-8888-4aaa-8bbb-cccc8888dddd","timestamp":"2026-10-27T08:00:05Z","payload":{"type":"user","content":"问"}}"#,
                "\n",
                r#"{"id":"b1b2c3d4-9999-4aaa-8bbb-cccc9999dddd","timestamp":"2026-10-27T08:00:10Z","payload":{"type":"assistant","content":"答"}}"#,
                "\n",
            ),
        )
        .unwrap();
        let sources = sources(temp.path()).unwrap();
        assert_eq!(sources.len(), 1, "{sources:?}");
        let session = parse(&sources[0]).unwrap();
        assert_eq!(
            session.model.as_deref(),
            Some("claude-opus-5.5"),
            "无 reasoningModelId 行时以 session.json.modelId 回退"
        );
        assert!(!session.partial);
        assert!(session.usage.is_empty());
    }

    #[test]
    fn unknown_session_metadata_shapes_stay_partial() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp
            .path()
            .join(".kiro/sessions/4a7c1e92b3d05f68/sess_0e1f2a3b-4c5d-4e6f-8a90-1234567890ab");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("session.json"),
            r#"{"title":"含未知元数据的会话","workspacePaths":["C:\\work\\demo"]}"#,
        )
        .unwrap();
        fs::write(
            dir.join("messages.jsonl"),
            concat!(
                r#"{"id":"c1b2c3d4-1111-4aaa-8bbb-cccc1111dddd","timestamp":"2026-10-27T08:00:00Z","payload":{"type":"user","content":"问"}}"#,
                "\n",
                // displayError 等其它 key 的 value 形状未核对。
                r#"{"id":"c1b2c3d4-2222-4aaa-8bbb-cccc2222dddd","timestamp":"2026-10-27T08:00:01Z","payload":{"type":"session_metadata","key":"displayError","value":{"message":"x"},"executionId":"e1"}}"#,
                "\n",
                r#"{"id":"c1b2c3d4-3333-4aaa-8bbb-cccc3333dddd","timestamp":"2026-10-27T08:00:02Z","payload":{"type":"session_metadata","key":"futureKey"}}"#,
                "\n",
                // contextUsage 但缺少可用的 usagePercentage：不猜。
                r#"{"id":"c1b2c3d4-4444-4aaa-8bbb-cccc4444dddd","timestamp":"2026-10-27T08:00:03Z","payload":{"type":"session_metadata","key":"contextUsage","value":{}}}"#,
                "\n",
                // usage_summary 条目缺 usage 或缺 unit、以及整行缺
                // promptTurnSummaries：均为未核对形状。
                r#"{"id":"c1b2c3d4-5555-4aaa-8bbb-cccc5555dddd","timestamp":"2026-10-27T08:00:04Z","payload":{"type":"usage_summary","promptTurnSummaries":[{"unit":"credit","usedTools":[]}]}}"#,
                "\n",
                r#"{"id":"c1b2c3d4-6666-4aaa-8bbb-cccc6666dddd","timestamp":"2026-10-27T08:00:05Z","payload":{"type":"usage_summary","promptTurnSummaries":[{"usage":1.5}]}}"#,
                "\n",
                r#"{"id":"c1b2c3d4-7777-4aaa-8bbb-cccc7777dddd","timestamp":"2026-10-27T08:00:06Z","payload":{"type":"usage_summary"}}"#,
                "\n",
            ),
        )
        .unwrap();
        let sources = sources(temp.path()).unwrap();
        assert_eq!(sources.len(), 1, "{sources:?}");
        let session = parse(&sources[0]).unwrap();
        assert!(session.partial, "未知 key 与畸形形状必须标 partial");
        assert_eq!(session.messages.len(), 1, "已知行仍须进入时间线");
        assert!(session.usage.is_empty(), "畸形用量行不得造出用量");
        assert_unlinked(&session);
    }

    #[test]
    fn unknown_row_shapes_degrade_to_partial_without_guessing() {
        let temp = tempfile::tempdir().unwrap();
        let legacy_dir = temp.path().join(".kiro/sessions/cli");
        fs::create_dir_all(&legacy_dir).unwrap();
        fs::write(
            legacy_dir.join("0aa0fb40-0b9c-74c9-8d7c-cd5d630dc6f0.jsonl"),
            concat!(
                r#"{"kind":"Prompt","data":{"content":[{"type":"text","text":"第一句"}]}}"#,
                "\n",
                r#"{"kind":"FutureKind","data":{"content":[]}}"#,
                "\n",
                r#"{"kind":"AssistantMessage","data":{"content":[{"type":"text","text":"回复"}]}}"#,
                "\n",
            ),
        )
        .unwrap();
        let current_dir = temp.path().join(".kiro/demo-workspace/sess_b1b2c3d4e5f67890");
        fs::create_dir_all(&current_dir).unwrap();
        fs::write(
            current_dir.join("messages.jsonl"),
            concat!(
                r#"{"payload":{"type":"user","content":[{"type":"text","text":"问"}]},"timestamp":"2026-09-30T08:00:00Z"}"#,
                "\n",
                r#"{"payload":{"type":"new_shape","content":[]},"timestamp":"2026-09-30T08:00:01Z"}"#,
                "\n",
            ),
        )
        .unwrap();
        let sources = sources(temp.path()).unwrap();
        assert_eq!(sources.len(), 2, "{sources:?}");
        for source in &sources {
            let session = parse(source).unwrap();
            assert!(session.partial, "未知行形状必须标记 partial：{source:?}");
            assert!(!session.messages.is_empty(), "已知行仍须进入时间线");
            assert_unlinked(&session);
        }
    }

    #[test]
    fn malformed_metadata_degrades_to_partial_and_keeps_identity() {
        let temp = tempfile::tempdir().unwrap();
        let legacy_dir = temp.path().join(".kiro/sessions/cli");
        fs::create_dir_all(&legacy_dir).unwrap();
        fs::write(
            legacy_dir.join("0aa0fb40-0b9c-74c9-8d7c-cd5d630dc6f0.jsonl"),
            r#"{"kind":"Prompt","data":{"content":[{"type":"text","text":"问"}]}}"#,
        )
        .unwrap();
        fs::write(
            legacy_dir.join("0aa0fb40-0b9c-74c9-8d7c-cd5d630dc6f0.json"),
            "not json",
        )
        .unwrap();
        let sources = sources(temp.path()).unwrap();
        let session = parse(&sources[0]).unwrap();
        assert!(session.partial);
        assert_eq!(
            session.native_id.as_deref(),
            Some("0aa0fb40-0b9c-74c9-8d7c-cd5d630dc6f0"),
            "uuid 文件名仍是可验证身份"
        );
    }

    #[test]
    fn legacy_session_stem_only_accepts_uuid_shapes() {
        assert!(legacy_session_stem("6f5813aa-9d04-4d7b-b3e2-5c1f0a67d2e4"));
        assert!(!legacy_session_stem("notes"));
        assert!(!legacy_session_stem("0aa0fb400b9c74c98d7ccd5d630dc6f0"));
    }

    #[test]
    fn declares_no_parent_child_association() {
        use crate::adapters::{CliAdapter, HISTORY_ASSOCIATION_UNAVAILABLE_REASON, PublishedDescriptor};

        let facet = super::super::Kiro
            .history_association()
            .expect("kiro declares association");
        assert_eq!(facet.state, "unavailable");
        assert_eq!(facet.reason, HISTORY_ASSOCIATION_UNAVAILABLE_REASON);
        let published = PublishedDescriptor::from_adapter(&super::super::Kiro);
        assert_eq!(published.descriptor.history.state, "available");
        assert_eq!(
            published.association.as_ref().map(|item| (item.state, item.reason)),
            Some(("unavailable", HISTORY_ASSOCIATION_UNAVAILABLE_REASON))
        );
    }

    #[test]
    fn unread_fields_do_not_create_parent_child_links() {
        let temp = tempfile::tempdir().unwrap();
        let legacy_dir = temp.path().join(".kiro/sessions/cli");
        fs::create_dir_all(&legacy_dir).unwrap();
        fs::write(
            legacy_dir.join("0aa0fb40-0b9c-74c9-8d7c-cd5d630dc6f0.jsonl"),
            concat!(
                r#"{"kind":"Prompt","parentId":"other-session","querySource":"subagent","agentId":"explore","delegationDepth":1,"agentPreset":"standard","source":"agent","data":{"content":[{"type":"text","text":"问"}]}}"#,
                "\n",
                r#"{"kind":"AssistantMessage","parentSessionId":"other-session","querySource":"main_turn","data":{"content":[{"type":"text","text":"答"}]}}"#,
                "\n",
            ),
        )
        .unwrap();
        let current_dir = temp.path().join(".kiro/demo-workspace/sess_b1b2c3d4e5f67890");
        fs::create_dir_all(&current_dir).unwrap();
        fs::write(
            current_dir.join("messages.jsonl"),
            concat!(
                r#"{"payload":{"type":"user","querySource":"subagent","parentId":"sess_parent","agentId":"explore","content":[{"type":"text","text":"问"}]},"timestamp":"2026-09-30T08:00:00Z"}"#,
                "\n",
                r#"{"payload":{"type":"assistant","querySource":"agent","parentSessionId":"sess_parent","source":"agent","reasoningModelId":"claude-sonnet-4-5","content":[{"type":"text","text":"答"}]},"timestamp":"2026-09-30T08:01:00Z"}"#,
                "\n",
            ),
        )
        .unwrap();
        fs::write(
            current_dir.join("session.json"),
            r#"{"title":"仍是本会话","workspacePaths":["C:\\work\\demo"],"querySource":"subagent","parentId":"sess_parent"}"#,
        )
        .unwrap();
        let sources = sources(temp.path()).unwrap();
        assert_eq!(sources.len(), 2, "{sources:?}");
        for source in &sources {
            let session = parse(source).unwrap();
            assert_eq!(session.messages.len(), 2, "原有对话仍可查看");
            assert!(session.usage.is_empty(), "未核对字段不得造出用量");
            assert!(!session.partial, "已知行上的额外字段不是新形状");
            assert_unlinked(&session);
            assert_ne!(session.native_id.as_deref(), Some("sess_parent"));
            assert_ne!(session.native_id.as_deref(), Some("other-session"));
        }
    }
}
