//! Create a linked Git worktree for one new local session.
//!
//! `git_context` stays read-only. This module is the only place that runs `git`
//! to add a worktree, and it records the result in the local ledger.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::params;

use crate::database::Database;

const LEDGER_TABLE: &str = "worktree_ledger";

/// Serializes name allocation so two new sessions cannot take the same branch.
static CREATE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PreparedWorktree {
    pub directory: PathBuf,
    pub branch: String,
    pub main_checkout: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorktreeRecord {
    pub main_checkout: String,
    pub worktree_path: String,
    pub branch: String,
}

/// `Ok(None)` means `directory` is not inside a Git repository: start there.
/// A repository whose `git` is missing or refuses the add is `Err`.
pub(crate) fn prepare_worktree(
    db: &Database,
    directory: &Path,
    task_text: Option<&str>,
) -> Result<Option<PreparedWorktree>, String> {
    if crate::git_context::worktrees(directory).is_none() {
        return Ok(None);
    }
    let git = find_git().ok_or_else(|| "找不到 Git，无法新建工作树。".to_string())?;
    prepare_with(&git, db, directory, task_text)
}

fn prepare_with(
    git: &Path,
    db: &Database,
    directory: &Path,
    task_text: Option<&str>,
) -> Result<Option<PreparedWorktree>, String> {
    let _guard = CREATE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(trees) = crate::git_context::worktrees(directory) else {
        return Ok(None);
    };
    if trees.is_empty() {
        return Ok(None);
    }
    if !git.is_file() {
        return Err("找不到 Git，无法新建工作树。".into());
    }
    let main = PathBuf::from(&trees[0].path);
    let main = main.canonicalize().unwrap_or(main);
    let parent = main.parent().filter(|path| !path.as_os_str().is_empty()).ok_or_else(|| {
        "无法在主检出同级创建工作树。".to_string()
    })?;
    let repo_name = main
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty() && *name != "." && *name != "..")
        .ok_or_else(|| "无法确定仓库目录名。".to_string())?;
    let commit = git_ok(git, directory, &["rev-parse", "--verify", "HEAD"])?;
    if commit.is_empty() || commit.chars().any(|ch| ch.is_whitespace()) {
        return Err("Git 无法创建工作树：无法读取当前提交。".into());
    }
    let existing = branch_names(git, directory)?;
    let base = branch_base(task_text, repo_name);
    let branch = unique_branch(&base, &existing);
    if !ref_ok(git, directory, &branch) {
        return Err(format!("Git 无法创建工作树：分支名“{branch}”不可用。"));
    }
    let path = unique_sibling(parent, repo_name, &branch)?;
    let path_text = path.to_str().ok_or("工作树路径文字编码无法识别")?;
    let created = git_output(git, directory, &["worktree", "add", "--quiet", "-b", &branch, path_text, &commit])?;
    if !created.status.success() {
        discard_incomplete(git, directory, &path, &main);
        return Err(git_failure(&created.stderr, &created.stdout));
    }
    let directory = path.canonicalize().map_err(|_| "新建的工作树目录不可用。".to_string())?;
    if directory == main {
        return Err("Git 无法创建工作树：新目录与主检出相同。".into());
    }
    if let Err(error) = record(db, &main, &directory, &branch) {
        discard_incomplete(git, &main, &directory, &main);
        return Err(error);
    }
    Ok(Some(PreparedWorktree { directory, branch, main_checkout: main }))
}

pub(crate) fn recorded_worktrees(db: &Database) -> Result<Vec<WorktreeRecord>, String> {
    db.with_connection(|conn| {
        ensure_ledger(conn)?;
        let mut statement = conn
            .prepare("SELECT main_checkout, worktree_path, branch FROM worktree_ledger ORDER BY created_at, worktree_path")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok(WorktreeRecord {
                    main_checkout: row.get(0)?,
                    worktree_path: row.get(1)?,
                    branch: row.get(2)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
    })
}

fn record(db: &Database, main: &Path, worktree: &Path, branch: &str) -> Result<(), String> {
    let main = main.to_str().ok_or("主检出路径文字编码无法识别")?;
    let worktree = worktree.to_str().ok_or("工作树路径文字编码无法识别")?;
    let created_at = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_secs() as i64);
    db.with_connection(|conn| {
        ensure_ledger(conn)?;
        conn.execute(
            "INSERT INTO worktree_ledger (worktree_path, main_checkout, branch, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![worktree, main, branch, created_at],
        )
        .map_err(|error| format!("无法记录工作树：{error}"))?;
        Ok(())
    })
}

fn ensure_ledger(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS {LEDGER_TABLE} (
           worktree_path TEXT PRIMARY KEY NOT NULL,
           main_checkout TEXT NOT NULL,
           branch TEXT NOT NULL,
           created_at INTEGER NOT NULL
         );"
    ))
    .map_err(|error| error.to_string())
}

