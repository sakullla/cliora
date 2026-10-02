use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::UNIX_EPOCH;

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::database::Database;
use crate::domain::CliId;
use crate::native::adapters::{CliAdapter, Registry};

pub mod claude;
pub mod codex;
pub mod grok;
pub mod opencode;
pub mod pi;
mod report;
mod usage;

pub use report::{usage_report, UsageReport};

/// Usage lives at the end of long sessions, so whole files are streamed. The cap only
/// protects against devices or runaway files, not ordinary large rollouts.
const MAX_SOURCE_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 256 * 1024 * 1024;
/// Line filters only look at this many leading bytes before deciding to skip a row.
const LINE_PREFIX_BYTES: usize = 1024;
const MAX_SOURCES: usize = 5_000;
const MAX_MESSAGES: usize = 2_000;
const MAX_MESSAGE_CHARS: usize = 16_000;
/// A source that parsed cleanly but holds nothing to show is skipped, not a failure.
pub const EMPTY_SESSION: &str = "会话没有可展示的内容";

#[derive(Clone, Debug)]
pub struct HistorySource {
    pub path: PathBuf,
    pub native_id: Option<String>,
    pub fingerprint: String,
    pub fingerprint_error: Option<String>,
}

impl HistorySource {
    pub fn key(&self) -> String {
        format!(
            "{}#{}",
            self.path.display(),
            self.native_id.as_deref().unwrap_or("")
        )
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMessage {
    pub id: String,
    pub role: String,
    pub text: String,
    pub timestamp: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageEvent {
    pub id: String,
    pub model: Option<String>,
    pub timestamp: Option<i64>,
    pub input: Option<u64>,
    pub output: Option<u64>,
    pub cache_read: Option<u64>,
    pub cache_write: Option<u64>,
    pub input_includes_cache: bool,
}

#[derive(Clone, Debug)]
pub struct ParsedSession {
    pub native_id: Option<String>,
    pub title: String,
    pub cwd: Option<String>,
    pub model: Option<String>,
    pub started_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub messages: Vec<HistoryMessage>,
    pub usage: Vec<UsageEvent>,
    pub partial: bool,
}

impl ParsedSession {
    pub fn new() -> Self {
        Self {
            native_id: None,
            title: String::new(),
            cwd: None,
            model: None,
            started_at: None,
            updated_at: None,
            messages: Vec::new(),
            usage: Vec::new(),
            partial: false,
        }
    }
    pub fn add_message(&mut self, id: String, role: &str, text: String, time: Option<i64>) {
        if text.trim().is_empty() {
            return;
        }
        if self.messages.len() >= MAX_MESSAGES {
            self.partial = true;
            return;
        }
        let mut text = text;
        if text.chars().count() > MAX_MESSAGE_CHARS {
            text = text.chars().take(MAX_MESSAGE_CHARS).collect();
            self.partial = true;
        }
        if self.title.is_empty() && role == "user" {
            self.title = text
                .lines()
                .find(|line| !line.trim().is_empty())
                .unwrap_or("")
                .chars()
                .take(96)
                .collect();
        }
        self.messages.push(HistoryMessage {
            id,
            role: role.to_owned(),
            text,
            timestamp: time,
        });
    }
    pub fn finish(mut self, source: &HistorySource) -> Result<Self, String> {
        if self.native_id.is_none() {
            self.native_id = source.native_id.clone();
        }
        if self.title.is_empty() {
            self.title = "未命名会话".into();
        }
        if self.updated_at.is_none() {
            self.updated_at = self
                .messages
                .iter()
                .filter_map(|item| item.timestamp)
                .max()
                .or(self.started_at);
        }
        if self.started_at.is_none() {
            self.started_at = self
                .messages
                .iter()
                .filter_map(|item| item.timestamp)
                .min()
                .or(self.updated_at);
        }
        if self.messages.is_empty() && self.usage.is_empty() && self.native_id.is_none() {
            return Err(if self.partial { "未识别到可展示的会话记录" } else { EMPTY_SESSION }.into());
        }
        Ok(self)
    }
}

pub fn timestamp(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number.as_i64().map(|time| {
            if time < 10_000_000_000 {
                time * 1000
            } else {
                time
            }
        }),
        Value::String(text) => DateTime::parse_from_rfc3339(text)
            .ok()
            .map(|date| date.timestamp_millis()),
        _ => None,
    }
}

pub fn at(value: &Value, path: &[&str]) -> Option<Value> {
    let mut current = value;
    for part in path {
        current = current.get(*part)?;
    }
    Some(current.clone())
}

pub fn text_content(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| {
                let kind = part.get("type").and_then(Value::as_str).unwrap_or("");
                if ["text", "input_text", "output_text"].contains(&kind) {
                    part.get("text").and_then(Value::as_str)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

pub fn valid_native_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
}

pub fn source_fingerprint(path: &Path) -> Result<String, String> {
    source_fingerprint_controlled(path, &|| false)
}

pub fn check_cancelled(cancelled: &dyn Fn() -> bool) -> Result<(), String> {
    if cancelled() { Err("扫描已取消，原索引已保留".into()) } else { Ok(()) }
}

pub fn source_fingerprint_controlled(path: &Path, cancelled: &dyn Fn() -> bool) -> Result<String, String> {
    check_cancelled(cancelled)?;
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("会话源为符号链接，已跳过".into());
    }
    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    // History caching uses metadata, including change-time so a same-size edit
    // with a restored mtime is still re-indexed. Native write/CAS hashes are separate.
    let changed = source_change_time(path, &metadata, cancelled)?;
    Ok(format!("m3:{}:{modified}:{changed}", metadata.len()))
}

fn source_change_time(_path: &Path, metadata: &fs::Metadata, _cancelled: &dyn Fn() -> bool) -> Result<String, String> {
    #[cfg(windows)] {
        use std::os::windows::io::AsRawHandle;
        #[repr(C)] struct BasicInfo { creation:i64, accessed:i64, written:i64, changed:i64, attributes:u32 }
        #[link(name="kernel32")] unsafe extern "system" {
            fn GetFileInformationByHandleEx(handle:*mut std::ffi::c_void, class:i32, info:*mut std::ffi::c_void, size:u32) -> i32;
        }
        let file = fs::File::open(_path).map_err(|e| e.to_string())?;
        let mut info = BasicInfo {creation:0,accessed:0,written:0,changed:0,attributes:0};
        if unsafe { GetFileInformationByHandleEx(file.as_raw_handle(), 0, (&mut info as *mut BasicInfo).cast(), std::mem::size_of::<BasicInfo>() as u32) } != 0 {
            return Ok(info.changed.to_string());
        }
    }
    #[cfg(unix)] {
        use std::os::unix::fs::MetadataExt;
        return Ok(format!("{}:{}",metadata.ctime(),metadata.ctime_nsec()));
    }
    // Fail over to content hashing when the filesystem cannot report change-time.
    #[allow(unreachable_code)] {
        let _ = metadata;
        let mut file = fs::File::open(_path).map_err(|e| e.to_string())?;
        let mut digest = Sha256::new(); let mut buffer = [0u8;64*1024];
        loop { check_cancelled(_cancelled)?; let count = file.read(&mut buffer).map_err(|e| e.to_string())?; if count == 0 {break;} digest.update(&buffer[..count]); }
        Ok(format!("{:x}",digest.finalize()))
    }
}

