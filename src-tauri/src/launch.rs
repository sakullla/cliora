use std::env;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::database::Database;
use crate::native::adapter::{self, Scope};
use crate::adapters::{self, CliAdapter, LaunchForm, LaunchMode, Registry};
use crate::credentials::{CredentialStore, SystemCredentialStore};
use crate::projects;
use crate::resources::skills;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalId {
    Auto,
    /// In-app session host. Selectable on the existing terminal control.
    Workbench,
    WindowsTerminal,
    /// Standalone PowerShell 7 (`pwsh.exe`), installed separately from Windows PowerShell 5.
    Pwsh,
    PowerShell,
    Cmd,
    MacTerminal,
    Custom,
    GnomeTerminal,
    Konsole,
    Xterm,
    /// A desktop-form launch starts the installed application directly. This
    /// is a spawn-channel marker carried by the plan, never a selectable
    /// terminal preference.
    Desktop,
}

impl TerminalId {
    fn label(self) -> &'static str {
        match self {
            Self::Auto => "系统默认",
            Self::Workbench => "工作台",
            Self::WindowsTerminal => "Windows Terminal",
            Self::Pwsh => "PowerShell 7",
            Self::PowerShell => "Windows PowerShell",
            Self::Cmd => "CMD（命令提示符）",
            Self::MacTerminal => "Terminal",
            Self::Custom => "自定义",
            Self::GnomeTerminal => "GNOME Terminal",
            Self::Konsole => "Konsole",
            Self::Xterm => "XTerm",
            Self::Desktop => "桌面应用",
        }
    }

    fn binary(self) -> Option<&'static str> {
        match self {
            Self::Auto | Self::Workbench => None,
            Self::WindowsTerminal => Some("wt.exe"),
            Self::Pwsh => Some("pwsh.exe"),
            Self::PowerShell => Some("powershell.exe"),
            Self::Cmd => Some("cmd.exe"),
            Self::MacTerminal => Some("/usr/bin/open"),
            Self::Custom => None,
            Self::GnomeTerminal => Some("gnome-terminal"),
            Self::Konsole => Some("konsole"),
            Self::Xterm => Some("xterm"),
            Self::Desktop => None,
        }
    }

    fn platform(self) -> bool {
        match self {
            Self::Auto | Self::Workbench => true,
            Self::WindowsTerminal | Self::Pwsh | Self::PowerShell | Self::Cmd => cfg!(windows),
            Self::MacTerminal => cfg!(target_os = "macos"),
            Self::Custom => true,
            Self::GnomeTerminal | Self::Konsole | Self::Xterm => cfg!(target_os = "linux"),
            // Desktop launches bypass terminal selection entirely.
            Self::Desktop => false,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOption {
    pub id: TerminalId,
    pub label: &'static str,
    pub available: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchSettings {
    pub selected: TerminalId,
    pub terminals: Vec<TerminalOption>,
    pub presets: Vec<TerminalPreset>,
    pub custom: Option<CustomTerminal>,
    pub cli_mode: LaunchMode,
    pub project_mode: LaunchMode,
}

/// A saved launch command. `{script}` is replaced with the script file; arguments are not passed through a shell.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomTerminal {
    pub program: String,
    pub args: Vec<String>,
}

/// An installed terminal whose launch command is already known. Choosing one only fills `CustomTerminal`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalPreset {
    pub id: String,
    pub label: String,
    pub program: String,
    pub args: Vec<String>,
}

struct KnownTerminal {
    id: &'static str,
    label: &'static str,
    args: &'static [&'static str],
    find: fn() -> Option<PathBuf>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
struct DefaultLaunchModes {
    #[serde(default)]
    cli: LaunchMode,
    #[serde(default)]
    project: LaunchMode,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRequest {
    pub tool_id: String,
    pub project_id: Option<String>,
    pub session_id: Option<String>,
    #[serde(default)]
    pub directory: Option<String>,
    #[serde(default)]
    pub initial_prompt: Option<String>,
    pub mode: LaunchMode,
    /// Continue the latest session in the selected directory. Never combined
    /// with `session_id`. Absent requests stay a normal launch.
    #[serde(default)]
    pub resume_latest: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchResult {
    pub tool_id: String,
    pub project_id: Option<String>,
    pub mode: LaunchMode,
    pub terminal: TerminalId,
    pub status: &'static str,
    pub session_id: Option<String>,
    pub remote_session_id: Option<String>,
}

/// A managed connection key the CLI reads only from the OS environment
/// (adapter-declared via `connection_secret_via_launch_env`). The plan carries
/// the adapter-owned environment name and the credential-store reference; the
/// value is resolved from the system credential store at spawn time and never
/// serialized, logged, or returned through IPC.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LaunchCredential {
    pub env_name: String,
    pub secret_ref: String,
}

#[derive(Clone, Debug)]
pub struct LaunchPlan {
    pub account_version: Option<u32>,
    pub account_context: Option<(String, crate::accounts::NativeContext)>,
    pub tool_id: String,
    pub project_id: Option<String>,
    pub mode: LaunchMode,
    pub executable: PathBuf,
    pub cli_args: Vec<String>,
    pub directory: PathBuf,
    pub terminal: TerminalId,
    pub session_markers: &'static [&'static str],
    pub credential: Option<LaunchCredential>,
    pub remote_session_id: Option<String>,
    pub remote_end_args: Option<Vec<String>>,
    /// Non-secret variables for the spawned process (remote askpass wiring).
    pub environment: Vec<(String, String)>,
}

/// Durable metadata for remote sessions.  The SSH attachment is ephemeral,
/// while this index survives app restarts so the workbench can discover and
/// reattach every remote agent independently.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSessionIndexEntry {
    pub remote_session_id: String,
    pub project_id: String,
    pub target_id: String,
    pub tool_id: String,
    pub directory: String,
    pub mode: LaunchMode,
    pub started_at: u64,
    pub last_seen_at: u64,
}

const REMOTE_SESSION_INDEX_KEY: &str = "remote_session_index_v1";
const REMOTE_REATTACH_PREFIX: &str = "__remote_reattach__:";

fn read_remote_session_index(db: &Database) -> Result<Vec<RemoteSessionIndexEntry>, String> {
    let raw = read_setting(db, REMOTE_SESSION_INDEX_KEY)?;
    Ok(raw
        .and_then(|value| serde_json::from_str::<Vec<RemoteSessionIndexEntry>>(&value).ok())
        .unwrap_or_default())
}

fn write_remote_session_index(db: &Database, entries: &[RemoteSessionIndexEntry]) -> Result<(), String> {
    let value = serde_json::to_string(entries).map_err(|error| error.to_string())?;
    write_setting(db, REMOTE_SESSION_INDEX_KEY, &value)
}

pub fn list_remote_sessions(db: &Database) -> Result<Vec<RemoteSessionIndexEntry>, String> {
    let entries = read_remote_session_index(db)?;
    // Older builds recorded one index row for every local SSH attachment. A
    // remote project/tool has one persistent tmux/screen session, so collapse
    // those historical rows before the workbench tries to reattach them.
    let mut latest = std::collections::HashMap::<(String, String, String), RemoteSessionIndexEntry>::new();
    for entry in entries {
        let key = (entry.target_id.clone(), entry.project_id.clone(), entry.tool_id.clone());
        let replace = latest.get(&key).is_none_or(|current| entry.last_seen_at > current.last_seen_at);
        if replace { latest.insert(key, entry); }
    }
    let mut entries: Vec<_> = latest.into_values().collect();
    // Drop rows for removed remote projects before asking SSH to reattach.
    let project_ids: std::collections::HashSet<String> = crate::remote::list_projects(db, None)
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|project| project.id)
        .collect();
    entries.retain(|entry| project_ids.contains(&entry.project_id));
    // A reachable host is authoritative about whether the persistent terminal
    // still exists. If probing fails (offline host, password prompt, etc.) keep
    // the row so the user can retry later instead of silently losing it.
    let targets = crate::remote::list_targets(db).map_err(|error| error.to_string())?;
    for target in targets.into_iter().filter(|target| target.enabled) {
        let ids: Vec<String> = entries
            .iter()
            .filter(|entry| entry.target_id == target.id)
            .map(|entry| entry.remote_session_id.clone())
            .collect();
        if ids.is_empty() { continue; }
        if let Ok(active) = crate::remote::active_session_ids(&target, &ids) {
            entries.retain(|entry| entry.target_id != target.id || active.contains(&entry.remote_session_id));
        }
    }
    entries.sort_by(|a, b| b.last_seen_at.cmp(&a.last_seen_at));
    let _ = write_remote_session_index(db, &entries);
    Ok(entries)
}

/// Durable index for history views. Ended and offline sessions stay visible;
/// the workbench reattach path continues to use `list_remote_sessions`.
pub fn list_remote_history(db: &Database) -> Result<Vec<RemoteSessionIndexEntry>, String> {
    let mut entries = read_remote_session_index(db)?;
    entries.sort_by(|a, b| b.last_seen_at.cmp(&a.last_seen_at));
    Ok(entries)
}

pub fn forget_remote_session(db: &Database, remote_session_id: &str) -> Result<(), String> {
    let entries = read_remote_session_index(db)?
        .into_iter()
        .filter(|entry| entry.remote_session_id != remote_session_id)
        .collect::<Vec<_>>();
    write_remote_session_index(db, &entries)
}

pub fn remember_remote_session(
    db: &Database,
    project_id: &str,
    tool_id: &str,
    mode: LaunchMode,
    remote_session_id: &str,
) -> Result<(), String> {
    let project_key = project_id.strip_prefix("remote:").unwrap_or(project_id);
    let project = crate::remote::list_projects(db, None).map_err(|error| error.to_string())?.into_iter().find(|item| item.id == project_key)
        .ok_or_else(|| "远程项目不存在".to_owned())?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|value| value.as_millis() as u64).unwrap_or_default();
    let mut entries = read_remote_session_index(db)?;
    // Keep the durable index aligned with the one-session-per-project/tool
    // contract. This also cleans rows created by pre-reuse versions.
    let mut compacted = std::collections::HashMap::<(String, String, String), RemoteSessionIndexEntry>::new();
    for entry in entries.drain(..) {
        let key = (entry.target_id.clone(), entry.project_id.clone(), entry.tool_id.clone());
        let replace = compacted.get(&key).is_none_or(|current| entry.last_seen_at > current.last_seen_at);
        if replace { compacted.insert(key, entry); }
    }
    let mut entries: Vec<_> = compacted.into_values().collect();
    if let Some(existing) = entries.iter_mut().find(|entry| entry.remote_session_id == remote_session_id) {
        existing.last_seen_at = now;
    } else {
        entries.retain(|entry| !(entry.project_id == project_key && entry.target_id == project.target_id && entry.tool_id == tool_id));
        entries.push(RemoteSessionIndexEntry { remote_session_id: remote_session_id.to_owned(), project_id: project_key.to_owned(), target_id: project.target_id, tool_id: tool_id.to_owned(), directory: project.path, mode, started_at: now, last_seen_at: now });
    }
    write_remote_session_index(db, &entries)
}

fn remote_project_key(project_id: Option<&str>) -> Option<&str> {
    project_id.and_then(|value| value.strip_prefix("remote:"))
}

fn remote_shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn remote_session_name(project_id: &str, suffix: Option<&str>) -> String {
    let mut name = String::from("cliora-");
    for ch in project_id.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
            name.push(ch);
        }
    }
    name.truncate(48);
    if name == "cliora-" { name.push_str("session"); }
    if let Some(suffix) = suffix.filter(|value| !value.is_empty()) {
        name.push('-');
        name.push_str(suffix);
    }
    name
}

