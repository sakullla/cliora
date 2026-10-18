pub mod crypto;
pub mod sync;

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::credentials::CredentialStore;
use crate::database::Database;
use crate::library::LibraryItem;
use crate::adapters::Registry;
use crate::native::format::{self, FileKind};
use crate::native::profile::{RegisteredCommon, RegisteredProfile};
use crate::resources::mcp::McpDefinition;

pub(crate) const SNAPSHOT_VERSION: u32 = 3;
const MAX_ENTITIES: usize = 10_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortablePreferences {
    pub managed_tools: Vec<String>,
    pub theme: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub tool_icons: BTreeMap<String, String>,
    /// Schema 3. Older packages omit it and must not wipe a saved language.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableProfile {
    pub profile: RegisteredProfile,
    pub connection_secret: Option<String>,
    pub native_secrets: BTreeMap<String, BTreeMap<String, String>>,
    pub pending_fields: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableProject {
    pub id: String,
    pub name: String,
    /// Absent on schema 1 and 2. Schema 3 keeps the source path text even when
    /// that directory is not on this machine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub model_overrides: BTreeMap<String, String>,
}

/// Auth file bytes copied from `NativeContext.auth_files`. Paths are not a
/// catalog of CLI ids; the receiver asks the account adapter for local paths.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableAuthFile {
    pub context_id: String,
    pub name: String,
    pub contents: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableAccount {
    pub account: crate::accounts::AuthAccount,
    pub auth_files: Vec<PortableAuthFile>,
}

/// Which saved profile is active. Local apply bookkeeping stays out of the digest.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableBinding {
    pub scope_key: String,
    pub tool: String,
    pub profile_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreBlocker {
    pub key: String,
    pub label: String,
    pub action: String,
    pub detail: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableSkill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub files: BTreeMap<String, String>,
    pub digest: String,
    pub pending_fields: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableMcp {
    pub definition: McpDefinition,
    pub pending_fields: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum PortablePayload {
    Preferences(PortablePreferences),
    Profile(PortableProfile),
    Common(RegisteredCommon),
    Project(PortableProject),
    Library(LibraryItem),
    Mcp(PortableMcp),
    Skill(PortableSkill),
    Account(PortableAccount),
    Binding(PortableBinding),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableEntity {
    pub id: String,
    pub payload: PortablePayload,
}

impl PortableEntity {
    pub fn kind(&self) -> &'static str {
        match &self.payload {
            PortablePayload::Preferences(_) => "preferences",
            PortablePayload::Profile(_) => "profile",
            PortablePayload::Common(_) => "common",
            PortablePayload::Project(_) => "project",
            PortablePayload::Library(_) => "library",
            PortablePayload::Mcp(_) => "mcp",
            PortablePayload::Skill(_) => "skill",
            PortablePayload::Account(_) => "account",
            PortablePayload::Binding(_) => "binding",
        }
    }
    pub fn key(&self) -> String {
        format!("{}:{}", self.kind(), self.id)
    }
    pub fn digest(&self) -> Result<String, String> {
        let mut normalized = self.clone();
        match &mut normalized.payload {
            PortablePayload::Profile(value) => {
                value.pending_fields.clear();
                value.profile.revision.clear();
            }
            PortablePayload::Common(value) => value.revision.clear(),
            PortablePayload::Mcp(value) => value.pending_fields.clear(),
            PortablePayload::Skill(value) => value.pending_fields.clear(),
            PortablePayload::Account(value) => normalize_account_digest(&mut value.account),
            _ => {}
        }
        let bytes = serde_json::to_vec(&normalized).map_err(|_| "无法核对迁移资料".to_string())?;
        Ok(format!("{:x}", Sha256::digest(bytes)))
    }
    pub fn label(&self) -> String {
        match &self.payload {
            PortablePayload::Preferences(_) => "管理偏好".into(),
            PortablePayload::Profile(value) => value.profile.name.clone(),
            PortablePayload::Common(value) => format!("{} 通用配置", value.tool),
            PortablePayload::Project(value) => value.name.clone(),
            PortablePayload::Library(value) => value.title.clone(),
            PortablePayload::Mcp(value) => value.definition.name.clone(),
            PortablePayload::Skill(value) => value.name.clone(),
            PortablePayload::Account(value) => value.account.label.clone(),
            PortablePayload::Binding(value) => format!("{} 活动配置", value.tool),
        }
    }
    pub fn pending_fields(&self) -> Vec<String> {
        match &self.payload {
            PortablePayload::Profile(value) => value.pending_fields.clone(),
            PortablePayload::Project(value) if !value.path.as_deref().is_some_and(|path| Path::new(path).is_dir()) => {
                vec!["项目本机目录".into()]
            }
            PortablePayload::Mcp(value) => value.pending_fields.clone(),
            PortablePayload::Skill(value) => value.pending_fields.clone(),
            PortablePayload::Account(value) if value.account.context.is_none() && value.account.state == crate::accounts::AccountState::SignedIn => {
                vec!["登录材料需要在本机重新登录".into()]
            }
            _ => Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableSnapshot {
    pub schema_version: u32,
    pub entities: Vec<PortableEntity>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportItem {
    pub key: String,
    pub kind: String,
    pub tool_id: Option<String>,
    pub label: String,
    pub status: &'static str,
    pub pending_fields: Vec<String>,
    pub local_preview: Option<String>,
    pub incoming_preview: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub preview_id: String,
    pub items: Vec<ImportItem>,
    pub pending_projects: usize,
}

#[derive(Clone)]
pub struct ImportDraft {
    pub id: String,
    pub snapshot: PortableSnapshot,
    pub baseline: BTreeMap<String, Option<String>>,
    pub items: Vec<ImportItem>,
}

fn looks_absolute(value: &str) -> bool {
    let bytes = value.as_bytes();
    Path::new(value).is_absolute()
        || value.starts_with("~/")
        || value.starts_with("~\\")
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'/' | b'\\'))
}

fn unsafe_field(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    [
        "token",
        "secret",
        "password",
        "cookie",
        "credential",
        "auth",
        "apikey",
        "api_key",
        "session",
        "notify",
        "path",
        "directory",
        "cwd",
        "cache",
        "logfile",
        "command",
    ]
    .iter()
    .any(|fragment| key.contains(fragment))
}

fn scrub_value(value: Value, path: &str, pending: &mut Vec<String>, adapter: Option<&dyn crate::adapters::CliAdapter>, native_path: &[String]) -> Option<Value> {
    match value {
        Value::Object(object) => {
            let mut clean = serde_json::Map::new();
            for (key, value) in object {
                let location = format!("{path}.{key}");
                let mut field_path = native_path.to_vec();
                field_path.push(key.clone());
                let semantic = adapter.map_or(Default::default(), |adapter| adapter.portable_field_kind(&field_path));
                use crate::adapters::configuration::PortableFieldKind;
                let exact_secret = matches!(key.to_ascii_lowercase().as_str(), "token" | "api_key" | "apikey" | "password" | "secret" | "authorization" | "cookie" | "credential" | "access_token" | "refresh_token");
                let public_reference = semantic == PortableFieldKind::CredentialReference
                    && adapter.and_then(|adapter| adapter.configuration()).is_some_and(|port| port.portable_reference_valid(&field_path, &value));
                if (semantic == PortableFieldKind::CredentialReference && !public_reference)
                    || (exact_secret && !public_reference)
                    || matches!(semantic, PortableFieldKind::Credential | PortableFieldKind::Local)
                    || (!public_reference && semantic != PortableFieldKind::Parameter && unsafe_field(&key)) {
                    pending.push(location);
                    continue;
                }
                if let Some(value) = scrub_value(value, &location, pending, adapter, &field_path) {
                    clean.insert(key, value);
                }
            }
            Some(Value::Object(clean))
        }
        Value::Array(items) => Some(Value::Array(
            items
                .into_iter()
                .enumerate()
                .filter_map(|(index, item)| scrub_value(item, &format!("{path}[{index}]"), pending, adapter, &native_path.iter().cloned().chain([index.to_string()]).collect::<Vec<_>>()))
                .collect(),
        )),
        Value::String(text) if looks_absolute(&text) => {
            pending.push(path.into());
            None
        }
        Value::Null => None,
        other => Some(other),
    }
}

fn portable_files(
    registry: &Registry,
    tool: &str,
    files: &BTreeMap<String, String>,
) -> Result<(BTreeMap<String, String>, Vec<String>), String> {
    let mut result = BTreeMap::new();
    let mut pending = Vec::new();
    let Some(adapter) = registry.get(tool) else {
        if !files.is_empty() {
            pending.push("未知适配器的原生字段".into());
        }
        return Ok((result, pending));
    };
    for (role, text) in files {
        let allowed = adapter.portable_root_fields(role);
        if allowed.is_empty() {
            continue;
        }
        let kind = adapter.file_kind(role)?;
        let parsed = format::parse(kind, text)?;
        let mut clean = serde_json::Map::new();
        if let Some(object) = parsed.as_object() {
            for (key, value) in object {
                if !allowed.contains(&key.as_str())
                    && (unsafe_field(key)
                        || value.to_string().contains(":\\\\")
                        || value.to_string().contains(":/"))
                {
                    pending.push(format!("{role}.{key}"));
                }
            }
            for key in allowed {
                if let Some(value) = object.get(*key).cloned() {
                    if let Some(value) = scrub_value(value, &format!("{role}.{key}"), &mut pending, Some(adapter), &[role.clone(), (*key).into()])
                    {
                        clean.insert((*key).into(), value);
                    }
                }
            }
        }
        if clean.is_empty() {
            continue;
        }
        let clean = Value::Object(clean);
        let rendered = match kind {
            FileKind::Toml => toml::to_string_pretty(&clean)
                .map_err(|_| "无法整理可迁移 TOML 字段".to_string())?,
            FileKind::Json | FileKind::Jsonc => serde_json::to_string_pretty(&clean)
                .map_err(|_| "无法整理可迁移 JSON 字段".to_string())?,
            FileKind::Yaml => serde_yaml::to_string(&clean)
                .map_err(|_| "无法整理可迁移 YAML 字段".to_string())?,
        };
        result.insert(role.clone(), rendered);
    }
    pending.sort();
    pending.dedup();
    Ok((result, pending))
}

fn references_in_text(text: &str) -> bool {
    text.split_whitespace().any(|part| {
        looks_absolute(
            part.trim_matches(|ch: char| matches!(ch, '\'' | '"' | '(' | ')' | ',' | ';')),
        )
    })
}

fn valid_skill_files(files: &BTreeMap<String, String>) -> Result<(), String> {
    if files.is_empty() || files.len() > 256 {
        return Err("Skill 文件数量无效".into());
    }
    let mut total = 0usize;
    for (name, contents) in files {
        if name.is_empty()
            || Path::new(name)
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
            || name.contains('\\')
            || name.contains(':')
        {
            return Err("Skill 包含不安全路径".into());
        }
        let bytes = STANDARD
            .decode(contents)
            .map_err(|_| "Skill 资源编码损坏".to_string())?;
        total = total.checked_add(bytes.len()).ok_or("Skill 资源过大")?;
        if total > 12 * 1024 * 1024 {
            return Err("Skill 资源超过 12 MiB".into());
        }
    }
    if !files.contains_key("SKILL.md") {
        return Err("Skill 缺少 SKILL.md".into());
    }
    Ok(())
}

fn read_rows<T>(
    conn: &rusqlite::Connection,
    sql: &str,
    mut row: impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
) -> Result<Vec<T>, String> {
    let mut statement = conn.prepare(sql).map_err(|error| error.to_string())?;
    let result = statement
        .query_map([], |entry| row(entry))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string());
    result
}

pub fn collect_snapshot(
    db: &Database,
    store: &dyn CredentialStore,
    registry: &Registry,
) -> Result<PortableSnapshot, String> {
    db.with_connection(|conn| collect_snapshot_on(conn, store, registry))
}

fn collect_snapshot_on(
    conn: &Connection,
    store: &dyn CredentialStore,
    registry: &Registry,
) -> Result<PortableSnapshot, String> {
    let (preferences, profiles, commons, projects, models, library, mcp, skills) = {
        let preferences: Option<String> = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = 'preferences'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let profiles = read_rows(
            conn,
            "SELECT data FROM native_profiles ORDER BY id",
            |row| row.get::<_, String>(0),
        )?;
        let commons = read_rows(
            conn,
            "SELECT data FROM common_configs ORDER BY tool",
            |row| row.get::<_, String>(0),
        )?;
        let projects = read_rows(conn, "SELECT id,name,path FROM projects ORDER BY id", |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?))
        })?;
        let models = read_rows(
            conn,
            "SELECT project_id,tool,model FROM project_tool_models ORDER BY project_id,tool",
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )?;
        let library = read_rows(conn, "SELECT id,kind,title,body,category,project_id,version,updated_at FROM library_items ORDER BY id", |row|
            Ok((row.get::<_, String>(0)?,row.get::<_, String>(1)?,row.get::<_, String>(2)?,row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,row.get::<_, Option<String>>(5)?,row.get::<_, i64>(6)?,row.get::<_, i64>(7)?)))?;
        let mcp = read_rows(
            conn,
            "SELECT data_json FROM mcp_definitions ORDER BY id",
            |row| row.get::<_, String>(0),
        )?;
        let skills = read_rows(
            conn,
            "SELECT id,name,description,digest,files_json FROM skill_packages ORDER BY id",
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )?;
        Ok::<_, String>((
            preferences,
            profiles,
            commons,
            projects,
            models,
            library,
            mcp,
            skills,
        ))
    }?;
    let mut entities = Vec::new();
    // Defaults are a view fallback, not a persisted portable entity or a CAS baseline.
    if let Some(preferences) = preferences {
    let preferences: Value = serde_json::from_str(&preferences).map_err(|_| "管理偏好格式错误")?;
    entities.push(PortableEntity {
        id: "managed".into(),
        payload: PortablePayload::Preferences(PortablePreferences {
            managed_tools: preferences
                .get("managed_tools")
                .and_then(Value::as_array)
                .ok_or("管理偏好格式错误")?
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
            tool_icons: serde_json::from_value(preferences.get("tool_icons").cloned().unwrap_or_else(|| serde_json::json!({}))).map_err(|_| "图标偏好格式错误")?,
            theme: preferences
                .get("theme")
                .and_then(Value::as_str)
                .unwrap_or("system")
                .into(),
            language: preferences
                .get("language")
                .and_then(Value::as_str)
                .filter(|value| matches!(*value, "zh" | "en"))
                .map(str::to_owned),
        }),
    });
    }
    for text in profiles {
        let mut profile: RegisteredProfile =
            serde_json::from_str(&text).map_err(|_| "命名配置格式错误")?;
        if registry.get(&profile.tool).is_some() {
            crate::native::configuration::normalize_legacy(registry, &mut profile, crate::native::adapter::Scope::Global, None)?;
        }
        profile.revision.clear();
        let (files, mut pending_fields) = portable_files(registry, &profile.tool, &profile.files)?;
        profile.files = files;
        if let Some(editing) = profile.editing.as_mut() {
            editing.intents.retain_mut(|action| {
                let Ok(value) = serde_json::to_value(&*action) else { return false; };
                let adapter = registry.get(&profile.tool);
                if let Some(field) = &action.field {
                    let kind = adapter.map_or(Default::default(), |adapter| adapter.portable_field_kind(&[field.clone()]));
                    let public_reference = kind == crate::adapters::configuration::PortableFieldKind::CredentialReference
                        && action.value.as_ref().is_some_and(|value| adapter.and_then(|adapter| adapter.configuration()).is_some_and(|port| port.portable_reference_valid(&[field.clone()], value)));
                    if (kind == crate::adapters::configuration::PortableFieldKind::CredentialReference && action.value.is_some() && !public_reference)
                        || (unsafe_field(field) && kind != crate::adapters::configuration::PortableFieldKind::Parameter && !public_reference) {
                        pending_fields.push(format!("editing.intent.{field}")); return false;
                    }
                }
                let Some(clean) = scrub_value(value, "editing.intent", &mut pending_fields, adapter, &[]) else { return false; };
                if let Ok(safe) = serde_json::from_value(clean) { *action = safe; true } else {
                    pending_fields.push("不适用本机的配置编辑意图".into()); false
                }
            });
        }
        // Connection API keys travel with the profile. An adapter flag must not drop them.
        let connection_secret = if let Some(connection) = profile.connection.as_mut() {
            let id = connection.secret_ref.take();
            id.map(|id| store.get(&id)).transpose()?
        } else {
            None
        };
        let mut native_secrets = BTreeMap::new();
        for (role, credentials) in std::mem::take(&mut profile.native_credentials) {
            let mut values = BTreeMap::new();
            for (name, id) in credentials {
                values.insert(name, store.get(&id)?);
            }
            if !values.is_empty() {
                native_secrets.insert(role, values);
            }
        }
        pending_fields.sort();
        pending_fields.dedup();
        entities.push(PortableEntity {
            id: profile.id.clone(),
            payload: PortablePayload::Profile(PortableProfile {
                profile,
                connection_secret,
                native_secrets,
                pending_fields,
            }),
        });
    }
    for text in commons {
        let mut common: RegisteredCommon =
            serde_json::from_str(&text).map_err(|_| "通用配置格式错误")?;
        common.revision.clear();
        common.files = portable_files(registry, &common.tool, &common.files)?.0;
        entities.push(PortableEntity {
            id: common.tool.clone(),
            payload: PortablePayload::Common(common),
        });
    }
    let mut project_models: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    for (project_id, tool, model) in models {
        project_models
            .entry(project_id)
            .or_default()
            .insert(tool, model);
    }
    for (id, name, path) in projects {
        entities.push(PortableEntity {
            id: id.clone(),
            payload: PortablePayload::Project(PortableProject {
                id: id.clone(),
                name,
                path,
                model_overrides: project_models.remove(&id).unwrap_or_default(),
            }),
        });
    }
    for (id, kind, title, body, category, project_id, version, updated_at) in library {
        let kind = match kind.as_str() {
            "prompt" => crate::library::LibraryKind::Prompt,
            "rule" => crate::library::LibraryKind::Rule,
            _ => return Err("资料库分类无效".into()),
        };
        entities.push(PortableEntity {
            id: id.clone(),
            payload: PortablePayload::Library(LibraryItem {
                id,
                kind,
                title,
                body,
                category,
                project_id,
                version: version.max(0) as u64,
                updated_at: updated_at.max(0) as u64,
            }),
        });
    }
    for text in mcp {
        let mut definition: McpDefinition =
            serde_json::from_str(&text).map_err(|_| "MCP 定义格式错误")?;
        let mut pending_fields = Vec::new();
        if looks_absolute(&definition.command) {
            definition.command.clear();
            pending_fields.push("MCP 命令本机路径".into());
        }
        for (index, arg) in definition.args.iter_mut().enumerate() {
            if looks_absolute(arg) {
                *arg = "<待关联路径>".into();
                pending_fields.push(format!("MCP 参数 {}", index + 1));
            }
        }
        for (name, value) in &mut definition.env {
            if looks_absolute(value) {
                *value = "<待关联路径>".into();
                pending_fields.push(format!("MCP 环境变量 {name}"));
            }
        }
        entities.push(PortableEntity {
            id: definition.id.clone(),
            payload: PortablePayload::Mcp(PortableMcp {
                definition,
                pending_fields,
            }),
        });
    }
    for (id, name, description, digest, files_json) in skills {
        let files: BTreeMap<String, String> =
            serde_json::from_str(&files_json).map_err(|_| "Skill 资源格式错误")?;
        valid_skill_files(&files)?;
        let mut pending_fields = Vec::new();
        for (path, data) in &files {
            let bytes = STANDARD.decode(data).map_err(|_| "Skill 资源编码损坏")?;
            if let Ok(text) = std::str::from_utf8(&bytes) {
                if references_in_text(text) {
                    pending_fields.push(format!("Skill {} 中的本机引用", path));
                }
            }
        }
        entities.push(PortableEntity {
            id: id.clone(),
            payload: PortablePayload::Skill(PortableSkill {
                id,
                name,
                description,
                files,
                digest,
                pending_fields,
            }),
        });
    }
    let accounts = read_rows(conn, "SELECT data FROM auth_accounts ORDER BY id", |row| row.get::<_, String>(0))?;
    for text in accounts {
        let account: crate::accounts::AuthAccount = serde_json::from_str(&text).map_err(|_| "账号格式错误")?;
        let (account, auth_files) = portable_account(account)?;
        entities.push(PortableEntity {
            id: account.id.clone(),
            payload: PortablePayload::Account(PortableAccount { account, auth_files }),
        });
    }
    let bindings = read_rows(
        conn,
        "SELECT scope_key,tool,profile_id,context_id FROM applied_bindings WHERE scope_key='global' OR scope_key LIKE 'project:%' ORDER BY tool, scope_key",
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, Option<String>>(3)?)),
    )?;
    for (scope_key, tool, profile_id, context_id) in bindings {
        let id = binding_id(&tool, &scope_key);
        entities.push(PortableEntity {
            id,
            payload: PortablePayload::Binding(PortableBinding { scope_key, tool, profile_id, context_id }),
        });
    }
    if entities.len() > MAX_ENTITIES {
        return Err("可迁移资料超过 10000 项".into());
    }
    Ok(PortableSnapshot {
        schema_version: SNAPSHOT_VERSION,
        entities,
    })
}

