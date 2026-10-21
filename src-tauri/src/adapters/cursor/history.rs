//! Cursor Agent transcripts, read-only:
//! `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`.
//!
//! Verified on a local desktop install. A parent file is one Agent session.
//! Rows are `{role, message:{content:[{type,text|name}]}}`. `turn_ended` rows
//! carry no conversation. User text is the `<user_query>` body. A leading
//! `<timestamp>` is the user message time; later replies in that turn reuse it.
//! The file has no model and no token counters, so those stay unknown and are
//! not stored as zero. Nested `subagents/*.jsonl` files are not separate
//! sessions. A file is a child body only when every row matches this parent
//! shape; any other shape is an unreadable child and adds no usage.
//!
//! The project directory is recorded only when a `workspace.json` folder URI
//! slugs to that project directory. The login database is not opened.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde_json::Value;

use crate::history::{
    check_cancelled, read_jsonl_filtered, source_fingerprint_controlled, text_content,
    valid_native_id, ChildSession, HistoryMessage, HistoryMessageKind, HistorySource,
    MessageTimeSource, ParsedSession, EMPTY_SESSION, MAX_SOURCES,
};

const PARSER_VERSION: &str = "cursor-agent-transcript-v3";

pub fn sources(home: &Path) -> Result<Vec<HistorySource>, String> {
    sources_controlled(home, &|| false)
}

pub fn sources_controlled(
    home: &Path,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<HistorySource>, String> {
    check_cancelled(cancelled)?;
    let root = home.join(".cursor").join("projects");
    if !root.exists() {
        return Ok(Vec::new());
    }
    let metadata = fs::symlink_metadata(&root).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Cursor 会话目录不可读取".into());
    }
    let mut result = Vec::new();
    for slug in fs::read_dir(&root).map_err(|error| error.to_string())? {
        check_cancelled(cancelled)?;
        let slug = slug.map_err(|error| error.to_string())?;
        if !is_real_dir(&slug.path()) {
            continue;
        }
        let transcripts = slug.path().join("agent-transcripts");
        if !is_real_dir(&transcripts) {
            continue;
        }
        for session in fs::read_dir(&transcripts).map_err(|error| error.to_string())? {
            check_cancelled(cancelled)?;
            let session = session.map_err(|error| error.to_string())?;
            let directory = session.path();
            if !is_real_dir(&directory) {
                continue;
            }
            let Some(name) = directory.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            if !valid_native_id(name) {
                continue;
            }
            let path = directory.join(format!("{name}.jsonl"));
            let Ok(file_meta) = fs::symlink_metadata(&path) else {
                continue;
            };
            if file_meta.file_type().is_symlink() || !file_meta.is_file() {
                continue;
            }
            let (fingerprint, fingerprint_error) = match transcript_fingerprint(&path, cancelled) {
                Ok(value) => (value, None),
                Err(error) => (String::new(), Some(error)),
            };
            result.push(HistorySource {
                native_title: None,
                path,
                native_id: Some(name.to_owned()),
                fingerprint,
                fingerprint_error,
            });
            if result.len() > MAX_SOURCES {
                return Err("Cursor 会话源超过 5000 个，本次未删除旧索引".into());
            }
        }
    }
    result.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(result)
}

pub fn parse(source: &HistorySource) -> Result<ParsedSession, String> {
    parse_controlled(source, &|| false)
}

pub fn parse_controlled(
    source: &HistorySource,
    cancelled: &dyn Fn() -> bool,
) -> Result<ParsedSession, String> {
    parse_with(source, &platform_workspace_roots(), cancelled)
}

fn parse_with(
    source: &HistorySource,
    workspace_roots: &[PathBuf],
    cancelled: &dyn Fn() -> bool,
) -> Result<ParsedSession, String> {
    check_cancelled(cancelled)?;
    let mut session = ParsedSession::new();
    session.native_id = source.native_id.clone();
    session.updated_at = modified_millis(&source.path);
    if let Some(slug) = project_slug_of_transcript(&source.path) {
        session.cwd = proven_directories(workspace_roots)
            .get(&slug)
            .map(|path| path.display().to_string());
    }
    let mut turn = None;
    let partial = read_jsonl_filtered(source, cancelled, skip_turn_ended, |index, row| {
        let role = row.get("role").and_then(Value::as_str).unwrap_or("");
        if role != "user" && role != "assistant" {
            return;
        }
        let text = row.get("message").map(message_text).unwrap_or_default();
        let (text, time, source) = if role == "user" {
            let time = message_timestamp(&text);
            turn = time;
            (user_query(&text).unwrap_or_default(), time, MessageTimeSource::Native)
        } else {
            (text, turn, MessageTimeSource::Turn)
        };
        let before = session.messages.len();
        session.add_message(format!("line-{index}"), role, text, time);
        if let Some(message) = session.messages.get_mut(before) {
            if message.timestamp.is_some() {
                message.timestamp_source = source;
            }
        }
    })?;
    session.partial |= partial;
    attach_subagents(&mut session, &source.path, cancelled)?;
    if session.messages.is_empty() {
        return Err(if session.partial {
            "未识别到可展示的会话记录".into()
        } else {
            EMPTY_SESSION.into()
        });
    }
    session.finish(source)
}