/// Same capability advertisement as a local Cliora PTY. Full-screen CLIs such as
/// Codex draw braille chrome only when stdout is truecolor, and a POSIX locale
/// drops those bytes before they reach the local terminal.
const REMOTE_TERMINAL_ENV: &str = "export TERM=xterm-256color COLORTERM=truecolor; case \"${LC_ALL:-${LC_CTYPE:-$LANG}}\" in *.UTF-8|*.utf8) ;; *) export LANG=C.UTF-8 LC_ALL=C.UTF-8 ;; esac";

fn remote_persistent_command(path: &str, executable: &str, args: &[String], session: &str) -> String {
    let mut cli = format!("exec {}", remote_shell_quote(executable));
    for arg in args { cli.push(' '); cli.push_str(&remote_shell_quote(arg)); }
    let command = format!("if ! command -v {} >/dev/null 2>&1; then echo {}; exit 127; fi; cd -- {} && {cli}", remote_shell_quote(executable), remote_shell_quote(&format!("Cliora: remote CLI '{}' is not installed or not on PATH", executable)), remote_shell_quote(path));
    // OpenSSH on Windows may allocate a `dumb` terminal. tmux then exports
    // its own TERM value, which is not sufficient for full-screen CLIs.
    // Run the payload through a shell that advertises the PTY we provide.
    let interactive = remote_shell_quote(&format!("{REMOTE_TERMINAL_ENV}; {command}"));
    let session_q = remote_shell_quote(session);
    let path_q = remote_shell_quote(path);
    format!(
        "if command -v tmux >/dev/null 2>&1; then tmux -u set-option -g status off >/dev/null 2>&1 || true; tmux -u set-window-option -g status off >/dev/null 2>&1 || true; tmux -u set-environment -g COLORTERM truecolor >/dev/null 2>&1 || true; tmux -u new-session -A -s {session_q} -c {path_q} -- sh -lc {interactive}; elif command -v screen >/dev/null 2>&1; then screen -U -dmS {session_q} sh -lc {interactive} >/dev/null 2>&1 || true; screen -U -r {session_q}; else echo 'Cliora requires tmux or screen for persistent remote sessions' >&2; exit 42; fi"
    )
}

pub(crate) fn remote_reattach_command(session: &str) -> String {
    let session_q = remote_shell_quote(session);
    let screen_token = session.replace(['.', '\\', '\n'], "");
    format!(
        "{REMOTE_TERMINAL_ENV}; if command -v tmux >/dev/null 2>&1 && tmux -u has-session -t {session_q} 2>/dev/null; then tmux -u set-option -g status off >/dev/null 2>&1 || true; tmux -u set-window-option -g status off >/dev/null 2>&1 || true; tmux -u set-environment -g COLORTERM truecolor >/dev/null 2>&1 || true; exec tmux -u attach-session -t {session_q}; elif command -v screen >/dev/null 2>&1 && screen -list | grep -q '[.]{screen_token}'; then exec screen -U -r {session_q}; else echo 'Cliora remote session is unavailable' >&2; exit 44; fi"
    )
}

#[derive(Clone, Debug)]
pub struct TerminalCommand {
    pub program: String,
    pub args: Vec<String>,
    pub directory: PathBuf,
    pub session_markers: &'static [&'static str],
    /// macOS runs this from a file. Terminal's `do script` types into the tty,
    /// and the canonical input limit drops everything after 1024 bytes.
    pub mac_script: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LaunchStage {
    ProjectDirectory,
    Configuration,
    Skills,
    Tool,
    Terminal,
}

#[derive(Debug)]
pub struct LaunchPlanError {
    pub stage: LaunchStage,
    pub message: String,
}

impl LaunchPlanError {
    fn new(stage: LaunchStage, message: String) -> Self {
        Self { stage, message }
    }
}

fn remote_launch_plan(
    db: &Database,
    registry: &Registry,
    request: &LaunchRequest,
) -> Result<Option<LaunchPlan>, LaunchPlanError> {
    let Some(project_key) = remote_project_key(request.project_id.as_deref()) else {
        return Ok(None);
    };
    crate::remote::ensure_enabled(db)
        .map_err(|error| LaunchPlanError::new(LaunchStage::ProjectDirectory, error.to_string()))?;
    let project = crate::remote::list_projects(db, None)
        .map_err(|error| LaunchPlanError::new(LaunchStage::ProjectDirectory, error.to_string()))?
        .into_iter()
        .find(|item| item.id == project_key)
        .ok_or_else(|| LaunchPlanError::new(LaunchStage::ProjectDirectory, "远程项目不存在".into()))?;
    let target = crate::remote::list_targets(db)
        .map_err(|error| LaunchPlanError::new(LaunchStage::ProjectDirectory, error.to_string()))?
        .into_iter()
        .find(|item| item.id == project.target_id && item.enabled)
        .ok_or_else(|| LaunchPlanError::new(LaunchStage::ProjectDirectory, "远程目标不可用".into()))?;
    let adapter = registry
        .get(&request.tool_id)
        .ok_or_else(|| LaunchPlanError::new(LaunchStage::Tool, "未注册的 CLI 不能启动".into()))?;
    let mut launch_args = adapter
        .launch_args(None, request.mode)
        .map_err(|error| LaunchPlanError::new(LaunchStage::Tool, error))?;
    let path = project.path.trim();
    if path.is_empty() || path.chars().any(|ch| ch.is_control()) {
        return Err(LaunchPlanError::new(LaunchStage::ProjectDirectory, "远程路径无效".into()));
    }
    let executable = std::env::var_os("CLIORA_SSH_BINARY")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("ssh"));
    // Keep OpenSSH informational shutdown lines out of the interactive PTY;
    // the workbench already reports connection state in its status bar.
    let mut args = vec!["-tt".into(), "-o".into(), "LogLevel=ERROR".into()];
    args.extend(crate::remote::connection_args(&target));
    let requested_session = request.session_id.as_deref().and_then(|value| value.strip_prefix(REMOTE_REATTACH_PREFIX));
    // A quick launch reuses the latest persistent session for this remote
    // project/tool. Closing the app therefore detaches the local transport
    // without creating another tmux/screen process next time.
    let indexed_session = list_remote_sessions(db).ok().and_then(|items| items.into_iter().find(|item| item.project_id == project_key && item.target_id == project.target_id && item.tool_id == request.tool_id).map(|item| item.remote_session_id));
    let existing_session = requested_session.map(str::to_owned).or(indexed_session);
    let session = existing_session.clone().unwrap_or_else(|| {
        let suffix = uuid::Uuid::new_v4().simple().to_string()[..8].to_owned();
        remote_session_name(project_key, Some(&suffix))
    });
    if let Some(prompt) = request.initial_prompt.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        launch_args.push(prompt.to_owned());
    }
    // Remote project reattach requests use the reserved session marker so the
    // existing IPC contract stays backwards compatible with native resume IDs.
    // A quick launch reuses the persistent tmux/screen session when it is
    // still alive, but recreates the CLI in the same named session when an old
    // index row points at a session that no longer exists. Explicit reattach
    // requests keep strict attach semantics so the UI can report a real
    // connection failure.
    let remote_command = if requested_session.is_some() {
        remote_reattach_command(&session)
    } else {
        remote_persistent_command(path, adapter.command(), &launch_args, &session)
    };
    let mut remote_end_args = args.clone();
    remote_end_args.push(format!("tmux kill-session -t {} 2>/dev/null || screen -S {} -X quit 2>/dev/null || true", remote_shell_quote(&session), remote_shell_quote(&session)));
    args.push(remote_command);
    let terminal = session_terminal(db)
        .map_err(|error| LaunchPlanError::new(LaunchStage::Terminal, error))?;
    Ok(Some(LaunchPlan {
        account_version: None,
        account_context: None,
        tool_id: request.tool_id.clone(),
        project_id: request.project_id.clone(),
        mode: request.mode,
        executable,
        cli_args: args,
        directory: PathBuf::from(path),
        terminal,
        session_markers: &[],
        credential: None,
        remote_session_id: Some(session),
        remote_end_args: Some(remote_end_args),
        environment: crate::remote::password::askpass_environment(&target),
    }))
}

fn on_path(name: &str) -> bool {
    crate::process_environment::directories()
        .into_iter()
        .any(|directory| directory.join(name).is_file())
}

fn app_binary(bundle: &Path) -> Option<PathBuf> {
    let plist = bundle.join("Contents/Info.plist");
    let output = Command::new("/usr/bin/defaults")
        .args(["read", &plist.to_string_lossy(), "CFBundleExecutable"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let name = String::from_utf8(output.stdout).ok()?;
    let binary = bundle.join("Contents/MacOS").join(name.trim());
    binary.is_file().then_some(binary)
}

fn find_bundle_binary(name: &str) -> Option<PathBuf> {
    let mut bundles = vec![PathBuf::from("/Applications").join(name)];
    if let Some(home) = dirs::home_dir() {
        bundles.push(home.join("Applications").join(name));
    }
    bundles.into_iter().find(|path| path.is_dir()).and_then(|path| app_binary(&path))
}

fn find_tabby() -> Option<PathBuf> {
    find_bundle_binary("Tabby.app")
}

fn find_ghostty() -> Option<PathBuf> {
    find_bundle_binary("Ghostty.app").map(|_| PathBuf::from("/usr/bin/open"))
}

/// Launch recipes verified from the terminal's own CLI, not one enum variant per product.
/// Tabby runs `run <command> <args…>` (`tabby-local` CLI). Ghostty accepts
/// `open -na Ghostty.app --args --wait-after-command=true -e <command>` (VS Code's external terminal).
fn known_terminals() -> &'static [KnownTerminal] {
    &[
        KnownTerminal { id: "tabby", label: "Tabby", args: &["run", "/bin/sh", "{script}"], find: find_tabby },
        KnownTerminal {
            id: "ghostty",
            label: "Ghostty",
            args: &["-na", "Ghostty.app", "--args", "--wait-after-command=true", "-e", "/bin/sh", "{script}"],
            find: find_ghostty,
        },
    ]
}

pub fn terminal_presets() -> Vec<TerminalPreset> {
    known_terminals()
        .iter()
        .filter_map(|preset| {
            let program = (preset.find)()?;
            Some(TerminalPreset {
                id: preset.id.to_owned(),
                label: preset.label.to_owned(),
                program: program.display().to_string(),
                args: preset.args.iter().map(|arg| (*arg).to_owned()).collect(),
            })
        })
        .collect()
}

/// PowerShell 7 is usually on PATH, but its installer can skip that; fall back to the default install root.
fn pwsh_path() -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    let on_path = crate::process_environment::directories().into_iter().map(|directory| directory.join("pwsh.exe"));
    let installed = ["ProgramFiles", "ProgramW6432"]
        .into_iter()
        .filter_map(env::var_os)
        .map(|root| PathBuf::from(root).join(r"PowerShell\7\pwsh.exe"));
    on_path.chain(installed).find(|path| path.is_absolute() && path.is_file())
}

/// Windows Terminal runs the command we give it, not its default profile, so prefer PowerShell 7 when present.
fn windows_terminal_shell() -> Result<String, String> {
    match pwsh_path() {
        Some(path) => terminal_path(&path),
        None => Ok("powershell.exe".into()),
    }
}

fn terminal_available(id: TerminalId) -> bool {
    match id {
        TerminalId::Workbench | TerminalId::Custom => true,
        TerminalId::Pwsh => pwsh_path().is_some(),
        #[cfg(windows)]
        TerminalId::Cmd => system_console_path(TerminalId::Cmd).is_ok() && system_console_path(TerminalId::PowerShell).is_ok(),
        other => other.binary().is_some_and(on_path),
    }
}

fn supported_terminals() -> &'static [TerminalId] {
    if cfg!(windows) {
        &[TerminalId::WindowsTerminal, TerminalId::Pwsh, TerminalId::PowerShell, TerminalId::Cmd]
    } else if cfg!(target_os = "macos") {
        &[TerminalId::MacTerminal]
    } else {
        &[
            TerminalId::GnomeTerminal,
            TerminalId::Konsole,
            TerminalId::Xterm,
        ]
    }
}

