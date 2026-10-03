//! dsh session logs: append-only JSONL compressed into checksum-chained
//! Zstandard frames; the finalized (V4) and released (V3) frame versions
//! coexist across the verified 0.2.x family.
//!
//! Frame layout implemented here (the official docs describe "checksum-chained
//! zstd frames" without a byte-level spec, so the concrete container below is
//! the constructed contract proven by the versioned fixture pair; see the
//! workflow evidence notes):
//! - bytes `0..4`: magic `DSHF`
//! - byte `4`: frame version, `3` (released) or `4` (finalized)
//! - then frames until end of file, each:
//!   - 32 bytes: SHA-256 of (previous digest || this frame's compressed bytes)
//!   - 4 bytes little-endian u32: compressed length
//!   - 4 bytes little-endian u32: uncompressed length
//!   - the compressed zstd frame bytes
//! - the seed digest is SHA-256(magic || version)
//!
//! A broken digest, length or decompressed size rejects the whole session
//! file: the parser is read-only and never rewrites or truncates the log.

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::Path;

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::history::usage::{self, RequestUsage};
use crate::history::{
    check_cancelled, discover_jsonl_controlled, text_content, timestamp, HistorySource,
    ParsedSession, UsageEvent,
};

const HEADER_BYTES: usize = 5;
const MAGIC: [u8; 4] = *b"DSHF";
const KNOWN_VERSIONS: [u8; 2] = [3, 4];

fn seed_digest(version: u8) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(MAGIC);
    hasher.update([version]);
    hasher.finalize().into()
}

fn chain_digest(previous: &[u8; 32], compressed: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(previous);
    hasher.update(compressed);
    hasher.finalize().into()
}

/// Encodes the documented container. Production code only decodes; the
/// test-only encoder exists so the committed fixtures and the parser provably
/// share one format (run the ignored generator to rewrite the pair).
#[cfg(test)]
pub(crate) fn encode_frames(version: u8, jsonl: &str) -> Vec<u8> {
    assert!(KNOWN_VERSIONS.contains(&version), "unverified frame version");
    let mut out = Vec::new();
    out.extend_from_slice(&MAGIC);
    out.push(version);
    let mut previous = seed_digest(version);
    for line in jsonl.split('\n') {
        if line.trim().is_empty() {
            continue;
        }
        // One frame per append: dsh appends whole records to the log.
        let record = format!("{line}\n");
        let compressed =
            zstd::bulk::compress(record.as_bytes(), 3).expect("zstd frame compression");
        let digest = chain_digest(&previous, &compressed);
        out.extend_from_slice(&digest);
        out.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
        out.extend_from_slice(&(record.len() as u32).to_le_bytes());
        out.extend_from_slice(&compressed);
        previous = digest;
    }
    out
}

fn decode_frames(bytes: &[u8]) -> Result<Vec<Vec<u8>>, String> {
    if bytes.len() < HEADER_BYTES || bytes[..4] != MAGIC {
        return Err("dsh 会话文件缺少 DSHF 帧标记，不是已验证的会话格式；原文件未更改".into());
    }
    let version = bytes[4];
    if !KNOWN_VERSIONS.contains(&version) {
        return Err(format!(
            "dsh 会话帧版本 {version} 不在已验证的 0.2.x 窄版本族内；原文件未更改"
        ));
    }
    let read_u32 = |offset: usize| -> Option<u32> {
        bytes
            .get(offset..offset + 4)
            .map(|slice| u32::from_le_bytes(slice.try_into().expect("four bytes")))
    };
    let mut previous = seed_digest(version);
    let mut cursor = HEADER_BYTES;
    let mut frames = Vec::new();
    while cursor < bytes.len() {
        let Some(expected) = bytes.get(cursor..cursor + 32) else {
            return Err("dsh 会话帧头不完整；校验和链断裂，原文件未更改".into());
        };
        cursor += 32;
        let Some(compressed_len) = read_u32(cursor) else {
            return Err("dsh 会话帧长度字段不完整；校验和链断裂，原文件未更改".into());
        };
        cursor += 4;
        let Some(plain_len) = read_u32(cursor) else {
            return Err("dsh 会话帧长度字段不完整；校验和链断裂，原文件未更改".into());
        };
        cursor += 4;
        let Some(compressed) = bytes.get(cursor..cursor + compressed_len as usize) else {
            return Err("dsh 会话帧数据不完整；校验和链断裂，原文件未更改".into());
        };
        cursor += compressed_len as usize;
        let actual = chain_digest(&previous, compressed);
        if actual.as_slice() != expected {
            return Err(format!(
                "dsh 会话第 {} 帧校验和链断裂；整个会话拒绝解析，原文件未更改",
                frames.len() + 1
            ));
        }
        let plain = zstd::bulk::decompress(compressed, plain_len as usize)
            .map_err(|_| "dsh 会话帧解压失败；原文件未更改".to_string())?;
        if plain.len() != plain_len as usize {
            return Err("dsh 会话帧解压长度与帧头不一致；校验和链断裂，原文件未更改".into());
        }
        previous = actual;
        frames.push(plain);
    }
    Ok(frames)
}

