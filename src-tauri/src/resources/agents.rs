use super::plugins::{self, PluginTarget};
use crate::adapters::{agents as contract, Registry};
use crate::{
    accounts::selection,
    credentials::CredentialStore,
    database::Database,
    native::{
        adapter::Scope,
        format::{self, FileKind},
        transaction::{self, FileMutation},
    },
};
use serde::{Deserialize, Serialize};
#[cfg(test)]
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

static OPERATIONS: Mutex<()> = Mutex::new(());
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    pub path: String,
    pub format: String,
    pub content: String,
    pub enabled: bool,
    pub read_only: bool,
    pub builtin: bool,
    pub owner: String,
    pub detail: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSnapshot {
    pub target: PluginTarget,
    pub capability: contract::AgentCapability,
    pub entries: Vec<AgentEntry>,
    pub baseline: String,
    pub detail: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRequest {
    pub target: PluginTarget,
    pub action: String,
    pub id: Option<String>,
    pub name: String,
    pub content: String,
    pub baseline: String,
    pub transaction_id: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentResult {
    pub transaction_id: String,
    pub changed_paths: Vec<String>,
    pub restore_path: String,
    pub snapshot: AgentSnapshot,
    pub detail: String,
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
fn safe_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("定义路径必须是规范绝对路径".into());
    }
    for item in path.ancestors() {
        if let Ok(meta) = fs::symlink_metadata(item) {
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if meta.file_attributes() & 0x400 != 0 {
                    return Err("重解析点只读，需在原生 CLI 管理".into());
                }
            }
            if meta.file_type().is_symlink() {
                return Err("链接定义只读，需在原生 CLI 管理".into());
            }
        }
    }
    Ok(())
}
fn walk(
    path: &Path,
    extension: &str,
    result: &mut Vec<PathBuf>,
    depth: usize,
    recursive: bool,
) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    safe_path(path)?;
    if path.is_file() {
        if path.extension().is_some_and(|e| e == extension) {
            result.push(path.into());
        }
        return Ok(());
    }
    if depth > 12 || result.len() > 512 {
        return Err("agent 目录超出扫描预算".into());
    }
    let mut items = fs::read_dir(path)
        .map_err(|_| "无法读取 agent 目录")?
        .map(|e| {
            e.map(|e| e.path())
                .map_err(|_| "无法读取 agent 文件".to_owned())
        })
        .collect::<Result<Vec<_>, _>>()?;
    items.sort();
    for item in items {
        if recursive || !item.is_dir() {
            walk(&item, extension, result, depth + 1, recursive)?;
        }
    }
    Ok(())
}
pub(crate) fn read(path: &Path) -> Result<String, String> {
    safe_path(path)?;
    if fs::metadata(path).map_err(|_| "无法读取 agent 文件")?.len() > 256 * 1024 {
        return Err("agent 文件超过 256 KiB".into());
    }
    transaction::read_native(path)
}
pub(crate) fn entry(
    tool: &str,
    path: &Path,
    format: &str,
    content: String,
    fallback: &str,
    enabled: bool,
    owner: &str,
) -> AgentEntry {
    let parsed = contract::validate(tool, format, &content, fallback);
    let (name, description, mut detail) = match parsed {
        Ok((n, d)) => (n, d, String::new()),
        Err(e) => (fallback.into(), String::new(), e),
    };
    let native_disabled = contract::get(tool).is_ok_and(|a| a.native_disabled(format, &content));
    if native_disabled {
        detail.push_str(
            contract::get(tool)
                .map(|a| a.disabled_detail())
                .unwrap_or("原生定义已停用。"),
        );
    }
    AgentEntry {
        id: path.display().to_string(),
        name,
        description,
        path: path.display().to_string(),
        format: format.into(),
        content,
        enabled: enabled && !native_disabled,
        read_only: owner != "独立定义",
        builtin: false,
        owner: owner.into(),
        detail,
    }
}

