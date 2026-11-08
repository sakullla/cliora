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
use crate::git_status::find_git;

const LEDGER_TABLE: &str = "worktree_ledger";
const PREPARE_TABLE: &str = "worktree_prepare";
const ENVIRONMENT_UNPREPARED: &str = "unprepared";
const ENVIRONMENT_PREPARED: &str = "prepared";

/// Serializes name allocation so two new sessions cannot take the same branch.
static CREATE_LOCK: Mutex<()> = Mutex::new(());

/// Stage names for one explicit worktree launch. The command layer turns them
/// into progress events; the launch result stays authoritative.
pub(crate) const STAGE_CREATING: &str = "creating";
pub(crate) const STAGE_PREPARING: &str = "preparing";
pub(crate) const STAGE_STARTING: &str = "starting";
pub(crate) const STAGE_SUCCEEDED: &str = "succeeded";
pub(crate) const STAGE_FAILED: &str = "failed";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PreparedWorktree {
    pub directory: PathBuf,
    pub branch: String,
    pub main_checkout: PathBuf,
}

/// Which commit a new worktree starts from. `Default` follows the repository's own
/// trunk; `Head` is used only when the user asks for the current commit.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WorktreeBase {
    #[default]
    Default,
    Head,
    Reference { reference: String },
}

/// What a creation will really start from, resolved before anything is written.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeBasePreview {
    /// `default`, `head` or `reference`.
    pub kind: String,
    /// The ref that will be used, e.g. `origin/main`.
    pub reference: Option<String>,
    pub commit: Option<String>,
    pub short_commit: Option<String>,
    /// Remote name when the base is a remote-tracking branch.
    pub remote: Option<String>,
    /// Branch name without the remote prefix.
    pub branch: Option<String>,
    /// The branch `prepare_with` would create for this task text, computed by the
    /// same `branch_base`/`unique_branch` pair so the preview cannot drift from
    /// the creation. Absent when the existing branches could not be read.
    pub proposed_branch: Option<String>,
    /// Visible reason when the default could not be used unchanged.
    pub degraded: Option<String>,
    /// Candidates the user has to choose from when no default is identifiable.
    pub candidates: Vec<String>,
    pub available: bool,
    pub reason: Option<String>,
}

/// A base that resolved to a real commit, or the reason it did not.
#[derive(Clone, Debug, PartialEq, Eq)]
enum BaseResolution {
    Resolved { reference: String, commit: String, remote: Option<String>, branch: Option<String>, degraded: Option<String> },
    Unavailable { reason: String, candidates: Vec<String> },
}

/// One progress event of an explicit worktree launch. Every field is known at
/// the moment the stage is reached; a later stage never rewrites an earlier one.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeLaunchEvent {
    pub operation_id: String,
    /// `creating`, `preparing`, `starting`, `succeeded` or `failed`.
    pub stage: &'static str,
    /// The worktree directory, once it exists.
    pub worktree_path: Option<String>,
    pub branch: Option<String>,
    /// The workbench session, once it started.
    pub session_id: Option<String>,
    pub error: Option<String>,
}

/// Progress for one explicit creation. Never used for a plain or remote launch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WorktreeProgress {
    /// The directory exists and its ledger row is written; the environment
    /// command is about to run.
    Preparing { directory: PathBuf, branch: String },
    /// The environment command failed. The worktree and its ledger row stay.
    PrepareFailed { directory: PathBuf, branch: String, error: String },
}

/// Options only an explicit creation carries.
#[derive(Clone, Debug)]
pub(crate) struct PrepareOptions<'a> {
    /// `Head` keeps the historical preference behaviour; an explicit creation
    /// passes what the caller confirmed.
    pub base: WorktreeBase,
    /// An explicit branch name is used exactly as given: a conflict is an error.
    pub branch: Option<&'a str>,
    /// An explicit creation must fail outside a repository, never start there.
    pub require_repository: bool,
}

impl<'a> Default for PrepareOptions<'a> {
    fn default() -> Self {
        Self { base: WorktreeBase::Head, branch: None, require_repository: false }
    }
}

/// One local session that keeps a worktree in use.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RunningSession {
    pub session_id: String,
    pub directory: PathBuf,
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
///
/// This is the entry point for the stored launch preference: it keeps the
/// historical "current commit" base and tolerates a plain directory.
pub(crate) fn prepare_worktree(
    db: &Database,
    directory: &Path,
    task_text: Option<&str>,
) -> Result<Option<PreparedWorktree>, String> {
    prepare_worktree_with(db, directory, task_text, &PrepareOptions::default(), &mut |_| {})
}

/// Create a worktree from a resolved base. `require_repository` marks an explicit
/// creation, which must never fall back to starting in the given directory.
pub(crate) fn prepare_worktree_with(
    db: &Database,
    directory: &Path,
    task_text: Option<&str>,
    options: &PrepareOptions<'_>,
    progress: &mut dyn FnMut(WorktreeProgress),
) -> Result<Option<PreparedWorktree>, String> {
    if crate::git_context::main_checkout(directory).is_none() {
        if options.require_repository {
            return Err("这个目录不是 Git 仓库，不能新建工作树。".into());
        }
        return Ok(None);
    }
    let git = find_git().ok_or_else(|| "找不到 Git，无法新建工作树。".to_string())?;
    prepare_with(&git, db, directory, task_text, options, progress)
}

