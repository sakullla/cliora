//! Where a local session started, so "changes" and the review baseline mean
//! "what this session did" rather than "everything uncommitted in the checkout".
//!
//! At launch Cliora records the worktree root, its HEAD and a fingerprint of each
//! file that was already changed. Fingerprints are blob ids from
//! `git hash-object` without `-w`: nothing is written into the repository.
//! Later reads compare the checkout against that record:
//!
//! - a file changed since the start HEAD counts, unless it was already changed at
//!   launch and still has the same content;
//! - a file that was changed at launch but is now back to the start HEAD counts too.
//!
//! The record lives in memory for the life of the session host process. A session
//! that moved into another worktree, or a launch whose read failed, has no record;
//! callers then fall back to the whole-checkout status.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, LazyLock, Mutex};
use std::time::Duration;

use crate::git_status::{hash_paths, is_oid, run_git};

/// Above this many pre-existing changes the launch keeps paths only, not content:
/// a pre-existing file that is still changed is then treated as untouched.
const MAX_FINGERPRINTS: usize = 5_000;
/// How long a status read waits for a capture that is still running.
const CAPTURE_WAIT: Duration = Duration::from_secs(5);
const DELETED: &str = "-";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SessionBaseline {
    pub root: PathBuf,
    /// HEAD at launch; `None` in a repository without commits.
    pub head: Option<String>,
    /// Paths already changed at launch → their content then (`None`: not fingerprinted).
    dirty: HashMap<String, Option<String>>,
}

type Slot = Arc<(Mutex<Option<Option<SessionBaseline>>>, Condvar)>;

static BASELINES: LazyLock<Mutex<HashMap<String, Slot>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Record the start point of a local session in the background. The CLI starts
/// at the same time; it takes longer to boot than this read takes to finish.
pub(crate) fn capture(session_id: &str, directory: &Path) {
    let slot: Slot = Arc::new((Mutex::new(None), Condvar::new()));
    if let Ok(mut map) = BASELINES.lock() {
        map.insert(session_id.to_owned(), Arc::clone(&slot));
    }
    let directory = directory.to_path_buf();
    let spawned = std::thread::Builder::new().name("cliora-session-baseline".into()).spawn({
        let slot = Arc::clone(&slot);
        move || publish(&slot, read_baseline(&directory))
    });
    if spawned.is_err() {
        publish(&slot, None);
    }
}

fn publish(slot: &Slot, value: Option<SessionBaseline>) {
    let (lock, ready) = &**slot;
    if let Ok(mut current) = lock.lock() {
        *current = Some(value);
        ready.notify_all();
    }
}

pub(crate) fn forget(session_id: &str) {
    if let Ok(mut map) = BASELINES.lock() {
        map.remove(session_id);
    }
}

/// The record of `session_id`, if its capture finished and found a repository.
pub(crate) fn get(session_id: &str) -> Option<SessionBaseline> {
    let slot = BASELINES.lock().ok()?.get(session_id).cloned()?;
    let (lock, ready) = &*slot;
    let guard = lock.lock().ok()?;
    let (guard, _) = ready.wait_timeout_while(guard, CAPTURE_WAIT, |value| value.is_none()).ok()?;
    guard.clone().flatten()
}

/// The record of `session_id` when it belongs to the worktree at `root`.
pub(crate) fn for_root(session_id: &str, root: &Path) -> Option<SessionBaseline> {
    get(session_id).filter(|baseline| same_root(&baseline.root, root))
}

fn same_root(left: &Path, right: &Path) -> bool {
    let left = left.canonicalize().unwrap_or_else(|_| left.to_path_buf());
    let right = right.canonicalize().unwrap_or_else(|_| right.to_path_buf());
    left == right
}

pub(crate) fn read_baseline(directory: &Path) -> Option<SessionBaseline> {
    let root = crate::twiglane::worktree_root(directory).ok()?;
    let head = head_oid(&root);
    let paths = changed_paths(&root, head.as_deref()).ok()?;
    let mut paths: Vec<String> = paths.into_iter().collect();
    paths.sort();
    let dirty = if paths.len() > MAX_FINGERPRINTS {
        paths.into_iter().map(|path| (path, None)).collect()
    } else {
        let prints = fingerprints(&root, &paths);
        paths.into_iter().zip(prints).collect()
    };
    Some(SessionBaseline { root, head, dirty })
}