pub fn validate_snapshot(snapshot: &PortableSnapshot) -> Result<(), String> {
    if !matches!(snapshot.schema_version, 1 | 2 | SNAPSHOT_VERSION) || snapshot.entities.len() > MAX_ENTITIES {
        return Err("配置包资料版本或数量不受支持".into());
    }
    let mut keys = HashSet::new();
    for entity in &snapshot.entities {
        if let PortablePayload::Profile(value) = &entity.payload {
            if let Some(editing) = &value.profile.editing {
                crate::native::configuration::validate_state(editing)?;
                if snapshot.schema_version < 2 || editing.version != crate::adapters::configuration::EDITING_VERSION {
                    return Err("配置包编辑语义版本不受支持".into());
                }
            }
        }
        if entity.id.is_empty() || entity.id.len() > 256 || !keys.insert(entity.key()) {
            return Err("配置包资料 ID 重复或无效".into());
        }
        match &entity.payload {
            PortablePayload::Preferences(value)
                if entity.id == "managed"
                    && matches!(value.theme.as_str(), "system" | "light" | "dark")
                    && value.language.as_deref().is_none_or(|language| matches!(language, "zh" | "en"))
                    && crate::domain::valid_tool_icons(&value.tool_icons) => {}
            PortablePayload::Profile(value)
                if value.profile.id == entity.id
                    && value
                        .profile
                        .connection
                        .as_ref()
                        .is_none_or(|c| c.secret_ref.is_none())
                    && value.profile.native_credentials.is_empty() => {}
            PortablePayload::Common(value) if value.tool == entity.id => {}
            PortablePayload::Project(value) if value.id == entity.id && value.name.len() <= 200 => {
            }
            PortablePayload::Library(value)
                if value.id == entity.id && value.body.len() <= 1_000_000 => {}
            PortablePayload::Mcp(value) if value.definition.id == entity.id => {}
            PortablePayload::Skill(value) if value.id == entity.id => {
                valid_skill_files(&value.files)?;
            }
            PortablePayload::Account(value)
                if snapshot.schema_version >= 3
                    && value.account.id == entity.id
                    && value.account.pending_login.is_none()
                    && value.account.context.iter().chain(&value.account.retired_contexts).all(|ctx| ctx.history_roots.is_empty())
                    && value.auth_files.iter().all(|file| valid_auth_name(&file.name) && STANDARD.decode(&file.contents).is_ok()) => {}
            PortablePayload::Binding(value)
                if snapshot.schema_version >= 3
                    && entity.id == binding_id(&value.tool, &value.scope_key)
                    && !value.profile_id.is_empty()
                    && (value.scope_key == "global" || value.scope_key.starts_with("project:")) => {}
            _ => return Err("配置包包含无效资料".into()),
        }
    }
    Ok(())
}

