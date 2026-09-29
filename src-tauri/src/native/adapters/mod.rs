//! Versioned CLI contracts. The registry key is deliberately open so a future
//! tool can be registered without changing the five legacy serialized IDs.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use super::adapter::{NativeFile, Scope};
use super::apply::NativeSecrets;
use super::format::FileKind;
use super::intake::NativeInspection;
use super::profile::{Connection, RegisteredProfile};
use super::transaction::{self, ApplyOutcome, FieldChange, FilePatch};
use crate::credentials::CredentialStore;
use crate::database::Database;
use crate::domain::CliId;
use crate::resources::mcp::McpDefinition;

mod claude;
mod codex;
mod grok;
mod opencode;
mod pi;

pub static CODEX: codex::Codex = codex::Codex;
pub static CLAUDE: claude::Claude = claude::Claude;
pub static GROK: grok::Grok = grok::Grok;
pub static PI: pi::Pi = pi::Pi;
pub static OPENCODE: opencode::OpenCode = opencode::OpenCode;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Facet {
    pub state: &'static str,
    pub reason: &'static str,
}

#[derive(Clone, Debug)]
pub struct McpLocation {
    pub path: PathBuf,
    pub kind: FileKind,
    pub root: &'static str,
    pub child: Option<&'static str>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterDescriptor {
    pub id: &'static str,
    pub name: &'static str,
    pub interface_formats: &'static [&'static str],
    pub project_model_override: bool,
    pub yolo_available: bool,
    pub native_config: Facet,
    pub launch: Facet,
    pub resume: Facet,
    pub resources: Facet,
    pub history: Facet,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LaunchMode {
    Normal,
    Yolo,
}

#[derive(Default)]
pub struct InspectionFields {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub base: Option<String>,
    pub wire: Option<&'static str>,
    pub env: Option<String>,
    pub reasoning_effort: Option<String>,
}

pub type NativeCredentialRefs = BTreeMap<String, BTreeMap<String, String>>;
pub type PendingSecrets = Vec<(String, String)>;