fn config_files(home: &Path, target: &PluginTarget) -> Result<Vec<PathBuf>, String> {
    let project = project(target)?;
    let adapter = Registry::builtins();
    let adapter = adapter.get(&target.tool_id).ok_or("未知 CLI")?;
    let paths: Vec<PathBuf> = adapter
        .native_files(target.scope, home, project.as_deref(), true)
        .into_iter()
        .filter(|f| f.role == "settings" && !f.sensitive)
        .map(|f| f.path.into())
        .collect();
    contract::get(&target.tool_id)?.config_paths(home, target, paths)
}
fn snapshot_inner(
    home: &Path,
    target: &PluginTarget,
    plugins: &[plugins::PluginEntry],
) -> Result<AgentSnapshot, String> {
    let capability = contract::capability(&target.tool_id)?;
    if !capability.supported {
        return Ok(AgentSnapshot {
            target: target.clone(),
            capability,
            entries: vec![],
            baseline: String::new(),
            detail: "规则与扩展可在各自入口管理。".into(),
        });
    }
    let root = contract::root(
        &target.tool_id,
        target.scope,
        home,
        project(target)?.as_deref(),
    )?;
    let adapter = contract::get(&target.tool_id)?;
    let extension = adapter.extension();
    let mut entries = Vec::new();
    let mut basis = serde_json::to_string(target).map_err(|_| "目标无效")?;
    for name in adapter.definition_dirs() {
        for (dir, enabled) in [
            (root.join(name), true),
            (root.join(".cliora-disabled-agents").join(name), false),
        ] {
            scan_directory(
                &target.tool_id,
                &dir,
                extension,
                enabled,
                "独立定义",
                &mut entries,
            )?;
        }
    }
    for path in config_files(home, target)? {
        if !path.exists() {
            continue;
        }
        let text = read(&path)?;
        basis.push_str(&text);
        let value = format::parse(FileKind::for_name(&path.display().to_string())?, &text)?;
        adapter.config_entries(target, &root, &path, &value, &mut entries)?;
    }

    adapter.additional_sources(home, target, &root, &mut entries)?;
    for plugin in plugins {
        for resource in &plugin.resources {
            if resource.kind != "agents" {
                continue;
            }
            let dir = Path::new(&resource.path);
            // Native package roots may be links, but their files are never writable here.
            let dir = dir.canonicalize().unwrap_or_else(|_| dir.into());
            let mut owned = Vec::new();
            scan_directory(
                &target.tool_id,
                &dir,
                extension,
                plugin.enabled != Some(false),
                &format!("插件：{}", plugin.id),
                &mut owned,
            )?;
            for entry in &mut owned {
                entry.name = contract::plugin_identity(
                    &target.tool_id,
                    &plugin.id,
                    &dir,
                    Path::new(&entry.path),
                    &entry.name,
                );
            }
            entries.extend(owned);
        }
    }

    let names: Vec<_> = entries
        .iter()
        .filter(|e| e.enabled)
        .map(|e| e.name.clone())
        .collect();
    for e in &mut entries {
        if e.enabled && names.iter().filter(|n| **n == e.name).count() > 1 {
            e.read_only = true;
            e.detail
                .push_str(" · 同名定义存在多个来源；原生优先级/合并可能生效，请在原生配置解决冲突");
        }
    }
    for builtin in adapter.builtin_definitions() {
        let overridden = entries.iter().any(|entry| entry.name == builtin.name && entry.enabled);
        entries.push(AgentEntry {
            id: format!("builtin://{}/{}", target.tool_id, builtin.name),
            name: builtin.name.into(), description: builtin.description.into(),
            path: String::new(), format: "markdown".into(), content: String::new(),
            enabled: !overridden, read_only: true, builtin: true, owner: "CLI 内置".into(),
            detail: format!("参考核验版本 {} 的内置目录；模型继承当前会话。完整提示词与加载状态由原生 CLI 管理。{}", capability.version, if overridden { "当前作用域存在同名定义，可能覆盖此内置项。" } else { "" }),
        });
    }
    basis.push_str(&serde_json::to_string(&entries).map_err(|_| "无法序列化定义")?);
    Ok(AgentSnapshot { target:target.clone(),capability,entries,baseline:transaction::fingerprint(basis.as_bytes()),detail:"此页显示所选作用域的定义；启停只影响这一来源，其他作用域或内置同名项可能生效。已配置不表示当前会话已加载。导入不会转换 CLI 格式。".into() })
}
pub(crate) fn scan_directory(
    tool: &str,
    dir: &Path,
    extension: &str,
    enabled: bool,
    owner: &str,
    entries: &mut Vec<AgentEntry>,
) -> Result<(), String> {
    let mut files = Vec::new();
    walk(
        dir,
        extension,
        &mut files,
        0,
        contract::get(tool)?.recursive(),
    )?;
    for path in files {
        let fallback = if contract::get(tool)?.namespaced_names() {
            path.strip_prefix(dir)
                .unwrap_or(&path)
                .with_extension("")
                .to_string_lossy()
                .replace('\\', "/")
        } else {
            path.file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        };
        entries.push(entry(
            tool,
            &path,
            if extension == "toml" {
                "toml"
            } else {
                "markdown"
            },
            read(&path)?,
            &fallback,
            enabled,
            owner,
        ));
    }
    Ok(())
}
pub fn scan(db: &Database, home: &Path, target: &PluginTarget) -> Result<AgentSnapshot, String> {
    let _context = selection::enter_bound(
        db,
        home,
        &target.tool_id,
        target.scope,
        project(target)?.as_deref(),
    )?;
    selection::validate_expected(&target.tool_id, target.context_id.as_deref())?;
    if !contract::capability(&target.tool_id)?.supported {
        return snapshot_inner(home, target, &[]);
    }
    // Do not lose package ownership when native discovery fails.
    let plugins = plugins::scan_resources(db, home, target)?;
    snapshot_inner(home, target, &plugins.entries)
}
pub fn operate(
    db: &Database,
    credentials: &dyn CredentialStore,
    home: &Path,
    request: &AgentRequest,
) -> Result<AgentResult, String> {
    let _lock = OPERATIONS.lock().map_err(|_| "agent 服务不可用")?;
    let target = &request.target;
    let _context = selection::enter_bound(
        db,
        home,
        &target.tool_id,
        target.scope,
        project(target)?.as_deref(),
    )?;
    selection::validate_expected(&target.tool_id, target.context_id.as_deref())?;
    let plugins = plugins::scan_resources(db, home, target)?;
    operate_inner(db, credentials, home, request, &plugins.entries)
}
fn operate_inner(
    db: &Database,
    credentials: &dyn CredentialStore,
    home: &Path,
    request: &AgentRequest,
    plugins: &[plugins::PluginEntry],
) -> Result<AgentResult, String> {
    let target = &request.target;
    let before = snapshot_inner(home, target, plugins)?;
    if !before.capability.supported {
        return Err(before.capability.detail.into());
    }
    if before.baseline != request.baseline {
        return Err("定义、作用域或插件已被外部修改，请重新扫描；草稿仍保留".into());
    }
    let root = contract::root(
        &target.tool_id,
        target.scope,
        home,
        project(target)?.as_deref(),
    )?;
    let adapter = contract::get(&target.tool_id)?;
    let selected = request
        .id
        .as_ref()
        .and_then(|id| before.entries.iter().find(|e| e.id == *id));
    let mut changes = Vec::new();
    let outcome;
    let restore_path;
    if request.action == "restore" {
        let path = PathBuf::from(request.id.as_deref().ok_or("缺少恢复路径")?);
        let allowed = |p: &Path| {
            adapter
                .definition_dirs()
                .iter()
                .any(|directory| p.starts_with(root.join(directory)))
                || p.starts_with(root.join(".cliora-disabled-agents"))
                || config_files(home, target).is_ok_and(|files| files.contains(&p.to_path_buf()))
        };
        if !allowed(&path) {
            return Err("恢复路径不属于当前定义目标".into());
        }
        safe_path(&path)?;
        let id = request.transaction_id.as_deref().ok_or("缺少恢复记录")?;
        let preview = transaction::preview_backup(db, credentials, &path, id)?;
        // Only this manager's definition roots/config paths may be restored.
        for p in &preview.affected_paths {
            if !allowed(Path::new(p)) {
                return Err("恢复记录包含其他目标".into());
            }
            safe_path(Path::new(p))?;
        }
        if before.entries.iter().any(|entry| {
            entry.read_only
                && preview
                    .affected_paths
                    .iter()
                    .any(|p| Path::new(p) == Path::new(&entry.path))
        }) {
            return Err("恢复目标已由插件、组织或其他原生定义管理，请先解决归属冲突".into());
        }
        if let Ok((name, _)) = contract::validate(
            &target.tool_id,
            before.capability.format,
            &preview.original,
            path.file_stem().unwrap_or_default().to_str().unwrap_or(""),
        ) {
            if before.entries.iter().any(|entry| {
                !entry.builtin && entry.name == name
                    && !preview
                        .affected_paths
                        .iter()
                        .any(|p| Path::new(p) == Path::new(&entry.path))
            }) {
                return Err("恢复会产生同名定义冲突；未恢复任何文件".into());
            }
        }
        outcome = transaction::restore_backup_if_unchanged(
            db,
            credentials,
            &path,
            id,
            &preview.current,
            |_| Ok(()),
        )?;
        restore_path = path.display().to_string();
    } else {
        let path;
        if request.action == "create" {
            if !contract::valid_name(&request.name) {
                return Err("文件名只能包含字母、数字、连字符和下划线".into());
            }
            let extension = adapter.extension();
            path = root
                .join(
                    adapter
                        .definition_dirs()
                        .first()
                        .ok_or("此 CLI 未提供可写定义目录")?,
                )
                .join(format!("{}.{extension}", request.name));
            if path.exists() {
                return Err("同名文件已存在".into());
            }
            let (name, _) = contract::validate(
                &target.tool_id,
                before.capability.format,
                &request.content,
                &request.name,
            )?;
            if before.entries.iter().any(|e| !e.builtin && e.name == name) {
                return Err("同名定义已存在（包含禁用或插件定义）".into());
            }
            changes.push(FileMutation {
                path: path.clone(),
                baseline: None,
                contents: Some(request.content.clone()),
            });
        } else {
            let entry = selected.ok_or("目标定义不存在，请重新扫描")?;
            if entry.read_only {
                return Err("此定义由插件、组织或原生配置管理，不可独立修改".into());
            }
            path = PathBuf::from(&entry.path);
            if entry.format == "json" {
                let old = read(&path)?;
                let output = adapter.config_edit(entry, request)?;
                changes.push(FileMutation {
                    path: path.clone(),
                    baseline: Some(old),
                    contents: Some(output),
                });
            } else {
                match request.action.as_str() {
                    "save" => {
                        let (name, _) = contract::validate(
                            &target.tool_id,
                            &entry.format,
                            &request.content,
                            &entry.name,
                        )?;
                        if before
                            .entries
                            .iter()
                            .any(|e| !e.builtin && e.id != entry.id && e.name == name)
                        {
                            return Err("同名定义已存在".into());
                        }
                        changes.push(FileMutation {
                            path: path.clone(),
                            baseline: Some(entry.content.clone()),
                            contents: Some(request.content.clone()),
                        });
                    }
                    "delete" => changes.push(FileMutation {
                        path: path.clone(),
                        baseline: Some(entry.content.clone()),
                        contents: None,
                    }),
                    "enable" | "disable" => {
                        let enabled = request.action == "enable";
                        if enabled {
                            contract::validate(
                                &target.tool_id,
                                &entry.format,
                                &entry.content,
                                &entry.name,
                            )?;
                        }
                        if entry.enabled == enabled {
                            return Err("状态未改变".into());
                        }
                        if enabled
                            && adapter.native_disabled(&entry.format, &entry.content)
                            && !path.starts_with(root.join(".cliora-disabled-agents"))
                        {
                            changes.push(FileMutation {
                                path: path.clone(),
                                baseline: Some(entry.content.clone()),
                                contents: Some(adapter.enable_content(&entry.content)?),
                            });
                        } else {
                            let relative = if enabled {
                                path.strip_prefix(root.join(".cliora-disabled-agents"))
                                    .map_err(|_| "禁用文件位置无效")?
                            } else {
                                path.strip_prefix(&root).map_err(|_| "定义不在目标目录")?
                            };
                            let dest = if enabled {
                                root.join(relative)
                            } else {
                                root.join(".cliora-disabled-agents").join(relative)
                            };
                            if dest.exists()
                                || before
                                    .entries
                                    .iter()
                                    .any(|e| !e.builtin && e.id != entry.id && e.name == entry.name && e.enabled)
                            {
                                return Err("启停目标已存在或同名定义冲突".into());
                            }
                            changes.push(FileMutation {
                                path: path.clone(),
                                baseline: Some(entry.content.clone()),
                                contents: None,
                            });
                            changes.push(FileMutation {
                                path: dest,
                                baseline: None,
                                contents: Some(
                                    if enabled
                                        && adapter.native_disabled(&entry.format, &entry.content)
                                    {
                                        adapter.enable_content(&entry.content)?
                                    } else {
                                        entry.content.clone()
                                    },
                                ),
                            });
                        }
                    }
                    _ => return Err("未知 agent 操作".into()),
                }
            }
        }
        restore_path = path.display().to_string();
        outcome = transaction::apply_files(db, credentials, &changes, |_| Ok(()))?;
    }
    let snapshot = snapshot_inner(home, target, plugins).map_err(|error| {
        format!(
            "原生定义已写入（事务 {}），重新扫描失败：{error}；请重新扫描",
            outcome.transaction_id
        )
    })?;
    Ok(AgentResult {transaction_id:outcome.transaction_id,changed_paths:outcome.changed_files,restore_path,snapshot,detail:"已修改原生定义。请按能力说明重新加载；现有会话状态未验证。删除和启停可恢复整个操作，任一文件外改将阻止恢复。".into()})
}

#[cfg(test)]
#[path = "../../../tests/resources/agents.rs"]
mod tests;