fn find_git() -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) { &["git.exe", "git.cmd", "git"] } else { &["git"] };
    crate::process_environment::directories().into_iter().find_map(|directory| {
        names.iter().map(|name| directory.join(name)).find(|path| path.is_file())
    })
}

fn branch_names(git: &Path, directory: &Path) -> Result<HashSet<String>, String> {
    let output = git_ok(git, directory, &["for-each-ref", "--format=%(refname:short)", "refs/heads"])?;
    Ok(output.lines().map(str::trim).filter(|line| !line.is_empty()).map(str::to_owned).collect())
}

fn unique_branch(base: &str, existing: &HashSet<String>) -> String {
    let mut n = 1u32;
    loop {
        let name = if n == 1 { base.to_owned() } else { format!("{base}-{n}") };
        if !existing.contains(&name) {
            return name;
        }
        n += 1;
        if n > 1000 {
            return format!("{base}-{n}");
        }
    }
}

fn unique_sibling(parent: &Path, repo_name: &str, branch: &str) -> Result<PathBuf, String> {
    let stem = format!("{repo_name}-{branch}");
    for n in 1..=1000u32 {
        let name = if n == 1 { stem.clone() } else { format!("{stem}-{n}") };
        let path = parent.join(&name);
        if !path.exists() {
            return Ok(path);
        }
    }
    Err("无法分配不冲突的工作树目录。".into())
}

fn ref_ok(git: &Path, directory: &Path, name: &str) -> bool {
    git_output(git, directory, &["check-ref-format", "--branch", name])
        .map(|output| output.status.success())
        .unwrap_or(false)
}

/// First non-empty line of the task text, or the repository directory name.
fn branch_base(task_text: Option<&str>, repo_name: &str) -> String {
    let line = task_text.and_then(first_line).unwrap_or("");
    let from_task = sanitize_ref(line);
    if !from_task.is_empty() {
        return from_task;
    }
    let from_repo = sanitize_ref(repo_name);
    if !from_repo.is_empty() {
        return from_repo;
    }
    "task".to_owned()
}

fn first_line(text: &str) -> Option<&str> {
    text.lines().map(str::trim).find(|line| !line.is_empty())
}

fn sanitize_ref(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().collect();
    let mut out = String::new();
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        let next = chars.get(index + 1).copied();
        if (ch == '@' && next == Some('{')) || (ch == '.' && next == Some('.')) {
            push_dash(&mut out);
            index += 2;
            continue;
        }
        if ch.is_control() || ch == '\u{7f}' || matches!(ch, ' ' | '~' | '^' | ':' | '?' | '*' | '[' | '\\' | '/') {
            push_dash(&mut out);
            index += 1;
            continue;
        }
        out.push(ch);
        index += 1;
    }
    while out.contains("--") {
        out = out.replace("--", "-");
    }
    let mut name = out.trim_matches(|ch| ch == '-' || ch == '.').to_owned();
    while let Some(stripped) = name.strip_suffix(".lock") {
        name = stripped.trim_end_matches(|ch| ch == '-' || ch == '.').to_owned();
    }
    name = name.chars().take(72).collect();
    name = name.trim_end_matches(|ch| ch == '-' || ch == '.').to_owned();
    while let Some(stripped) = name.strip_suffix(".lock") {
        name = stripped.trim_end_matches(|ch| ch == '-' || ch == '.').to_owned();
    }
    if name == "@" || name.eq_ignore_ascii_case("con") || name.eq_ignore_ascii_case("prn") || name.eq_ignore_ascii_case("aux") || name.eq_ignore_ascii_case("nul") {
        return String::new();
    }
    name
}

fn push_dash(out: &mut String) {
    if !out.ends_with('-') {
        out.push('-');
    }
}

struct GitOutput {
    status: std::process::ExitStatus,
    stdout: String,
    stderr: String,
}