fn transcript_fingerprint(path: &Path, cancelled: &dyn Fn() -> bool) -> Result<String, String> {
    // Only the parent transcript's own fingerprint failure skips the scan.
    // A subagents listing or child stamp failure stays in the parent stamp.
    let parent = source_fingerprint_controlled(path, cancelled)?;
    let mut rows = Vec::new();
    if let Some(directory) = path.parent() {
        rows.extend(child_fingerprint_parts(&directory.join("subagents"), cancelled)?);
    }
    rows.sort();
    Ok(format!("{PARSER_VERSION}|{parent}|{}", rows.join("|")))
}

fn child_fingerprint_parts(subagents: &Path, cancelled: &dyn Fn() -> bool) -> Result<Vec<String>, String> {
    let subagents = match child_directory(subagents) {
        Ok(Some(path)) => path,
        Ok(None) => return Ok(Vec::new()),
        Err(error) if cancelled() || scan_cancelled(&error) => return Err(error),
        Err(_) => return Ok(vec![format!("children-unread:{}", unread_material_stamp(subagents))]),
    };
    let entries = match fs::read_dir(&subagents) {
        Ok(entries) => entries,
        Err(error) if cancelled() || scan_cancelled(&error.to_string()) => return Err(error.to_string()),
        Err(_) => return Ok(vec![format!("children-unread:{}", unread_material_stamp(&subagents))]),
    };
    let mut rows = Vec::new();
    let mut unread_dir = false;
    for entry in entries {
        check_cancelled(cancelled)?;
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) if cancelled() || scan_cancelled(&error.to_string()) => return Err(error.to_string()),
            Err(_) => {
                unread_dir = true;
                continue;
            }
        };
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !name.ends_with(".jsonl") {
            continue;
        }
        let metadata = match fs::symlink_metadata(entry.path()) {
            Ok(metadata) => metadata,
            Err(error) if cancelled() || scan_cancelled(&error.to_string()) => return Err(error.to_string()),
            Err(_) => {
                rows.push(format!("{name}:{}", unread_material_stamp(&entry.path())));
                continue;
            }
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            continue;
        }
        rows.push(format!("{name}:{}", child_material_stamp(&entry.path(), cancelled)?));
    }
    if unread_dir {
        rows.push(format!("children-unread:{}", unread_material_stamp(&subagents)));
    }
    Ok(rows)
}

/// `Ok(None)` is a missing or non-directory child folder. Stat failures are
/// listing failures so the parent stays indexed with an unread child.
fn child_directory(path: &Path) -> Result<Option<PathBuf>, String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) if scan_cancelled(&error.to_string()) => Err(error.to_string()),
        Err(error) => Err(error.to_string()),
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => Ok(None),
        Ok(_) => Ok(Some(path.to_path_buf())),
    }
}

fn scan_cancelled(error: &str) -> bool {
    error.contains("扫描已取消")
}

fn unread_material_stamp(path: &Path) -> String {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return format!("unread:{}", path.display());
    };
    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    format!("unread:{}:{modified}:{}", metadata.len(), path.display())
}

fn child_material_stamp(path: &Path, cancelled: &dyn Fn() -> bool) -> Result<String, String> {
    check_cancelled(cancelled)?;
    // Attribute metadata can succeed while a sharing lock still blocks the
    // body. The unread prefix keeps the parent fingerprint different until
    // the body can be opened again.
    let stamp = match source_fingerprint_controlled(path, cancelled) {
        Ok(stamp) => stamp,
        Err(error) if cancelled() || scan_cancelled(&error) => return Err(error),
        Err(_) => return Ok(unread_material_stamp(path)),
    };
    if fs::File::open(path).is_ok() {
        Ok(stamp)
    } else if cancelled() {
        Err("扫描已取消，原索引已保留".into())
    } else {
        Ok(format!("unread:{stamp}"))
    }
}

fn subagent_files(session_dir: &Path) -> Result<Vec<PathBuf>, String> {
    let Some(root) = child_directory(&session_dir.join("subagents"))? else {
        return Ok(Vec::new());
    };
    let mut files = Vec::new();
    for entry in fs::read_dir(&root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            continue;
        };
        if !name.ends_with(".jsonl") {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path()).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            continue;
        }
        files.push(entry.path());
    }
    files.sort();
    Ok(files)
}

