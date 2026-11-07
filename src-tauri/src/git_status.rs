//! Read-only Git status shared by Twiglane review and the worktree menu.
//!
//! Every read runs Git with an argument array, no shell, no network and no
//! optional lock, and drains stdout under one output bound. A failure comes back
//! as a stable reason so callers can show "unknown" instead of a fabricated zero.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;

use crate::database::Database;

/// Git output bound. Larger output is unknown, never a truncated count.
const MAX_GIT_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

/// Windows CREATE_NO_WINDOW: a background Git read must not open a console.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Bounded status of one checkout: branch, HEAD and the number of changed files.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct WorktreeSnapshot {
    pub branch: Option<String>,
    pub head_oid: Option<String>,
    pub files: u64,
}

/// One worktree as the bottom menu shows it: ledger environment plus real Git
/// status. `state` is `unknown` (and every count `None`) when nothing could be read.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeMenuStatus {
    pub worktree_path: Option<String>,
    /// Whether Cliora's ledger created this worktree.
    pub managed: bool,
    /// Ledger environment (`prepared`/`unprepared`); `None` when unmanaged.
    pub environment: Option<String>,
    pub branch: Option<String>,
    pub head_oid: Option<String>,
    pub uncommitted_files: Option<u64>,
    pub state: &'static str,
    pub reason: Option<String>,
}

pub(crate) fn find_git() -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) { &["git.exe", "git.cmd", "git"] } else { &["git"] };
    crate::process_environment::directories()
        .into_iter()
        .find_map(|directory| names.iter().map(|name| directory.join(name)).find(|path| path.is_file()))
}

/// Git command for reads: the inherited PATH, and no console window on Windows.
fn git_command(git: PathBuf) -> Command {
    #[cfg(windows)]
    use std::os::windows::process::CommandExt;
    let mut command = Command::new(git);
    crate::process_environment::apply(&mut command);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW); // CREATE_NO_WINDOW
    command
}

/// Run Git with an argument array, never through a shell and never over the network.
pub(crate) fn run_git(cwd: &Path, args: &[&str]) -> Result<(bool, String), &'static str> {
    let mut out = Vec::new();
    let ok = stream_git(cwd, args, |chunk| {
        out.extend_from_slice(chunk);
        Ok(())
    })?;
    Ok((ok, String::from_utf8_lossy(&out).into_owned()))
}

/// Drain stdout without retaining file paths; every consumer shares the same bound.
fn stream_git(
    cwd: &Path,
    args: &[&str],
    mut consume: impl FnMut(&[u8]) -> Result<(), &'static str>,
) -> Result<bool, &'static str> {
    let git = find_git().ok_or("git_missing")?;
    let mut child = git_command(git)
        .arg("-C")
        .arg(cwd)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        // A read takes no lock and lets no global configuration change the result.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_CONFIG_GLOBAL", if cfg!(windows) { "NUL" } else { "/dev/null" })
        .env("GIT_CONFIG_SYSTEM", if cfg!(windows) { "NUL" } else { "/dev/null" })
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "git_missing")?;
    let mut bytes = 0;
    if let Some(mut stdout) = child.stdout.take() {
        let mut chunk = [0u8; 8192];
        loop {
            match stdout.read(&mut chunk) {
                Ok(0) => break,
                Ok(read) => {
                    bytes += read;
                    if bytes > MAX_GIT_OUTPUT_BYTES {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err("output_too_large");
                    }
                    if let Err(reason) = consume(&chunk[..read]) {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(reason);
                    }
                }
                Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("read_failed");
                }
            }
        }
    }
    let status = child.wait().map_err(|_| "read_failed")?;
    Ok(status.success())
}

/// Full object id: exactly 40 lowercase hex characters.
pub(crate) fn is_oid(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Read branch, HEAD and the full uncommitted file count of one checkout.
/// Runs from any directory inside the worktree; the count is repository-wide.
pub(crate) fn read(directory: &Path) -> Result<WorktreeSnapshot, &'static str> {
    let mut summary = StatusSummary::default();
    let ok = stream_git(
        directory,
        &["status", "--porcelain=v2", "--branch", "--no-ahead-behind", "--untracked-files=all"],
        |chunk| summary.push(chunk),
    )?;
    if !ok {
        return Err("read_failed");
    }
    summary.finish()?;
    Ok(WorktreeSnapshot { branch: summary.branch, head_oid: summary.head_oid, files: summary.files })
}

