//! The ACP file-system capability: `fs/read_text_file` and
//! `fs/write_text_file`, served through the shared `safe_fs` primitives.
//!
//! A path inside the session directory is served directly. A path outside goes
//! through the access rules (YOLO, a session grant, or an approval card).
//! Cliora's own data directories, devices and non-regular files are refused
//! whatever was granted. Every write is recorded in the timeline with its
//! diff; reads inside the directory stay quiet.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::access::AccessKind;
use super::timeline::{cap, AcpFileDiff, MAX_DIFF_CHARS};
use super::Session;
use crate::safe_fs::{self, Expect, Resolved};

/// The largest text a single write accepts.
pub const MAX_WRITE_BYTES: usize = 8 * 1024 * 1024;

fn param_path(params: &Value) -> Result<PathBuf, String> {
    params
        .get("path")
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "缺少参数 path".to_string())
}

impl Session {
    /// Classify a requested path and, when it is outside the session
    /// directory, obtain the user's (or YOLO's, or a grant's) consent. The path
    /// is resolved again after a wait: a target that moved while the card was
    /// open is refused instead of served. A target of the wrong kind (a device,
    /// a pipe, a directory) is refused before anyone is asked.
    pub(super) fn approve_path(
        &self,
        kind: AccessKind,
        expect: Expect,
        subagent: Option<&str>,
        requested: &Path,
    ) -> Result<(PathBuf, Option<String>), String> {
        match safe_fs::resolve_target(&self.directory, requested, expect)? {
            Resolved::Inside(path) => Ok((path, None)),
            Resolved::Outside(path) => {
                let record = self.authorize_outside(kind, subagent, &safe_fs::display(&path), None)?;
                let again = safe_fs::resolve_target(&self.directory, requested, expect)?;
                if again.path() != path {
                    return Err("审批期间路径指向发生变化，已拒绝".into());
                }
                Ok((path, Some(record)))
            }
        }
    }

    /// fs/read_text_file: the text, optionally from a 1-based line and for a
    /// number of lines.
    pub(super) fn read_text_file(&self, subagent: Option<&str>, params: &Value) -> Result<Value, String> {
        let requested = param_path(params)?;
        let line = params.get("line").and_then(Value::as_u64);
        let limit = params.get("limit").and_then(Value::as_u64);
        let (path, _) = self.approve_path(AccessKind::Read, Expect::File, subagent, &requested)?;
        let content = safe_fs::read_text(&path, line, limit, safe_fs::MAX_READ_BYTES)?;
        Ok(json!({ "content": content }))
    }

    /// fs/write_text_file: an atomic replacement, recorded with its diff.
    pub(super) fn write_text_file(&self, subagent: Option<&str>, params: &Value) -> Result<Value, String> {
        let requested = param_path(params)?;
        let content = params.get("content").and_then(Value::as_str).ok_or("缺少参数 content")?;
        if content.len() > MAX_WRITE_BYTES {
            return Err(format!("写入内容超过 {} MiB 上限", MAX_WRITE_BYTES / (1024 * 1024)));
        }
        let (path, record) = self.approve_path(AccessKind::Write, Expect::FileOrNew, subagent, &requested)?;
        let outcome = safe_fs::write_text_atomic(&path, content)?;
        let display = safe_fs::display(&path);
        let record = match record {
            Some(record) => record,
            None => self.record_inside(AccessKind::Write, subagent, &display, None),
        };
        let (old_text, old_cut) = match outcome.old.as_deref() {
            Some(old) => {
                let (text, cut) = cap(old, MAX_DIFF_CHARS);
                (Some(text), cut)
            }
            None => (None, false),
        };
        let (new_text, new_cut) = cap(content, MAX_DIFF_CHARS);
        self.attach_diff(
            &record,
            AcpFileDiff {
                path: display,
                old_text,
                new_text,
                truncated: old_cut || new_cut,
                previous_omitted: outcome.old_omitted,
            },
        );
        Ok(json!({}))
    }
}