pub fn export_bundle(
    db: &Database,
    store: &dyn CredentialStore,
    registry: &Registry,
    password: &str,
    selected: Option<&BTreeSet<String>>,
    destination: &Path,
) -> Result<usize, String> {
    let mut snapshot = collect_snapshot(db, store, registry)?;
    if let Some(keys) = selected {
        snapshot
            .entities
            .retain(|entity| keys.contains(&entity.key()));
    }
    validate_snapshot(&snapshot)?;
    let plaintext = serde_json::to_vec(&snapshot).map_err(|_| "无法整理可迁移资料".to_string())?;
    let bytes = crypto::seal(password, "offline", &plaintext)?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|error| format!("导出只能创建新文件：{error}"))?;
    use std::io::Write;
    file.write_all(&bytes)
        .map_err(|error| format!("无法写入配置包：{error}"))?;
    Ok(snapshot.entities.len())
}

pub fn unlock_bundle(path: &Path, password: &str) -> Result<PortableSnapshot, String> {
    let size = fs::metadata(path)
        .map_err(|_| "配置包不可读取".to_string())?
        .len();
    if size > 96 * 1024 * 1024 {
        return Err("配置包超过大小限制".into());
    }
    let bytes = fs::read(path).map_err(|_| "配置包不可读取".to_string())?;
    let plaintext = crypto::open(password, "offline", &bytes)?;
    let snapshot: PortableSnapshot =
        serde_json::from_slice(&plaintext).map_err(|_| "配置包资料结构损坏".to_string())?;
    validate_snapshot(&snapshot)?;
    Ok(snapshot)
}