/// Menu status for one worktree path: the ledger says whether Cliora created it
/// and how its environment prepared; Git says what is uncommitted. A read failure
/// stays `unknown` with a reason and no zero count.
pub fn menu_status(db: &Database, directory: &Path) -> Result<WorktreeMenuStatus, String> {
    let record = crate::git_worktree::ledger_entry(db, directory)?;
    let path = crate::launch::terminal_path(directory).ok();
    let managed = record.is_some();
    let environment = record.map(|row| row.environment);
    match read(directory) {
        Ok(snapshot) => Ok(WorktreeMenuStatus {
            worktree_path: path,
            managed,
            environment,
            branch: snapshot.branch,
            head_oid: snapshot.head_oid,
            uncommitted_files: Some(snapshot.files),
            state: "ready",
            reason: None,
        }),
        Err(reason) => Ok(WorktreeMenuStatus {
            worktree_path: path,
            managed,
            environment,
            branch: None,
            head_oid: None,
            uncommitted_files: None,
            state: "unknown",
            reason: Some(reason.into()),
        }),
    }
}

/// Porcelain v2 carries HEAD and branch in the same snapshot as the count.
/// Only headers are retained (at most 4 KiB); file records are counted and discarded.
/// Without -z, Git quotes embedded newlines in paths, including rename paths.
#[derive(Default)]
struct StatusSummary {
    branch: Option<String>,
    head_oid: Option<String>,
    files: u64,
    first: Option<u8>,
    header: Vec<u8>,
    saw_branch: bool,
    saw_head: bool,
}

