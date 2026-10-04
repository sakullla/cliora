use crate::adapters::plugins::text;
use crate::adapters::{self, Registry};
// Plugins are native packages, never flattened into the Skill library.
use crate::{
    accounts::selection,
    credentials::CredentialStore,
    database::Database,
    native::{
        adapter::{self, Scope},
        format::{self, FileKind},
        transaction::{self, FilePatch},
    },
};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
#[cfg(test)]
use serde_json::json;
use serde_json::Value;
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Mutex,
    time::{Duration, Instant},
};

static OPERATIONS: Mutex<()> = Mutex::new(());
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginTarget {
    pub tool_id: String,
    pub scope: Scope,
    pub project_path: Option<String>,
    pub context_id: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEntry {
    pub id: String,
    pub name: String,
    pub source: String,
    pub version: Option<String>,
    pub scope: String,
    pub enabled: Option<bool>,
    pub state: String,
    pub policy: String,
    pub read_only: bool,
    pub root: Option<String>,
    /// Package-owned resources are read-only consumers for the agent manager.
    pub resources: Vec<PluginResource>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginResource {
    pub kind: String,
    pub path: String,
    pub owner_id: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSnapshot {
    pub target: PluginTarget,
    pub capability: adapters::plugins::PluginCapability,
    pub entries: Vec<PluginEntry>,
    pub baseline: String,
    pub detail: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRequest {
    pub target: PluginTarget,
    pub action: String,
    pub source: String,
    pub baseline: String,
    pub trusted: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginResult {
    pub status: String,
    pub detail: String,
    pub transaction_id: Option<String>,
    pub snapshot: Option<PluginSnapshot>,
}

pub(crate) fn project(target: &PluginTarget) -> Result<Option<PathBuf>, String> {
    if target.scope == Scope::Global {
        return Ok(None);
    }
    let path = PathBuf::from(target.project_path.as_deref().ok_or("请选择项目")?);
    if !path.is_absolute() || !path.is_dir() {
        return Err("项目目录不可用".into());
    }
    Ok(Some(path))
}
fn config(home: &Path, target: &PluginTarget) -> Result<(PathBuf, FileKind), String> {
    if let Some(location) = adapters::plugins::get(&target.tool_id)?.config_location(home, target)? { return Ok(location); }
    let registry = Registry::builtins();
    let cli = registry.get(&target.tool_id).ok_or("未知 CLI")?;
    let project = project(target)?;
    let file = cli
        .native_files(target.scope, home, project.as_deref(), true)
        .into_iter()
        .find(|f| f.role == "settings" && !f.sensitive)
        .ok_or("没有此作用域的插件配置")?;
    Ok((PathBuf::from(&file.path), FileKind::for_name(&file.path)?))
}
fn executable(db: &Database, home: &Path, target: &PluginTarget, fresh: bool) -> Result<PathBuf, String> {
    let custom: Option<String> = db.with_connection(|conn| {
        conn.query_row(
            "SELECT path FROM installation_choices WHERE tool=?1",
            [&target.tool_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "无法读取 CLI 路径".into())
    })?;
    let probe = adapter::probe_registered_cached(
        &Registry::builtins(),
        &target.tool_id,
        custom.as_deref().map(Path::new),
        home,
        project(target)?.as_deref(),
        target.scope,
        fresh,
    )?;
    let selected = probe.selected_path.ok_or("未找到 CLI 安装")?;
    let version = probe
        .installations
        .iter()
        .find(|item| item.path == selected)
        .and_then(|item| item.version.as_deref())
        .ok_or("未识别 CLI 版本")?;
    let adapter = adapters::plugins::get(&target.tool_id)?;
    let policy = adapter.version_policy();
    if !policy.accepts(version) {
        return Err(format!(
            "插件参考核验版本 {}；当前 {version} 不满足原生契约范围 {}，请使用兼容版本或更新适配器",
            adapter.capability().version,
            policy.requirement
        ));
    }
    Ok(selected.into())
}
fn run(
    executable: &Path,
    home: &Path,
    target: &PluginTarget,
    args: &[String],
) -> Result<String, String> {
    let (mut path, prefix) = adapters::plugins::get(&target.tool_id)?.command_program(executable)?;
    #[cfg(windows)]
    if path
        .extension()
        .is_some_and(|x| x.eq_ignore_ascii_case("cmd"))
    {
        path.set_extension("ps1");
    }
    let mut command = if path
        .extension()
        .is_some_and(|x| x.eq_ignore_ascii_case("ps1"))
    {
        // File arguments, never an interpolated PowerShell program.
        let mut cmd = crate::background_process::command("powershell.exe");
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(&path);
        cmd
    } else {
        crate::background_process::command(&path)
    };
    command.args(prefix);
    if let Some(context) = selection::current(&target.tool_id) {
        context.apply_to_command(&mut command)?;
        command.args(&context.cli_args);
    }
    command
        .current_dir(project(target)?.as_deref().unwrap_or(home))
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "无法启动原生插件命令".to_owned())?;
    let stdout = child.stdout.take().ok_or("无法读取原生命令结果")?;
    let (send, receive) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout.take(2 * 1024 * 1024 + 1).read_to_end(&mut bytes);
        let _ = send.send((result, bytes));
    });
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|_| "无法读取原生命令状态")? {
            let (result, bytes) = receive
                .recv_timeout(Duration::from_secs(2))
                .map_err(|_| "原生输出尚未结束；请重新扫描")?;
            result.map_err(|_| "无法读取原生输出")?;
            if !status.success() {
                return Err(format!("原生命令失败（退出码 {}）；可能已产生部分配置或下载。请重新扫描；组织策略、信任及市场认证由原生 CLI 决定", status.code().unwrap_or(-1)));
            }
            if bytes.len() > 2 * 1024 * 1024 {
                return Err("原生输出超过 2 MiB；请在原生 CLI 检查".into());
            }
            return String::from_utf8(bytes).map_err(|_| "原生输出不是 UTF-8".into());
        }
        if started.elapsed() > Duration::from_secs(60) {
            #[cfg(windows)]
            {
                if let Some(root) = std::env::var_os("SystemRoot") {
                    let _ = crate::background_process::command(
                        PathBuf::from(root).join("System32/taskkill.exe"),
                    )
                    .args(["/PID", &child.id().to_string(), "/T", "/F"])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
                }
            }
            #[cfg(unix)]
            {
                let _ = crate::background_process::command("/bin/kill")
                    .args(["-KILL", &format!("-{}", child.id())])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
            let _ = child.kill();
            let _ = child.wait();
            return Err("原生命令超时并停止；已经下载/修改的内容未自动回滚，请重新扫描".into());
        }
        std::thread::sleep(Duration::from_millis(40));
    }
}

fn parse_list(
    tool: &str,
    value: &Value,
    target: &PluginTarget,
) -> Result<Vec<PluginEntry>, String> {
    parse_list_registered(&Registry::builtins(), tool, value, target)
}
pub(crate) fn parse_list_registered(
    registry: &Registry,
    tool: &str,
    value: &Value,
    target: &PluginTarget,
) -> Result<Vec<PluginEntry>, String> {
    adapters::plugins::get_registered(registry, tool)?.parse_list(value, target)
}
fn disabled_key(target: &PluginTarget) -> String {
    let mut target = target.clone();
    // Project declarations are shared files; the request still carries the
    // effective account for concurrency checks, but recovery belongs to the file.
    if target.scope == Scope::Project {
        target.context_id = None;
    }
    format!(
        "native_plugin_disabled:{}",
        transaction::fingerprint(
            serde_json::to_string(&target)
                .unwrap_or_default()
                .as_bytes()
        )
    )
}
fn disabled(
    db: &Database,
    target: &PluginTarget,
) -> Result<serde_json::Map<String, Value>, String> {
    let saved: Option<String> = db.with_connection(|conn| {
        conn.query_row(
            "SELECT value FROM app_settings WHERE key=?1",
            [disabled_key(target)],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "读取禁用插件失败".into())
    })?;
    saved
        .map(|s| serde_json::from_str(&s).map_err(|_| "禁用插件记录损坏".into()))
        .unwrap_or_else(|| Ok(Default::default()))
}

// Pi 0.99.2 DefaultPackageManager getManagedNpmInstallPath/getGitInstallPath.
// Legacy global npm roots can be customized by arbitrary package-manager
// commands: do not execute those during discovery or guess their location.
//
// A native backup restores the document, not Cliora's recovery metadata.
// Reconcile only an exact original declaration; arbitrary edits remain unknown.
fn reconcile_disabled(
    db: &Database,
    target: &PluginTarget,
    path: &Path,
    baseline: &str,
    entries: &[Value],
) -> Result<serde_json::Map<String, Value>, String> {
    let mut saved = disabled(db, target)?;
    let before = serde_json::to_string(&saved).map_err(|_| "禁用记录不可读取")?;
    saved.retain(|_, original| !entries.iter().any(|item| item == original));
    let after = serde_json::to_string(&saved).map_err(|_| "禁用记录不可读取")?;
    if before != after {
        db.with_connection(|conn| {
            let tx = conn.transaction().map_err(|_| "无法对账插件恢复记录")?;
            if transaction::read_native(path)? != baseline {
                return Err("原生配置在恢复对账期间又被修改，请重新扫描".into());
            }
            let key = disabled_key(target);
            let current: String = tx
                .query_row(
                    "SELECT value FROM app_settings WHERE key=?1",
                    [&key],
                    |row| row.get(0),
                )
                .map_err(|_| "插件恢复记录已变化")?;
            let current: serde_json::Map<String, Value> =
                serde_json::from_str(&current).map_err(|_| "插件恢复记录损坏")?;
            if serde_json::to_string(&current).map_err(|_| "恢复记录不可读取")? != before {
                return Err("插件恢复记录已变化，请重新扫描".into());
            }
            tx.execute(
                "UPDATE app_settings SET value=?1 WHERE key=?2",
                [&after, &key],
            )
            .map_err(|_| "插件恢复对账失败")?;
            tx.commit().map_err(|_| "插件恢复对账提交失败".to_owned())
        })?;
    }
    Ok(saved)
}
fn config_entries(
    db: &Database,
    home: &Path,
    target: &PluginTarget,
) -> Result<Vec<PluginEntry>, String> {
    let (path, kind) = config(home, target)?;
    let baseline = transaction::read_native(&path)?;
    let parsed = format::parse(kind, &baseline)?;
    let adapter = adapters::plugins::get(&target.tool_id)?;
    let field = adapter.config_field().ok_or("插件没有配置声明格式")?;
    let empty = vec![];
    let entries = match parsed.get(field) {
        Some(value) => value.as_array().ok_or("插件配置不是数组")?,
        None => &empty,
    };
    let saved = reconcile_disabled(db, target, &path, &baseline, entries)?;
    let source_of = |item: &Value| {
        item.as_str()
            .map(str::to_owned)
            .or_else(|| text(item, &["source"]))
    };
    let mut result = vec![];
    for (item, declared) in entries.iter().map(|item| (item.clone(), true)).chain(
        saved
            .iter()
            .filter(|(source, _)| {
                !entries
                    .iter()
                    .any(|item| source_of(item).as_ref() == Some(source))
            })
            .map(|(_, item)| (item.clone(), false)),
    ) {
        let source = item
            .as_str()
            .map(str::to_owned)
            .or_else(|| text(&item, &["source"]))
            .ok_or("插件声明没有来源")?;
        let disabled_original = saved.get(&source);
        let enabled = declared && disabled_original.is_none();
        let conflict = disabled_original.is_some_and(|original| {
            let disabled = adapter.disabled_declaration(original, &source);
            if declared {
                disabled.as_ref() != Some(&item)
            } else {
                disabled.is_some()
            }
        });
        let resolved = adapter.resolve_root(&source, path.parent().ok_or("配置缺少父目录")?, home);
        let resolution_error = resolved.as_ref().err().cloned();
        let root = resolved.unwrap_or(None);
        let package = adapter.package_metadata(root.as_deref());
        let mut entry = PluginEntry {
            id: source.clone(),
            name: package.name.unwrap_or_else(|| source.clone()),
            source,
            version: package.version,
            scope: if target.scope == Scope::Global {
                "user"
            } else {
                "project"
            }
            .into(),
            enabled: if conflict { None } else { Some(enabled) },
            state: if conflict {
                "state_unknown"
            } else if enabled {
                "configured_load_unknown"
            } else {
                "disabled"
            }
            .into(),
            policy: if adapter.project_trust() && target.scope == Scope::Project {
                "需原生项目信任"
            } else {
                "原生策略校验"
            }
            .into(),
            read_only: conflict || resolution_error.is_some(),
            root: root.map(|p| p.display().to_string()),
            resources: vec![],
        };
        if conflict {
            entry
                .policy
                .push_str(" · 禁用后声明被外部修改，请先恢复或核对原生备份");
        }
        if let Some(error) = resolution_error {
            entry.policy.push_str(&format!(" · {error}"));
        }
        if let Err(error) = adapter.resources(&mut entry, package.manifest.as_ref()) {
            entry.read_only = true;
            entry.policy.push_str(&format!(" · {error}"));
        }
        result.push(entry);
    }
    result.extend(adapter.discover(home, target, &path)?);
    Ok(result)
}
// Bound complete package trees, including directory membership. Never follow
// symlinks/reparse points into another package or account.
fn digest_path(path: &Path, output: &mut String, budget: &mut (usize, u64)) -> Result<(), String> {
    if !path.exists() {
        output.push_str("missing");
        return Ok(());
    }
    let meta = fs::symlink_metadata(path).map_err(|_| "无法检查插件文件")?;
    if meta.file_type().is_symlink() {
        return Err("插件含符号链接；请在原生 CLI 中管理，未跟随链接".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err("插件含重解析点；未跟随链接".into());
        }
    }
    budget.0 += 1;
    budget.1 += if meta.is_file() { meta.len() } else { 0 };
    if budget.0 > 20000 || budget.1 > 128 * 1024 * 1024 {
        return Err("插件目录超过校验上限；请在原生 CLI 管理".into());
    }
    output.push_str(&path.display().to_string());
    if meta.is_dir() {
        let mut children = fs::read_dir(path)
            .map_err(|_| "无法读取插件目录")?
            .map(|item| item.map(|e| e.path()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "无法读取插件目录")?;
        children.sort();
        for child in children {
            digest_path(&child, output, budget)?;
        }
    } else {
        output.push_str(&transaction::fingerprint(
            &fs::read(path).map_err(|_| "无法读取插件文件")?,
        ));
    }
    Ok(())
}
fn snapshot_inner(
    db: &Database,
    home: &Path,
    target: &PluginTarget,
    exe: Option<&Path>,
) -> Result<PluginSnapshot, String> {
    snapshot_with_packages(db, home, target, exe, true)
}
fn snapshot_with_packages(
    db: &Database,
    home: &Path,
    target: &PluginTarget,
    exe: Option<&Path>,
    verify_packages: bool,
) -> Result<PluginSnapshot, String> {
    let capability = adapters::plugins::capability(&target.tool_id)?;
    if target.scope == Scope::Project && !capability.project {
        return Err(capability.detail.into());
    }
    let adapter = adapters::plugins::get(&target.tool_id)?;
    let mut entries = if adapter.discovery_only() {
        let (path, _) = config(home, target)?;
        adapter.discover(home, target, &path)?
    } else if adapter.config_field().is_some() {
        config_entries(db, home, target)?
    } else {
        let output = run(exe.ok_or("未找到 CLI 安装")?, home, target, &adapter.list_command_args())?;
        let value: Value = serde_json::from_str(&output).map_err(|_| "原生插件输出格式不兼容")?;
        parse_list(&target.tool_id, &value, target)?
    };
    let (path, _) = config(home, target)?;
    let mut basis = serde_json::to_string(&(target, &entries)).map_err(|_| "无法序列化插件")?;
    basis.push_str(&transaction::read_native(&path)?);
    for file in adapter.snapshot_files(home, target) {
        basis.push_str(&file.display().to_string());
        basis.push_str(&transaction::read_native(&file)?);
    }
    let mut budget = (0, 0);
    for entry in &mut entries {
        adapter.decorate(entry, &path)?;
        if entry.resources.is_empty() {
            adapter.fill_missing_resources(entry)?;
        }
        if let Some(root) = entry.root.as_ref().filter(|_| verify_packages && !entry.read_only) {
            // Native local installs intentionally link the package root (Grok).
            // Include the link identity and canonical destination in the baseline;
            // nested links remain unsupported and make this entry read-only.
            basis.push_str(root);
            let canonical = Path::new(root)
                .canonicalize()
                .unwrap_or_else(|_| root.into());
            if let Err(error) = digest_path(&canonical, &mut basis, &mut budget) {
                entry.read_only = true;
                entry.policy.push_str(&format!(" · {error}"));
            }
        }
    }
    let ids: Vec<_> = entries.iter().map(|entry| entry.id.clone()).collect();
    for entry in &mut entries {
        if ids.iter().filter(|id| *id == &entry.id).count() > 1 {
            entry.read_only = true;
            entry
                .policy
                .push_str(" · 同名多来源，原生命令不能唯一选择，请在原生 CLI 管理");
        }
    }
    basis.push_str(&serde_json::to_string(&disabled(db, target)?).map_err(|_| "禁用记录错误")?);
    Ok(PluginSnapshot { target: target.clone(), capability, entries, baseline: transaction::fingerprint(basis.as_bytes()), detail: "列表与本机文件快照；原生会话是否已加载无法从静态列表确认。配置事务可从配置页的原生备份恢复。".into() })
}
pub fn scan(db: &Database, home: &Path, target: &PluginTarget) -> Result<PluginSnapshot, String> {
    scan_with_packages(db, home, target, true)
}
/// Agent definitions have their own content baseline; they never mutate plugin
/// packages, so enumerating their resources needs no whole-package digest.
pub(super) fn scan_resources(db: &Database, home: &Path, target: &PluginTarget) -> Result<PluginSnapshot, String> {
    scan_with_packages(db, home, target, false)
}
fn scan_with_packages(db: &Database, home: &Path, target: &PluginTarget, verify_packages: bool) -> Result<PluginSnapshot, String> {
    let project = project(target)?;
    let _context =
        selection::enter_bound(db, home, &target.tool_id, target.scope, project.as_deref())?;
    selection::validate_expected(&target.tool_id, target.context_id.as_deref())?;
    // File-backed discovery validates native documents directly. It does not
    // require a runnable CLI (desktop apps have no version command).
    let adapter = adapters::plugins::get(&target.tool_id)?;
    let exe = if adapter.discovery_only() || adapter.config_field().is_some() {
        None
    } else {
        Some(executable(db, home, target, false)?)
    };
    snapshot_with_packages(db, home, target, exe.as_deref(), verify_packages)
}

fn mutate_config(
    db: &Database,
    credentials: &dyn CredentialStore,
    home: &Path,
    request: &PluginRequest,
) -> Result<String, String> {
    let target = &request.target;
    let (path, kind) = config(home, target)?;
    let baseline = transaction::read_native(&path)?;
    let parsed = format::parse(kind, &baseline)?;
    let mut saved = disabled(db, target)?;
    let changes =
        adapters::plugins::get(&target.tool_id)?.config_changes(&parsed, &mut saved, request)?;
    let key = disabled_key(target);
    let value = serde_json::to_string(&saved).map_err(|_| "无法保存禁用记录")?;
    transaction::watch_file_metadata(db, &path, &key)?;
    let result = transaction::apply(
        db,
        credentials,
        &[FilePatch {
            path,
            kind,
            baseline,
            changes,
            // The same native document can contain apiKey/env credentials.
            // Restrict the replacement even when this patch only edits plugins.
            sensitive: true,
            force_restrict: true,
        }],
        |tx| {
            tx.execute("INSERT INTO app_settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [&key, &value]).map_err(|_| "保存插件恢复记录失败")?;
            Ok(())
        },
    )?;
    Ok(result.transaction_id)
}
pub fn operate(
    db: &Database,
    credentials: &dyn CredentialStore,
    home: &Path,
    request: &PluginRequest,
) -> Result<PluginResult, String> {
    let _operation = OPERATIONS
        .try_lock()
        .map_err(|_| "已有插件操作进行中，请等待后重新扫描")?;
    let target = &request.target;
    let project = project(target)?;
    let _context =
        selection::enter_bound(db, home, &target.tool_id, target.scope, project.as_deref())?;
    selection::validate_expected(&target.tool_id, target.context_id.as_deref())?;
    let adapter = adapters::plugins::get(&target.tool_id)?;
    let configured_operation = adapter.config_only(&request.action, None);
    let needs_executable = !configured_operation || (!adapter.discovery_only() && adapter.config_field().is_none());
    let exe = if needs_executable { Some(executable(db, home, target, true)?) } else { None };
    let before = snapshot_inner(db, home, target, exe.as_deref())?;
    if before.baseline != request.baseline {
        return Err("插件配置或目录被外部修改，请重新扫描后重试；没有执行操作".into());
    }
    if !before.capability.actions.contains(&request.action.as_str()) {
        return Err("此原生操作尚未支持".into());
    }
    if request.source.is_empty()
        || request.source.starts_with('-')
        || request.source.chars().any(char::is_control)
        || request.source.len() > 2048
    {
        return Err("插件来源无效".into());
    }
    let entry = before
        .entries
        .iter()
        .find(|entry| entry.id == request.source);
    if entry.is_some_and(|entry| entry.read_only) {
        return Err("插件由组织策略、其他作用域或不可唯一定位的原生来源管理".into());
    }
    if request.action != "install" {
        let entry = entry.ok_or("插件已不存在，请重新扫描")?;
        if entry.read_only {
            return Err(format!("插件由原生策略或其他作用域管理：{}", entry.policy));
        }
    }
    if matches!(request.action.as_str(), "install" | "update") && !request.trusted {
        return Err("安装或更新插件会执行外部代码，请先确认信任来源".into());
    }
    let fresh_context = selection::bound(
        db,
        home,
        &target.tool_id,
        target.scope,
        project.as_deref(),
        false,
    )?
    .map(|(_, context)| context.id);
    if fresh_context != target.context_id {
        return Err("扫描期间账号上下文已切换，请重新扫描".into());
    }
    let config_only = adapter.config_only(&request.action, entry);
    adapter.validate_operation(request, entry)?;
    let result = if config_only {
        mutate_config(db, credentials, home, request).map(Some)
    } else {
        let (path, _) = config(home, target)?;
        let source = adapter.operation_source(request, &path)?;
        let args = adapters::plugins::command_args(
            &target.tool_id,
            &request.action,
            &source,
            target.scope == Scope::Project,
        )?;
        let command_exe = match &exe { Some(exe) => exe.clone(), None => executable(db, home, target, true)? };
        run(&command_exe, home, target, &args).map(|_| None)
    };
    let snapshot = snapshot_inner(db, home, target, exe.as_deref());
    match result {
        Ok(transaction_id) => Ok(PluginResult {
            status: if config_only {
                "configuration_written"
            } else {
                "native_command_completed"
            }
            .into(),
            detail: format!(
                "{}；现有会话未热加载。{}",
                if config_only && request.action == "uninstall" {
                    "插件声明及禁用恢复记录已移除；本地包和依赖缓存保留"
                } else if config_only {
                    "配置已写入，依赖安装与加载尚未验证"
                } else {
                    "原生命令已完成，加载状态仍需重启会话核验"
                },
                if snapshot.is_err() {
                    "重新扫描失败，请手动重新扫描检查实际状态"
                } else {
                    "已重新扫描"
                }
            ),
            transaction_id,
            snapshot: snapshot.ok(),
        }),
        Err(error) => Ok(PluginResult {
            status: "failed_possible_side_effects".into(),
            detail: format!(
                "{error}；未宣称原子回滚。{}",
                if snapshot.is_err() {
                    "重新扫描失败，请在原生 CLI 检查"
                } else {
                    "已重新扫描实际状态"
                }
            ),
            transaction_id: None,
            snapshot: snapshot.ok(),
        }),
    }
}

#[cfg(test)]
#[path = "../../../tests/resources/plugins.rs"]
mod tests;
