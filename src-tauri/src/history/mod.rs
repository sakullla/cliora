use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use chrono::{DateTime, Utc};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::database::Database;
use crate::native::adapters::{CliAdapter, Registry};

pub mod claude;
pub mod codex;
pub mod grok;
pub mod opencode;
pub mod pi;

const MAX_SOURCE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_SOURCES: usize = 5_000;
const MAX_MESSAGES: usize = 2_000;
const MAX_MESSAGE_CHARS: usize = 16_000;

#[derive(Clone, Debug)]
pub struct HistorySource {
    pub path: PathBuf,
    pub native_id: Option<String>,
    pub fingerprint: String,
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
            return Err("未识别到可展示的会话记录".into());
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
    Ok(format!("{}:{modified}", metadata.len()))
}

pub fn discover_jsonl(
    root: &Path,
    accept: impl Fn(&Path) -> bool,
) -> Result<Vec<HistorySource>, String> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    if !root.is_dir() || root.is_symlink() {
        return Err("会话根目录不可读取".into());
    }
    let mut pending = vec![(root.to_path_buf(), 0usize)];
    let mut sources = Vec::new();
    while let Some((directory, depth)) = pending.pop() {
        for entry in fs::read_dir(&directory).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let file_type = entry.file_type().map_err(|error| error.to_string())?;
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            if file_type.is_dir() && depth < 5 {
                pending.push((path, depth + 1));
            } else if file_type.is_file() && accept(&path) {
                sources.push(HistorySource {
                    fingerprint: source_fingerprint(&path)?,
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
    mut consume: impl FnMut(usize, Value),
) -> Result<bool, String> {
    let size = fs::metadata(&source.path)
        .map_err(|error| error.to_string())?
        .len();
    if size > MAX_SOURCE_BYTES {
        return Err("会话文件超过 16 MiB，未读取".into());
    }
    let file = fs::File::open(&source.path).map_err(|error| error.to_string())?;
    let mut partial = false;
    for (index, line) in BufReader::new(file).lines().enumerate() {
        if index > 30_000 {
            partial = true;
            break;
        }
        let line = line.map_err(|error| error.to_string())?;
        if line.len() > 1_000_000 {
            partial = true;
            continue;
        }
        match serde_json::from_str::<Value>(&line) {
            Ok(value) => consume(index, value),
            Err(_) => partial = true,
        }
    }
    Ok(partial)
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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub session_count: usize,
    pub usage_sessions: usize,
    pub unknown_usage_sessions: usize,
    pub partial_sessions: usize,
    pub stale_sessions: usize,
    pub input: Option<u64>,
    pub output: Option<u64>,
    pub cache_read: Option<u64>,
    pub cache_write: Option<u64>,
    pub input_includes_cache: Option<bool>,
    pub estimated_cost: Option<f64>,
    pub currency: Option<String>,
    pub price_sources: Vec<String>,
    pub scans: Vec<ScanStatus>,
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn project_for_path(db: &Database, cwd: Option<&str>) -> Result<Option<String>, String> {
    let Some(cwd) = cwd else {
        return Ok(None);
    };
    db.with_connection(|conn| {
        conn.query_row(
            "SELECT id FROM projects WHERE path = ?1 COLLATE NOCASE",
            [cwd],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())
    })
}

fn store_session(
    db: &Database,
    adapter: &dyn CliAdapter,
    source: &HistorySource,
    parsed: &ParsedSession,
) -> Result<(), String> {
    let key = source.key();
    let id = stable_id(adapter.id(), &key);
    let project_id = project_for_path(db, parsed.cwd.as_deref())?;
    let messages = serde_json::to_string(&parsed.messages).map_err(|error| error.to_string())?;
    let usage = serde_json::to_string(&parsed.usage).map_err(|error| error.to_string())?;
    db.with_connection(|conn| conn.execute(
        "INSERT INTO history_sessions (id, tool, source_key, source_path, source_fingerprint, native_id, title, cwd, model, started_at, updated_at, messages_json, usage_json, message_count, usage_count, partial, stale, project_id)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,0,?17)
         ON CONFLICT(id) DO UPDATE SET source_fingerprint=excluded.source_fingerprint, native_id=excluded.native_id,
         title=excluded.title, cwd=excluded.cwd, model=excluded.model, started_at=excluded.started_at,
         updated_at=excluded.updated_at, messages_json=excluded.messages_json, usage_json=excluded.usage_json,
         message_count=excluded.message_count, usage_count=excluded.usage_count,
         partial=excluded.partial, stale=0, project_id=COALESCE(history_sessions.project_id, excluded.project_id)",
        params![id,adapter.id(),key,source.path.display().to_string(),source.fingerprint,parsed.native_id,parsed.title,
            parsed.cwd,parsed.model,parsed.started_at,parsed.updated_at,messages,usage,
            parsed.messages.len() as i64,parsed.usage.len() as i64,parsed.partial as i64,project_id])
        .map(|_| ()).map_err(|error| error.to_string()))
}

fn existing_fingerprint(db: &Database, key: &str) -> Result<Option<(String, bool)>, String> {
    db.with_connection(|conn| {
        conn.query_row(
            "SELECT source_fingerprint, stale FROM history_sessions WHERE source_key = ?1",
            [key],
            |row| Ok((row.get(0)?, row.get::<_, i64>(1)? != 0)),
        )
        .optional()
        .map_err(|error| error.to_string())
    })
}

fn scan_adapter(db: &Database, adapter: &dyn CliAdapter, home: &Path) -> ScanStatus {
    let mut report = ScanStatus {
        tool_id: adapter.id().into(),
        scanned_at: now_ms(),
        source_count: 0,
        failed_count: 0,
        incomplete: false,
        detail: String::new(),
    };
    let sources = match adapter.history_sources(home) {
        Ok(sources) => sources,
        Err(error) => {
            report.incomplete = true;
            report.failed_count = 1;
            report.detail = error;
            return report;
        }
    };
    report.source_count = sources.len();
    let mut seen = HashSet::new();
    for source in sources {
        let key = source.key();
        seen.insert(key.clone());
        let cached = existing_fingerprint(db, &key).ok().flatten();
        if source.native_id.is_none()
            && cached
                .as_ref()
                .is_some_and(|(fingerprint, stale)| fingerprint == &source.fingerprint && !stale)
        {
            continue;
        }
        match adapter
            .parse_history(&source)
            .and_then(|parsed| store_session(db, adapter, &source, &parsed))
        {
            Ok(()) => {}
            Err(error) => {
                report.failed_count += 1;
                if report.detail.is_empty() {
                    report.detail = error;
                }
                let _ = db.with_connection(|conn| {
                    conn.execute(
                        "UPDATE history_sessions SET stale = 1 WHERE source_key = ?1",
                        [&key],
                    )
                    .map(|_| ())
                    .map_err(|error| error.to_string())
                });
            }
        }
    }
    if let Err(error) = db.with_connection(|conn| {
        let mut statement = conn
            .prepare("SELECT source_key FROM history_sessions WHERE tool = ?1")
            .map_err(|error| error.to_string())?;
        let keys = statement
            .query_map([adapter.id()], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        for key in keys {
            if !seen.contains(&key) {
                conn.execute("DELETE FROM history_sessions WHERE source_key = ?1", [key])
                    .map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    }) {
        report.incomplete = true;
        report.detail = error;
    }
    report
}

pub fn refresh(db: &Database, registry: &Registry, home: &Path) -> Result<Vec<ScanStatus>, String> {
    let mut reports = Vec::new();
    for descriptor in registry.descriptors() {
        let Some(adapter) = registry.get(descriptor.id) else {
            continue;
        };
        if !adapter.history_supported() {
            continue;
        }
        let report = scan_adapter(db, adapter, home);
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

fn query_sessions(
    db: &Database,
    filter: &HistoryFilter,
    date_on_session: bool,
) -> Result<Vec<(HistorySession, Vec<UsageEvent>)>, String> {
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
    let (from, to) = if date_on_session {
        (filter.from_ms, filter.to_ms)
    } else {
        (None, None)
    };
    db.with_connection(|conn| {
        let mut statement = conn.prepare(
            "SELECT id,tool,native_id,title,cwd,model,project_id,started_at,updated_at,favorite,partial,stale,message_count,usage_count,usage_json
             FROM history_sessions WHERE (?1 IS NULL OR tool = ?1)
             AND (?2 IS NULL OR project_id = ?2 OR (?2 = '__unknown__' AND project_id IS NULL))
             AND (?3 IS NULL OR title LIKE ?3 ESCAPE '\\' OR messages_json LIKE ?3 ESCAPE '\\')
             AND (?4 IS NULL OR updated_at >= ?4) AND (?5 IS NULL OR updated_at < ?5)
             AND (?6 = 0 OR favorite = 1) ORDER BY favorite DESC, updated_at DESC, id")
            .map_err(|error| error.to_string())?;
        let rows = statement.query_map(params![filter.tool_id,filter.project_id,search,from,to,filter.favorite_only as i64], |row| {
            Ok((row_session(row)?,row.get::<_,String>(14)?))
        }).map_err(|error| error.to_string())?;
        let mut result = Vec::new();
        for row in rows {
            let (session,text) = row.map_err(|error| error.to_string())?;
            let usage: Vec<UsageEvent> = serde_json::from_str(&text).map_err(|_| "会话用量缓存损坏")?;
            if filter.model.as_deref().is_some_and(|model| session.model.as_deref() != Some(model)
                && !usage.iter().any(|event| event.model.as_deref() == Some(model))) { continue; }
            result.push((session,usage));
        }
        Ok(result)
    })
}

pub fn list(db: &Database, filter: &HistoryFilter) -> Result<Vec<HistorySession>, String> {
    Ok(query_sessions(db, filter, true)?
        .into_iter()
        .map(|(session, _)| session)
        .collect())
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
    let resume_path = if session.0.project_id.is_some() {
        linked_path.as_deref()
    } else {
        session.0.cwd.as_deref()
    };
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

fn sum_known(current: &mut Option<u64>, value: Option<u64>) {
    *current = current.and_then(|old| value.and_then(|value| old.checked_add(value)));
}

pub fn usage_summary(db: &Database, filter: &HistoryFilter) -> Result<UsageSummary, String> {
    let rows = query_sessions(db, filter, false)?;
    let price_map: BTreeMap<(String, String), HistoryPrice> = prices(db)?
        .into_iter()
        .map(|price| ((price.tool_id.clone(), price.model.clone()), price))
        .collect();
    let mut result = UsageSummary {
        session_count: 0,
        usage_sessions: 0,
        unknown_usage_sessions: 0,
        partial_sessions: 0,
        stale_sessions: 0,
        input: Some(0),
        output: Some(0),
        cache_read: Some(0),
        cache_write: Some(0),
        input_includes_cache: None,
        estimated_cost: Some(0.0),
        currency: None,
        price_sources: Vec::new(),
        scans: scans(db)?,
    };
    let mut seen_events = HashSet::new();
    let mut semantics: Option<bool> = None;
    let mut mixed_semantics = false;
    for (session, events) in rows {
        let in_range = |time: Option<i64>| {
            time.is_some_and(|time| {
                filter.from_ms.is_none_or(|from| time >= from)
                    && filter.to_ms.is_none_or(|to| time < to)
            })
        };
        let selected: Vec<_> = events
            .iter()
            .filter(|event| {
                filter
                    .model
                    .as_deref()
                    .is_none_or(|model| event.model.as_deref() == Some(model))
                    && ((filter.from_ms.is_none() && filter.to_ms.is_none())
                        || in_range(event.timestamp))
            })
            .collect();
        if filter.from_ms.is_some() || filter.to_ms.is_some() {
            if selected.is_empty() && !in_range(session.updated_at) {
                continue;
            }
        }
        result.session_count += 1;
        if session.partial {
            result.partial_sessions += 1;
        }
        if session.stale {
            result.stale_sessions += 1;
        }
        if selected.is_empty() {
            result.unknown_usage_sessions += 1;
            continue;
        }
        result.usage_sessions += 1;
        for event in selected {
            if !seen_events.insert((session.tool_id.clone(), event.id.clone())) {
                continue;
            }
            sum_known(&mut result.input, event.input);
            sum_known(&mut result.output, event.output);
            sum_known(&mut result.cache_read, event.cache_read);
            sum_known(&mut result.cache_write, event.cache_write);
            if semantics.is_some_and(|same| same != event.input_includes_cache) {
                mixed_semantics = true;
            }
            semantics.get_or_insert(event.input_includes_cache);
            let price = event
                .model
                .as_ref()
                .and_then(|model| price_map.get(&(session.tool_id.clone(), model.clone())));
            let Some(price) = price else {
                result.estimated_cost = None;
                continue;
            };
            if result
                .currency
                .as_deref()
                .is_some_and(|currency| currency != price.currency)
            {
                result.estimated_cost = None;
                result.currency = None;
                continue;
            }
            result.currency = Some(price.currency.clone());
            let Some((input, output, read, write)) = event
                .input
                .zip(event.output)
                .zip(event.cache_read)
                .zip(event.cache_write)
                .map(|(((a, b), c), d)| (a, b, c, d))
            else {
                result.estimated_cost = None;
                continue;
            };
            let Some(uncached) = (if event.input_includes_cache {
                input
                    .checked_sub(read)
                    .and_then(|value| value.checked_sub(write))
            } else {
                Some(input)
            }) else {
                result.estimated_cost = None;
                continue;
            };
            if let Some(cost) = &mut result.estimated_cost {
                *cost += (uncached as f64 * price.input_per_million
                    + output as f64 * price.output_per_million
                    + read as f64 * price.cache_read_per_million
                    + write as f64 * price.cache_write_per_million)
                    / 1_000_000.0;
            }
            let updated = DateTime::<Utc>::from_timestamp_millis(price.updated_at)
                .map(|time| time.to_rfc3339())
                .unwrap_or_else(|| "更新时间未知".into());
            let label = format!(
                "{} / {} · {} · {}",
                price.tool_id, price.model, price.source, updated
            );
            if !result.price_sources.contains(&label) {
                result.price_sources.push(label);
            }
        }
    }
    result.input_includes_cache = if mixed_semantics { None } else { semantics };
    if result.usage_sessions == 0 || result.unknown_usage_sessions > 0 {
        result.estimated_cost = None;
    }
    Ok(result)
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
    let cwd = detail.session.cwd.as_deref().map(Path::new).unwrap_or(home);
    crate::launch::plan_history(
        db,
        registry,
        home,
        crate::launch::LaunchRequest {
            tool_id: detail.session.tool_id,
            project_id: detail.session.project_id,
            session_id: Some(native_id),
            mode,
        },
        cwd,
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
    let source_path: String = db.with_connection(|conn| {
        conn.query_row(
            "SELECT source_path FROM history_sessions WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
    })?;
    let source = Path::new(&source_path);
    let source = source
        .canonicalize()
        .unwrap_or_else(|_| source.to_path_buf());
    let target = if let Ok(metadata) = fs::symlink_metadata(destination) {
        if metadata.file_type().is_symlink() {
            return Err("不能导出到符号链接".into());
        }
        destination
            .canonicalize()
            .map_err(|error| error.to_string())?
    } else {
        let parent = destination
            .parent()
            .ok_or("请选择导出目录")?
            .canonicalize()
            .map_err(|error| format!("导出目录不可用：{error}"))?;
        parent.join(destination.file_name().ok_or("请选择导出文件")?)
    };
    if target == source || (source.is_dir() && target.starts_with(&source)) {
        return Err("不能覆盖原生会话源".into());
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
    fs::write(destination, contents).map_err(|error| format!("无法导出会话：{error}"))?;
    Ok(destination.display().to_string())
}

#[cfg(test)]
#[path = "../../../tests/history/history.rs"]
mod tests;
