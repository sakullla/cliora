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

/// One checkout of a repository: the main working tree or a linked worktree.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    /// Display name: the main checkout's folder name, or the linked worktree's name.
    pub name: String,
    /// Checked-out branch, without `refs/heads/`; `None` when detached.
    pub branch: Option<String>,
    /// Absolute path of this checkout's working tree.
    pub path: String,
    /// Whether the session's directory currently sits in this checkout.
    pub current: bool,
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

/// Every checkout of the repository that contains `directory`: the main working
/// tree first, then each linked worktree. Reads `.git` metadata directly, like
/// [`read`], so it never spawns `git`. Returns `None` outside a repository and
/// an empty list is never produced when inside one (the current checkout is
/// always present). The checkout holding `directory` is flagged `current`.
pub fn worktrees(directory: &Path) -> Option<Vec<Worktree>> {
    let (root, git_dir, linked) = locate(directory)?;
    // The common dir is the main checkout's `.git`; for the main checkout it is
    // the git dir itself, for a linked worktree it is resolved via `commondir`.
    let common = if linked { common_dir(&git_dir)? } else { git_dir.clone() };
    let main_root = common.parent().map(Path::to_path_buf).unwrap_or(root);
    // The working tree the session currently sits in, used to flag `current`.
    let active = if linked { worktree_tree(&git_dir) } else { Some(main_root.clone()) };

    let mut out = Vec::new();
    out.push(worktree_entry(
        main_root.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| "main".to_owned()),
        &common.join("HEAD"),
        main_root.clone(),
        active.as_deref(),
    ));

    let linked_dir = common.join("worktrees");
    if let Ok(entries) = std::fs::read_dir(&linked_dir) {
        let mut linked: Vec<_> = entries.flatten().map(|entry| entry.path()).filter(|path| path.is_dir()).collect();
        linked.sort();
        for admin in linked {
            let Some(tree) = worktree_tree(&admin) else { continue };
            let name = admin.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
            if name.is_empty() { continue; }
            out.push(worktree_entry(name, &admin.join("HEAD"), tree, active.as_deref()));
        }
    }
    Some(out)
}

fn worktree_entry(name: String, head_path: &Path, tree: PathBuf, active: Option<&Path>) -> Worktree {
    let branch = read_pointer(head_path).and_then(|head| parse_head(&head)).and_then(|(branch, _)| branch);
    let current = active.is_some_and(|path| path == tree);
    Worktree { name, branch, path: tree.to_string_lossy().into_owned(), current }
}

/// Working-tree path of a linked worktree, from its `gitdir` pointer file.
/// `<common>/worktrees/<name>/gitdir` holds the path of the checkout's `.git`
/// file, whose parent is the working tree.
fn worktree_tree(admin: &Path) -> Option<PathBuf> {
    let pointer = read_pointer(&admin.join("gitdir"))?;
    let git_file = normalize(&absolute(admin, pointer.trim()));
    git_file.parent().map(Path::to_path_buf)
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