fn session_file(path: &Path) -> bool {
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut header = [0u8; HEADER_BYTES];
    file.read_exact(&mut header).is_ok()
        && header[..4] == MAGIC
        && KNOWN_VERSIONS.contains(&header[4])
}

pub fn sources(home: &Path) -> Result<Vec<HistorySource>, String> {
    sources_controlled(home, &|| false)
}

pub fn sources_controlled(
    home: &Path,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<HistorySource>, String> {
    let root = crate::accounts::selection::history_root("deepseek", || super::dsh_home(home));
    // No file name or extension is documented, so discovery sniffs the frame
    // header instead of trusting a guessable naming scheme.
    discover_jsonl_controlled(&root, session_file, cancelled)
}

pub fn parse(source: &HistorySource) -> Result<ParsedSession, String> {
    parse_controlled(source, &|| false)
}

pub fn parse_controlled(
    source: &HistorySource,
    cancelled: &dyn Fn() -> bool,
) -> Result<ParsedSession, String> {
    check_cancelled(cancelled)?;
    let bytes = fs::read(&source.path).map_err(|error| error.to_string())?;
    check_cancelled(cancelled)?;
    let frames = decode_frames(&bytes)?;
    let mut session = ParsedSession::new();
    let mut events = BTreeMap::<String, RequestUsage>::new();
    let mut partial = false;
    let mut index = 0usize;
    for frame in frames {
        check_cancelled(cancelled)?;
        for line in frame.split(|byte| *byte == b'\n') {
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            index += 1;
            let Ok(row) = serde_json::from_slice::<Value>(line) else {
                partial = true;
                continue;
            };
            fold_row(&row, index, &mut session, &mut events);
        }
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
            // cacheWrite; reasoningTokens are already inside outputTokens).
            input_includes_cache: false,
        })
        .collect();
    session.finish(source)
}

