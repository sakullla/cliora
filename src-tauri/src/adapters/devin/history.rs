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
//! The usage dimension stays undelivered per the 2026-10-07 approved matrix
//! (02-technical-solution ADR-2: "transcript 无 token 字段"). Implementation-
//! time inspection of the local 3000.11.3 transcripts contradicts that survey
//! premise — every agent step carries `metrics{prompt_tokens,
//! completion_tokens, cached_tokens}` and each file ends with `final_metrics`
//! token totals. The binding decision is honored (no usage events are emitted)
//! and the contradiction is recorded in the adapter descriptor reason for the
//! owner to amend the plan; the metrics shapes are still pinned here by the
//! module tests so a future usage task starts from verified facts.
//!
//! `credentials.toml`, `sessions.db` and every other file under the config
//! root are never opened by this module.

use std::fs;
use std::path::Path;

use serde_json::Value;

use crate::history::{
    check_cancelled, text_content, timestamp, valid_native_id, HistorySource, ParsedSession,
    MAX_SOURCES,
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
        let fingerprint = crate::history::source_fingerprint_controlled(&path, cancelled)
            .map(|value| format!("devin-transcript-v1|{value}"));
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
        assert!(example.fingerprint.starts_with("devin-transcript-v1|"));
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

    /// The binding 02 ADR-2 decision keeps Devin usage undelivered; the tests
    /// below pin the token shapes actually present so a future usage task has
    /// verified facts to build on.
    #[test]
    fn fixture_carries_token_metrics_but_no_usage_events_are_emitted() {
        let root: Value = serde_json::from_str(TRANSCRIPT_FIXTURE).unwrap();
        let agent_steps: Vec<&Value> = root["steps"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|step| step["source"].as_str() == Some("agent"))
            .collect();
        assert!(agent_steps
            .iter()
            .all(|step| step["metrics"]["prompt_tokens"].is_u64()
                && step["metrics"]["completion_tokens"].is_u64()
                && step["metrics"]["cached_tokens"].is_u64()));
        assert_eq!(agent_steps.len(), 2);
        assert_eq!(agent_steps[0]["metrics"]["prompt_tokens"], 1240);
        assert_eq!(root["final_metrics"]["total_prompt_tokens"], 3550);
        assert_eq!(root["final_metrics"]["total_completion_tokens"], 236);
        assert_eq!(root["final_metrics"]["total_cached_tokens"], 2700);
        let home = tempfile::tempdir().unwrap();
        write_transcripts(home.path());
        let sources = sources(home.path()).unwrap();
        let session = parse(&sources[0]).unwrap();
        assert!(
            session.usage.is_empty(),
            "按 2026-10-07 方案矩阵，Devin 用量维度不接入"
        );
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