pub trait CliAdapter: Sync {
    fn id(&self) -> &'static str;
    fn name(&self) -> &'static str;
    fn command(&self) -> &'static str;
    fn npm_package(&self) -> &'static str;
    fn version_identity(&self, basename: &str, output: &str) -> bool;
    fn native_files(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
        known: bool,
    ) -> Vec<NativeFile>;
    fn interface_formats(&self) -> &'static [&'static str];
    fn file_kind(&self, role: &str) -> Result<FileKind, String>;
    fn auth_env_name(&self, connection: &Connection) -> Option<String> {
        if let Some(name) = &connection.auth_env_var {
            return Some(name.clone());
        }
        connection.secret_ref.as_ref()?;
        let tool = self.id().to_ascii_uppercase().replace('-', "_");
        let provider = connection
            .provider_id
            .to_ascii_uppercase()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .collect::<String>();
        Some(format!("CLIORA_{tool}_{provider}_API_KEY"))
    }
    fn connection_documents(
        &self,
        connection: &Connection,
        scope: Scope,
    ) -> Result<BTreeMap<String, Value>, String>;
    fn write_connection_secret(
        &self,
        profile: &RegisteredProfile,
        scope: Scope,
        credentials: &dyn CredentialStore,
        secrets: &mut NativeSecrets,
    ) -> Result<(), String>;
    fn has_native_secret(&self, role: &str, root: &Value) -> bool;
    fn inspect_values(
        &self,
        settings: &Value,
        local_settings: &Value,
        models: &Value,
    ) -> InspectionFields;
    fn import_literal_secrets(
        &self,
        _files: &mut BTreeMap<String, String>,
        _found: &mut NativeInspection,
        _pending: &mut PendingSecrets,
        _native_refs: &mut NativeCredentialRefs,
    ) -> Result<(), String> {
        Ok(())
    }
    fn validate_draft(&self, _role: &str, _parsed: &Value) -> Result<(), String> {
        Ok(())
    }
    fn accepts_native_credential(&self, _role: &str, _name: &str) -> bool {
        false
    }
    fn imported_connection_overrides_native(&self) -> bool {
        false
    }
    fn restore_imported_secrets(
        &self,
        _profile: &RegisteredProfile,
        _scope: Scope,
        _credentials: &dyn CredentialStore,
        _secrets: &mut NativeSecrets,
    ) -> Result<(), String> {
        Ok(())
    }
    fn connection_roles(&self) -> &'static [&'static str] {
        &["settings"]
    }
    fn validate_role_scope(&self, _role: &str, _scope: Scope) -> Result<(), String> {
        Ok(())
    }
    fn validate_documents(
        &self,
        _scope: Scope,
        _documents: &BTreeMap<String, Value>,
    ) -> Result<(), String> {
        Ok(())
    }
    /// Returns arguments only. The caller owns executable selection and process launch.
    fn launch_args(&self, session: Option<&str>, mode: LaunchMode) -> Result<Vec<String>, String>;
    fn supports_project_model_override(&self) -> bool {
        false
    }
    fn project_model_args(&self, model: Option<&str>) -> Result<Vec<String>, String> {
        if model.is_some() {
            return Err("此 CLI 不支持项目启动模型覆盖".into());
        }
        Ok(Vec::new())
    }
    fn mcp_location(
        &self,
        _scope: Scope,
        _home: &Path,
        _project: Option<&Path>,
    ) -> Option<McpLocation> {
        None
    }
    fn mcp_requires_version(&self) -> bool {
        false
    }
    fn mcp_location_for_version(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
        _version: Option<&str>,
    ) -> Option<McpLocation> {
        self.mcp_location(scope, home, project)
    }
    fn mcp_document(
        &self,
        _definition: &McpDefinition,
        _enabled: bool,
        _existing: Option<&Value>,
    ) -> Result<Option<Value>, String> {
        Err("此 CLI 没有已确认的原生 MCP 配置格式".into())
    }
    fn mcp_document_at(
        &self,
        definition: &McpDefinition,
        enabled: bool,
        existing: Option<&Value>,
        _location: &McpLocation,
    ) -> Result<Option<Value>, String> {
        self.mcp_document(definition, enabled, existing)
    }
    fn mcp_disabled_description(&self) -> Option<&'static str> {
        None
    }
    fn skill_root(&self, _scope: Scope, _home: &Path, _project: Option<&Path>) -> Option<PathBuf> {
        None
    }
    fn rule_path(&self, _scope: Scope, _home: &Path, _project: Option<&Path>) -> Option<PathBuf> {
        None
    }
    fn install_guidance(&self) -> (&'static str, &'static str);
    fn node_required_when_missing(&self) -> bool {
        true
    }
    fn minimum_node_version(&self) -> Option<(u32, u32, u32)> {
        None
    }
    fn node_dependency_detail(&self) -> &'static str {
        "npm 命令入口需要 Node.js"
    }
    fn requires_windows_bash(&self) -> bool {
        false
    }
    fn recognizes_native_install_path(&self, _path: &Path) -> bool {
        false
    }
    fn install_command(&self) -> Option<String> {
        Some(format!("npm install -g {}", self.npm_package()))
    }
    fn upgrade_command(&self, source: &str) -> Option<String> {
        (source == "npm_shim").then(|| format!("npm install -g {}@latest", self.npm_package()))
    }
    fn anthropic_base_url(&self) -> &'static str {
        "https://api.anthropic.com/v1"
    }
    fn explicitly_incompatible_native_version(&self, _version: &str) -> bool {
        false
    }
    fn explicitly_incompatible_launch_version(&self, _version: &str) -> bool {
        false
    }
    fn descriptor(&self) -> AdapterDescriptor {
        AdapterDescriptor {
            id: self.id(),
            name: self.name(),
            interface_formats: self.interface_formats(),
            project_model_override: self.supports_project_model_override(),
            yolo_available: self.launch_args(None, LaunchMode::Yolo).is_ok(),
            native_config: Facet {
                state: "available",
                reason: "已确认 CLI 身份，可编辑受支持的原生文件格式",
            },
            launch: Facet {
                state: "available",
                reason: "可在外部终端启动",
            },
            resume: Facet {
                state: "available",
                reason: "可用原生会话 ID 在外部终端恢复；历史索引后续接入",
            },
            resources: Facet {
                state: "available",
                reason: "原生资源路径由此 CLI 适配器逐项提供",
            },
            history: Facet {
                state: "planned",
                reason: "历史能力由后续任务确认",
            },
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnknownAdapterRecord {
    pub id: String,
    pub profile_count: u32,
    pub read_only: bool,
    pub reason: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterCatalog {
    pub registered: Vec<AdapterDescriptor>,
    pub managed_ids: Vec<String>,
    pub preserved_unknown: Vec<UnknownAdapterRecord>,
}

pub struct Registry {
    entries: Vec<&'static dyn CliAdapter>,
}

impl Registry {
    pub fn builtins() -> Self {
        Self {
            entries: vec![&CODEX, &CLAUDE, &GROK, &PI, &OPENCODE],
        }
    }

    pub fn with_adapters(entries: Vec<&'static dyn CliAdapter>) -> Result<Self, String> {
        let mut ids = std::collections::HashSet::new();
        for entry in &entries {
            if entry.id().is_empty() || !ids.insert(entry.id()) {
                return Err("CLI 适配器 ID 为空或重复".into());
            }
        }
        Ok(Self { entries })
    }

    pub fn get(&self, id: &str) -> Option<&'static dyn CliAdapter> {
        self.entries.iter().copied().find(|entry| entry.id() == id)
    }

    pub fn descriptors(&self) -> Vec<AdapterDescriptor> {
        self.entries
            .iter()
            .map(|entry| entry.descriptor())
            .collect()
    }
}

pub fn legacy_id(id: CliId) -> &'static str {
    id.stable_id()
}

pub fn known(id: CliId) -> &'static dyn CliAdapter {
    Registry::builtins()
        .get(legacy_id(id))
        .expect("built-in adapter registered")
}