fn fold_row(
    row: &Value,
    index: usize,
    session: &mut ParsedSession,
    events: &mut BTreeMap<String, RequestUsage>,
) {
    let kind = row.get("type").and_then(Value::as_str).unwrap_or("");
    if kind != "user" && kind != "assistant" {
        return;
    }
    let message = row.get("message").unwrap_or(&Value::Null);
    let body = message.get("content").map(text_content).unwrap_or_default();
    let time = row.get("timestamp").and_then(timestamp);
    session.add_message(format!("line-{index}"), kind, body, time);
    if session.model.is_none() {
        session.model = message
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_owned);
    }
    if kind != "assistant" {
        return;
    }
    // "There is no separate usage record": usage rides on the assistant
    // message payload itself.
    let Some(usage_value) = row.get("usage").or_else(|| message.get("usage")) else {
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
    // Streaming snapshots repeat one turn/step and grow the output; keep the
    // largest snapshot instead of double counting the request.
    let key = match (
        row.get("turn").and_then(Value::as_u64),
        row.get("step").and_then(Value::as_u64),
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

    const V3_JSONL: &str = "\
{\"type\":\"user\",\"turn\":1,\"timestamp\":\"2026-09-28T09:15:00Z\",\"message\":{\"role\":\"user\",\"content\":\"帮我把会话日志解析成表格\"}}
{\"type\":\"assistant\",\"turn\":1,\"step\":0,\"stream\":false,\"interrupted\":false,\"timestamp\":\"2026-09-28T09:15:02Z\",\"message\":{\"role\":\"assistant\",\"model\":\"deepseek-chat\",\"content\":[{\"type\":\"text\",\"text\":\"可以，我先读取日志目录。\"}]},\"usage\":{\"inputTokens\":120,\"outputTokens\":35,\"totalTokens\":155}}
{\"type\":\"user\",\"turn\":2,\"timestamp\":\"2026-09-28T09:16:10Z\",\"message\":{\"role\":\"user\",\"content\":\"统计每轮的 token 用量\"}}
{\"type\":\"assistant\",\"turn\":2,\"step\":0,\"stream\":false,\"interrupted\":false,\"timestamp\":\"2026-09-28T09:16:12Z\",\"message\":{\"role\":\"assistant\",\"model\":\"deepseek-chat\",\"content\":[{\"type\":\"text\",\"text\":\"已统计完成。\"}]},\"usage\":{\"inputTokens\":210,\"outputTokens\":48,\"totalTokens\":258,\"cacheReadTokens\":64}}
";

    const V4_JSONL: &str = "\
{\"type\":\"user\",\"turn\":1,\"timestamp\":\"2026-10-01T14:02:00Z\",\"message\":{\"role\":\"user\",\"content\":\"整理这个项目的 README\"}}
{\"type\":\"assistant\",\"turn\":1,\"step\":0,\"stream\":true,\"interrupted\":false,\"timestamp\":\"2026-10-01T14:02:03Z\",\"message\":{\"role\":\"assistant\",\"model\":\"deepseek-reasoner\",\"content\":[{\"type\":\"text\",\"text\":\"整理中\"}]},\"usage\":{\"inputTokens\":80,\"outputTokens\":12,\"totalTokens\":92,\"cacheWriteTokens\":16,\"reasoningTokens\":4}}
{\"type\":\"assistant\",\"turn\":1,\"step\":0,\"stream\":false,\"interrupted\":false,\"timestamp\":\"2026-10-01T14:02:09Z\",\"message\":{\"role\":\"assistant\",\"model\":\"deepseek-reasoner\",\"content\":[{\"type\":\"text\",\"text\":\"整理完成：README 已更新。\"}]},\"usage\":{\"inputTokens\":80,\"outputTokens\":57,\"totalTokens\":137,\"cacheReadTokens\":32,\"cacheWriteTokens\":16,\"reasoningTokens\":21}}
{\"type\":\"assistant\",\"turn\":1,\"step\":1,\"stream\":false,\"interrupted\":true,\"timestamp\":\"2026-10-01T14:03:00Z\",\"message\":{\"role\":\"assistant\",\"model\":\"deepseek-reasoner\",\"content\":[{\"type\":\"text\",\"text\":\"（已中断）\"}]},\"usage\":{\"inputTokens\":20,\"outputTokens\":5,\"totalTokens\":25}}
";

    fn fixture_source(name: &str) -> HistorySource {
        HistorySource {
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
    #[ignore = "fixture generator: cargo test deepseek::history::tests::regenerate_pair_fixtures --manifest-path src-tauri/Cargo.toml -- --ignored rewrites the committed pair"]
    fn regenerate_pair_fixtures() {
        let directory = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tests")
            .join("fixtures")
            .join("history");
        fs::write(directory.join("dsh-0.2.1-v3.frames"), encode_frames(3, V3_JSONL)).unwrap();
        fs::write(directory.join("dsh-0.2.1-v4.frames"), encode_frames(4, V4_JSONL)).unwrap();
    }

    #[test]
    fn committed_fixtures_match_the_documented_encoder() {
        let v3 = fs::read(fixture_source("dsh-0.2.1-v3.frames").path).unwrap();
        assert_eq!(v3, encode_frames(3, V3_JSONL));
        let v4 = fs::read(fixture_source("dsh-0.2.1-v4.frames").path).unwrap();
        assert_eq!(v4, encode_frames(4, V4_JSONL));
    }

    #[test]
    fn v3_and_v4_frames_yield_sessions_and_token_usage() {
        let v3 = parse(&fixture_source("dsh-0.2.1-v3.frames")).unwrap();
        assert_eq!(v3.messages.len(), 4);
        assert_eq!(v3.messages[0].role, "user");
        assert_eq!(v3.title, "帮我把会话日志解析成表格");
        assert_eq!(v3.model.as_deref(), Some("deepseek-chat"));
        assert!(!v3.partial);
        assert_eq!(v3.usage.len(), 2);
        assert_eq!(
            v3.usage.iter().map(|item| item.input.unwrap()).sum::<u64>(),
            330
        );
        assert_eq!(
            v3.usage.iter().map(|item| item.output.unwrap()).sum::<u64>(),
            83
        );
        assert_eq!(
            v3.usage
                .iter()
                .map(|item| item.cache_read.unwrap())
                .sum::<u64>(),
            64
        );
        assert!(v3.usage.iter().all(|item| !item.input_includes_cache));

        let v4 = parse(&fixture_source("dsh-0.2.1-v4.frames")).unwrap();
        assert_eq!(v4.messages.len(), 4);
        assert_eq!(v4.model.as_deref(), Some("deepseek-reasoner"));
        // The streamed snapshot pair collapses into one request event.
        assert_eq!(v4.usage.len(), 2);
        assert_eq!(v4.usage[0].id, "1:0");
        assert_eq!(v4.usage[0].output, Some(57));
        assert_eq!(v4.usage[0].input, Some(80));
        assert_eq!(v4.usage[0].cache_write, Some(16));
        assert_eq!(v4.usage[0].cache_read, Some(32));
        assert_eq!(v4.usage[1].id, "1:1");
        assert_eq!(
            v4.usage.iter().map(|item| item.output.unwrap()).sum::<u64>(),
            62
        );
        assert!(v4.started_at.is_some());
        assert!(v4.updated_at.is_some());
    }

    #[test]
    fn broken_checksum_chain_fails_closed_and_never_touches_the_file() {
        let directory = tempfile::tempdir().unwrap();
        let original = fs::read(fixture_source("dsh-0.2.1-v4.frames").path).unwrap();
        let path = directory.path().join("broken.frames");
        // Corrupt one payload byte inside the second frame's compressed body.
        // Frame layout: header(5) | digest(32) compressed_len(4) plain_len(4) payload.
        let mut damaged = original.clone();
        let first_compressed_len =
            u32::from_le_bytes(original[HEADER_BYTES + 32..HEADER_BYTES + 36].try_into().unwrap())
                as usize;
        let second_payload = HEADER_BYTES + 40 + first_compressed_len;
        damaged[second_payload + 2] ^= 0xff;
        assert_ne!(damaged, original);
        fs::write(&path, &damaged).unwrap();
        let source = HistorySource {
            path: path.clone(),
            native_id: None,
            fingerprint: "fixture".into(),
            fingerprint_error: None,
        };
        let error = parse(&source).unwrap_err();
        assert!(error.contains("校验和链断裂"), "{error}");
        // Fail-closed means fail-untouched: the log on disk is byte-identical.
        assert_eq!(fs::read(&path).unwrap(), damaged);

        // A truncated tail, a bad version byte and a plain non-frame file are
        // equally rejected without touching anything on disk.
        let truncated = &original[..original.len() - 3];
        fs::write(&path, truncated).unwrap();
        assert!(parse(&source).is_err());
        let mut bad_version = original.clone();
        bad_version[4] = 5;
        fs::write(&path, &bad_version).unwrap();
        assert!(parse(&source).unwrap_err().contains("窄版本族"));
        let plain_path = directory.path().join("notes.jsonl");
        fs::write(&plain_path, "{\"type\":\"user\",\"message\":{\"content\":\"hello\"}}\n").unwrap();
        let plain = parse(&HistorySource {
            path: plain_path,
            native_id: None,
            fingerprint: "fixture".into(),
            fingerprint_error: None,
        })
        .unwrap_err();
        assert!(plain.contains("DSHF"), "{plain}");
    }

    #[test]
    fn discovery_sniffs_frame_headers_under_the_harness_home() {
        let home = tempfile::tempdir().unwrap();
        let sessions = home.path().join(".dsh").join("by-cwd").join("work-app");
        fs::create_dir_all(&sessions).unwrap();
        fs::write(
            sessions.join("session-a.frames"),
            encode_frames(4, V4_JSONL),
        )
        .unwrap();
        fs::write(
            sessions.join("session-b.frames"),
            encode_frames(3, V3_JSONL),
        )
        .unwrap();
        fs::write(sessions.join("unrelated.txt"), "not a session").unwrap();
        let sources = sources(home.path()).unwrap();
        let mut names: Vec<_> = sources
            .iter()
            .map(|source| source.path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, ["session-a.frames", "session-b.frames"]);
        assert!(sources.iter().all(|source| source.fingerprint.starts_with("m3:")));
    }
}
