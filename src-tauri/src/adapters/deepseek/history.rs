//! dsh session logs: append-only JSONL under
//! `~/.dsh/sessions/<workspace>/session-<uuid>/session.v4.jsonl.zstd` where
//! every appended record is compressed as its own zstd frame, so a finalized
//! log is a stream of concatenated frames.
//!
//! Layout implemented from the first real machine sample (0.2.x line, header
//! version 4):
//! - row 0: `{"type":"session","version":4,"id","createdAt","cwd",...}`
//! - every later row is an event envelope `{"type","seq","time","data"}`
//! - conversation rides on `user/message` / `assistant/message` rows and
//!   usage rides on the assistant payload itself (there is no separate usage
//!   record); `session/title` rows carry the display title and
//!   `agent/inbox/spliced` mirrors inbox mutations, folded only for messages
//!   the canonical rows lack (both share the same message ids)
//!
//! Unknown event types are skipped. A header version outside the sampled
//! family, a broken or torn frame stream or a missing header row rejects the
//! whole session file: the parser is read-only and never rewrites the log.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;

use serde_json::Value;

use crate::history::usage::{self, RequestUsage};
use crate::history::{
    check_cancelled, discover_jsonl_controlled, text_content, timestamp, valid_native_id,
    HistoryMessageKind, HistorySource, ParsedSession, UsageEvent,
};

const ZSTD_MAGIC: [u8; 4] = [0x28, 0xb5, 0x2f, 0xfd];
const KNOWN_VERSIONS: [u64; 1] = [4];

fn session_file(path: &Path) -> bool {
    let name = path.file_name().and_then(|value| value.to_str()).unwrap_or("");
    if !name.ends_with(".jsonl.zstd") {
        return false;
    }
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut header = [0u8; 4];
    file.read_exact(&mut header).is_ok() && header == ZSTD_MAGIC
}

pub fn sources(home: &Path) -> Result<Vec<HistorySource>, String> {
    sources_controlled(home, &|| false)
}

pub fn sources_controlled(
    home: &Path,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<HistorySource>, String> {
    let root = crate::accounts::selection::history_root("deepseek", || super::dsh_home(home));
    // The sessions tree nests by workspace and session id, so discovery sniffs
    // the zstd magic instead of trusting a fixed depth or exact file name.
    discover_jsonl_controlled(&root.join("sessions"), session_file, cancelled)
}

pub fn parse(source: &HistorySource) -> Result<ParsedSession, String> {
    parse_controlled(source, &|| false)
}

pub fn parse_controlled(
    source: &HistorySource,
    cancelled: &dyn Fn() -> bool,
) -> Result<ParsedSession, String> {
    check_cancelled(cancelled)?;
    let file = fs::File::open(&source.path).map_err(|error| error.to_string())?;
    let decoder = zstd::stream::read::Decoder::new(file)
        .map_err(|_| "dsh 会话文件不是有效的 zstd 帧流；原文件未更改".to_string())?;
    let mut reader = BufReader::with_capacity(256 * 1024, decoder);
    let mut session = ParsedSession::new();
    let mut events = BTreeMap::<String, RequestUsage>::new();
    let mut seen = HashSet::<String>::new();
    let mut header = false;
    let mut partial = false;
    let mut line = Vec::new();
    let mut next_index = 0usize;
    let mut total = 0u64;
    loop {
        check_cancelled(cancelled)?;
        line.clear();
        let count = reader.by_ref().take(256 * 1024 * 1024 + 1).read_until(b'\n', &mut line)
            .map_err(|_| "dsh 会话文件不是有效的 zstd 帧流；原文件未更改".to_string())?;
        if count == 0 { break; }
        total += count as u64;
        if count > 256 * 1024 * 1024 || total > 8 * 1024 * 1024 * 1024 {
            return Err("dsh 会话解压内容超过读取上限；原索引保留".into());
        }
        let index = next_index;
        next_index += 1;
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let Ok(row) = serde_json::from_slice::<Value>(&line) else {
            partial = true;
            continue;
        };
        let kind = row.get("type").and_then(Value::as_str).unwrap_or("");
        if !header {
            if kind != "session" {
                return Err(
                    "dsh 会话日志缺少 session 头行，不是已验证的会话格式；原文件未更改".into(),
                );
            }
            let version = row.get("version").and_then(Value::as_u64);
            if !version.is_some_and(|value| KNOWN_VERSIONS.contains(&value)) {
                return Err(format!(
                    "dsh 会话日志版本 {version:?} 不在已验证的 0.2.x 样本族内；原文件未更改"
                ));
            }
            header = true;
            if let Some(id) = row.get("id").and_then(Value::as_str) {
                if valid_native_id(id) {
                    session.native_id = Some(id.to_owned());
                }
            }
            session.started_at = row.get("createdAt").and_then(timestamp);
            session.cwd = row.get("cwd").and_then(Value::as_str).map(str::to_owned);
        }
        let time = row.get("time").and_then(timestamp);
        if time.is_some_and(|value| session.updated_at.is_none_or(|current| value > current)) {
            session.updated_at = time;
        }
        match kind {
            "session/title" => {
                if let Some(title) = row.pointer("/data/title").and_then(Value::as_str) {
                    if !title.trim().is_empty() {
                        session.title = title.to_owned();
                    }
                }
            }
            "user/message" => {
                fold_message(row.get("data").unwrap_or(&Value::Null), index, time, &mut session, &mut seen);
            }
            "assistant/message" => {
                let data = row.get("data").unwrap_or(&Value::Null);
                if let Some(message) = data.get("message") {
                    fold_message(message, index, time, &mut session, &mut seen);
                }
                fold_usage(data, index, time, &mut session, &mut events);
            }
            "agent/inbox/spliced" => {
                if let Some(inserted) = row.pointer("/data/inserted").and_then(Value::as_array) {
                    for item in inserted {
                        fold_message(item, index, time, &mut session, &mut seen);
                    }
                }
            }
            "request/context" if session.model.is_none() => {
                session.model = row
                    .pointer("/data/model")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
            }
            _ => {}
        }
    }
    if !header {
        return Err("dsh 会话日志缺少 session 头行，不是已验证的会话格式；原文件未更改".into());
    }
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
            // TokenUsage semantics: inputTokens excludes cached input, so the
            // four buckets stay disjoint (billed input = input + cacheRead +
            // cacheWrite; reasoning tokens are already inside outputTokens).
            input_includes_cache: false,
        })
        .collect();
    session.finish(source)
}

