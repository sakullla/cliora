//! Antigravity session sources: `conversation_summaries.db` index,
//! `brain/<id>/transcript_full.jsonl` transcripts and per-conversation
//! `conversations/<id>.db` usage rows, read from two native layouts.
//!
//! [RE] evidence: third-party reverse engineering (codeburn against `agy`
//! 1.2.x; the local machine runs 1.3.1 but has never produced data, so every
//! legacy fixture is hand-built from the documented schema — 02 ADR-2
//! evidence policy) plus the 1.5.9 layout captured on the authorized remote
//! (`docs/verification/remote-workflow/agy-1.5.9/`, fixture
//! `tests/fixtures/history/antigravity-cli-1.5.9/sessions.json`).
//!
//! Data roots, both read-only and deduplicated by native conversation id
//! (the 1.5.9 root is scanned first, so an id stored in both roots keeps its
//! live copy and each source stays attributed to its own root's index):
//!
//! * legacy `~/.gemini/antigravity/` — `conversation_summaries` rows
//!   (`id`, `title`, `workspace`, `status`, `parent_conversation_id`).
//! * 1.5.9 `~/.gemini/antigravity-cli/` (the CLI settings directory after
//!   the native migration; the legacy root then stays empty with a
//!   `~/.gemini/config/.migrated` marker) — the index renames `id` to
//!   `conversation_id` and `workspace` to `workspace_uris` (a JSON array of
//!   paths), stamps `CASCADE_RUN_STATUS_*` statuses, adds columns
//!   (`preview`, `step_count`, `agent_name`, `nesting_depth`, …) and a
//!   `conversation_parents(conversation_id, parent_id)` table next to FTS5
//!   search tables; per-conversation databases add executor/trajectory
//!   tables beside `gen_metadata`.
//!
//! Sessions: a direct parent link (`parent_conversation_id`, plus the 1.5.9
//! `conversation_parents` table) attaches the child to that parent; it is
//! never an independent session. The child transcript is readable on its
//! own. A missing, unreadable, or failed usage database omits that child's
//! usage and leaves an already read transcript in place. A missing,
//! symlinked, or unreadable transcript keeps the node unreadable with an
//! empty body. The parent remains either way. Deeper descendants are not
//! merged.
//!
//! * `brain/<conversation-id>/.system_generated/logs/transcript_full.jsonl`
//!   — one JSON object per line: `{step_index, source, type, status,
//!   created_at, content, thinking?}`. Legacy rows type ∈ `USER_INPUT` /
//!   `PLANNER_RESPONSE` / `AGENT_RESPONSE`; 1.5.9 rows type ∈ `USER_INPUT` /
//!   `PLANNER_RESPONSE` / `GENERIC` / `SYSTEM_MESSAGE` / `ERROR_MESSAGE` /
//!   `CHECKPOINT`. Only the documented user/planner rows of each layout map
//!   to the timeline; the 1.5.9-only types have no verified timeline
//!   meaning and stay out rather than being guessed in. `thinking` stays
//!   out on both layouts.
//! * `conversations/<id>.db` — SQLite with a `gen_metadata` table of
//!   protobuf blobs (see [`protobuf`]): field 1 `ChatModel` → field 4
//!   `ModelUsageStats` (`exa.codeium_common_pb`: 2 input_tokens UNCACHED,
//!   3 output_tokens = 9 + 10, 4 cache_write_tokens, 5 cache_read_tokens,
//!   9 thinking_output_tokens, 10 response_output_tokens, 11 response_id),
//!   ChatModel 19 model config id, 21 display name, 9 → 4 timestamp; row
//!   field 4 generation uuid. Field 2 (stepIndices) is a bare varint in the
//!   legacy [RE] shape and length-delimited (packed/repeated) in every
//!   sampled 1.5.9 row; the value is unused, but the wire shape proves the
//!   row matches its layout. 1.5.9 also stamps a new unknown top-level
//!   field 8 (~0.3 KB submessage), skipped as an ordinary unknown field.
//! * 1.5.9 transcripts carry a second, transcript-side usage source:
//!   `PLANNER_RESPONSE` rows hold `input_tokens`, `output_tokens`,
//!   `cache_read_tokens` and `model`. Those counters substitute for
//!   `gen_metadata` only when the conversation's usage database is missing,
//!   so one call is never counted from both sources; a present-but-drifted
//!   database degrades partial instead of being silently replaced.
//!
//! Usage semantics: stored `input_tokens` EXCLUDES cache read/write →
//! `input_includes_cache` is false on every event; stored `output_tokens`
//! already includes thinking output (field 3 = field 9 + field 10,
//! verified per row and treated as drift when it disagrees); duplicates are
//! dropped by `response_id`. Transcript-side events mirror the captured
//! counter semantics (the sanitized fixture records the same call with the
//! same three counters in both sources); they carry no cache-write field,
//! so that bucket stays unknown instead of zero. Strict degradation per the
//! [RE] policy: any structural mismatch (missing stats/response_id,
//! unexpected wire type, truncated blob, malformed transcript line, missing
//! own conversation database) skips that row and marks the session partial.
//! A direct child's missing usage database omits only that child's events.
//! Fields are never guessed.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde_json::Value;

use super::protobuf::{Mismatch, Reader};
use crate::history::{
    check_cancelled, text_content, timestamp as parse_timestamp, valid_native_id, AgentKind,
    ChildSession, HistorySource, ParsedSession, UsageAttribution, UsageEvent, MAX_SOURCES,
};

const MAX_TRANSCRIPT_LINES: usize = 4_000;

/// Which native layout an index (and its rows) follows. Detected from the
/// index columns, never from a version probe: `conversation_summaries` uses
/// `id`/`workspace` through 1.3.x and `conversation_id`/`workspace_uris`
/// since 1.5.9.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Layout {
    /// Legacy `~/.gemini/antigravity/` ([RE] agy 1.2.x schema).
    Legacy,
    /// 1.5.9 `~/.gemini/antigravity-cli/` (remote-evidenced schema).
    Cli,
}

pub fn sources(home: &Path) -> Result<Vec<HistorySource>, String> {
    sources_controlled(home, &|| false)
}

pub fn sources_controlled(
    home: &Path,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<HistorySource>, String> {
    check_cancelled(cancelled)?;
    let mut out = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    // The 1.5.9 root is scanned first: a migrated machine keeps its live ids
    // there while the legacy root stays empty, and one id stored in both
    // roots keeps the live copy — never two entries. Each source's path
    // attributes it to the root's own index.
    let cli_root = super::cli_data_root(home);
    let legacy_root = super::data_root(home);
    scan_root(&cli_root, cancelled, &mut out, &mut seen)?;
    if legacy_root != cli_root {
        scan_root(&legacy_root, cancelled, &mut out, &mut seen)?;
    }
    Ok(out)
}

fn scan_root(
    root: &Path,
    cancelled: &dyn Fn() -> bool,
    out: &mut Vec<HistorySource>,
    seen: &mut HashSet<String>,
) -> Result<(), String> {
    let index = root.join("conversation_summaries.db");
    if !index.is_file() {
        return Ok(());
    }
    let (connection, layout) = open_summaries(&index)?;
    let summaries = read_summaries(&connection, layout, cancelled)?;
    let children_of = children_map(&connection, layout, &summaries)?;
    // Every id linked as a direct child (column or parents table) stays with
    // its parent instead of listing independently.
    let linked_children: HashSet<&str> = children_of
        .values()
        .flatten()
        .map(|(id, _)| id.as_str())
        .collect();
    for row in &summaries {
        check_cancelled(cancelled)?;
        if row.parent.is_some()
            || linked_children.contains(row.id.as_str())
            || !valid_native_id(&row.id)
        {
            continue;
        }
        if !seen.insert(row.id.clone()) {
            // Already listed from the earlier (live) root: a duplicate id
            // must not appear twice.
            continue;
        }
        if out.len() >= MAX_SOURCES {
            return Err("Antigravity 会话源超过 5000 个，本次未删除旧索引".into());
        }
        let id = &row.id;
        let title = &row.title;
        let workspace = &row.workspace;
        let status = &row.status;
        // Discovery reads only revisions, never every transcript/protobuf blob.
        // Only this conversation's own transcript and usage database can set
        // fingerprint_error. A direct child's stamp or open failure stays in
        // the parent stamp so the scan still parses the parent.
        let prefix = match layout {
            Layout::Legacy => "antigravity-session-v3",
            Layout::Cli => "antigravity-session-cli-v1",
        };
        let checked = (|| -> Result<String, String> {
            let transcript = crate::history::source_cache::optional_stamp(&transcript_path(root, id), cancelled)?;
            let usage = usage_stamp(root, id, cancelled)?;
            let mut children = Vec::new();
            for (child_id, child_title) in children_of.get(id).into_iter().flatten() {
                children.push(child_revision(child_id, child_title, root, cancelled)?);
            }
            children.sort();
            Ok(format!(
                "{prefix}|{id}|{title:?}|{workspace:?}|{status:?}|{transcript}|{usage}|{}",
                children.join(",")
            ))
        })();
        out.push(HistorySource {
            native_title: title.clone().filter(|title| !title.trim().is_empty()),
            path: index.clone(),
            native_id: Some(id.clone()),
            fingerprint: checked.as_ref().cloned().unwrap_or_default(),
            fingerprint_error: checked.err(),
        });
    }
    Ok(())
}

fn read_summaries(
    connection: &Connection,
    layout: Layout,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<SummaryRow>, String> {
    let sql = match layout {
        Layout::Legacy => "SELECT id, title, workspace, status, parent_conversation_id
             FROM conversation_summaries ORDER BY rowid DESC",
        Layout::Cli => "SELECT conversation_id, title, workspace_uris, status, parent_conversation_id
             FROM conversation_summaries ORDER BY rowid DESC",
    };
    let mut statement = connection
        .prepare(sql)
        .map_err(|error| format!("Antigravity 会话索引结构无法识别：{error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(SummaryRow {
                id: row.get(0)?,
                title: row.get(1)?,
                workspace: row.get(2)?,
                status: row.get(3)?,
                parent: row.get(4)?,
            })
        })
        .map_err(|error| format!("Antigravity 会话索引结构无法识别：{error}"))?;
    let mut summaries = Vec::new();
    for row in rows {
        check_cancelled(cancelled)?;
        summaries.push(row.map_err(|error| error.to_string())?);
    }
    Ok(summaries)
}

/// Parent id → direct children (id, title), built from one index.
type ChildLinks = HashMap<String, Vec<(String, Option<String>)>>;