pub fn preview_import(
    db: &Database,
    store: &dyn CredentialStore,
    registry: &Registry,
    snapshot: PortableSnapshot,
) -> Result<ImportDraft, String> {
    validate_snapshot(&snapshot)?;
    let local = collect_snapshot(db, store, registry)?;
    let local: BTreeMap<_, _> = local
        .entities
        .into_iter()
        .map(|entity| (entity.key(), entity))
        .collect();
    let mut baseline = BTreeMap::new();
    let mut items = Vec::new();
    for entity in &snapshot.entities {
        let key = entity.key();
        let current = local.get(&key).map(PortableEntity::digest).transpose()?;
        let incoming = entity.digest()?;
        let status = match &current {
            None => "new",
            Some(digest) if digest == &incoming => "same",
            Some(_) => "conflict",
        };
        baseline.insert(key.clone(), current);
        items.push(ImportItem {
            key,
            kind: entity.kind().into(),
            tool_id: match &entity.payload {
                PortablePayload::Profile(value) => Some(value.profile.tool.clone()),
                _ => None,
            },
            label: entity.label(),
            status,
            pending_fields: entity.pending_fields(),
            local_preview: local.get(&entity.key()).map(preview_content).transpose()?,
            incoming_preview: preview_content(entity)?,
        });
    }
    Ok(ImportDraft {
        id: Uuid::new_v4().to_string(),
        snapshot,
        baseline,
        items,
    })
}

pub fn preview_dto(draft: &ImportDraft) -> ImportPreview {
    ImportPreview {
        preview_id: draft.id.clone(),
        pending_projects: draft
            .items
            .iter()
            .filter(|item| item.kind == "project")
            .count(),
        items: draft.items.clone(),
    }
}

fn credential_id() -> String {
    format!("connection-{}", Uuid::new_v4())
}

fn preview_content(entity: &PortableEntity) -> Result<String, String> {
    let mut safe = entity.clone();
    if let PortablePayload::Profile(profile) = &mut safe.payload {
        if profile.connection_secret.is_some() {
            profile.connection_secret = Some("<已设置，内容隐藏>".into());
        }
        for values in profile.native_secrets.values_mut() {
            for secret in values.values_mut() {
                *secret = "<已设置，内容隐藏>".into();
            }
        }
    }
    if let PortablePayload::Account(account) = &mut safe.payload {
        for file in &mut account.auth_files {
            file.contents = "<已设置，内容隐藏>".into();
        }
    }
    if let PortablePayload::Skill(skill) = &mut safe.payload {
        for encoded in skill.files.values_mut() {
            let bytes = STANDARD
                .decode(encoded.as_bytes())
                .map_err(|_| "Skill 资源编码损坏")?;
            *encoded = match std::str::from_utf8(&bytes) {
                Ok(text) => text.chars().take(8_000).collect(),
                Err(_) => format!(
                    "<二进制资源，{} 字节，SHA-256 {:x}>",
                    bytes.len(),
                    Sha256::digest(&bytes)
                ),
            };
        }
    }
    let text = serde_json::to_string_pretty(&safe.payload)
        .map_err(|_| "无法生成导入差异预览".to_string())?;
    let mut preview: String = text.chars().take(16_000).collect();
    if preview.len() < text.len() {
        preview.push_str("\n… 内容过长，预览已截断");
    }
    Ok(preview)
}

pub fn apply_import(
    db: &Database,
    store: &dyn CredentialStore,
    registry: &Registry,
    draft: &ImportDraft,
    selected: &BTreeSet<String>,
) -> Result<usize, String> {
    apply_import_selecting(db, store, registry, draft, selected, &BTreeSet::new())
}