fn child_key(path: &Path) -> Option<String> {
    let key = path.file_stem()?.to_str()?.trim().to_owned();
    if key.is_empty() || key.len() > 512 || key.chars().any(|ch| ch.is_control()) {
        None
    } else {
        Some(key)
    }
}

/// Parent rows are `{role, message:{content:[{type,text|name,input}]}}` or
/// `{type:"turn_ended", status?}`. Any other key or part is not this shape.
fn fixed_transcript_text(row: &Value) -> Result<Option<(&str, String)>, ()> {
    let object = row.as_object().ok_or(())?;
    if object.contains_key("type") {
        if object.get("type").and_then(Value::as_str) != Some("turn_ended") {
            return Err(());
        }
        if object.keys().any(|key| key != "type" && key != "status") {
            return Err(());
        }
        if object.get("status").is_some_and(|status| !status.is_string()) {
            return Err(());
        }
        return Ok(None);
    }
    let role = object.get("role").and_then(Value::as_str).ok_or(())?;
    if role != "user" && role != "assistant" {
        return Err(());
    }
    if object.len() != 2 || !object.contains_key("message") {
        return Err(());
    }
    let message = object.get("message").and_then(Value::as_object).ok_or(())?;
    if message.len() != 1 {
        return Err(());
    }
    let content = message.get("content").and_then(Value::as_array).ok_or(())?;
    for part in content {
        let part = part.as_object().ok_or(())?;
        match part.get("type").and_then(Value::as_str).ok_or(())? {
            "text" => {
                if part.keys().any(|key| key != "type" && key != "text") {
                    return Err(());
                }
                if part.get("text").is_some_and(|text| !text.is_string()) {
                    return Err(());
                }
            }
            "tool_use" => {
                if part.keys().any(|key| key != "type" && key != "name" && key != "input") {
                    return Err(());
                }
                if part.get("name").is_some_and(|name| !name.is_string()) {
                    return Err(());
                }
            }
            _ => return Err(()),
        }
    }
    Ok(Some((role, message_text(object.get("message").unwrap()))))
}

fn read_child_body(path: &Path, cancelled: &dyn Fn() -> bool) -> Result<Vec<HistoryMessage>, String> {
    let source = HistorySource {
        native_title: None,
        path: path.to_path_buf(),
        native_id: None,
        fingerprint: String::new(),
        fingerprint_error: None,
    };
    let mut messages = Vec::new();
    let mut turn = None;
    let mut rejected = false;
    let mut saw_row = false;
    let partial = read_jsonl_filtered(&source, cancelled, |_| false, |index, row| {
        if rejected {
            return;
        }
        saw_row = true;
        let Ok(parsed) = fixed_transcript_text(&row) else {
            rejected = true;
            return;
        };
        let Some((role, raw)) = parsed else {
            return;
        };
        let (text, time, source) = if role == "user" {
            let time = message_timestamp(&raw);
            turn = time;
            (user_query(&raw).unwrap_or_default(), time, MessageTimeSource::Native)
        } else {
            (raw, turn, MessageTimeSource::Turn)
        };
        if text.trim().is_empty() {
            return;
        }
        messages.push(HistoryMessage {
            id: format!("line-{index}"),
            role: role.to_owned(),
            text,
            timestamp: time,
            timestamp_source: if time.is_some() { source } else { MessageTimeSource::Unknown },
            kind: HistoryMessageKind::Conversation,
        });
    })?;
    if partial || rejected || !saw_row {
        return Err("Cursor 子日志不可读".into());
    }
    Ok(messages)
}

fn attach_subagents(
    session: &mut ParsedSession,
    transcript: &Path,
    cancelled: &dyn Fn() -> bool,
) -> Result<(), String> {
    let Some(directory) = transcript.parent() else {
        return Ok(());
    };
    let files = match subagent_files(directory) {
        Ok(files) => files,
        Err(error) if cancelled() || scan_cancelled(&error) => return Err(error),
        Err(_) => {
            session.children.push(unreadable_child("child"));
            return Ok(());
        }
    };
    for path in files {
        check_cancelled(cancelled)?;
        let Some(key) = child_key(&path) else {
            continue;
        };
        let (readable, messages) = match read_child_body(&path, cancelled) {
            Ok(messages) => (true, messages),
            Err(error) if cancelled() || scan_cancelled(&error) => return Err(error),
            Err(_) => (false, Vec::new()),
        };
        session.children.push(ChildSession {
            key,
            name: None,
            messages,
            readable,
            children: Vec::new(),
        });
    }
    Ok(())
}