/// Direct-child map for one index. Both layouts link through the
/// `parent_conversation_id` column; 1.5.9 additionally records links in the
/// `conversation_parents(conversation_id, parent_id)` table (empty on the
/// evidence machine, but a native link wherever present). A child linked in
/// both places is attached once.
fn children_map(
    connection: &Connection,
    layout: Layout,
    summaries: &[SummaryRow],
) -> Result<ChildLinks, String> {
    let mut children_of: ChildLinks = HashMap::new();
    for row in summaries {
        if let Some(parent) = linked_parent(row.parent.as_deref()) {
            if valid_native_id(&row.id) && valid_native_id(parent) {
                children_of
                    .entry(parent.to_owned())
                    .or_default()
                    .push((row.id.clone(), row.title.clone()));
            }
        }
    }
    if layout != Layout::Cli {
        return Ok(children_of);
    }
    for (child, parent) in parent_links(connection)? {
        if !valid_native_id(&child) || !valid_native_id(&parent) {
            continue;
        }
        let entry = children_of.entry(parent).or_default();
        if entry.iter().any(|(id, _)| id == &child) {
            continue;
        }
        let title = summaries
            .iter()
            .find(|row| row.id == child)
            .and_then(|row| row.title.clone());
        entry.push((child, title));
    }
    Ok(children_of)
}

/// All rows of the 1.5.9 `conversation_parents` table; an absent table is no
/// extra links, not an error.
fn parent_links(connection: &Connection) -> Result<Vec<(String, String)>, String> {
    let exists = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='conversation_parents'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("Antigravity 会话索引结构无法识别：{error}"))?;
    if exists != 1 {
        return Ok(Vec::new());
    }
    let mut statement = connection
        .prepare("SELECT conversation_id, parent_id FROM conversation_parents ORDER BY conversation_id, parent_id")
        .map_err(|error| format!("Antigravity 会话索引结构无法识别：{error}"))?;
    let rows = statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|error| format!("Antigravity 会话索引结构无法识别：{error}"))?;
    Ok(rows.flatten().collect())
}

struct SummaryRow {
    id: String,
    title: Option<String>,
    workspace: Option<String>,
    status: Option<String>,
    parent: Option<String>,
}

fn linked_parent(parent: Option<&str>) -> Option<&str> {
    parent.map(str::trim).filter(|value| !value.is_empty())
}

fn usage_stamp(root: &Path, id: &str, cancelled: &dyn Fn() -> bool) -> Result<String, String> {
    let database = conversation_db(root, id);
    if database.is_file() {
        crate::history::source_cache::database_stamp(&database, cancelled)
    } else {
        Ok("missing".into())
    }
}

fn child_revision(
    child_id: &str,
    child_title: &Option<String>,
    root: &Path,
    cancelled: &dyn Fn() -> bool,
) -> Result<String, String> {
    let transcript = child_file_stamp(&transcript_path(root, child_id), cancelled)?;
    let usage = child_usage_stamp(root, child_id, cancelled)?;
    Ok(format!("{child_id}|{child_title:?}|{transcript}|{usage}"))
}

fn scan_cancelled(error: &str) -> bool {
    error.contains("扫描已取消")
}

fn unread_material_stamp(path: &Path) -> String {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return format!("unread:{}", path.display());
    };
    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    format!("unread:{}:{modified}:{}", metadata.len(), path.display())
}

/// Keeps a child stamp failure out of the parent `fingerprint_error`.
/// `missing` stays `missing`. Cancellation is not turned into an unread stamp.
fn isolate_child_stamp(
    path: &Path,
    stamp: Result<String, String>,
    cancelled: &dyn Fn() -> bool,
) -> Result<String, String> {
    let stamp = match stamp {
        Ok(stamp) => stamp,
        Err(error) if cancelled() || scan_cancelled(&error) => return Err(error),
        Err(_) => return Ok(unread_material_stamp(path)),
    };
    if stamp == "missing" {
        return Ok(stamp);
    }
    // Attribute metadata can succeed while a sharing lock still blocks the
    // body. The unread prefix keeps the parent fingerprint different until
    // the body can be opened again.
    match std::fs::File::open(path) {
        Ok(_) => Ok(stamp),
        Err(_) if cancelled() => Err("扫描已取消，原索引已保留".into()),
        Err(_) => Ok(format!("unread:{stamp}")),
    }
}

fn child_file_stamp(path: &Path, cancelled: &dyn Fn() -> bool) -> Result<String, String> {
    check_cancelled(cancelled)?;
    isolate_child_stamp(path, crate::history::source_cache::optional_stamp(path, cancelled), cancelled)
}

fn child_usage_stamp(root: &Path, id: &str, cancelled: &dyn Fn() -> bool) -> Result<String, String> {
    check_cancelled(cancelled)?;
    let database = conversation_db(root, id);
    match std::fs::symlink_metadata(&database) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok("missing".into()),
        Err(error) if cancelled() || scan_cancelled(&error.to_string()) => Err(error.to_string()),
        Err(_) => Ok(unread_material_stamp(&database)),
        Ok(metadata) if metadata.file_type().is_symlink() => Ok(unread_material_stamp(&database)),
        Ok(metadata) if !metadata.is_file() => Ok("missing".into()),
        Ok(_) => isolate_child_stamp(
            &database,
            crate::history::source_cache::database_stamp(&database, cancelled),
            cancelled,
        ),
    }
}

/// Child material counts only as a real file. A link or a stat failure is not
/// readable, so parsing does not follow it or invent a body.
fn regular_child_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .ok()
        .is_some_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
}

/// The usage database and its WAL must both be real files before usage rows
/// are read. A missing WAL is normal. A link, a non-file, or a stat failure
/// omits that child's usage; it does not decide whether the transcript opens.
fn child_usage_readable(database: &Path) -> bool {
    if !regular_child_file(database) {
        return false;
    }
    let mut wal = database.as_os_str().to_os_string();
    wal.push("-wal");
    match std::fs::symlink_metadata(Path::new(&wal)) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Ok(metadata) => metadata.is_file() && !metadata.file_type().is_symlink(),
        Err(_) => false,
    }
}

/// Usage material is present but cannot be read: a link, a stat failure, or a
/// real database whose WAL is not an ordinary file. A missing database is not
/// this case; there is then no child usage to attach.
fn child_usage_unreadable(database: &Path) -> bool {
    if child_usage_readable(database) {
        return false;
    }
    match std::fs::symlink_metadata(database) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Ok(metadata) if !metadata.file_type().is_symlink() && !metadata.is_file() => false,
        _ => true,
    }
}

fn transcript_path(root: &Path, id: &str) -> PathBuf {
    root.join("brain")
        .join(id)
        .join(".system_generated")
        .join("logs")
        .join("transcript_full.jsonl")
}

fn conversation_db(root: &Path, id: &str) -> PathBuf {
    root.join("conversations").join(format!("{id}.db"))
}

fn open_summaries(path: &Path) -> Result<(Connection, Layout), String> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("Antigravity 会话索引无法只读打开：{error}"))?;
    connection
        .busy_timeout(std::time::Duration::from_millis(500))
        .map_err(|error| error.to_string())?;
    let tables = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='conversation_summaries'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("Antigravity 会话索引结构无法识别：{error}"))?;
    if tables != 1 {
        return Err("Antigravity 会话索引缺少 conversation_summaries 表".into());
    }
    let layout = detect_layout(&connection)?;
    Ok((connection, layout))
}

/// Layout by index shape: the 1.5.9 index renamed `id` to
/// `conversation_id`. An index with neither or both shapes is drift and is
/// not guessed onto either parser.
fn detect_layout(connection: &Connection) -> Result<Layout, String> {
    let mut statement = connection
        .prepare("PRAGMA table_info(conversation_summaries)")
        .map_err(|error| format!("Antigravity 会话索引结构无法识别：{error}"))?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("Antigravity 会话索引结构无法识别：{error}"))?;
    let mut legacy = false;
    let mut cli = false;
    for name in names.flatten() {
        match name.as_str() {
            "id" => legacy = true,
            "conversation_id" => cli = true,
            _ => {}
        }
    }
    match (legacy, cli) {
        (true, false) => Ok(Layout::Legacy),
        (false, true) => Ok(Layout::Cli),
        _ => Err("Antigravity 会话索引缺少已知的会话 ID 列（id/conversation_id）".into()),
    }
}

fn open_conversation(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("Antigravity 会话用量库无法只读打开：{error}"))?;
    connection
        .busy_timeout(std::time::Duration::from_millis(500))
        .map_err(|error| error.to_string())?;
    let tables = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='gen_metadata'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("Antigravity 会话用量库结构无法识别：{error}"))?;
    if tables != 1 {
        return Err("Antigravity 会话用量库缺少 gen_metadata 表".into());
    }
    Ok(connection)
}

pub fn parse(source: &HistorySource) -> Result<ParsedSession, String> {
    parse_controlled(source, &|| false)
}

