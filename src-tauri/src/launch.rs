use std::env;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::database::Database;
use crate::native::adapter::{self, Scope};
use crate::native::adapters::{self, LaunchMode, Registry};
use crate::projects;
use crate::resources::skills;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalId {
    Auto,
    WindowsTerminal,
    PowerShell,
    MacTerminal,
    GnomeTerminal,
    Konsole,
    Xterm,
}

impl TerminalId {
    fn label(self) -> &'static str {
        match self {
            Self::Auto => "系统默认",
            Self::WindowsTerminal => "Windows Terminal",
            Self::PowerShell => "PowerShell",
            Self::MacTerminal => "Terminal",
            Self::GnomeTerminal => "GNOME Terminal",
            Self::Konsole => "Konsole",
            Self::Xterm => "XTerm",
        }
    }

    fn binary(self) -> Option<&'static str> {
        match self {
            Self::Auto => None,
            Self::WindowsTerminal => Some("wt.exe"),
            Self::PowerShell => Some("powershell.exe"),
            Self::MacTerminal => Some("osascript"),
            Self::GnomeTerminal => Some("gnome-terminal"),
            Self::Konsole => Some("konsole"),
            Self::Xterm => Some("xterm"),
        }
    }

    fn platform(self) -> bool {
        match self {
            Self::Auto => true,
            Self::WindowsTerminal | Self::PowerShell => cfg!(windows),
            Self::MacTerminal => cfg!(target_os = "macos"),
            Self::GnomeTerminal | Self::Konsole | Self::Xterm => cfg!(target_os = "linux"),
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
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRequest {
    pub tool_id: String,
    pub project_id: Option<String>,
    pub session_id: Option<String>,
    pub mode: LaunchMode,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchResult {
    pub tool_id: String,
    pub project_id: Option<String>,
    pub mode: LaunchMode,
    pub terminal: TerminalId,
    pub status: &'static str,
}

#[derive(Clone, Debug)]
pub struct LaunchPlan {
    pub tool_id: String,
    pub project_id: Option<String>,
    pub mode: LaunchMode,
    pub executable: PathBuf,
    pub cli_args: Vec<String>,
    pub directory: PathBuf,
    pub terminal: TerminalId,
}

#[derive(Clone, Debug)]
pub struct TerminalCommand {
    pub program: &'static str,
    pub args: Vec<String>,
    pub directory: PathBuf,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LaunchStage {
    ProjectDirectory,
    Configuration,
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

fn on_path(name: &str) -> bool {
    env::var_os("PATH")
        .into_iter()
        .flat_map(|value| env::split_paths(&value).collect::<Vec<_>>())
        .any(|directory| directory.join(name).is_file())
}

fn supported_terminals() -> &'static [TerminalId] {
    if cfg!(windows) {
        &[TerminalId::WindowsTerminal, TerminalId::PowerShell]
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
    let available = supported_terminals()
        .iter()
        .any(|terminal| terminal.binary().is_some_and(on_path));
    options.push(TerminalOption {
        id: TerminalId::Auto,
        label: TerminalId::Auto.label(),
        available,
    });
    for id in supported_terminals() {
        options.push(TerminalOption {
            id: *id,
            label: id.label(),
            available: id.binary().is_some_and(on_path),
        });
    }
    options
}

pub fn terminal_preference(db: &Database) -> Result<TerminalId, String> {
    db.with_connection(|conn| {
        let value: Option<String> = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = 'preferred_terminal'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        value
            .map(|text| serde_json::from_str(&text).map_err(|_| "终端设置格式无法识别".into()))
            .unwrap_or(Ok(TerminalId::Auto))
    })
}

pub fn settings(db: &Database) -> Result<LaunchSettings, String> {
    Ok(LaunchSettings {
        selected: terminal_preference(db)?,
        terminals: terminal_options(),
    })
}

pub fn set_terminal(db: &Database, terminal: TerminalId) -> Result<LaunchSettings, String> {
    if !terminal.platform() {
        return Err("当前系统不支持所选终端".into());
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

fn selected_terminal(db: &Database) -> Result<TerminalId, String> {
    let preferred = terminal_preference(db)?;
    let options = terminal_options();
    if preferred == TerminalId::Auto {
        return options
            .into_iter()
            .find(|option| option.id != TerminalId::Auto && option.available)
            .map(|option| option.id)
            .ok_or_else(|| "未找到可用的外部终端，请安装终端后重试".into());
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

pub fn plan_with_stage(
    db: &Database,
    registry: &Registry,
    home: &Path,
    request: LaunchRequest,
) -> Result<LaunchPlan, LaunchPlanError> {
    skills::recover(db).map_err(|message| {
        LaunchPlanError::new(
            LaunchStage::Configuration,
            format!("Skills 安装恢复失败：{message}"),
        )
    })?;
    let adapter = registry
        .get(&request.tool_id)
        .ok_or_else(|| LaunchPlanError::new(LaunchStage::Tool, "未注册的 CLI 不能启动".into()))?;
    let project = request
        .project_id
        .as_deref()
        .map(|id| projects::get(db, id))
        .transpose()
        .map_err(|message| LaunchPlanError::new(LaunchStage::ProjectDirectory, message))?;
    let directory = match project.as_ref() {
        Some(project) => {
            let path = project.path.as_deref().ok_or_else(|| {
                LaunchPlanError::new(LaunchStage::ProjectDirectory, "项目尚未关联本机目录".into())
            })?;
            projects::checked_directory(path)
                .map_err(|message| LaunchPlanError::new(LaunchStage::ProjectDirectory, message))?
        }
        None => {
            let path = home.to_str().ok_or_else(|| {
                LaunchPlanError::new(LaunchStage::ProjectDirectory, "用户目录不可识别".into())
            })?;
            projects::checked_directory(path)
                .map_err(|message| LaunchPlanError::new(LaunchStage::ProjectDirectory, message))?
        }
    };
    let scope = if project.is_some() {
        Scope::Project
    } else {
        Scope::Global
    };
    let probe = adapter::probe_registered(
        registry,
        &request.tool_id,
        custom_cli_path(db, &request.tool_id)
            .map_err(|message| LaunchPlanError::new(LaunchStage::Tool, message))?
            .as_deref(),
        home,
        project.as_ref().map(|_| directory.as_path()),
        scope,
    )
    .map_err(|message| LaunchPlanError::new(LaunchStage::Tool, message))?;
    let selected_path = probe.selected_path.as_deref().ok_or_else(|| {
        LaunchPlanError::new(
            LaunchStage::Tool,
            "CLI 未确认安装，请在工具页检查安装路径".into(),
        )
    })?;
    let version = probe
        .installations
        .iter()
        .find(|item| item.path == selected_path && item.status == "available")
        .and_then(|item| item.version.as_deref())
        .ok_or_else(|| {
            LaunchPlanError::new(
                LaunchStage::Tool,
                "CLI 版本未确认，请在工具页重新检测".into(),
            )
        })?;
    let mut cli_args = adapters::plan_launch(
        registry,
        &request.tool_id,
        version,
        request.session_id.as_deref(),
        request.mode,
    )
    .map_err(|message| LaunchPlanError::new(LaunchStage::Tool, message))?;
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
    Ok(LaunchPlan {
        tool_id: request.tool_id,
        project_id: request.project_id,
        mode: request.mode,
        executable: PathBuf::from(selected_path),
        cli_args,
        directory,
        terminal: selected_terminal(db)
            .map_err(|message| LaunchPlanError::new(LaunchStage::Terminal, message))?,
    })
}

fn quote_powershell(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn quote_shell(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn shell_script(plan: &LaunchPlan) -> Result<String, String> {
    let directory = plan.directory.to_str().ok_or("项目目录文字编码无法识别")?;
    let executable = plan.executable.to_str().ok_or("CLI 路径文字编码无法识别")?;
    let mut parts = vec![quote_shell(executable)];
    parts.extend(plan.cli_args.iter().map(|arg| quote_shell(arg)));
    Ok(format!(
        "cd -- {} && exec {}",
        quote_shell(directory),
        parts.join(" ")
    ))
}

pub fn terminal_command(plan: &LaunchPlan) -> Result<TerminalCommand, String> {
    let directory = plan.directory.to_str().ok_or("项目目录文字编码无法识别")?;
    let executable = plan.executable.to_str().ok_or("CLI 路径文字编码无法识别")?;
    let powershell = || {
        let mut parts = vec![format!("& {}", quote_powershell(executable))];
        parts.extend(plan.cli_args.iter().map(|arg| quote_powershell(arg)));
        format!(
            "Set-Location -LiteralPath {}; {}",
            quote_powershell(directory),
            parts.join(" ")
        )
    };
    let (program, args) = match plan.terminal {
        TerminalId::WindowsTerminal => (
            "wt.exe",
            vec![
                "-d".into(),
                directory.into(),
                "powershell.exe".into(),
                "-NoProfile".into(),
                "-NoExit".into(),
                "-ExecutionPolicy".into(),
                "Bypass".into(),
                "-Command".into(),
                powershell(),
            ],
        ),
        TerminalId::PowerShell => (
            "powershell.exe",
            vec![
                "-NoProfile".into(),
                "-NoExit".into(),
                "-ExecutionPolicy".into(),
                "Bypass".into(),
                "-Command".into(),
                powershell(),
            ],
        ),
        TerminalId::MacTerminal => {
            let script = shell_script(plan)?;
            let script = script.replace('\\', "\\\\").replace('"', "\\\"");
            (
                "osascript",
                vec![
                    "-e".into(),
                    format!("tell application \"Terminal\" to do script \"{script}\""),
                    "-e".into(),
                    "tell application \"Terminal\" to activate".into(),
                ],
            )
        }
        TerminalId::GnomeTerminal => (
            "gnome-terminal",
            vec![
                format!("--working-directory={directory}"),
                "--".into(),
                "sh".into(),
                "-lc".into(),
                shell_script(plan)?,
            ],
        ),
        TerminalId::Konsole => (
            "konsole",
            vec![
                "--workdir".into(),
                directory.into(),
                "-e".into(),
                "sh".into(),
                "-lc".into(),
                shell_script(plan)?,
            ],
        ),
        TerminalId::Xterm => (
            "xterm",
            vec!["-e".into(), "sh".into(), "-lc".into(), shell_script(plan)?],
        ),
        TerminalId::Auto => return Err("请先选择可用的终端".into()),
    };
    Ok(TerminalCommand {
        program,
        args,
        directory: plan.directory.clone(),
    })
}

pub fn spawn(plan: LaunchPlan) -> Result<LaunchResult, String> {
    let terminal = terminal_command(&plan)?;
    let mut command = Command::new(terminal.program);
    command
        .args(&terminal.args)
        .current_dir(&terminal.directory)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0000_0010 | 0x0000_0200); // CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP
    }
    command
        .spawn()
        .map_err(|error| format!("无法打开所选终端，请在设置中更换后重试：{error}"))?;
    Ok(LaunchResult {
        tool_id: plan.tool_id,
        project_id: plan.project_id,
        mode: plan.mode,
        terminal: plan.terminal,
        status: "terminal_requested",
    })
}

#[cfg(test)]
#[path = "../../tests/launch/launch.rs"]
mod tests;
