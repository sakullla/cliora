//! Command Code session sources: `~/.commandcode/projects/<slug>/<uuid>.jsonl`.
//!
//! Evidence: Command Code 1.73.4 installed locally (npm `command-code`); four
//! real sessions sampled read-only (19/199/586/490 rows) plus the CLI bundle's
//! own session IO (`sessionSidecarPaths`, `isSessionTranscriptFileName`,
//! `loadV3SessionInfo`). Files are append-only JSONL: the first row is the
//! header `{type:"session",version:3,id,timestamp,cwd}` and every later row is
//! `{type:"message",id,parentId,timestamp,message:{role,content[],meta},
//! usage?,model?,effort?}`.
//!
//! ## Usage semantics (the CodeBuddy question, answered for this format)
//!
//! Unlike CodeBuddy (where the tool loop's intermediate calls log usage on
//! `function_call` rows), Command Code expresses the tool loop as alternating
//! message rows: one assistant row per billed API call (which may batch
//! several parallel `tool_use` blocks) followed by one user row aggregating
//! the `tool_result` blocks. The per-call usage object
//! `{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd}`
//! sits on the assistant row only:
//!
//! * **every billed call carries usage on its message row** — 644/644
//!   assistant rows across the four sampled real sessions carry usage, and no
//!   other row type ever does; there is no separate intermediate-call row
//!   class to hunt for;
//! * the format has **no aggregate signal** (no turn-metrics row; the
//!   `<id>.meta.json` sidecar holds model/traceIds/title only), so the
//!   reconciliation substitute is the context chain: a billed call's charged
//!   context `input + cacheRead + cacheWrite + output` must cover the previous
//!   call's context for a complete record — 97/98 consecutive pairs in the
//!   199-row session are monotonic (the single dip is consistent with a
//!   compaction/truncation event), matching a complete per-message record;
//! * `inputTokens` **excludes** cache read/write (the cache columns are
//!   explicit siblings), so every event records `input_includes_cache=false`;
//! * `costUsd` is the per-call provider cost. The shared `UsageEvent`
//!   contract has no cost channel, so cost is verified in the module tests
//!   and deliberately not surfaced into the usage pipeline.
//!
//! Titles come from the `<id>.meta.json` sidecar (`title` field). The source
//! fingerprint covers both the transcript and the sidecar, so a retitled
//! session reindexes; `.checkpoints.jsonl`/`.prompts.jsonl` sidecars never
//! affect displayed content and stay out of the fingerprint.

use std::collections::HashSet;
use std::path::Path;

use serde_json::Value;

use crate::history::usage;
use crate::history::{
    check_cancelled, discover_jsonl_controlled, read_jsonl_controlled,
    source_fingerprint_controlled, text_content, timestamp, valid_native_id, HistorySource,
    ParsedSession, UsageEvent,
};

/// The CLI's own transcript filter (`isSessionTranscriptFileName`): `.jsonl`
/// files that are neither checkpoint nor prompt logs (`.v2.bak` copies never
/// end in `.jsonl`). Project `config.json`/`mcp.json` are not JSONL.
fn session_transcript(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    path.extension().is_some_and(|value| value == "jsonl")
        && !name.contains(".checkpoints.")
        && !name.contains(".prompts.")
}

pub fn sources(home: &Path) -> Result<Vec<HistorySource>, String> {
    sources_controlled(home, &|| false)
}

pub fn sources_controlled(
    home: &Path,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<HistorySource>, String> {
    let root = crate::accounts::selection::history_root("command_code", || {
        super::config_root(home).join("projects")
    });
    let mut sources = discover_jsonl_controlled(&root, session_transcript, cancelled)?;
    for source in &mut sources {
        check_cancelled(cancelled)?;
        let mut parts = vec![source.fingerprint.clone()];
        let mut error = source.fingerprint_error.take();
        let sidecar = source.path.with_extension("meta.json");
        if sidecar.is_file() {
            match source_fingerprint_controlled(&sidecar, cancelled) {
                Ok(stamp) => parts.push(stamp),
                Err(message) => error = Some(message),
            }
        }
        if let Some(message) = error {
            source.fingerprint = String::new();
            source.fingerprint_error = Some(message);
        } else {
            source.fingerprint = format!("command-code-session-v1|{}", parts.join("|"));
        }
        if let Some(stem) = source.path.file_stem().and_then(|stem| stem.to_str()) {
            if valid_native_id(stem) {
                source.native_id = Some(stem.to_owned());
            }
        }
        // Title lives in the meta sidecar; a missing sidecar falls back to the
        // transcript-derived title in `finish`.
        if sidecar.is_file() {
            if let Ok(text) = std::fs::read_to_string(&sidecar) {
                if let Ok(meta) = serde_json::from_str::<Value>(&text) {
                    if let Some(title) = meta
                        .get("title")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|title| !title.is_empty())
                    {
                        source.native_title = Some(title.chars().take(96).collect());
                    }
                }
            }
        }
    }
    Ok(sources)
}