pub fn parse_controlled(
    source: &HistorySource,
    cancelled: &dyn Fn() -> bool,
) -> Result<ParsedSession, String> {
    check_cancelled(cancelled)?;
    let id = source
        .native_id
        .clone()
        .ok_or("Antigravity 会话缺少 conversation id")?;
    let (connection, layout) = open_summaries(&source.path)?;
    let (title, workspace): (Option<String>, Option<String>) = match layout {
        Layout::Legacy => connection
            .query_row(
                "SELECT title, workspace FROM conversation_summaries
                 WHERE id = ?1 AND parent_conversation_id IS NULL",
                [&id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|_| "Antigravity 会话索引行缺失或结构变化".to_string())?,
        Layout::Cli => {
            let (title, uris): (Option<String>, Option<String>) = connection
                .query_row(
                    "SELECT title, workspace_uris FROM conversation_summaries
                     WHERE conversation_id = ?1 AND parent_conversation_id IS NULL",
                    [&id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(|_| "Antigravity 会话索引行缺失或结构变化".to_string())?;
            (title, uris.and_then(first_workspace_uri))
        }
    };
    let mut session = ParsedSession::new();
    session.native_id = Some(id.clone());
    if let Some(title) = title.filter(|title| !title.trim().is_empty()) {
        session.title = title.chars().take(96).collect();
    }
    session.cwd = workspace.filter(|workspace| !workspace.trim().is_empty());
    // The source path is <data root>/conversation_summaries.db; transcripts and
    // the usage database live beside it under the same root.
    let root = source
        .path
        .parent()
        .ok_or("Antigravity 会话索引路径无效")?
        .to_path_buf();
    // Transcript: only each layout's documented user/planner rows enter the
    // timeline; 1.5.9 PLANNER_RESPONSE rows also expose their counters.
    let transcript = transcript_path(&root, &id);
    let mut transcript_usage = Vec::new();
    match read_transcript(&id, &transcript, layout, &mut transcript_usage, cancelled) {
        Ok(body) => {
            session.partial |= body.partial;
            session.messages = body.messages;
        }
        Err(error) if error == "missing" => session.partial = true,
        Err(error) => return Err(format!("Antigravity 会话记录无法读取：{error}")),
    }
    check_cancelled(cancelled)?;
    // Usage: protobuf rows in conversations/<id>.db, strictly validated.
    let mut seen = HashSet::new();
    let usage_db = conversation_db(&root, &id);
    if !usage_db.is_file() {
        session.partial = true;
        if layout == Layout::Cli {
            // The 1.5.9 transcript counters stand in only for a missing
            // database, so a readable gen_metadata source is never
            // double-counted.
            record_transcript_usage(&mut session, &mut seen, &id, &transcript_usage, None);
        }
    } else {
        // A root usage database that cannot be opened is still a parse failure.
        // A child database omits that child's usage and keeps its transcript.
        append_usage(&mut session, &usage_db, layout, &mut seen, None, cancelled)?;
    }
    attach_direct_children(&mut session, &connection, layout, &root, &id, &mut seen, cancelled)?;
    check_cancelled(cancelled)?;
    session.finish(source)
}

/// 1.5.9 stores workspaces as a JSON array of path strings. Only the first
/// non-empty entry becomes the working directory; an empty, non-array, or
/// unparseable value is no cwd rather than a guess.
fn first_workspace_uri(value: String) -> Option<String> {
    let parsed: Value = serde_json::from_str(&value).ok()?;
    parsed.as_array()?.iter().find_map(|item| {
        item.as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    })
}

/// The 1.5.9 transcript-side counters of one PLANNER_RESPONSE row.
struct TranscriptUsage {
    line: usize,
    input: u64,
    output: u64,
    cache_read: u64,
    model: Option<String>,
    timestamp: Option<i64>,
}

fn read_transcript(
    id: &str,
    transcript: &Path,
    layout: Layout,
    usage: &mut Vec<TranscriptUsage>,
    cancelled: &dyn Fn() -> bool,
) -> Result<ParsedSession, String> {
    if !transcript.is_file() {
        return Err("missing".into());
    }
    let text = std::fs::read_to_string(transcript).map_err(|error| error.to_string())?;
    let mut session = ParsedSession::new();
    for (index, line) in text.lines().enumerate() {
        check_cancelled(cancelled)?;
        if index >= MAX_TRANSCRIPT_LINES {
            session.partial = true;
            break;
        }
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(row) = serde_json::from_str::<Value>(line) else {
            session.partial = true;
            continue;
        };
        let kind = row.get("type").and_then(Value::as_str);
        // Each layout admits only its documented row types; the 1.5.9-only
        // GENERIC/SYSTEM_MESSAGE/ERROR_MESSAGE/CHECKPOINT rows have no
        // verified timeline meaning and stay out of it.
        let role = match (layout, kind) {
            (_, Some("USER_INPUT")) => Some("user"),
            (_, Some("PLANNER_RESPONSE")) | (Layout::Legacy, Some("AGENT_RESPONSE")) => {
                Some("assistant")
            }
            _ => None,
        };
        if layout == Layout::Cli && kind == Some("PLANNER_RESPONSE") {
            match transcript_usage_row(&row, index) {
                Ok(event) => usage.push(event),
                Err(Mismatch) => session.partial = true,
            }
        }
        let Some(role) = role else {
            continue;
        };
        let content = row.get("content").cloned().unwrap_or(Value::Null);
        session.add_message(
            format!("{id}:{index}"),
            role,
            text_content(&content),
            row.get("created_at").and_then(parse_timestamp),
        );
    }
    Ok(session)
}

/// All three documented counter fields are required on a 1.5.9
/// PLANNER_RESPONSE row; a partial or non-numeric block is drift (partial
/// degrade, no guessed values). `model` is absent on one observed row shape
/// and stays None then.
fn transcript_usage_row(row: &Value, line: usize) -> Result<TranscriptUsage, Mismatch> {
    let counter = |name: &str| -> Result<u64, Mismatch> {
        row.get(name).and_then(Value::as_u64).ok_or(Mismatch)
    };
    Ok(TranscriptUsage {
        line,
        input: counter("input_tokens")?,
        output: counter("output_tokens")?,
        cache_read: counter("cache_read_tokens")?,
        model: row
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_owned),
        timestamp: row.get("created_at").and_then(parse_timestamp),
    })
}

/// Records the transcript-side counters as usage events. They substitute for
/// gen_metadata only when that database is missing, so the same call is
/// never counted twice. There is no cache-write field on the transcript
/// side; that bucket stays unknown instead of zero.
fn record_transcript_usage(
    session: &mut ParsedSession,
    seen: &mut HashSet<String>,
    conversation: &str,
    usage: &[TranscriptUsage],
    attribution: Option<UsageAttribution>,
) {
    for event in usage {
        record_usage(
            session,
            seen,
            UsageEvent {
                native_usage: None,
                request_count: Some(1),
                id: format!("{conversation}:tr:{}", event.line),
                model: event.model.clone(),
                timestamp: event.timestamp,
                input: Some(event.input),
                output: Some(event.output),
                cache_read: Some(event.cache_read),
                cache_write: None,
                // The captured transcript counters mirror the gen_metadata
                // split: input excludes the separately reported cache read.
                input_includes_cache: false,
                attributions: attribution.clone().into_iter().collect(),
            },
        );
    }
}

fn append_usage(
    session: &mut ParsedSession,
    usage_db: &Path,
    layout: Layout,
    seen: &mut HashSet<String>,
    attribution: Option<UsageAttribution>,
    cancelled: &dyn Fn() -> bool,
) -> Result<(), String> {
    let usage = open_conversation(usage_db)?;
    let mut statement = usage
        .prepare("SELECT data FROM gen_metadata ORDER BY rowid")
        .map_err(|_| "Antigravity 会话用量库 gen_metadata 结构变化".to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, Vec<u8>>(0))
        .map_err(|error| error.to_string())?;
    for blob in rows.flatten() {
        check_cancelled(cancelled)?;
        match parse_generation(&blob, layout) {
            Ok(None) => {}
            Ok(Some(event)) => {
                let response_id = event.response_id.clone();
                record_usage(session, seen, UsageEvent {
                    native_usage: None,
                    request_count: Some(1),
                    id: response_id,
                    model: event.model,
                    timestamp: event.timestamp,
                    input: Some(event.input),
                    output: Some(event.output),
                    cache_read: Some(event.cache_read),
                    cache_write: Some(event.cache_write),
                    // Verified [RE] semantics: field 2 counts only the uncached share.
                    input_includes_cache: false,
                    attributions: attribution.clone().into_iter().collect(),
                });
            }
            Err(Mismatch) => session.partial = true,
        }
    }
    Ok(())
}

fn record_usage(session: &mut ParsedSession, seen: &mut HashSet<String>, event: UsageEvent) {
    if !seen.insert(event.id.clone()) {
        // The same response_id on a child log is still one call. Keep the
        // child jump on that existing event instead of adding a second row.
        if let Some(existing) = session.usage.iter_mut().find(|item| item.id == event.id) {
            for attribution in event.attributions {
                if attribution.session_key.is_some()
                    && !existing.attributions.iter().any(|item| item.session_key == attribution.session_key)
                {
                    existing.attributions.push(attribution);
                }
            }
        }
        return;
    }
    if session.model.is_none() {
        session.model.clone_from(&event.model);
    }
    session.usage.push(event);
}

fn attach_direct_children(
    session: &mut ParsedSession,
    conversation_index: &Connection,
    layout: Layout,
    root: &Path,
    parent: &str,
    seen: &mut HashSet<String>,
    cancelled: &dyn Fn() -> bool,
) -> Result<(), String> {
    let sql = match layout {
        Layout::Legacy => "SELECT id, title FROM conversation_summaries
             WHERE parent_conversation_id = ?1 ORDER BY id",
        Layout::Cli => "SELECT conversation_id, title FROM conversation_summaries
             WHERE parent_conversation_id = ?1 ORDER BY conversation_id",
    };
    let mut statement = conversation_index
        .prepare(sql)
        .map_err(|_| "Antigravity 会话索引行缺失或结构变化".to_string())?;
    let rows = statement
        .query_map([parent], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)))
        .map_err(|error| error.to_string())?;
    let mut children: Vec<(String, Option<String>)> = Vec::new();
    for row in rows {
        check_cancelled(cancelled)?;
        children.push(row.map_err(|error| error.to_string())?);
    }
    if layout == Layout::Cli {
        // 1.5.9 also links children through conversation_parents; a child
        // linked in both places is attached once.
        let mut extra = conversation_index
            .prepare(
                "SELECT p.conversation_id, s.title FROM conversation_parents p
                 LEFT JOIN conversation_summaries s
                   ON s.conversation_id = p.conversation_id
                 WHERE p.parent_id = ?1 ORDER BY p.conversation_id",
            )
            .map_err(|_| "Antigravity 会话索引行缺失或结构变化".to_string())?;
        let linked = extra
            .query_map([parent], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })
            .map_err(|error| error.to_string())?;
        for row in linked {
            check_cancelled(cancelled)?;
            let (id, title) = row.map_err(|error| error.to_string())?;
            if !children.iter().any(|(existing, _)| existing == &id) {
                children.push((id, title));
            }
        }
    }
    children.sort_by(|a, b| a.0.cmp(&b.0));
    for (id, title) in children {
        check_cancelled(cancelled)?;
        if !valid_native_id(&id) {
            continue;
        }
        let name = title.and_then(|title| {
            let trimmed = title.trim();
            (!trimmed.is_empty()).then(|| trimmed.chars().take(256).collect())
        });
        let transcript = transcript_path(root, &id);
        let usage_db = conversation_db(root, &id);
        // Readability is the transcript alone. Usage never clears a body that
        // was already read, and a missing usage database adds no events.
        let mut readable = false;
        let mut messages = Vec::new();
        let mut child_usage = Vec::new();
        if regular_child_file(&transcript) {
            match read_transcript(&id, &transcript, layout, &mut child_usage, cancelled) {
                Ok(body) => {
                    session.partial |= body.partial;
                    messages = body.messages;
                    readable = true;
                }
                Err(error) if cancelled() || scan_cancelled(&error) => return Err(error),
                Err(_) => session.partial = true,
            }
        }
        if child_usage_readable(&usage_db) {
            let attribution = UsageAttribution {
                kind: AgentKind::Subagent,
                name: name.clone(),
                session_key: Some(id.clone()),
            };
            match append_usage(session, &usage_db, layout, seen, Some(attribution), cancelled) {
                Ok(()) => {}
                Err(error) if cancelled() || scan_cancelled(&error) => return Err(error),
                Err(_) => session.partial = true,
            }
        } else if child_usage_unreadable(&usage_db) {
            session.partial = true;
        } else if layout == Layout::Cli {
            // Missing 1.5.9 child database: the child transcript's own
            // PLANNER_RESPONSE counters attribute its calls; there is no
            // gen_metadata copy to double-count against.
            let attribution = UsageAttribution {
                kind: AgentKind::Subagent,
                name: name.clone(),
                session_key: Some(id.clone()),
            };
            record_transcript_usage(session, seen, &id, &child_usage, Some(attribution));
        }
        session.children.push(ChildSession {
            key: id,
            name,
            messages: if readable { messages } else { Vec::new() },
            readable,
            children: Vec::new(),
        });
    }
    Ok(())
}