pub fn terminal_options() -> Vec<TerminalOption> {
    let mut options = Vec::new();
    options.push(TerminalOption {
        id: TerminalId::Workbench,
        label: TerminalId::Workbench.label(),
        available: true,
    });
    let available = supported_terminals().iter().any(|terminal| terminal_available(*terminal));
    options.push(TerminalOption {
        id: TerminalId::Auto,
        label: TerminalId::Auto.label(),
        available,
    });
    for id in supported_terminals() {
        options.push(TerminalOption {
            id: *id,
            label: id.label(),
            available: terminal_available(*id),
        });
    }
    options.push(TerminalOption {
        id: TerminalId::Custom,
        label: TerminalId::Custom.label(),
        available: true,
    });
    options
}

fn read_setting(db: &Database, key: &str) -> Result<Option<String>, String> {
    db.with_connection(|conn| {
        conn.query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            [key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())
    })
}

fn write_setting(db: &Database, key: &str, value: &str) -> Result<(), String> {
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
        .map_err(|error| error.to_string())?;
        Ok(())
    })
}

pub fn terminal_preference(db: &Database) -> Result<TerminalId, String> {
    adopt_workbench_default(db)?;
    let Some(text) = read_setting(db, "preferred_terminal")? else {
        return Ok(TerminalId::Workbench);
    };
    let name: String = serde_json::from_str(&text).map_err(|_| "终端设置格式无法识别".to_string())?;
    // Older builds stored a product name. Keep that choice as a command template.
    if name == "tabby" {
        return migrate_removed_terminal(db, "tabby");
    }
    serde_json::from_str(&text).map_err(|_| "终端设置格式无法识别".into())
}

fn adopt_workbench_default(db: &Database) -> Result<(), String> {
    if read_setting(db, "terminal_default_epoch")?.is_some() {
        return Ok(());
    }
    if let Some(text) = read_setting(db, "preferred_terminal")? {
        if serde_json::from_str::<TerminalId>(&text).ok() == Some(TerminalId::Auto) {
            let value = serde_json::to_string(&TerminalId::Workbench).map_err(|error| error.to_string())?;
            write_setting(db, "preferred_terminal", &value)?;
        }
    }
    write_setting(db, "terminal_default_epoch", "1")
}

fn migrate_removed_terminal(db: &Database, id: &str) -> Result<TerminalId, String> {
    if let Some(preset) = terminal_presets().into_iter().find(|preset| preset.id == id) {
        store_custom(db, &CustomTerminal { program: preset.program, args: preset.args })?;
        write_setting(db, "preferred_terminal", &serde_json::to_string(&TerminalId::Custom).map_err(|error| error.to_string())?)?;
        return Ok(TerminalId::Custom);
    }
    write_setting(db, "preferred_terminal", &serde_json::to_string(&TerminalId::Auto).map_err(|error| error.to_string())?)?;
    Ok(TerminalId::Auto)
}

fn stored_custom(db: &Database) -> Result<Option<CustomTerminal>, String> {
    let Some(text) = read_setting(db, "custom_terminal")? else {
        return Ok(None);
    };
    serde_json::from_str(&text).map(Some).map_err(|_| "自定义终端格式无法识别".into())
}

fn store_custom(db: &Database, custom: &CustomTerminal) -> Result<(), String> {
    let value = serde_json::to_string(custom).map_err(|error| error.to_string())?;
    write_setting(db, "custom_terminal", &value)
}

fn normalize_custom(program: &str, args: &[String]) -> Result<CustomTerminal, String> {
    let trimmed = program.trim();
    if trimmed.is_empty() {
        return Err("请填写终端程序".into());
    }
    let mut program_path = PathBuf::from(trimmed);
    if program_path.extension().and_then(|ext| ext.to_str()) == Some("app") {
        program_path = app_binary(&program_path).ok_or("无法从这个应用包找到可执行文件")?;
    }
    if !program_path.is_file() {
        return Err("终端程序不存在".into());
    }
    let mut args: Vec<String> = args.iter().map(|arg| arg.trim().to_owned()).filter(|arg| !arg.is_empty()).collect();
    if args.is_empty() {
        args.push("{script}".into());
    }
    let matches: Vec<_> = terminal_presets().into_iter().filter(|preset| preset.program == program_path.display().to_string()).collect();
    if matches.len() == 1 && args == ["{script}"] {
        args = matches[0].args.clone();
    }
    if args.iter().filter(|arg| arg.as_str() == "{script}").count() != 1 {
        return Err("参数里要有且只有一个 {script}，它会换成要运行的脚本".into());
    }
    if args.iter().any(|arg| arg.contains('\0') || arg.contains('\n') || arg.contains('\r')) {
        return Err("参数不能包含换行或空字符".into());
    }
    Ok(CustomTerminal { program: program_path.display().to_string(), args })
}

pub fn set_custom_terminal(db: &Database, program: String, args: Vec<String>) -> Result<LaunchSettings, String> {
    let custom = normalize_custom(&program, &args)?;
    store_custom(db, &custom)?;
    set_terminal(db, TerminalId::Custom)
}

pub(crate) fn saved_launch_modes(db: &Database) -> Result<(LaunchMode, LaunchMode), String> {
    let stored: Option<String> = db.with_connection(|conn| {
        conn.query_row(
            "SELECT value FROM app_settings WHERE key = 'default_launch_modes'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())
    })?;
    let modes = match stored {
        None => DefaultLaunchModes { cli: LaunchMode::Normal, project: LaunchMode::Normal },
        Some(text) => serde_json::from_str(&text).map_err(|_| "默认启动模式格式无法识别")?,
    };
    Ok((modes.cli, modes.project))
}

pub fn settings(db: &Database) -> Result<LaunchSettings, String> {
    let (cli_mode, project_mode) = saved_launch_modes(db)?;
    Ok(LaunchSettings {
        selected: terminal_preference(db)?,
        terminals: terminal_options(),
        presets: terminal_presets(),
        custom: stored_custom(db)?,
        cli_mode,
        project_mode,
    })
}

pub fn set_default_mode(db: &Database, target: &str, mode: LaunchMode) -> Result<LaunchSettings, String> {
    if target != "cli" && target != "project" {
        return Err("启动默认范围无效".into());
    }
    let (cli, project) = saved_launch_modes(db)?;
    let modes = match target {
        "cli" => DefaultLaunchModes { cli: mode, project },
        "project" => DefaultLaunchModes { cli, project: mode },
        _ => unreachable!(),
    };
    let value = serde_json::to_string(&modes).map_err(|error| error.to_string())?;
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES ('default_launch_modes', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![value],
        )
        .map_err(|error| error.to_string())?;
        Ok(())
    })?;
    settings(db)
}

pub fn set_terminal(db: &Database, terminal: TerminalId) -> Result<LaunchSettings, String> {
    if !terminal.platform() {
        return Err("当前系统不支持所选终端".into());
    }
    if terminal == TerminalId::Custom && stored_custom(db)?.is_none() {
        return Err("请先填写自定义终端命令".into());
    }
    if !terminal_options()
        .iter()
        .any(|option| option.id == terminal && option.available)
    {
        return Err("所选终端不可用，请在设置中选择可用终端".into());
    }
    let value = serde_json::to_string(&terminal).map_err(|error| error.to_string())?;
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES ('preferred_terminal', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![value],
        )
        .map_err(|error| error.to_string())?;
        Ok(())
    })?;
    settings(db)
}

fn session_terminal(db: &Database) -> Result<TerminalId, String> {
    if terminal_preference(db)? == TerminalId::Workbench {
        Ok(TerminalId::Workbench)
    } else {
        selected_terminal(db)
    }
}

fn selected_terminal(db: &Database) -> Result<TerminalId, String> {
    let mut preferred = terminal_preference(db)?;
    if preferred == TerminalId::Workbench {
        preferred = TerminalId::Auto;
    }
    let options = terminal_options();
    if preferred == TerminalId::Auto {
        return options
            .into_iter()
            .find(|option| {
                !matches!(option.id, TerminalId::Auto | TerminalId::Workbench | TerminalId::Custom) && option.available
            })
            .map(|option| option.id)
            .ok_or_else(|| "未找到可用的外部终端，请安装终端后重试".into());
    }
    if preferred == TerminalId::Custom {
        let custom = stored_custom(db)?.ok_or("请先在设置里填写自定义终端命令")?;
        if !Path::new(&custom.program).is_file() {
            return Err("自定义终端程序不存在，请在设置里重新选择".into());
        }
        return Ok(TerminalId::Custom);
    }
    if options
        .iter()
        .any(|option| option.id == preferred && option.available)
    {
        Ok(preferred)
    } else {
        Err("所选终端当前不可用，请在设置中更换终端".into())
    }
}