fn message_kind(item: &Value) -> HistoryMessageKind {
    match item.pointer("/source/kind").and_then(Value::as_str) {
        Some("runtime-context") => HistoryMessageKind::EnvironmentContext,
        Some("skill-catalog") => HistoryMessageKind::ProjectContext,
        _ => HistoryMessageKind::Conversation,
    }
}

/// Canonical `user/message` rows and `agent/inbox/spliced` mirrors share the
/// same message ids, so the first sighting of an id wins and replays never
/// duplicate a message.
fn fold_message(
    item: &Value,
    index: usize,
    time: Option<i64>,
    session: &mut ParsedSession,
    seen: &mut HashSet<String>,
) {
    let role = item.get("role").and_then(Value::as_str).unwrap_or("");
    if role != "user" && role != "assistant" {
        return;
    }
    let body = item.get("content").map(text_content).unwrap_or_default();
    if body.trim().is_empty() {
        return;
    }
    let id = item
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| format!("line-{index}"));
    if !seen.insert(id.clone()) {
        return;
    }
    let kind = message_kind(item);
    session.add_classified_message(id, role, body, time, kind);
    if session.model.is_none() {
        session.model = item
            .pointer("/source/model")
            .and_then(Value::as_str)
            .map(str::to_owned);
    }
}