/// A strictly parsed `gen_metadata` usage row.
#[derive(Debug, PartialEq)]
struct GenerationUsage {
    response_id: String,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    model: Option<String>,
    timestamp: Option<i64>,
}

/// Walks one `gen_metadata` blob. `Ok(None)` means the row carries no usage
/// stats; `Err(Mismatch)` means structural drift — the caller skips the row
/// and marks the session partial, never guessing a field.
fn parse_generation(blob: &[u8], layout: Layout) -> Result<Option<GenerationUsage>, Mismatch> {
    let mut chat_model: Option<&[u8]> = None;
    let mut reader = Reader::new(blob);
    while !reader.done() {
        let (number, _, field) = reader.next()?;
        // Documented row fields: 1 ChatModel (message), 2 stepIndices, 4
        // generation uuid (string). Field 2 is a bare varint in the legacy
        // [RE] shape and packed (length-delimited) in every sampled 1.5.9
        // row; the value is unused, but a documented number arriving with
        // the layout's wrong wire type is drift even then.
        match number {
            1 => chat_model = Some(field.as_bytes()?),
            2 => match layout {
                Layout::Legacy => {
                    field.as_varint()?;
                }
                Layout::Cli => {
                    field.as_bytes()?;
                }
            },
            4 => {
                field.as_bytes()?;
            }
            // Unknown numbers (1.5.9's new field 8 among them) are skipped
            // by wire type.
            _ => {}
        }
    }
    let Some(chat_model) = chat_model else {
        // No ChatModel wrapper: nothing billable in this row.
        return Ok(None);
    };
    let mut stats: Option<&[u8]> = None;
    let mut timestamp_wrapper: Option<&[u8]> = None;
    let mut model_id: Option<String> = None;
    let mut display_name: Option<String> = None;
    let mut reader = Reader::new(chat_model);
    while !reader.done() {
        let (number, _, field) = reader.next()?;
        match number {
            4 => stats = Some(field.as_bytes()?),
            9 => timestamp_wrapper = Some(field.as_bytes()?),
            19 => model_id = Some(decode_string(field.as_bytes()?)?),
            21 => display_name = Some(decode_string(field.as_bytes()?)?),
            _ => {}
        }
    }
    let Some(stats) = stats else {
        return Ok(None);
    };
    let mut input_tokens = None;
    let mut output_tokens = None;
    let mut cache_write_tokens = None;
    let mut cache_read_tokens = None;
    let mut thinking_output_tokens = None;
    let mut response_output_tokens = None;
    let mut response_id = None;
    let mut reader = Reader::new(stats);
    while !reader.done() {
        let (number, _, field) = reader.next()?;
        match number {
            2 => input_tokens = Some(field.as_varint()?),
            3 => output_tokens = Some(field.as_varint()?),
            4 => cache_write_tokens = Some(field.as_varint()?),
            5 => cache_read_tokens = Some(field.as_varint()?),
            9 => thinking_output_tokens = Some(field.as_varint()?),
            10 => response_output_tokens = Some(field.as_varint()?),
            11 => response_id = Some(decode_string(field.as_bytes()?)?),
            _ => {}
        }
    }
    if input_tokens.is_none()
        && output_tokens.is_none()
        && cache_write_tokens.is_none()
        && cache_read_tokens.is_none()
    {
        // The stats submessage exists but holds none of the documented token
        // counters: drift, not a zero-cost call.
        return Err(Mismatch);
    }
    // Documented identity: field 3 = field 9 + field 10. Disagreement means
    // the [RE] schema no longer holds for this row.
    if let (Some(output), Some(thinking), Some(response)) =
        (output_tokens, thinking_output_tokens, response_output_tokens)
    {
        if output != thinking.saturating_add(response) {
            return Err(Mismatch);
        }
    }
    // The response_id is the documented dedup key; without it the row cannot
    // be accounted for honestly.
    let Some(response_id) = response_id.filter(|id| !id.is_empty()) else {
        return Err(Mismatch);
    };
    let mut timestamp = None;
    if let Some(wrapper) = timestamp_wrapper {
        let mut reader = Reader::new(wrapper);
        while !reader.done() {
            let (number, _, field) = reader.next()?;
            if number == 4 {
                timestamp = Some(field.as_varint()? as i64);
            }
        }
    }
    let model = model_id
        .filter(|id| !id.is_empty())
        .or_else(|| display_name.filter(|name| !name.is_empty()));
    Ok(Some(GenerationUsage {
        response_id,
        input: input_tokens.unwrap_or(0),
        output: output_tokens.unwrap_or(0),
        cache_read: cache_read_tokens.unwrap_or(0),
        cache_write: cache_write_tokens.unwrap_or(0),
        model,
        timestamp,
    }))
}

fn decode_string(bytes: &[u8]) -> Result<String, Mismatch> {
    String::from_utf8(bytes.to_vec()).map_err(|_| Mismatch)
}


#[cfg(test)]
mod tests {
    use super::*;
    use super::super::protobuf::encode;
    use rusqlite::params;
    use serde_json::json;

    /// Hand-built sanitized row set following the documented [RE] schema
    /// (codeburn against agy 1.2.x; no local agy data exists to desensitize).
    /// Tests rebuild conversation_summaries.db, conversations/<id>.db and the
    /// transcript jsonl deterministically from these rows (the mimo_code
    /// in-test database pattern; no committed binaries).
    const ROWS_FIXTURE: &str =
        include_str!("../../../../tests/fixtures/history/antigravity-cli-1.3/sessions.json");

    /// Sanitized 1.5.9 row set captured on the authorized remote; the rebuild
    /// mirrors the observed index schema (conversation_id/workspace_uris
    /// columns, conversation_parents table), gen_metadata wire shapes
    /// (packed field 2, unknown field 8) and transcript row shape.
    const CLI_ROWS_FIXTURE: &str =
        include_str!("../../../../tests/fixtures/history/antigravity-cli-1.5.9/sessions.json");

    const ROOT_ID: &str = "conv_root_20261005_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6";
    const CHILD_ID: &str = "conv_child_20261005_z9y8x7w6v5u4t3s2r1q0p1o2n3m2l1k0";
    const CLI_ROOT_ID: &str = "conv_159_root_0000000000000000000000000a1";
    const CLI_CHILD_ID: &str = "conv_159_subagent_00000000000000000000b2";
    const CLI_RUNNING_ID: &str = "conv_159_running_0000000000000000000c3";

    fn fixture() -> Value {
        serde_json::from_str(ROWS_FIXTURE).unwrap()
    }

    fn cli_fixture() -> Value {
        serde_json::from_str(CLI_ROWS_FIXTURE).unwrap()
    }

    /// Encodes one structured fixture generation into its protobuf blob.
    fn encode_generation(row: &Value) -> Vec<u8> {
        if row["malformed"] == "wrong_wire" {
            // Documented varint field 2 arrives length-delimited: drift.
            let mut blob = encode::bytes_field(2, b"150");
            blob.extend(encode::string_field(
                4,
                row["generation_uuid"].as_str().unwrap_or(""),
            ));
            return blob;
        }
        if row["malformed"] == "truncated" {
            // Cut the blob inside the stats submessage.
            let full = encode_well_formed_generation(row);
            return full[..full.len() - 4].to_vec();
        }
        encode_well_formed_generation(row)
    }

    /// The ChatModel submessage both layouts share (stats counters, 9→4
    /// timestamp wrapper, 19 model config id, 21 display name).
    fn chat_model_payload(row: &Value) -> Vec<u8> {
        let mut stats = Vec::new();
        if let Some(value) = row["input_tokens"].as_u64() {
            stats.extend(encode::varint_field(2, value));
        }
        if let Some(value) = row["output_tokens"].as_u64() {
            stats.extend(encode::varint_field(3, value));
        }
        if let Some(value) = row["cache_write_tokens"].as_u64() {
            stats.extend(encode::varint_field(4, value));
        }
        if let Some(value) = row["cache_read_tokens"].as_u64() {
            stats.extend(encode::varint_field(5, value));
        }
        if let Some(value) = row["thinking_output_tokens"].as_u64() {
            stats.extend(encode::varint_field(9, value));
        }
        if let Some(value) = row["response_output_tokens"].as_u64() {
            stats.extend(encode::varint_field(10, value));
        }
        if let Some(value) = row["response_id"].as_str() {
            stats.extend(encode::string_field(11, value));
        }
        if row["no_stats"] == true {
            // A ChatModel wrapper without the ModelUsageStats submessage.
            let mut chat_model = Vec::new();
            if let Some(value) = row["display_name"].as_str() {
                chat_model.extend(encode::string_field(21, value));
            }
            return chat_model;
        }
        let mut chat_model = encode::bytes_field(4, &stats);
        if let Some(value) = row["timestamp"].as_u64() {
            chat_model.extend(encode::bytes_field(9, &encode::varint_field(4, value)));
        }
        if let Some(value) = row["model_id"].as_str() {
            chat_model.extend(encode::string_field(19, value));
        }
        if let Some(value) = row["display_name"].as_str() {
            chat_model.extend(encode::string_field(21, value));
        }
        chat_model
    }

    fn encode_well_formed_generation(row: &Value) -> Vec<u8> {
        let mut blob = encode::bytes_field(1, &chat_model_payload(row));
        if let Some(indices) = row["step_indices"].as_array() {
            for index in indices {
                blob.extend(encode::varint_field(2, index.as_u64().unwrap()));
            }
        }
        if let Some(value) = row["generation_uuid"].as_str() {
            blob.extend(encode::string_field(4, value));
        }
        blob
    }

