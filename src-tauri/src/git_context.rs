//! Best-effort Git context for a workbench directory.
//!
//! The workbench shows the branch (and worktree) a session works in as a quiet hint.
//! It reads `.git` metadata directly instead of starting `git`, so it costs a few
//! small file reads, never opens a console window, and works without Git installed.
//! Anything unexpected yields `None`; the hint simply stays hidden.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// How far up from the session directory a repository root is searched.
const MAX_DEPTH: usize = 48;
/// `HEAD`, `commondir` and `.git` pointer files are a line long; refuse anything large.
const MAX_POINTER_BYTES: u64 = 4096;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitContext {
    /// Checked-out branch, without `refs/heads/`.
    pub branch: Option<String>,
    /// Short commit when `HEAD` is detached.
    pub commit: Option<String>,
    /// Linked worktree name when the directory is not the main checkout.
    pub worktree: Option<String>,
    /// Folder name of the main checkout.
    pub repository: Option<String>,
}

pub fn read(directory: &Path) -> Option<GitContext> {
    let (root, git_dir, linked) = locate(directory)?;
    let head = read_pointer(&git_dir.join("HEAD"))?;
    let (branch, commit) = parse_head(&head)?;
    let worktree = if linked { git_dir.file_name().map(|name| name.to_string_lossy().into_owned()) } else { None };
    let main_root = if linked { common_dir(&git_dir).and_then(|common| common.parent().map(Path::to_path_buf)) } else { Some(root) };
    let repository = main_root.and_then(|path| path.file_name().map(|name| name.to_string_lossy().into_owned()));
    Some(GitContext { branch, commit, worktree, repository })
}

/// Working-tree root, its Git directory, and whether it is a linked worktree.
fn locate(directory: &Path) -> Option<(PathBuf, PathBuf, bool)> {
    for candidate in directory.ancestors().take(MAX_DEPTH) {
        let dot_git = candidate.join(".git");
        let Ok(meta) = std::fs::metadata(&dot_git) else { continue };
        if meta.is_dir() {
            return Some((candidate.to_path_buf(), dot_git, false));
        }
        if meta.is_file() {
            let pointer = read_pointer(&dot_git)?;
            let target = pointer.strip_prefix("gitdir:")?.trim();
            let git_dir = absolute(candidate, target);
            // Linked worktrees live in <common>/worktrees/<name>; submodules use a `.git`
            // file too but point into <common>/modules/<name>.
            let linked = git_dir.parent().and_then(Path::file_name).is_some_and(|name| name == "worktrees");
            return Some((candidate.to_path_buf(), git_dir, linked));
        }
    }
    None
}

fn common_dir(git_dir: &Path) -> Option<PathBuf> {
    let pointer = read_pointer(&git_dir.join("commondir"))?;
    Some(normalize(&absolute(git_dir, pointer.trim())))
}

fn parse_head(head: &str) -> Option<(Option<String>, Option<String>)> {
    let head = head.trim();
    if let Some(reference) = head.strip_prefix("ref:") {
        let reference = reference.trim();
        let name = reference.strip_prefix("refs/heads/").unwrap_or(reference);
        if name.is_empty() {
            return None;
        }
        return Some((Some(name.to_owned()), None));
    }
    if head.len() >= 7 && head.chars().all(|c| c.is_ascii_hexdigit()) {
        return Some((None, Some(head[..7].to_ascii_lowercase())));
    }
    None
}

fn read_pointer(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_POINTER_BYTES {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    Some(text.lines().next().unwrap_or_default().to_owned())
}

fn absolute(base: &Path, target: &str) -> PathBuf {
    let target = Path::new(target);
    if target.is_absolute() { target.to_path_buf() } else { base.join(target) }
}

/// Resolve `.`/`..` lexically; `commondir` is usually `../..`.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::ParentDir => { out.pop(); }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
#[path = "../../tests/launch/git_context.rs"]
mod tests;
