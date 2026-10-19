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
    MemoryAdapter, MemoryDeclaration, MemoryFileChange, MemoryLayout, MemoryManagement,
    MemoryOperation, MemoryStoreRef, MemoryTargetDimension,
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
    /// The adapter-enumerated store directory this target points at. Only a
    /// directory the adapter re-enumerates for the same home (with the same
    /// scope and project path) is accepted; callers can select an enumerated
    /// store, never invent a native path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub store_directory: Option<String>,
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

struct Prepared<'a> {
    directory: PathBuf,
    home: PathBuf,
    excluded: Vec<PathBuf>,
    management: MemoryManagement,
    layout: Option<&'a dyn MemoryLayout>,
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

/// One aggregated entry: the shared list output plus the store it came from
/// and the exact target that reaches it again for open, edit, and delete.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStoreEntry {
    pub id: String,
    pub path: String,
    pub enabled: bool,
    pub fingerprint: String,
    pub source_label: String,
    pub target: MemoryTarget,
    pub in_use: bool,
    pub detail: String,
}

/// A store whose listing failed; the remaining stores are still returned.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryFailedSource {
    pub label: String,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryAggregate {
    pub tool_id: String,
    pub entries: Vec<MemoryStoreEntry>,
    pub failed_sources: Vec<MemoryFailedSource>,
}

/// Lists every store the CLI already keeps on disk, one protected shared
/// list per store. A store that fails to list is reported in
/// `failed_sources` and never blocks the others; a CLI without a verified
/// memory declaration is refused before any read.
pub fn list_all_memories(
    db: &Database,
    registry: &Registry,
    home: &Path,
    tool_id: &str,
) -> Result<MemoryAggregate, String> {
    if !home.is_absolute() {
        return Err("用户目录必须是绝对路径".into());
    }
    let adapter = registry.get(tool_id).ok_or("此 CLI 尚无注册适配器")?;
    let port = adapter
        .memory()
        .ok_or("此 CLI 没有已核实的记忆")?;
    let declaration = port.declaration();
    crate::adapters::memory::publish(&declaration).ok_or("此 CLI 的记忆尚未核实")?;
    let mut entries = Vec::new();
    let mut failed_sources = Vec::new();
    for store in port.existing_stores(home) {
        let target = MemoryTarget {
            tool_id: tool_id.to_owned(),
            scope: store.scope,
            project_path: store.project_path.clone(),
            context_id: None,
            store_directory: Some(store.directory.display().to_string()),
        };
        match list_memories(db, registry, home, &target) {
            Ok(list) => {
                entries.extend(list.entries.into_iter().map(|entry| MemoryStoreEntry {
                    id: entry.id,
                    path: entry.path,
                    enabled: entry.enabled,
                    fingerprint: entry.fingerprint,
                    source_label: store.label.clone(),
                    target: target.clone(),
                    in_use: list.in_use,
                    detail: list.detail.clone(),
                }));
            }
            Err(reason) => failed_sources.push(MemoryFailedSource {
                label: store.label.clone(),
                reason,
            }),
        }
    }
    Ok(MemoryAggregate {
        tool_id: tool_id.to_owned(),
        entries,
        failed_sources,
    })
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
    let mut changes = vec![FileMutation {
        path: path.clone(),
        baseline: if path.is_file() { Some(baseline) } else { None },
        contents: Some(request.text.clone()),
    }];
    if let Some(layout) = prepared.layout {
        if let Some(change) = index_change(
            &prepared,
            layout
                .index_after_save(&prepared.directory, &request.id, &request.text)
                .map_err(|error| format!("无法更新记忆索引，请重试：{error}"))?,
        )? {
            changes.push(change);
        }
    }
    transaction::apply_files(db, credentials, &changes, commit_without_records)
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
    match prepared.layout {
        Some(layout) => {
            if let Some(change) = index_change(
                &prepared,
                layout
                    .index_after_delete(&prepared.directory, &request.id)
                    .map_err(|error| format!("无法更新记忆索引，请重试：{error}"))?,
            )? {
                changes.push(change);
            }
        }
        None => {
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
        }
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
            if let Some(layout) = prepared.layout {
                // The verified native switch target is the CLI's own settings
                // file, so the memory-path exclusion list deliberately does
                // not apply; the shared transaction still keeps the baseline
                // and reparse protections.
                if let Some(change) = layout
                    .switch_patch(&prepared.home, &prepared.directory, request.enabled)
                    .map_err(|error| format!("无法保存记忆总开关，请重试：{error}"))?
                {
                    transaction::apply_files(
                        db,
                        credentials,
                        &[file_change(change)],
                        commit_without_records,
                    )
                    .map_err(|error| format!("无法保存记忆总开关，请重试：{error}"))?;
                }
            } else {
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
    let (in_use, detail) = usage(prepared)?;
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
    let (in_use, detail) = usage(prepared)?;
    let enabled = match prepared.layout {
        // Native families have no engine enable record; every listed entry is
        // in use and single-entry management is editing or deleting it.
        Some(_) => true,
        None => entry_enabled(&enabled_map(&prepared.directory)?, id),
    };
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

fn prepare<'a>(
    db: &Database,
    registry: &'a Registry,
    home: &Path,
    target: &MemoryTarget,
) -> Result<Prepared<'a>, String> {
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
    let store = match requested_store(target) {
        Some(_) => Some(matched_store(port, home, target)?),
        None => None,
    };
    let (scope, project) = checked_scope(&declaration, target, store.as_ref())?;
    let (partition, guard) = partition(db, target, &declaration)?;
    let mut directory = match &store {
        Some(store) => store.directory.clone(),
        None => port
            .directory(scope, home, project.as_deref())
            .map_err(unavailable_directory)?,
    };
    // An enumerated store directory is the exact native location the
    // adapter reported, so the account partition suffix never applies to
    // it; an adapter that keeps per-account stores enumerates each one.
    if store.is_none() {
        match &partition {
            Partition::Shared => {}
            Partition::Bound(id) => directory.push(id),
            Partition::Unbound => directory.push("_unbound"),
        }
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
        home: home.to_path_buf(),
        excluded,
        management,
        layout: port.layout(),
        _guard: guard,
    })
}