/// Number of files this session changed in `root`.
pub(crate) fn session_changes(baseline: &SessionBaseline, root: &Path) -> Result<u64, &'static str> {
    let current = changed_paths(root, baseline.head.as_deref())?;
    // Files that were already changed at launch and are still changed: compare content.
    let overlap: Vec<String> = current
        .iter()
        .filter(|path| matches!(baseline.dirty.get(*path), Some(Some(_))))
        .cloned()
        .collect();
    let now = fingerprints(root, &overlap);
    let mut untouched: HashSet<&str> = overlap
        .iter()
        .zip(&now)
        .filter(|(path, print)| baseline.dirty.get(*path).and_then(Option::as_ref) == print.as_ref())
        .map(|(path, _)| path.as_str())
        .collect();
    // Without a fingerprint a pre-existing change that is still changed counts as untouched.
    for path in &current {
        if matches!(baseline.dirty.get(path), Some(None)) {
            untouched.insert(path.as_str());
        }
    }
    let changed_now = current.iter().filter(|path| !untouched.contains(path.as_str())).count();
    let reverted = baseline.dirty.keys().filter(|path| !current.contains(*path)).count();
    Ok((changed_now + reverted) as u64)
}

/// The commit a review of this session starts from: the launch HEAD while it is
/// still an ancestor of HEAD, else the point where history diverged from it.
pub(crate) fn review_base(baseline: &SessionBaseline, root: &Path) -> Option<String> {
    let start = baseline.head.as_deref()?;
    let head = head_oid(root)?;
    if start == head {
        return Some(head);
    }
    if is_ancestor(root, start, &head) {
        return Some(start.to_owned());
    }
    let (ok, text) = run_git(root, &["merge-base", start, &head]).ok()?;
    let base = text.trim();
    (ok && is_oid(base)).then(|| base.to_owned())
}

/// Whether `ancestor` is reachable from `descendant` (a commit is its own ancestor).
pub(crate) fn is_ancestor(root: &Path, ancestor: &str, descendant: &str) -> bool {
    matches!(run_git(root, &["merge-base", "--is-ancestor", ancestor, descendant]), Ok((true, _)))
}

fn head_oid(root: &Path) -> Option<String> {
    let (ok, text) = run_git(root, &["rev-parse", "--verify", "--quiet", "HEAD"]).ok()?;
    let text = text.trim();
    (ok && is_oid(text)).then(|| text.to_owned())
}

/// Tracked files that differ from `head` (staged or not) plus untracked files
/// that are not ignored. Without a HEAD every listed file counts.
fn changed_paths(root: &Path, head: Option<&str>) -> Result<HashSet<String>, &'static str> {
    let mut paths = HashSet::new();
    match head {
        Some(head) => {
            collect(root, &["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", head, "--"], &mut paths)?;
            collect(root, &["ls-files", "-z", "--others", "--exclude-standard"], &mut paths)?;
        }
        None => collect(root, &["ls-files", "-z", "--cached", "--others", "--exclude-standard"], &mut paths)?,
    }
    Ok(paths)
}

fn collect(root: &Path, args: &[&str], into: &mut HashSet<String>) -> Result<(), &'static str> {
    let (ok, text) = run_git(root, args)?;
    if !ok {
        return Err("read_failed");
    }
    into.extend(text.split('\0').filter(|path| !path.is_empty()).map(str::to_owned));
    Ok(())
}

