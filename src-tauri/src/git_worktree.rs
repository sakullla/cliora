//! Create a linked Git worktree for one new local session.
//!
//! `git_context` stays read-only. This module is the only place that runs `git`
//! to add a worktree, and it records the result in the local ledger.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, OptionalExtension};

use crate::database::Database;

const LEDGER_TABLE: &str = "worktree_ledger";
const PREPARE_TABLE: &str = "worktree_prepare";
const ENVIRONMENT_UNPREPARED: &str = "unprepared";
const ENVIRONMENT_PREPARED: &str = "prepared";

/// Serializes name allocation so two new sessions cannot take the same branch.
static CREATE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PreparedWorktree {
    pub directory: PathBuf,
    pub branch: String,
    pub main_checkout: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRecord {
    pub main_checkout: String,
    pub worktree_path: String,
    pub branch: String,
    /// `unprepared` until a saved command exits successfully in this worktree.
    pub environment: String,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareCommand {
    pub main_checkout: String,
    pub command: String,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupReport {
    pub removed: bool,
    pub needs_confirmation: bool,
    pub detail: String,
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
        return Err(command_failure("Git 无法创建工作树", &created.stderr, &created.stdout));
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
            .prepare("SELECT main_checkout, worktree_path, branch, environment FROM worktree_ledger ORDER BY created_at, worktree_path")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok(WorktreeRecord {
                    main_checkout: row.get(0)?,
                    worktree_path: row.get(1)?,
                    branch: row.get(2)?,
                    environment: row.get(3)?,
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
            "INSERT INTO worktree_ledger (worktree_path, main_checkout, branch, created_at, environment) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![worktree, main, branch, created_at, ENVIRONMENT_UNPREPARED],
        )
        .map_err(|error| format!("无法记录工作树：{error}"))?;
        Ok(())
    })
}

/// Run the repository's saved command in a worktree that was just created.
/// No saved command leaves the ledger row unprepared and still lets the session start.
/// A non-zero exit keeps the worktree and refuses to start the CLI.
pub(crate) fn finish_prepare(db: &Database, created: &PreparedWorktree) -> Result<(), String> {
    let Some(command) = prepare_command_for_main(db, &created.main_checkout)? else {
        return Ok(());
    };
    run_prepare_command(&created.directory, &command)?;
    set_environment(db, &created.directory, ENVIRONMENT_PREPARED)
}

/// The saved command for the repository that contains `directory`, if any.
/// A directory that is not a Git checkout has none.
pub fn read_prepare_command(db: &Database, directory: &Path) -> Result<Option<String>, String> {
    let Ok(main) = canonical_main(directory) else {
        return Ok(None);
    };
    prepare_command_for_main(db, &main)
}

/// Store at most one command for the repository, keyed by its canonical main checkout.
/// An empty command clears the row. Nothing is written into the repository.
pub fn write_prepare_command(db: &Database, directory: &Path, command: &str) -> Result<PrepareCommand, String> {
    if command.contains('\0') {
        return Err("环境准备命令无效。".into());
    }
    let trimmed = command.trim();
    if trimmed.chars().count() > 4_000 {
        return Err("环境准备命令过长。".into());
    }
    let main = canonical_main(directory)?;
    let key = path_key(&main)?;
    db.with_connection(|conn| {
        ensure_prepare(conn)?;
        if trimmed.is_empty() {
            conn.execute("DELETE FROM worktree_prepare WHERE main_checkout = ?1", [&key])
                .map_err(|error| error.to_string())?;
        } else {
            conn.execute(
                "INSERT INTO worktree_prepare (main_checkout, command) VALUES (?1, ?2)
                 ON CONFLICT(main_checkout) DO UPDATE SET command = excluded.command",
                params![key, trimmed],
            )
            .map_err(|error| error.to_string())?;
        }
        Ok(())
    })?;
    Ok(PrepareCommand { main_checkout: key, command: trimmed.to_owned() })
}

/// Remove one ledger worktree. Paths that are not in the ledger, including the
/// main checkout and worktrees Cliora did not create, are refused before git runs.
pub fn cleanup_worktree(db: &Database, path: &Path, confirm: bool) -> Result<CleanupReport, String> {
    let record = find_ledger(db, path)?;
    let worktree = PathBuf::from(&record.worktree_path);
    let main = PathBuf::from(&record.main_checkout);
    if same_path(&worktree, &main) {
        return Err("主检出不能清理。".into());
    }
    let git = find_git().ok_or_else(|| "找不到 Git，无法清理工作树。".to_string())?;
    if let (Ok(tree), Ok(root)) = (worktree.canonicalize(), main.canonicalize()) {
        if tree == root {
            return Err("主检出不能清理。".into());
        }
    }
    let dirty = if worktree.is_dir() { dirty_lines(&git, &worktree)? } else { Vec::new() };
    let commits = unmerged_lines(&git, &main, &record.branch)?;
    if (!dirty.is_empty() || !commits.is_empty()) && !confirm {
        return Ok(CleanupReport {
            removed: false,
            needs_confirmation: true,
            detail: discard_detail(&dirty, &commits),
        });
    }
    delete_worktree(&git, &main, &worktree, &record.branch, !dirty.is_empty(), !commits.is_empty())?;
    forget_ledger(db, &record.worktree_path)?;
    Ok(CleanupReport { removed: true, needs_confirmation: false, detail: String::new() })
}

fn canonical_main(directory: &Path) -> Result<PathBuf, String> {
    let trees = crate::git_context::worktrees(directory).ok_or("这个目录不是 Git 仓库，不能保存环境准备命令。")?;
    let main = PathBuf::from(&trees[0].path);
    main.canonicalize().map_err(|_| "主检出目录不可用。".to_string())
}

fn prepare_command_for_main(db: &Database, main: &Path) -> Result<Option<String>, String> {
    let key = path_key(main)?;
    db.with_connection(|conn| {
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'worktree_prepare'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if exists == 0 {
            return Ok(None);
        }
        let value: Option<String> = conn
            .query_row("SELECT command FROM worktree_prepare WHERE main_checkout = ?1", [key], |row| row.get(0))
            .optional()
            .map_err(|error| error.to_string())?;
        Ok(value.filter(|text| !text.trim().is_empty()))
    })
}

fn set_environment(db: &Database, worktree: &Path, environment: &str) -> Result<(), String> {
    let key = path_key(worktree)?;
    db.with_connection(|conn| {
        ensure_ledger(conn)?;
        let updated = conn
            .execute("UPDATE worktree_ledger SET environment = ?1 WHERE worktree_path = ?2", params![environment, key])
            .map_err(|error| error.to_string())?;
        if updated == 0 {
            return Err("无法记录工作树的环境准备结果。".into());
        }
        Ok(())
    })
}

fn run_prepare_command(cwd: &Path, command: &str) -> Result<(), String> {
    let mut child = prepare_shell(command);
    child.current_dir(cwd).env("GIT_TERMINAL_PROMPT", "0").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let output = child.output().map_err(|error| format!("环境准备失败：无法运行命令：{error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let code = output.status.code().map(|code| code.to_string()).unwrap_or_else(|| "未知".into());
    let detail = command_failure(&format!("环境准备失败（退出码 {code}）"), &stderr, &stdout);
    Err(detail)
}

fn prepare_shell(command: &str) -> Command {
    let mut child = if cfg!(windows) {
        let mut child = Command::new(std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into()));
        child.arg("/D").arg("/C").arg(command);
        child
    } else {
        let mut child = Command::new("/bin/sh");
        child.arg("-c").arg(command);
        child
    };
    crate::process_environment::apply(&mut child);
    child
}

fn find_ledger(db: &Database, path: &Path) -> Result<WorktreeRecord, String> {
    let records = recorded_worktrees(db)?;
    let canon = path.canonicalize().ok();
    records
        .into_iter()
        .find(|row| {
            let stored = PathBuf::from(&row.worktree_path);
            stored == path
                || canon.as_ref().is_some_and(|canon| stored == *canon || stored.canonicalize().ok().as_ref() == Some(canon))
        })
        .ok_or_else(|| "这个目录不是 Cliora 创建的工作树，不能清理。".to_string())
}

fn forget_ledger(db: &Database, worktree: &str) -> Result<(), String> {
    db.with_connection(|conn| {
        ensure_ledger(conn)?;
        conn.execute("DELETE FROM worktree_ledger WHERE worktree_path = ?1", [worktree])
            .map_err(|error| error.to_string())?;
        Ok(())
    })
}

fn dirty_lines(git: &Path, worktree: &Path) -> Result<Vec<String>, String> {
    let output = git_output(git, worktree, &["status", "--porcelain", "--untracked-files=all"])?;
    if !output.status.success() {
        return Err(command_failure("Git 无法查看工作树改动", &output.stderr, &output.stdout));
    }
    Ok(output.stdout.lines().map(str::trim_end).filter(|line| !line.is_empty()).take(40).map(str::to_owned).collect())
}

fn unmerged_lines(git: &Path, main: &Path, branch: &str) -> Result<Vec<String>, String> {
    if branch.is_empty() {
        return Ok(Vec::new());
    }
    let exists = git_output(git, main, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{branch}")])?;
    if !exists.status.success() {
        return Ok(Vec::new());
    }
    let others = branch_names(git, main)?;
    let mut args = vec!["log".to_owned(), "-n".to_owned(), "9".to_owned(), "--pretty=format:%h %s".to_owned(), branch.to_owned()];
    let other_names: Vec<String> = others.into_iter().filter(|name| name != branch).collect();
    if !other_names.is_empty() {
        args.push("--not".to_owned());
        args.extend(other_names);
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = git_output(git, main, &arg_refs)?;
    if !output.status.success() {
        return Err(command_failure("Git 无法查看尚未合并的提交", &output.stderr, &output.stdout));
    }
    Ok(output.stdout.lines().map(str::trim).filter(|line| !line.is_empty()).map(str::to_owned).collect())
}

fn discard_detail(dirty: &[String], commits: &[String]) -> String {
    let mut parts = Vec::new();
    if !dirty.is_empty() {
        parts.push(listed("将丢弃未提交的改动：", dirty, "项"));
    }
    if !commits.is_empty() {
        parts.push(listed("将丢弃尚未合并的提交，确认后这些提交不能再从任何分支检出：", commits, "个"));
    }
    parts.join("\n")
}

fn listed(title: &str, lines: &[String], unit: &str) -> String {
    let shown: Vec<&str> = lines.iter().take(8).map(String::as_str).collect();
    let mut text = format!("{title}\n{}", shown.join("\n"));
    if lines.len() > shown.len() {
        text.push_str(&format!("\n…还有 {} {unit}", lines.len() - shown.len()));
    }
    text
}

fn delete_worktree(git: &Path, main: &Path, worktree: &Path, branch: &str, force_tree: bool, drop_unmerged: bool) -> Result<(), String> {
    let path = path_key(worktree)?;
    let mut args = vec!["worktree", "remove"];
    if force_tree {
        args.push("--force");
    }
    args.push(&path);
    let output = git_output(git, main, &args)?;
    if !output.status.success() && worktree.exists() {
        return Err(command_failure("Git 无法删除工作树", &output.stderr, &output.stdout));
    }
    if worktree.exists() {
        return Err("Git 无法删除工作树：目录仍在。".into());
    }
    if branch.is_empty() {
        return Ok(());
    }
    if drop_unmerged {
        let output = git_output(git, main, &["branch", "-D", branch])?;
        if !output.status.success() {
            return Err(command_failure("Git 无法删除未合并的分支", &output.stderr, &output.stdout));
        }
        return Ok(());
    }
    let _ = git_output(git, main, &["branch", "-d", branch]);
    Ok(())
}

fn same_path(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn path_key(path: &Path) -> Result<String, String> {
    path.to_str().map(str::to_owned).ok_or_else(|| "路径文字编码无法识别".to_string())
}

fn ensure_ledger(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS {LEDGER_TABLE} (
           worktree_path TEXT PRIMARY KEY NOT NULL,
           main_checkout TEXT NOT NULL,
           branch TEXT NOT NULL,
           created_at INTEGER NOT NULL,
           environment TEXT NOT NULL DEFAULT 'unprepared'
         );"
    ))
    .map_err(|error| error.to_string())?;
    let names = {
        let mut info = conn.prepare(&format!("PRAGMA table_info({LEDGER_TABLE})")).map_err(|error| error.to_string())?;
        let names = info
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        names
    };
    if !names.iter().any(|name| name == "environment") {
        conn.execute(
            &format!("ALTER TABLE {LEDGER_TABLE} ADD COLUMN environment TEXT NOT NULL DEFAULT 'unprepared'"),
            [],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn ensure_prepare(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS {PREPARE_TABLE} (
           main_checkout TEXT PRIMARY KEY NOT NULL,
           command TEXT NOT NULL
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
        Err(command_failure("Git 无法创建工作树", &output.stderr, &output.stdout))
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

fn command_failure(prefix: &str, stderr: &str, stdout: &str) -> String {
    let detail = if stderr.is_empty() { stdout } else { stderr };
    let detail: String = detail.chars().take(500).collect();
    if detail.trim().is_empty() {
        format!("{prefix}。")
    } else {
        format!("{prefix}：{}", detail.trim())
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
        assert!(recorded_worktrees(&db).unwrap().iter().all(|row| row.environment == "unprepared"));
    }

    fn marker_command(name: &str) -> String {
        if cfg!(windows) { format!("echo ready> {name}") } else { format!("printf ready > {name}") }
    }

    fn fail_command() -> &'static str {
        if cfg!(windows) { "echo nope>&2& exit /b 9" } else { "echo nope >&2; exit 9" }
    }

    fn git_text(cwd: &Path, args: &[&str]) -> String {
        let Some(git) = find_git() else { return String::new(); };
        let output = Command::new(git)
            .arg("-C")
            .arg(cwd)
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_CONFIG_GLOBAL", if cfg!(windows) { "NUL" } else { "/dev/null" })
            .env("GIT_CONFIG_SYSTEM", if cfg!(windows) { "NUL" } else { "/dev/null" })
            .output();
        output.map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned()).unwrap_or_default()
    }

    #[test]
    fn no_prepare_command_leaves_the_session_unprepared_and_copies_nothing() {
        let (temp, db) = database();
        let Some(main) = init_repo(temp.path(), "shop") else {
            eprintln!("git unavailable; skipping prepare absence test");
            return;
        };
        std::fs::write(main.join("tracked.txt"), "committed\n").unwrap();
        assert!(run_git(&main, &["add", "tracked.txt"]));
        assert!(run_git(&main, &["commit", "-q", "-m", "root"]));
        std::fs::create_dir_all(main.join("node_modules")).unwrap();
        std::fs::write(main.join("node_modules/pkg.json"), "{}\n").unwrap();
        std::fs::write(main.join(".env"), "SECRET=1\n").unwrap();
        let created = prepare_worktree(&db, &main, Some("task")).unwrap().expect("worktree");
        finish_prepare(&db, &created).unwrap();
        assert!(!created.directory.join("node_modules").exists());
        assert!(!created.directory.join(".env").exists());
        assert_eq!(std::fs::read(main.join(".env")).unwrap(), b"SECRET=1\n");
        let row = recorded_worktrees(&db).unwrap().into_iter().find(|row| row.branch == "task").unwrap();
        assert_eq!(row.environment, "unprepared");
        assert!(read_prepare_command(&db, &main).unwrap().is_none());
        let saved = write_prepare_command(&db, &created.directory, "npm ci").unwrap();
        assert_eq!(saved.command, "npm ci");
        assert_eq!(read_prepare_command(&db, &main).unwrap().as_deref(), Some("npm ci"));
        assert!(!main.join("npm ci").exists());
        assert!(!created.directory.join("npm ci").exists());
        assert!(!git_text(&main, &["status", "--porcelain"]).contains("worktree_prepare"));
        write_prepare_command(&db, &main, "  ").unwrap();
        assert!(read_prepare_command(&db, &main).unwrap().is_none());
    }

    #[test]
    fn a_prepare_command_runs_in_the_new_worktree_and_failure_keeps_it() {
        let (temp, db) = database();
        let Some(main) = init_repo(temp.path(), "shop") else {
            eprintln!("git unavailable; skipping prepare command test");
            return;
        };
        std::fs::write(main.join("tracked.txt"), "committed\n").unwrap();
        assert!(run_git(&main, &["add", "tracked.txt"]));
        assert!(run_git(&main, &["commit", "-q", "-m", "root"]));
        std::fs::write(main.join("tracked.txt"), "dirty\n").unwrap();
        write_prepare_command(&db, &main, fail_command()).unwrap();
        let failed = prepare_worktree(&db, &main, Some("task")).unwrap().expect("failed worktree");
        let error = finish_prepare(&db, &failed).unwrap_err();
        assert!(error.contains("环境准备失败"), "{error}");
        assert!(error.contains("nope"), "{error}");
        assert!(failed.directory.is_dir());
        assert_eq!(std::fs::read(main.join("tracked.txt")).unwrap(), b"dirty\n");
        assert_eq!(recorded_worktrees(&db).unwrap().iter().find(|row| row.branch == "task").unwrap().environment, "unprepared");
        write_prepare_command(&db, &main, &marker_command("ready.txt")).unwrap();
        let ready = prepare_worktree(&db, &main, Some("next")).unwrap().expect("ready worktree");
        finish_prepare(&db, &ready).unwrap();
        assert!(ready.directory.join("ready.txt").is_file());
        assert!(!main.join("ready.txt").exists());
        assert!(!failed.directory.join("ready.txt").exists());
        assert_eq!(recorded_worktrees(&db).unwrap().iter().find(|row| row.branch == "next").unwrap().environment, "prepared");
    }

    #[test]
    fn cleanup_removes_only_a_ledger_worktree_and_keeps_merged_commits() {
        let (temp, db) = database();
        let Some(main) = init_repo(temp.path(), "shop") else {
            eprintln!("git unavailable; skipping cleanup test");
            return;
        };
        std::fs::write(main.join("tracked.txt"), "committed\n").unwrap();
        assert!(run_git(&main, &["add", "tracked.txt"]));
        assert!(run_git(&main, &["commit", "-q", "-m", "root"]));
        let created = prepare_worktree(&db, &main, Some("task")).unwrap().expect("worktree");
        std::fs::write(created.directory.join("note.txt"), "note\n").unwrap();
        assert!(run_git(&created.directory, &["add", "note.txt"]));
        assert!(run_git(&created.directory, &["commit", "-q", "-m", "note"]));
        let hash = git_text(&created.directory, &["rev-parse", "HEAD"]);
        assert!(!hash.is_empty());
        let external = temp.path().join("external-wt");
        assert!(run_git(&main, &["worktree", "add", "--quiet", "-b", "external", external.to_str().unwrap(), "HEAD"]));
        let refused_main = cleanup_worktree(&db, &main, true).unwrap_err();
        assert!(refused_main.contains("不是 Cliora 创建的工作树"), "{refused_main}");
        assert!(main.is_dir());
        let refused_external = cleanup_worktree(&db, &external, true).unwrap_err();
        assert!(refused_external.contains("不是 Cliora 创建的工作树"), "{refused_external}");
        assert!(external.is_dir());
        assert!(run_git(&main, &["merge", "--ff-only", "task"]));
        let removed = cleanup_worktree(&db, &created.directory, false).unwrap();
        assert!(removed.removed);
        assert!(!removed.needs_confirmation);
        assert!(!created.directory.exists());
        assert!(main.is_dir());
        assert!(external.is_dir());
        assert!(git_text(&main, &["merge-base", "--is-ancestor", &hash, "HEAD"]).is_empty());
        assert!(run_git(&main, &["merge-base", "--is-ancestor", &hash, "HEAD"]));
        assert!(recorded_worktrees(&db).unwrap().is_empty());
    }

    #[test]
    fn cleanup_keeps_uncommitted_work_until_the_user_confirms() {
        let (temp, db) = database();
        let Some(main) = init_repo(temp.path(), "shop") else {
            eprintln!("git unavailable; skipping dirty cleanup test");
            return;
        };
        std::fs::write(main.join("tracked.txt"), "committed\n").unwrap();
        assert!(run_git(&main, &["add", "tracked.txt"]));
        assert!(run_git(&main, &["commit", "-q", "-m", "root"]));
        let created = prepare_worktree(&db, &main, Some("task")).unwrap().expect("worktree");
        std::fs::write(created.directory.join("note.txt"), "dirty\n").unwrap();
        let held = cleanup_worktree(&db, &created.directory, false).unwrap();
        assert!(held.needs_confirmation);
        assert!(!held.removed);
        assert!(held.detail.contains("note.txt"), "{}", held.detail);
        assert_eq!(std::fs::read(created.directory.join("note.txt")).unwrap(), b"dirty\n");
        let removed = cleanup_worktree(&db, &created.directory, true).unwrap();
        assert!(removed.removed);
        assert!(!created.directory.exists());
        assert!(main.is_dir());
        assert_eq!(std::fs::read(main.join("tracked.txt")).unwrap(), b"committed\n");
    }

    #[test]
    fn confirming_cleanup_drops_unmerged_commits_from_every_branch() {
        let (temp, db) = database();
        let Some(main) = init_repo(temp.path(), "shop") else {
            eprintln!("git unavailable; skipping unmerged cleanup test");
            return;
        };
        std::fs::write(main.join("tracked.txt"), "committed\n").unwrap();
        assert!(run_git(&main, &["add", "tracked.txt"]));
        assert!(run_git(&main, &["commit", "-q", "-m", "root"]));
        let created = prepare_worktree(&db, &main, Some("task")).unwrap().expect("worktree");
        std::fs::write(created.directory.join("note.txt"), "note\n").unwrap();
        assert!(run_git(&created.directory, &["add", "note.txt"]));
        assert!(run_git(&created.directory, &["commit", "-q", "-m", "only here"]));
        let hash = git_text(&created.directory, &["rev-parse", "HEAD"]);
        let held = cleanup_worktree(&db, &created.directory, false).unwrap();
        assert!(held.needs_confirmation, "{}", held.detail);
        assert!(held.detail.contains("only here"), "{}", held.detail);
        assert!(created.directory.is_dir());
        assert_eq!(git_text(&main, &["rev-parse", "task"]), hash);
        let removed = cleanup_worktree(&db, &created.directory, true).unwrap();
        assert!(removed.removed, "{removed:?}");
        assert!(!created.directory.exists());
        assert!(main.is_dir());
        assert!(!git_text(&main, &["branch", "--list", "task"]).contains("task"));
        assert!(!git_text(&main, &["rev-list", "--all"]).lines().any(|line| line == hash));
    }

    #[test]
    fn git_refusal_to_delete_keeps_the_worktree_and_reports_why() {
        let (temp, db) = database();
        let Some(main) = init_repo(temp.path(), "shop") else {
            eprintln!("git unavailable; skipping locked cleanup test");
            return;
        };
        std::fs::write(main.join("tracked.txt"), "committed\n").unwrap();
        assert!(run_git(&main, &["add", "tracked.txt"]));
        assert!(run_git(&main, &["commit", "-q", "-m", "root"]));
        let created = prepare_worktree(&db, &main, Some("task")).unwrap().expect("worktree");
        assert!(run_git(&main, &["merge", "--ff-only", "task"]));
        assert!(run_git(&main, &["worktree", "lock", created.directory.to_str().unwrap()]));
        let error = cleanup_worktree(&db, &created.directory, false).unwrap_err();
        assert!(error.contains("Git 无法删除工作树"), "{error}");
        assert!(created.directory.is_dir());
        assert_eq!(recorded_worktrees(&db).unwrap().len(), 1);
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
