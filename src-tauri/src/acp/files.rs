//! Project files offered to `@` references in the composer.
//!
//! Only paths inside the session directory are returned, relative to it and
//! with `/` separators. A Git worktree is listed with `git ls-files`
//! (tracked and untracked, ignore rules applied) under a short deadline;
//! anything else — or a Git that fails or runs too long — is walked with a
//! bound, skipping heavy directories. Symbolic links and junctions are never
//! followed or listed, so no listed path leads outside the directory. The list
//! is cached briefly per session; the query filters it.

use std::collections::VecDeque;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;

use super::{guard, Session};

/// The most paths one index holds.
pub const MAX_INDEXED: usize = 20_000;
/// How long an index is reused.
pub const CACHE_TTL: Duration = Duration::from_secs(30);
/// How long `git ls-files` may run.
pub const GIT_DEADLINE: Duration = Duration::from_secs(3);
/// The most paths one answer returns.
pub const MAX_LIMIT: usize = 500;
/// Directories a walk never enters.
pub const SKIPPED_DIRECTORIES: &[&str] = &[".git", "node_modules", "target", "dist"];
/// The most bytes read from `git ls-files`.
const MAX_GIT_OUTPUT: usize = 16 * 1024 * 1024;

/// One answer to a file query.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpFileList {
    /// Relative paths inside the session directory, best matches first.
    pub files: Vec<String>,
    /// The directory holds more files than were indexed.
    pub truncated: bool,
    /// git or walk: how the index was built.
    pub source: &'static str,
}

/// A cached listing of one session directory.
pub(crate) struct FileIndex {
    built: Instant,
    files: Arc<Vec<String>>,
    truncated: bool,
    source: &'static str,
}

/// A relative path that stays inside the root: plain names only.
fn plain_relative(path: &str) -> bool {
    !path.is_empty()
        && Path::new(path).components().all(|component| matches!(component, Component::Normal(_)))
}

/// Whether a listed entry is a regular file and not a link of any kind.
fn regular(root: &Path, relative: &str) -> bool {
    std::fs::symlink_metadata(root.join(relative)).is_ok_and(|metadata| metadata.file_type().is_file())
}

/// `git ls-files` for the directory, or None when it is not a worktree, Git
/// is missing, fails or runs past the deadline.
fn git_files(root: &Path) -> Option<(Vec<String>, bool)> {
    let git = crate::git_status::find_git()?;
    let mut child = crate::background_process::command(git)
        .arg("-c")
        .arg("core.fsmonitor=false")
        .arg("-C")
        .arg(root)
        .args(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = (&mut stdout).take(MAX_GIT_OUTPUT as u64 + 1).read_to_end(&mut bytes);
        bytes
    });
    let deadline = Instant::now() + GIT_DEADLINE;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                crate::background_process::terminate(&mut child);
                let _ = reader.join();
                return None;
            }
        }
    };
    let bytes = reader.join().ok()?;
    if !status.success() {
        return None;
    }
    let mut truncated = bytes.len() > MAX_GIT_OUTPUT;
    let mut files = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for entry in bytes.split(|byte| *byte == 0) {
        let Ok(path) = std::str::from_utf8(entry) else { continue };
        if !plain_relative(path) || !seen.insert(path) {
            continue;
        }
        if files.len() >= MAX_INDEXED {
            truncated = true;
            break;
        }
        // A tracked link, a submodule or a deleted file is not offered.
        if regular(root, path) {
            files.push(path.to_owned());
        }
    }
    Some((files, truncated))
}

/// A bounded breadth-first walk that never follows a link or a junction.
fn walk_files(root: &Path) -> (Vec<String>, bool) {
    let mut files = Vec::new();
    let mut visited = 0usize;
    let mut queue: VecDeque<PathBuf> = VecDeque::from([PathBuf::new()]);
    while let Some(relative) = queue.pop_front() {
        let Ok(entries) = std::fs::read_dir(root.join(&relative)) else { continue };
        let mut children: Vec<_> = entries.flatten().collect();
        children.sort_by_key(|entry| entry.file_name());
        for entry in children {
            visited += 1;
            if visited > MAX_INDEXED {
                return (files, true);
            }
            let Ok(kind) = entry.file_type() else { continue };
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let path = relative.join(name);
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                if !SKIPPED_DIRECTORIES.contains(&name) {
                    queue.push_back(path);
                }
            } else if kind.is_file() {
                files.push(path.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    (files, false)
}

/// Build the index for a session directory.
pub(crate) fn build_index(directory: &Path) -> Result<FileIndex, String> {
    let root = crate::safe_fs::canonical_root(directory)?;
    let (files, truncated, source) = match git_files(&root) {
        Some((files, truncated)) => (files, truncated, "git"),
        None => {
            let (files, truncated) = walk_files(&root);
            (files, truncated, "walk")
        }
    };
    Ok(FileIndex { built: Instant::now(), files: Arc::new(files), truncated, source })
}

/// How well `path` matches `query`: lower is better, None is no match. A
/// match in the file name beats one in the directory, a contiguous match
/// beats a scattered one (letters in order).
fn rank(path: &str, query: &str) -> Option<u8> {
    let path = path.to_lowercase();
    let name = path.rsplit('/').next().unwrap_or(&path);
    if name.starts_with(query) {
        return Some(0);
    }
    if name.contains(query) {
        return Some(1);
    }
    if path.contains(query) {
        return Some(2);
    }
    let mut letters = path.chars();
    query.chars().all(|wanted| letters.any(|letter| letter == wanted)).then_some(3)
}

/// Every match of `query`, best first, in index order within each rank.
pub(crate) fn ranked<'a>(files: &'a [String], query: &str) -> Vec<&'a String> {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return files.iter().collect();
    }
    let mut ranked: Vec<(u8, usize)> = files
        .iter()
        .enumerate()
        .filter_map(|(index, path)| rank(path, &query).map(|score| (score, index)))
        .collect();
    ranked.sort();
    ranked.into_iter().map(|(_, index)| &files[index]).collect()
}

impl Session {
    /// Files inside the session directory that match `query`.
    pub(super) fn list_files(&self, query: &str, limit: usize) -> Result<AcpFileList, String> {
        let limit = limit.clamp(1, MAX_LIMIT);
        let (files, truncated, source) = {
            let mut cache = guard(&self.files);
            let fresh = cache.as_ref().is_some_and(|index| index.built.elapsed() < CACHE_TTL);
            if !fresh {
                *cache = Some(build_index(&self.directory)?);
            }
            let index = cache.as_ref().ok_or("无法读取项目文件")?;
            (Arc::clone(&index.files), index.truncated, index.source)
        };
        // Every path offered is checked once more through the shared
        // classification, exactly as an attachment of it would be: only a
        // regular file inside the directory (by its canonical target) is
        // returned. The index may be up to a cache period old.
        let base = std::path::PathBuf::from(crate::safe_fs::display(&self.directory));
        let mut offered = Vec::with_capacity(limit);
        for path in ranked(&files, query) {
            if offered.len() >= limit {
                break;
            }
            let requested = base.join(path.replace('/', std::path::MAIN_SEPARATOR_STR));
            let inside = crate::safe_fs::resolve_target(&self.directory, &requested, crate::safe_fs::Expect::File)
                .is_ok_and(|resolved| resolved.inside());
            if inside {
                offered.push(path.clone());
            }
        }
        Ok(AcpFileList { files: offered, truncated, source })
    }
}