fn git_ok(git: &Path, cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = git_output(git, cwd, args)?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(git_failure(&output.stderr, &output.stdout))
    }
}

fn git_output(git: &Path, cwd: &Path, args: &[&str]) -> Result<GitOutput, String> {
    let mut command = Command::new(git);
    crate::process_environment::apply(&mut command);
    let output = command
        .arg("-C")
        .arg(cwd)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("无法运行 Git：{error}"))?;
    Ok(GitOutput {
        status: output.status,
        stdout: String::from_utf8_lossy(&output.stdout).trim().to_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
    })
}

fn git_failure(stderr: &str, stdout: &str) -> String {
    let detail = if stderr.is_empty() { stdout } else { stderr };
    let detail: String = detail.chars().take(500).collect();
    if detail.trim().is_empty() {
        "Git 无法创建工作树。".to_owned()
    } else {
        format!("Git 无法创建工作树：{}", detail.trim())
    }
}

/// Remove a directory this call created. Never touches the main checkout.
fn discard_incomplete(git: &Path, source: &Path, path: &Path, main: &Path) {
    if path == main || path.parent() != main.parent() {
        return;
    }
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return;
    };
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return;
    }
    if let Some(text) = path.to_str() {
        let _ = git_output(git, source, &["worktree", "remove", "--force", text]);
    }
    if path.exists() && path != main {
        if let Ok(meta) = std::fs::symlink_metadata(path) {
            if meta.is_dir() && !meta.file_type().is_symlink() {
                let _ = std::fs::remove_dir_all(path);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> (tempfile::TempDir, Database) {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        (temp, db)
    }

    fn run_git(cwd: &Path, args: &[&str]) -> bool {
        let Some(git) = find_git() else {
            return false;
        };
        let mut command = Command::new(git);
        crate::process_environment::apply(&mut command);
        command
            .arg("-C")
            .arg(cwd)
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_CONFIG_GLOBAL", if cfg!(windows) { "NUL" } else { "/dev/null" })
            .env("GIT_CONFIG_SYSTEM", if cfg!(windows) { "NUL" } else { "/dev/null" })
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    fn init_repo(parent: &Path, name: &str) -> Option<PathBuf> {
        let main = parent.join(name);
        std::fs::create_dir_all(&main).unwrap();
        if !run_git(&main, &["init", "-q", "-b", "main"]) {
            return None;
        }
        assert!(run_git(&main, &["config", "user.email", "t@example.com"]));
        assert!(run_git(&main, &["config", "user.name", "Test"]));
        assert!(run_git(&main, &["config", "core.autocrlf", "false"]));
        Some(main)
    }

    #[test]
    fn branch_names_drop_ref_characters_and_fall_back_to_the_repository() {
        assert_eq!(branch_base(Some("feat: hello?\nsecond"), "shop"), "feat-hello");
        assert_eq!(branch_base(Some("  \n"), "shop"), "shop");
        assert_eq!(branch_base(None, "My Repo"), "My-Repo");
        assert_eq!(branch_base(Some(".."), "shop"), "shop");
        assert_eq!(branch_base(Some("notes.lock"), "shop"), "notes");
        assert_eq!(branch_base(Some("@{"), "shop"), "shop");
        assert_eq!(branch_base(Some(""), ".."), "task");
    }

    #[test]
    fn a_plain_directory_does_not_create_a_worktree_or_a_ledger() {
        let (temp, db) = database();
        let plain = temp.path().join("notes");
        std::fs::create_dir(&plain).unwrap();
        std::fs::write(plain.join("keep.txt"), "same").unwrap();
        let result = prepare_worktree(&db, &plain, Some("task")).unwrap();
        assert!(result.is_none());
        assert_eq!(std::fs::read(plain.join("keep.txt")).unwrap(), b"same");
        let tables: i64 = db.with_connection(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'worktree_ledger'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        }).unwrap();
        assert_eq!(tables, 0);
    }

    #[test]
    fn missing_git_on_a_repository_fails_without_changing_files() {
        let (temp, db) = database();
        let main = temp.path().join("shop");
        std::fs::create_dir_all(main.join(".git")).unwrap();
        std::fs::write(main.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(main.join("keep.txt"), "before").unwrap();
        let missing = temp.path().join("missing-git");
        let error = prepare_with(&missing, &db, &main, Some("task")).unwrap_err();
        assert!(error.contains("找不到 Git"), "{error}");
        assert_eq!(std::fs::read(main.join("keep.txt")).unwrap(), b"before");
        assert!(recorded_worktrees(&db).unwrap().is_empty());
        let names: Vec<_> = std::fs::read_dir(temp.path()).unwrap().map(|entry| entry.unwrap().file_name()).collect();
        assert!(names.iter().all(|name| name != "shop-task" && name != "shop-shop"));
    }

    #[test]
    fn git_refusal_keeps_the_main_checkout_and_creates_no_ledger_row() {
        let (temp, db) = database();
        let Some(main) = init_repo(temp.path(), "shop") else {
            eprintln!("git unavailable; skipping refusal test");
            return;
        };
        std::fs::write(main.join("tracked.txt"), "committed\n").unwrap();
        assert!(run_git(&main, &["add", "tracked.txt"]));
        assert!(run_git(&main, &["commit", "-q", "-m", "root"]));
        std::fs::write(main.join("tracked.txt"), "dirty\n").unwrap();
        std::fs::write(main.join("untracked.txt"), "keep\n").unwrap();
        let fake = fake_git(temp.path());
        let error = prepare_with(&fake, &db, &main, Some("task")).unwrap_err();
        assert!(error.contains("refusing on purpose"), "{error}");
        assert_eq!(std::fs::read(main.join("tracked.txt")).unwrap(), b"dirty\n");
        assert_eq!(std::fs::read(main.join("untracked.txt")).unwrap(), b"keep\n");
        assert!(recorded_worktrees(&db).unwrap().is_empty());
        assert!(!temp.path().join("shop-task").exists());
    }

    #[test]
    fn two_new_sessions_get_different_branches_without_touching_uncommitted_files() {
        let (temp, db) = database();
        let Some(main) = init_repo(temp.path(), "shop") else {
            eprintln!("git unavailable; skipping worktree creation test");
            return;
        };
        std::fs::write(main.join("tracked.txt"), "committed\n").unwrap();
        assert!(run_git(&main, &["add", "tracked.txt"]));
        assert!(run_git(&main, &["commit", "-q", "-m", "root"]));
        std::fs::write(main.join("tracked.txt"), "dirty\n").unwrap();
        std::fs::write(main.join("secret.txt"), "do-not-copy\n").unwrap();
        let first = prepare_worktree(&db, &main, Some("feat: hello?\nignored")).unwrap().expect("first worktree");
        let second = prepare_worktree(&db, &main, Some("feat: hello?")).unwrap().expect("second worktree");
        assert_ne!(first.directory, second.directory);
        assert_ne!(first.directory, main);
        assert_ne!(second.directory, main);
        assert_eq!(first.branch, "feat-hello");
        assert_eq!(second.branch, "feat-hello-2");
        assert_eq!(crate::git_context::read(&first.directory).and_then(|context| context.branch).as_deref(), Some("feat-hello"));
        assert_eq!(crate::git_context::read(&second.directory).and_then(|context| context.branch).as_deref(), Some("feat-hello-2"));
        assert_eq!(std::fs::read(main.join("tracked.txt")).unwrap(), b"dirty\n");
        assert_eq!(std::fs::read(main.join("secret.txt")).unwrap(), b"do-not-copy\n");
        assert!(!first.directory.join("secret.txt").exists());
        let records = recorded_worktrees(&db).unwrap();
        let canonical_main = main.canonicalize().unwrap();
        assert_eq!(records.len(), 2);
        assert!(records.iter().any(|row| row.branch == "feat-hello" && Path::new(&row.worktree_path) == first.directory));
        assert!(records.iter().all(|row| Path::new(&row.main_checkout) == canonical_main));
        let fallback = prepare_worktree(&db, &main, None).unwrap().expect("fallback name");
        assert_eq!(fallback.branch, "shop");
        assert!(fallback.directory.file_name().unwrap().to_string_lossy().contains("shop"));
    }

    #[cfg(unix)]
    fn fake_git(dir: &Path) -> PathBuf {
        let path = dir.join("git");
        std::fs::write(&path, "#!/bin/sh\necho refusing on purpose >&2\nexit 1\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(windows)]
    fn fake_git(dir: &Path) -> PathBuf {
        let path = dir.join("git.cmd");
        std::fs::write(&path, "@echo refusing on purpose 1>&2\r\nexit /b 1\r\n").unwrap();
        path
    }
}