/// Content of each path: a blob id, `-` when it is gone, `None` when it cannot be read
/// (a directory such as a submodule, or a hash failure).
fn fingerprints(root: &Path, paths: &[String]) -> Vec<Option<String>> {
    let mut out: Vec<Option<String>> = vec![None; paths.len()];
    let mut files = Vec::new();
    let mut slots = Vec::new();
    for (index, path) in paths.iter().enumerate() {
        let full = root.join(path);
        match std::fs::symlink_metadata(&full) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => out[index] = Some(DELETED.into()),
            Ok(meta) if meta.is_file() => {
                files.push(path.clone());
                slots.push(index);
            }
            _ => {}
        }
    }
    if let Ok(ids) = hash_paths(root, &files) {
        for (slot, id) in slots.into_iter().zip(ids) {
            out[slot] = Some(id);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    fn git(cwd: &Path, args: &[&str]) -> bool {
        let Some(git) = crate::git_status::find_git() else { return false };
        let mut command = Command::new(git);
        crate::process_environment::apply(&mut command);
        command
            .arg("-C")
            .arg(cwd)
            .args(args)
            .env("GIT_CONFIG_GLOBAL", if cfg!(windows) { "NUL" } else { "/dev/null" })
            .env("GIT_CONFIG_SYSTEM", if cfg!(windows) { "NUL" } else { "/dev/null" })
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    fn repo(temp: &Path) -> Option<PathBuf> {
        let root = temp.join("repo");
        std::fs::create_dir_all(&root).unwrap();
        if !git(&root, &["init", "-q", "-b", "main"]) {
            return None;
        }
        assert!(git(&root, &["config", "user.email", "t@example.com"]));
        assert!(git(&root, &["config", "user.name", "Test"]));
        assert!(git(&root, &["config", "core.autocrlf", "false"]));
        for name in ["a.txt", "b.txt", "c.txt"] {
            std::fs::write(root.join(name), "one\n").unwrap();
        }
        assert!(git(&root, &["add", "."]));
        assert!(git(&root, &["commit", "-q", "-m", "root"]));
        Some(root.canonicalize().unwrap())
    }

    #[test]
    fn changes_already_present_at_launch_are_not_counted_for_the_session() {
        let temp = tempfile::tempdir().unwrap();
        let Some(root) = repo(temp.path()) else { return };
        // Dirty before the session starts.
        std::fs::write(root.join("a.txt"), "before\n").unwrap();
        std::fs::write(root.join("old-untracked.txt"), "x\n").unwrap();
        let baseline = read_baseline(&root).expect("baseline");
        assert_eq!(session_changes(&baseline, &root).unwrap(), 0);

        // The session edits one new file, adds one, and touches a pre-existing change.
        std::fs::write(root.join("b.txt"), "session\n").unwrap();
        std::fs::write(root.join("new.txt"), "session\n").unwrap();
        assert_eq!(session_changes(&baseline, &root).unwrap(), 2);
        std::fs::write(root.join("a.txt"), "session edit\n").unwrap();
        assert_eq!(session_changes(&baseline, &root).unwrap(), 3);
        // Reverting a pre-existing change back to HEAD is also the session's doing.
        std::fs::remove_file(root.join("old-untracked.txt")).unwrap();
        assert_eq!(session_changes(&baseline, &root).unwrap(), 4);
    }

    #[test]
    fn commits_made_during_the_session_still_count_and_set_the_review_base() {
        let temp = tempfile::tempdir().unwrap();
        let Some(root) = repo(temp.path()) else { return };
        let baseline = read_baseline(&root).expect("baseline");
        let start = baseline.head.clone().unwrap();
        std::fs::write(root.join("c.txt"), "committed by the session\n").unwrap();
        assert!(git(&root, &["commit", "-q", "-am", "session"]));
        assert_eq!(session_changes(&baseline, &root).unwrap(), 1);
        assert_eq!(review_base(&baseline, &root).as_deref(), Some(start.as_str()));
    }

    #[test]
    fn a_rewritten_history_reviews_from_the_common_ancestor() {
        let temp = tempfile::tempdir().unwrap();
        let Some(root) = repo(temp.path()) else { return };
        std::fs::write(root.join("a.txt"), "two\n").unwrap();
        assert!(git(&root, &["commit", "-q", "-am", "second"]));
        let baseline = read_baseline(&root).expect("baseline");
        let (_, first) = run_git(&root, &["rev-parse", "HEAD~1"]).unwrap();
        assert!(git(&root, &["reset", "-q", "--hard", "HEAD~1"]));
        std::fs::write(root.join("b.txt"), "other\n").unwrap();
        assert!(git(&root, &["commit", "-q", "-am", "other"]));
        assert_eq!(review_base(&baseline, &root).as_deref(), Some(first.trim()));
    }

    #[test]
    fn a_review_starts_at_the_session_start_and_moves_past_a_confirmed_commit() {
        let temp = tempfile::tempdir().unwrap();
        let Some(root) = repo(temp.path()) else { return };
        let session = "4f0e6b8e-0000-4000-8000-00000000b001";
        let (_, start) = run_git(&root, &["rev-parse", "HEAD"]).unwrap();
        capture(session, &root);
        assert!(get(session).is_some());
        std::fs::write(root.join("a.txt"), "session work\n").unwrap();
        assert!(git(&root, &["commit", "-q", "-am", "session work"]));
        // The session already committed once: the review still starts where the session did.
        assert_eq!(crate::twiglane::baseline(session, &root, None).as_deref(), Some(start.trim()));

        // Twiglane returned a commit; the next review starts there.
        let (_, reviewed) = run_git(&root, &["rev-parse", "HEAD"]).unwrap();
        let path = crate::twiglane::url_path(&root).unwrap();
        let mut previous = crate::twiglane::new_review(session, &path, Some(start.trim().to_owned()));
        previous.status = crate::twiglane::STATUS_RETURNED.into();
        previous.outcome = Some("committed".into());
        previous.head_oid = Some(reviewed.trim().to_owned());
        std::fs::write(root.join("b.txt"), "more\n").unwrap();
        assert!(git(&root, &["commit", "-q", "-am", "more"]));
        assert_eq!(crate::twiglane::baseline(session, &root, Some(&previous)).as_deref(), Some(reviewed.trim()));

        // A returned commit that is no longer in the history is ignored.
        previous.head_oid = Some("0".repeat(40));
        assert_eq!(crate::twiglane::baseline(session, &root, Some(&previous)).as_deref(), Some(start.trim()));
        forget(session);
    }

    #[test]
    fn a_directory_outside_git_has_no_baseline() {
        let temp = tempfile::tempdir().unwrap();
        assert!(read_baseline(temp.path()).is_none());
    }
}