/// `selected` is written. `unchanged` must still match the preview baseline but is not written.
fn apply_import_selecting(
    db: &Database,
    store: &dyn CredentialStore,
    registry: &Registry,
    draft: &ImportDraft,
    selected: &BTreeSet<String>,
    unchanged: &BTreeSet<String>,
) -> Result<usize, String> {
    if selected.iter().chain(unchanged.iter()).any(|key| !draft.baseline.contains_key(key)) {
        return Err("导入选择含未知资料".into());
    }
    let mut imported = 0;
    let mut created_secrets: Vec<String> = Vec::new();
    let mut prepared = Vec::new();
    let mut account_rows: BTreeMap<String, String> = BTreeMap::new();
    let mut issues = Vec::new();
    let roots = restore_roots(db);
    for entity in &draft.snapshot.entities {
        if !selected.contains(&entity.key())
            || draft.baseline.get(&entity.key()) == Some(&Some(entity.digest()?))
        {
            continue;
        }
        let mut entity = entity.clone();
        if let PortablePayload::Common(common) = &mut entity.payload {
            common.revision = Uuid::new_v4().to_string();
        }
        if let PortablePayload::Profile(portable) = &mut entity.payload {
            if registry.get(&portable.profile.tool).is_some() {
                crate::native::configuration::normalize_legacy(registry, &mut portable.profile, crate::native::adapter::Scope::Global, None)?;
            }
            portable.profile.revision = Uuid::new_v4().to_string();
            if let Some(secret) = portable.connection_secret.as_ref() {
                let id = credential_id();
                if let Err(error) = store.put(&id, secret) {
                    for old in created_secrets {
                        let _ = store.delete(&old);
                    }
                    return Err(error);
                }
                created_secrets.push(id.clone());
                if let Some(connection) = portable.profile.connection.as_mut() {
                    connection.secret_ref = Some(id);
                }
            }
            for (role, values) in &portable.native_secrets {
                for (name, secret) in values {
                    let id = credential_id();
                    if let Err(error) = store.put(&id, secret) {
                        for old in created_secrets {
                            let _ = store.delete(&old);
                        }
                        return Err(error);
                    }
                    created_secrets.push(id.clone());
                    portable
                        .profile
                        .native_credentials
                        .entry(role.clone())
                        .or_default()
                        .insert(name.clone(), id);
                }
            }
        }
        if let PortablePayload::Account(portable) = &entity.payload {
            let stored = account_without_context(&portable.account);
            account_rows.insert(entity.id.clone(), serde_json::to_string(&stored).map_err(|error| error.to_string())?);
        }
        prepared.push(entity);
    }
    let touched: BTreeSet<String> = prepared.iter().map(PortableEntity::key).collect();
    let result = db.with_connection(|conn| {
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        let current: BTreeMap<_, _> = collect_snapshot_on(&tx, store, registry)?
            .entities
            .into_iter()
            .map(|entity| (entity.key(), entity))
            .collect();
        for key in selected.iter().chain(unchanged.iter()) {
            let digest = current.get(key).map(PortableEntity::digest).transpose()?;
            if draft.baseline.get(key) != Some(&digest) {
                return Err("本机资料已变化，请重新预览导入".into());
            }
        }
        for entity in &prepared {
            match &entity.payload {
                PortablePayload::Preferences(value) => {
                    let preserved = current.get("preferences:managed").and_then(|entity| match &entity.payload {
                        PortablePayload::Preferences(existing) => existing.language.clone(),
                        _ => None,
                    });
                    let language = value.language.clone().filter(|language| matches!(language.as_str(), "zh" | "en"))
                        .or(preserved.filter(|language| matches!(language.as_str(), "zh" | "en")));
                    let mut body = serde_json::json!({"schema_version":1,"managed_tools":value.managed_tools,"theme":value.theme,"tool_icons":value.tool_icons});
                    if let Some(language) = language {
                        body["language"] = serde_json::Value::String(language);
                    }
                    tx.execute("INSERT INTO app_settings (key,value) VALUES ('preferences',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[body.to_string()]).map_err(|error| error.to_string())?;
                }
                PortablePayload::Project(value) => {
                    if draft.snapshot.schema_version >= 3 {
                        tx.execute("INSERT INTO projects (id,name,path,preferred_tool,last_opened) VALUES (?1,?2,?3,NULL,0) ON CONFLICT(id) DO UPDATE SET name=excluded.name, path=excluded.path",
                            params![value.id, value.name, value.path]).map_err(|error| error.to_string())?;
                    } else {
                        tx.execute("INSERT INTO projects (id,name,path,preferred_tool,last_opened) VALUES (?1,?2,NULL,NULL,0) ON CONFLICT(id) DO UPDATE SET name=excluded.name",
                            params![value.id,value.name]).map_err(|error| error.to_string())?;
                    }
                    tx.execute("DELETE FROM project_tool_models WHERE project_id=?1",[&value.id]).map_err(|error| error.to_string())?;
                    for (tool,model) in &value.model_overrides {
                        tx.execute("INSERT INTO project_tool_models (project_id,tool,model) VALUES (?1,?2,?3)",params![value.id,tool,model]).map_err(|error| error.to_string())?;
                    }
                }
                PortablePayload::Common(value) => {
                    tx.execute("INSERT INTO common_configs (tool,version,data) VALUES (?1,?2,?3) ON CONFLICT(tool) DO UPDATE SET version=excluded.version,data=excluded.data",
                        params![value.tool,value.version as i64,serde_json::to_string(value).map_err(|error| error.to_string())?]).map_err(|error| error.to_string())?;
                    crate::native::profile::invalidate_common_bindings(&tx, &value.tool)?;
                }
                PortablePayload::Profile(value) => {
                    let profile = &value.profile;
                    tx.execute("INSERT INTO native_profiles (id,tool,version,data) VALUES (?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET version=excluded.version,data=excluded.data",
                        params![profile.id,profile.tool,profile.version as i64,serde_json::to_string(profile).map_err(|error| error.to_string())?]).map_err(|error| error.to_string())?;
                    // The old native file remains in place until an explicit application succeeds.
                    tx.execute("UPDATE applied_bindings SET profile_version=-1 WHERE profile_id=?1", [&profile.id])
                        .map_err(|error| error.to_string())?;
                }
                PortablePayload::Library(value) => {
                    let kind = match value.kind { crate::library::LibraryKind::Prompt => "prompt", crate::library::LibraryKind::Rule => "rule" };
                    let project_id = value.project_id.as_ref().filter(|id| tx.query_row("SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1)",[*id],|row| row.get::<_,bool>(0)).unwrap_or(false));
                    tx.execute("INSERT INTO library_items (id,kind,title,body,category,project_id,version,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
                        ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,title=excluded.title,body=excluded.body,category=excluded.category,project_id=excluded.project_id,version=excluded.version,updated_at=excluded.updated_at",
                        params![value.id,kind,value.title,value.body,value.category,project_id,value.version as i64,value.updated_at as i64]).map_err(|error| error.to_string())?;
                }
                PortablePayload::Mcp(value) => {
                    let definition = &value.definition;
                    let updated_at = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map_or(0, |time| time.as_secs());
                    tx.execute("INSERT INTO mcp_definitions (id,name,transport,data_json,version,updated_at) VALUES (?1,?2,?3,?4,?5,?6)
                        ON CONFLICT(id) DO UPDATE SET name=excluded.name,transport=excluded.transport,data_json=excluded.data_json,version=excluded.version,updated_at=excluded.updated_at",
                        params![definition.id,definition.name,if definition.transport==crate::resources::mcp::McpTransport::Stdio {"stdio"} else {"http"},
                            serde_json::to_string(definition).map_err(|error| error.to_string())?,definition.version as i64,updated_at as i64]).map_err(|error| error.to_string())?;
                }
                PortablePayload::Skill(value) => {
                    tx.execute("INSERT INTO skill_packages (id,name,description,source,digest,files_json,updated_at) VALUES (?1,?2,?3,'迁移资料包',?4,?5,0)
                        ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,source=excluded.source,digest=excluded.digest,files_json=excluded.files_json,updated_at=excluded.updated_at",
                        params![value.id,value.name,value.description,value.digest,serde_json::to_string(&value.files).map_err(|error| error.to_string())?]).map_err(|error| error.to_string())?;
                }
                PortablePayload::Account(value) => {
                    let json = account_rows.get(&entity.id).cloned().ok_or("账号资料未准备好")?;
                    tx.execute("INSERT INTO auth_accounts (id,tool,version,data) VALUES (?1,?2,1,?3) ON CONFLICT(id) DO UPDATE SET tool=excluded.tool, version=auth_accounts.version+1, data=excluded.data",
                        params![value.account.id, value.account.tool_id, json]).map_err(|error| error.to_string())?;
                    remember_outbox(&tx, &entity.key())?;
                }
                PortablePayload::Binding(value) => {
                    // Keep the previous managed map so apply can remove owned fields. A successful
                    // apply writes the new map; a failed apply must still be able to release it.
                    tx.execute("INSERT INTO applied_bindings (scope_key,tool,profile_id,profile_version,managed,context_id) VALUES (?1,?2,?3,-1,'{}',?4)
                        ON CONFLICT(scope_key, tool) DO UPDATE SET profile_id=excluded.profile_id, profile_version=-1, context_id=excluded.context_id",
                        params![value.scope_key, value.tool, value.profile_id, value.context_id]).map_err(|error| error.to_string())?;
                    remember_outbox(&tx, &entity.key())?;
                }
            }
        }
        tx.commit().map_err(|error| error.to_string())
    });
    if let Err(error) = result {
        for id in created_secrets {
            let _ = store.delete(&id);
        }
        return Err(error);
    }
    if let Some((home, base)) = roots {
        for entity in &prepared {
            let PortablePayload::Account(portable) = &entity.payload else { continue };
            let (stored, _, account_issues) = place_account(db, portable, registry, &home, &base);
            issues.extend(account_issues);
            let key = format!("account:{}", stored.id);
            let label = stored.label.clone();
            match serde_json::to_string(&stored) {
                Ok(saved) => {
                    if let Err(error) = db.with_connection(|conn| {
                        conn.execute("UPDATE auth_accounts SET version=version+1, data=?1 WHERE id=?2", params![saved, stored.id])
                            .map(|_| ()).map_err(|error| error.to_string())
                    }) {
                        issues.push(RestoreBlocker { key, label, action: "retry".into(), detail: error });
                    }
                }
                Err(error) => issues.push(RestoreBlocker { key, label, action: "retry".into(), detail: error.to_string() }),
            }
        }
        issues.extend(apply_active_bindings(db, store, registry, &home, &touched));
    }
    if let Err(error) = store_blockers(db, &touched, &issues) {
        return Err(error);
    }
    imported += prepared.len();
    Ok(imported)
}

/// Apply only new and identical items. A differing item keeps the local row and both versions.
pub fn restore_preview(
    db: &Database,
    store: &dyn CredentialStore,
    registry: &Registry,
    draft: &ImportDraft,
) -> Result<usize, String> {
    let mut selected = BTreeSet::new();
    let mut unchanged = BTreeSet::new();
    for item in &draft.items {
        match item.status {
            "new" | "same" => { selected.insert(item.key.clone()); }
            "conflict" => { unchanged.insert(item.key.clone()); }
            _ => return Err("导入资料状态无效".into()),
        }
    }
    let imported = apply_import_selecting(db, store, registry, draft, &selected, &unchanged)?;
    remember_bundle_conflicts(db, store, registry, draft, &selected, &unchanged)?;
    Ok(imported)
}

fn remember_bundle_conflicts(
    db: &Database,
    store: &dyn CredentialStore,
    registry: &Registry,
    draft: &ImportDraft,
    applied: &BTreeSet<String>,
    conflicts: &BTreeSet<String>,
) -> Result<(), String> {
    let local: BTreeMap<_, _> = collect_snapshot(db, store, registry)?
        .entities
        .into_iter()
        .map(|entity| (entity.key(), entity))
        .collect();
    let mut created: Vec<String> = Vec::new();
    let mut held = Vec::new();
    for key in conflicts {
        let incoming = draft.snapshot.entities.iter().find(|entity| entity.key() == *key).ok_or("冲突资料缺失")?;
        let digest = incoming.digest()?;
        if local.get(key).map(PortableEntity::digest).transpose()?.as_ref() != draft.baseline.get(key).and_then(|value| value.as_ref()) {
            for id in created { let _ = store.delete(&id); }
            return Err("本机资料已变化，请重新预览导入".into());
        }
        let (entity, secret_ids) = hold_conflict_entity(store, incoming)?;
        created.extend(secret_ids);
        held.push(sync::SyncConflict {
            key: key.clone(),
            label: local.get(key).map(PortableEntity::label).unwrap_or_else(|| incoming.label()),
            local_present: local.contains_key(key),
            local_digest: local.get(key).map(PortableEntity::digest).transpose()?.unwrap_or_default(),
            remote_versions: 1,
            remote_deleted: false,
            versions: vec![sync::SyncConflictVersion {
                id: format!("bundle:{digest}"),
                digest,
                deleted: false,
                entity: Some(entity),
            }],
        });
    }
    if let Err(error) = sync::replace_conflicts(db, applied, conflicts, held) {
        for id in created { let _ = store.delete(&id); }
        return Err(error);
    }
    Ok(())
}

/// Keep API keys in the credential store. The held entity keeps references, not raw key text.
fn hold_conflict_entity(store: &dyn CredentialStore, incoming: &PortableEntity) -> Result<(PortableEntity, Vec<String>), String> {
    let mut entity = incoming.clone();
    let mut created: Vec<String> = Vec::new();
    if let PortablePayload::Profile(portable) = &mut entity.payload {
        if let Some(secret) = portable.connection_secret.take() {
            let id = credential_id();
            if let Err(error) = store.put(&id, &secret) {
                for old in created { let _ = store.delete(&old); }
                return Err(error);
            }
            created.push(id.clone());
            if let Some(connection) = portable.profile.connection.as_mut() {
                connection.secret_ref = Some(id);
            }
        }
        for (role, values) in std::mem::take(&mut portable.native_secrets) {
            for (name, secret) in values {
                let id = credential_id();
                if let Err(error) = store.put(&id, &secret) {
                    for old in created { let _ = store.delete(&old); }
                    return Err(error);
                }
                created.push(id.clone());
                portable.profile.native_credentials.entry(role.clone()).or_default().insert(name, id);
            }
        }
    }
    Ok((entity, created))
}

/// Observe committed portable rows without reading secrets. Metadata-only syncs emit nothing;
/// committed rows still notify consumers when a later target or network operation fails.
pub fn with_change_notification<T, E>(db: &Database, notify: impl FnOnce(), action: impl FnOnce() -> Result<T, E>) -> Result<T, E> {
    fn fingerprint(db: &Database) -> Result<Vec<u8>, String> {
        db.with_connection(|conn| {
            let mut digest = Sha256::new();
            for sql in [
                "SELECT value FROM app_settings WHERE key='preferences'",
                "SELECT data FROM native_profiles ORDER BY id",
                "SELECT data FROM common_configs ORDER BY tool",
                "SELECT json_array(id,name,path,preferred_tool) FROM projects ORDER BY id",
                "SELECT json_array(project_id,tool,model) FROM project_tool_models ORDER BY project_id,tool",
                "SELECT json_array(id,kind,title,body,category,project_id,version,updated_at) FROM library_items ORDER BY id",
                "SELECT data_json FROM mcp_definitions ORDER BY id",
                "SELECT json_array(id,name,description,digest,files_json) FROM skill_packages ORDER BY id",
                "SELECT data FROM auth_accounts ORDER BY id",
                "SELECT json_array(scope_key,tool,profile_id,context_id) FROM applied_bindings WHERE scope_key='global' OR scope_key LIKE 'project:%' ORDER BY tool, scope_key",
            ] {
                digest.update(sql.as_bytes());
                for row in read_rows(conn, sql, |row| row.get::<_, String>(0))? {
                    digest.update((row.len() as u64).to_le_bytes());
                    digest.update(row.as_bytes());
                }
            }
            Ok(digest.finalize().to_vec())
        })
    }
    let before = fingerprint(db);
    let result = action();
    // If observation itself failed, refresh conservatively to expose any committed changes.
    if before.is_err() || match fingerprint(db) { Ok(after) => before.as_ref().ok() != Some(&after), Err(_) => true } {
        notify();
    }
    result
}

fn remember_outbox(conn: &Connection, key: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO sync_outbox (id,entity_key,object_json,created_at) VALUES (?1,?1,hex(randomblob(16)),strftime('%s','now')) ON CONFLICT(id) DO UPDATE SET object_json=excluded.object_json, created_at=excluded.created_at",
        [key],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

pub(crate) fn binding_id(tool: &str, scope_key: &str) -> String {
    let raw = format!("{tool}\u{1f}{scope_key}");
    if raw.len() <= 200 {
        raw
    } else {
        format!("{:x}", Sha256::digest(raw.as_bytes()))
    }
}

fn valid_auth_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains(':')
        && Path::new(name).components().all(|part| matches!(part, Component::Normal(_)))
}

fn normalize_account_digest(account: &mut crate::accounts::AuthAccount) {
    account.pending_login = None;
    account.version = 0;
    account.checked_at = None;
    let contexts = account.context.iter_mut().chain(account.retired_contexts.iter_mut());
    for context in contexts {
        context.history_roots.clear();
        context.root.clear();
        context.config_root.clear();
        context.resource_root.clear();
        context.environment.clear();
        context.cli_args.clear();
        context.remove_environment.clear();
        context.auth_files = context.auth_files.iter().filter_map(|path| path.file_name().map(PathBuf::from)).collect();
        context.auth_files.sort();
        context.auth_files.dedup();
    }
}

fn portable_account(mut account: crate::accounts::AuthAccount) -> Result<(crate::accounts::AuthAccount, Vec<PortableAuthFile>), String> {
    account.pending_login = None;
    let mut auth_files = Vec::new();
    let label = account.label.clone();
    let contexts = account.context.iter_mut().chain(account.retired_contexts.iter_mut());
    for context in contexts {
        for path in &context.auth_files {
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                return Err(format!("账号 {label} 的认证文件名无效，不能当作已导出"));
            };
            if !valid_auth_name(name) {
                return Err(format!("账号 {label} 的认证文件名无效，不能当作已导出"));
            }
            let metadata = fs::metadata(path).map_err(|_| format!("账号 {label} 的认证文件无法读取，不能当作已导出"))?;
            if metadata.len() > 4 * 1024 * 1024 {
                return Err(format!("账号 {label} 的认证文件超过 4MiB，不能当作已导出"));
            }
            let bytes = fs::read(path).map_err(|_| format!("账号 {label} 的认证文件无法读取，不能当作已导出"))?;
            auth_files.push(PortableAuthFile { context_id: context.id.clone(), name: name.to_owned(), contents: STANDARD.encode(bytes) });
        }
    }
    auth_files.sort_by(|left, right| (&left.context_id, &left.name).cmp(&(&right.context_id, &right.name)));
    auth_files.dedup_by(|left, right| left.context_id == right.context_id && left.name == right.name);
    normalize_account_digest(&mut account);
    Ok((account, auth_files))
}