fn unreadable_child(key: &str) -> ChildSession {
    ChildSession {
        key: key.to_owned(),
        name: None,
        messages: Vec::new(),
        readable: false,
        children: Vec::new(),
    }
}

fn is_real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .ok()
        .is_some_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
}

fn skip_turn_ended(prefix: &[u8]) -> bool {
    let text = std::str::from_utf8(prefix).unwrap_or("");
    let trimmed = text.trim_start();
    trimmed.starts_with("{\"type\":\"turn_ended\"") || trimmed.starts_with("{\"type\": \"turn_ended\"")
}

fn message_text(message: &Value) -> String {
    message
        .get("content")
        .map(text_content)
        .filter(|text| !text.trim().is_empty())
        .or_else(|| message.as_str().map(str::to_owned))
        .unwrap_or_default()
}

/// The verified user row wraps the typed request in `<user_query>`. Skill and
/// timestamp wrappers around it are not the request.
fn message_timestamp(text: &str) -> Option<i64> {
    let head = text.find("<user_query>").map(|index| &text[..index]).unwrap_or(text);
    let start = head.find("<timestamp>")?;
    let after = &head[start + "<timestamp>".len()..];
    let end = after.find("</timestamp>")?;
    parse_cursor_timestamp(after[..end].trim())
}

fn parse_cursor_timestamp(text: &str) -> Option<i64> {
    if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(text) {
        return Some(parsed.timestamp_millis());
    }
    let mut parts = text.split(", ");
    let _weekday = parts.next()?;
    let month_day = parts.next()?;
    let year: i32 = parts.next()?.parse().ok()?;
    let rest = parts.next()?;
    if parts.next().is_some() || !(2000..=2100).contains(&year) {
        return None;
    }
    let (month_name, day) = month_day.split_once(' ')?;
    let month = month_number(month_name)?;
    let day: u32 = day.parse().ok()?;
    let (clock, zone) = rest.split_once(" (UTC")?;
    let zone = zone.strip_suffix(')')?;
    let (hhmm, ampm) = clock.rsplit_once(' ')?;
    let (hour, minute) = hhmm.split_once(':')?;
    let hour: u32 = hour.parse().ok()?;
    let minute: u32 = minute.parse().ok()?;
    let hour = match ampm {
        "AM" if hour == 12 => 0,
        "AM" if hour < 12 => hour,
        "PM" if hour == 12 => 12,
        "PM" if hour < 12 => hour + 12,
        _ => return None,
    };
    let offset = offset_seconds(zone)?;
    let date = chrono::NaiveDate::from_ymd_opt(year, month, day)?;
    let time = chrono::NaiveTime::from_hms_opt(hour, minute, 0)?;
    let local = chrono::NaiveDateTime::new(date, time);
    let zone = chrono::FixedOffset::east_opt(offset)?;
    local.and_local_timezone(zone).single().map(|instant| instant.timestamp_millis())
}

fn month_number(name: &str) -> Option<u32> {
    Some(match name {
        "Jan" => 1,
        "Feb" => 2,
        "Mar" => 3,
        "Apr" => 4,
        "May" => 5,
        "Jun" => 6,
        "Jul" => 7,
        "Aug" => 8,
        "Sep" => 9,
        "Oct" => 10,
        "Nov" => 11,
        "Dec" => 12,
        _ => return None,
    })
}

fn offset_seconds(zone: &str) -> Option<i32> {
    let (sign, body) = if let Some(rest) = zone.strip_prefix('+') {
        (1, rest)
    } else if let Some(rest) = zone.strip_prefix('-') {
        (-1, rest)
    } else {
        return None;
    };
    let (hours, minutes) = if let Some((hours, minutes)) = body.split_once(':') {
        (hours.parse::<i32>().ok()?, minutes.parse::<i32>().ok()?)
    } else if body.len() == 4 && body.bytes().all(|byte| byte.is_ascii_digit()) {
        (body[..2].parse().ok()?, body[2..].parse().ok()?)
    } else {
        (body.parse::<i32>().ok()?, 0)
    };
    if !(0..=14).contains(&hours) || !(0..60).contains(&minutes) {
        return None;
    }
    Some(sign * (hours * 3600 + minutes * 60))
}

fn user_query(text: &str) -> Option<String> {
    let mut found = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("<user_query>") {
        let after = &rest[start + "<user_query>".len()..];
        let Some(end) = after.find("</user_query>") else {
            break;
        };
        let body = after[..end].trim();
        if !body.is_empty() {
            found.push(body.to_owned());
        }
        rest = &after[end + "</user_query>".len()..];
    }
    if !found.is_empty() {
        return Some(found.join("\n"));
    }
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    const WRAPPED: [&str; 5] = [
        "<timestamp",
        "<user_instructions",
        "<manually_attached_skills",
        "<environment_context",
        "<system_reminder",
    ];
    if WRAPPED.iter().any(|tag| trimmed.starts_with(tag)) {
        return None;
    }
    Some(trimmed.to_owned())
}

