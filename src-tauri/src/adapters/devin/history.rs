//! Devin session sources: the ATIF transcript files under
//! `%APPDATA%\devin\cli\transcripts\<slug>.json`.
//!
//! Evidence: local install 3000.11.3 (structure-only inspection of the real
//! transcripts on this machine, sanitized into
//! `tests/fixtures/history/devin-3000-transcript.json`). The ATIF-v1.7
//! transcript is a single JSON document:
//!
//! * `schema_version` — exact protocol tag `ATIF-v1.7`; any other value fails
//!   the session as a parse error instead of being guessed (ADR-5 keeps
//!   protocol versions exact).
//! * `session_id` — the slug-style native session id, the same id `devin
//!   --resume <id>` accepts.
//! * `agent` — `{name, version, model_name, tool_definitions[], extra}`; the
//!   model metadata comes from `model_name` and the per-step `model_name`.
//! * `steps[]` — `{step_id, timestamp, source, message, extra}` rows;
//!   `source` is `system`, `user` or `agent`, and agent steps additionally
//!   carry `model_name`, `reasoning_content`, `tool_calls[]`,
//!   `observation{results[]}` and `metrics`. System prompts never enter the
//!   indexed transcript.
//! * `final_metrics` — session aggregate counters.
//!
//! Usage events come from the per-agent-step `metrics` and are cross-checked
//! against `final_metrics`. The semantics were determined against all 8 real
//! local 3000.11.3 transcripts (read-only, devin-usage 2026-10-08):
//!
//! * `prompt_tokens` is the FULL step context and INCLUDES `cached_tokens`:
//!   in every file each step N+1's `cached_tokens` equals step N's
//!   `prompt_tokens` minus a small constant (the previous context re-read from
//!   cache), `cached_tokens <= prompt_tokens` holds on every step, and
//!   Σ`prompt_tokens` == `final_metrics.total_prompt_tokens` exactly (8/8). So
//!   events are stored OpenAI-style with `input_includes_cache = true`,
//!   `input = prompt_tokens`, `cache_read = cached_tokens`; the report layer
//!   carves the mutually exclusive buckets out of the inclusive input.
//! * `metrics.extra.cache_creation_input_tokens` (present in 3/8 real files)
//!   is always <= `prompt_tokens - cached_tokens` — the freshly written cache
//!   inside the non-cached portion — and maps to `cache_write`; steps without
//!   it store 0. `final_metrics` carries no creation total, so the write
//!   bucket is pinned only by the per-step invariant.
//! * Each agent step with well-formed metrics is one request
//!   (`request_count = 1`); Σ per session equals the `final_metrics` totals
//!   exactly in all 8 files.
//!
//! `credentials.toml`, `sessions.db` and every other file under the config
//! root are never opened by this module.

use std::fs;
use std::path::Path;

use serde_json::Value;

use crate::history::{
    check_cancelled, text_content, timestamp, valid_native_id, HistorySource, ParsedSession,
    UsageEvent, MAX_SOURCES,
};

/// The only verified ATIF protocol tag; protocol versions stay exact.
const SCHEMA_VERSION: &str = "ATIF-v1.7";

pub(crate) fn transcripts_dir(home: &Path) -> std::path::PathBuf {
    super::config_root(home).join("cli").join("transcripts")
}

pub fn sources(home: &Path) -> Result<Vec<HistorySource>, String> {
    sources_controlled(home, &|| false)
}