fn account_without_context(account: &crate::accounts::AuthAccount) -> crate::accounts::AuthAccount {
    let mut account = account.clone();
    account.pending_login = None;
    account.context = None;
    account.retired_contexts.clear();
    account.version = 1;
    account
}

fn login_executable(db: &Database, tool: &str, home: &Path) -> Option<PathBuf> {
    if let Some(path) = tool_choice(db, tool) {
        return Some(path);
    }
    // Unit tests must not probe the developer PATH. Production uses the account executable check.
    #[cfg(test)]
    {
        let _ = (db, home);
        None
    }
    #[cfg(not(test))]
    {
        crate::accounts::native::executable(db, home, tool).ok()
    }
}

fn place_account(
    db: &Database,
    portable: &PortableAccount,
    registry: &Registry,
    home: &Path,
    base: &Path,
) -> (crate::accounts::AuthAccount, Vec<PathBuf>, Vec<RestoreBlocker>) {
    let mut account = portable.account.clone();
    account.pending_login = None;
    account.version = 1;
    let mut written = Vec::new();
    let mut issues = Vec::new();
    let sources: Vec<_> = account.context.iter().cloned().chain(account.retired_contexts.iter().cloned()).collect();
    let retired_ids: BTreeSet<_> = account.retired_contexts.iter().map(|context| context.id.clone()).collect();
    let primary_id = account.context.as_ref().map(|context| context.id.clone());
    let mut placed = Vec::new();
    for source in sources {
        let root = base.join("accounts").join(&source.id);
        let local = match crate::accounts::context::context_at_registered(registry, root, &account.tool_id, source.id.clone()) {
            Ok(local) => local,
            Err(error) => {
                issues.push(RestoreBlocker {
                    key: format!("account:{}", account.id),
                    label: account.label.clone(),
                    action: "relogin".into(),
                    detail: error,
                });
                continue;
            }
        };
        for path in &local.auth_files {
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else { continue };
            let Some(file) = portable.auth_files.iter().find(|file| file.context_id == source.id && file.name == name) else { continue };
            match STANDARD.decode(&file.contents) {
                Ok(bytes) => {
                    if let Some(parent) = path.parent() {
                        if fs::create_dir_all(parent).is_err() {
                            issues.push(RestoreBlocker { key: format!("account:{}", account.id), label: account.label.clone(), action: "relogin".into(), detail: format!("无法创建认证目录 {}", parent.display()) });
                            continue;
                        }
                    }
                    if let Err(error) = fs::write(path, &bytes) {
                        issues.push(RestoreBlocker { key: format!("account:{}", account.id), label: account.label.clone(), action: "relogin".into(), detail: format!("无法写入认证文件：{error}") });
                    } else {
                        written.push(path.clone());
                    }
                }
                Err(_) => issues.push(RestoreBlocker { key: format!("account:{}", account.id), label: account.label.clone(), action: "relogin".into(), detail: format!("认证文件 {name} 损坏") }),
            }
        }
        placed.push(local);
    }
    account.context = primary_id.as_ref().and_then(|id| placed.iter().find(|context| &context.id == id).cloned());
    account.retired_contexts = placed.into_iter().filter(|context| retired_ids.contains(&context.id)).collect();
    if account.state == crate::accounts::AccountState::SignedIn {
        if let Some(context) = &account.context {
            if let Some(executable) = login_executable(db, &account.tool_id, home) {
                if executable.is_file() {
                    match crate::accounts::native::observe(&executable, context) {
                        Ok(observation) if observation.state == crate::accounts::AccountState::SignedIn => {}
                        Ok(observation) => issues.push(RestoreBlocker {
                            key: format!("account:{}", account.id),
                            label: account.label.clone(),
                            action: "relogin".into(),
                            detail: observation.detail.unwrap_or_else(|| "登录被拒绝，材料已保留，需要重新登录".into()),
                        }),
                        Err(error) => issues.push(RestoreBlocker {
                            key: format!("account:{}", account.id),
                            label: account.label.clone(),
                            action: "relogin".into(),
                            detail: format!("登录未被接受，材料已保留：{error}"),
                        }),
                    }
                }
            }
        }
    }
    (account, written, issues)
}