pub fn file(
    role: &'static str,
    path: PathBuf,
    kind: FileKind,
    known: bool,
    reason: Option<&'static str>,
    sensitive: bool,
) -> NativeFile {
    NativeFile {
        role,
        path: path.display().to_string(),
        format: match kind {
            FileKind::Toml => "toml",
            FileKind::Json => "json",
            FileKind::Jsonc => "jsonc",
        },
        writable: known && !sensitive,
        reason: if known {
            reason
        } else {
            Some("此版本的原生写入能力尚未验证")
        },
        sensitive,
    }
}

pub fn project_root(scope: Scope, project: Option<&Path>) -> Option<Option<&Path>> {
    match scope {
        Scope::Global => Some(None),
        Scope::Project => project.map(Some),
    }
}

pub fn import_toml_key(
    collection: &str,
    field: &str,
    active: Option<&str>,
    files: &mut BTreeMap<String, String>,
    found: &mut NativeInspection,
    pending: &mut PendingSecrets,
) -> Result<(), String> {
    let mut text = files.get("settings").cloned().unwrap_or_default();
    let parsed = super::format::parse(FileKind::Toml, &text)?;
    if let Some(entries) = parsed.get(collection).and_then(Value::as_object) {
        for (name, entry) in entries {
            let Some(key) = entry.get(field).and_then(Value::as_str) else {
                continue;
            };
            if Some(name.as_str()) != active || found.connection.is_none() {
                return Err(format!("{collection}.{name}.{field} 含原生密钥，但不是完整的当前连接；请先在 CLI 中选定模型与供应商，原文件未更改"));
            }
            if key.is_empty() || key.len() > 16_384 {
                return Err("原生 API 密钥为空或过长；原文件未更改".into());
            }
            let id = format!("connection-{}", uuid::Uuid::new_v4());
            text = super::format::set_path(
                FileKind::Toml,
                &text,
                &[collection.into(), name.clone(), field.into()],
                None,
            )?;
            files.insert("settings".into(), text.clone());
            found.connection.as_mut().unwrap().secret_ref = Some(id.clone());
            pending.push((id, key.to_owned()));
        }
    }
    Ok(())
}