fn custom_cli_path(db: &Database, tool: &str) -> Result<Option<PathBuf>, String> {
    db.with_connection(|conn| {
        let path: Option<String> = conn
            .query_row(
                "SELECT path FROM installation_choices WHERE tool = ?1",
                [tool],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        Ok(path.map(PathBuf::from))
    })
}

pub fn plan(
    db: &Database,
    registry: &Registry,
    home: &Path,
    request: LaunchRequest,
) -> Result<LaunchPlan, String> {
    plan_with_stage(db, registry, home, request).map_err(|error| error.message)
}

/// Resolve the launch credential for adapters whose managed connection key is
/// delivered only through the child environment. File-channel adapters (the
/// legacy enum five included) and tools without a managed env key stay
/// unchanged; only the environment name and store reference are planned —
/// the stored value is read at spawn time.
fn launch_credential_binding(
    db: &Database,
    adapter: &dyn CliAdapter,
    tool_id: &str,
    scope: Scope,
    directory: &Path,
) -> Result<Option<LaunchCredential>, String> {
    if !adapter.connection_secret_via_launch_env() {
        return Ok(None);
    }
    // Env-channel keys are global by adapter policy; a project-scoped launch
    // still receives the globally applied connection when its own scope has
    // no key binding. Lookup keys mirror apply's scope_key canonicalization.
    let mut keys = Vec::new();
    if scope == Scope::Project {
        let canonical = directory
            .canonicalize()
            .unwrap_or_else(|_| directory.to_path_buf());
        keys.push(format!("project:{}", canonical.display()));
    }
    keys.push("global".into());
    for key in keys {
        let Some(binding) = crate::native::apply::get_registered_binding(db, tool_id, &key)? else {
            continue;
        };
        let Some(connection) = binding
            .applied_profile
            .as_ref()
            .and_then(|snapshot| snapshot.runtime_profile.connection.as_ref())
        else {
            continue;
        };
        let Some(secret_ref) = connection
            .secret_ref
            .as_deref()
            .filter(|id| !id.is_empty())
        else {
            continue;
        };
        let env_name = adapter
            .auth_env_name(connection)
            .ok_or("无法确定 CLI 认证环境变量")?;
        if !crate::native::profile::valid_env_name(&env_name) {
            return Err("CLI 认证环境变量名称无效".into());
        }
        return Ok(Some(LaunchCredential {
            env_name,
            secret_ref: secret_ref.to_owned(),
        }));
    }
    Ok(None)
}

/// Read the planned credential value from the system credential store at
/// injection time. The returned pair exists only to reach the child process
/// environment; it is never placed in the plan, a log line, or an IPC payload.
fn resolve_credential(
    plan: &LaunchPlan,
    credentials: &dyn CredentialStore,
) -> Result<Option<(String, String)>, String> {
    let Some(spec) = &plan.credential else {
        return Ok(None);
    };
    let value = crate::native::auth::stored_launch_credential(&spec.secret_ref, credentials)
        .map_err(|message| format!("无法注入托管连接密钥：{message}"))?;
    Ok(Some((spec.env_name.clone(), value)))
}

pub fn plan_with_stage(
    db: &Database,
    registry: &Registry,
    home: &Path,
    request: LaunchRequest,
) -> Result<LaunchPlan, LaunchPlanError> {
    if request.resume_latest && request.session_id.is_some() {
        return Err(LaunchPlanError::new(
            LaunchStage::Tool,
            "恢复最近会话不能同时指定会话编号".into(),
        ));
    }
    if let Some(native_id)=&request.session_id {
        if let Some(id)=crate::history::unique_session_id(db,&request.tool_id,native_id).map_err(|message|LaunchPlanError::new(LaunchStage::Configuration,message))? {
            return crate::history::resume_plan(db,registry,home,&id,request.mode).map_err(|message|LaunchPlanError::new(LaunchStage::Configuration,message));
        }
    }
    let original = request
        .session_id
        .as_deref()
        .map(|id| {
            crate::history::native_session_directory(db, &request.tool_id, id)
                .map_err(|message| LaunchPlanError::new(LaunchStage::ProjectDirectory, message))
        })
        .transpose()?
        .flatten();
    if request.session_id.is_some()
        && original.is_none()
        && request.directory.is_none()
        && request.project_id.is_none()
    {
        return Err(LaunchPlanError::new(
            LaunchStage::ProjectDirectory,
            "未找到此会话的原工作目录，请刷新会话索引，或明确选择工作目录。".into(),
        ));
    }
    let directory = original.or_else(|| request.directory.as_ref().map(PathBuf::from));
    plan_with_stage_at(db, registry, home, request, directory.as_deref(), None)
}

pub fn plan_history(
    db: &Database,
    registry: &Registry,
    home: &Path,
    request: LaunchRequest,
    cwd: &Path,
) -> Result<LaunchPlan, LaunchPlanError> {
    plan_with_stage_at(db, registry, home, request, Some(cwd), None)
}

pub fn plan_history_context(db: &Database, registry: &Registry, home: &Path, request: LaunchRequest, cwd: &Path, context: Option<(String, crate::accounts::NativeContext)>) -> Result<LaunchPlan, LaunchPlanError> {
    plan_with_stage_at(db, registry, home, request, Some(cwd), Some(context))
}

/// Directory of the desktop executable. A direct launch, or a selected
/// directory whose adapter returns no desktop arguments, starts here instead
/// of the user home or the project path.
fn executable_directory(executable: &Path) -> PathBuf {
    executable
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn plan_with_stage_at(
    db: &Database,
    registry: &Registry,
    home: &Path,
    request: LaunchRequest,
    directory_override: Option<&Path>,
    resume_context: Option<Option<(String, crate::accounts::NativeContext)>>,
) -> Result<LaunchPlan, LaunchPlanError> {
    if let Some(plan) = remote_launch_plan(db, registry, &request)? {
        return Ok(plan);
    }
    let skill_issues = skills::recover_report(db).map_err(|message| {
        LaunchPlanError::new(
            LaunchStage::Skills,
            format!("Skills 安装恢复失败：{message}"),
        )
    })?;
    let adapter = registry
        .get(&request.tool_id)
        .ok_or_else(|| LaunchPlanError::new(LaunchStage::Tool, "未注册的 CLI 不能启动".into()))?;
    let launch_form = adapter.launch_form();
    if request.resume_latest && request.session_id.is_some() {
        return Err(LaunchPlanError::new(
            LaunchStage::Tool,
            "恢复最近会话不能同时指定会话编号".into(),
        ));
    }
    if request.resume_latest && launch_form != LaunchForm::Terminal {
        return Err(LaunchPlanError::new(
            LaunchStage::Tool,
            "桌面应用没有已核对的恢复最近会话参数".into(),
        ));
    }
    let project = request
        .project_id
        .as_deref()
        .map(|id| projects::get(db, id))
        .transpose()
        .map_err(|message| LaunchPlanError::new(LaunchStage::ProjectDirectory, message))?;
    let directory = match (directory_override, project.as_ref()) {
        (Some(path), _) => projects::checked_directory(path.to_str().ok_or_else(|| {
            LaunchPlanError::new(
                LaunchStage::ProjectDirectory,
                "工作目录文字编码无法识别".into(),
            )
        })?)
        .map_err(|message| LaunchPlanError::new(LaunchStage::ProjectDirectory, message))?,
        (None, Some(project)) => {
            let path = project.path.as_deref().ok_or_else(|| {
                LaunchPlanError::new(LaunchStage::ProjectDirectory, "项目尚未关联本机目录".into())
            })?;
            projects::checked_directory(path)
                .map_err(|message| LaunchPlanError::new(LaunchStage::ProjectDirectory, message))?
        }
        (None, None) => {
            let path = directory_override.unwrap_or(home).to_str().ok_or_else(|| {
                LaunchPlanError::new(LaunchStage::ProjectDirectory, "用户目录不可识别".into())
            })?;
            projects::checked_directory(path)
                .map_err(|message| LaunchPlanError::new(LaunchStage::ProjectDirectory, message))?
        }
    };
    let scope = if project.is_some() || directory_override.is_some() {
        Scope::Project
    } else {
        Scope::Global
    };
    let account_context = match resume_context {
        Some(context) => context,
        None => crate::accounts::selection::bound(db, home, &request.tool_id, scope, (scope==Scope::Project).then_some(directory.as_path()), true)
            .map_err(|message|LaunchPlanError::new(LaunchStage::Configuration,message))?,
    };
    let _context = crate::accounts::selection::enter(account_context.as_ref().map(|(_,ctx)|ctx.clone()));
    let scope_key = if scope == Scope::Global {
        "global".to_owned()
    } else {
        format!("project:{}", directory.display())
    };
    // One credential source per launch: a bound native account context keeps
    // its own environment and never mixes with a stored connection key.
    let credential = if account_context.is_some() {
        None
    } else {
        launch_credential_binding(db, adapter, &request.tool_id, scope, &directory)
            .map_err(|message| LaunchPlanError::new(LaunchStage::Configuration, message))?
    };
    if let Some(issue) = skill_issues
        .iter()
        .find(|issue| issue.affects(&request.tool_id, &scope_key))
    {
        return Err(LaunchPlanError::new(
            LaunchStage::Skills,
            format!(
                "Skills 安装需修复：{}；异常备份：{}。请在工具页 Skills 查看并重新检查。",
                issue.detail, issue.backup_path
            ),
        ));
    }
    let probe = adapter::probe_registered(
        registry,
        &request.tool_id,
        custom_cli_path(db, &request.tool_id)
            .map_err(|message| LaunchPlanError::new(LaunchStage::Tool, message))?
            .as_deref(),
        home,
        (scope == Scope::Project).then_some(directory.as_path()),
        scope,
    )
    .map_err(|message| LaunchPlanError::new(LaunchStage::Tool, message))?;
    crate::accounts::selection::validate_oauth_files(registry,&request.tool_id,home,(scope==Scope::Project).then_some(directory.as_path())).map_err(|message|LaunchPlanError::new(LaunchStage::Configuration,message))?;
    let selected_path = probe.selected_path.as_deref().ok_or_else(|| {
        LaunchPlanError::new(
            LaunchStage::Tool,
            "CLI 未确认安装，请在工具页检查安装路径".into(),
        )
    })?;
    let installation_version = probe
        .installations
        .iter()
        .find(|item| item.path == selected_path && item.status == "available")
        .and_then(|item| item.version.as_deref());
    // Desktop install markers are authoritative without a readable version;
    // terminal launches keep requiring a confirmed version.
    if launch_form == LaunchForm::Terminal && installation_version.is_none() {
        return Err(LaunchPlanError::new(
            LaunchStage::Tool,
            "CLI 版本未确认，请在工具页重新检测".into(),
        ));
    }
    if installation_version.is_some_and(|value| adapter.explicitly_incompatible_launch_version(value))
    {
        return Err(LaunchPlanError::new(
            LaunchStage::Tool,
            "此 CLI 版本不支持所请求的启动参数".into(),
        ));
    }
    let version = installation_version.unwrap_or("");
    // Desktop apps have no resume command. A session id only names a directory
    // that was already selected, so the terminal resume-version gate does not apply.
    if launch_form == LaunchForm::Terminal
        && request.session_id.is_some()
        && !adapter.history_resume_version_supported(version)
    {
        return Err(LaunchPlanError::new(
            LaunchStage::Tool,
            "此 CLI 版本的精确会话恢复命令尚未验证".into(),
        ));
    }
    // A desktop direct launch has neither a request/session directory nor a
    // project. Home stays the global scope root and is not a launch argument.
    // launch_args stays session-less; only a non-empty desktop_launch_args
    // attaches the selected directory.
    let selected_directory = directory_override.is_some() || project.is_some();
    let mut attached_desktop_directory = false;
    let mut cli_args = match launch_form {
        LaunchForm::Terminal => adapters::plan_launch(
            registry,
            &request.tool_id,
            version,
            request.session_id.as_deref(),
            request.resume_latest,
            request.mode,
        )
        .map_err(|message| LaunchPlanError::new(LaunchStage::Tool, message))?,
        LaunchForm::Desktop => {
            let mut args = adapter
                .launch_args(None, request.mode)
                .map_err(|message| LaunchPlanError::new(LaunchStage::Tool, message))?;
            if selected_directory {
                let desktop_args = adapter
                    .desktop_launch_args(&directory)
                    .map_err(|message| LaunchPlanError::new(LaunchStage::Tool, message))?;
                attached_desktop_directory = !desktop_args.is_empty();
                args.extend(desktop_args);
            }
            args
        }
    };
    if let Some((_, context)) = &account_context { cli_args.splice(0..0, context.cli_args.clone()); }
    if let Some(project) = &project {
        let model = project
            .model_overrides
            .get(&request.tool_id)
            .map(String::as_str);
        cli_args.extend(
            adapter
                .project_model_args(model)
                .map_err(|message| LaunchPlanError::new(LaunchStage::Tool, message))?,
        );
    }
    if let Some(prompt) = request.initial_prompt.as_deref().map(str::trim).filter(|text| !text.is_empty()) {
        if launch_form == LaunchForm::Desktop {
            return Err(LaunchPlanError::new(
                LaunchStage::Tool,
                "桌面应用启动尚无已验证的初始提示词契约".into(),
            ));
        }
        if prompt.chars().count() > 20_000 {
            return Err(LaunchPlanError::new(LaunchStage::Tool, "提示词过长，请先缩短后再启动。".into()));
        }
        cli_args.push(prompt.to_owned());
    }
    let process_directory = if launch_form == LaunchForm::Desktop && !attached_desktop_directory {
        executable_directory(Path::new(selected_path))
    } else {
        directory
    };
    Ok(LaunchPlan {
        account_version: account_context.as_ref().map(|(id,_)|crate::accounts::get(db,id).map(|account|account.version)).transpose().map_err(|message|LaunchPlanError::new(LaunchStage::Configuration,message))?,
        account_context,
        tool_id: request.tool_id,
        project_id: request.project_id,
        mode: request.mode,
        executable: PathBuf::from(selected_path),
        cli_args,
        directory: process_directory,
        session_markers: if launch_form == LaunchForm::Desktop {
            // Session markers scope nested terminal sessions; a desktop app
            // never inherits a terminal environment.
            &[]
        } else {
            adapter.session_env_markers()
        },
        credential,
        terminal: match launch_form {
            LaunchForm::Terminal => session_terminal(db)
                .map_err(|message| LaunchPlanError::new(LaunchStage::Terminal, message))?,
            LaunchForm::Desktop => TerminalId::Desktop,
        },
        remote_session_id: None,
        remote_end_args: None,
        environment: Vec::new(),
    })
}

/// Native login does not apply named profiles or modify the original OAuth files.
pub fn login_plan(db: &Database, registry: &Registry, home: &Path, tool: &str, custom: Option<&Path>) -> Result<LaunchPlan, String> {
    let adapter = registry.get(tool).ok_or("此 CLI 尚无注册适配器")?;
    let cli_args = adapter.login_args().ok_or("此 CLI 没有原生交互登录入口，请配置 API 连接")?;
    let probe = adapter::probe_registered(registry, tool, custom, home, None, Scope::Global)?;
    let selected = probe.selected_path.ok_or("未找到可验证的 CLI，先安装或重新检测")?;
    Ok(LaunchPlan {account_version:None,account_context:None,tool_id:tool.into(),project_id:None,mode:LaunchMode::Normal,executable:PathBuf::from(selected),cli_args,
        directory:projects::checked_directory(&home.display().to_string())?,session_markers:adapter.session_env_markers(),terminal:selected_terminal(db)?,credential:None,remote_session_id:None,remote_end_args:None,environment:Vec::new()})
}

fn quote_powershell(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn quote_shell(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

// Extended-length paths remain useful for file IO; shells and terminal brokers expect DOS/UNC paths.
pub(crate) fn terminal_path(path: &Path) -> Result<String, String> {
    let text = path.to_str().ok_or("路径文字编码无法识别")?;
    #[cfg(windows)]
    {
        if let Some(rest) = text.strip_prefix("\\\\?\\UNC\\") {
            return Ok(format!("\\\\{rest}"));
        }
        if let Some(rest) = text.strip_prefix("\\\\?\\") {
            return Ok(rest.to_owned());
        }
    }
    Ok(text.to_owned())
}

fn encoded_powershell(script: &str) -> String {
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// A copyable resume command runs outside Cliora's credential injection, so
/// it never embeds a stored connection key; only a real spawn does.
pub fn native_command(plan: &LaunchPlan) -> Result<String, String> {
    native_script(plan, None)
}

fn native_script(
    plan: &LaunchPlan,
    credential: Option<&(String, String)>,
) -> Result<String, String> {
    #[cfg(windows)]
    if plan.terminal == TerminalId::Cmd {
        let args = cmd_arguments(&powershell_script(plan, credential)?)?;
        return Ok(format!("\"{}\" {}", terminal_path(&system_console_path(TerminalId::PowerShell)?)?, args[4..].join(" ")));
    }
    if cfg!(windows) {
        powershell_script(plan, credential)
    } else {
        shell_script(plan, credential)
    }
}

fn context_script(
    plan: &LaunchPlan,
    windows: bool,
    credential: Option<&(String, String)>,
) -> String {
    let mut parts = Vec::new();
    for (key, value) in &plan.environment { parts.push(if windows {format!("$env:{key} = {}",quote_powershell(value))} else {format!("export {key}={}",quote_shell(value))}); }
    if let Some((_,context))=&plan.account_context {
        for key in &context.remove_environment { parts.push(if windows {format!("Remove-Item -LiteralPath 'Env:{key}' -ErrorAction SilentlyContinue")} else {format!("unset {key}")}); }
        for (key,value) in &context.environment { parts.push(if windows {format!("$env:{key} = {}",quote_powershell(value))} else {format!("export {key}={}",quote_shell(value))}); }
    }
    if let Some((name, value)) = credential {
        // The managed connection key for env-channel CLIs; same quoting rules
        // as an account context environment entry.
        parts.push(if windows {format!("$env:{name} = {}",quote_powershell(value))} else {format!("export {name}={}",quote_shell(value))});
    }
    if parts.is_empty() { String::new() } else { format!("{}; ",parts.join("; ")) }
}

fn powershell_script(
    plan: &LaunchPlan,
    credential: Option<&(String, String)>,
) -> Result<String, String> {
    if plan.project_id.as_deref().is_some_and(|id| id.starts_with("remote:")) {
        let mut parts = vec![format!("& {}", quote_powershell(&terminal_path(&plan.executable)?))];
        parts.extend(plan.cli_args.iter().map(|arg| quote_powershell(arg)));
        return Ok(format!("{}{}", context_script(plan, true, credential), parts.join(" ")));
    }
    let directory = terminal_path(&plan.directory)?;
    #[cfg(windows)]
    let executable = terminal_path(&windows_cli_path(&plan.executable))?;
    #[cfg(not(windows))]
    let executable = terminal_path(&plan.executable)?;
    let mut parts = vec![format!("& {}", quote_powershell(&executable))];
    parts.extend(plan.cli_args.iter().map(|arg| quote_powershell(arg)));
    Ok(format!(
        "{}Set-Location -LiteralPath {}; {}",
        context_script(plan,true,credential),
        quote_powershell(&directory),
        parts.join(" ")
    ))
}

#[cfg(windows)]
fn windows_cli_path(path: &Path) -> PathBuf {
    // npm's extensionless sibling is a Unix shell script, not a Win32 entry.
    // Resolve only siblings of that exact installation, never another PATH hit.
    if path.extension().is_none() {
        for extension in ["exe", "cmd", "bat", "ps1"] {
            let candidate = path.with_extension(extension);
            if candidate.is_file() { return candidate; }
        }
    }
    path.to_path_buf()
}

#[cfg(windows)]
fn cmd_helper_script(script: &str, directories: &[PathBuf]) -> String {
    // The helper uses PowerShell syntax, but package manager commands should
    // resolve to their Windows batch entrypoints just as they do at a CMD prompt.
    let mut prelude = String::new();
    for name in ["npm", "npx"] {
        if let Some(path) = directories.iter().map(|directory| directory.join(format!("{name}.cmd"))).find(|path| path.is_file()) {
            prelude.push_str(&format!("function {name} {{ & {} @args }}; ", quote_powershell(&path.to_string_lossy())));
        }
    }
    format!("{prelude}{script}")
}

fn shell_script(
    plan: &LaunchPlan,
    credential: Option<&(String, String)>,
) -> Result<String, String> {
    if plan.project_id.as_deref().is_some_and(|id| id.starts_with("remote:")) {
        let executable = plan.executable.to_str().ok_or("SSH 路径文字编码无法识别")?;
        let mut parts = vec![quote_shell(executable)];
        parts.extend(plan.cli_args.iter().map(|arg| quote_shell(arg)));
        return Ok(format!("{}exec {}", context_script(plan, false, credential), parts.join(" ")));
    }
    let directory = plan.directory.to_str().ok_or("项目目录文字编码无法识别")?;
    let executable = plan.executable.to_str().ok_or("CLI 路径文字编码无法识别")?;
    let mut parts = vec![quote_shell(executable)];
    parts.extend(plan.cli_args.iter().map(|arg| quote_shell(arg)));
    Ok(format!(
        "{}cd -- {} && exec {}",
        context_script(plan,false,credential),
        quote_shell(directory),
        parts.join(" ")
    ))
}

fn interactive_powershell_script(
    plan: &LaunchPlan,
    credential: Option<&(String, String)>,
) -> Result<String, String> {
    let cleanup = if plan.session_markers.is_empty() {
        String::new()
    } else {
        let markers = plan.session_markers.iter().map(|name| format!("'{name}'")).collect::<Vec<_>>().join(",");
        format!("foreach ($name in {markers}) {{ Remove-Item -LiteralPath \"Env:$name\" -ErrorAction SilentlyContinue }}; ")
    };
    Ok(format!(
        "if ($null -ne $env:NO_COLOR) {{ Remove-Item Env:NO_COLOR -ErrorAction SilentlyContinue }}; if ($env:TERM -eq 'dumb') {{ Remove-Item Env:TERM -ErrorAction SilentlyContinue }}; if ($env:FORCE_COLOR -in '0','false') {{ Remove-Item Env:FORCE_COLOR -ErrorAction SilentlyContinue }}; {cleanup}{}",
        powershell_script(plan, credential)?
    ))
}
fn interactive_shell_script(
    plan: &LaunchPlan,
    credential: Option<&(String, String)>,
) -> Result<String, String> {
    let cleanup = if plan.session_markers.is_empty() { String::new() } else { format!("unset {}; ", plan.session_markers.join(" ")) };
    Ok(format!(
        "unset NO_COLOR; if [ \"${{TERM-}}\" = dumb ]; then unset TERM; fi; if [ \"${{FORCE_COLOR-}}\" = 0 ] || [ \"${{FORCE_COLOR-}}\" = false ]; then unset FORCE_COLOR; fi; {cleanup}{}",
        shell_script(plan, credential)?
    ))
}

fn mac_terminal_shell_body(directory: &str, script: &str) -> String {
    // Terminal may reuse an already running shell with a different PATH. Pass the
    // same environment used by version probes, including Node for npm entrypoints.
    let path = crate::process_environment::path()
        .and_then(|value| value.into_string().ok())
        .map(|value| format!("export PATH={}:\"$PATH\"; ", quote_shell(&value)))
        .unwrap_or_default();
    format!("{path}cd -- {} && {script}", quote_shell(directory))
}

// CMD hosts the CLI in its own interactive console. Passing only an encoded
// PowerShell payload through cmd avoids an additional expansion of paths,
// prompts, %, !, & and other command-shell metacharacters. The helper exits
// with the CLI; /K then leaves the user at a normal CMD prompt.
fn cmd_arguments(script: &str) -> Result<Vec<String>, String> {
    #[cfg(windows)]
    let script = cmd_helper_script(script, &crate::process_environment::directories());
    #[cfg(windows)]
    let script = script.as_str();
    let encoded = encoded_powershell(script);
    if encoded.len() > 7600 {
        return Err("启动命令超过 CMD 长度限制，请在设置中选择 PowerShell 或 Windows Terminal".into());
    }
    Ok(vec!["/D".into(), "/V:OFF".into(), "/K".into(), "powershell.exe".into(), "-NoProfile".into(), "-ExecutionPolicy".into(), "Bypass".into(), "-EncodedCommand".into(), encoded])
}

pub fn terminal_command(
    plan: &LaunchPlan,
    credential: Option<&(String, String)>,
) -> Result<TerminalCommand, String> {
    let remote = plan.project_id.as_deref().is_some_and(|id| id.starts_with("remote:"));
    let directory = if remote {
        std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
    } else {
        PathBuf::from(terminal_path(&plan.directory)?)
    };
    let directory = directory.to_string_lossy().into_owned();
    let powershell = || interactive_powershell_script(plan, credential).map(|script| encoded_powershell(&script));
    let mac_script = if matches!(plan.terminal, TerminalId::MacTerminal | TerminalId::Custom) {
        Some(mac_terminal_shell_body(&directory, &interactive_shell_script(plan, credential)?))
    } else {
        None
    };
    let (program, args): (&str, Vec<String>) = match plan.terminal {
        TerminalId::WindowsTerminal => ("wt.exe", windows_terminal_arguments(powershell()?)?),
        TerminalId::Pwsh => return powershell_console(TerminalId::Pwsh, powershell()?, directory, plan.session_markers),
        TerminalId::PowerShell => ("powershell.exe", powershell_arguments(powershell()?)),
        TerminalId::Cmd => ("cmd.exe", cmd_arguments(&interactive_powershell_script(plan, credential)?)?),
        TerminalId::MacTerminal => ("/usr/bin/open", vec!["-a".into(), "Terminal".into()]),
        TerminalId::Custom => ("", Vec::new()),
        TerminalId::GnomeTerminal => (
            "gnome-terminal",
            vec![
                format!("--working-directory={directory}"),
                "--".into(),
                "sh".into(),
                "-lc".into(),
                interactive_shell_script(plan, credential)?,
            ],
        ),
        TerminalId::Konsole => (
            "konsole",
            vec![
                "--workdir".into(),
                directory.clone(),
                "-e".into(),
                "sh".into(),
                "-lc".into(),
                interactive_shell_script(plan, credential)?,
            ],
        ),
        TerminalId::Xterm => (
            "xterm",
            vec!["-e".into(), "sh".into(), "-lc".into(), interactive_shell_script(plan, credential)?],
        ),
        TerminalId::Desktop => return Err("桌面应用启动不经过终端".into()),
        TerminalId::Workbench => return Err("工作台不经过外部终端".into()),
        TerminalId::Auto => return Err("请先选择可用的终端".into()),
    };
    Ok(TerminalCommand {
        program: program.into(),
        args,
        directory: PathBuf::from(directory),
        session_markers: plan.session_markers,
        mac_script,
    })
}

fn powershell_arguments(encoded: String) -> Vec<String> {
    vec!["-NoProfile".into(), "-NoExit".into(), "-ExecutionPolicy".into(), "Bypass".into(), "-EncodedCommand".into(), encoded]
}

fn windows_terminal_arguments(encoded: String) -> Result<Vec<String>, String> {
    let mut args = vec![windows_terminal_shell()?];
    args.extend(powershell_arguments(encoded));
    Ok(args)
}

/// PowerShell 7 runs from its resolved install path in its own console window.
fn powershell_console(terminal: TerminalId, encoded: String, directory: String, session_markers: &'static [&'static str]) -> Result<TerminalCommand, String> {
    let program = match terminal {
        TerminalId::Pwsh => terminal_path(&pwsh_path().ok_or("未找到 PowerShell 7（pwsh.exe），请安装后重试或在设置中更换终端")?)?,
        _ => return Err("所选终端不是 PowerShell".into()),
    };
    Ok(TerminalCommand { program, args: powershell_arguments(encoded), directory: PathBuf::from(directory), session_markers, mac_script: None })
}

#[cfg(windows)]
fn system_console_path(terminal: TerminalId) -> Result<PathBuf, String> {
    let relative = match terminal {
        TerminalId::PowerShell => r"System32\WindowsPowerShell\v1.0\powershell.exe",
        TerminalId::Cmd => r"System32\cmd.exe",
        _ => return Err("所选终端不是系统控制台".into()),
    };
    let executable = env::var_os("SystemRoot").map(PathBuf::from).ok_or("找不到 Windows 系统目录")?.join(relative);
    if !executable.is_absolute() || !executable.is_file() { return Err(format!("找不到系统 {}", terminal.label())); }
    Ok(executable)
}

#[cfg(windows)]
fn console_command_line(terminal: &TerminalCommand) -> Result<(PathBuf, String), String> {
    let pwsh = pwsh_path().filter(|path| terminal_path(path).ok().as_deref() == Some(terminal.program.as_str()));
    let id = match terminal.program.as_str() {
        "powershell.exe" => TerminalId::PowerShell,
        "cmd.exe" => TerminalId::Cmd,
        _ if pwsh.is_some() => TerminalId::Pwsh,
        _ => return Err("系统控制台命令无效".into()),
    };
    let executable = match pwsh {
        Some(path) => path,
        None => system_console_path(id)?,
    };
    // Fixed flags and the base64 payload never contain shell-sensitive text.
    if terminal.args.iter().any(|arg| arg.chars().any(|ch| ch.is_whitespace() || ch == '"' || ch == '\0')) { return Err("系统控制台启动参数无效".into()); }
    let application = terminal_path(&executable)?;
    let line = if id == TerminalId::Cmd {
        if terminal.args.len() != 9 || terminal.args[..8] != ["/D", "/V:OFF", "/K", "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand"] { return Err("CMD 启动参数无效".into()); }
        let helper = terminal_path(&system_console_path(TerminalId::PowerShell)?)?;
        format!("\"{application}\" /D /V:OFF /S /K \"\"{helper}\" {}\"", terminal.args[4..].join(" "))
    } else {
        format!("\"{application}\" {}", terminal.args.join(" "))
    };
    if id == TerminalId::Cmd && line.encode_utf16().count() > 8191 {
        return Err("启动命令超过 CMD 长度限制，请在设置中选择 PowerShell 或 Windows Terminal".into());
    }
    Ok((executable, line))
}

#[cfg(windows)]
fn spawn_console(terminal: &TerminalCommand) -> Result<(), String> {
    use windows_sys::Win32::{Foundation::CloseHandle, System::Threading::{CreateProcessW, PROCESS_INFORMATION, STARTUPINFOW, CREATE_NEW_CONSOLE}};
    let (executable, line) = console_command_line(terminal)?;
    let wide = |text: &str| text.encode_utf16().chain(std::iter::once(0)).collect::<Vec<_>>();
    let application = wide(&terminal_path(&executable)?);
    let mut line = wide(&line);
    let directory = wide(&terminal_path(&terminal.directory)?);
    let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() }; startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    // Windows supplies real console I/O handles; don't inherit the GUI's null handles.
    let created = unsafe { CreateProcessW(application.as_ptr(), line.as_mut_ptr(), std::ptr::null(), std::ptr::null(), 0, CREATE_NEW_CONSOLE, std::ptr::null(), directory.as_ptr(), &startup, &mut process) };
    if created == 0 { return Err(format!("无法打开系统终端：{}", std::io::Error::last_os_error())); }
    unsafe { CloseHandle(process.hThread); CloseHandle(process.hProcess); }
    Ok(())
}

fn shell_terminal(terminal: TerminalId, directory: &Path, script: &str) -> Result<TerminalCommand, String> {
    if script.is_empty() || script.contains('\0') || script.contains('\n') || script.contains('\r') {
        return Err("安装命令无效".into());
    }
    let directory_text = terminal_path(directory)?;
    let mac_script = if matches!(terminal, TerminalId::MacTerminal | TerminalId::Custom) {
        Some(mac_terminal_shell_body(&directory_text, script))
    } else {
        None
    };
    let (program, args): (&str, Vec<String>) = match terminal {
        TerminalId::WindowsTerminal => ("wt.exe", windows_terminal_arguments(encoded_powershell(script))?),
        TerminalId::Pwsh => return powershell_console(TerminalId::Pwsh, encoded_powershell(script), directory_text, &[]),
        TerminalId::PowerShell => ("powershell.exe", powershell_arguments(encoded_powershell(script))),
        TerminalId::Cmd => ("cmd.exe", cmd_arguments(script)?),
        TerminalId::MacTerminal => ("/usr/bin/open", vec!["-a".into(), "Terminal".into()]),
        TerminalId::Custom => ("", Vec::new()),
        TerminalId::GnomeTerminal => (
            "gnome-terminal",
            vec![format!("--working-directory={directory_text}"), "--".into(), "sh".into(), "-lc".into(), script.to_owned()],
        ),
        TerminalId::Konsole => (
            "konsole",
            vec!["--workdir".into(), directory_text.clone(), "-e".into(), "sh".into(), "-lc".into(), script.to_owned()],
        ),
        TerminalId::Xterm => ("xterm", vec!["-e".into(), "sh".into(), "-lc".into(), script.to_owned()]),
        TerminalId::Desktop => return Err("桌面应用启动不经过终端".into()),
        TerminalId::Workbench => return Err("工作台不经过外部终端".into()),
        TerminalId::Auto => return Err("请先选择可用的终端".into()),
    };
    Ok(TerminalCommand { program: program.into(), args, directory: PathBuf::from(directory_text), session_markers: &[], mac_script })
}

fn spawn_terminal(db: &Database, terminal_id: TerminalId, terminal: TerminalCommand) -> Result<(), String> {
    #[cfg(windows)]
    // Console shells need real console handles; the generic path below hands them NUL, and an
    // interactive shell reading NUL exits at once.
    if matches!(terminal_id, TerminalId::Pwsh | TerminalId::PowerShell | TerminalId::Cmd) {
        return spawn_console(&terminal);
    }
    if terminal_id == TerminalId::MacTerminal {
        let script = terminal.mac_script.as_deref().ok_or("终端命令无效")?;
        #[cfg(target_os = "macos")]
        {
            return open_mac_terminal(script);
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = script;
            return Err("Terminal 仅在 macOS 上可用".into());
        }
    }
    if terminal_id == TerminalId::Custom {
        let script = terminal.mac_script.as_deref().ok_or("终端命令无效")?;
        return spawn_custom(db, script);
    }
    let mut command = Command::new(&terminal.program);
    crate::process_environment::apply(&mut command);
    command.args(&terminal.args).current_dir(&terminal.directory).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0000_0010 | 0x0000_0200);
    }
    command.env_remove("NO_COLOR");
    if env::var("TERM").as_deref() == Ok("dumb") { command.env_remove("TERM"); }
    if matches!(env::var("FORCE_COLOR").as_deref(), Ok("0") | Ok("false")) { command.env_remove("FORCE_COLOR"); }
    for name in terminal.session_markers { command.env_remove(name); }
    command.spawn().map_err(|error| format!("无法打开所选终端，请在设置中更换后重试：{error}"))?;
    Ok(())
}

fn write_launch_script(script: &str) -> Result<PathBuf, String> {
    use std::io::Write;

    if script.is_empty() || script.contains('\0') {
        return Err("终端命令无效".into());
    }
    let path = env::temp_dir().join(format!("cliora-launch-{}.command", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o700);
    }
    let mut file = options.open(&path).map_err(|error| format!("无法准备终端启动脚本：{error}"))?;
    // The shell unlinks the script after it has the file open, so a long command
    // is not left behind and is never typed into a terminal's input buffer.
    if let Err(error) = writeln!(file, "#!/bin/sh\nrm -f \"$0\"\n{script}") {
        let _ = std::fs::remove_file(&path);
        return Err(format!("无法准备终端启动脚本：{error}"));
    }
    Ok(path)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn open_mac_terminal(script: &str) -> Result<(), String> {
    let path = write_launch_script(script)?;
    let output = Command::new("/usr/bin/open")
        .args(["-a", "Terminal"])
        .arg(&path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| {
            let _ = std::fs::remove_file(&path);
            format!("无法打开 Terminal：{error}")
        })?;
    if !output.status.success() {
        let _ = std::fs::remove_file(&path);
    }
    mac_terminal_result(output.status.success(), &String::from_utf8_lossy(&output.stderr))
}

fn spawn_custom(db: &Database, script: &str) -> Result<(), String> {
    let custom = stored_custom(db)?.ok_or("请先在设置里填写自定义终端命令")?;
    if !Path::new(&custom.program).is_file() {
        return Err("自定义终端程序不存在，请在设置里重新选择".into());
    }
    let path = write_launch_script(script)?;
    let args: Vec<String> = custom.args.into_iter().map(|arg| if arg == "{script}" { path.display().to_string() } else { arg }).collect();
    // Spawn and return. Some terminals, including Tabby, keep this process alive
    // or only show their own confirmation after the CLI has already returned.
    Command::new(&custom.program)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| {
            let _ = std::fs::remove_file(&path);
            format!("无法打开自定义终端：{error}")
        })?;
    Ok(())
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn mac_terminal_result(success: bool, stderr: &str) -> Result<(), String> {
    if success {
        Ok(())
    } else if stderr.contains("-1743") {
        Err("macOS 未允许控制 Terminal，请在系统设置 → 隐私与安全性 → 自动化中允许 Cliora 控制 Terminal 后重试".into())
    } else {
        // osascript errors can echo the entire command, including user prompts.
        Err("无法向 Terminal 发送启动命令，请确认 Terminal 可用后重试".into())
    }
}

/// Account authentication is an explicitly requested interactive terminal.
/// Environment changes are scoped to this shell, never the desktop process.
pub fn spawn_account_terminal(db: &Database, executable: &Path, args: &[String], context: &crate::accounts::NativeContext, hint: &str, completion: Option<&Path>) -> Result<(), String> {
    crate::accounts::context::check_path(&context.root)?;
    let quote = if cfg!(windows) { quote_powershell } else { quote_shell };
    let mut parts = Vec::new();
    if cfg!(windows) {
        parts.push(format!("Set-Location -LiteralPath {}", quote(&terminal_path(&context.root)?)));
        for key in &context.remove_environment { parts.push(format!("Remove-Item -LiteralPath 'Env:{key}' -ErrorAction SilentlyContinue")); }
        for (key, value) in &context.environment { parts.push(format!("$env:{key} = {}", quote(value))); }
        parts.push(format!("Write-Host {}", quote(hint)));
    } else {
        parts.push(format!("cd {} || exit 1", quote(&terminal_path(&context.root)?)));
        for key in &context.remove_environment { parts.push(format!("unset {key}")); }
        for (key, value) in &context.environment { parts.push(format!("export {key}={}", quote(value))); }
        parts.push(format!("printf '%s\\n' {}", quote(hint)));
    }
    let mut invocation = vec![quote(&terminal_path(executable)?)];
    invocation.extend(context.cli_args.iter().chain(args).map(|value| quote(value)));
    let mut invocation = format!("{}{}", if cfg!(windows) { "& " } else { "" }, invocation.join(" "));
    if cfg!(windows) && completion.is_some() {
        if let Some(endpoint) = crate::adapters::accounts::get(&context.tool_id)?.browser_login_endpoint() {
            invocation = browser_login_invocation(&invocation, endpoint, &context.root.join(".cliora-auth-url"))?;
        }
    }
    if let Some(path) = completion {
        if path.parent() != Some(context.root.as_path()) { return Err("登录结果文件不属于当前上下文".into()); }
        if cfg!(windows) {
            parts.push(format!("$clioraAuthExit = 1; try {{ $ErrorActionPreference = 'Stop'; {invocation}; $clioraAuthExit = $LASTEXITCODE }} catch {{ $clioraAuthExit = 1 }}; Set-Content -LiteralPath {} -Value $clioraAuthExit -Encoding Ascii", quote(&terminal_path(path)?)));
        } else {
            parts.push(format!("{invocation}; cliora_auth_exit=$?; printf '%s' \"$cliora_auth_exit\" > {}", quote(&terminal_path(path)?)));
        }
    } else { parts.push(invocation); }
    open_shell(db, &parts.join("; "))
}

pub fn open_shell(db: &Database, script: &str) -> Result<(), String> {
    let terminal = selected_terminal(db)?;
    let home = env::var_os("USERPROFILE").or_else(|| env::var_os("HOME")).map(PathBuf::from).filter(|path| path.is_dir()).ok_or("找不到用户目录")?;
    spawn_terminal(db, terminal, shell_terminal(terminal, &home, script)?)
}

/// Preserve visible native output, capture only the allowlisted URL, and open it
/// through ShellExecute once. No full auth output or tokens are logged.
fn browser_login_invocation(invocation: &str, endpoint: &str, receipt: &Path) -> Result<String, String> {
    let endpoint = quote_powershell(endpoint);
    let receipt = quote_powershell(&terminal_path(receipt)?);
    Ok(format!(r#"{invocation} | ForEach-Object {{ Write-Host $_; if (-not (Test-Path -LiteralPath {receipt}) -and ([string]$_ -match '(https://[^\s\x1b]+)')) {{ $clioraAuthUrl = $Matches[1]; $clioraAuthUri = $null; if ([Uri]::TryCreate($clioraAuthUrl, [UriKind]::Absolute, [ref]$clioraAuthUri) -and $clioraAuthUri.GetLeftPart([UriPartial]::Path) -ceq {endpoint} -and -not $clioraAuthUri.UserInfo -and -not $clioraAuthUri.Fragment) {{ Set-Content -LiteralPath {receipt} -Value $clioraAuthUrl -Encoding UTF8; try {{ Start-Process -FilePath $clioraAuthUrl -ErrorAction Stop }} catch {{ Write-Host '浏览器未打开，请在 Cliora 点击“打开授权页面”，或复制上方 Go to 链接。' }} }} }} }}"#))
}

pub fn spawn(db: &Database, plan: LaunchPlan) -> Result<LaunchResult, String> {
    if let Some((id,context))=&plan.account_context { if Some(crate::accounts::get(db,id)?.version)!=plan.account_version {return Err("账号在计划后发生变化，请重新启动".into());} crate::accounts::validate_selected_context(db,id,&context.id)?; crate::accounts::context::check_path(&context.root)?; }
    // The stored connection key is read here, at injection time, and only
    // travels into the child process environment.
    let credential = resolve_credential(&plan, &SystemCredentialStore)?;
    if plan.terminal == TerminalId::Desktop {
        return spawn_desktop(&plan, credential.as_ref());
    }
    if plan.terminal == TerminalId::Workbench {
        return crate::session_host::start(plan, credential.as_ref());
    }
    let terminal_id = plan.terminal;
    let terminal = terminal_command(&plan, credential.as_ref())?;
    spawn_terminal(db, terminal_id, terminal)?;
    Ok(LaunchResult {
        tool_id: plan.tool_id,
        project_id: plan.project_id,
        mode: plan.mode,
        terminal: plan.terminal,
        status: "terminal_requested",
        session_id: None,
        remote_session_id: plan.remote_session_id,
    })
}

/// Desktop launches start the installed application directly: detached from
/// any terminal, owning its own windows and lifetime. The status only reports
/// that the start was requested, never that the application came up.
/// `plan.directory` is the executable directory unless the plan attached a
/// non-empty desktop directory argument, in which case it is that directory.
fn spawn_desktop(plan: &LaunchPlan, credential: Option<&(String, String)>) -> Result<LaunchResult, String> {
    if !plan.executable.is_file() {
        return Err("桌面应用可执行文件不存在，请在工具页重新检测".into());
    }
    let mut command = Command::new(&plan.executable);
    crate::process_environment::apply(&mut command);
    command
        .args(&plan.cli_args)
        .current_dir(&plan.directory)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    if let Some((_, context)) = &plan.account_context {
        for key in &context.remove_environment {
            command.env_remove(key);
        }
        for (key, value) in &context.environment {
            command.env(key, value);
        }
    }
    if let Some((name, value)) = credential {
        command.env(name, value);
    }
    command
        .spawn()
        .map_err(|error| format!("无法启动桌面应用：{error}"))?;
    Ok(LaunchResult {
        tool_id: plan.tool_id.clone(),
        project_id: plan.project_id.clone(),
        mode: plan.mode,
        terminal: TerminalId::Desktop,
        status: "desktop_requested",
        session_id: None,
        remote_session_id: plan.remote_session_id.clone(),
    })
}

#[cfg(test)]
mod desktop_launch {
    use std::collections::BTreeMap;
    use std::path::Path;

    use serde_json::Value;

    use super::*;
    use crate::adapters::{CliAdapter, InspectionFields, LaunchForm};
    use crate::credentials::CredentialStore;
    use crate::native::adapter::{Installation, NativeFile, Scope};
    use crate::native::apply::NativeSecrets;
    use crate::native::format::FileKind;
    use crate::native::profile::{Connection, RegisteredProfile};

    /// A desktop-form fixture adapter: bare launch plus a workspace flag that
    /// mirrors how a desktop application receives the resolved directory.
    struct DesktopApp;
    static DESKTOP_APP: DesktopApp = DesktopApp;

    impl CliAdapter for DesktopApp {
        fn id(&self) -> &'static str {
            "desktop_fixture"
        }
        fn name(&self) -> &'static str {
            "Desktop fixture"
        }
        fn command(&self) -> &'static str {
            "desktop-fixture"
        }
        fn npm_package(&self) -> &'static str {
            ""
        }
        fn version_identity(&self, _basename: &str, _output: &str) -> bool {
            false
        }
        fn native_files(
            &self,
            _scope: Scope,
            _home: &Path,
            _project: Option<&Path>,
            _known: bool,
        ) -> Vec<NativeFile> {
            Vec::new()
        }
        fn interface_formats(&self) -> &'static [&'static str] {
            &[]
        }
        fn file_kind(&self, _role: &str) -> Result<FileKind, String> {
            Err("fixture has no native config".into())
        }
        fn connection_documents(
            &self,
            _connection: &Connection,
            _scope: Scope,
        ) -> Result<BTreeMap<String, Value>, String> {
            Ok(BTreeMap::new())
        }
        fn write_connection_secret(
            &self,
            _profile: &RegisteredProfile,
            _scope: Scope,
            _credentials: &dyn CredentialStore,
            _secrets: &mut NativeSecrets,
        ) -> Result<(), String> {
            Ok(())
        }
        fn has_native_secret(&self, _role: &str, _root: &Value) -> bool {
            false
        }
        fn inspect_values(
            &self,
            _settings: &Value,
            _local_settings: &Value,
            _models: &Value,
        ) -> InspectionFields {
            InspectionFields::default()
        }
        fn launch_args(
            &self,
            _session: Option<&str>,
            mode: LaunchMode,
        ) -> Result<Vec<String>, String> {
            if mode == LaunchMode::Yolo {
                return Err("桌面应用没有已验证的跳审批启动参数".into());
            }
            Ok(Vec::new())
        }
        fn install_guidance(&self) -> (&'static str, &'static str) {
            ("https://example.invalid/desktop", "fixture only")
        }
        fn launch_form(&self) -> LaunchForm {
            LaunchForm::Desktop
        }
        fn desktop_launch_args(&self, directory: &Path) -> Result<Vec<String>, String> {
            Ok(vec![format!("--open-workspace={}", directory.display())])
        }
    }

    fn desktop_registry() -> Registry {
        Registry::with_adapters(vec![&DESKTOP_APP]).unwrap()
    }

    fn request(directory: Option<String>, session_id: Option<String>, mode: LaunchMode) -> LaunchRequest {
        LaunchRequest {
            tool_id: "desktop_fixture".into(),
            project_id: None,
            session_id,
            directory,
            initial_prompt: None,
            mode,
            resume_latest: false,
        }
    }

    #[test]
    fn descriptor_declares_the_launch_form_in_both_contracts() {
        let descriptor = desktop_registry().get("desktop_fixture").unwrap().descriptor();
        assert_eq!(descriptor.launch_form, LaunchForm::Desktop);
        let value = serde_json::to_value(&descriptor).unwrap();
        assert_eq!(value["launchForm"], "desktop");
        let builtin = Registry::builtins().get("grok").unwrap().descriptor();
        assert_eq!(builtin.launch_form, LaunchForm::Terminal);
        assert_eq!(serde_json::to_value(&builtin).unwrap()["launchForm"], "terminal");
    }

    #[test]
    fn desktop_plan_resolves_the_installed_executable_without_terminal_artifacts() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let registry = desktop_registry().with_fixture_installation("desktop_fixture", "1.2.3");
        // A terminal preference that would fail selection must not affect a
        // desktop plan: terminal choice does not apply to the desktop form.
        db.with_connection(|conn| {
            conn.execute(
                "INSERT INTO app_settings (key, value) VALUES ('preferred_terminal', '\"mac_terminal\"')",
                [],
            )
            .map(|_| ())
            .map_err(|error| error.to_string())
        })
        .unwrap();
        let workspace = temp.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let plan = plan(
            &db,
            &registry,
            temp.path(),
            request(Some(workspace.display().to_string()), None, LaunchMode::Normal),
        )
        .unwrap();
        assert_eq!(plan.executable, PathBuf::from("fixture-cli/desktop_fixture"));
        assert_eq!(plan.terminal, TerminalId::Desktop);
        assert!(plan.session_markers.is_empty());
        assert_eq!(
            plan.cli_args,
            [format!("--open-workspace={}", plan.directory.display())]
        );
        assert!(terminal_command(&plan, None).is_err());
    }

    #[test]
    fn desktop_plan_accepts_an_install_marker_without_a_version() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let mut registry = desktop_registry();
        registry.fixture_installations.insert(
            "desktop_fixture".into(),
            vec![Installation {
                path: "fixture-cli/desktop_fixture".into(),
                version: None,
                source: "test_fixture",
                status: "available",
                detail: None,
            }],
        );
        let plan = plan(
            &db,
            &registry,
            temp.path(),
            request(Some(temp.path().display().to_string()), None, LaunchMode::Normal),
        )
        .unwrap();
        assert_eq!(plan.executable, PathBuf::from("fixture-cli/desktop_fixture"));
    }

    #[test]
    fn desktop_plans_reject_resume_yolo_and_initial_prompts() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let registry = desktop_registry().with_fixture_installation("desktop_fixture", "1.2.3");
        let workspace = temp.path().join("session-workspace");
        std::fs::create_dir(&workspace).unwrap();
        let selected = plan_with_stage(
            &db,
            &registry,
            temp.path(),
            request(
                Some(workspace.display().to_string()),
                Some("session 1".into()),
                LaunchMode::Normal,
            ),
        )
        .unwrap();
        let canonical = workspace.canonicalize().unwrap();
        assert_eq!(selected.directory, canonical);
        assert_eq!(
            selected.cli_args,
            vec![format!("--open-workspace={}", canonical.display())]
        );
        assert!(selected.cli_args.iter().all(|arg| arg != "session 1"));
        let home = temp.path().display().to_string();
        let yolo = plan_with_stage(
            &db,
            &registry,
            temp.path(),
            request(Some(home.clone()), None, LaunchMode::Yolo),
        )
        .unwrap_err();
        assert_eq!(yolo.stage, LaunchStage::Tool);
        assert!(yolo.message.contains("跳审批"));
        let mut prompt_request = request(Some(home), None, LaunchMode::Normal);
        prompt_request.initial_prompt = Some("hello".into());
        let prompt = plan_with_stage(&db, &registry, temp.path(), prompt_request).unwrap_err();
        assert_eq!(prompt.stage, LaunchStage::Tool);
        assert!(prompt.message.contains("提示词"));
    }

    fn benign_desktop_plan(executable: PathBuf, args: Vec<String>) -> LaunchPlan {
        LaunchPlan {
            account_version: None,
            account_context: None,
            tool_id: "desktop_fixture".into(),
            project_id: None,
            mode: LaunchMode::Normal,
            executable,
            cli_args: args,
            directory: std::env::temp_dir(),
            terminal: TerminalId::Desktop,
            session_markers: &[],
            credential: None,
            remote_session_id: None,
            remote_end_args: None,
        environment: Vec::new(),
        }
    }

    #[cfg(windows)]
    #[test]
    fn desktop_spawn_runs_a_detached_process_and_only_reports_requested() {
        let temp = tempfile::tempdir().unwrap();
        let marker = temp.path().join("desktop-launched.txt");
        let shell = std::env::var_os("ComSpec")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("C:/Windows/System32/cmd.exe"));
        let plan = benign_desktop_plan(
            shell,
            vec!["/c".into(), format!("type nul > {}", marker.display())],
        );
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let result = spawn(&db, plan).unwrap();
        assert_eq!(result.status, "desktop_requested");
        assert_eq!(result.terminal, TerminalId::Desktop);
        assert!(result.session_id.is_none());
        assert_eq!(result.tool_id, "desktop_fixture");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !marker.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(marker.exists(), "detached desktop process did not run");
    }

    #[cfg(unix)]
    #[test]
    fn desktop_spawn_runs_a_detached_process_and_only_reports_requested() {
        let temp = tempfile::tempdir().unwrap();
        let marker = temp.path().join("desktop-launched.txt");
        let plan = benign_desktop_plan(
            PathBuf::from("/bin/sh"),
            vec!["-c".into(), format!("touch '{}'", marker.display())],
        );
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let result = spawn(&db, plan).unwrap();
        assert_eq!(result.status, "desktop_requested");
        assert_eq!(result.terminal, TerminalId::Desktop);
        assert!(result.session_id.is_none());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !marker.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(marker.exists(), "detached desktop process did not run");
    }

    #[test]
    fn desktop_direct_launch_keeps_home_out_of_the_arguments() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let registry = desktop_registry().with_fixture_installation("desktop_fixture", "1.2.3");
        let home = temp.path().canonicalize().unwrap();
        let plan = plan(
            &db,
            &registry,
            temp.path(),
            request(None, None, LaunchMode::Normal),
        )
        .unwrap();
        assert!(plan.cli_args.is_empty());
        assert_eq!(plan.directory, PathBuf::from("fixture-cli"));
        assert_ne!(plan.directory, home);
        let home_text = home.display().to_string();
        assert!(plan.cli_args.iter().all(|arg| !arg.contains(&home_text)));
    }
}