pub fn parse(source: &HistorySource) -> Result<ParsedSession, String> {
    parse_controlled(source, &|| false)
}

pub fn parse_controlled(
    source: &HistorySource,
    cancelled: &dyn Fn() -> bool,
) -> Result<ParsedSession, String> {
    let mut session = ParsedSession::new();
    let mut records = HashSet::<String>::new();
    let mut header_seen = false;
    let partial = read_jsonl_controlled(source, cancelled, |line, row| {
        match row.get("type").and_then(Value::as_str) {
            Some("session") => {
                if header_seen {
                    return;
                }
                header_seen = true;
                let version = row.get("version").and_then(Value::as_i64);
                if version != Some(3) {
                    session.partial = true;
                    return;
                }
                if let Some(id) = row
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| valid_native_id(id))
                {
                    session.native_id = Some(id.to_owned());
                }
                session.cwd = row
                    .get("cwd")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .filter(|cwd| !cwd.trim().is_empty());
                session.started_at = row.get("timestamp").and_then(timestamp);
            }
            Some("message") => {
                let body = row.get("message").unwrap_or(&Value::Null);
                let role = body.get("role").and_then(Value::as_str).unwrap_or("");
                let time = row.get("timestamp").and_then(timestamp);
                let id = row
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("line-{line}"));
                // Per-call usage: only assistant rows carry it (verified on
                // the sampled sessions), one billed API call per row.
                let counts = row.get("usage").and_then(usage_counts);
                if let Some(counts) = counts.filter(|counts| usage::active(*counts)) {
                    if records.insert(format!("command-code:usage:{id}")) {
                        let model = row
                            .get("model")
                            .and_then(Value::as_str)
                            .filter(|model| !model.is_empty())
                            .map(str::to_owned);
                        if model.is_some() {
                            session.model.clone_from(&model);
                        }
                        // costUsd has no channel in the shared UsageEvent
                        // contract; see the module docs.
                        session.usage.push(UsageEvent {
                            request_count: Some(1),
                            id: format!("command-code:usage:{id}"),
                            model,
                            timestamp: time,
                            input: Some(counts.input),
                            output: Some(counts.output),
                            cache_read: Some(counts.read),
                            cache_write: Some(counts.write),
                            // Verified semantics: stored input excludes cache.
                            input_includes_cache: false,
                        });
                    }
                }
                if role != "user" && role != "assistant" {
                    return;
                }
                let text = body.get("content").map(text_content).unwrap_or_default();
                session.add_message(id, role, text, time);
            }
            _ => {}
        }
    })?;
    session.partial |= partial;
    if !header_seen {
        return Err("Command Code 会话文件缺少 version 3 会话头，格式不识别".into());
    }
    session.finish(source)
}