fn tool_choice(db: &Database, tool: &str) -> Option<PathBuf> {
    db.with_connection(|conn| {
        conn.query_row("SELECT path FROM installation_choices WHERE tool=?1", [tool], |row| row.get::<_, String>(0))
            .optional()
            .map_err(|error| error.to_string())
    }).ok().flatten().map(PathBuf::from)
}

fn apply_active_bindings(
    db: &Database,
    store: &dyn CredentialStore,
    registry: &Registry,
    home: &Path,
    touched: &BTreeSet<String>,
) -> Vec<RestoreBlocker> {
    let relevant = touched.iter().any(|key| {
        key.starts_with("profile:") || key.starts_with("binding:") || key.starts_with("common:") || key.starts_with("project:") || key.starts_with("account:")
    });
    if !relevant {
        return Vec::new();
    }
    let (project_paths, account_tools) = db.with_connection(|conn| {
        let projects = read_rows(conn, "SELECT id,path FROM projects WHERE path IS NOT NULL", |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
        let accounts = read_rows(conn, "SELECT id,tool FROM auth_accounts", |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
        Ok::<_, String>((projects, accounts))
    }).unwrap_or_default();
    let project_paths: BTreeSet<String> = project_paths.into_iter()
        .filter(|(id, _)| touched.contains(&format!("project:{id}")))
        .map(|(_, path)| path)
        .collect();
    let account_tools: BTreeSet<String> = account_tools.into_iter()
        .filter(|(id, _)| touched.contains(&format!("account:{id}")))
        .map(|(_, tool)| tool)
        .collect();
    let rows = db.with_connection(|conn| {
        read_rows(conn, "SELECT scope_key,tool,profile_id FROM applied_bindings WHERE scope_key='global' OR scope_key LIKE 'project:%' ORDER BY tool, scope_key",
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)))
    }).unwrap_or_default();
    let mut issues = Vec::new();
    for (scope_key, tool, profile_id) in rows {
        let binding_key = format!("binding:{}", binding_id(&tool, &scope_key));
        let profile_key = format!("profile:{profile_id}");
        let common_key = format!("common:{tool}");
        let selected = touched.contains(&binding_key)
            || touched.contains(&profile_key)
            || touched.contains(&common_key)
            || scope_key.strip_prefix("project:").is_some_and(|path| project_paths.contains(path))
            || account_tools.contains(&tool);
        if !selected {
            continue;
        }
        let label = format!("{tool} 活动配置");
        let scope = if scope_key == "global" {
            Ok((crate::native::adapter::Scope::Global, None))
        } else if let Some(path) = scope_key.strip_prefix("project:") {
            let path = PathBuf::from(path);
            if path.is_dir() { Ok((crate::native::adapter::Scope::Project, Some(path))) } else { Err(format!("目录不存在：{}", path.display())) }
        } else {
            Err("不支持的活动范围".into())
        };
        let result = scope.and_then(|(scope, project)| {
            let custom = tool_choice(db, &tool);
            crate::native::apply::apply_registered_profile(registry, db, store, &tool, &profile_id, scope, home, project.as_deref(), custom.as_deref(), true)
                .map(|_| ())
        });
        if let Err(error) = result {
            let action = if error.contains("目录") { "relink" } else if error.contains("未发现") || error.contains("未注册") || error.contains("不能探测") { "install" } else { "retry" };
            issues.push(RestoreBlocker { key: binding_key, label, action: action.into(), detail: error });
        }
    }
    issues
}