/// A layout index change, guarded like an entry: inside the resolved
/// directory, absolute, no parent traversal, and never on an excluded path.
fn index_change(
    prepared: &Prepared,
    change: Option<MemoryFileChange>,
) -> Result<Option<FileMutation>, String> {
    let Some(change) = change else {
        return Ok(None);
    };
    if !change.path.is_absolute()
        || !change
            .path
            .components()
            .all(|component| !matches!(component, Component::ParentDir))
        || !change.path.starts_with(&prepared.directory)
    {
        return Err("记忆索引路径无效".into());
    }
    reject_excluded(&change.path, &prepared.excluded)?;
    Ok(Some(file_change(change)))
}

fn file_change(change: MemoryFileChange) -> FileMutation {
    FileMutation {
        path: change.path,
        baseline: change.baseline,
        contents: change.contents,
    }
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
    store: Option<&MemoryStoreRef>,
) -> Result<(Scope, Option<PathBuf>), String> {
    match target.scope {
        Scope::Global if declaration.scope.global => Ok((Scope::Global, None)),
        Scope::Project if declaration.scope.project => {
            // An enumerated store already pins its native location, and the
            // project behind an on-disk identity (slug, hash, UUID) is not
            // recoverable for every family. The store directory is therefore
            // authoritative on its own: the project behind it is neither
            // re-validated nor resolved, because entries cannot leave the
            // store directory and a project-domain exclusion never guards
            // anything inside it. Only a store-less target needs the caller's
            // project, validated as before.
            if store.is_some() {
                return Ok((Scope::Project, None));
            }
            let project =
                projects::checked_directory(target.project_path.as_deref().ok_or("请选择项目目录")?)?;
            Ok((Scope::Project, Some(project)))
        }
        _ => Err("此 CLI 的记忆不覆盖当前范围".into()),
    }
}