impl StatusSummary {
    fn push(&mut self, chunk: &[u8]) -> Result<(), &'static str> {
        for &byte in chunk {
            if byte == b'\n' {
                self.finish_line()?;
                continue;
            }
            let first = *self.first.get_or_insert(byte);
            if first == b'#' {
                if self.header.len() == 4096 {
                    return Err("output_too_large");
                }
                self.header.push(byte);
            }
        }
        Ok(())
    }

    fn finish_line(&mut self) -> Result<(), &'static str> {
        match self.first.take() {
            Some(b'#') => {
                let header = std::str::from_utf8(&self.header).map_err(|_| "read_failed")?.trim_end();
                if let Some(oid) = header.strip_prefix("# branch.oid ") {
                    let sha256 = oid.len() == 64 && oid.bytes().all(|byte| byte.is_ascii_hexdigit());
                    if oid != "(initial)" && !is_oid(oid) && !sha256 {
                        return Err("read_failed");
                    }
                    // The review protocol accepts SHA-1 only; preserve the previous
                    // unknown HEAD for SHA-256 without losing branch/file status.
                    self.head_oid = is_oid(oid).then(|| oid.to_owned());
                    self.saw_head = true;
                } else if let Some(branch) = header.strip_prefix("# branch.head ") {
                    if branch.is_empty() {
                        return Err("read_failed");
                    }
                    self.branch = (branch != "(detached)").then(|| branch.to_owned());
                    self.saw_branch = true;
                }
                self.header.clear();
            }
            Some(b'1' | b'2' | b'u' | b'?') => self.files += 1,
            None => {}
            _ => return Err("read_failed"),
        }
        Ok(())
    }

    fn finish(&mut self) -> Result<(), &'static str> {
        self.finish_line()?;
        if !self.saw_head || !self.saw_branch {
            return Err("read_failed");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OID: &str = "4f3c2b1a0f9e8d7c6b5a4938271605f4e3d2c1b0";

    #[test]
    fn status_stream_counts_all_record_types_across_chunk_boundaries() {
        let mut output = format!("# branch.oid {OID}\n# branch.head feature/中文\n# future.header ignored\n");
        for index in 0..57 {
            output.push_str(&format!("? file-{index}.txt\n"));
        }
        output.push_str("2 R. N... 100644 100644 100644 oid oid R100 new.txt\told.txt\n");
        output.push_str("1 .M N... 100644 100644 100644 oid oid tracked.txt\n");
        output.push_str("u UU N... modes oids conflict.txt\n? \"line\\nbreak.txt\"");
        for size in [1, 7, 8192] {
            let mut summary = StatusSummary::default();
            for chunk in output.as_bytes().chunks(size) {
                summary.push(chunk).unwrap();
            }
            summary.finish().unwrap();
            assert_eq!(summary.files, 61);
            assert_eq!(summary.branch.as_deref(), Some("feature/中文"));
            assert_eq!(summary.head_oid.as_deref(), Some(OID));
        }
    }

    #[test]
    fn status_stream_does_not_retain_paths_and_rejects_incomplete_headers() {
        let mut summary = StatusSummary::default();
        summary.push(b"# branch.oid (initial)\n# branch.head main\n? ").unwrap();
        let retained = summary.header.capacity();
        for _ in 0..1024 {
            summary.push(&[b'x'; 4096]).unwrap();
        }
        summary.push(b"\n").unwrap();
        summary.finish().unwrap();
        assert_eq!(summary.files, 1);
        assert_eq!(summary.header.capacity(), retained);
        assert_eq!(StatusSummary::default().finish(), Err("read_failed"));
        let mut oversized = StatusSummary::default();
        oversized.push(b"# ").unwrap();
        assert_eq!(oversized.push(&[b'x'; 4096]), Err("output_too_large"));
    }

    /// std cannot read back the creation flags of a Command, so guard the real
    /// construction site: without this line every background read flashes a console.
    #[test]
    fn git_reads_never_ask_windows_for_a_console_window() {
        let source = include_str!("git_status.rs");
        let lines: Vec<&str> = source.lines().collect();
        let guarded = lines
            .windows(2)
            .any(|pair| pair[0].trim() == "#[cfg(windows)]" && pair[1].contains("creation_flags(CREATE_NO_WINDOW)"));
        assert!(guarded, "读取状态的 Git 命令必须在 cfg(windows) 下设置 CREATE_NO_WINDOW");
        // run_git must go through the same construction site or the flag is bypassed.
        assert!(source.contains("let mut child = git_command(git)"), "run_git 必须使用 git_command");
        // Read-only environment, argument arrays and the output bound stay in place.
        assert!(source.contains(".env(\"GIT_OPTIONAL_LOCKS\", \"0\")"));
        assert!(source.contains("MAX_GIT_OUTPUT_BYTES"));
    }

    #[test]
    #[cfg(windows)]
    fn a_windows_git_read_starts_without_a_console_window() {
        assert_eq!(CREATE_NO_WINDOW, 0x0800_0000, "CREATE_NO_WINDOW 常量被改动");
        let Some(git) = find_git() else {
            eprintln!("git unavailable; skipping console window test");
            return;
        };
        let output = git_command(git)
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .expect("git --version 应该能启动");
        assert!(output.status.success(), "{output:?}");
        assert!(String::from_utf8_lossy(&output.stdout).contains("git version"));
    }

    fn git(cwd: &Path, args: &[&str]) -> bool {
        matches!(run_git(cwd, args), Ok((true, _)))
    }

    fn commit_all(repo: &Path, message: &str) -> bool {
        git(repo, &["-c", "user.name=cliora", "-c", "user.email=cliora@example.com", "add", "-A"])
            && git(
                repo,
                &["-c", "user.name=cliora", "-c", "user.email=cliora@example.com", "commit", "-q", "-m", message],
            )
    }

    fn init_repo(root: &Path) -> Option<PathBuf> {
        if find_git().is_none() {
            eprintln!("git unavailable; skipping status read test");
            return None;
        }
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        if !git(&repo, &["init", "-b", "main"]) {
            return None;
        }
        Some(repo)
    }

    #[test]
    fn a_read_reports_branch_head_and_every_uncommitted_file() {
        let temp = tempfile::tempdir().unwrap();
        let Some(repo) = init_repo(temp.path()) else { return };
        std::fs::write(repo.join("tracked.txt"), "one\n").unwrap();
        assert!(commit_all(&repo, "root"));
        for index in 0..3 {
            std::fs::write(repo.join(format!("new-{index}.txt")), "x\n").unwrap();
        }
        std::fs::write(repo.join("tracked.txt"), "two\n").unwrap();
        let snapshot = read(&repo).expect("snapshot");
        assert_eq!(snapshot.branch.as_deref(), Some("main"));
        assert_eq!(snapshot.files, 4);
        assert!(snapshot.head_oid.as_deref().is_some_and(is_oid));
        // Reading leaves the working tree untouched.
        assert!(git(&repo, &["status", "--porcelain=v1"]));
    }

    #[test]
    fn an_empty_repository_reads_no_head_instead_of_zero_commits() {
        let temp = tempfile::tempdir().unwrap();
        let Some(repo) = init_repo(temp.path()) else { return };
        let snapshot = read(&repo).expect("snapshot");
        assert!(snapshot.head_oid.is_none());
        assert_eq!(snapshot.branch.as_deref(), Some("main"));
        assert_eq!(snapshot.files, 0);
    }

    #[test]
    fn a_directory_outside_a_repository_is_an_error_not_an_empty_status() {
        let temp = tempfile::tempdir().unwrap();
        let plain = temp.path().join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        assert_eq!(read(&plain), Err("read_failed"));
    }

    #[test]
    fn the_menu_status_separates_unknown_from_a_real_zero() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let Some(repo) = init_repo(temp.path()) else { return };
        let unmanaged = menu_status(&db, &repo).expect("status");
        assert_eq!(unmanaged.state, "ready");
        assert!(!unmanaged.managed);
        assert_eq!(unmanaged.environment, None);
        assert_eq!(unmanaged.uncommitted_files, Some(0));

        let plain = temp.path().join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        let unknown = menu_status(&db, &plain).expect("status");
        assert_eq!(unknown.state, "unknown");
        assert_eq!(unknown.uncommitted_files, None, "未知不能显示成零改动");
        assert_eq!(unknown.reason.as_deref(), Some("read_failed"));
    }
}