pub fn discover_jsonl(
    root: &Path,
    accept: impl Fn(&Path) -> bool,
) -> Result<Vec<HistorySource>, String> {
    discover_jsonl_with(root, accept, source_fingerprint)
}

pub fn discover_jsonl_controlled(root: &Path, accept: impl Fn(&Path) -> bool, cancelled: &dyn Fn() -> bool) -> Result<Vec<HistorySource>, String> {
    discover_jsonl_with_control(root, accept, |path| source_fingerprint_controlled(path, cancelled), cancelled)
}

fn discover_jsonl_with(
    root: &Path,
    accept: impl Fn(&Path) -> bool,
    fingerprint: impl Fn(&Path) -> Result<String, String>,
) -> Result<Vec<HistorySource>, String> {
    discover_jsonl_with_control(root, accept, fingerprint, &|| false)
}

fn discover_jsonl_with_control(root: &Path, accept: impl Fn(&Path) -> bool, fingerprint: impl Fn(&Path) -> Result<String, String>, cancelled: &dyn Fn() -> bool) -> Result<Vec<HistorySource>, String> {
    check_cancelled(cancelled)?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    if !root.is_dir() || root.is_symlink() {
        return Err("会话根目录不可读取".into());
    }
    let mut pending = vec![(root.to_path_buf(), 0usize)];
    let mut sources = Vec::new();
    while let Some((directory, depth)) = pending.pop() {
        check_cancelled(cancelled)?;
        for entry in fs::read_dir(&directory).map_err(|error| error.to_string())? {
            check_cancelled(cancelled)?;
            let entry = entry.map_err(|error| error.to_string())?;
            let file_type = entry.file_type().map_err(|error| error.to_string())?;
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            if file_type.is_dir() && depth < 5 {
                pending.push((path, depth + 1));
            } else if file_type.is_file() && accept(&path) {
                let checked = fingerprint(&path);
                check_cancelled(cancelled)?;
                sources.push(HistorySource {
                    fingerprint: checked.as_ref().cloned().unwrap_or_default(),
                    fingerprint_error: checked.err(),
                    path,
                    native_id: None,
                });
                if sources.len() > MAX_SOURCES {
                    return Err("会话源超过 5000 个，本次未删除旧索引".into());
                }
            }
        }
    }
    Ok(sources)
}

pub fn read_jsonl(
    source: &HistorySource,
    consume: impl FnMut(usize, Value),
) -> Result<bool, String> {
    read_jsonl_controlled(source, &|| false, consume)
}

pub fn read_jsonl_controlled(source: &HistorySource, cancelled: &dyn Fn() -> bool, consume: impl FnMut(usize, Value)) -> Result<bool, String> {
    read_jsonl_filtered(source, cancelled, |_| false, consume)
}