fn modified_millis(path: &Path) -> Option<i64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let millis = modified.duration_since(UNIX_EPOCH).ok()?.as_millis();
    i64::try_from(millis).ok()
}

fn project_slug_of_transcript(path: &Path) -> Option<String> {
    let session = path.parent()?;
    let transcripts = session.parent()?;
    if transcripts.file_name().and_then(|name| name.to_str()) != Some("agent-transcripts") {
        return None;
    }
    transcripts
        .parent()
        .and_then(|slug| slug.file_name())
        .and_then(|name| name.to_str())
        .map(str::to_owned)
}

fn platform_workspace_roots() -> Vec<PathBuf> {
    dirs::config_dir()
        .map(|dir| dir.join("Cursor").join("User").join("workspaceStorage"))
        .into_iter()
        .collect()
}

/// Slug used by `~/.cursor/projects`. A drive letter is lowercased and its
/// colon dropped; every other non-alphanumeric run becomes one hyphen.
pub(crate) fn project_slug(path: &Path) -> String {
    let mut slug = String::new();
    let text = path.to_string_lossy().replace('/', "\\");
    let text = if text.len() >= 2 && text.as_bytes()[1] == b':' {
        let mut owned = String::new();
        owned.push(text.chars().next().unwrap_or_default().to_ascii_lowercase());
        owned.push_str(&text[2..]);
        owned
    } else {
        text
    };
    for ch in text.chars() {
        if ch.is_alphanumeric() {
            slug.push(ch);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    slug.trim_matches('-').to_string()
}

fn proven_directories(roots: &[PathBuf]) -> HashMap<String, PathBuf> {
    let mut found = HashMap::<String, PathBuf>::new();
    let mut ambiguous = HashSet::new();
    for root in roots {
        if !is_real_dir(root) {
            continue;
        }
        let Ok(entries) = fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let file = entry.path().join("workspace.json");
            let Ok(metadata) = fs::symlink_metadata(&file) else {
                continue;
            };
            if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 65_536 {
                continue;
            }
            let Ok(text) = fs::read_to_string(&file) else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            let Some(folder) = value.get("folder").and_then(Value::as_str) else {
                continue;
            };
            let Ok(url) = url::Url::parse(folder) else {
                continue;
            };
            if url.scheme() != "file" {
                continue;
            }
            let Ok(path) = url.to_file_path() else {
                continue;
            };
            let slug = project_slug(&path);
            if slug.is_empty() || ambiguous.contains(&slug) {
                continue;
            }
            if found.get(&slug).is_some_and(|existing| existing != &path) {
                found.remove(&slug);
                ambiguous.insert(slug);
                continue;
            }
            found.insert(slug, path);
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION_ID: &str = "11111111-2222-3333-4444-555555555555";
    const TRANSCRIPT: &str = include_str!("../../../../tests/fixtures/cursor/agent-transcript.jsonl");

    fn write_session(home: &Path) -> (PathBuf, HistorySource) {
        let directory = home
            .join(".cursor")
            .join("projects")
            .join("c-fixture-demo")
            .join("agent-transcripts")
            .join(SESSION_ID);
        fs::create_dir_all(&directory).unwrap();
        let subagents = directory.join("subagents");
        fs::create_dir_all(&subagents).unwrap();
        fs::write(
            subagents.join("99999999-9999-9999-9999-999999999999.jsonl"),
            b"{\"role\":\"user\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"subagent\"}]}}\n",
        )
        .unwrap();
        let path = directory.join(format!("{SESSION_ID}.jsonl"));
        fs::write(&path, TRANSCRIPT).unwrap();
        let source = sources(home).unwrap().into_iter().next().unwrap();
        (path, source)
    }

    #[test]
    fn parent_transcript_lists_title_text_and_unknown_usage() {
        let temp = tempfile::tempdir().unwrap();
        let (path, source) = write_session(temp.path());
        let before = fs::read(&path).unwrap();
        assert_eq!(source.native_id.as_deref(), Some(SESSION_ID));
        assert!(source.fingerprint.starts_with("cursor-agent-transcript-v3|"));
        let parsed = parse_with(&source, &[], &|| false).unwrap();
        assert_eq!(fs::read(&path).unwrap(), before);
        assert_eq!(parsed.title, "修复会话列表");
        let expected = chrono::DateTime::parse_from_rfc3339("2026-10-11T10:00:00Z")
            .unwrap()
            .timestamp_millis();
        assert_eq!(parsed.messages[0].timestamp, Some(expected));
        assert_eq!(parsed.messages[0].timestamp_source, MessageTimeSource::Native);
        assert_eq!(parsed.messages[1].timestamp, Some(expected));
        assert_eq!(parsed.messages[1].timestamp_source, MessageTimeSource::Turn);
        // The skill-only user row has no clock, so it clears the turn.
        assert!(parsed.messages[2].timestamp.is_none());
        assert_eq!(parsed.messages[2].timestamp_source, MessageTimeSource::Unknown);
        assert!(parsed.model.is_none());
        assert!(parsed.usage.is_empty());
        assert!(parsed.cwd.is_none());
        assert!(parsed.partial);
        assert!(parsed.updated_at.is_some());
        let texts: Vec<_> = parsed.messages.iter().map(|item| (item.role.as_str(), item.text.as_str())).collect();
        assert_eq!(
            texts,
            vec![
                ("user", "修复会话列表"),
                ("assistant", "我会查看记录页。"),
                ("assistant", "记录里没有 token。"),
            ]
        );
        assert_eq!(sources(temp.path()).unwrap().len(), 1);
        assert!(parsed.usage.is_empty());
        assert_eq!(parsed.children.len(), 1);
        let child = &parsed.children[0];
        assert_eq!(child.key, "99999999-9999-9999-9999-999999999999");
        assert!(child.name.is_none());
        assert!(child.readable && child.children.is_empty());
        assert_eq!(child.messages.len(), 1);
        assert_eq!(child.messages[0].role, "user");
        assert_eq!(child.messages[0].text, "subagent");
        assert!(parsed.messages.iter().all(|item| item.text != "subagent"));
    }

    #[test]
    fn subagent_outside_the_parent_shape_is_unreadable_and_adds_no_usage() {
        let temp = tempfile::tempdir().unwrap();
        let (_path, source) = write_session(temp.path());
        let subagents = source.path.parent().unwrap().join("subagents");
        fs::write(
            subagents.join("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"),
            concat!(
                "{\"role\":\"user\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"<user_query>嵌套正文</user_query>\"}]}}\n",
                "{\"role\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"同形状应答\"},{\"type\":\"tool_use\",\"name\":\"Read\",\"input\":{\"path\":\"a.rs\"}}]}}\n",
                "{\"type\":\"turn_ended\",\"status\":\"success\"}\n",
            ),
        )
        .unwrap();
        fs::write(
            subagents.join("bad-shape.jsonl"),
            "{\"role\":\"user\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"不该计用量\"}]},\"usage\":{\"input\":9}}\n",
        )
        .unwrap();
        fs::write(subagents.join("notes.txt"), "subagent").unwrap();
        let before = source.fingerprint.clone();
        fs::write(
            subagents.join("99999999-9999-9999-9999-999999999999.jsonl"),
            b"{\"role\":\"user\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"changed\"}]}}\n",
        )
        .unwrap();
        let source = sources(temp.path()).unwrap().into_iter().next().unwrap();
        assert_ne!(before, source.fingerprint);
        assert_eq!(sources(temp.path()).unwrap().len(), 1);
        let parsed = parse(&source).unwrap();
        assert!(parsed.usage.is_empty());
        assert!(parsed.messages.iter().any(|item| item.text == "修复会话列表"));
        assert!(parsed.messages.iter().all(|item| item.text != "嵌套正文" && item.text != "不该计用量"));
        let nested = parsed
            .children
            .iter()
            .find(|child| child.key == "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
            .unwrap();
        assert!(nested.readable && nested.name.is_none());
        assert_eq!(
            nested.messages.iter().map(|item| item.text.as_str()).collect::<Vec<_>>(),
            vec!["嵌套正文", "同形状应答"]
        );
        let bad = parsed.children.iter().find(|child| child.key == "bad-shape").unwrap();
        assert!(!bad.readable);
        assert!(bad.messages.is_empty());
        assert!(bad.name.is_none());
        assert!(parsed.children.iter().all(|child| child.key != "notes"));
    }

    #[test]
    fn cursor_clock_timestamps_are_message_times_and_unparsed_tags_stay_unknown() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp
            .path()
            .join(".cursor")
            .join("projects")
            .join("c-fixture-demo")
            .join("agent-transcripts")
            .join(SESSION_ID);
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join(format!("{SESSION_ID}.jsonl")),
            concat!(
                "{\"role\":\"user\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"<timestamp>Monday, Sep 14, 2026, 12:05 AM (UTC+8)</timestamp>\\n<user_query>\\n凌晨\\n</user_query>\"}]}}\n",
                "{\"role\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"应答\"}]}}\n",
                "{\"role\":\"user\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"<timestamp>Monday, Sep 14, 2026, 12:05 PM (UTC+8)</timestamp>\\n<user_query>\\n中午\\n</user_query>\"}]}}\n",
                "{\"role\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"下午应答\"}]}}\n",
                "{\"role\":\"user\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"<timestamp>not-a-time</timestamp>\\n<user_query>\\n无法识别\\n</user_query>\"}]}}\n",
                "{\"role\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"仍未知\"}]}}\n",
            ),
        )
        .unwrap();
        let source = sources(temp.path()).unwrap().remove(0);
        let parsed = parse(&source).unwrap();
        let morning = chrono::DateTime::parse_from_rfc3339("2026-09-13T16:05:00Z")
            .unwrap()
            .timestamp_millis();
        let noon = chrono::DateTime::parse_from_rfc3339("2026-09-14T04:05:00Z")
            .unwrap()
            .timestamp_millis();
        assert_eq!(parsed.messages[0].text, "凌晨");
        assert_eq!(parsed.messages[0].timestamp, Some(morning));
        assert_eq!(parsed.messages[0].timestamp_source, MessageTimeSource::Native);
        assert_eq!(parsed.messages[1].timestamp, Some(morning));
        assert_eq!(parsed.messages[1].timestamp_source, MessageTimeSource::Turn);
        assert_eq!(parsed.messages[2].timestamp, Some(noon));
        assert_eq!(parsed.messages[3].timestamp, Some(noon));
        assert_eq!(parsed.messages[3].timestamp_source, MessageTimeSource::Turn);
        assert!(parsed.messages[4].timestamp.is_none());
        assert!(!parsed.messages[4].text.contains("timestamp"));
        assert!(parsed.messages[5].timestamp.is_none());
    }

    #[test]
    fn workspace_folder_becomes_the_session_directory() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("self-workflow");
        fs::create_dir_all(&project).unwrap();
        let folder = url::Url::from_file_path(&project).unwrap();
        let slug = project_slug(&project);
        let directory = temp
            .path()
            .join(".cursor")
            .join("projects")
            .join(&slug)
            .join("agent-transcripts")
            .join(SESSION_ID);
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join(format!("{SESSION_ID}.jsonl")),
            "{\"role\":\"user\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"<user_query>打开目录</user_query>\"}]}}\n",
        )
        .unwrap();
        let storage = temp.path().join("workspaceStorage").join("hash");
        fs::create_dir_all(&storage).unwrap();
        fs::write(
            storage.join("workspace.json"),
            serde_json::json!({ "folder": folder.as_str() }).to_string(),
        )
        .unwrap();
        fs::write(storage.join("state.vscdb"), b"sk-test-cursor-secret").unwrap();
        let source = sources(temp.path()).unwrap().remove(0);
        let parsed = parse_with(&source, &[temp.path().join("workspaceStorage")], &|| false).unwrap();
        assert_eq!(parsed.cwd.as_deref(), Some(project.display().to_string().as_str()));
        assert!(!parsed.messages.iter().any(|item| item.text.contains("sk-test-cursor-secret")));
        assert_eq!(fs::read(storage.join("state.vscdb")).unwrap(), b"sk-test-cursor-secret");
    }

    #[test]
    fn hyphen_and_separator_that_share_a_slug_leave_the_directory_unknown() {
        let temp = tempfile::tempdir().unwrap();
        let hyphenated = temp.path().join("work").join("foo-bar");
        let nested = temp.path().join("work").join("foo").join("bar");
        assert_eq!(project_slug(&hyphenated), project_slug(&nested));
        let storage = temp.path().join("workspaceStorage");
        for (name, path) in [("a", &hyphenated), ("b", &nested)] {
            let dir = storage.join(name);
            fs::create_dir_all(&dir).unwrap();
            let folder = url::Url::from_file_path(path).unwrap();
            fs::write(
                dir.join("workspace.json"),
                serde_json::json!({ "folder": folder.as_str() }).to_string(),
            )
            .unwrap();
        }
        let map = proven_directories(&[storage]);
        assert!(!map.contains_key(&project_slug(&hyphenated)));
    }

    #[test]
    fn sampled_windows_slugs_match_opened_workspaces() {
        assert_eq!(
            project_slug(Path::new(r"C:\Users\example\cursor\cliora")),
            "c-Users-example-cursor-cliora"
        );
        assert_eq!(
            project_slug(Path::new(r"C:\Users\example\project\self-workflow")),
            "c-Users-example-project-self-workflow"
        );
        assert_eq!(
            project_slug(Path::new(r"C:\Users\example\IdeaProjects\sample-proxy-test-suite-speed")),
            "c-Users-example-IdeaProjects-sample-proxy-test-suite-speed"
        );
    }

    fn lock_exclusive(path: &Path) -> fs::File {
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            return fs::OpenOptions::new().read(true).share_mode(0).open(path).unwrap();
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            let file = fs::File::open(path).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0)).unwrap();
            file
        }
    }

    struct DenyList { path: PathBuf }

    impl DenyList {
        fn new(path: &Path) -> Self {
            #[cfg(windows)]
            {
                let user = std::env::var("USERNAME").expect("USERNAME");
                let status = std::process::Command::new("icacls").arg(path).arg("/inheritance:r").status().unwrap();
                assert!(status.success());
                let status = std::process::Command::new("icacls").arg(path).arg("/deny").arg(format!("{user}:(OI)(CI)(RX)")).status().unwrap();
                assert!(status.success());
            }
            #[cfg(not(windows))]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(path, fs::Permissions::from_mode(0)).unwrap();
            }
            Self { path: path.to_path_buf() }
        }
    }

    impl Drop for DenyList {
        fn drop(&mut self) {
            #[cfg(windows)]
            {
                let _ = std::process::Command::new("icacls").arg(&self.path).arg("/reset").status();
                let _ = std::process::Command::new("icacls").arg(&self.path).arg("/inheritance:e").status();
            }
            #[cfg(not(windows))]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(&self.path, fs::Permissions::from_mode(0o755));
            }
        }
    }

    fn other_transcript(home: &Path) {
        let id = "22222222-2222-2222-2222-222222222222";
        let directory = home.join(".cursor/projects/c-fixture-demo/agent-transcripts").join(id);
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join(format!("{id}.jsonl")),
            "{\"role\":\"user\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"<user_query>另一父会话</user_query>\"}]}}\n",
        )
        .unwrap();
    }

    #[test]
    fn unlistable_subagents_keep_every_parent() {
        let temp = tempfile::tempdir().unwrap();
        let (_path, source) = write_session(temp.path());
        other_transcript(temp.path());
        let subagents = source.path.parent().unwrap().join("subagents");
        let _deny = DenyList::new(&subagents);
        let found = sources(temp.path()).unwrap();
        assert_eq!(found.len(), 2, "子目录列举失败不能让本次发现整体失败");
        assert!(found.iter().all(|item| item.fingerprint_error.is_none() && item.fingerprint.starts_with("cursor-agent-transcript-v3|")));
        let parent = found.iter().find(|item| item.native_id.as_deref() == Some(SESSION_ID)).unwrap();
        assert!(parent.fingerprint.contains("children-unread") || parent.fingerprint.contains("unread:"));
        let parsed = parse(parent).unwrap();
        assert!(parsed.messages.iter().any(|item| item.text == "修复会话列表"));
        assert!(parsed.messages.iter().all(|item| item.text != "subagent"));
        assert!(parsed.usage.is_empty());
        let unread = parsed.children.iter().find(|child| !child.readable).unwrap();
        assert!(unread.messages.is_empty() && unread.name.is_none());
    }

    #[test]
    fn locked_subagent_stays_on_the_parent_until_it_can_be_read() {
        let temp = tempfile::tempdir().unwrap();
        let (_path, source) = write_session(temp.path());
        let locked = source.path.parent().unwrap().join("subagents/99999999-9999-9999-9999-999999999999.jsonl");
        let blocked = {
            let _lock = lock_exclusive(&locked);
            let parent = sources(temp.path()).unwrap().remove(0);
            assert!(parent.fingerprint_error.is_none(), "{:?}", parent.fingerprint_error);
            assert!(parent.fingerprint.contains("unread:"), "{}", parent.fingerprint);
            let parsed = parse(&parent).unwrap();
            assert!(parsed.messages.iter().any(|item| item.text == "修复会话列表"));
            assert!(parsed.messages.iter().all(|item| item.text != "subagent"));
            assert!(parsed.usage.is_empty());
            let unread = parsed.children.iter().find(|child| !child.readable).unwrap();
            assert!(unread.messages.is_empty() && unread.name.is_none());
            parent.fingerprint
        };
        let parent = sources(temp.path()).unwrap().remove(0);
        assert_ne!(parent.fingerprint, blocked, "子文件恢复可读后父指纹必须变化");
        let parsed = parse(&parent).unwrap();
        let child = parsed.children.iter().find(|child| child.key == "99999999-9999-9999-9999-999999999999").unwrap();
        assert!(child.readable);
        assert_eq!(child.messages[0].text, "subagent");
        assert!(parsed.messages.iter().all(|item| item.text != "subagent"));
    }
}