    /// Encodes one 1.5.9 fixture generation with the observed top-level wire
    /// shapes: field 1 ChatModel, field 2 packed step indices
    /// (length-delimited), field 4 uuid string, and the new unknown field 8
    /// submessage.
    fn encode_cli_generation(row: &Value) -> Vec<u8> {
        if row["malformed"] == "wrong_wire" {
            // Field 4 is documented length-delimited (36-byte uuid); a varint
            // there is drift. The rest of the row stays well formed.
            let mut blob = encode::bytes_field(1, &chat_model_payload(row));
            blob.extend(encode::varint_field(4, 7));
            return blob;
        }
        let mut blob = encode::bytes_field(1, &chat_model_payload(row));
        let indices = row["step_indices"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .map(|index| index.as_u64().unwrap())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        blob.extend(encode::bytes_field(2, &encode::packed_varints(&indices)));
        if let Some(value) = row["generation_uuid"].as_str() {
            blob.extend(encode::string_field(4, value));
        }
        if row["top_fields"]
            .as_array()
            .is_some_and(|fields| fields.contains(&json!(8)))
        {
            blob.extend(encode::bytes_field(8, b"unknown-1.5.9-submessage"));
        }
        blob
    }

    fn write_fixture(home: &std::path::Path) {
        let rows = fixture();
        let root = super::super::data_root(home);
        let summaries = root.join("conversation_summaries.db");
        std::fs::create_dir_all(&root).unwrap();
        let index = Connection::open(&summaries).unwrap();
        index
            .execute_batch(
                "CREATE TABLE conversation_summaries (
                    id TEXT PRIMARY KEY, title TEXT, workspace TEXT,
                    status TEXT, parent_conversation_id TEXT);",
            )
            .unwrap();
        for row in rows["conversations"].as_array().unwrap() {
            index
                .execute(
                    "INSERT INTO conversation_summaries
                        (id, title, workspace, status, parent_conversation_id)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        row["id"].as_str().unwrap(),
                        row["title"].as_str(),
                        row["workspace"].as_str(),
                        row["status"].as_str(),
                        row["parent_conversation_id"].as_str(),
                    ],
                )
                .unwrap();
            if let Some(generations) = row["generations"].as_array() {
                let db = conversation_db(&root, row["id"].as_str().unwrap());
                std::fs::create_dir_all(db.parent().unwrap()).unwrap();
                let usage = Connection::open(&db).unwrap();
                usage
                    .execute_batch(
                        "CREATE TABLE gen_metadata (key TEXT, data BLOB);",
                    )
                    .unwrap();
                for generation in generations {
                    usage
                        .execute(
                            "INSERT INTO gen_metadata (key, data) VALUES (?1, ?2)",
                            params![
                                generation["generation_uuid"].as_str().unwrap_or(""),
                                encode_generation(generation),
                            ],
                        )
                        .unwrap();
                }
            }
            if let Some(lines) = row["transcript"].as_array() {
                let transcript = transcript_path(&root, row["id"].as_str().unwrap());
                std::fs::create_dir_all(transcript.parent().unwrap()).unwrap();
                let text = lines
                    .iter()
                    .map(|line| line.to_string())
                    .collect::<Vec<_>>()
                    .join("\n");
                std::fs::write(&transcript, format!("{text}\n")).unwrap();
            }
        }
    }

    /// Rebuilds the 1.5.9 layout under the antigravity-cli data root: the
    /// full conversation_summaries column set, the conversation_parents table
    /// (empty, as on the evidence machine — the parent column carries the
    /// fixture link), conversations/<uuid>.db gen_metadata rows in the
    /// observed wire shapes and native transcript rows.
    fn write_cli_fixture(home: &std::path::Path) {
        let rows = cli_fixture();
        let root = super::super::cli_data_root(home);
        std::fs::create_dir_all(&root).unwrap();
        let index = Connection::open(root.join("conversation_summaries.db")).unwrap();
        index
            .execute_batch(
                "CREATE TABLE conversation_summaries (
                    conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT,
                    step_count INTEGER, last_modified_time TEXT, workspace_uris TEXT,
                    status TEXT, source TEXT, project_id TEXT, agent_name TEXT,
                    parent_conversation_id TEXT, nesting_depth INTEGER, battle_id TEXT,
                    winning_conversation_id TEXT, not_fully_idle INTEGER, killed INTEGER,
                    last_user_input_time TEXT, last_user_input_step_index INTEGER,
                    app_data_dir TEXT, raw_summary BLOB, group_id TEXT);
                 CREATE TABLE conversation_parents (conversation_id TEXT, parent_id TEXT);",
            )
            .unwrap();
        for row in rows["conversations"].as_array().unwrap() {
            index
                .execute(
                    "INSERT INTO conversation_summaries
                        (conversation_id, title, preview, step_count, last_modified_time,
                         workspace_uris, status, source, project_id, agent_name,
                         parent_conversation_id, nesting_depth, battle_id,
                         winning_conversation_id, not_fully_idle, killed,
                         last_user_input_time, last_user_input_step_index, app_data_dir,
                         group_id)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)",
                    params![
                        row["conversation_id"].as_str().unwrap(),
                        row["title"].as_str(),
                        row["preview"].as_str(),
                        row["step_count"].as_i64(),
                        row["last_modified_time"].as_str(),
                        serde_json::to_string(&row["workspace_uris"]).unwrap(),
                        row["status"].as_str(),
                        row["source"].as_str(),
                        row["project_id"].as_str(),
                        row["agent_name"].as_str(),
                        row["parent_conversation_id"].as_str(),
                        row["nesting_depth"].as_i64(),
                        row["battle_id"].as_str(),
                        row["winning_conversation_id"].as_str(),
                        row["not_fully_idle"].as_i64(),
                        row["killed"].as_i64(),
                        row["last_user_input_time"].as_str(),
                        row["last_user_input_step_index"].as_i64(),
                        row["app_data_dir"].as_str(),
                        row["group_id"].as_str(),
                    ],
                )
                .unwrap();
            if let Some(generations) = row["generations"].as_array() {
                let db = conversation_db(&root, row["conversation_id"].as_str().unwrap());
                std::fs::create_dir_all(db.parent().unwrap()).unwrap();
                let usage = Connection::open(&db).unwrap();
                usage
                    .execute_batch(
                        "CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER);",
                    )
                    .unwrap();
                for (position, generation) in generations.iter().enumerate() {
                    usage
                        .execute(
                            "INSERT INTO gen_metadata (idx, data, size) VALUES (?1, ?2, ?3)",
                            params![position as i64, encode_cli_generation(generation), 0],
                        )
                        .unwrap();
                }
            }
            if let Some(lines) = row["transcript"].as_array() {
                let transcript = transcript_path(&root, row["conversation_id"].as_str().unwrap());
                std::fs::create_dir_all(transcript.parent().unwrap()).unwrap();
                let text = lines
                    .iter()
                    .map(|line| line.to_string())
                    .collect::<Vec<_>>()
                    .join("\n");
                std::fs::write(&transcript, format!("{text}\n")).unwrap();
            }
        }
    }

    #[test]
    fn fixture_index_lists_root_conversations_with_fingerprinted_sources() {
        let home = tempfile::tempdir().unwrap();
        write_fixture(home.path());
        let found = sources(home.path()).unwrap();
        // Only the root conversation is a source; the child row stays with its
        // host and is never listed independently.
        assert_eq!(found.len(), 1, "{found:?}");
        assert!(found
            .iter()
            .all(|source| source.native_id.as_deref() != Some(CHILD_ID)));
        assert_eq!(found[0].native_id.as_deref(), Some(ROOT_ID));
        assert_eq!(found[0].native_title.as_deref(), Some("帮我把部署脚本改成幂等版本"));
        assert!(found[0].fingerprint.starts_with("antigravity-session-v3|"));
        let before = found[0].fingerprint.clone();
        // A new usage row in the conversation database changes the fingerprint.
        let usage = Connection::open(conversation_db(
            &super::super::data_root(home.path()),
            ROOT_ID,
        ))
        .unwrap();
        let row = json!({
            "response_id": "resp_added_0000000001",
            "generation_uuid": "cascade_added:resp_added_0000000001",
            "input_tokens": 9, "output_tokens": 3,
            "thinking_output_tokens": 1, "response_output_tokens": 2,
            "cache_write_tokens": 0, "cache_read_tokens": 0,
            "model_id": "gemini-3-pro-preview", "timestamp": 1791000090000u64
        });
        usage
            .execute(
                "INSERT INTO gen_metadata (key, data) VALUES (?1, ?2)",
                params!["cascade_added:resp_added_0000000001", encode_well_formed_generation(&row)],
            )
            .unwrap();
        drop(usage);
        let after = sources(home.path()).unwrap();
        assert_ne!(before, after[0].fingerprint);
        let with_root_usage = after[0].fingerprint.clone();
        let transcript = transcript_path(&super::super::data_root(home.path()), CHILD_ID);
        std::fs::write(&transcript, "{\"type\":\"AGENT_RESPONSE\",\"content\":\"子记录已改\"}\n").unwrap();
        let after_child = sources(home.path()).unwrap();
        assert_ne!(with_root_usage, after_child[0].fingerprint);
    }

    #[test]
    fn root_conversation_parses_identity_transcript_and_split_token_usage() {
        let home = tempfile::tempdir().unwrap();
        write_fixture(home.path());
        let found = sources(home.path()).unwrap();
        let session = parse(&found[0]).unwrap();
        assert_eq!(session.native_id.as_deref(), Some(ROOT_ID));
        assert_eq!(session.title, "帮我把部署脚本改成幂等版本");
        assert_eq!(
            session.cwd.as_deref(),
            Some(r"C:\Users\example\agy-demo")
        );
        assert_eq!(session.model.as_deref(), Some("gemini-3-pro-preview"));
        let roles: Vec<&str> = session
            .messages
            .iter()
            .map(|message| message.role.as_str())
            .collect();
        // USER_INPUT/PLANNER_RESPONSE/AGENT_RESPONSE map to the timeline; the
        // undocumented TOOL_CALL row type stays out.
        assert_eq!(roles, vec!["user", "assistant", "assistant"]);
        assert!(session.messages.iter().all(|message| !message.text.is_empty()));
        assert_eq!(session.messages[0].timestamp, Some(1791000005000));
        // Two documented generations survive: the duplicate response_id row is
        // deduped, the two malformed rows skip with partial degradation, and
        // the stats-free row stays out silently.
        assert_eq!(session.usage.len(), 2, "{:?}", session.usage);
        assert!(session.partial, "malformed rows must degrade to partial");
        let first = &session.usage[0];
        assert_eq!(first.id, "resp_0001_agy_fixture");
        assert_eq!(first.model.as_deref(), Some("gemini-3-pro-preview"));
        // input_tokens counts only the uncached share; cache read/write are
        // explicit sibling fields.
        assert_eq!(first.input, Some(1_200));
        assert_eq!(first.cache_read, Some(8_000));
        assert_eq!(first.cache_write, Some(3_000));
        // output_tokens includes thinking (field 3 = field 9 + field 10).
        assert_eq!(first.output, Some(300));
        assert!(!first.input_includes_cache, "stored input excludes cache");
        assert_eq!(first.timestamp, Some(1791000010000));
        let second = &session.usage[1];
        assert_eq!(second.id, "resp_0002_agy_fixture");
        assert_eq!(second.input, Some(500));
        assert_eq!(second.output, Some(150));
        assert_eq!(second.cache_read, Some(0));
        assert_eq!(second.cache_write, Some(0));
        // Model display name (field 21) is the fallback when the config id is
        // absent.
        assert_eq!(second.model.as_deref(), Some("Gemini 3 Pro"));
        assert!(session.usage.iter().all(|event| event.request_count == Some(1)));
        // The fixture child has a transcript and no usage database. The body
        // stays on the child node; it does not enter the parent timeline, and
        // the missing database adds no usage row.
        assert_eq!(session.children.len(), 1);
        assert_eq!(session.children[0].key, CHILD_ID);
        assert_eq!(session.children[0].name.as_deref(), Some("task: 检查重复资源"));
        assert!(session.children[0].readable);
        assert_eq!(session.children[0].messages.len(), 1);
        assert!(session.children[0].messages[0].text.contains("子会话时间线"));
        assert!(session.children[0].children.is_empty());
        assert!(session.messages.iter().all(|message| !message.text.contains("子会话时间线")));
        assert!(session.usage.iter().all(|event| event.attributions.is_empty()));
    }

    #[test]
    fn missing_or_unrecognized_index_yields_no_sources_or_errors() {
        let home = tempfile::tempdir().unwrap();
        assert!(sources(home.path()).unwrap().is_empty());
        let root = super::super::data_root(home.path());
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("conversation_summaries.db"), b"not a database").unwrap();
        assert!(sources(home.path()).is_err());
    }

    #[test]
    fn missing_usage_database_degrades_to_partial_without_usage() {
        let home = tempfile::tempdir().unwrap();
        write_fixture(home.path());
        let found = sources(home.path()).unwrap();
        std::fs::remove_file(conversation_db(
            &super::super::data_root(home.path()),
            ROOT_ID,
        ))
        .unwrap();
        let session = parse(&found[0]).unwrap();
        assert!(session.usage.is_empty());
        // The transcript still shows; the session is flagged partial because
        // its usage cannot be verified.
        assert_eq!(session.messages.len(), 3);
        assert!(session.partial);
    }

    #[test]
    fn direct_child_with_both_materials_is_readable_and_counted_once() {
        let home = tempfile::tempdir().unwrap();
        write_fixture(home.path());
        let root = super::super::data_root(home.path());
        let database = conversation_db(&root, CHILD_ID);
        std::fs::create_dir_all(database.parent().unwrap()).unwrap();
        let usage = Connection::open(&database).unwrap();
        usage.execute_batch("CREATE TABLE gen_metadata (key TEXT, data BLOB);").unwrap();
        let child_row = json!({
            "response_id": "resp_child_agy_fixture",
            "generation_uuid": "cascade_child:resp_child_agy_fixture",
            "input_tokens": 11, "output_tokens": 4,
            "thinking_output_tokens": 1, "response_output_tokens": 3,
            "cache_write_tokens": 0, "cache_read_tokens": 0,
            "model_id": "gemini-3-pro-preview", "timestamp": 1791000040000u64
        });
        let duplicate = json!({
            "response_id": "resp_0001_agy_fixture",
            "generation_uuid": "cascade_child:resp_0001_agy_fixture",
            "input_tokens": 1200, "output_tokens": 300,
            "thinking_output_tokens": 24, "response_output_tokens": 276,
            "cache_write_tokens": 3000, "cache_read_tokens": 8000,
            "model_id": "gemini-3-pro-preview", "timestamp": 1791000010000u64
        });
        usage.execute(
            "INSERT INTO gen_metadata (key, data) VALUES (?1, ?2)",
            params!["cascade_child:resp_child_agy_fixture", encode_well_formed_generation(&child_row)],
        ).unwrap();
        usage.execute(
            "INSERT INTO gen_metadata (key, data) VALUES (?1, ?2)",
            params!["cascade_child:resp_0001_agy_fixture", encode_well_formed_generation(&duplicate)],
        ).unwrap();
        drop(usage);
        let index = Connection::open(root.join("conversation_summaries.db")).unwrap();
        index.execute(
            "INSERT INTO conversation_summaries (id, title, workspace, status, parent_conversation_id)
             VALUES ('conv_grand_20261005_abcdefghijklmnopqrstuvwx', 'grandchild', ?1, 'active', ?2)",
            params![r"C:\Users\example\agy-demo", CHILD_ID],
        ).unwrap();
        drop(index);
        let grand_transcript = transcript_path(&root, "conv_grand_20261005_abcdefghijklmnopqrstuvwx");
        std::fs::create_dir_all(grand_transcript.parent().unwrap()).unwrap();
        std::fs::write(&grand_transcript, "{\"type\":\"AGENT_RESPONSE\",\"content\":\"孙会话不挂到根\"}\n").unwrap();
        let before = std::fs::read(transcript_path(&root, CHILD_ID)).unwrap();
        let found = sources(home.path()).unwrap();
        assert_eq!(found.len(), 1);
        assert!(found.iter().all(|source| source.native_id.as_deref() != Some(CHILD_ID)));
        let session = parse(&found[0]).unwrap();
        assert_eq!(std::fs::read(transcript_path(&root, CHILD_ID)).unwrap(), before);
        assert_eq!(session.children.len(), 1);
        assert!(session.children[0].readable, "{:?}", session.children[0]);
        assert!(session.children[0].children.is_empty());
        assert_eq!(session.children[0].messages.len(), 1);
        assert!(session.children[0].messages[0].text.contains("子会话时间线"));
        assert!(session.messages.iter().all(|message| !message.text.contains("子会话时间线")));
        assert!(session.messages.iter().chain(session.children[0].messages.iter()).all(|message| !message.text.contains("孙会话")));
        assert_eq!(session.usage.len(), 3, "{:?}", session.usage.iter().map(|event| event.id.as_str()).collect::<Vec<_>>());
        let child_event = session.usage.iter().find(|event| event.id == "resp_child_agy_fixture").unwrap();
        assert_eq!(child_event.input, Some(11));
        assert_eq!(child_event.attributions.len(), 1);
        assert_eq!(child_event.attributions[0].kind, AgentKind::Subagent);
        assert_eq!(child_event.attributions[0].name.as_deref(), Some("task: 检查重复资源"));
        assert_eq!(child_event.attributions[0].session_key.as_deref(), Some(CHILD_ID));
        let shared = session.usage.iter().find(|event| event.id == "resp_0001_agy_fixture").unwrap();
        assert_eq!(shared.attributions.len(), 1);
        assert_eq!(shared.attributions[0].session_key.as_deref(), Some(CHILD_ID));
        std::fs::remove_file(transcript_path(&root, CHILD_ID)).unwrap();
        let missing_transcript = parse(&found[0]).unwrap();
        assert_eq!(missing_transcript.native_id.as_deref(), Some(ROOT_ID));
        assert_eq!(missing_transcript.messages.len(), 3);
        assert_eq!(missing_transcript.children.len(), 1);
        assert!(!missing_transcript.children[0].readable);
        assert!(missing_transcript.children[0].messages.is_empty());
        assert!(missing_transcript.usage.iter().any(|event| event.id == "resp_child_agy_fixture"));
        assert!(missing_transcript.messages.iter().all(|message| !message.text.contains("子会话时间线")));
    }

    #[test]
    fn missing_or_unreadable_child_usage_keeps_the_transcript() {
        let home = tempfile::tempdir().unwrap();
        write_fixture(home.path());
        let found = sources(home.path()).unwrap();
        let session = parse(&found[0]).unwrap();
        assert_eq!(session.native_id.as_deref(), Some(ROOT_ID));
        assert_eq!(session.messages.len(), 3);
        assert!(!session.usage.iter().any(|event| event.id.contains("child")));
        assert!(session.children[0].readable);
        assert!(session.children[0].messages[0].text.contains("子会话时间线"));
        assert!(session.messages.iter().all(|message| !message.text.contains("子会话时间线")));

        let root = super::super::data_root(home.path());
        let database = conversation_db(&root, CHILD_ID);
        std::fs::create_dir_all(database.parent().unwrap()).unwrap();
        std::fs::write(&database, b"not a database").unwrap();
        let broken = parse(&found[0]).unwrap();
        assert!(broken.partial);
        assert!(broken.children[0].readable);
        assert!(broken.children[0].messages[0].text.contains("子会话时间线"));
        assert!(broken.children[0].messages.iter().all(|message| !message.text.is_empty()));
        assert!(broken.messages.iter().all(|message| !message.text.contains("子会话时间线")));
        assert!(!broken.usage.iter().any(|event| event.id.contains("child")));
    }

    #[test]
    fn parse_generation_rejects_schema_drift_strictly() {
        // output_tokens disagreeing with thinking + response is drift.
        let drifted = encode_well_formed_generation(&json!({
            "response_id": "resp_drift", "input_tokens": 10, "output_tokens": 9,
            "thinking_output_tokens": 4, "response_output_tokens": 6
        }));
        assert_eq!(parse_generation(&drifted, Layout::Legacy), Err(Mismatch));
        assert_eq!(parse_generation(&drifted, Layout::Cli), Err(Mismatch));
        // Missing response_id: no dedup key, no event.
        let no_id = encode_well_formed_generation(&json!({
            "input_tokens": 10, "output_tokens": 5
        }));
        assert_eq!(parse_generation(&no_id, Layout::Legacy), Err(Mismatch));
        // A blob without the ChatModel wrapper is not a usage row.
        assert_eq!(parse_generation(&encode::varint_field(2, 7), Layout::Legacy), Ok(None));
        // Truncated and wrong-wire blobs fail as mismatches.
        let truncated = encode_well_formed_generation(&json!({
            "response_id": "resp_cut", "input_tokens": 10, "output_tokens": 5
        }));
        assert_eq!(
            parse_generation(&truncated[..truncated.len() - 3], Layout::Legacy),
            Err(Mismatch)
        );
    }

    #[test]
    fn gen_metadata_field_two_wire_shape_follows_the_layout() {
        // Legacy [RE] shape: field 2 is a bare varint; the 1.5.9 packed form
        // is drift there (the 1.3 fixture's wrong_wire sample).
        assert_eq!(parse_generation(&encode::varint_field(2, 7), Layout::Legacy), Ok(None));
        assert_eq!(parse_generation(&encode::bytes_field(2, b"150"), Layout::Legacy), Err(Mismatch));
        // 1.5.9 shape: field 2 is packed/length-delimited and the new
        // unknown field 8 rides along; the bare varint is drift there (the
        // 1.5.9 fixture's wrong_wire sample uses field 4, same rule).
        let mut cli_blob = encode::bytes_field(2, &encode::packed_varints(&[1]));
        cli_blob.extend(encode::bytes_field(8, b"unknown-1.5.9-submessage"));
        assert_eq!(parse_generation(&cli_blob, Layout::Cli), Ok(None));
        assert_eq!(parse_generation(&encode::varint_field(2, 7), Layout::Cli), Err(Mismatch));
        // Field 4 stays a length-delimited uuid on both layouts.
        assert_eq!(parse_generation(&encode::varint_field(4, 7), Layout::Cli), Err(Mismatch));
        assert_eq!(parse_generation(&encode::varint_field(4, 7), Layout::Legacy), Err(Mismatch));
    }

    #[test]
    fn cli_layout_sources_dedup_across_both_roots_with_attribution() {
        let home = tempfile::tempdir().unwrap();
        write_fixture(home.path());
        write_cli_fixture(home.path());
        let found = sources(home.path()).unwrap();
        // The cli root is scanned first (its two roots by rowid DESC), then
        // the legacy root; ids never repeat and the child never lists.
        let ids: Vec<&str> = found
            .iter()
            .map(|source| source.native_id.as_deref().unwrap())
            .collect();
        assert_eq!(ids, vec![CLI_RUNNING_ID, CLI_ROOT_ID, ROOT_ID], "{found:?}");
        let cli_root = super::super::cli_data_root(home.path());
        let legacy_root = super::super::data_root(home.path());
        for source in &found {
            let from_cli = [CLI_ROOT_ID, CLI_RUNNING_ID].contains(&source.native_id.as_deref().unwrap_or(""));
            let expected = if from_cli { &cli_root } else { &legacy_root };
            assert_eq!(source.path, expected.join("conversation_summaries.db"));
            if from_cli {
                assert!(source.fingerprint.starts_with("antigravity-session-cli-v1|"));
            } else {
                // The legacy prefix keeps existing cached indexes valid.
                assert!(source.fingerprint.starts_with("antigravity-session-v3|"));
            }
        }
        assert!(found.iter().all(|source| source.native_id.as_deref() != Some(CLI_CHILD_ID)));
        // The same id stored in both roots keeps the live (cli) copy only,
        // still attributed to the cli index.
        let index = Connection::open(cli_root.join("conversation_summaries.db")).unwrap();
        index
            .execute(
                "INSERT INTO conversation_summaries (conversation_id, title, parent_conversation_id)
                 VALUES (?1, ?2, NULL)",
                params![ROOT_ID, "旧根 id 的 1.5.9 副本"],
            )
            .unwrap();
        drop(index);
        let deduped = sources(home.path()).unwrap();
        assert_eq!(deduped.len(), 3, "{deduped:?}");
        let copies: Vec<_> = deduped
            .iter()
            .filter(|source| source.native_id.as_deref() == Some(ROOT_ID))
            .collect();
        assert_eq!(copies.len(), 1);
        assert_eq!(copies[0].path, cli_root.join("conversation_summaries.db"));
        assert_eq!(copies[0].native_title.as_deref(), Some("旧根 id 的 1.5.9 副本"));
    }

    #[test]
    fn cli_root_conversation_parses_timeline_gen_usage_and_child_fallback() {
        let home = tempfile::tempdir().unwrap();
        write_cli_fixture(home.path());
        let found = sources(home.path()).unwrap();
        let root_source = found
            .iter()
            .find(|source| source.native_id.as_deref() == Some(CLI_ROOT_ID))
            .unwrap();
        let session = parse(root_source).unwrap();
        assert_eq!(session.native_id.as_deref(), Some(CLI_ROOT_ID));
        assert_eq!(session.title, "把探针脚本改成幂等版本");
        assert_eq!(session.cwd.as_deref(), Some("/home/example/fixture-project"));
        // Only USER_INPUT and PLANNER_RESPONSE enter the 1.5.9 timeline; the
        // GENERIC and SYSTEM_MESSAGE rows stay out.
        let roles: Vec<&str> = session.messages.iter().map(|message| message.role.as_str()).collect();
        assert_eq!(roles, vec!["user", "assistant"]);
        assert!(session.messages.iter().all(|message| !message.text.contains("GENERIC")));
        assert!(session.messages.iter().all(|message| !message.text.contains("系统提示行")));
        // gen_metadata stays the usage source while present: the packed
        // field 2 and unknown field 8 rows parse; the wrong-wire field 4 row
        // skips with partial.
        assert!(session.partial, "错型行必须降级 partial");
        assert_eq!(session.model.as_deref(), Some("gemini-4-carbon-medium"));
        let first = session.usage.iter().find(|event| event.id == "resp_1590001_agy_fixture").unwrap();
        assert_eq!(first.input, Some(1_200));
        assert_eq!(first.output, Some(300));
        assert_eq!(first.cache_read, Some(8_000));
        assert_eq!(first.cache_write, Some(3_000));
        assert!(!first.input_includes_cache);
        assert_eq!(first.timestamp, Some(1_791_000_010_000));
        let second = session.usage.iter().find(|event| event.id == "resp_1590002_agy_fixture").unwrap();
        assert_eq!(second.input, Some(500));
        assert_eq!(second.model.as_deref(), Some("Gemini 4 Carbon (Medium)"));
        // The root transcript row carrying the same counters adds nothing
        // while the gen database exists.
        assert!(!session.usage.iter().any(|event| event.id == format!("{CLI_ROOT_ID}:tr:1")));
        // Child: transcript attached; its missing usage database falls back
        // to the transcript counters with subagent attribution.
        assert_eq!(session.children.len(), 1);
        assert_eq!(session.children[0].key, CLI_CHILD_ID);
        assert_eq!(session.children[0].name.as_deref(), Some("research: 检查重复资源"));
        assert!(session.children[0].readable);
        assert_eq!(session.children[0].messages.len(), 1);
        assert!(session.children[0].messages[0].text.contains("子会话时间线"));
        assert!(session.messages.iter().all(|message| !message.text.contains("子会话时间线")));
        let child_event = session
            .usage
            .iter()
            .find(|event| event.id == format!("{CLI_CHILD_ID}:tr:0"))
            .unwrap();
        assert_eq!(child_event.input, Some(2_100));
        assert_eq!(child_event.output, Some(90));
        assert_eq!(child_event.cache_read, Some(11_000));
        assert_eq!(child_event.cache_write, None, "转录侧无 cache_write 字段，保持未知");
        assert_eq!(child_event.model.as_deref(), Some("gemini-4-carbon-medium"));
        assert!(!child_event.input_includes_cache);
        assert_eq!(child_event.attributions.len(), 1);
        assert_eq!(child_event.attributions[0].kind, AgentKind::Subagent);
        assert_eq!(child_event.attributions[0].session_key.as_deref(), Some(CLI_CHILD_ID));
        assert_eq!(session.usage.len(), 3, "{:?}", session.usage.iter().map(|event| event.id.as_str()).collect::<Vec<_>>());
    }

    #[test]
    fn cli_missing_usage_database_falls_back_to_transcript_counters() {
        let home = tempfile::tempdir().unwrap();
        write_cli_fixture(home.path());
        let found = sources(home.path()).unwrap();
        std::fs::remove_file(conversation_db(&super::super::cli_data_root(home.path()), CLI_ROOT_ID))
            .unwrap();
        let root_source = found
            .iter()
            .find(|source| source.native_id.as_deref() == Some(CLI_ROOT_ID))
            .unwrap();
        let session = parse(root_source).unwrap();
        assert!(session.partial, "缺用量库仍是 partial");
        assert_eq!(session.messages.len(), 2);
        assert!(session.usage.iter().all(|event| !event.id.contains("resp_")));
        let root_event = session
            .usage
            .iter()
            .find(|event| event.id == format!("{CLI_ROOT_ID}:tr:1"))
            .unwrap();
        assert_eq!(root_event.input, Some(1_200));
        assert_eq!(root_event.output, Some(300));
        assert_eq!(root_event.cache_read, Some(8_000));
        assert_eq!(root_event.cache_write, None);
        assert_eq!(root_event.model.as_deref(), Some("gemini-4-carbon-medium"));
        assert_eq!(root_event.timestamp, Some(1_791_000_010_000));
        assert!(root_event.attributions.is_empty());
        // The child fallback keeps its subagent attribution.
        let child_event = session
            .usage
            .iter()
            .find(|event| event.id == format!("{CLI_CHILD_ID}:tr:0"))
            .unwrap();
        assert_eq!(child_event.input, Some(2_100));
        assert_eq!(child_event.attributions[0].session_key.as_deref(), Some(CLI_CHILD_ID));
        assert_eq!(session.usage.len(), 2, "{:?}", session.usage);
    }

    #[test]
    fn cli_running_conversation_without_materials_stays_partial_but_readable() {
        let home = tempfile::tempdir().unwrap();
        write_cli_fixture(home.path());
        let found = sources(home.path()).unwrap();
        let running = found
            .iter()
            .find(|source| source.native_id.as_deref() == Some(CLI_RUNNING_ID))
            .unwrap();
        let session = parse(running).unwrap();
        assert_eq!(session.native_id.as_deref(), Some(CLI_RUNNING_ID));
        assert_eq!(session.title, "仍在运行的探针会话");
        assert_eq!(session.cwd.as_deref(), Some("/home/example/another-fixture"));
        assert!(session.messages.is_empty());
        assert!(session.usage.is_empty());
        assert!(session.partial, "缺失转录与用量库都降级 partial");
        assert!(session.children.is_empty());
    }

    #[test]
    fn cli_conversation_parents_table_links_a_child_without_the_column() {
        let home = tempfile::tempdir().unwrap();
        write_cli_fixture(home.path());
        let root = super::super::cli_data_root(home.path());
        let linked = "conv_159_linked_0000000000000000000d4";
        let index = Connection::open(root.join("conversation_summaries.db")).unwrap();
        index
            .execute(
                "INSERT INTO conversation_summaries (conversation_id, title, parent_conversation_id)
                 VALUES (?1, ?2, NULL)",
                params![linked, "task: 表链接的子会话"],
            )
            .unwrap();
        index
            .execute(
                "INSERT INTO conversation_parents (conversation_id, parent_id) VALUES (?1, ?2)",
                params![linked, CLI_ROOT_ID],
            )
            .unwrap();
        drop(index);
        let transcript = transcript_path(&root, linked);
        std::fs::create_dir_all(transcript.parent().unwrap()).unwrap();
        std::fs::write(
            &transcript,
            "{\"step_index\":0,\"type\":\"PLANNER_RESPONSE\",\"source\":\"MODEL\",\"status\":\"DONE\",\
             \"created_at\":1791000060000,\"content\":\"表链接子会话正文\",\
             \"model\":\"gemini-4-carbon-medium\",\"input_tokens\":5,\"output_tokens\":2,\"cache_read_tokens\":9}\n",
        )
        .unwrap();
        let found = sources(home.path()).unwrap();
        assert!(
            found.iter().all(|source| source.native_id.as_deref() != Some(linked)),
            "conversation_parents 链接的子行不独立列出：{found:?}"
        );
        let root_source = found
            .iter()
            .find(|source| source.native_id.as_deref() == Some(CLI_ROOT_ID))
            .unwrap();
        let session = parse(root_source).unwrap();
        let child = session.children.iter().find(|child| child.key == linked).unwrap();
        assert!(child.readable);
        assert_eq!(child.name.as_deref(), Some("task: 表链接的子会话"));
        assert_eq!(child.messages.len(), 1);
        let event = session
            .usage
            .iter()
            .find(|event| event.id == format!("{linked}:tr:0"))
            .unwrap();
        assert_eq!(event.input, Some(5));
        assert_eq!(event.output, Some(2));
        assert_eq!(event.cache_read, Some(9));
        assert_eq!(event.attributions[0].session_key.as_deref(), Some(linked));
    }

    fn write_child_usage(root: &std::path::Path, id: &str, response_id: &str, input: u64) {
        let database = conversation_db(root, id);
        std::fs::create_dir_all(database.parent().unwrap()).unwrap();
        let usage = Connection::open(&database).unwrap();
        usage.execute_batch("CREATE TABLE gen_metadata (key TEXT, data BLOB);").unwrap();
        let row = json!({
            "response_id": response_id,
            "generation_uuid": format!("cascade:{response_id}"),
            "input_tokens": input, "output_tokens": 4,
            "thinking_output_tokens": 1, "response_output_tokens": 3,
            "cache_write_tokens": 0, "cache_read_tokens": 0,
            "model_id": "gemini-3-pro-preview", "timestamp": 1791000040000u64
        });
        usage.execute(
            "INSERT INTO gen_metadata (key, data) VALUES (?1, ?2)",
            params![format!("cascade:{response_id}"), encode_well_formed_generation(&row)],
        ).unwrap();
    }

    fn write_transcript(root: &std::path::Path, id: &str, content: &str) {
        let transcript = transcript_path(root, id);
        std::fs::create_dir_all(transcript.parent().unwrap()).unwrap();
        std::fs::write(
            &transcript,
            format!("{{\"type\":\"AGENT_RESPONSE\",\"content\":\"{content}\"}}\n"),
        ).unwrap();
    }

    /// Denies traverse on a directory. Listing its parent can still succeed,
    /// while a file inside fails attribute reads. Denying the file itself does
    /// not fail attribute reads on this Windows.
    struct DenyStat { path: PathBuf }

    impl DenyStat {
        fn new(path: &std::path::Path) -> Self {
            #[cfg(windows)]
            {
                let user = std::env::var("USERNAME").expect("USERNAME");
                let status = std::process::Command::new("icacls").arg(path).arg("/inheritance:r").status().unwrap();
                assert!(status.success(), "icacls inheritance");
                let status = std::process::Command::new("icacls")
                    .arg(path)
                    .arg("/deny")
                    .arg(format!("{user}:(RX)"))
                    .status()
                    .unwrap();
                assert!(status.success(), "icacls deny");
            }
            #[cfg(not(windows))]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o0)).unwrap();
            }
            Self { path: path.to_path_buf() }
        }
    }

    impl Drop for DenyStat {
        fn drop(&mut self) {
            #[cfg(windows)]
            {
                let _ = std::process::Command::new("icacls").arg(&self.path).arg("/reset").status();
                let _ = std::process::Command::new("icacls").arg(&self.path).arg("/inheritance:e").status();
            }
            #[cfg(not(windows))]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o755));
            }
        }
    }

    fn symlink_file(target: &std::path::Path, link: &std::path::Path) {
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(target, link).unwrap();
        #[cfg(not(windows))]
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    #[test]
    fn missing_child_material_stays_missing_without_a_fingerprint_error() {
        let home = tempfile::tempdir().unwrap();
        write_fixture(home.path());
        let found = sources(home.path()).unwrap();
        assert!(found[0].fingerprint_error.is_none(), "{:?}", found[0].fingerprint_error);
        assert!(found[0].fingerprint.contains("missing"), "{}", found[0].fingerprint);
        assert!(!found[0].fingerprint.contains("unread:"), "{}", found[0].fingerprint);
        assert!(sources_controlled(home.path(), &|| true).unwrap_err().contains("扫描已取消"));
        let error = child_file_stamp(
            &transcript_path(&super::super::data_root(home.path()), CHILD_ID),
            &|| true,
        )
        .unwrap_err();
        assert!(error.contains("扫描已取消"), "{error}");
    }

    #[test]
    fn parent_transcript_stat_failure_is_still_a_fingerprint_error() {
        let home = tempfile::tempdir().unwrap();
        write_fixture(home.path());
        let transcript = transcript_path(&super::super::data_root(home.path()), ROOT_ID);
        let _deny = DenyStat::new(transcript.parent().unwrap());
        let stat_error = std::fs::symlink_metadata(&transcript).expect_err("测试必须让父 transcript 的属性读取失败");
        assert_ne!(stat_error.kind(), std::io::ErrorKind::NotFound, "{stat_error}");
        let found = sources(home.path()).unwrap();
        assert_eq!(found.len(), 1);
        assert!(found[0].fingerprint_error.is_some(), "父会话自身材料失败必须写入 fingerprint_error：{found:?}");
        assert!(found[0].fingerprint.is_empty());
    }

    #[test]
    fn unreadable_child_transcript_keeps_the_parent_and_known_attribution() {
        let home = tempfile::tempdir().unwrap();
        write_fixture(home.path());
        let root = super::super::data_root(home.path());
        write_child_usage(&root, CHILD_ID, "resp_child_agy_fixture", 11);
        let sibling = "conv_sibling_20261005_aabbccddeeff001122334455667788";
        let index = Connection::open(root.join("conversation_summaries.db")).unwrap();
        index.execute(
            "INSERT INTO conversation_summaries (id, title, workspace, status, parent_conversation_id)
             VALUES (?1, 'task: 兄弟子会话', ?2, 'active', ?3)",
            params![sibling, r"C:\Users\example\agy-demo", ROOT_ID],
        ).unwrap();
        drop(index);
        write_transcript(&root, sibling, "兄弟子会话正文");
        write_child_usage(&root, sibling, "resp_sibling_agy_fixture", 7);
        let blocked = transcript_path(&root, CHILD_ID);
        let blocked_fingerprint = {
            let _deny = DenyStat::new(blocked.parent().unwrap());
            let stat_error = std::fs::symlink_metadata(&blocked).expect_err("测试必须让子 transcript 的属性读取失败");
            assert_ne!(stat_error.kind(), std::io::ErrorKind::NotFound, "{stat_error}");
            let found = sources(home.path()).unwrap();
            assert_eq!(found.len(), 1);
            assert!(found[0].fingerprint_error.is_none(), "{:?}", found[0].fingerprint_error);
            assert!(found[0].fingerprint.contains("unread:"), "{}", found[0].fingerprint);
            let session = parse(&found[0]).unwrap();
            assert_eq!(session.native_id.as_deref(), Some(ROOT_ID));
            assert_eq!(session.messages.len(), 3);
            assert!(session.messages.iter().all(|message| {
                !message.text.contains("子会话时间线") && !message.text.contains("兄弟子会话正文")
            }));
            let denied = session.children.iter().find(|child| child.key == CHILD_ID).unwrap();
            assert!(!denied.readable);
            assert!(denied.messages.is_empty());
            assert_eq!(denied.name.as_deref(), Some("task: 检查重复资源"));
            let child_event = session.usage.iter().find(|event| event.id == "resp_child_agy_fixture").unwrap();
            assert_eq!(child_event.attributions[0].session_key.as_deref(), Some(CHILD_ID));
            let sibling_node = session.children.iter().find(|child| child.key == sibling).unwrap();
            assert!(sibling_node.readable, "{:?}", session.children);
            assert_eq!(sibling_node.messages[0].text, "兄弟子会话正文");
            assert!(session.usage.iter().any(|event| event.id == "resp_sibling_agy_fixture"));
            found[0].fingerprint.clone()
        };
        let found = sources(home.path()).unwrap();
        assert!(found[0].fingerprint_error.is_none(), "{:?}", found[0].fingerprint_error);
        assert_ne!(found[0].fingerprint, blocked_fingerprint, "子文件恢复可读后父指纹必须变化");
        let session = parse(&found[0]).unwrap();
        let denied = session.children.iter().find(|child| child.key == CHILD_ID).unwrap();
        assert!(denied.readable);
        assert!(denied.messages[0].text.contains("子会话时间线"));
        assert!(session.messages.iter().all(|message| !message.text.contains("子会话时间线")));
    }

    #[test]
    fn unreadable_child_usage_stamp_keeps_the_parent() {
        let home = tempfile::tempdir().unwrap();
        write_fixture(home.path());
        let root = super::super::data_root(home.path());
        write_child_usage(&root, CHILD_ID, "resp_child_agy_fixture", 11);
        let database = conversation_db(&root, CHILD_ID);
        let mut wal_name = database.as_os_str().to_os_string();
        wal_name.push("-wal");
        let wal = PathBuf::from(wal_name);
        let wal_real = wal.parent().unwrap().join(format!("{}.real", wal.file_name().unwrap().to_string_lossy()));
        std::fs::write(&wal_real, b"wal").unwrap();
        symlink_file(&wal_real, &wal);
        let found = sources(home.path()).unwrap();
        assert!(found[0].fingerprint_error.is_none(), "{:?}", found[0].fingerprint_error);
        assert!(found[0].fingerprint.contains("unread:"), "{}", found[0].fingerprint);
        let session = parse(&found[0]).unwrap();
        assert_eq!(session.native_id.as_deref(), Some(ROOT_ID));
        assert_eq!(session.messages.len(), 3);
        assert!(session.messages.iter().all(|message| !message.text.contains("子会话时间线")));
        assert_eq!(session.children.len(), 1);
        assert!(session.partial);
        assert!(session.children[0].readable);
        assert!(session.children[0].messages[0].text.contains("子会话时间线"));
        assert_eq!(session.children[0].name.as_deref(), Some("task: 检查重复资源"));
        assert!(session.usage.iter().all(|event| event.id != "resp_child_agy_fixture"));
    }

    #[test]
    fn symlinked_child_material_stays_unread_without_following_the_link() {
        let home = tempfile::tempdir().unwrap();
        write_fixture(home.path());
        let root = super::super::data_root(home.path());
        write_child_usage(&root, CHILD_ID, "resp_child_agy_fixture", 11);
        let transcript = transcript_path(&root, CHILD_ID);
        let transcript_real = transcript.with_extension("jsonl.real");
        std::fs::rename(&transcript, &transcript_real).unwrap();
        std::fs::write(&transcript_real, "{\"type\":\"AGENT_RESPONSE\",\"content\":\"符号链接正文不应进入父会话\"}\n").unwrap();
        symlink_file(&transcript_real, &transcript);
        let database = conversation_db(&root, CHILD_ID);
        let database_real = database.with_extension("db.real");
        std::fs::rename(&database, &database_real).unwrap();
        symlink_file(&database_real, &database);
        let found = sources(home.path()).unwrap();
        assert!(found[0].fingerprint_error.is_none(), "{:?}", found[0].fingerprint_error);
        assert!(found[0].fingerprint.contains("unread:"), "{}", found[0].fingerprint);
        let session = parse(&found[0]).unwrap();
        assert_eq!(session.messages.len(), 3);
        assert!(session.messages.iter().all(|message| !message.text.contains("符号链接")));
        assert_eq!(session.children.len(), 1);
        assert!(!session.children[0].readable);
        assert!(session.children[0].messages.is_empty());
        assert_eq!(session.children[0].name.as_deref(), Some("task: 检查重复资源"));
        assert!(session.usage.iter().all(|event| event.id != "resp_child_agy_fixture"));
        let parent_transcript = transcript_path(&root, ROOT_ID);
        let parent_real = parent_transcript.with_extension("jsonl.real");
        std::fs::rename(&parent_transcript, &parent_real).unwrap();
        symlink_file(&parent_real, &parent_transcript);
        let parent = sources(home.path()).unwrap();
        assert!(parent[0].fingerprint_error.is_some(), "父会话自身符号链接必须写入 fingerprint_error：{parent:?}");
    }
}
