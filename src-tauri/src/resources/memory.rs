//! Shared memory operations.
//!
//! The registry memory port resolves the storage directory and declares the
//! scope, target dimensions, and verified operations. This service lists and
//! writes plain text in that resolved directory. It does not match CLI ids,
//! and the native transaction callback does not insert library, account, or
//! portable rows.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::accounts::selection;
use crate::adapters::memory::{
    MemoryDeclaration, MemoryManagement, MemoryOperation, MemoryTargetDimension,
};
use crate::adapters::{CliAdapter, Registry};
use crate::credentials::CredentialStore;
use crate::database::Database;
use crate::native::adapter::Scope;
use crate::native::transaction::{self, FileMutation, TextPatch};
use crate::projects;

const MAX_BYTES: usize = 1024 * 1024;
const SWITCH_FILE: &str = ".cliora-memory-switch";
const ITEMS_FILE: &str = ".cliora-memory-items.json";
const NOT_IN_USE: &str = "记忆当前未使用";
const EXCLUDED: &str =
    "该路径属于已声明的规则、提示词、MCP、Skill、Agent、会话历史、认证或原生配置，不能当作记忆";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryTarget {
    pub tool_id: String,
    pub scope: Scope,
    pub project_path: Option<String>,
    #[serde(default)]
    pub context_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySave {
    pub target: MemoryTarget,
    pub id: String,
    pub text: String,
    pub baseline: String,
    #[serde(default)]
    pub confirm_external: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDelete {
    pub target: MemoryTarget,
    pub id: String,
    pub baseline: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEnable {
    pub target: MemoryTarget,
    pub id: Option<String>,
    pub enabled: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    pub id: String,
    pub path: String,
    pub enabled: bool,
    pub fingerprint: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryList {
    pub in_use: bool,
    pub detail: String,
    pub operations: Vec<MemoryOperation>,
    pub limitation: String,
    pub entries: Vec<MemoryEntry>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDocument {
    pub id: String,
    pub path: String,
    pub text: String,
    pub fingerprint: String,
    pub enabled: bool,
    pub in_use: bool,
    pub detail: String,
}

enum Partition {
    Shared,
    Bound(String),
    Unbound,
}

struct Prepared {
    directory: PathBuf,
    excluded: Vec<PathBuf>,
    management: MemoryManagement,
    _guard: Option<selection::ContextGuard>,
}

/// Native transaction commit. Memory stays out of library, account, and portable rows.
fn commit_without_records(_: &rusqlite::Transaction<'_>) -> Result<(), String> {
    Ok(())
}

pub fn list_memories(
    db: &Database,
    registry: &Registry,
    home: &Path,
    target: &MemoryTarget,
) -> Result<MemoryList, String> {
    let prepared = prepare(db, registry, home, target)?;
    require(&prepared, MemoryOperation::List)?;
    finish_list(&prepared)
}

pub fn read_memory(
    db: &Database,
    registry: &Registry,
    home: &Path,
    target: &MemoryTarget,
    id: &str,
) -> Result<MemoryDocument, String> {
    let prepared = prepare(db, registry, home, target)?;
    require(&prepared, MemoryOperation::Open)?;
    let path = entry_path(&prepared, id)?;
    if !path.is_file() {
        return Err("记忆不存在".into());
    }
    let bytes = read_entry_bytes(&path)?;
    let text = String::from_utf8(bytes.clone())
        .map_err(|_| "无法读取记忆，请重试：正文不是 UTF-8".to_owned())?;
    document(&prepared, id, &path, text, &bytes)
}

pub fn save_memory(
    db: &Database,
    credentials: &dyn CredentialStore,
    registry: &Registry,
    home: &Path,
    request: &MemorySave,
) -> Result<MemoryDocument, String> {
    if request.text.len() > MAX_BYTES {
        return Err("记忆内容超过 1 MiB，请缩小后重试".into());
    }
    let prepared = prepare(db, registry, home, &request.target)?;
    let path = entry_path(&prepared, &request.id)?;
    if is_symlink(&path)? {
        return Err(format!("不跟随符号链接：{}", path.display()));
    }
    if path.exists() && !path.is_file() {
        return Err(format!("无法保存记忆，请重试：{}", path.display()));
    }
    let exists = path.is_file();
    require(
        &prepared,
        if exists {
            MemoryOperation::Edit
        } else {
            MemoryOperation::Create
        },
    )?;
    let current = transaction::read_native(&path)
        .map_err(|error| format!("无法读取记忆，请重试：{error}"))?;
    let baseline = if current != request.baseline {
        if !request.confirm_external {
            return Err("记忆已被外部修改，确认后才会写入，请重试".into());
        }
        current
    } else {
        request.baseline.clone()
    };
    transaction::apply_text(
        db,
        credentials,
        &[TextPatch {
            path: path.clone(),
            baseline,
            contents: request.text.clone(),
            sensitive: false,
        }],
        commit_without_records,
    )
    .map_err(|error| format!("无法保存记忆，请重试：{error}"))?;
    let bytes = read_entry_bytes(&path)?;
    let text = String::from_utf8(bytes.clone())
        .map_err(|_| "无法读取记忆，请重试：正文不是 UTF-8".to_owned())?;
    document(&prepared, &request.id, &path, text, &bytes)
}

pub fn delete_memory(
    db: &Database,
    credentials: &dyn CredentialStore,
    registry: &Registry,
    home: &Path,
    request: &MemoryDelete,
) -> Result<(), String> {
    let prepared = prepare(db, registry, home, &request.target)?;
    require(&prepared, MemoryOperation::Delete)?;
    let path = entry_path(&prepared, &request.id)?;
    if !path.is_file() {
        return Err("记忆不存在".into());
    }
    let current = transaction::read_native(&path)
        .map_err(|error| format!("无法读取记忆，请重试：{error}"))?;
    if current != request.baseline {
        return Err("记忆已被外部修改，请重新打开后重试".into());
    }
    let mut changes = vec![FileMutation {
        path: path.clone(),
        baseline: Some(current),
        contents: None,
    }];
    let items_path = prepared.directory.join(ITEMS_FILE);
    let items_current = transaction::read_native(&items_path)
        .map_err(|error| format!("无法读取记忆启停记录，请重试：{error}"))?;
    if let Some(contents) = removed_item(&items_current, &request.id)? {
        reject_excluded(&items_path, &prepared.excluded)?;
        changes.push(FileMutation {
            path: items_path,
            baseline: Some(items_current),
            contents: Some(contents),
        });
    }
    transaction::apply_files(db, credentials, &changes, commit_without_records)
        .map(|_| ())
        .map_err(|error| format!("无法删除记忆，请重试：{error}"))
}

pub fn set_memory_enabled(
    db: &Database,
    credentials: &dyn CredentialStore,
    registry: &Registry,
    home: &Path,
    request: &MemoryEnable,
) -> Result<MemoryList, String> {
    let prepared = prepare(db, registry, home, &request.target)?;
    match request
        .id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        None => {
            require(&prepared, MemoryOperation::MasterSwitch)?;
            let path = prepared.directory.join(SWITCH_FILE);
            reject_excluded(&path, &prepared.excluded)?;
            let current = transaction::read_native(&path)
                .map_err(|error| format!("无法读取记忆总开关，请重试：{error}"))?;
            let contents = if request.enabled { "on\n" } else { "off\n" };
            if current != contents {
                transaction::apply_text(
                    db,
                    credentials,
                    &[TextPatch {
                        path,
                        baseline: current,
                        contents: contents.to_owned(),
                        sensitive: false,
                    }],
                    commit_without_records,
                )
                .map_err(|error| format!("无法保存记忆总开关，请重试：{error}"))?;
            }
        }
        Some(id) => {
            require(&prepared, MemoryOperation::ItemEnable)?;
            let entry = entry_path(&prepared, id)?;
            if !entry.is_file() {
                return Err("记忆不存在".into());
            }
            let path = prepared.directory.join(ITEMS_FILE);
            reject_excluded(&path, &prepared.excluded)?;
            let current = transaction::read_native(&path)
                .map_err(|error| format!("无法读取记忆启停记录，请重试：{error}"))?;
            let mut map = parse_items(&current)?;
            map.insert(id.to_owned(), request.enabled);
            let contents =
                serde_json::to_string(&map).map_err(|_| "无法保存记忆启停，请重试".to_owned())?;
            if current != contents {
                transaction::apply_text(
                    db,
                    credentials,
                    &[TextPatch {
                        path,
                        baseline: current,
                        contents,
                        sensitive: false,
                    }],
                    commit_without_records,
                )
                .map_err(|error| format!("无法保存记忆启停，请重试：{error}"))?;
            }
        }
    }
    finish_list(&prepared)
}

fn finish_list(prepared: &Prepared) -> Result<MemoryList, String> {
    let (in_use, detail) = usage(&prepared.directory)?;
    let entries = list_entries(prepared)?;
    Ok(MemoryList {
        in_use,
        detail,
        operations: prepared.management.operations.clone(),
        limitation: prepared.management.limitation.to_owned(),
        entries,
    })
}

fn document(
    prepared: &Prepared,
    id: &str,
    path: &Path,
    text: String,
    bytes: &[u8],
) -> Result<MemoryDocument, String> {
    let (in_use, detail) = usage(&prepared.directory)?;
    let enabled = entry_enabled(&enabled_map(&prepared.directory)?, id);
    Ok(MemoryDocument {
        id: id.to_owned(),
        path: path.display().to_string(),
        text,
        fingerprint: transaction::fingerprint(bytes),
        enabled,
        in_use,
        detail,
    })
}

fn prepare(
    db: &Database,
    registry: &Registry,
    home: &Path,
    target: &MemoryTarget,
) -> Result<Prepared, String> {
    if !home.is_absolute() {
        return Err("用户目录必须是绝对路径".into());
    }
    let adapter = registry
        .get(&target.tool_id)
        .ok_or("此 CLI 尚无注册适配器")?;
    let port = adapter.memory().ok_or("此 CLI 没有已核实的记忆")?;
    let declaration = port.declaration();
    let management =
        crate::adapters::memory::publish(&declaration).ok_or("此 CLI 的记忆尚未核实")?;
    let (scope, project) = checked_scope(&declaration, target)?;
    let (partition, guard) = partition(db, target, &declaration)?;
    let mut directory = port
        .directory(scope, home, project.as_deref())
        .map_err(unavailable_directory)?;
    match &partition {
        Partition::Shared => {}
        Partition::Bound(id) => directory.push(id),
        Partition::Unbound => directory.push("_unbound"),
    }
    if !directory.is_absolute()
        || directory
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("记忆路径无效".into());
    }
    // Same unresolved ancestor walk as apply_files. Do not follow a symlink or
    // Windows junction before the exclusion check or a directory listing.
    reject_reparse_ancestors(&directory)?;
    let excluded = excluded_paths(
        adapter,
        home,
        scope,
        project.as_deref(),
        &target.tool_id,
        !matches!(partition, Partition::Shared),
    )?;
    Ok(Prepared {
        directory,
        excluded,
        management,
        _guard: guard,
    })
}

fn unavailable_directory(reason: String) -> String {
    let trimmed = reason.trim();
    if trimmed.is_empty() {
        "此 CLI 的记忆目录不可用".to_owned()
    } else {
        trimmed.to_owned()
    }
}

fn partition(
    db: &Database,
    target: &MemoryTarget,
    declaration: &MemoryDeclaration,
) -> Result<(Partition, Option<selection::ContextGuard>), String> {
    let participates = declaration.binds_account
        || declaration
            .targets
            .contains(&MemoryTargetDimension::Account);
    if !participates {
        return Ok((Partition::Shared, None));
    }
    let requested = target
        .context_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    let Some(id) = requested else {
        // An omitted account is the caller's unbound target. The applied
        // config account is a separate choice and does not select this partition.
        return Ok((Partition::Unbound, None));
    };
    let context = selection::by_id(db, &target.tool_id, id)?;
    if !valid_segment(&context.id) {
        return Err("账号上下文标识无效".into());
    }
    let partition = Partition::Bound(context.id.clone());
    let guard = selection::enter(Some(context));
    Ok((partition, Some(guard)))
}

fn checked_scope(
    declaration: &MemoryDeclaration,
    target: &MemoryTarget,
) -> Result<(Scope, Option<PathBuf>), String> {
    match target.scope {
        Scope::Global if declaration.scope.global => Ok((Scope::Global, None)),
        Scope::Project if declaration.scope.project => {
            let project = projects::checked_directory(
                target.project_path.as_deref().ok_or("请选择项目目录")?,
            )?;
            Ok((Scope::Project, Some(project)))
        }
        _ => Err("此 CLI 的记忆不覆盖当前范围".into()),
    }
}

fn excluded_paths(
    adapter: &dyn CliAdapter,
    home: &Path,
    scope: Scope,
    project: Option<&Path>,
    tool_id: &str,
    account_participates: bool,
) -> Result<Vec<PathBuf>, String> {
    let mut paths = Vec::new();
    if let Some(path) = adapter.rule_path(scope, home, project) {
        paths.push(path);
    }
    if adapter.uses_rule_catalog(scope) {
        let specs = adapter
            .rule_file_specs(scope, home, project)
            .map_err(|error| format!("无法确认规则路径，请重试：{error}"))?;
        paths.extend(specs.into_iter().map(|spec| spec.path));
    }
    if let Some(root) = adapter.skill_root(scope, home, project) {
        paths.push(root);
    }
    for observation in adapter.skill_observations(scope, home, project) {
        paths.push(observation.root);
    }
    if let Some(location) = adapter.skill_switch_location(scope, home, project, "") {
        paths.push(location.path);
    }
    if let Some(location) = adapter.mcp_location(scope, home, project) {
        paths.push(location.path);
    }
    if let Some(agents) = adapter.agents() {
        paths.push(
            agents
                .root(scope, home, project)
                .map_err(|error| format!("无法确认 Agent 定义路径，请重试：{error}"))?,
        );
    }
    paths.extend(
        adapter
            .history_sources(home)
            .map_err(|error| format!("无法确认会话历史路径，请重试：{error}"))?
            .into_iter()
            .map(|source| source.path),
    );
    if let Some(plugins) = adapter.plugins() {
        let plugin_target = crate::resources::plugins::PluginTarget {
            tool_id: tool_id.to_owned(),
            scope,
            project_path: project.map(|path| path.display().to_string()),
            context_id: None,
        };
        paths.extend(plugins.snapshot_files(home, &plugin_target));
    }
    for file_scope in [Scope::Global, Scope::Project] {
        if file_scope == Scope::Project && project.is_none() {
            continue;
        }
        for file in adapter.native_files(file_scope, home, project, true) {
            if !file.path.is_empty() {
                paths.push(PathBuf::from(file.path));
            }
        }
    }
    if account_participates {
        if let Some(context) = selection::current(tool_id) {
            paths.extend(context.auth_files);
            paths.push(context.config_root);
            paths.extend(context.history_roots);
            paths.push(context.resource_root);
        }
    }
    Ok(paths)
}

fn require(prepared: &Prepared, operation: MemoryOperation) -> Result<(), String> {
    if prepared.management.operations.contains(&operation) {
        return Ok(());
    }
    let limitation = prepared.management.limitation.trim();
    if limitation.is_empty() {
        Err("此记忆存储不支持该操作".into())
    } else {
        Err(limitation.to_owned())
    }
}

fn entry_path(prepared: &Prepared, id: &str) -> Result<PathBuf, String> {
    if !valid_segment(id) {
        return Err("记忆标识无效，请修改后重试".into());
    }
    let path = prepared.directory.join(format!("{id}.md"));
    reject_excluded(&path, &prepared.excluded)?;
    Ok(path)
}

fn valid_segment(value: &str) -> bool {
    !value.is_empty()
        && value != "_unbound"
        && value.len() <= 80
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn reject_excluded(path: &Path, excluded: &[PathBuf]) -> Result<(), String> {
    if excluded.iter().any(|item| overlaps(path, item)) {
        Err(EXCLUDED.into())
    } else {
        Ok(())
    }
}

fn reject_reparse_ancestors(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        if let Ok(metadata) = fs::symlink_metadata(ancestor) {
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if metadata.file_attributes() & 0x400 != 0 {
                    return Err("不修改重解析点中的文件".into());
                }
            }
            if metadata.file_type().is_symlink()
                && !crate::path_policy::is_platform_directory_alias(ancestor)
            {
                return Err("不修改符号链接中的文件".into());
            }
        }
    }
    Ok(())
}

fn overlaps(path: &Path, excluded: &Path) -> bool {
    path == excluded || path.starts_with(excluded) || excluded.starts_with(path)
}

fn list_entries(prepared: &Prepared) -> Result<Vec<MemoryEntry>, String> {
    let map = enabled_map(&prepared.directory)?;
    let mut entries = Vec::new();
    let read = match fs::read_dir(&prepared.directory) {
        Ok(read) => read,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(entries),
        Err(_) => return Err("无法列出记忆，请重试".into()),
    };
    for item in read {
        let item = item.map_err(|_| "无法列出记忆，请重试".to_owned())?;
        let file_type = item
            .file_type()
            .map_err(|_| "无法列出记忆，请重试".to_owned())?;
        if !file_type.is_file() {
            continue;
        }
        let name = item.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name == SWITCH_FILE || name == ITEMS_FILE || !name.ends_with(".md") {
            continue;
        }
        let id = name.trim_end_matches(".md");
        if !valid_segment(id) || overlaps_path(&item.path(), &prepared.excluded) {
            continue;
        }
        let bytes = read_entry_bytes(&item.path())?;
        entries.push(MemoryEntry {
            id: id.to_owned(),
            path: item.path().display().to_string(),
            enabled: entry_enabled(&map, id),
            fingerprint: transaction::fingerprint(&bytes),
        });
    }
    entries.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(entries)
}

fn overlaps_path(path: &Path, excluded: &[PathBuf]) -> bool {
    excluded.iter().any(|item| overlaps(path, item))
}

fn read_entry_bytes(path: &Path) -> Result<Vec<u8>, String> {
    if is_symlink(path)? {
        return Err(format!("不跟随符号链接：{}", path.display()));
    }
    let metadata =
        fs::metadata(path).map_err(|_| format!("无法读取记忆，请重试：{}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("无法读取记忆，请重试：{}", path.display()));
    }
    fs::read(path).map_err(|_| format!("无法读取记忆，请重试：{}", path.display()))
}

fn is_symlink(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(metadata.file_type().is_symlink()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(format!("无法读取记忆，请重试：{}", path.display())),
    }
}

fn usage(directory: &Path) -> Result<(bool, String), String> {
    let text = transaction::read_native(&directory.join(SWITCH_FILE))
        .map_err(|error| format!("无法读取记忆总开关，请重试：{error}"))?;
    match text.trim() {
        "" | "on" | "1" => Ok((true, String::new())),
        "off" | "0" => Ok((false, NOT_IN_USE.to_owned())),
        _ => Err("无法读取记忆总开关，请重试".into()),
    }
}

fn enabled_map(directory: &Path) -> Result<BTreeMap<String, bool>, String> {
    let text = transaction::read_native(&directory.join(ITEMS_FILE))
        .map_err(|error| format!("无法读取记忆启停记录，请重试：{error}"))?;
    parse_items(&text)
}

fn parse_items(text: &str) -> Result<BTreeMap<String, bool>, String> {
    if text.trim().is_empty() {
        return Ok(BTreeMap::new());
    }
    serde_json::from_str(text).map_err(|_| "无法读取记忆启停记录，请重试".into())
}

fn entry_enabled(map: &BTreeMap<String, bool>, id: &str) -> bool {
    map.get(id).copied().unwrap_or(true)
}

fn removed_item(text: &str, id: &str) -> Result<Option<String>, String> {
    let mut map = parse_items(text)?;
    if map.remove(id).is_none() {
        return Ok(None);
    }
    serde_json::to_string(&map)
        .map(Some)
        .map_err(|_| "无法保存记忆启停，请重试".into())
}

#[cfg(test)]
#[path = "../../../tests/resources/memory.rs"]
mod tests;