pub(crate) fn load_blockers(db: &Database) -> Result<Vec<RestoreBlocker>, String> {
    db.with_connection(|conn| {
        let value: Option<String> = conn.query_row("SELECT value FROM app_settings WHERE key='sync_blockers'", [], |row| row.get(0))
            .optional().map_err(|error| error.to_string())?;
        value.map(|text| serde_json::from_str(&text).map_err(|_| "同步阻塞记录损坏".to_string())).transpose().map(|items| items.unwrap_or_default())
    })
}

fn store_blockers(db: &Database, touched: &BTreeSet<String>, issues: &[RestoreBlocker]) -> Result<(), String> {
    let mut current = load_blockers(db)?;
    current.retain(|item| !touched.contains(&item.key) && !issues.iter().any(|issue| issue.key == item.key));
    current.extend(issues.iter().cloned());
    db.with_connection(|conn| {
        conn.execute("INSERT INTO app_settings (key,value) VALUES ('sync_blockers',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [serde_json::to_string(&current).map_err(|error| error.to_string())?]).map(|_| ()).map_err(|error| error.to_string())
    })
}

/// Remove one active binding from the native file after the database row is gone.
/// Failure is reported and does not restore the deleted row.
pub(crate) fn release_native_binding(
    db: &Database,
    registry: &Registry,
    tool: &str,
    scope_key: &str,
    managed_json: &str,
) -> Result<(), String> {
    let Some((home, _)) = restore_roots(db) else { return Ok(()) };
    let (scope, project) = if scope_key == "global" {
        (crate::native::adapter::Scope::Global, None)
    } else if let Some(path) = scope_key.strip_prefix("project:") {
        let path = PathBuf::from(path);
        if !path.is_dir() {
            return Err(format!("目录不存在：{}", path.display()));
        }
        (crate::native::adapter::Scope::Project, Some(path))
    } else {
        return Ok(());
    };
    let probe = crate::native::adapter::probe_registered(registry, tool, tool_choice(db, tool).as_deref(), &home, project.as_deref(), scope)?;
    if probe.native_writes.state != "supported" {
        return Err(probe.native_writes.reason.into());
    }
    let managed: BTreeMap<String, BTreeMap<String, serde_json::Value>> = serde_json::from_str(managed_json).unwrap_or_default();
    for file in &probe.native_files {
        let Some(fields) = managed.get(file.role) else { continue };
        if !file.writable || !Path::new(&file.path).is_file() { continue; }
        let kind = match file.format { "toml" => FileKind::Toml, "yaml" => FileKind::Yaml, "jsonc" => FileKind::Jsonc, _ => FileKind::Json };
        let mut text = fs::read_to_string(&file.path).map_err(|error| error.to_string())?;
        for pointer in fields.keys() {
            let path = pointer_path(pointer);
            if path.is_empty() { continue; }
            text = format::set_path(kind, &text, &path, None)?;
        }
        fs::write(&file.path, text).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn pointer_path(pointer: &str) -> Vec<String> {
    pointer.split('/').skip(1).map(|segment| segment.replace("~1", "/").replace("~0", "~")).filter(|segment| !segment.is_empty()).collect()
}

pub(crate) fn record_blocker(db: &Database, blocker: RestoreBlocker) {
    let mut current = load_blockers(db).unwrap_or_default();
    current.retain(|item| item.key != blocker.key);
    current.push(blocker);
    let _ = db.with_connection(|conn| {
        conn.execute("INSERT INTO app_settings (key,value) VALUES ('sync_blockers',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [serde_json::to_string(&current).unwrap_or_else(|_| "[]".into())]).map(|_| ()).map_err(|error| error.to_string())
    });
}

#[cfg(test)]
thread_local! {
    static RESTORE_ROOTS: std::cell::RefCell<Option<(PathBuf, PathBuf)>> = const { std::cell::RefCell::new(None) };
}

fn restore_roots(db: &Database) -> Option<(PathBuf, PathBuf)> {
    #[cfg(test)]
    {
        let _ = db;
        return RESTORE_ROOTS.with(|cell| cell.borrow().clone());
    }
    #[cfg(not(test))]
    {
        let home = dirs::home_dir()?;
        let base = db.with_connection(|conn| Ok(conn.path().and_then(|path| Path::new(path).parent().map(Path::to_path_buf)))).ok().flatten()?;
        Some((home, base))
    }
}

#[cfg(test)]
pub(crate) fn set_restore_roots_for_test(roots: Option<(PathBuf, PathBuf)>) {
    RESTORE_ROOTS.with(|cell| *cell.borrow_mut() = roots);
}

#[cfg(test)]
#[path = "../../tests/migration/migration.rs"]
mod tests;