pub fn sources_controlled(
    home: &Path,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<HistorySource>, String> {
    check_cancelled(cancelled)?;
    let root = transcripts_dir(home);
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut sources = Vec::new();
    for entry in fs::read_dir(&root).map_err(|error| error.to_string())? {
        check_cancelled(cancelled)?;
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if !path.is_file()
            || path.extension().and_then(|value| value.to_str()) != Some("json")
            || path.is_symlink()
        {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        if !valid_native_id(stem) {
            continue;
        }
        // v2: the devin-usage task started emitting per-step usage events, so
        // sessions indexed under v1 re-parse and backfill history_usage.
        let fingerprint = crate::history::source_fingerprint_controlled(&path, cancelled)
            .map(|value| format!("devin-transcript-v2|{value}"));
        let source = match &fingerprint {
            Ok(_) => HistorySource {
                native_title: None,
                fingerprint: fingerprint.as_ref().unwrap().clone(),
                fingerprint_error: None,
                native_id: Some(stem.to_owned()),
                path,
            },
            Err(error) => HistorySource {
                native_title: None,
                fingerprint: String::new(),
                fingerprint_error: Some(error.clone()),
                native_id: Some(stem.to_owned()),
                path,
            },
        };
        sources.push(source);
        if sources.len() > MAX_SOURCES {
            return Err("Devin 会话源超过 5000 个，本次未删除旧索引".into());
        }
    }
    Ok(sources)
}

/// Emits one UsageEvent per agent step with well-formed metrics.
///
/// Verified semantics (8 real local 3000.11.3 transcripts): `prompt_tokens`
/// is the full step context and includes `cached_tokens`, so the event is
/// stored OpenAI-style (`input_includes_cache = true`) and the report layer
/// derives the exclusive buckets; `metrics.extra.cache_creation_input_tokens`
/// is the freshly written cache inside the non-cached portion and maps to
/// `cache_write`. A malformed or self-inconsistent metrics object (or a
/// cache-creation counter exceeding the fresh portion) degrades the session
/// to partial instead of being guessed.
fn add_usage(session: &mut ParsedSession, id: &str, time: Option<i64>, step: &Value) {
    let Some(metrics) = step.get("metrics") else {
        return;
    };
    let fields = metrics
        .get("prompt_tokens")
        .and_then(Value::as_u64)
        .zip(metrics.get("completion_tokens").and_then(Value::as_u64))
        .zip(metrics.get("cached_tokens").and_then(Value::as_u64));
    let Some(((prompt, completion), cached)) = fields else {
        session.partial = true;
        return;
    };
    let cache_write = metrics
        .get("extra")
        .and_then(|extra| extra.get("cache_creation_input_tokens"));
    let cache_write = match cache_write {
        None => 0,
        Some(value) => match value.as_u64() {
            Some(value) => value,
            None => {
                session.partial = true;
                return;
            }
        },
    };
    if cached > prompt || cache_write > prompt - cached {
        session.partial = true;
        return;
    }
    session.usage.push(UsageEvent {
        request_count: Some(1),
        id: format!("step-{id}"),
        model: step
            .get("model_name")
            .and_then(Value::as_str)
            .filter(|model| !model.is_empty())
            .map(str::to_owned)
            .or_else(|| session.model.clone()),
        timestamp: time,
        input: Some(prompt),
        output: Some(completion),
        cache_read: Some(cached),
        cache_write: Some(cache_write),
        input_includes_cache: true,
    });
}

pub fn parse(source: &HistorySource) -> Result<ParsedSession, String> {
    parse_controlled(source, &|| false)
}

pub fn parse_controlled(
    source: &HistorySource,
    cancelled: &dyn Fn() -> bool,
) -> Result<ParsedSession, String> {
    check_cancelled(cancelled)?;
    if source.path.is_symlink() {
        return Err("Devin transcript 为符号链接，已跳过".into());
    }
    let text = fs::read_to_string(&source.path)
        .map_err(|error| format!("Devin transcript 无法读取：{error}"))?;
    let root: Value =
        serde_json::from_str(&text).map_err(|error| format!("Devin transcript 无法解析：{error}"))?;
    check_cancelled(cancelled)?;
    if root.get("schema_version").and_then(Value::as_str) != Some(SCHEMA_VERSION) {
        return Err(format!(
            "Devin transcript 协议版本不是已验证的 {SCHEMA_VERSION}，拒绝猜测解析"
        ));
    }
    let mut session = ParsedSession::new();
    session.native_id = root
        .get("session_id")
        .and_then(Value::as_str)
        .filter(|id| valid_native_id(id))
        .map(str::to_owned)
        .or_else(|| source.native_id.clone());
    if let Some(model) = root
        .get("agent")
        .and_then(|agent| agent.get("model_name"))
        .and_then(Value::as_str)
        .filter(|model| !model.is_empty())
    {
        session.model = Some(model.to_owned());
    }
    let Some(steps) = root.get("steps").and_then(Value::as_array) else {
        return Err("Devin transcript 缺少 steps 数组".into());
    };
    for step in steps {
        check_cancelled(cancelled)?;
        let Some(step_id) = step.get("step_id") else {
            session.partial = true;
            continue;
        };
        let id = match step_id {
            Value::Number(number) => number.to_string(),
            Value::String(text) => text.clone(),
            _ => {
                session.partial = true;
                continue;
            }
        };
        let time = step.get("timestamp").and_then(timestamp);
        match step.get("source").and_then(Value::as_str) {
            Some("user") => session.add_message(
                format!("step-{id}"),
                "user",
                step.get("message").map(text_content).unwrap_or_default(),
                time,
            ),
            Some("agent") => {
                if let Some(model) = step
                    .get("model_name")
                    .and_then(Value::as_str)
                    .filter(|model| !model.is_empty())
                {
                    session.model = Some(model.to_owned());
                }
                session.add_message(
                    format!("step-{id}"),
                    "assistant",
                    step.get("message").map(text_content).unwrap_or_default(),
                    time,
                );
                add_usage(&mut session, &id, time, step);
            }
            // System prompts (and any unknown source) stay out of the indexed
            // transcript; unknown sources only mark the session partial.
            Some("system") => {}
            _ => session.partial = true,
        }
    }
    check_cancelled(cancelled)?;
    session.finish(source)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TRANSCRIPT_FIXTURE: &str =
        include_str!("../../../../tests/fixtures/history/devin-3000-transcript.json");

    fn write_transcripts(home: &std::path::Path) -> std::path::PathBuf {
        let dir = transcripts_dir(home);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("serene-example.json"), TRANSCRIPT_FIXTURE).unwrap();
        dir
    }

    #[test]
    fn transcript_dir_lists_name_based_fingerprinted_sources() {
        let home = tempfile::tempdir().unwrap();
        assert!(sources(home.path()).unwrap().is_empty(), "目录不存在时无源");
        let dir = write_transcripts(home.path());
        // Listing is name-based (like the other transcript adapters): any
        // valid-stem .json becomes a candidate source and schema filtering
        // happens at parse time; an invalid id never becomes a source.
        std::fs::write(dir.join("notes.json"), "{}").unwrap();
        std::fs::write(dir.join("bad id!.json"), "{}").unwrap();
        let sources = sources(home.path()).unwrap();
        let ids: Vec<&str> = sources
            .iter()
            .filter_map(|source| source.native_id.as_deref())
            .collect();
        assert_eq!(ids, vec!["notes", "serene-example"], "{sources:?}");
        let example = sources
            .iter()
            .find(|source| source.native_id.as_deref() == Some("serene-example"))
            .unwrap();
        assert!(example.fingerprint.starts_with("devin-transcript-v2|"));
        assert!(example.fingerprint.contains('m'), "指纹含元数据摘要");
        assert!(example.path.ends_with("cli/transcripts/serene-example.json"));
        // The non-transcript candidate fails parsing instead of being guessed.
        assert!(parse(&sources[0]).is_err());
    }

    #[test]
    fn fixture_parses_identity_model_times_and_filtered_messages() {
        let home = tempfile::tempdir().unwrap();
        write_transcripts(home.path());
        let sources = sources(home.path()).unwrap();
        let session = parse(&sources[0]).unwrap();
        assert_eq!(session.native_id.as_deref(), Some("serene-example"));
        assert_eq!(session.model.as_deref(), Some("example-swe-high"));
        // Title falls back to the first user message (the transcript itself
        // carries no title field).
        assert_eq!(session.title, "请把示例项目的构建脚本改成跨平台版本");
        // Session times come from the indexed conversation steps (the system
        // prompts never enter the transcript index).
        assert_eq!(session.started_at, Some(1_791_364_541_250));
        assert_eq!(session.updated_at, Some(1_791_364_580_401));
        let roles: Vec<&str> = session
            .messages
            .iter()
            .map(|message| message.role.as_str())
            .collect();
        assert_eq!(roles, vec!["user", "assistant", "user", "assistant"]);
        assert!(session
            .messages
            .iter()
            .all(|message| !message.text.is_empty()));
        assert_eq!(session.cwd, None, "transcript 不携带工作目录");
        assert!(!session.partial);
    }

    /// The devin-usage task (2026-10-08) delivers the usage dimension: every
    /// agent step with metrics becomes one inclusive-bucket UsageEvent and the
    /// per-session sums must cross-check against `final_metrics` exactly.
    #[test]
    fn fixture_usage_events_cross_check_against_final_metrics() {
        let root: Value = serde_json::from_str(TRANSCRIPT_FIXTURE).unwrap();
        let home = tempfile::tempdir().unwrap();
        write_transcripts(home.path());
        let sources = sources(home.path()).unwrap();
        let session = parse(&sources[0]).unwrap();
        assert_eq!(session.usage.len(), 2, "每个带 metrics 的 agent step 一个事件");
        let first = &session.usage[0];
        assert_eq!(first.id, "step-4");
        assert_eq!(first.request_count, Some(1));
        assert_eq!(first.model.as_deref(), Some("example-swe-high"));
        assert_eq!(first.timestamp, Some(1_791_364_544_521));
        // Verified semantics: prompt_tokens is the full context and INCLUDES
        // cached_tokens (step N+1's cached == step N's prompt in the real
        // transcripts); cache_creation under metrics.extra maps to cache_write.
        assert_eq!(first.input, Some(1240));
        assert_eq!(first.output, Some(86));
        assert_eq!(first.cache_read, Some(800));
        assert_eq!(first.cache_write, Some(438), "extra.cache_creation_input_tokens");
        assert!(first.input_includes_cache);
        let second = &session.usage[1];
        assert_eq!(second.cache_write, Some(0), "无 extra 时 cache_write 为 0");
        assert_eq!(second.input, Some(2310));
        assert_eq!(second.cache_read, Some(1900));
        // Mutually exclusive buckets stay derivable: read + write <= input.
        for event in &session.usage {
            assert!(event.cache_read.unwrap() + event.cache_write.unwrap() <= event.input.unwrap());
        }
        // Cross-check against the session aggregate the transcript itself
        // records (the same reconciliation passed on all 8 real transcripts).
        let sum = |select: fn(&UsageEvent) -> u64| session.usage.iter().map(select).sum::<u64>();
        assert_eq!(sum(|event| event.input.unwrap()), 3550, "Σinput == total_prompt_tokens");
        assert_eq!(sum(|event| event.output.unwrap()), 236, "Σoutput == total_completion_tokens");
        assert_eq!(sum(|event| event.cache_read.unwrap()), 2700, "Σcache_read == total_cached_tokens");
        assert_eq!(root["final_metrics"]["total_prompt_tokens"], 3550);
        assert_eq!(root["final_metrics"]["total_completion_tokens"], 236);
        assert_eq!(root["final_metrics"]["total_cached_tokens"], 2700);
        assert!(!session.partial);
    }

    #[test]
    fn malformed_step_metrics_degrade_partial_without_events() {
        let home = tempfile::tempdir().unwrap();
        let dir = write_transcripts(home.path());
        // Non-numeric token fields, a cached counter above prompt (the real
        // transcripts always keep cached <= prompt), and a cache-creation
        // counter above the fresh portion all degrade instead of being guessed.
        for (name, metrics) in [
            ("broken", r#"{"prompt_tokens": "many", "completion_tokens": 5, "cached_tokens": 1}"#),
            ("inverted", r#"{"prompt_tokens": 10, "completion_tokens": 5, "cached_tokens": 11}"#),
            (
                "overflowing-creation",
                r#"{"prompt_tokens": 10, "completion_tokens": 5, "cached_tokens": 2, "extra": {"cache_creation_input_tokens": 9}}"#,
            ),
        ] {
            let root: Value = serde_json::from_str(TRANSCRIPT_FIXTURE).unwrap();
            if let Value::Object(mut map) = root {
                map.insert("session_id".into(), Value::String(name.to_owned()));
                if let Some(steps) = map.get_mut("steps").and_then(Value::as_array_mut) {
                    steps[3]["metrics"] = serde_json::from_str::<Value>(metrics).unwrap();
                }
                std::fs::write(
                    dir.join(format!("{name}.json")),
                    serde_json::to_string(&Value::Object(map)).unwrap(),
                )
                .unwrap();
            }
        }
        let listed = sources(home.path()).unwrap();
        for source in listed
            .iter()
            .filter(|source| source.native_id.as_deref() != Some("serene-example"))
        {
            let session = parse(source).unwrap();
            assert!(session.partial, "{} 降级 partial", source.native_id.as_deref().unwrap());
            assert_eq!(session.usage.len(), 1, "{} 只保留完好 step 的事件", source.native_id.as_deref().unwrap());
        }
    }

    #[test]
    fn unrecognized_schema_version_fails_instead_of_guessing() {
        let home = tempfile::tempdir().unwrap();
        let dir = write_transcripts(home.path());
        let drifted_text = TRANSCRIPT_FIXTURE.replace("ATIF-v1.7", "ATIF-v1.8");
        std::fs::write(dir.join("drifted-example.json"), drifted_text).unwrap();
        let listed = sources(home.path()).unwrap();
        let drifted = listed
            .iter()
            .find(|source| source.native_id.as_deref() == Some("drifted-example"))
            .unwrap();
        assert!(parse(drifted).is_err());
        // Structural corruption also fails as a parse error for that session.
        std::fs::write(dir.join("broken-example.json"), "{not json").unwrap();
        let listed = sources(home.path()).unwrap();
        let broken = listed
            .iter()
            .find(|source| source.native_id.as_deref() == Some("broken-example"))
            .unwrap();
        assert!(parse(broken).is_err());
    }
}