#[cfg(test)]
mod installed_desktop_launch {
    use std::path::PathBuf;

    use super::*;

    fn fresh() -> (tempfile::TempDir, Database, Registry) {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let registry = Registry::builtins()
            .with_fixture_installation("zcode", "1.0.0")
            .with_fixture_installation("deepseek", "1.0.0")
            .with_fixture_installation("cursor", "1.0.0");
        (temp, db, registry)
    }

    fn direct(tool: &str) -> LaunchRequest {
        LaunchRequest {
            tool_id: tool.into(),
            project_id: None,
            session_id: None,
            directory: None,
            initial_prompt: None,
            mode: LaunchMode::Normal,
            resume_latest: false,
        }
    }

    #[test]
    fn direct_launch_has_no_directory_argument_and_uses_the_executable_directory() {
        let (temp, db, registry) = fresh();
        let home = temp.path().canonicalize().unwrap().display().to_string();
        for tool in ["zcode", "deepseek", "cursor"] {
            let plan = plan(&db, &registry, temp.path(), direct(tool)).unwrap();
            assert!(plan.cli_args.is_empty(), "{tool}");
            assert_eq!(plan.directory, PathBuf::from("fixture-cli"), "{tool}");
            assert!(plan.cli_args.iter().all(|arg| !arg.contains(&home)), "{tool}");
            assert_eq!(plan.terminal, TerminalId::Desktop, "{tool}");
            let mut session = direct(tool);
            session.session_id = Some("missing-session".into());
            let missing = plan_with_stage(&db, &registry, temp.path(), session).unwrap_err();
            assert_eq!(missing.stage, LaunchStage::ProjectDirectory, "{tool}");
            assert!(missing.message.contains("原工作目录"), "{tool}");
            let mut prompt = direct(tool);
            prompt.initial_prompt = Some("hello".into());
            assert!(plan_with_stage(&db, &registry, temp.path(), prompt).is_err(), "{tool}");
        }
    }