fn prepare_with(
    git: &Path,
    db: &Database,
    directory: &Path,
    task_text: Option<&str>,
    options: &PrepareOptions<'_>,
    progress: &mut dyn FnMut(WorktreeProgress),
) -> Result<Option<PreparedWorktree>, String> {
    let _guard = CREATE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(main) = crate::git_context::main_checkout(directory) else {
        if options.require_repository {
            return Err("这个目录不是 Git 仓库，不能新建工作树。".into());
        }
        return Ok(None);
    };
    if !git.is_file() {
        return Err("找不到 Git，无法新建工作树。".into());
    }
    let main = main.canonicalize().unwrap_or(main);
    let parent = main.parent().filter(|path| !path.as_os_str().is_empty()).ok_or_else(|| {
        "无法在主检出同级创建工作树。".to_string()
    })?;
    let repo_name = repository_name(&main).ok_or_else(|| "无法确定仓库目录名。".to_string())?;
    // The base is resolved once here and pinned to its commit, so a ref that
    // moves after the preview cannot change where the worktree starts.
    let commit = match &options.base {
        WorktreeBase::Head => {
            let commit = git_ok(git, directory, &["rev-parse", "--verify", "HEAD"])?;
            if !is_commit_oid(&commit) {
                return Err("Git 无法创建工作树：无法读取当前提交。".into());
            }
            commit
        }
        base => match resolve_base(git, directory, base)? {
            BaseResolution::Resolved { commit, .. } => commit,
            BaseResolution::Unavailable { reason, candidates } => {
                return Err(base_unavailable_message(&reason, &candidates));
            }
        },
    };
    let existing = branch_names(git, directory)?;
    let branch = match options.branch.map(str::trim).filter(|name| !name.is_empty()) {
        Some(name) => {
            if !ref_ok(git, directory, name) {
                return Err(format!("Git 无法创建工作树：分支名“{name}”不可用。"));
            }
            if existing.contains(name) {
                return Err(format!("分支“{name}”已存在，请换一个名称。"));
            }
            name.to_owned()
        }
        None => unique_branch(&branch_base(task_text, repo_name), &existing),
    };
    let path = unique_sibling(parent, repo_name, &branch)?;
    // Git for Windows cannot use canonical \\?\ paths as worktree arguments.
    // Keep canonical paths for identity/IO and normalize only at the CLI boundary.
    let path_text = crate::launch::terminal_path(&path)?;
    let created = git_output(git, directory, &["worktree", "add", "--quiet", "-b", &branch, &path_text, &commit])?;
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
    progress(WorktreeProgress::Preparing { directory: directory.clone(), branch: branch.clone() });
    Ok(Some(PreparedWorktree { directory, branch, main_checkout: main }))
}