fn requested_store(target: &MemoryTarget) -> Option<&str> {
    target
        .store_directory
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// Resolves a caller-supplied store directory back to a store the adapter
/// enumerates for this home with the same scope and project path. Native
/// path resolution stays adapter-owned: a directory the adapter did not
/// enumerate is refused, and the generic absolute, parent-directory, and
/// reparse checks still apply afterwards.
fn matched_store(
    port: &dyn MemoryAdapter,
    home: &Path,
    target: &MemoryTarget,
) -> Result<MemoryStoreRef, String> {
    let Some(requested) = requested_store(target) else {
        return Err("记忆存储无效".into());
    };
    let requested_path = PathBuf::from(requested);
    port.existing_stores(home)
        .into_iter()
        .find(|store| {
            store.directory == requested_path
                && store.scope == target.scope
                && store.project_path == target.project_path
        })
        .ok_or_else(|| "该记忆存储已不在磁盘上，请刷新后重试".to_owned())
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
        // Agent definitions live in the declared definition directories under
        // the adapter root (plus the disabled marker directory). Excluding the
        // whole root would swallow unrelated native state that shares the
        // config root, such as a CLI's memory workspace.
        let resolved = agents.root(scope, home, project);
        let root = match resolved {
            Ok(root) => Some(root),
            Err(error) => {
                if scope == Scope::Project && project.is_none() {
                    // Only an enumerated store target reaches the project
                    // scope without a project: its writes are confined to the
                    // adapter-reported store directory, which a project-domain
                    // agent definition never guards, so an adapter that needs
                    // the project to name that root is skipped instead of
                    // failing the whole store.
                    None
                } else {
                    return Err(format!("无法确认 Agent 定义路径，请重试：{error}"));
                }
            }
        };
        if let Some(root) = root {
            if agents.scans_definition_directories() {
                for directory in agents.definition_dirs() {
                    paths.push(root.join(directory));
                }
                paths.push(root.join(".cliora-disabled-agents"));
            }
        }
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
    let path = match prepared.layout {
        Some(layout) => {
            let path = layout
                .entry_path(&prepared.directory, id)
                .map_err(|error| format!("无法定位记忆文件，请重试：{error}"))?;
            if !path.is_absolute()
                || path
                    .components()
                    .any(|component| matches!(component, Component::ParentDir))
                || !path.starts_with(&prepared.directory)
            {
                return Err("记忆路径无效".into());
            }
            path
        }
        None => prepared.directory.join(format!("{id}.md")),
    };
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
    if let Some(layout) = prepared.layout {
        let mut entries = Vec::new();
        for entry in layout
            .entries(&prepared.directory)
            .map_err(|error| format!("无法列出记忆，请重试：{error}"))?
        {
            if !valid_segment(&entry.id) || overlaps_path(&entry.path, &prepared.excluded) {
                continue;
            }
            let bytes = read_entry_bytes(&entry.path)?;
            entries.push(MemoryEntry {
                id: entry.id,
                path: entry.path.display().to_string(),
                enabled: true,
                fingerprint: transaction::fingerprint(&bytes),
            });
        }
        entries.sort_by(|left, right| left.id.cmp(&right.id));
        return Ok(entries);
    }
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

fn usage(prepared: &Prepared) -> Result<(bool, String), String> {
    if let Some(layout) = prepared.layout {
        let state = layout
            .switch_state(&prepared.home, &prepared.directory)
            .map_err(|error| format!("无法读取记忆总开关，请重试：{error}"))?;
        if state.enabled {
            return Ok((true, String::new()));
        }
        let detail = if state.detail.trim().is_empty() {
            NOT_IN_USE.to_owned()
        } else {
            state.detail
        };
        return Ok((false, detail));
    }
    let text = transaction::read_native(&prepared.directory.join(SWITCH_FILE))
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