pub fn plan_launch(
    registry: &Registry,
    id: &str,
    version: &str,
    session: Option<&str>,
    mode: LaunchMode,
) -> Result<Vec<String>, String> {
    let adapter = registry
        .get(id)
        .ok_or("未注册的 CLI 适配器，不能生成启动参数")?;
    if version.trim().is_empty() {
        return Err("CLI 版本不可识别，无法生成启动参数".into());
    }
    if adapter.explicitly_incompatible_launch_version(version) {
        return Err("此 CLI 版本不支持所请求的启动参数".into());
    }
    if session.is_some_and(|value| value.is_empty() || value.contains(['\r', '\n', '\0'])) {
        return Err("会话 ID 无效".into());
    }
    adapter.launch_args(session, mode)
}

pub fn registered_file(
    registry: &Registry,
    id: &str,
    role: &str,
    scope: Scope,
    home: &Path,
    project: Option<&Path>,
    known: bool,
) -> Result<NativeFile, String> {
    registry
        .get(id)
        .ok_or("未注册的 CLI 适配器，只能只读保留原资料")?
        .native_files(scope, home, project, known)
        .into_iter()
        .find(|file| file.role == role)
        .ok_or("此 CLI 没有指定的原生文件角色".into())
}

pub fn read_registered_file(
    registry: &Registry,
    id: &str,
    role: &str,
    scope: Scope,
    home: &Path,
    project: Option<&Path>,
    known: bool,
) -> Result<String, String> {
    let file = registered_file(registry, id, role, scope, home, project, known)?;
    if file.sensitive {
        return Err("受保护的原生凭据文件不能作为普通配置读取".into());
    }
    transaction::read_native(Path::new(&file.path))
}

pub fn commit_registered_patches<F>(
    registry: &Registry,
    id: &str,
    files: &[NativeFile],
    db: &Database,
    credentials: &dyn CredentialStore,
    patches: &[FilePatch],
    commit: F,
) -> Result<ApplyOutcome, String>
where
    F: FnOnce(&rusqlite::Transaction<'_>) -> Result<(), String>,
{
    let adapter = registry
        .get(id)
        .ok_or("未注册的 CLI 适配器，不能写入原生配置")?;
    for patch in patches {
        let allowed = files.iter().any(|file| {
            file.writable
                && !file.sensitive
                && Path::new(&file.path) == patch.path
                && adapter.file_kind(file.role).is_ok()
                && matches!(
                    (file.format, patch.kind),
                    ("toml", FileKind::Toml)
                        | ("json", FileKind::Json)
                        | ("jsonc", FileKind::Jsonc)
                )
        });
        if !allowed {
            return Err("原生目标不在此适配器可写文件角色内".into());
        }
    }
    transaction::apply(db, credentials, patches, commit)
}

pub fn apply_registered_fields<F>(
    registry: &Registry,
    id: &str,
    role: &str,
    scope: Scope,
    home: &Path,
    project: Option<&Path>,
    version: &str,
    db: &Database,
    credentials: &dyn CredentialStore,
    baseline: String,
    changes: Vec<FieldChange>,
    commit: F,
) -> Result<ApplyOutcome, String>
where
    F: FnOnce(&rusqlite::Transaction<'_>) -> Result<(), String>,
{
    let adapter = registry
        .get(id)
        .ok_or("未注册的 CLI 适配器，不能写入原生配置")?;
    if version.trim().is_empty() || adapter.explicitly_incompatible_native_version(version) {
        return Err("此 CLI 版本尚未确认身份或明确不兼容原生写入".into());
    }
    let files = adapter.native_files(scope, home, project, true);
    let file = files
        .iter()
        .find(|file| file.role == role)
        .ok_or("此 CLI 没有指定的原生文件角色")?;
    let patch = FilePatch {
        path: PathBuf::from(&file.path),
        kind: match file.format {
            "toml" => FileKind::Toml,
            "json" => FileKind::Json,
            "jsonc" => FileKind::Jsonc,
            _ => return Err("原生文件格式不受支持".into()),
        },
        baseline,
        changes,
        sensitive: false,
        force_restrict: false,
    };
    commit_registered_patches(registry, id, &files, db, credentials, &[patch], commit)
}

#[cfg(test)]
#[path = "../../../../tests/adapter/sixth.rs"]
mod adapter_contract_tests;