/// Resume a creation that is already recorded. The ledger row and the directory
/// are authoritative, so a retry reuses the same branch and allocates nothing.
pub(crate) fn retry_prepare(db: &Database, directory: &Path) -> Result<PreparedWorktree, String> {
    let record = find_ledger(db, directory)?;
    let path = PathBuf::from(&record.worktree_path);
    if !path.is_dir() {
        return Err("已创建的工作树目录不存在，请重新创建工作树。".into());
    }
    Ok(PreparedWorktree {
        directory: path,
        branch: record.branch,
        main_checkout: PathBuf::from(&record.main_checkout),
    })
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
/// A worktree a running local session still sits in is refused before any Git
/// write: ending that session is the only safe next step.
pub fn cleanup_worktree(db: &Database, path: &Path, confirm: bool) -> Result<CleanupReport, String> {
    cleanup_worktree_with_sessions(db, path, confirm, &running_local_sessions())
}

/// Running local sessions and their directories, read from the session host.
fn running_local_sessions() -> Vec<RunningSession> {
    crate::session_host::list()
        .into_iter()
        .filter(|session| session.running && session.remote_session_id.is_none())
        .map(|session| RunningSession { session_id: session.id, directory: PathBuf::from(session.directory) })
        .filter(|session| !session.directory.as_os_str().is_empty())
        .collect()
}

/// `sessions` is injected so the running-session guard is testable without a live PTY.
pub(crate) fn cleanup_worktree_with_sessions(
    db: &Database,
    path: &Path,
    confirm: bool,
    sessions: &[RunningSession],
) -> Result<CleanupReport, String> {
    let record = find_ledger(db, path)?;
    let worktree = PathBuf::from(&record.worktree_path);
    let main = PathBuf::from(&record.main_checkout);
    if same_path(&worktree, &main) {
        return Err("主检出不能清理。".into());
    }
    let git = find_git().ok_or_else(|| "找不到 Git，无法清理工作树。".to_string())?;
    // A path that cannot be resolved cannot be proven unrelated to a session, so
    // it is reported instead of deleted: a wrong delete loses work silently.
    let Some(root) = worktree.canonicalize().ok() else {
        return Err("无法确认工作树目录（可能已移动或删除），不能清理。".into());
    };
    if main.canonicalize().ok().as_deref() == Some(root.as_path()) {
        return Err("主检出不能清理。".into());
    }
    if let Some(session) = sessions.iter().find(|session| same_or_inside(&session.directory, &root)) {
        return Err(format!(
            "工作树仍被运行中的会话 {} 使用，请先结束该会话再清理。",
            session.session_id
        ));
    }
    let dirty = dirty_lines(&git, &worktree)?;
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

/// Whether `child` is `root` itself or lies inside it. Comparison uses canonical
/// paths when available and compares component by component either way, so a
/// sibling such as `repo-other` never matches `repo`.
fn same_or_inside(child: &Path, root: &Path) -> bool {
    let child = child.canonicalize().unwrap_or_else(|_| child.to_path_buf());
    let mut actual = child.components();
    for expected in root.components() {
        match actual.next() {
            Some(component) if same_component(component, expected) => {}
            _ => return false,
        }
    }
    true
}

fn same_component(left: std::path::Component<'_>, right: std::path::Component<'_>) -> bool {
    if cfg!(windows) {
        left.as_os_str().to_string_lossy().eq_ignore_ascii_case(&right.as_os_str().to_string_lossy())
    } else {
        left == right
    }
}

fn canonical_main(directory: &Path) -> Result<PathBuf, String> {
    let main = crate::git_context::main_checkout(directory).ok_or("这个目录不是 Git 仓库，不能保存环境准备命令。")?;
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

/// The ledger row for `path`, including a path that moved: the stored path
/// and its canonical form are both compared. `None` means Cliora did not
/// create it, which is not an error.
pub(crate) fn ledger_entry(db: &Database, path: &Path) -> Result<Option<WorktreeRecord>, String> {
    let records = recorded_worktrees(db)?;
    let canon = path.canonicalize().ok();
    Ok(records.into_iter().find(|row| {
        let stored = PathBuf::from(&row.worktree_path);
        stored == path
            || canon.as_ref().is_some_and(|canon| stored == *canon || stored.canonicalize().ok().as_ref() == Some(canon))
    }))
}

fn find_ledger(db: &Database, path: &Path) -> Result<WorktreeRecord, String> {
    ledger_entry(db, path)?.ok_or_else(|| "这个目录不是 Cliora 创建的工作树，不能清理。".to_string())
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
    let path = crate::launch::terminal_path(worktree)?;
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
        name = stripped.trim_end_matches(['-', '.']).to_owned();
    }
    name = name.chars().take(72).collect();
    name = name.trim_end_matches(['-', '.']).to_owned();
    while let Some(stripped) = name.strip_suffix(".lock") {
        name = stripped.trim_end_matches(['-', '.']).to_owned();
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
    #[cfg(windows)]
    use std::os::windows::process::CommandExt;
    let mut command = Command::new(git);
    crate::process_environment::apply(&mut command);
    // A background preview or cleanup must not flash a console window on Windows.
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
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

/// What a creation would start from, resolved without writing anything.
///
/// This keeps the historical two-argument shape for callers that only need the
/// base: the branch proposal then follows an empty task text, exactly what a
/// creation without a task would use.
pub fn base_preview(directory: &Path, base: Option<&WorktreeBase>) -> Result<WorktreeBasePreview, String> {
    base_preview_for(directory, base, None)
}

/// The same preview, with the branch a creation would really use for `task_text`.
///
/// The branch is never invented here: it comes from `branch_base` and
/// `unique_branch`, the pair `prepare_with` uses, so what the dialog shows and
/// what the creation allocates are the same rule.
pub fn base_preview_for(
    directory: &Path,
    base: Option<&WorktreeBase>,
    task_text: Option<&str>,
) -> Result<WorktreeBasePreview, String> {
    let git = find_git().ok_or_else(|| "找不到 Git，无法读取工作树基点。".to_string())?;
    let Some(main) = crate::git_context::main_checkout(directory) else {
        return Err("这个目录不是 Git 仓库，不能新建工作树。".into());
    };
    let base = base.cloned().unwrap_or_default();
    let mut preview = preview_of(&base, resolve_base(&git, directory, &base)?);
    // A branch list that cannot be read leaves the branch unknown instead of
    // promising a name the creation might not be able to use.
    preview.proposed_branch = branch_names(&git, directory).ok().map(|existing| {
        let repo_name = repository_name(&main).unwrap_or("task");
        unique_branch(&branch_base(task_text, repo_name), &existing)
    });
    Ok(preview)
}

/// The repository directory name an automatic branch is derived from. The
/// preview and the creation both read it here, so they cannot disagree.
fn repository_name(main: &Path) -> Option<&str> {
    main.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty() && *name != "." && *name != "..")
}

/// Refresh only the selected remote branch. Nothing else is fetched and no
/// reference other than that remote-tracking one is written, so the main
/// checkout, HEAD and every other base stay exactly as they were.
pub fn base_update(directory: &Path, base: Option<&WorktreeBase>) -> Result<WorktreeBasePreview, String> {
    let git = find_git().ok_or_else(|| "找不到 Git，无法更新工作树基点。".to_string())?;
    if crate::git_context::main_checkout(directory).is_none() {
        return Err("这个目录不是 Git 仓库，不能更新基点。".into());
    }
    let base = base.cloned().unwrap_or_default();
    let preview = preview_of(&base, resolve_base(&git, directory, &base)?);
    let (Some(remote), Some(branch)) = (preview.remote.clone(), preview.branch.clone()) else {
        return Err("只能更新远程分支基点。".into());
    };
    let refspec = format!("+refs/heads/{branch}:refs/remotes/{remote}/{branch}");
    let output = git_output(
        &git,
        directory,
        &["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", &remote, &refspec],
    )?;
    if !output.status.success() {
        return Err(command_failure(&format!("更新远程基点 {remote}/{branch} 失败"), &output.stderr, &output.stdout));
    }
    Ok(preview_of(&base, resolve_base(&git, directory, &base)?))
}

fn preview_of(base: &WorktreeBase, resolution: BaseResolution) -> WorktreeBasePreview {
    let kind = match base {
        WorktreeBase::Default => "default",
        WorktreeBase::Head => "head",
        WorktreeBase::Reference { .. } => "reference",
    };
    match resolution {
        BaseResolution::Resolved { reference, commit, remote, branch, degraded } => WorktreeBasePreview {
            kind: kind.to_owned(),
            short_commit: Some(commit.chars().take(7).collect()),
            reference: Some(reference),
            commit: Some(commit),
            remote,
            branch,
            proposed_branch: None,
            degraded,
            candidates: Vec::new(),
            available: true,
            reason: None,
        },
        BaseResolution::Unavailable { reason, candidates } => WorktreeBasePreview {
            kind: kind.to_owned(),
            candidates,
            available: false,
            reason: Some(reason),
            ..WorktreeBasePreview::default()
        },
    }
}

/// Resolve the base a new worktree starts from. Read-only: no ref, HEAD or
/// working tree is written. An unidentifiable base is reported together with
/// the candidates to choose from instead of being guessed.
fn resolve_base(git: &Path, directory: &Path, base: &WorktreeBase) -> Result<BaseResolution, String> {
    match base {
        WorktreeBase::Default => default_base(git, directory),
        WorktreeBase::Head => Ok(match rev_parse_commit(git, directory, "HEAD")? {
            Some(commit) => BaseResolution::Resolved {
                reference: "HEAD".into(),
                commit,
                remote: None,
                branch: None,
                degraded: None,
            },
            None => BaseResolution::Unavailable {
                reason: "当前仓库还没有提交，无法确定基点。".into(),
                candidates: Vec::new(),
            },
        }),
        WorktreeBase::Reference { reference } => {
            let reference = reference.trim();
            if reference.is_empty() || reference.starts_with('-') {
                return Ok(BaseResolution::Unavailable { reason: "基点无效。".into(), candidates: Vec::new() });
            }
            match rev_parse_commit(git, directory, reference)? {
                Some(commit) => {
                    let (remote, branch) = split_remote(git, directory, reference)?;
                    Ok(BaseResolution::Resolved { reference: reference.to_owned(), commit, remote, branch, degraded: None })
                }
                None => Ok(BaseResolution::Unavailable {
                    reason: format!("基点 {reference} 不存在或无法解析为提交。"),
                    candidates: Vec::new(),
                }),
            }
        }
    }
}

/// The repository's own default: the remote trunk its remote HEAD points at.
/// Without that, a single unambiguous remote-tracking branch, a single detected
/// remote HEAD, or (with no remote at all) the only local branch. Names such as
/// main or master are never guessed and HEAD is never used as a fallback.
fn default_base(git: &Path, directory: &Path) -> Result<BaseResolution, String> {
    if let Some(reference) = remote_head(git, directory, "origin")? {
        return resolve_tracking(git, directory, &reference, None);
    }
    let remotes = git_lines(git, directory, &["remote"])?;
    let tracking = tracking_branches(git, directory)?;
    if tracking.len() == 1 {
        let reference = tracking[0].clone();
        let note = format!("远程主干未配置，已使用唯一的远程跟踪分支 {reference}。");
        return resolve_tracking(git, directory, &reference, Some(note));
    }
    if !tracking.is_empty() {
        for remote in &remotes {
            if let Some(reference) = remote_head(git, directory, remote)? {
                let note = format!("远程主干未配置，已使用检测到的远程 HEAD {reference}。");
                return resolve_tracking(git, directory, &reference, Some(note));
            }
        }
        return Ok(BaseResolution::Unavailable {
            reason: "无法确定仓库默认的远程主干，请选择基点。".into(),
            candidates: tracking,
        });
    }
    let locals = git_lines(git, directory, &["for-each-ref", "--format=%(refname:short)", "refs/heads"])?;
    if remotes.is_empty() && locals.len() == 1 {
        let reference = locals[0].clone();
        let note = format!("仓库没有远程，已使用唯一的本地分支 {reference}。");
        return resolve_tracking(git, directory, &reference, Some(note));
    }
    if locals.is_empty() {
        return Ok(BaseResolution::Unavailable {
            reason: "仓库还没有提交，无法确定基点。".into(),
            candidates: Vec::new(),
        });
    }
    Ok(BaseResolution::Unavailable { reason: "无法确定仓库默认分支，请选择基点。".into(), candidates: locals })
}

fn resolve_tracking(
    git: &Path,
    directory: &Path,
    reference: &str,
    degraded: Option<String>,
) -> Result<BaseResolution, String> {
    let Some(commit) = rev_parse_commit(git, directory, reference)? else {
        return Ok(BaseResolution::Unavailable {
            reason: format!("基点 {reference} 不存在或无法解析为提交。"),
            candidates: Vec::new(),
        });
    };
    // A local branch may contain a slash; only a real remote-tracking ref has a
    // remote, so the split is verified against refs/remotes like the explicit ref.
    let (remote, branch) = split_remote(git, directory, reference)?;
    Ok(BaseResolution::Resolved { reference: reference.to_owned(), commit, remote, branch, degraded })
}

fn remote_head(git: &Path, directory: &Path, remote: &str) -> Result<Option<String>, String> {
    let probe = format!("refs/remotes/{remote}/HEAD");
    let output = git_output(git, directory, &["symbolic-ref", "--quiet", "--short", &probe])?;
    if !output.status.success() {
        return Ok(None);
    }
    let reference = output.stdout.trim();
    Ok((!reference.is_empty()).then(|| reference.to_owned()))
}

fn tracking_branches(git: &Path, directory: &Path) -> Result<Vec<String>, String> {
    Ok(git_lines(git, directory, &["for-each-ref", "--format=%(refname:short)", "refs/remotes"])?
        .into_iter()
        .filter(|name| !name.ends_with("/HEAD"))
        .collect())
}

/// The remote and branch of an explicit ref, but only when it really is a
/// remote-tracking branch; a local branch with a slash keeps no remote.
fn split_remote(git: &Path, directory: &Path, reference: &str) -> Result<(Option<String>, Option<String>), String> {
    let Some((remote, branch)) = reference.split_once('/') else {
        return Ok((None, None));
    };
    if remote.is_empty() || branch.is_empty() {
        return Ok((None, None));
    }
    let probe = format!("refs/remotes/{reference}");
    let output = git_output(git, directory, &["show-ref", "--verify", "--quiet", &probe])?;
    Ok(if output.status.success() {
        (Some(remote.to_owned()), Some(branch.to_owned()))
    } else {
        (None, None)
    })
}

fn git_lines(git: &Path, directory: &Path, args: &[&str]) -> Result<Vec<String>, String> {
    let output = git_output(git, directory, args)?;
    if !output.status.success() {
        return Err(command_failure("Git 无法读取仓库信息", &output.stderr, &output.stdout));
    }
    Ok(output.stdout.lines().map(str::trim).filter(|line| !line.is_empty()).map(str::to_owned).collect())
}

fn rev_parse_commit(git: &Path, directory: &Path, reference: &str) -> Result<Option<String>, String> {
    let probe = format!("{reference}^{{commit}}");
    let output = git_output(git, directory, &["rev-parse", "--verify", "--quiet", &probe])?;
    if !output.status.success() {
        return Ok(None);
    }
    let commit = output.stdout.trim();
    Ok(is_commit_oid(commit).then(|| commit.to_owned()))
}

fn is_commit_oid(value: &str) -> bool {
    (value.len() == 40 || value.len() == 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn base_unavailable_message(reason: &str, candidates: &[String]) -> String {
    if candidates.is_empty() {
        return reason.to_owned();
    }
    format!("{reason}
可选基点：{}", candidates.join("、"))
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
    if let Ok(text) = crate::launch::terminal_path(path) {
        let _ = git_output(git, source, &["worktree", "remove", "--force", &text]);
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
    fn the_base_contract_deserializes_for_every_kind() {
        let default: WorktreeBase = serde_json::from_str(r#"{"kind":"default"}"#).unwrap();
        assert_eq!(default, WorktreeBase::Default);
        let head: WorktreeBase = serde_json::from_str(r#"{"kind":"head"}"#).unwrap();
        assert_eq!(head, WorktreeBase::Head);
        let reference: WorktreeBase =
            serde_json::from_str(r#"{"kind":"reference","reference":"origin/main"}"#).unwrap();
        assert_eq!(reference, WorktreeBase::Reference { reference: "origin/main".into() });
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
        let error = prepare_with(&missing, &db, &main, Some("task"), &PrepareOptions::default(), &mut |_| {}).unwrap_err();
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
        let error = prepare_with(&fake, &db, &main, Some("task"), &PrepareOptions::default(), &mut |_| {}).unwrap_err();
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
        assert!(run_git(&main, &["worktree", "lock", &crate::launch::terminal_path(&created.directory).unwrap()]));
        let error = cleanup_worktree(&db, &created.directory, false).unwrap_err();
        assert!(error.contains("Git 无法删除工作树"), "{error}");
        assert!(created.directory.is_dir());
        assert_eq!(recorded_worktrees(&db).unwrap().len(), 1);
    }

    /// A repository whose origin is a local bare trunk, with a feature branch
    /// checked out in the main checkout so trunk and HEAD deliberately differ.
    fn repo_with_origin(parent: &Path) -> Option<PathBuf> {
        let bare = parent.join("origin.git");
        std::fs::create_dir_all(&bare).unwrap();
        if !run_git(&bare, &["init", "-q", "--bare", "-b", "main"]) {
            return None;
        }
        let main = init_repo(parent, "shop")?;
        std::fs::write(main.join("tracked.txt"), "root\n").unwrap();
        assert!(run_git(&main, &["add", "tracked.txt"]));
        assert!(run_git(&main, &["commit", "-q", "-m", "root"]));
        let bare_text = crate::launch::terminal_path(&bare).unwrap();
        assert!(run_git(&main, &["remote", "add", "origin", &bare_text]));
        assert!(run_git(&main, &["push", "-q", "origin", "main"]));
        assert!(run_git(&main, &["fetch", "-q", "origin"]));
        assert!(run_git(&main, &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]));
        assert!(run_git(&main, &["checkout", "-q", "-b", "feature/orders"]));
        std::fs::write(main.join("feature.txt"), "feature\n").unwrap();
        assert!(run_git(&main, &["add", "feature.txt"]));
        assert!(run_git(&main, &["commit", "-q", "-m", "feature"]));
        Some(main)
    }

    fn explicit(base: WorktreeBase, branch: Option<&str>) -> PrepareOptions<'_> {
        PrepareOptions { base, branch, require_repository: true }
    }

    #[test]
    fn the_default_base_is_the_remote_trunk_not_the_current_feature_branch() {
        let (temp, db) = database();
        let Some(main) = repo_with_origin(temp.path()) else {
            eprintln!("git unavailable; skipping default base test");
            return;
        };
        let preview = base_preview(&main, None).expect("preview");
        assert!(preview.available, "{preview:?}");
        assert_eq!(preview.kind, "default");
        assert_eq!(preview.reference.as_deref(), Some("origin/main"));
        assert_eq!(preview.remote.as_deref(), Some("origin"));
        assert_eq!(preview.branch.as_deref(), Some("main"));
        assert!(preview.degraded.is_none(), "{preview:?}");
        let head = git_text(&main, &["rev-parse", "HEAD"]);
        let trunk = git_text(&main, &["rev-parse", "origin/main"]);
        assert_ne!(head, trunk, "功能分支必须领先于主干");
        assert_eq!(preview.commit.as_deref(), Some(trunk.as_str()));
        assert_eq!(preview.short_commit.as_deref(), Some(&trunk[..7]));

        let mut seen = Vec::new();
        let created = prepare_worktree_with(&db, &main, Some("task"), &explicit(WorktreeBase::Default, None), &mut |event| seen.push(event))
            .unwrap()
            .expect("worktree");
        assert_eq!(git_text(&created.directory, &["rev-parse", "HEAD"]), trunk);
        assert!(!created.directory.join("feature.txt").exists(), "未提交之外的功能分支提交也不能带进来");
        assert_eq!(seen, vec![WorktreeProgress::Preparing { directory: created.directory.clone(), branch: created.branch.clone() }]);
        // The main checkout keeps its branch, its files and its commit.
        assert_eq!(git_text(&main, &["rev-parse", "HEAD"]), head);
        assert!(main.join("feature.txt").is_file());
    }

    #[test]
    fn the_head_and_an_explicit_reference_create_at_the_selected_commit() {
        let (temp, db) = database();
        let Some(main) = repo_with_origin(temp.path()) else {
            eprintln!("git unavailable; skipping selected base test");
            return;
        };
        let head = git_text(&main, &["rev-parse", "HEAD"]);
        let head_preview = base_preview(&main, Some(&WorktreeBase::Head)).expect("preview");
        assert_eq!(head_preview.kind, "head");
        assert_eq!(head_preview.commit.as_deref(), Some(head.as_str()));
        let from_head = prepare_worktree_with(&db, &main, Some("task"), &explicit(WorktreeBase::Head, None), &mut |_| {})
            .unwrap()
            .expect("worktree");
        assert_eq!(git_text(&from_head.directory, &["rev-parse", "HEAD"]), head);
        assert!(from_head.directory.join("feature.txt").is_file());

        let trunk = git_text(&main, &["rev-parse", "origin/main"]);
        let preview = base_preview(&main, Some(&WorktreeBase::Reference { reference: trunk.clone() })).expect("preview");
        assert!(preview.available, "{preview:?}");
        assert_eq!(preview.commit.as_deref(), Some(trunk.as_str()));
        assert_eq!(preview.short_commit.as_deref(), Some(&trunk[..7]));
        let picked = prepare_worktree_with(
            &db,
            &main,
            Some("task"),
            &explicit(WorktreeBase::Reference { reference: trunk.clone() }, Some("picked")),
            &mut |_| {},
        )
        .unwrap()
        .expect("worktree");
        assert_eq!(picked.branch, "picked");
        assert_eq!(git_text(&picked.directory, &["rev-parse", "HEAD"]), trunk);

        // A base that no longer resolves is a readable refusal and creates nothing.
        let gone = base_preview(&main, Some(&WorktreeBase::Reference { reference: "gone-ref".into() })).expect("preview");
        assert!(!gone.available, "{gone:?}");
        assert!(gone.reason.as_deref().unwrap_or_default().contains("gone-ref"));
        let before = std::fs::read_dir(temp.path()).unwrap().count();
        let error = prepare_worktree_with(&db, &main, Some("task"), &explicit(WorktreeBase::Reference { reference: "gone-ref".into() }, None), &mut |_| {})
            .unwrap_err();
        assert!(error.contains("gone-ref"), "{error}");
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), before);
    }

    /// The dialog shows the branch before anything is written. That name must be
    /// the one the creation really allocates: same task text, same clash handling.
    #[test]
    fn the_preview_names_the_branch_the_creation_will_use() {
        let (temp, db) = database();
        let Some(main) = repo_with_origin(temp.path()) else {
            eprintln!("git unavailable; skipping proposed branch test");
            return;
        };
        let task = Some("feat: hello?\nsecond line");
        let preview = base_preview_for(&main, Some(&WorktreeBase::Default), task).expect("preview");
        assert!(preview.available, "{preview:?}");
        assert_eq!(preview.proposed_branch.as_deref(), Some("feat-hello"));
        let created = prepare_worktree_with(&db, &main, task, &explicit(WorktreeBase::Default, None), &mut |_| {})
            .unwrap()
            .expect("worktree");
        assert_eq!(created.branch, "feat-hello");
        assert_eq!(preview.proposed_branch.as_deref(), Some(created.branch.as_str()));

        // A taken name is avoided identically in the preview and in the creation.
        assert!(run_git(&main, &["branch", "shop-task"]));
        let taken = base_preview_for(&main, Some(&WorktreeBase::Default), Some("shop task")).expect("preview");
        assert_eq!(taken.proposed_branch.as_deref(), Some("shop-task-2"), "{taken:?}");
        let second = prepare_worktree_with(&db, &main, Some("shop task"), &explicit(WorktreeBase::Default, None), &mut |_| {})
            .unwrap()
            .expect("worktree");
        assert_eq!(second.branch, "shop-task-2");

        // No task text falls back to the repository name, the historical default.
        let empty = base_preview_for(&main, Some(&WorktreeBase::Default), None).expect("preview");
        assert_eq!(empty.proposed_branch.as_deref(), Some("shop"));
        assert_eq!(base_preview(&main, None).expect("preview").proposed_branch, empty.proposed_branch);

        // An explicit branch name is what the user sees instead: the proposal keeps
        // following the task, while the creation uses the given name verbatim.
        let explicit_preview = base_preview_for(&main, Some(&WorktreeBase::Default), task).expect("preview");
        assert_eq!(explicit_preview.proposed_branch.as_deref(), Some("feat-hello-2"));
        let named = prepare_worktree_with(&db, &main, task, &explicit(WorktreeBase::Default, Some("manual-name")), &mut |_| {})
            .unwrap()
            .expect("worktree");
        assert_eq!(named.branch, "manual-name");
    }

    #[test]
    fn without_a_remote_only_a_single_local_branch_counts_as_the_default() {
        let (temp, db) = database();
        let Some(single) = init_repo(temp.path(), "solo") else {
            eprintln!("git unavailable; skipping local default test");
            return;
        };
        assert!(run_git(&single, &["commit", "-q", "--allow-empty", "-m", "root"]));
        let preview = base_preview(&single, None).expect("preview");
        assert!(preview.available, "{preview:?}");
        assert_eq!(preview.reference.as_deref(), Some("main"));
        assert_eq!(preview.remote, None);
        assert!(preview.degraded.as_deref().unwrap_or_default().contains("没有远程"), "{preview:?}");

        // Two local branches leave no identifiable default: the user has to choose.
        assert!(run_git(&single, &["branch", "release"]));
        let ambiguous = base_preview(&single, None).expect("preview");
        assert!(!ambiguous.available, "{ambiguous:?}");
        assert_eq!(ambiguous.candidates, vec!["main".to_string(), "release".to_string()]);
        assert!(ambiguous.commit.is_none());
        let error = prepare_worktree_with(&db, &single, Some("task"), &explicit(WorktreeBase::Default, None), &mut |_| {})
            .unwrap_err();
        assert!(error.contains("请选择基点"), "{error}");
        assert!(error.contains("release"), "{error}");
        assert!(!temp.path().join("solo-task").exists());
    }

    #[test]
    fn a_local_branch_with_a_slash_is_not_reported_as_a_remote_base() {
        let (temp, _db) = database();
        let Some(repo) = init_repo(temp.path(), "slash") else {
            eprintln!("git unavailable; skipping slash branch test");
            return;
        };
        assert!(run_git(&repo, &["commit", "-q", "--allow-empty", "-m", "root"]));
        assert!(run_git(&repo, &["branch", "-m", "feat/orders"]));
        let preview = base_preview(&repo, None).expect("preview");
        assert!(preview.available, "{preview:?}");
        assert_eq!(preview.reference.as_deref(), Some("feat/orders"));
        // The name contains a slash but no remote owns it: the 更新 action and the
        // remote fetch must not be offered for it.
        assert_eq!(preview.remote, None, "{preview:?}");
        assert_eq!(preview.branch, None, "{preview:?}");
        let error = base_update(&repo, None).unwrap_err();
        assert!(error.contains("只能更新远程分支基点"), "{error}");
    }

    #[test]
    fn updating_a_remote_base_moves_only_that_branch_and_a_failure_keeps_the_cache() {
        let (temp, _db) = database();
        let Some(main) = repo_with_origin(temp.path()) else {
            eprintln!("git unavailable; skipping base update test");
            return;
        };
        let feature_head = git_text(&main, &["rev-parse", "HEAD"]);
        let cached = base_preview(&main, None).expect("preview");
        // Another clone lands a commit on the remote trunk.
        let other = temp.path().join("other");
        let bare_text = crate::launch::terminal_path(&temp.path().join("origin.git")).unwrap();
        assert!(run_git(temp.path(), &["clone", "-q", &bare_text, other.to_str().unwrap()]));
        std::fs::write(other.join("trunk.txt"), "trunk\n").unwrap();
        assert!(run_git(&other, &["add", "trunk.txt"]));
        assert!(run_git(&other, &["-c", "user.name=cliora", "-c", "user.email=cliora@example.com", "commit", "-q", "-m", "trunk"]));
        assert!(run_git(&other, &["push", "-q", "origin", "main"]));
        let pushed = git_text(&other, &["rev-parse", "HEAD"]);
        assert_eq!(base_preview(&main, None).expect("preview").commit, cached.commit, "更新前缓存不变");

        let updated = base_update(&main, None).expect("update");
        assert_eq!(updated.reference.as_deref(), Some("origin/main"));
        assert_eq!(updated.commit.as_deref(), Some(pushed.as_str()));
        assert_eq!(git_text(&main, &["rev-parse", "HEAD"]), feature_head, "更新不改写当前 HEAD");
        assert_eq!(git_text(&main, &["rev-parse", "refs/remotes/origin/main"]), pushed);

        // A failing update reports Git and leaves the cached base untouched.
        let missing = crate::launch::terminal_path(&temp.path().join("gone.git")).unwrap();
        assert!(run_git(&main, &["remote", "set-url", "origin", &missing]));
        let error = base_update(&main, None).unwrap_err();
        assert!(error.contains("更新远程基点 origin/main 失败"), "{error}");
        assert_eq!(base_preview(&main, None).expect("preview").commit.as_deref(), Some(pushed.as_str()));
        assert_eq!(git_text(&main, &["rev-parse", "HEAD"]), feature_head);
    }

    #[test]
    fn explicit_creation_refuses_a_plain_directory_an_empty_repository_and_a_taken_branch() {
        let (temp, db) = database();
        let plain = temp.path().join("notes");
        std::fs::create_dir(&plain).unwrap();
        let error = prepare_worktree_with(&db, &plain, Some("task"), &explicit(WorktreeBase::Default, None), &mut |_| {})
            .unwrap_err();
        assert!(error.contains("不是 Git 仓库"), "{error}");
        assert!(recorded_worktrees(&db).unwrap().is_empty());

        let Some(empty) = init_repo(temp.path(), "empty") else {
            eprintln!("git unavailable; skipping empty repository test");
            return;
        };
        let error = prepare_worktree_with(&db, &empty, Some("task"), &explicit(WorktreeBase::Default, None), &mut |_| {})
            .unwrap_err();
        assert!(error.contains("还没有提交"), "{error}");
        assert!(!temp.path().join("empty-task").exists());

        let Some(main) = repo_with_origin(temp.path()) else { return };
        let error = prepare_worktree_with(&db, &main, Some("task"), &explicit(WorktreeBase::Head, Some("feature/orders")), &mut |_| {})
            .unwrap_err();
        assert!(error.contains("已存在"), "{error}");
        let first = prepare_worktree_with(&db, &main, Some("shop task"), &explicit(WorktreeBase::Head, None), &mut |_| {})
            .unwrap()
            .expect("first");
        let second = prepare_worktree_with(&db, &main, Some("shop task"), &explicit(WorktreeBase::Head, None), &mut |_| {})
            .unwrap()
            .expect("second");
        assert_ne!(first.branch, second.branch, "自动分支名仍避让冲突");
        assert_ne!(first.directory, second.directory);
    }

    #[test]
    fn a_prepare_retry_reuses_the_recorded_directory_and_branch() {
        let (temp, db) = database();
        let Some(main) = init_repo(temp.path(), "shop") else {
            eprintln!("git unavailable; skipping prepare retry test");
            return;
        };
        std::fs::write(main.join("tracked.txt"), "committed\n").unwrap();
        assert!(run_git(&main, &["add", "tracked.txt"]));
        assert!(run_git(&main, &["commit", "-q", "-m", "root"]));
        write_prepare_command(&db, &main, fail_command()).unwrap();
        let created = prepare_worktree_with(&db, &main, Some("task"), &PrepareOptions::default(), &mut |_| {})
            .unwrap()
            .expect("worktree");
        assert!(finish_prepare(&db, &created).is_err());
        let siblings = std::fs::read_dir(temp.path()).unwrap().count();
        write_prepare_command(&db, &main, &marker_command("ready.txt")).unwrap();
        let retried = retry_prepare(&db, &created.directory).expect("retry");
        assert_eq!(retried.directory, created.directory);
        assert_eq!(retried.branch, created.branch);
        finish_prepare(&db, &retried).unwrap();
        assert!(retried.directory.join("ready.txt").is_file());
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), siblings, "重试不重新分配目录");
        assert_eq!(recorded_worktrees(&db).unwrap().len(), 1, "重试不重复分配分支");
    }

    #[test]
    fn cleanup_refuses_a_worktree_a_running_session_still_uses() {
        let (temp, db) = database();
        let Some(main) = init_repo(temp.path(), "shop") else {
            eprintln!("git unavailable; skipping running session cleanup test");
            return;
        };
        assert!(run_git(&main, &["commit", "-q", "--allow-empty", "-m", "root"]));
        let created = prepare_worktree(&db, &main, Some("task")).unwrap().expect("worktree");
        let inside = [RunningSession { session_id: "session-1".into(), directory: created.directory.join("src") }];
        let error = cleanup_worktree_with_sessions(&db, &created.directory, true, &inside).unwrap_err();
        assert!(error.contains("运行中的会话 session-1"), "{error}");
        assert!(created.directory.is_dir());
        assert_eq!(recorded_worktrees(&db).unwrap().len(), 1, "被拒绝时台账保留");

        // A sibling directory with a similar name is not inside the worktree.
        let sibling = temp.path().join("shop-task-other");
        std::fs::create_dir_all(&sibling).unwrap();
        let outside = [RunningSession { session_id: "session-2".into(), directory: sibling }];
        let removed = cleanup_worktree_with_sessions(&db, &created.directory, false, &outside).unwrap();
        assert!(removed.removed, "{removed:?}");
        assert!(!created.directory.exists());
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