/// Streams every row. `skip` sees at most the first `LINE_PREFIX_BYTES` of a row and
/// may drop rows that are known to carry neither text nor usage (tool output, compaction
/// snapshots) without allocating or parsing them. Row indexes still count skipped rows,
/// so line-based ids stay stable.
pub fn read_jsonl_filtered(
    source: &HistorySource,
    cancelled: &dyn Fn() -> bool,
    skip: impl Fn(&[u8]) -> bool,
    mut consume: impl FnMut(usize, Value),
) -> Result<bool, String> {
    check_cancelled(cancelled)?;
    let size = fs::metadata(&source.path)
        .map_err(|error| error.to_string())?
        .len();
    if size > MAX_SOURCE_BYTES {
        return Err("会话文件超过 8 GiB，未读取".into());
    }
    let file = fs::File::open(&source.path).map_err(|error| error.to_string())?;
    let mut reader = BufReader::with_capacity(256 * 1024, file);
    let mut partial = false;
    let mut line = Vec::new();
    let mut index = 0usize;
    loop {
        check_cancelled(cancelled)?;
        match read_row(&mut reader, &mut line, &skip).map_err(|error| error.to_string())? {
            Row::End => break,
            Row::Skipped => {}
            Row::TooLong => partial = true,
            Row::Kept => {
                let text = line.strip_suffix(b"\r").unwrap_or(&line[..]);
                if !text.iter().all(u8::is_ascii_whitespace) {
                    match serde_json::from_slice::<Value>(text) {
                        Ok(value) => consume(index, value),
                        Err(_) => partial = true,
                    }
                }
            }
        }
        index += 1;
    }
    check_cancelled(cancelled)?;
    Ok(partial)
}

enum Row {
    End,
    Kept,
    Skipped,
    TooLong,
}

fn read_row(reader: &mut impl BufRead, line: &mut Vec<u8>, skip: &dyn Fn(&[u8]) -> bool) -> std::io::Result<Row> {
    line.clear();
    let mut read_any = false;
    let mut checked = false;
    let mut dropped = None;
    loop {
        let buffer = match reader.fill_buf() {
            Ok(buffer) => buffer,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        if buffer.is_empty() {
            break;
        }
        read_any = true;
        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let end = newline.unwrap_or(buffer.len());
        if dropped.is_none() {
            line.extend_from_slice(&buffer[..end]);
            if !checked && (newline.is_some() || line.len() >= LINE_PREFIX_BYTES) {
                checked = true;
                if skip(&line[..line.len().min(LINE_PREFIX_BYTES)]) {
                    dropped = Some(Row::Skipped);
                }
            }
            if line.len() > MAX_LINE_BYTES {
                dropped = Some(Row::TooLong);
            }
            if dropped.is_some() {
                line.clear();
            }
        }
        reader.consume(newline.map_or(end, |at| at + 1));
        if newline.is_some() {
            break;
        }
    }
    if !read_any {
        return Ok(Row::End);
    }
    if let Some(row) = dropped {
        return Ok(row);
    }
    if !checked && skip(line) {
        return Ok(Row::Skipped);
    }
    Ok(Row::Kept)
}

pub(crate) fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    find_bytes(haystack, needle).is_some()
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|window| window == needle)
}

/// The string that follows the first occurrence of `marker` (for example `"type":"`).
pub(crate) fn raw_string_after<'a>(raw: &'a [u8], marker: &[u8]) -> Option<&'a [u8]> {
    let start = find_bytes(raw, marker)? + marker.len();
    let length = raw[start..].iter().position(|byte| *byte == b'"')?;
    Some(&raw[start..start + length])
}

