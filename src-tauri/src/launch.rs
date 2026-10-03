use std::env;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use base64::Engine;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::database::Database;
use crate::native::adapter::{self, Scope};
use crate::adapters::{self, LaunchMode, Registry};
use crate::projects;
use crate::resources::skills;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalId {
    Auto,
    WindowsTerminal,
    PowerShell,
    MacTerminal,
    Custom,
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
            Self::Custom => "自定义",
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
            Self::MacTerminal => Some("/usr/bin/open"),
            Self::Custom => None,
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
            Self::Custom => true,
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
}

#[derive(Clone, Debug)]
pub struct TerminalCommand {
    pub program: &'static str,
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

fn terminal_available(id: TerminalId) -> bool {
    match id {
        TerminalId::Custom => true,
        other => other.binary().is_some_and(on_path),
    }
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
    let Some(text) = read_setting(db, "preferred_terminal")? else {
        return Ok(TerminalId::Auto);
    };
    let name: String = serde_json::from_str(&text).map_err(|_| "终端设置格式无法识别".to_string())?;
    // Older builds stored a product name. Keep that choice as a command template.
    if name == "tabby" {
        return migrate_removed_terminal(db, "tabby");
    }
    serde_json::from_str(&text).map_err(|_| "终端设置格式无法识别".into())
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

fn selected_terminal(db: &Database) -> Result<TerminalId, String> {
    let preferred = terminal_preference(db)?;
    let options = terminal_options();
    if preferred == TerminalId::Auto {
        return options
            .into_iter()
            .find(|option| option.id != TerminalId::Auto && option.id != TerminalId::Custom && option.available)
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

pub fn plan_with_stage(
    db: &Database,
    registry: &Registry,
    home: &Path,
    request: LaunchRequest,
) -> Result<LaunchPlan, LaunchPlanError> {
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

fn plan_with_stage_at(
    db: &Database,
    registry: &Registry,
    home: &Path,
    request: LaunchRequest,
    directory_override: Option<&Path>,
    resume_context: Option<Option<(String, crate::accounts::NativeContext)>>,
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
        if prompt.chars().count() > 20_000 {
            return Err(LaunchPlanError::new(LaunchStage::Tool, "提示词过长，请先缩短后再启动。".into()));
        }
        cli_args.push(prompt.to_owned());
    }
    Ok(LaunchPlan {
        account_version: account_context.as_ref().map(|(id,_)|crate::accounts::get(db,id).map(|account|account.version)).transpose().map_err(|message|LaunchPlanError::new(LaunchStage::Configuration,message))?,
        account_context,
        tool_id: request.tool_id,
        project_id: request.project_id,
        mode: request.mode,
        executable: PathBuf::from(selected_path),
        cli_args,
        directory,
        session_markers: adapter.session_env_markers(),
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
    Ok(LaunchPlan {account_version:None,account_context:None,tool_id:tool.into(),project_id:None,mode:LaunchMode::Normal,executable:PathBuf::from(selected),cli_args,
        directory:projects::checked_directory(&home.display().to_string())?,session_markers:adapter.session_env_markers(),terminal:selected_terminal(db)?})
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

fn context_script(plan: &LaunchPlan, windows: bool) -> String {
    let Some((_,context))=&plan.account_context else {return String::new();};
    let mut parts=Vec::new();
    for key in &context.remove_environment { parts.push(if windows {format!("Remove-Item -LiteralPath 'Env:{key}' -ErrorAction SilentlyContinue")} else {format!("unset {key}")}); }
    for (key,value) in &context.environment { parts.push(if windows {format!("$env:{key} = {}",quote_powershell(value))} else {format!("export {key}={}",quote_shell(value))}); }
    format!("{}; ",parts.join("; "))
}

fn powershell_script(plan: &LaunchPlan) -> Result<String, String> {
    let directory = terminal_path(&plan.directory)?;
    let executable = terminal_path(&plan.executable)?;
    let mut parts = vec![format!("& {}", quote_powershell(&executable))];
    parts.extend(plan.cli_args.iter().map(|arg| quote_powershell(arg)));
    Ok(format!(
        "{}Set-Location -LiteralPath {}; {}",
        context_script(plan,true),
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
        "{}cd -- {} && exec {}",
        context_script(plan,false),
        quote_shell(directory),
        parts.join(" ")
    ))
}

fn interactive_powershell_script(plan: &LaunchPlan) -> Result<String, String> {
    let cleanup = if plan.session_markers.is_empty() {
        String::new()
    } else {
        let markers = plan.session_markers.iter().map(|name| format!("'{name}'")).collect::<Vec<_>>().join(",");
        format!("foreach ($name in {markers}) {{ Remove-Item -LiteralPath \"Env:$name\" -ErrorAction SilentlyContinue }}; ")
    };
    Ok(format!(
        "if ($null -ne $env:NO_COLOR) {{ Remove-Item Env:NO_COLOR -ErrorAction SilentlyContinue }}; if ($env:TERM -eq 'dumb') {{ Remove-Item Env:TERM -ErrorAction SilentlyContinue }}; if ($env:FORCE_COLOR -in '0','false') {{ Remove-Item Env:FORCE_COLOR -ErrorAction SilentlyContinue }}; {cleanup}{}",
        powershell_script(plan)?
    ))
}
fn interactive_shell_script(plan: &LaunchPlan) -> Result<String, String> {
    let cleanup = if plan.session_markers.is_empty() { String::new() } else { format!("unset {}; ", plan.session_markers.join(" ")) };
    Ok(format!(
        "unset NO_COLOR; if [ \"${{TERM-}}\" = dumb ]; then unset TERM; fi; if [ \"${{FORCE_COLOR-}}\" = 0 ] || [ \"${{FORCE_COLOR-}}\" = false ]; then unset FORCE_COLOR; fi; {cleanup}{}",
        shell_script(plan)?
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

pub fn terminal_command(plan: &LaunchPlan) -> Result<TerminalCommand, String> {
    let directory = terminal_path(&plan.directory)?;
    let powershell = || interactive_powershell_script(plan).map(|script| encoded_powershell(&script));
    let mac_script = if matches!(plan.terminal, TerminalId::MacTerminal | TerminalId::Custom) {
        Some(mac_terminal_shell_body(&directory, &interactive_shell_script(plan)?))
    } else {
        None
    };
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
        TerminalId::MacTerminal => ("/usr/bin/open", vec!["-a".into(), "Terminal".into()]),
        TerminalId::Custom => ("", Vec::new()),
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
        session_markers: plan.session_markers,
        mac_script,
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
    let (program, args) = match terminal {
        TerminalId::WindowsTerminal => (
            "wt.exe",
            vec!["powershell.exe".into(), "-NoProfile".into(), "-NoExit".into(), "-ExecutionPolicy".into(), "Bypass".into(), "-EncodedCommand".into(), encoded_powershell(script)],
        ),
        TerminalId::PowerShell => (
            "powershell.exe",
            vec!["-NoProfile".into(), "-NoExit".into(), "-ExecutionPolicy".into(), "Bypass".into(), "-EncodedCommand".into(), encoded_powershell(script)],
        ),
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
        TerminalId::Auto => return Err("请先选择可用的终端".into()),
    };
    Ok(TerminalCommand { program, args, directory: PathBuf::from(directory_text), session_markers: &[], mac_script })
}

fn spawn_terminal(db: &Database, terminal_id: TerminalId, terminal: TerminalCommand) -> Result<(), String> {
    #[cfg(windows)]
    if terminal_id == TerminalId::PowerShell {
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
    let mut command = Command::new(terminal.program);
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
    let terminal_id = plan.terminal;
    let terminal = terminal_command(&plan)?;
    spawn_terminal(db, terminal_id, terminal)?;
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