/// Row-level usage shape `{inputTokens, outputTokens, cacheReadTokens,
/// cacheWriteTokens, costUsd}`; cache read/write are explicit siblings of a
/// cache-exclusive input.
fn usage_counts(value: &Value) -> Option<usage::TokenCounts> {
    if !value.is_object() {
        return None;
    }
    usage::from_optional(
        usage::field(value, "inputTokens"),
        usage::field(value, "outputTokens"),
        usage::field(value, "cacheReadTokens"),
        usage::field(value, "cacheWriteTokens"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixtures() -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/history")
    }

    fn fixture_source() -> HistorySource {
        HistorySource {
            native_title: None,
            path: fixtures().join("command-code-1.73-session.jsonl"),
            native_id: None,
            fingerprint: "test".into(),
            fingerprint_error: None,
        }
    }

    #[test]
    fn fixture_session_parses_identity_transcript_and_split_usage() {
        let parsed = parse(&fixture_source()).unwrap();
        assert_eq!(
            parsed.native_id.as_deref(),
            Some("4d2c0a55-3b7e-4f6a-9c21-8e0a11d57b34")
        );
        assert_eq!(parsed.cwd.as_deref(), Some(r"C:\Users\example\project\demo"));
        assert_eq!(parsed.started_at, Some(1_791_188_120_417));
        assert_eq!(parsed.model.as_deref(), Some("deepseek/deepseek-v4.1-flash"));
        let roles: Vec<&str> = parsed
            .messages
            .iter()
            .map(|message| message.role.as_str())
            .collect();
        // The tool-result-only user rows stay out; every other user/assistant
        // row with text joins the timeline in order.
        assert_eq!(
            roles,
            vec!["user", "assistant", "assistant", "user", "assistant", "assistant"]
        );
        // 4 assistant rows = 4 billed API calls (the third carries two
        // parallel tool_use blocks in ONE call).
        assert_eq!(parsed.usage.len(), 4, "{:?}", parsed.usage);
        let first = &parsed.usage[0];
        assert_eq!(first.input, Some(18_246));
        assert_eq!(first.output, Some(173));
        assert_eq!(first.cache_read, Some(5_120));
        assert_eq!(first.cache_write, Some(0));
        assert!(!first.input_includes_cache, "stored input excludes cache");
        assert_eq!(first.request_count, Some(1));
        assert_eq!(first.timestamp, Some(1_791_188_141_002));
        // Cache write is an explicit column; a nonzero value must survive.
        assert_eq!(parsed.usage[1].cache_write, Some(4_096));
        assert_eq!(parsed.usage[1].cache_read, Some(23_816));
        let totals: (u64, u64, u64, u64) = parsed.usage.iter().fold(
            (0, 0, 0, 0),
            |(input, output, read, write), event| {
                (
                    input + event.input.unwrap_or(0),
                    output + event.output.unwrap_or(0),
                    read + event.cache_read.unwrap_or(0),
                    write + event.cache_write.unwrap_or(0),
                )
            },
        );
        assert_eq!(totals, (20_294, 1_619, 90_018, 6_144));
        assert!(!parsed.partial);
    }

    #[test]
    fn cost_usd_stays_off_the_shared_pipeline_but_reconciles_per_call() {
        // The shared UsageEvent contract has no cost channel; the per-call
        // costUsd values of the fixture are verified here so the token split
        // stays reconcilable against the sanitized source.
        let raw = std::fs::read_to_string(fixtures().join("command-code-1.73-session.jsonl"))
            .unwrap();
        let costs: Vec<f64> = raw
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|row| row.get("type").and_then(Value::as_str) == Some("message"))
            .filter_map(|row| {
                row.get("usage")
                    .and_then(|usage| usage.get("costUsd"))
                    .and_then(Value::as_f64)
            })
            .collect();
        assert_eq!(costs.len(), 4);
        assert!(
            (costs.iter().sum::<f64>() - (0.002081 + 0.000971 + 0.001043 + 0.001204)).abs()
                < 1e-12
        );
    }

    #[test]
    fn duplicate_row_ids_collapse_instead_of_double_counting() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("demo.jsonl");
        std::fs::write(
            &path,
            concat!(
                r#"{"type":"session","version":3,"id":"11111111-2222-4333-8444-555555555555","timestamp":"2026-10-05T08:00:00.000Z","cwd":"/tmp/demo"}"#,
                "\n",
                r#"{"type":"message","id":"dup1","parentId":null,"timestamp":"2026-10-05T08:00:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"第一次"}]},"usage":{"inputTokens":100,"outputTokens":10,"cacheReadTokens":0,"cacheWriteTokens":0,"costUsd":0.0001},"model":"deepseek/deepseek-v4.1-flash"}"#,
                "\n",
                r#"{"type":"message","id":"dup1","parentId":null,"timestamp":"2026-10-05T08:00:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"重复行"}]},"usage":{"inputTokens":100,"outputTokens":10,"cacheReadTokens":0,"cacheWriteTokens":0,"costUsd":0.0001},"model":"deepseek/deepseek-v4.1-flash"}"#,
                "\n",
            ),
        )
        .unwrap();
        let source = HistorySource {
            native_title: None,
            path,
            native_id: None,
            fingerprint: "test".into(),
            fingerprint_error: None,
        };
        let parsed = parse(&source).unwrap();
        assert_eq!(parsed.usage.len(), 1, "重复行 id 折叠为一次计费调用");
        assert_eq!(parsed.usage[0].input, Some(100));
    }

    #[test]
    fn sources_cover_transcript_and_meta_sidecar_in_the_fingerprint() {
        let temp = tempfile::tempdir().unwrap();
        let projects = temp.path().join(".commandcode/projects/c-users-example-demo");
        std::fs::create_dir_all(&projects).unwrap();
        let session = projects.join("11111111-2222-4333-8444-555555555555.jsonl");
        std::fs::write(
            &session,
            concat!(
                r#"{"type":"session","version":3,"id":"11111111-2222-4333-8444-555555555555","timestamp":"2026-10-05T08:00:00.000Z","cwd":"/tmp/demo"}"#,
                "\n",
            ),
        )
        .unwrap();
        std::fs::write(
            projects.join("11111111-2222-4333-8444-555555555555.meta.json"),
            r#"{"model":"deepseek/deepseek-v4.1-flash","title":"构建脚本梳理","traceIds":[]}"#,
        )
        .unwrap();
        // Checkpoint/prompt sidecars and non-transcript files stay out.
        std::fs::write(
            projects.join("11111111-2222-4333-8444-555555555555.checkpoints.jsonl"),
            "{}\n",
        )
        .unwrap();
        std::fs::write(projects.join("mcp.json"), "{}").unwrap();
        let sources = sources(temp.path()).unwrap();
        assert_eq!(sources.len(), 1, "{sources:?}");
        assert!(sources[0].fingerprint.starts_with("command-code-session-v1|"));
        assert_eq!(
            sources[0].native_id.as_deref(),
            Some("11111111-2222-4333-8444-555555555555")
        );
        assert_eq!(sources[0].native_title.as_deref(), Some("构建脚本梳理"));
        let before = sources[0].fingerprint.clone();
        // A retitled session (sidecar-only change) must reindex.
        std::fs::write(
            projects.join("11111111-2222-4333-8444-555555555555.meta.json"),
            r#"{"model":"deepseek/deepseek-v4.1-flash","title":"新的标题","traceIds":[]}"#,
        )
        .unwrap();
        let after = super::sources(temp.path()).unwrap();
        assert_ne!(before, after[0].fingerprint, "标题 sidecar 变化必须触发重扫");
        // The meta title overrides the transcript-derived title.
        let parsed = parse(&after[0]).unwrap();
        assert_eq!(parsed.title, "新的标题");
    }

    #[test]
    fn missing_header_or_wrong_version_fails_instead_of_guessing() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("scratch.jsonl");
        std::fs::write(&path, "{\"type\":\"message\"}\n").unwrap();
        let source = HistorySource {
            native_title: None,
            path: path.clone(),
            native_id: None,
            fingerprint: "test".into(),
            fingerprint_error: None,
        };
        assert!(parse(&source).unwrap_err().contains("会话头"));
        std::fs::write(
            &path,
            concat!(
                r#"{"type":"session","version":2,"id":"11111111-2222-4333-8444-555555555555","timestamp":"2026-10-05T08:00:00.000Z","cwd":"/tmp/demo"}"#,
                "\n",
                r#"{"type":"message","id":"m1","parentId":null,"timestamp":"2026-10-05T08:00:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"v2 行"}]},"usage":{"inputTokens":10,"outputTokens":1,"cacheReadTokens":0,"cacheWriteTokens":0,"costUsd":0.00001},"model":"deepseek/deepseek-v4.1-flash"}"#,
                "\n",
            ),
        )
        .unwrap();
        // A non-v3 header degrades to partial identity loss: the header is
        // not adopted, but the file stays explainable instead of guessing.
        let parsed = parse(&source).unwrap();
        assert!(parsed.partial);
        assert!(parsed.native_id.is_none());
        assert_eq!(parsed.usage.len(), 1, "v2 行的 usage 形状与 v3 相同则可统计");
        assert!(sources(temp.path()).unwrap().is_empty(), "无 projects 根时无源");
    }

    #[test]
    fn empty_root_yields_no_sources() {
        let temp = tempfile::tempdir().unwrap();
        assert!(sources(temp.path()).unwrap().is_empty());
    }

    /// Read-only local reconciliation on the machine's real sessions: every
    /// parsed usage event must equal an independent per-row recount of the
    /// raw file (the audit the CodeBuddy fix motivated for this format).
    #[test]
    #[ignore = "read-only local evidence check; needs real ~/.commandcode data"]
    fn real_sessions_reconcile_against_independent_row_recount() {
        let home = dirs::home_dir().unwrap();
        let found = sources(&home).unwrap();
        assert!(!found.is_empty(), "本机无 Command Code 会话数据");
        for source in found.iter().take(4) {
            let parsed = parse(source).unwrap();
            let raw = std::fs::read_to_string(&source.path).unwrap();
            let mut expected = Vec::<(u64, u64, u64, u64)>::new();
            for line in raw.lines().filter(|line| !line.trim().is_empty()) {
                let row: Value = serde_json::from_str(line).unwrap();
                if row.get("type").and_then(Value::as_str) != Some("message") {
                    continue;
                }
                if row["message"]["role"].as_str() != Some("assistant") {
                    continue;
                }
                let usage = row.get("usage").unwrap();
                expected.push((
                    usage["inputTokens"].as_u64().unwrap(),
                    usage["outputTokens"].as_u64().unwrap(),
                    usage["cacheReadTokens"].as_u64().unwrap(),
                    usage["cacheWriteTokens"].as_u64().unwrap(),
                ));
            }
            let actual: Vec<(u64, u64, u64, u64)> = parsed
                .usage
                .iter()
                .map(|event| {
                    (
                        event.input.unwrap_or(0),
                        event.output.unwrap_or(0),
                        event.cache_read.unwrap_or(0),
                        event.cache_write.unwrap_or(0),
                    )
                })
                .collect();
            assert_eq!(actual.len(), expected.len(), "{}", source.path.display());
            assert_eq!(actual, expected, "{}", source.path.display());
            assert!(parsed
                .usage
                .iter()
                .all(|event| !event.input_includes_cache));
        }
    }
}