    #[test]
    fn selected_project_directory_follows_each_desktop_contract() {
        let (temp, db, registry) = fresh();
        let workspace = temp.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let project = crate::projects::add(
            &db,
            &registry,
            workspace.to_str().unwrap(),
            Some("demo"),
            Some("zcode"),
        )
        .unwrap();
        let canonical = workspace.canonicalize().unwrap();
        let request = |tool: &str| LaunchRequest {
            tool_id: tool.into(),
            project_id: Some(project.id.clone()),
            session_id: None,
            directory: None,
            initial_prompt: None,
            mode: LaunchMode::Normal,
            resume_latest: false,
        };
        let zcode = plan(&db, &registry, temp.path(), request("zcode")).unwrap();
        assert_eq!(zcode.directory, canonical);
        assert_eq!(
            zcode.cli_args,
            vec![format!("--open-workspace={}", canonical.display())]
        );

        let deepseek = plan(&db, &registry, temp.path(), request("deepseek")).unwrap();
        assert!(deepseek.cli_args.is_empty());
        assert_eq!(deepseek.directory, PathBuf::from("fixture-cli"));
        assert_ne!(deepseek.directory, canonical);
        let project_text = canonical.display().to_string();
        assert!(deepseek.cli_args.iter().all(|arg| !arg.contains(&project_text)));

        let cursor = plan(&db, &registry, temp.path(), request("cursor")).unwrap();
        assert_eq!(cursor.directory, canonical);
        assert_eq!(cursor.cli_args, vec![canonical.display().to_string()]);
        assert_eq!(cursor.cli_args.len(), 1);
        assert!(!cursor.cli_args[0].starts_with('-'));
        assert!(!cursor.cli_args[0].to_ascii_lowercase().contains("agent"));
    }