fn stable_id(tool: &str, key: &str) -> String {
    format!("{:x}", Sha256::digest(format!("{tool}:{key}").as_bytes()))
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanStatus {
    pub tool_id: String,
    pub scanned_at: i64,
    pub source_count: usize,
    pub failed_count: usize,
    pub incomplete: bool,
    pub detail: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySession {
    pub id: String,
    pub tool_id: String,
    pub native_id: Option<String>,
    pub title: String,
    pub cwd: Option<String>,
    pub model: Option<String>,
    pub project_id: Option<String>,
    pub started_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub favorite: bool,
    pub partial: bool,
    pub stale: bool,
    pub message_count: usize,
    pub usage_count: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryDetail {
    pub session: HistorySession,
    pub messages: Vec<HistoryMessage>,
    pub usage: Vec<UsageEvent>,
    pub resume_reason: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryFilter {
    pub tool_id: Option<String>,
    pub model: Option<String>,
    pub project_id: Option<String>,
    pub search: Option<String>,
    pub from_ms: Option<i64>,
    pub to_ms: Option<i64>,
    pub favorite_only: bool,
    pub tools: Option<Vec<String>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPrice {
    pub tool_id: String,
    pub model: String,
    pub currency: String,
    pub input_per_million: f64,
    pub output_per_million: f64,
    pub cache_read_per_million: f64,
    pub cache_write_per_million: f64,
    pub source: String,
    pub updated_at: i64,
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// Projects are matched to session directories once per scan instead of once per row.
fn project_paths(conn: &Connection) -> Result<HashMap<String, String>, String> {
    let mut statement = conn
        .prepare("SELECT id, path FROM projects WHERE path IS NOT NULL")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|error| error.to_string())?;
    let mut paths = HashMap::new();
    for row in rows {
        let (id, path) = row.map_err(|error| error.to_string())?;
        paths.entry(path.to_ascii_lowercase()).or_insert(id);
    }
    Ok(paths)
}

pub(crate) fn model_label(model: Option<String>) -> Option<String> {
    let model = model?;
    let label = crate::history::opencode::model_id(model.trim());
    (!label.is_empty()).then_some(label)
}

/// Claude Code writes `<synthetic>` on local command and placeholder rows. Those are not model calls.
fn billable_usage_model(model: Option<&str>) -> bool {
    model != Some("<synthetic>")
}

fn store_session(
    conn: &Connection,
    tool: &str,
    source: &HistorySource,
    parsed: &ParsedSession,
    projects: &HashMap<String, String>,
) -> Result<(), String> {
    let key = source.key();
    let id = stable_id(tool, &key);
    let project_id = parsed
        .cwd
        .as_deref()
        .and_then(|cwd| projects.get(&cwd.to_ascii_lowercase()).cloned());
    let session_model = model_label(parsed.model.clone());
    let messages = serde_json::to_string(&parsed.messages).map_err(|error| error.to_string())?;
    let usage = serde_json::to_string(&parsed.usage).map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT INTO history_sessions (id, tool, source_key, source_path, source_fingerprint, native_id, title, cwd, model, started_at, updated_at, messages_json, usage_json, message_count, usage_count, partial, stale, project_id)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,0,?17)
         ON CONFLICT(id) DO UPDATE SET source_fingerprint=excluded.source_fingerprint, native_id=excluded.native_id,
         title=excluded.title, cwd=excluded.cwd, model=excluded.model, started_at=excluded.started_at,
         updated_at=excluded.updated_at, messages_json=excluded.messages_json, usage_json=excluded.usage_json,
         message_count=excluded.message_count, usage_count=excluded.usage_count,
         partial=excluded.partial, stale=0, project_id=COALESCE(history_sessions.project_id, excluded.project_id)",
        params![id,tool,key,source.path.display().to_string(),source.fingerprint,parsed.native_id,parsed.title,
            parsed.cwd,session_model,parsed.started_at,parsed.updated_at,messages,usage,
            parsed.messages.len() as i64,parsed.usage.len() as i64,parsed.partial as i64,project_id])
        .map_err(|error| error.to_string())?;
    conn.execute("DELETE FROM history_usage WHERE session_id = ?1", [&id])
        .map_err(|error| error.to_string())?;
    let mut insert = conn
        .prepare_cached(
            "INSERT OR REPLACE INTO history_usage (session_id,event_id,tool,model,timestamp,input,output,cache_read,cache_write,input_includes_cache)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        )
        .map_err(|error| error.to_string())?;
    for event in &parsed.usage {
        let model = model_label(event.model.clone()).or_else(|| session_model.clone());
        if !billable_usage_model(model.as_deref()) {
            continue;
        }
        insert
            .execute(params![
                id,
                event.id,
                tool,
                model,
                event.timestamp,
                event.input.map(|value| value as i64),
                event.output.map(|value| value as i64),
                event.cache_read.map(|value| value as i64),
                event.cache_write.map(|value| value as i64),
                event.input_includes_cache as i64
            ])
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn cached_fingerprints(conn: &Connection, tool: &str) -> Result<HashMap<String, (String, bool)>, String> {
    let mut statement = conn
        .prepare("SELECT source_key, source_fingerprint, stale FROM history_sessions WHERE tool = ?1")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([tool], |row| {
            Ok((row.get::<_, String>(0)?, (row.get::<_, String>(1)?, row.get::<_, i64>(2)? != 0)))
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<HashMap<_, _>, _>>()
        .map_err(|error| error.to_string())
}

#[cfg(test)]
fn scan_adapter_sources(
    db: &Database,
    adapter: &dyn CliAdapter,
    discovered: Result<Vec<HistorySource>, String>,
) -> ScanStatus {
    scan_adapter_sources_controlled(db, adapter, discovered, &|| false)
}

const CANCELLED_DETAIL: &str = "扫描已取消，原索引已保留";
const WRITE_BATCH: usize = 64;

/// Sessions are parsed on worker threads and written by this thread in batched
/// transactions, so one slow file does not hold up the others and the database
/// is not committed once per session.
fn parse_and_store(
    db: &Database,
    adapter: &dyn CliAdapter,
    sources: &[HistorySource],
    projects: &HashMap<String, String>,
    cancelled: &(dyn Fn() -> bool + Sync),
    progress: &dyn Fn(usize),
) -> Result<Vec<(String, String)>, ()> {
    let mut failures = Vec::new();
    if sources.is_empty() {
        return Ok(failures);
    }
    let workers = std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(4)
        .clamp(1, 8)
        .min(sources.len());
    let next = AtomicUsize::new(0);
    let stop = AtomicBool::new(false);
    let halted = || stop.load(Ordering::Relaxed) || cancelled();
    let (sender, receiver) = std::sync::mpsc::sync_channel::<(usize, Result<ParsedSession, String>)>(workers * 2);
    std::thread::scope(|scope| {
        for _ in 0..workers {
            let sender = sender.clone();
            let (next, halted) = (&next, &halted);
            scope.spawn(move || loop {
                let index = next.fetch_add(1, Ordering::Relaxed);
                if index >= sources.len() || halted() {
                    break;
                }
                let parsed = adapter.parse_history_controlled(&sources[index], halted);
                if sender.send((index, parsed)).is_err() {
                    break;
                }
            });
        }
        drop(sender);
        let mut done = 0usize;
        let mut aborted = false;
        while let Ok(first) = receiver.recv() {
            let mut batch = vec![first];
            while batch.len() < WRITE_BATCH {
                match receiver.try_recv() {
                    Ok(item) => batch.push(item),
                    Err(_) => break,
                }
            }
            if cancelled() {
                aborted = true;
                break;
            }
            done += batch.len();
            let written = db.with_connection(|conn| {
                let mut transaction = conn.transaction().map_err(|error| error.to_string())?;
                let mut batch_failures = Vec::new();
                for (index, parsed) in &batch {
                    let source = &sources[*index];
                    let outcome = parsed.as_ref().map_err(String::clone).and_then(|parsed| {
                        let savepoint = transaction.savepoint().map_err(|error| error.to_string())?;
                        store_session(&savepoint, adapter.id(), source, parsed, projects)?;
                        savepoint.commit().map_err(|error| error.to_string())
                    });
                    if let Err(error) = outcome {
                        batch_failures.push((source.key(), error));
                    }
                }
                transaction.commit().map_err(|error| error.to_string())?;
                Ok(batch_failures)
            });
            match written {
                Ok(batch_failures) => failures.extend(batch_failures),
                Err(error) => failures.extend(batch.iter().map(|(index, _)| (sources[*index].key(), error.clone()))),
            }
            progress(done);
        }
        if aborted {
            stop.store(true, Ordering::Relaxed);
        }
        drop(receiver);
        if aborted { Err(()) } else { Ok(failures) }
    })
}

fn scan_adapter_sources_controlled(db: &Database, adapter: &dyn CliAdapter, discovered: Result<Vec<HistorySource>, String>, cancelled: &(impl Fn() -> bool + Sync)) -> ScanStatus {
    let mut report = ScanStatus {
        tool_id: adapter.id().into(),
        scanned_at: now_ms(),
        source_count: 0,
        failed_count: 0,
        incomplete: false,
        detail: String::new(),
    };
    let sources = match discovered {
        Ok(sources) => sources,
        Err(error) => {
            report.incomplete = true;
            report.failed_count = 1;
            report.detail = error;
            return report;
        }
    };
    report.source_count = sources.len();
    let (cached, projects) = match db.with_connection(|conn| Ok((cached_fingerprints(conn, adapter.id())?, project_paths(conn)?))) {
        Ok(value) => value,
        Err(error) => {
            report.incomplete = true;
            report.detail = error;
            return report;
        }
    };
    let seen: HashSet<String> = sources.iter().map(HistorySource::key).collect();
    let mut failures = Vec::new();
    let mut pending = Vec::new();
    for source in sources {
        if let Some(error) = source.fingerprint_error.as_ref() {
            failures.push((source.key(), format!("{}：{error}", source.path.display())));
            continue;
        }
        let unchanged = source.fingerprint != "0"
            && !source.fingerprint.is_empty()
            && cached.get(&source.key()).is_some_and(|(fingerprint, stale)| {
                !stale && history_fingerprints_match(fingerprint, &source.fingerprint)
            });
        if !unchanged {
            pending.push(source);
        }
    }
    let settled = report.source_count - pending.len();
    let total = report.source_count;
    set_scan_progress(true, adapter.id(), settled, total);
    let progress = |done: usize| set_scan_progress(true, adapter.id(), settled + done, total);
    let parsed = parse_and_store(db, adapter, &pending, &projects, cancelled, &progress);
    if cancelled() || parsed.is_err() {
        report.incomplete = true;
        report.detail = CANCELLED_DETAIL.into();
        return report;
    }
    failures.extend(parsed.unwrap_or_default().into_iter().filter(|(_, error)| error != EMPTY_SESSION));
    report.failed_count = failures.len();
    if let Some((_, error)) = failures.first() {
        report.incomplete = true;
        report.detail = error.clone();
    }
    if let Err(error) = db.with_connection(|conn| {
        let transaction = conn.transaction().map_err(|error| error.to_string())?;
        for (key, _) in &failures {
            transaction
                .execute("UPDATE history_sessions SET stale = 1 WHERE source_key = ?1", [key])
                .map_err(|error| error.to_string())?;
        }
        for key in cached.keys().filter(|key| !seen.contains(*key)) {
            check_cancelled(cancelled)?;
            transaction
                .execute("DELETE FROM history_sessions WHERE source_key = ?1", [key])
                .map_err(|error| error.to_string())?;
        }
        check_cancelled(cancelled)?;
        transaction.commit().map_err(|error| error.to_string())
    }) {
        report.incomplete = true;
        report.detail = error;
    }
    report
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress { pub running: bool, pub tool_id: String, pub completed_sources: usize, pub total_sources: usize }
static SCAN_PROGRESS: std::sync::OnceLock<std::sync::Mutex<ScanProgress>> = std::sync::OnceLock::new();
fn set_scan_progress(running: bool, tool: &str, completed: usize, total: usize) {
    if let Ok(mut value) = SCAN_PROGRESS.get_or_init(Default::default).lock() { *value = ScanProgress {running,tool_id:tool.into(),completed_sources:completed,total_sources:total}; }
}
pub fn scan_progress() -> ScanProgress { SCAN_PROGRESS.get_or_init(Default::default).lock().map(|value| value.clone()).unwrap_or_default() }
fn history_fingerprints_match(cached: &str, current: &str) -> bool {
    cached == current
}
pub fn refresh(db: &Database, registry: &Registry, home: &Path) -> Result<Vec<ScanStatus>, String> {
    refresh_controlled(db, registry, home, &CliId::ALL, &|| false)
}
pub fn refresh_controlled(db: &Database, registry: &Registry, home: &Path, managed: &[CliId], cancelled: &(impl Fn() -> bool + Sync)) -> Result<Vec<ScanStatus>, String> {
    struct Finish;
    impl Drop for Finish { fn drop(&mut self) { let state = scan_progress(); set_scan_progress(false, &state.tool_id, state.completed_sources, state.total_sources); } }
    let _finish = Finish;
    let mut reports = Vec::new();
    for descriptor in registry.descriptors() {
        let Some(adapter) = registry.get(descriptor.id) else {
            continue;
        };
        if !managed.iter().any(|tool| tool.stable_id() == descriptor.id) {
            continue;
        }
        if !adapter.history_supported() {
            continue;
        }
        if cancelled() { return Err("扫描已取消".into()); }
        set_scan_progress(true, adapter.id(), 0, 0);
        let report = scan_adapter_sources_controlled(db, adapter, adapter.history_sources_controlled(home, cancelled), cancelled);
        if cancelled() { return Err("扫描已取消".into()); }
        db.with_connection(|conn| conn.execute(
            "INSERT INTO history_scan_state (tool,scanned_at,source_count,failed_count,incomplete,detail) VALUES (?1,?2,?3,?4,?5,?6)
             ON CONFLICT(tool) DO UPDATE SET scanned_at=excluded.scanned_at, source_count=excluded.source_count,
             failed_count=excluded.failed_count, incomplete=excluded.incomplete, detail=excluded.detail",
            params![report.tool_id,report.scanned_at,report.source_count as i64,report.failed_count as i64,report.incomplete as i64,report.detail])
            .map(|_| ()).map_err(|error| error.to_string()))?;
        reports.push(report);
    }
    Ok(reports)
}

pub fn scans(db: &Database) -> Result<Vec<ScanStatus>, String> {
    db.with_connection(|conn| {
        let mut statement = conn.prepare("SELECT tool,scanned_at,source_count,failed_count,incomplete,detail FROM history_scan_state ORDER BY tool")
            .map_err(|error| error.to_string())?;
        let rows = statement.query_map([],|row| Ok(ScanStatus { tool_id:row.get(0)?, scanned_at:row.get(1)?, source_count:row.get::<_,i64>(2)? as usize,
            failed_count:row.get::<_,i64>(3)? as usize, incomplete:row.get::<_,i64>(4)?!=0, detail:row.get(5)? }))
            .map_err(|error| error.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|error| error.to_string())?;
        Ok(rows)
    })
}

fn row_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<HistorySession> {
    Ok(HistorySession {
        id: row.get(0)?,
        tool_id: row.get(1)?,
        native_id: row.get(2)?,
        title: row.get(3)?,
        cwd: row.get(4)?,
        model: row.get(5)?,
        project_id: row.get(6)?,
        started_at: row.get(7)?,
        updated_at: row.get(8)?,
        favorite: row.get::<_, i64>(9)? != 0,
        partial: row.get::<_, i64>(10)? != 0,
        stale: row.get::<_, i64>(11)? != 0,
        message_count: row.get::<_, i64>(12)? as usize,
        usage_count: row.get::<_, i64>(13)? as usize,
    })
}

pub fn list(db: &Database, filter: &HistoryFilter) -> Result<Vec<HistorySession>, String> {
    let search = filter
        .search
        .as_deref()
        .filter(|text| !text.trim().is_empty())
        .map(|text| {
            format!(
                "%{}%",
                text.trim()
                    .replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_")
            )
        });
    let model = filter.model.as_deref().filter(|model| !model.is_empty());
    let tools: Vec<&String> = filter.tools.as_ref().map(|list| list.iter().filter(|tool| !tool.is_empty()).collect()).unwrap_or_default();
    db.with_connection(|conn| {
        // A session belongs to a date range when it was last active there or when any
        // of its model calls happened there, so long sessions show up on every day used.
        let mut sql = String::from(
            "SELECT id,tool,native_id,title,cwd,model,project_id,started_at,updated_at,favorite,partial,stale,message_count,usage_count
             FROM history_sessions s WHERE (?1 IS NULL OR tool = ?1)
             AND (?2 IS NULL OR project_id = ?2 OR (?2 = '__unknown__' AND project_id IS NULL))
             AND (?3 IS NULL OR title LIKE ?3 ESCAPE '\\' OR messages_json LIKE ?3 ESCAPE '\\')
             AND ((?4 IS NULL AND ?5 IS NULL)
               OR ((?4 IS NULL OR updated_at >= ?4) AND (?5 IS NULL OR updated_at < ?5))
               OR EXISTS (SELECT 1 FROM history_usage u WHERE u.session_id = s.id
                 AND (?4 IS NULL OR u.timestamp >= ?4) AND (?5 IS NULL OR u.timestamp < ?5)))
             AND (?6 = 0 OR favorite = 1)
             AND (?7 IS NULL
               OR (?7 = '__unknown__' AND (model IS NULL OR EXISTS (SELECT 1 FROM history_usage u WHERE u.session_id = s.id AND u.model IS NULL)))
               OR model = ?7
               OR EXISTS (SELECT 1 FROM history_usage u WHERE u.session_id = s.id AND u.model = ?7))");
        if !tools.is_empty() {
            let placeholders = (0..tools.len()).map(|index| format!("?{}", index + 8)).collect::<Vec<_>>().join(",");
            sql.push_str(&format!(" AND tool IN ({placeholders})"));
        }
        sql.push_str(" ORDER BY favorite DESC, updated_at DESC, id");
        let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
        let mut values: Vec<&dyn rusqlite::ToSql> = vec![&filter.tool_id, &filter.project_id, &search, &filter.from_ms, &filter.to_ms, &filter.favorite_only, &model];
        for tool in &tools { values.push(*tool); }
        let rows = statement
            .query_map(rusqlite::params_from_iter(values), row_session)
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
    })
}

pub fn detail(db: &Database, id: &str) -> Result<HistoryDetail, String> {
    let session = db.with_connection(|conn| conn.query_row(
        "SELECT id,tool,native_id,title,cwd,model,project_id,started_at,updated_at,favorite,partial,stale,message_count,usage_count,messages_json,usage_json
         FROM history_sessions WHERE id = ?1",[id], |row| Ok((row_session(row)?,row.get::<_,String>(14)?,row.get::<_,String>(15)?)))
         .optional().map_err(|error| error.to_string()))?.ok_or("会话已从本机索引移除")?;
    let messages = serde_json::from_str(&session.1).map_err(|_| "会话正文缓存损坏")?;
    let usage = serde_json::from_str(&session.2).map_err(|_| "会话用量缓存损坏")?;
    let linked_path = session
        .0
        .project_id
        .as_deref()
        .map(|project_id| {
            db.with_connection(|conn| {
                conn.query_row(
                    "SELECT path FROM projects WHERE id = ?1",
                    [project_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()
                .map_err(|error| error.to_string())
            })
        })
        .transpose()?
        .flatten()
        .flatten();
    let resume_path = session.0.cwd.as_deref().or(linked_path.as_deref());
    let reason = if session.0.native_id.is_none() {
        Some("原始记录没有可验证的恢复 ID".into())
    } else if resume_path.is_none_or(|cwd| !Path::new(cwd).is_dir()) {
        Some("原项目目录不存在，请先关联有效目录".into())
    } else if session.0.stale {
        Some("会话源最近读取失败，请修复后刷新索引".into())
    } else {
        None
    };
    Ok(HistoryDetail {
        session: session.0,
        messages,
        usage,
        resume_reason: reason,
    })
}

pub fn set_favorite(db: &Database, id: &str, favorite: bool) -> Result<(), String> {
    db.with_connection(|conn| {
        if conn
            .execute(
                "UPDATE history_sessions SET favorite = ?2 WHERE id = ?1",
                params![id, favorite as i64],
            )
            .map_err(|error| error.to_string())?
            == 0
        {
            return Err("会话不存在".into());
        }
        Ok(())
    })
}

pub fn set_project(db: &Database, id: &str, project_id: Option<&str>) -> Result<(), String> {
    if let Some(project_id) = project_id {
        let exists: bool = db.with_connection(|conn| {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
                [project_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })?;
        if !exists {
            return Err("所选项目不存在".into());
        }
    }
    db.with_connection(|conn| {
        if conn
            .execute(
                "UPDATE history_sessions SET project_id = ?2 WHERE id = ?1",
                params![id, project_id],
            )
            .map_err(|error| error.to_string())?
            == 0
        {
            return Err("会话不存在".into());
        }
        Ok(())
    })
}

pub fn prices(db: &Database) -> Result<Vec<HistoryPrice>, String> {
    db.with_connection(|conn| {
        let mut statement = conn.prepare("SELECT tool,model,currency,input_per_million,output_per_million,cache_read_per_million,cache_write_per_million,source,updated_at FROM history_prices ORDER BY tool,model")
            .map_err(|error| error.to_string())?;
        let rows = statement.query_map([],|row| Ok(HistoryPrice {tool_id:row.get(0)?,model:row.get(1)?,currency:row.get(2)?,
            input_per_million:row.get(3)?,output_per_million:row.get(4)?,cache_read_per_million:row.get(5)?,
            cache_write_per_million:row.get(6)?,source:row.get(7)?,updated_at:row.get(8)?}))
            .map_err(|error| error.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|error| error.to_string())?;
        Ok(rows)
    })
}

pub fn save_price(
    db: &Database,
    registry: &Registry,
    mut price: HistoryPrice,
) -> Result<HistoryPrice, String> {
    if registry.get(&price.tool_id).is_none()
        || price.model.trim().is_empty()
        || price.model.len() > 200
        || price.source.trim().is_empty()
        || price.source.len() > 500
        || price.currency.len() != 3
        || !price
            .currency
            .chars()
            .all(|value| value.is_ascii_uppercase())
        || [
            price.input_per_million,
            price.output_per_million,
            price.cache_read_per_million,
            price.cache_write_per_million,
        ]
        .iter()
        .any(|value| !value.is_finite() || *value < 0.0 || *value > 1_000_000.0)
    {
        return Err("价格、币种或来源无效".into());
    }
    price.updated_at = now_ms();
    db.with_connection(|conn| conn.execute(
        "INSERT INTO history_prices (tool,model,currency,input_per_million,output_per_million,cache_read_per_million,cache_write_per_million,source,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(tool,model) DO UPDATE SET currency=excluded.currency,
         input_per_million=excluded.input_per_million,output_per_million=excluded.output_per_million,
         cache_read_per_million=excluded.cache_read_per_million,cache_write_per_million=excluded.cache_write_per_million,
         source=excluded.source,updated_at=excluded.updated_at",
        params![price.tool_id,price.model,price.currency,price.input_per_million,price.output_per_million,
            price.cache_read_per_million,price.cache_write_per_million,price.source,price.updated_at])
        .map(|_| ()).map_err(|error| error.to_string()))?;
    Ok(price)
}

/// Short-context public rates, per million tokens: input, cached input, cache write, output.
/// Requests above 272K input tokens use 2x input-side rates and 1.5x output.
pub(crate) fn published_rate(tool_id: &str, model: &str) -> Option<HistoryPrice> {
    let (input, cached, write, output, source) = match model {
        "gpt-6-astra" => (10.0, 1.0, 12.5, 50.0, "OpenAI 公开价"),
        "gpt-6.1-sol" => (2.0, 0.10, 2.5, 10.0, "OpenAI 公开价"),
        "gpt-6-luna" => (0.10, 0.01, 0.125, 0.50, "OpenAI 公开价"),
        "gpt-5.6-sol" => (4.0, 0.40, 5.0, 20.0, "OpenAI 公开价"),
        "gpt-5.6-cyber" => (12.5, 1.25, 15.625, 75.0, "OpenAI 公开价"),
        "big-pickle" => (0.0, 0.0, 0.0, 0.0, "OpenCode 公开价"),
        _ => return None,
    };
    Some(HistoryPrice {
        tool_id: tool_id.to_owned(),
        model: model.to_owned(),
        currency: "USD".into(),
        input_per_million: input,
        output_per_million: output,
        cache_read_per_million: cached,
        cache_write_per_million: write,
        source: source.into(),
        updated_at: 0,
    })
}

pub fn native_session_directory(db: &Database, tool: &str, native_id: &str) -> Result<Option<PathBuf>, String> {
    let id: Option<String> = db.with_connection(|conn| conn.query_row(
        "SELECT id FROM history_sessions WHERE tool = ?1 AND native_id = ?2 ORDER BY updated_at DESC LIMIT 1",
        params![tool, native_id], |row| row.get(0),
    ).optional().map_err(|error| error.to_string()))?;
    let Some(id) = id else { return Ok(None); };
    let detail = detail(db, &id)?;
    if let Some(reason) = detail.resume_reason { return Err(reason); }
    if let Some(cwd) = detail.session.cwd { return Ok(Some(PathBuf::from(cwd))); }
    let project_id = detail.session.project_id.ok_or("原会话没有工作目录")?;
    let project = crate::projects::get(db, &project_id)?;
    project.path.map(PathBuf::from).map(Some).ok_or_else(|| "原会话没有工作目录".into())
}

pub fn resume_plan(
    db: &Database,
    registry: &Registry,
    home: &Path,
    id: &str,
    mode: crate::native::adapters::LaunchMode,
) -> Result<crate::launch::LaunchPlan, String> {
    let detail = detail(db, id)?;
    if let Some(reason) = detail.resume_reason {
        return Err(reason);
    }
    let native_id = detail
        .session
        .native_id
        .ok_or("原始记录没有可验证的恢复 ID")?;
    if detail.session.cwd.is_none() && detail.session.project_id.is_none() {
        return Err("原会话没有项目目录".into());
    }
    let cwd = native_session_directory(db, &detail.session.tool_id, &native_id)?.ok_or("原会话没有工作目录")?;
    crate::launch::plan_history(
        db,
        registry,
        home,
        crate::launch::LaunchRequest {
            tool_id: detail.session.tool_id,
            project_id: detail.session.project_id,
            session_id: Some(native_id),
            directory: None,
            initial_prompt: None,
            mode,
        },
        &cwd,
    )
    .map_err(|error| error.message)
}

pub fn copy_resume_command(
    db: &Database,
    registry: &Registry,
    home: &Path,
    id: &str,
    mode: crate::native::adapters::LaunchMode,
) -> Result<String, String> {
    crate::launch::native_command(&resume_plan(db, registry, home, id, mode)?)
}

pub fn export(db: &Database, id: &str, format: &str, destination: &Path) -> Result<String, String> {
    if !matches!(format, "markdown" | "json") {
        return Err("请选择 Markdown 或 JSON 格式".into());
    }
    if destination.file_name().is_none() || destination.is_dir() {
        return Err("请选择导出文件".into());
    }
    // A new file is required even when the chosen destination is an unindexed native source.
    // create_new also closes the check-then-write race and refuses symlinks and hard links.
    let target = destination
        .parent()
        .ok_or("请选择导出目录")?
        .canonicalize()
        .map_err(|error| format!("导出目录不可用：{error}"))?
        .join(destination.file_name().ok_or("请选择导出文件")?);
    let native_directories: Vec<String> = db.with_connection(|conn| {
        let mut statement = conn
            .prepare("SELECT DISTINCT source_path FROM history_sessions")
            .map_err(|error| error.to_string())?;
        let paths = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        Ok(paths)
    })?;
    if native_directories.iter().any(|path| {
        let source = Path::new(path)
            .canonicalize()
            .unwrap_or_else(|_| PathBuf::from(path));
        source.is_dir() && target.starts_with(source)
    }) {
        return Err("不能导出到原生会话目录".into());
    }
    let detail = detail(db, id)?;
    let contents = if format == "json" {
        serde_json::to_string_pretty(&detail).map_err(|error| error.to_string())?
    } else {
        let mut text = format!(
            "# {}\n\n工具：{}\n\n原生会话 ID：{}\n\n项目目录：{}\n\n",
            detail.session.title,
            detail.session.tool_id,
            detail.session.native_id.as_deref().unwrap_or("未知"),
            detail.session.cwd.as_deref().unwrap_or("未知")
        );
        if detail.session.partial || detail.session.stale {
            text.push_str("> 本地记录不完整或最近读取失败，以下内容仅为已索引部分。\n\n");
        }
        for message in detail.messages {
            text.push_str(&format!("## {}\n\n{}\n\n", message.role, message.text));
        }
        text
    };
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|error| format!("导出只能创建新文件，不能覆盖现有文件：{error}"))?;
    file.write_all(contents.as_bytes())
        .map_err(|error| format!("无法导出会话：{error}"))?;
    Ok(destination.display().to_string())
}

#[cfg(test)]
#[path = "../../../tests/history/history.rs"]
mod tests;
