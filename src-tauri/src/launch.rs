use std::env;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use base64::Engine;
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
    #[serde(default)]
    pub directory: Option<String>,
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
    plan_with_stage_at(db, registry, home, request, directory.as_deref())
}

pub fn plan_history(
    db: &Database,
    registry: &Registry,
    home: &Path,
    request: LaunchRequest,
    cwd: &Path,
) -> Result<LaunchPlan, LaunchPlanError> {
    plan_with_stage_at(db, registry, home, request, Some(cwd))
}

fn plan_with_stage_at(
    db: &Database,
    registry: &Registry,
    home: &Path,
    request: LaunchRequest,
    directory_override: Option<&Path>,
) -> Result<LaunchPlan, LaunchPlanError> {
    let skill_issues = skills::recover_report(db).map_err(|message| {
        LaunchPlanError::new(
            LaunchStage::Skills,
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
    let scope_key = if scope == Scope::Global {
        "global".to_owned()
    } else {
        format!("project:{}", directory.display())
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
    if request.session_id.is_some() && !adapter.history_resume_version_supported(version) {
        return Err(LaunchPlanError::new(
            LaunchStage::Tool,
            "此 CLI 版本的精确会话恢复命令尚未验证".into(),
        ));
    }
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

/// Native login does not apply named profiles or modify the original OAuth files.
pub fn login_plan(db: &Database, registry: &Registry, home: &Path, tool: &str, custom: Option<&Path>) -> Result<LaunchPlan, String> {
    let adapter = registry.get(tool).ok_or("此 CLI 尚无注册适配器")?;
    let cli_args = adapter.login_args().ok_or("此 CLI 没有原生交互登录入口，请配置 API 连接")?;
    let probe = adapter::probe_registered(registry, tool, custom, home, None, Scope::Global)?;
    let selected = probe.selected_path.ok_or("未找到可验证的 CLI，先安装或重新检测")?;
    Ok(LaunchPlan {tool_id:tool.into(),project_id:None,mode:LaunchMode::Normal,executable:PathBuf::from(selected),cli_args,
        directory:projects::checked_directory(&home.display().to_string())?,terminal:selected_terminal(db)?})
}

fn quote_powershell(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn quote_shell(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

// Extended-length paths remain useful for file IO; shells and terminal brokers expect DOS/UNC paths.
fn terminal_path(path: &Path) -> Result<String, String> {
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

pub fn native_command(plan: &LaunchPlan) -> Result<String, String> {
    if cfg!(windows) {
        powershell_script(plan)
    } else {
        shell_script(plan)
    }
}

fn powershell_script(plan: &LaunchPlan) -> Result<String, String> {
    let directory = terminal_path(&plan.directory)?;
    let executable = terminal_path(&plan.executable)?;
    let mut parts = vec![format!("& {}", quote_powershell(&executable))];
    parts.extend(plan.cli_args.iter().map(|arg| quote_powershell(arg)));
    Ok(format!(
        "Set-Location -LiteralPath {}; {}",
        quote_powershell(&directory),
        parts.join(" ")
    ))
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

fn inherited_noninteractive_color() -> bool { env::var("TERM").as_deref()==Ok("dumb") && env::var("NO_COLOR").as_deref()==Ok("1") }
fn interactive_powershell_script(plan: &LaunchPlan) -> Result<String,String> {
    let inherited=if inherited_noninteractive_color() {"$true"} else {"$false"};
    Ok(format!("if ($env:TERM -eq 'dumb' -or {inherited}) {{ if ($env:NO_COLOR -eq '1') {{ Remove-Item Env:NO_COLOR -ErrorAction SilentlyContinue }}; if ($env:TERM -eq 'dumb') {{ Remove-Item Env:TERM -ErrorAction SilentlyContinue }} }}; {}",powershell_script(plan)?))
}
fn interactive_shell_script(plan: &LaunchPlan) -> Result<String,String> {
    let prefix=if inherited_noninteractive_color() {"unset TERM NO_COLOR; "} else {"if [ \"${TERM-}\" = dumb ]; then unset TERM; if [ \"${NO_COLOR-}\" = 1 ]; then unset NO_COLOR; fi; fi; "};
    Ok(format!("{prefix}{}",shell_script(plan)?))
}

pub fn terminal_command(plan: &LaunchPlan) -> Result<TerminalCommand, String> {
    let directory = terminal_path(&plan.directory)?;
    let powershell = || interactive_powershell_script(plan).map(|script| encoded_powershell(&script));
    let (program, args) = match plan.terminal {
        TerminalId::WindowsTerminal => (
            "wt.exe",
            vec![
                "powershell.exe".into(),
                "-NoProfile".into(),
                "-NoExit".into(),
                "-ExecutionPolicy".into(),
                "Bypass".into(),
                "-EncodedCommand".into(),
                powershell()?,
            ],
        ),
        TerminalId::PowerShell => (
            "powershell.exe",
            vec![
                "-NoProfile".into(),
                "-NoExit".into(),
                "-ExecutionPolicy".into(),
                "Bypass".into(),
                "-EncodedCommand".into(),
                powershell()?,
            ],
        ),
        TerminalId::MacTerminal => {
            let script = interactive_shell_script(plan)?;
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
                interactive_shell_script(plan)?,
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
                interactive_shell_script(plan)?,
            ],
        ),
        TerminalId::Xterm => (
            "xterm",
            vec!["-e".into(), "sh".into(), "-lc".into(), interactive_shell_script(plan)?],
        ),
        TerminalId::Auto => return Err("请先选择可用的终端".into()),
    };
    Ok(TerminalCommand {
        program,
        args,
        directory: PathBuf::from(directory),
    })
}

#[cfg(windows)]
fn spawn_console(terminal: &TerminalCommand) -> Result<(),String> {
    use windows_sys::Win32::{Foundation::CloseHandle,System::Threading::{CreateProcessW,PROCESS_INFORMATION,STARTUPINFOW,CREATE_NEW_CONSOLE}};
    let executable=env::var_os("SystemRoot").map(PathBuf::from).ok_or("找不到 Windows 系统目录")?
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    if !executable.is_file() {return Err("找不到系统 PowerShell，请选择 Windows Terminal".into());}
    // EncodedCommand and the fixed PowerShell flags contain no quoting-sensitive characters.
    if terminal.args.iter().any(|arg|arg.chars().any(|ch|ch.is_whitespace() || ch=='"' || ch=='\0')) {return Err("PowerShell 启动参数无效".into());}
    let wide=|text:&str|text.encode_utf16().chain(std::iter::once(0)).collect::<Vec<_>>();
    let application=wide(&terminal_path(&executable)?);
    let mut line=wide(&format!("\"{}\" {}",terminal_path(&executable)?,terminal.args.join(" ")));
    let directory=wide(&terminal_path(&terminal.directory)?);
    let mut startup:STARTUPINFOW=unsafe{std::mem::zeroed()};startup.cb=std::mem::size_of::<STARTUPINFOW>() as u32;
    let mut process:PROCESS_INFORMATION=unsafe{std::mem::zeroed()};
    // No STARTF_USESTDHANDLES: Windows initializes the new console's real input/output handles.
    let created=unsafe{CreateProcessW(application.as_ptr(),line.as_mut_ptr(),std::ptr::null(),std::ptr::null(),0,CREATE_NEW_CONSOLE,std::ptr::null(),directory.as_ptr(),&startup,&mut process)};
    if created==0 {return Err(format!("无法打开 PowerShell：{}",std::io::Error::last_os_error()));}
    unsafe {CloseHandle(process.hThread);CloseHandle(process.hProcess);}
    Ok(())
}

pub fn spawn(plan: LaunchPlan) -> Result<LaunchResult, String> {
    let terminal = terminal_command(&plan)?;
    #[cfg(windows)]
    if plan.terminal==TerminalId::PowerShell {
        spawn_console(&terminal)?;
        return Ok(LaunchResult {tool_id:plan.tool_id,project_id:plan.project_id,mode:plan.mode,terminal:plan.terminal,status:"terminal_requested"});
    }
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
    if env::var("TERM").as_deref()==Ok("dumb") { command.env_remove("TERM"); if env::var("NO_COLOR").as_deref()==Ok("1") {command.env_remove("NO_COLOR");} }
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