    fn index_session(db: &Database, tool: &str, native_id: &str, cwd: &std::path::Path) -> String {
        let id = format!("hist-{tool}");
        let source_key = format!("source-{tool}");
        let cwd_text = cwd.to_str().unwrap().to_owned();
        db.with_connection(|conn| {
            conn.execute(
                "INSERT INTO history_sessions (id, tool, source_key, source_path, source_fingerprint, native_id, title, cwd, model, started_at, updated_at, messages_json, usage_json, message_count, usage_count, partial, stale, favorite, project_id)
                 VALUES (?1, ?2, ?3, ?4, '', ?5, 'demo', ?6, NULL, 1, 1, '[]', '[]', 0, 0, 0, 0, 0, NULL)",
                rusqlite::params![id, tool, source_key, cwd_text, native_id, cwd_text],
            )
            .map(|_| ())
            .map_err(|error| error.to_string())
        })
        .unwrap();
        id
    }

    #[test]
    fn indexed_session_directory_follows_each_desktop_contract() {
        let (temp, db, registry) = fresh();
        let workspace = temp.path().join("session-workspace");
        std::fs::create_dir(&workspace).unwrap();
        let canonical = workspace.canonicalize().unwrap();
        let project_text = canonical.display().to_string();
        for tool in ["zcode", "deepseek", "cursor"] {
            let native_id = format!("native-{tool}");
            let row_id = index_session(&db, tool, &native_id, &workspace);
            let resumed = crate::history::resume_plan(
                &db,
                &registry,
                temp.path(),
                &row_id,
                LaunchMode::Normal,
            )
            .unwrap_or_else(|error| panic!("{tool}: {error}"));
            let via_native = plan(
                &db,
                &registry,
                temp.path(),
                LaunchRequest {
                    tool_id: tool.into(),
                    project_id: None,
                    session_id: Some(native_id.clone()),
                    directory: None,
                    initial_prompt: None,
                    mode: LaunchMode::Normal,
                    resume_latest: false,
                },
            )
            .unwrap_or_else(|error| panic!("{tool}: {error}"));
            assert_eq!(resumed.cli_args, via_native.cli_args, "{tool}");
            assert_eq!(resumed.directory, via_native.directory, "{tool}");
            assert!(
                resumed.cli_args.iter().all(|arg| arg != &native_id),
                "{tool}"
            );
            let command = crate::history::copy_resume_command(
                &db,
                &registry,
                temp.path(),
                &row_id,
                LaunchMode::Normal,
            )
            .unwrap_or_else(|error| panic!("{tool}: {error}"));
            assert!(!command.contains(&native_id), "{tool}");
            assert!(crate::history::resume_plan(
                &db,
                &registry,
                temp.path(),
                &row_id,
                LaunchMode::Yolo,
            )
            .is_err(), "{tool}");
            match tool {
                "zcode" => {
                    assert_eq!(resumed.directory, canonical);
                    assert_eq!(
                        resumed.cli_args,
                        vec![format!("--open-workspace={}", canonical.display())]
                    );
                    assert!(command.contains("--open-workspace="));
                }
                "deepseek" => {
                    assert!(resumed.cli_args.is_empty());
                    assert_eq!(resumed.directory, PathBuf::from("fixture-cli"));
                    assert_ne!(resumed.directory, canonical);
                    assert!(resumed.cli_args.iter().all(|arg| !arg.contains(&project_text)));
                    assert!(!command.contains(&project_text));
                }
                "cursor" => {
                    assert_eq!(resumed.directory, canonical);
                    assert_eq!(resumed.cli_args, vec![canonical.display().to_string()]);
                    assert_eq!(resumed.cli_args.len(), 1);
                    assert!(!resumed.cli_args[0].starts_with('-'));
                    assert!(!resumed.cli_args[0].to_ascii_lowercase().contains("agent"));
                    assert!(!command.to_ascii_lowercase().contains("agent"));
                }
                _ => unreachable!(),
            }
        }
    }
}

#[cfg(test)]
#[path = "../../tests/launch/launch.rs"]
mod tests;

#[cfg(test)]
#[path = "../../tests/launch/remote.rs"]
mod remote_tests;