/// "There is no separate usage record": usage rides on the assistant message
/// payload itself. Turn/step identify the request; replayed rows for one
/// request keep the largest snapshot instead of double counting.
fn fold_usage(
    data: &Value,
    index: usize,
    time: Option<i64>,
    session: &mut ParsedSession,
    events: &mut BTreeMap<String, RequestUsage>,
) {
    let Some(usage_value) = data.get("usage") else {
        return;
    };
    let Some(counts) = usage::from_optional(
        usage::field(usage_value, "inputTokens"),
        usage::field(usage_value, "outputTokens"),
        usage::field(usage_value, "cacheReadTokens"),
        usage::field(usage_value, "cacheWriteTokens"),
    ) else {
        return;
    };
    if !usage::active(counts) {
        return;
    }
    let key = match (
        data.get("turn").and_then(Value::as_u64),
        data.get("step").and_then(Value::as_u64),
    ) {
        (Some(turn), Some(step)) => format!("{turn}:{step}"),
        _ => format!("line-{index}"),
    };
    usage::keep_largest_output(
        events,
        key,
        RequestUsage {
            counts,
            model: session.model.clone(),
            timestamp: time,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    // Desensitized from the first real machine sample: same envelope, event
    // types and field shapes; ids, timestamps, cwd and token counts rewritten.
    const SAMPLE_JSONL: &str = "\
{\"type\":\"session\",\"version\":4,\"id\":\"session-00000000-0000-4000-8000-000000000001\",\"createdAt\":1791077550400,\"cwd\":\"C:\\\\work\\\\demo\",\"isSeeded\":false,\"delegationDepth\":0,\"agentPreset\":\"standard\"}
{\"type\":\"permission/preset\",\"seq\":0,\"time\":1791077550401,\"data\":{\"preset\":\"workspace-write\"}}
{\"type\":\"agent/inbox/spliced\",\"seq\":1,\"time\":1791077550418,\"data\":{\"target\":\"next-turn\",\"start\":0,\"inserted\":[{\"content\":[{\"type\":\"text\",\"text\":\"帮我把会话日志解析成表格\"}],\"source\":{\"kind\":\"user\"},\"role\":\"user\",\"id\":\"11111111-1111-4111-8111-111111111111\"}]}}
{\"type\":\"turn/start\",\"seq\":2,\"time\":1791077550421,\"data\":{\"turn\":1}}
{\"type\":\"system/message\",\"seq\":3,\"time\":1791077550481,\"surfaceOp\":\"append\",\"data\":{\"turn\":1,\"step\":1,\"message\":{\"role\":\"system\",\"content\":[{\"type\":\"text\",\"text\":\"You are an AI agent powered by DeepSeek Harness.\"}],\"source\":{\"kind\":\"system-prompt\"},\"id\":\"22222222-2222-4222-8222-222222222222\"}}}
{\"type\":\"user/message\",\"seq\":4,\"time\":1791077550483,\"surfaceOp\":\"append\",\"data\":{\"content\":[{\"type\":\"text\",\"text\":\"帮我把会话日志解析成表格\"}],\"source\":{\"kind\":\"user\"},\"role\":\"user\",\"id\":\"11111111-1111-4111-8111-111111111111\"}}
{\"type\":\"user/message\",\"seq\":5,\"time\":1791077550485,\"surfaceOp\":\"append\",\"data\":{\"content\":[{\"type\":\"text\",\"text\":\"Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\"}],\"source\":{\"kind\":\"runtime-context\",\"form\":\"snapshot\"},\"role\":\"user\",\"id\":\"33333333-3333-4333-8333-333333333333\"}}
{\"type\":\"user/message\",\"seq\":6,\"time\":1791077550486,\"surfaceOp\":\"append\",\"data\":{\"content\":[{\"type\":\"text\",\"text\":\"<system-reminder>\\nA skill is a reusable set of task-specific instructions.\\n</system-reminder>\"}],\"source\":{\"kind\":\"skill-catalog\",\"form\":\"catalog\"},\"role\":\"user\",\"id\":\"44444444-4444-4444-8444-444444444444\"}}
{\"type\":\"request/context\",\"seq\":7,\"time\":1791077550490,\"data\":{\"provider\":\"deepseek-account\",\"model\":\"deepseek-flash\",\"contextWindow\":1000000,\"systemPromptUpdate\":\"in-history\"}}
{\"type\":\"session/title\",\"seq\":8,\"time\":1791077550494,\"data\":{\"title\":\"帮我把会话日志解析成表格\",\"messageSeqs\":[4],\"source\":{\"kind\":\"fallback\"}}}
{\"type\":\"assistant/message\",\"seq\":9,\"time\":1791077551380,\"surfaceOp\":\"append\",\"data\":{\"turn\":1,\"step\":1,\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"reasoning\",\"text\":\"\"},{\"type\":\"text\",\"text\":\"可以，我先读取日志目录。\"}],\"source\":{\"kind\":\"model\",\"provider\":\"deepseek-account\",\"model\":\"deepseek-flash\"},\"id\":\"55555555-5555-4555-8555-555555555555\"},\"usage\":{\"inputTokens\":120,\"outputTokens\":35,\"cacheReadTokens\":0,\"cacheWriteTokens\":0,\"totalTokens\":155}}}
{\"type\":\"turn/end\",\"seq\":10,\"time\":1791077551382,\"data\":{\"turn\":1,\"reason\":{\"kind\":\"completed\"}}}
{\"type\":\"agent/inbox/spliced\",\"seq\":11,\"time\":1791077560407,\"data\":{\"target\":\"next-turn\",\"start\":0,\"inserted\":[{\"content\":[{\"type\":\"text\",\"text\":\"统计每轮的 token 用量\"}],\"source\":{\"kind\":\"user\"},\"role\":\"user\",\"id\":\"66666666-6666-4666-8666-666666666666\"}]}}
{\"type\":\"turn/start\",\"seq\":12,\"time\":1791077560421,\"data\":{\"turn\":2}}
{\"type\":\"user/message\",\"seq\":13,\"time\":1791077560423,\"surfaceOp\":\"append\",\"data\":{\"content\":[{\"type\":\"text\",\"text\":\"统计每轮的 token 用量\"}],\"source\":{\"kind\":\"user\"},\"role\":\"user\",\"id\":\"66666666-6666-4666-8666-666666666666\"}}
{\"type\":\"assistant/message\",\"seq\":14,\"time\":1791077562400,\"surfaceOp\":\"append\",\"data\":{\"turn\":2,\"step\":1,\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"已统计完成。\"}],\"source\":{\"kind\":\"model\",\"provider\":\"deepseek-account\",\"model\":\"deepseek-flash\"},\"id\":\"77777777-7777-4777-8777-777777777777\"},\"usage\":{\"inputTokens\":210,\"outputTokens\":48,\"cacheReadTokens\":64,\"cacheWriteTokens\":0,\"totalTokens\":322}}}
{\"type\":\"session/title\",\"seq\":15,\"time\":1791077562600,\"data\":{\"title\":\"会话日志解析与用量统计\",\"messageSeqs\":[4,13],\"source\":{\"kind\":\"provider\",\"provider\":\"session-title-first-prompt-llm\",\"model\":{\"provider\":\"deepseek-account\",\"model\":\"deepseek-flash\"}}}}
{\"type\":\"turn/end\",\"seq\":16,\"time\":1791077562602,\"data\":{\"turn\":2,\"reason\":{\"kind\":\"completed\"}}}
";

    /// One zstd frame per appended record, concatenated: the real append
    /// semantics observed on disk. Production code only decodes.
    fn encode_session(jsonl: &str) -> Vec<u8> {
        let mut out = Vec::new();
        for line in jsonl.split('\n') {
            if line.trim().is_empty() {
                continue;
            }
            let record = format!("{line}\n");
            out.extend_from_slice(
                &zstd::bulk::compress(record.as_bytes(), 3).expect("zstd frame compression"),
            );
        }
        out
    }

    fn fixture_source(name: &str) -> HistorySource {
        HistorySource { native_title: None,
            path: std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("tests")
                .join("fixtures")
                .join("history")
                .join(name),
            native_id: None,
            fingerprint: "fixture".into(),
            fingerprint_error: None,
        }
    }

    #[test]
    #[ignore = "fixture generator: cargo test deepseek::history::tests::regenerate_session_fixture --manifest-path src-tauri/Cargo.toml -- --ignored rewrites the committed sample"]
    fn regenerate_session_fixture() {
        let directory = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tests")
            .join("fixtures")
            .join("history");
        fs::write(
            directory.join("dsh-0.2.1-v4.session.jsonl.zstd"),
            encode_session(SAMPLE_JSONL),
        )
        .unwrap();
    }

    #[test]
    fn committed_fixture_matches_the_encoder() {
        let fixture = fs::read(fixture_source("dsh-0.2.1-v4.session.jsonl.zstd").path).unwrap();
        assert_eq!(fixture, encode_session(SAMPLE_JSONL));
    }

    #[test]
    fn session_log_yields_title_context_messages_and_usage() {
        let parsed = parse(&fixture_source("dsh-0.2.1-v4.session.jsonl.zstd")).unwrap();
        assert_eq!(
            parsed.native_id.as_deref(),
            Some("session-00000000-0000-4000-8000-000000000001")
        );
        // The last session/title row (provider generated) wins over the
        // fallback title and the first-message fallback.
        assert_eq!(parsed.title, "会话日志解析与用量统计");
        assert_eq!(parsed.cwd.as_deref(), Some("C:\\work\\demo"));
        assert_eq!(parsed.model.as_deref(), Some("deepseek-flash"));
        assert_eq!(parsed.started_at, Some(1791077550400));
        assert_eq!(parsed.updated_at, Some(1791077562602));
        // The spliced mirror shares ids with canonical rows: no duplicates,
        // and the system prompt row never becomes a message.
        assert_eq!(parsed.messages.len(), 6);
        assert_eq!(
            parsed
                .messages
                .iter()
                .filter(|message| message.role == "user")
                .count(),
            4
        );
        assert_eq!(parsed.messages[0].text, "帮我把会话日志解析成表格");
        // runtime-context and skill-catalog rows fold as context kinds.
        assert_eq!(parsed.messages[1].kind, HistoryMessageKind::EnvironmentContext);
        assert_eq!(parsed.messages[2].kind, HistoryMessageKind::ProjectContext);
        // Reasoning blocks stay out of the assistant text.
        assert_eq!(parsed.messages[3].text, "可以，我先读取日志目录。");
        assert!(!parsed.partial);
        assert_eq!(parsed.usage.len(), 2);
        assert_eq!(parsed.usage[0].id, "1:1");
        assert_eq!(parsed.usage[0].model.as_deref(), Some("deepseek-flash"));
        assert_eq!(parsed.usage[0].input, Some(120));
        assert_eq!(parsed.usage[0].output, Some(35));
        assert_eq!(parsed.usage[1].id, "2:1");
        assert_eq!(parsed.usage[1].input, Some(210));
        assert_eq!(parsed.usage[1].output, Some(48));
        assert_eq!(parsed.usage[1].cache_read, Some(64));
        assert!(parsed.usage.iter().all(|event| !event.input_includes_cache));
    }

    #[test]
    fn broken_streams_fail_closed_and_never_touch_the_file() {
        let directory = tempfile::tempdir().unwrap();
        let original = fs::read(fixture_source("dsh-0.2.1-v4.session.jsonl.zstd").path).unwrap();
        let path = directory.path().join("broken.session.jsonl.zstd");
        let source = HistorySource { native_title: None,
            path: path.clone(),
            native_id: None,
            fingerprint: "fixture".into(),
            fingerprint_error: None,
        };
        let cases: Vec<(&str, Vec<u8>, &str)> = vec![
            ("truncated tail", original[..original.len() - 5].to_vec(), "zstd"),
            ("torn append", [original.as_slice(), b"\x00\x00".as_slice()].concat(), "zstd"),
            (
                "plain jsonl",
                b"{\"type\":\"session\",\"version\":4}\n".to_vec(),
                "zstd",
            ),
            (
                "missing header row",
                encode_session(
                    "{\"type\":\"user/message\",\"seq\":0,\"time\":1791077550483,\"surfaceOp\":\"append\",\"data\":{\"content\":[{\"type\":\"text\",\"text\":\"hi\"}],\"source\":{\"kind\":\"user\"},\"role\":\"user\",\"id\":\"11111111-1111-4111-8111-111111111111\"}}\n",
                ),
                "头行",
            ),
            (
                "unverified version",
                encode_session(
                    "{\"type\":\"session\",\"version\":5,\"id\":\"session-00000000-0000-4000-8000-000000000001\",\"createdAt\":1791077550400,\"cwd\":\"C:\\\\work\\\\demo\"}\n",
                ),
                "样本族",
            ),
        ];
        for (name, damaged, marker) in cases {
            fs::write(&path, &damaged).unwrap();
            let error = parse(&source).unwrap_err();
            assert!(error.contains(marker), "{name}: {error}");
            // Fail-closed means fail-untouched: the log on disk is byte-identical.
            assert_eq!(fs::read(&path).unwrap(), damaged, "{name}");
        }
    }

    #[test]
    fn discovery_sniffs_zstd_streams_under_the_harness_home() {
        let home = tempfile::tempdir().unwrap();
        let sessions = home
            .path()
            .join(".dsh")
            .join("sessions")
            .join("--C-work-demo--")
            .join("session-00000000-0000-4000-8000-000000000001");
        fs::create_dir_all(&sessions).unwrap();
        fs::write(
            sessions.join("session.v4.jsonl.zstd"),
            encode_session(SAMPLE_JSONL),
        )
        .unwrap();
        fs::write(sessions.join("notes.txt"), "not a session").unwrap();
        // Right extension but not a zstd stream: rejected by the magic sniff.
        fs::write(home.path().join(".dsh").join("plain.jsonl.zstd"), "{\"type\":\"session\"}\n").unwrap();
        let sources = sources(home.path()).unwrap();
        let names: Vec<_> = sources
            .iter()
            .map(|source| source.path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["session.v4.jsonl.zstd"]);
        assert!(sources.iter().all(|source| source.fingerprint.starts_with("m3:")));
    }
}
