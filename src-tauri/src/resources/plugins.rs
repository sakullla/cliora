//! Plugins are native packages, never flattened into the Skill library.
use crate::{
    accounts::selection,
    credentials::CredentialStore,
    database::Database,
    native::{
        adapter::{self, Scope},
        adapters::{self, Registry},
        format::{self, FileKind},
        transaction::{self, FieldChange, FilePatch},
    },
};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
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

fn project(target: &PluginTarget) -> Result<Option<PathBuf>, String> {
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
fn executable(db: &Database, home: &Path, target: &PluginTarget) -> Result<PathBuf, String> {
    let custom: Option<String> = db.with_connection(|conn| {
        conn.query_row(
            "SELECT path FROM installation_choices WHERE tool=?1",
            [&target.tool_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "无法读取 CLI 路径".into())
    })?;
    let probe = adapter::probe_registered(
        &Registry::builtins(),
        &target.tool_id,
        custom.as_deref().map(Path::new),
        home,
        project(target)?.as_deref(),
        target.scope,
    )?;
    let selected = probe.selected_path.ok_or("未找到 CLI 安装")?;
    let version = probe
        .installations
        .iter()
        .find(|item| item.path == selected)
        .and_then(|item| item.version.as_deref())
        .ok_or("未识别 CLI 版本")?;
    let expected = adapters::plugins::capability(&target.tool_id)?.version;
    // Patch releases in the same minor line retain the native contract; failures
    // remain explicit rather than silently fabricating successful operations.
    let minor = |s: &str| s.split('.').take(2).collect::<Vec<_>>().join(".");
    if minor(version) != minor(expected) {
        return Err(format!(
            "插件契约核验版本为 {expected}；当前 {version} 不在已核验版本系列"
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
    let mut path = executable.to_path_buf();
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
fn text(value: &Value, names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| value.get(*name).and_then(Value::as_str).map(str::to_owned))
}
fn string_source(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_owned)
        .or_else(|| text(value, &["url", "path", "source", "repo"]))
        .unwrap_or_else(|| "原生来源未提供".into())
}
fn parse_list(
    tool: &str,
    value: &Value,
    target: &PluginTarget,
) -> Result<Vec<PluginEntry>, String> {
    let rows = if tool == "codex" {
        value.get("installed")
    } else {
        Some(value)
    }
    .and_then(Value::as_array)
    .ok_or("原生插件列表结构不兼容；未解释为无插件")?;
    rows.iter()
        .filter(|row| {
            if tool != "claude_code" {
                return true;
            }
            let scope = row
                .get("scope")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            if target.scope == Scope::Global {
                scope == "user" || scope == "managed"
            } else {
                (scope == "project" || scope == "local")
                    && row
                        .get("projectPath")
                        .and_then(Value::as_str)
                        .zip(target.project_path.as_deref())
                        .is_some_and(|(actual, expected)| {
                            let normalize = |p: &str| {
                                let p = p.replace('\\', "/").trim_end_matches('/').to_owned();
                                if cfg!(windows) {
                                    p.to_lowercase()
                                } else {
                                    p
                                }
                            };
                            normalize(actual) == normalize(expected)
                        })
            }
        })
        .map(|row| {
            let id = text(row, &["pluginId", "id", "name"])
                .ok_or("插件条目缺少身份；请使用原生 CLI 检查")?;
            let install_policy =
                text(row, &["installPolicy", "policy"]).unwrap_or_else(|| "原生策略校验".into());
            let auth_policy = text(row, &["authPolicy"]);
            let policy = format!(
                "{}{}",
                install_policy,
                auth_policy
                    .as_ref()
                    .map(|policy| format!(" · 认证 {policy}（原生校验）"))
                    .unwrap_or_default()
            );
            let scope = text(row, &["scope"]).unwrap_or_else(|| "user".into());
            let read_only = scope == "managed"
                || matches!(
                    install_policy.as_str(),
                    "REQUIRED" | "NOT_AVAILABLE" | "FORBIDDEN"
                )
                || scope == "local"
                || (tool == "codex"
                    && (!matches!(
                        install_policy.as_str(),
                        "AVAILABLE" | "REQUIRED" | "NOT_AVAILABLE" | "FORBIDDEN"
                    ) || auth_policy
                        .as_deref()
                        .is_some_and(|p| !matches!(p, "ON_INSTALL" | "NONE"))));
            Ok(PluginEntry {
                name: text(row, &["name"]).unwrap_or_else(|| id.clone()),
                id: id.clone(),
                source: row
                    .get("source")
                    .map(string_source)
                    .unwrap_or_else(|| id.clone()),
                version: text(row, &["version", "revision", "commit"]),
                scope,
                enabled: row.get("enabled").and_then(Value::as_bool),
                state: "installed_load_unknown".into(),
                policy,
                read_only,
                root: text(row, &["installPath", "installedPath", "path"]),
                resources: vec![],
            })
        })
        .collect()
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
fn owned_resources(entry: &mut PluginEntry) {
    let Some(root) = entry.root.as_deref().map(Path::new) else {
        return;
    };
    for (kind, paths) in [
        ("agents", vec!["agents"]),
        ("skills", vec!["skills"]),
        ("hooks", vec!["hooks"]),
        ("mcp", vec![".mcp.json"]),
        ("extensions", vec!["extensions"]),
        ("prompts", vec!["prompts"]),
        ("themes", vec!["themes"]),
    ] {
        for path in paths {
            let path = root.join(path);
            if path.exists() {
                entry.resources.push(PluginResource {
                    kind: kind.into(),
                    path: path.display().to_string(),
                    owner_id: entry.id.clone(),
                });
            }
        }
    }
}
fn local_root(source: &str, base: &Path) -> Option<PathBuf> {
    if source.starts_with("file:") {
        return url::Url::parse(source).ok()?.to_file_path().ok();
    }
    let path = Path::new(source);
    if path.is_absolute() {
        Some(path.to_path_buf())
    } else if source.starts_with('.') {
        Some(base.join(path))
    } else {
        None
    }
}
fn pi_disabled(item: &Value, source: &str) -> Value {
    let mut value = item
        .as_object()
        .cloned()
        .unwrap_or_else(|| serde_json::Map::from_iter([("source".into(), json!(source))]));
    // Project autoload:false is a delta over the global package. Empty delta
    // arrays remove exclusions, so disabling MUST replace inherited resources.
    value.insert("autoload".into(), json!(true));
    for kind in ["extensions", "skills", "prompts", "themes"] {
        value.insert(kind.into(), json!([]));
    }
    Value::Object(value)
}

/// Pi 0.99.2 DefaultPackageManager getManagedNpmInstallPath/getGitInstallPath.
/// Legacy global npm roots can be customized by arbitrary package-manager
/// commands: do not execute those during discovery or guess their location.
fn pi_installed_root(source: &str, base: &Path, home: &Path) -> Result<PathBuf, String> {
    let root = if let Some(spec) = source.strip_prefix("npm:") {
        let spec = spec.trim();
        let name = spec
            .rfind('@')
            .filter(|index| *index > 0)
            .map(|index| &spec[..index])
            .unwrap_or(spec);
        let parts: Vec<_> = name.split('/').collect();
        if name.is_empty()
            || !name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"@._-/".contains(&c))
            || parts.iter().any(|part| matches!(*part, "" | "." | ".."))
            || (name.starts_with('@') && parts.len() != 2)
            || (!name.starts_with('@') && parts.len() != 1)
        {
            return Err("Pi npm 来源无法安全解析，请用原生 CLI 管理".into());
        }
        base.join("npm/node_modules").join(name)
    } else if source.starts_with("git:")
        || source.starts_with("https://")
        || source.starts_with("http://")
        || source.starts_with("ssh://")
    {
        let source = if source.starts_with("git://") {
            source
        } else {
            source.strip_prefix("git:").unwrap_or(source)
        }
        .trim();
        let (host, path) = if let Some(scp) = source.strip_prefix("git@") {
            let (host, path) = scp.split_once(':').ok_or("Pi Git SSH 来源格式未识别")?;
            (host.to_owned(), path.to_owned())
        } else if source.contains("://") {
            let value = url::Url::parse(source).map_err(|_| "Pi Git URL 格式未识别")?;
            (
                value.host_str().ok_or("Pi Git URL 缺少主机")?.to_owned(),
                value.path().trim_start_matches('/').to_owned(),
            )
        } else {
            let expanded = source
                .strip_prefix("github:")
                .map(|path| format!("github.com/{path}"))
                .or_else(|| {
                    source
                        .strip_prefix("gitlab:")
                        .map(|path| format!("gitlab.com/{path}"))
                })
                .or_else(|| {
                    source
                        .strip_prefix("bitbucket:")
                        .map(|path| format!("bitbucket.org/{path}"))
                })
                .unwrap_or_else(|| source.into());
            let (host, path) = expanded.split_once('/').ok_or("Pi Git 简写格式未识别")?;
            if !host.contains('.') && host != "localhost" {
                return Err("Pi Git 简写的原生安装路径尚未核验".into());
            }
            (host.to_owned(), path.to_owned())
        };
        let path = path
            .split(['@', '#'])
            .next()
            .unwrap_or("")
            .trim_end_matches(".git");
        if host.is_empty()
            || !host
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b".-".contains(&c))
            || path.split('/').count() < 2
            || path.split('/').any(|part| matches!(part, "" | "." | ".."))
            || path
                .bytes()
                .any(|c| c.is_ascii_control() || b"\\:%?#".contains(&c))
        {
            return Err("Pi Git 来源安装路径无法安全解析".into());
        }
        base.join("git").join(host).join(path)
    } else if let Some(rest) = source
        .strip_prefix("~/")
        .or_else(|| source.strip_prefix("~\\"))
    {
        home.join(rest)
    } else {
        local_root(source, base).unwrap_or_else(|| base.join(source))
    };
    if !root.exists() {
        return Err("Pi 安装目录未找到；旧全局 npm/custom package-manager 路径须先由原生 CLI 迁移，当前条目只读".into());
    }
    Ok(root)
}

fn pi_manifest_resources(entry: &mut PluginEntry, manifest: Option<&Value>) -> Result<(), String> {
    let Some(root) = entry.root.as_ref().map(PathBuf::from) else {
        return Err("没有可核验的 Pi 包目录".into());
    };
    let Some(manifest) = manifest.and_then(|value| value.get("pi")) else {
        owned_resources(entry);
        return Ok(());
    };
    let canonical_root = root.canonicalize().map_err(|_| "Pi 包目录不可读取")?;
    for kind in ["extensions", "skills", "prompts", "themes"] {
        let Some(patterns) = manifest.get(kind) else {
            continue;
        };
        for pattern in patterns.as_array().ok_or("Pi manifest 资源字段不是数组")? {
            let pattern = pattern.as_str().ok_or("Pi manifest 资源路径不是字符串")?;
            if pattern.starts_with(['!', '+', '-']) {
                continue;
            } // filters do not introduce owned files
            if Path::new(pattern).is_absolute()
                || pattern.split(['/', '\\']).any(|part| part == "..")
                || pattern.contains(['{', '}', '(', ')'])
            {
                return Err("Pi manifest 含包外路径或未核验的 glob 语法，已限制管理".into());
            }
            let expression = format!(
                "{}/{}",
                glob::Pattern::escape(&root.to_string_lossy().replace('\\', "/")),
                pattern.replace('\\', "/")
            );
            for path in glob::glob(&expression)
                .map_err(|_| "Pi manifest glob 无法解析")?
                .take(20001)
            {
                let path = path.map_err(|_| "Pi manifest 资源不可读取")?;
                let canonical = path
                    .canonicalize()
                    .map_err(|_| "Pi manifest 资源不可读取")?;
                if !canonical.starts_with(&canonical_root) {
                    return Err("Pi manifest 资源链接到包外，已限制管理".into());
                }
                if entry.resources.len() >= 20000 {
                    return Err("Pi manifest 资源超过检查上限".into());
                }
                if !entry.resources.iter().any(|resource| {
                    resource.kind == kind && resource.path == path.display().to_string()
                }) {
                    entry.resources.push(PluginResource {
                        kind: kind.into(),
                        path: path.display().to_string(),
                        owner_id: entry.id.clone(),
                    });
                }
            }
        }
    }
    Ok(())
}

/// A native backup restores the document, not Cliora's recovery metadata.
/// Reconcile only an exact original declaration; arbitrary edits remain unknown.
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
    let field = if target.tool_id == "pi" {
        "packages"
    } else {
        "plugin"
    };
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
            if declared {
                target.tool_id != "pi" || item != pi_disabled(original, &source)
            } else {
                target.tool_id == "pi"
            }
        });
        let resolved = if target.tool_id == "pi" {
            pi_installed_root(&source, path.parent().ok_or("配置缺少父目录")?, home).map(Some)
        } else {
            Ok(local_root(&source, path.parent().ok_or("配置缺少父目录")?))
        };
        let resolution_error = resolved.as_ref().err().cloned();
        let root = resolved.unwrap_or(None);
        let manifest = root
            .as_ref()
            .map(|root| root.join("package.json"))
            .filter(|path| path.is_file())
            .and_then(|path| fs::read_to_string(path).ok())
            .and_then(|s| serde_json::from_str::<Value>(&s).ok());
        let mut entry = PluginEntry {
            id: source.clone(),
            name: manifest
                .as_ref()
                .and_then(|v| text(v, &["name"]))
                .unwrap_or_else(|| source.clone()),
            source,
            version: manifest.as_ref().and_then(|v| text(v, &["version"])),
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
            policy: if target.tool_id == "pi" && target.scope == Scope::Project {
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
        if target.tool_id == "pi" {
            if let Err(error) = pi_manifest_resources(&mut entry, manifest.as_ref()) {
                entry.read_only = true;
                entry.policy.push_str(&format!(" · {error}"));
            }
        } else {
            owned_resources(&mut entry);
        }
        result.push(entry);
    }
    if target.tool_id == "open_code" {
        let dir = if target.scope == Scope::Project {
            project(target)?
                .ok_or("请选择项目")?
                .join(".opencode/plugins")
        } else {
            path.parent().ok_or("配置缺少父目录")?.join("plugins")
        };
        if dir.is_dir() {
            for file in fs::read_dir(dir).map_err(|_| "无法读取自动发现插件目录")? {
                let file = file.map_err(|_| "读取插件失败")?;
                let path = file.path();
                if path.extension().is_some_and(|e| e == "ts" || e == "js") {
                    let source = path.display().to_string();
                    result.push(PluginEntry {
                        id: format!("auto:{source}"),
                        name: file.file_name().to_string_lossy().into(),
                        source: source.clone(),
                        version: None,
                        scope: "auto".into(),
                        enabled: Some(true),
                        state: "discovered_load_unknown".into(),
                        policy: "自动扫描文件，需在原生目录管理".into(),
                        read_only: true,
                        root: Some(source),
                        resources: vec![],
                    });
                }
            }
        }
    }
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
    exe: &Path,
) -> Result<PluginSnapshot, String> {
    let capability = adapters::plugins::capability(&target.tool_id)?;
    if target.scope == Scope::Project && !capability.project {
        return Err(capability.detail.into());
    }
    let mut entries = if matches!(target.tool_id.as_str(), "pi" | "open_code") {
        config_entries(db, home, target)?
    } else {
        let output = run(
            exe,
            home,
            target,
            &["plugin".into(), "list".into(), "--json".into()],
        )?;
        let value: Value = serde_json::from_str(&output).map_err(|_| "原生插件输出格式不兼容")?;
        parse_list(&target.tool_id, &value, target)?
    };
    let (path, _) = config(home, target)?;
    let mut basis = serde_json::to_string(&(target, &entries)).map_err(|_| "无法序列化插件")?;
    basis.push_str(&transaction::read_native(&path)?);
    let mut budget = (0, 0);
    for entry in &mut entries {
        if target.tool_id == "grok" {
            let value = format::parse(FileKind::Toml, &transaction::read_native(&path)?)?;
            let has = |field: &str| {
                value
                    .get("plugins")
                    .and_then(|p| p.get(field))
                    .and_then(Value::as_array)
                    .is_some_and(|items| items.iter().any(|item| item.as_str() == Some(&entry.id)))
            };
            entry.enabled = Some(has("enabled") && !has("disabled"));
        }
        if target.tool_id == "codex" && entry.root.is_none() {
            if let (Some((name, market)), Some(version)) =
                (entry.id.split_once('@'), entry.version.as_deref())
            {
                if [name, market, version]
                    .iter()
                    .all(|s| !s.is_empty() && !s.contains(['/', '\\']) && *s != "." && *s != "..")
                {
                    let root = path
                        .parent()
                        .ok_or("配置目录缺失")?
                        .join("plugins/cache")
                        .join(market)
                        .join(name)
                        .join(version);
                    if root.is_dir() {
                        entry.root = Some(root.display().to_string());
                    }
                }
            }
        }
        if entry.resources.is_empty() && target.tool_id != "pi" {
            owned_resources(entry);
        }
        if let Some(root) = &entry.root {
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
    let project = project(target)?;
    let _context =
        selection::enter_bound(db, home, &target.tool_id, target.scope, project.as_deref())?;
    selection::validate_expected(&target.tool_id, target.context_id.as_deref())?;
    let exe = executable(db, home, target)?;
    snapshot_inner(db, home, target, &exe)
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
    let changes = if target.tool_id == "codex" {
        vec![FieldChange {
            path: vec!["plugins".into(), request.source.clone(), "enabled".into()],
            value: Some(json!(request.action == "enable")),
        }]
    } else {
        let field = if target.tool_id == "pi" {
            "packages"
        } else {
            "plugin"
        };
        let mut items = parsed
            .get(field)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let index = items.iter().position(|item| {
            item.as_str() == Some(&request.source)
                || item.get("source").and_then(Value::as_str) == Some(&request.source)
        });
        match request.action.as_str() {
            "disable" => {
                let index = index.ok_or("插件声明已消失")?;
                if saved.contains_key(&request.source) {
                    return Err("此包已禁用，请重新扫描".into());
                }
                let original = items[index].clone();
                if target.tool_id == "pi" {
                    items[index] = pi_disabled(&original, &request.source);
                } else {
                    items.remove(index);
                }
                saved.insert(request.source.clone(), original);
            }
            "enable" => {
                let original = saved
                    .remove(&request.source)
                    .ok_or("没有可恢复的插件声明")?;
                if let Some(index) = index {
                    if target.tool_id != "pi"
                        || items[index] != pi_disabled(&original, &request.source)
                    {
                        return Err("相同来源已被外部修改；重新扫描后处理冲突".into());
                    }
                    items[index] = original;
                } else {
                    items.push(original);
                }
            }
            "install" => {
                if index.is_some() || saved.contains_key(&request.source) {
                    return Err("此来源已配置；请启用或先移除".into());
                }
                items.push(json!(request.source));
            }
            "uninstall" => {
                if let Some(index) = index {
                    items.remove(index);
                }
                saved.remove(&request.source);
            }
            _ => return Err("不支持的配置操作".into()),
        }
        vec![FieldChange {
            path: vec![field.into()],
            value: Some(json!(items)),
        }]
    };
    let key = disabled_key(target);
    let value = serde_json::to_string(&saved).map_err(|_| "无法保存禁用记录")?;
    if request.action == "uninstall"
        && changes.iter().all(|change| {
            change.path.len() == 1 && parsed.get(&change.path[0]) == change.value.as_ref()
        })
    {
        // Removing an already-disabled declaration only removes recovery metadata.
        // The native transaction deliberately refuses no-op file rewrites.
        db.with_connection(|conn| {
            let tx = conn.transaction().map_err(|_| "无法更新插件恢复记录")?;
            if transaction::read_native(&path)? != baseline { return Err("原生配置已变更，请重新扫描".into()); }
            tx.execute("INSERT INTO app_settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [&key, &value]).map_err(|_| "更新插件恢复记录失败")?;
            tx.commit().map_err(|_| "提交插件恢复记录失败".to_owned())
        })?;
        return Ok(String::new());
    }
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
            force_restrict: false,
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
    let exe = executable(db, home, target)?;
    let before = snapshot_inner(db, home, target, &exe)?;
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
    let config_only = target.tool_id == "open_code"
        || (matches!(target.tool_id.as_str(), "codex" | "pi")
            && matches!(request.action.as_str(), "enable" | "disable"))
        || (target.tool_id == "pi"
            && request.action == "uninstall"
            && entry.is_some_and(|entry| entry.enabled == Some(false)));
    if target.tool_id == "pi"
        && request.action == "update"
        && entry.is_some_and(|entry| entry.enabled == Some(false))
    {
        return Err("先恢复包声明再执行原生更新".into());
    }
    let result = if config_only {
        mutate_config(db, credentials, home, request).map(Some)
    } else {
        let source = if target.tool_id == "pi" && request.action != "install" {
            let (path, _) = config(home, target)?;
            local_root(&request.source, path.parent().ok_or("配置目录缺失")?)
                .map(|path| path.display().to_string())
                .unwrap_or_else(|| request.source.clone())
        } else {
            request.source.clone()
        };
        let args = adapters::plugins::command_args(
            &target.tool_id,
            &request.action,
            &source,
            target.scope == Scope::Project,
        )?;
        run(&exe, home, target, &args).map(|_| None)
    };
    let snapshot = snapshot_inner(db, home, target, &exe);
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
