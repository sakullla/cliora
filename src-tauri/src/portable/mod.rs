pub mod crypto;
pub mod sync;

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::path::{Component, Path};

use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::credentials::CredentialStore;
use crate::database::Database;
use crate::library::LibraryItem;
use crate::native::adapters::Registry;
use crate::native::format::{self, FileKind};
use crate::native::profile::{RegisteredCommon, RegisteredProfile};
use crate::resources::mcp::McpDefinition;

const SNAPSHOT_VERSION: u32 = 1;
const MAX_ENTITIES: usize = 10_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortablePreferences {
    pub managed_tools: Vec<String>,
    pub theme: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub tool_icons: BTreeMap<String, String>,
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
    pub model_overrides: BTreeMap<String, String>,
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
        }
    }
    pub fn pending_fields(&self) -> Vec<String> {
        match &self.payload {
            PortablePayload::Profile(value) => value.pending_fields.clone(),
            PortablePayload::Project(_) => vec!["项目本机目录".into()],
            PortablePayload::Mcp(value) => value.pending_fields.clone(),
            PortablePayload::Skill(value) => value.pending_fields.clone(),
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

fn scrub_value(value: Value, path: &str, pending: &mut Vec<String>) -> Option<Value> {
    match value {
        Value::Object(object) => {
            let mut clean = serde_json::Map::new();
            for (key, value) in object {
                let location = format!("{path}.{key}");
                if unsafe_field(&key) {
                    pending.push(location);
                    continue;
                }
                if let Some(value) = scrub_value(value, &location, pending) {
                    clean.insert(key, value);
                }
            }
            Some(Value::Object(clean))
        }
        Value::Array(items) => Some(Value::Array(
            items
                .into_iter()
                .enumerate()
                .filter_map(|(index, item)| scrub_value(item, &format!("{path}[{index}]"), pending))
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
                    if let Some(value) = scrub_value(value, &format!("{role}.{key}"), &mut pending)
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
        let projects = read_rows(conn, "SELECT id,name FROM projects ORDER BY id", |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
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
        }),
    });
    }
    for text in profiles {
        let mut profile: RegisteredProfile =
            serde_json::from_str(&text).map_err(|_| "命名配置格式错误")?;
        profile.revision.clear();
        let (files, mut pending_fields) = portable_files(registry, &profile.tool, &profile.files)?;
        profile.files = files;
        let connection_secret = if let Some(connection) = profile.connection.as_mut() {
            connection
                .secret_ref
                .take()
                .map(|id| store.get(&id))
                .transpose()?
        } else {
            None
        };
        let mut native_secrets = BTreeMap::new();
        if matches!(profile.authentication, crate::native::profile::ProfileAuthentication::OAuth { .. }) { profile.authentication=crate::native::profile::ProfileAuthentication::RebindRequired; pending_fields.push("OAuth 账号需要在此设备重新绑定".into()); }
        for (role, credentials) in std::mem::take(&mut profile.native_credentials) {
            if role == "auth" || role == "local_auth" {
                pending_fields.push(format!("{role} 本机登录凭据"));
                continue;
            }
            let mut values = BTreeMap::new();
            for (name, id) in credentials {
                if name.to_ascii_lowercase().contains("oauth")
                    || name.to_ascii_lowercase().contains("session")
                {
                    pending_fields.push(format!("{role}.{name} 本机登录凭据"));
                } else {
                    values.insert(name, store.get(&id)?);
                }
            }
            native_secrets.insert(role, values);
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
    for (id, name) in projects {
        entities.push(PortableEntity {
            id: id.clone(),
            payload: PortablePayload::Project(PortableProject {
                id: id.clone(),
                name,
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
    if entities.len() > MAX_ENTITIES {
        return Err("可迁移资料超过 10000 项".into());
    }
    Ok(PortableSnapshot {
        schema_version: SNAPSHOT_VERSION,
        entities,
    })
}

pub fn validate_snapshot(snapshot: &PortableSnapshot) -> Result<(), String> {
    if snapshot.schema_version != SNAPSHOT_VERSION || snapshot.entities.len() > MAX_ENTITIES {
        return Err("配置包资料版本或数量不受支持".into());
    }
    let mut keys = HashSet::new();
    for entity in &snapshot.entities {
        if entity.id.is_empty() || entity.id.len() > 256 || !keys.insert(entity.key()) {
            return Err("配置包资料 ID 重复或无效".into());
        }
        match &entity.payload {
            PortablePayload::Preferences(value)
                if entity.id == "managed"
                    && matches!(value.theme.as_str(), "system" | "light" | "dark")
                    && crate::domain::valid_tool_icons(&value.tool_icons) => {}
            PortablePayload::Profile(value)
                if value.profile.id == entity.id
                    && value
                        .profile
                        .connection
                        .as_ref()
                        .is_none_or(|c| c.secret_ref.is_none())
                    && value.profile.native_credentials.is_empty()
                    && !matches!(value.profile.authentication, crate::native::profile::ProfileAuthentication::OAuth { .. }) => {}
            PortablePayload::Common(value) if value.tool == entity.id => {}
            PortablePayload::Project(value) if value.id == entity.id && value.name.len() <= 200 => {
            }
            PortablePayload::Library(value)
                if value.id == entity.id && value.body.len() <= 1_000_000 => {}
            PortablePayload::Mcp(value) if value.definition.id == entity.id => {}
            PortablePayload::Skill(value) if value.id == entity.id => {
                valid_skill_files(&value.files)?;
            }
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
    if selected.iter().any(|key| !draft.baseline.contains_key(key)) {
        return Err("导入选择含未知资料".into());
    }
    let mut imported = 0;
    let mut created_secrets: Vec<String> = Vec::new();
    let mut prepared = Vec::new();
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
        prepared.push(entity);
    }
    let result = db.with_connection(|conn| {
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        let current: BTreeMap<_, _> = collect_snapshot_on(&tx, store, registry)?
            .entities
            .into_iter()
            .map(|entity| (entity.key(), entity))
            .collect();
        for key in selected {
            let digest = current.get(key).map(PortableEntity::digest).transpose()?;
            if draft.baseline.get(key) != Some(&digest) {
                return Err("本机资料已变化，请重新预览导入".into());
            }
        }
        for entity in &prepared {
            match &entity.payload {
                PortablePayload::Preferences(value) => {
                    let json = serde_json::json!({"schema_version":1,"managed_tools":value.managed_tools,"theme":value.theme,"tool_icons":value.tool_icons}).to_string();
                    tx.execute("INSERT INTO app_settings (key,value) VALUES ('preferences',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[json]).map_err(|error| error.to_string())?;
                }
                PortablePayload::Project(value) => {
                    tx.execute("INSERT INTO projects (id,name,path,preferred_tool,last_opened) VALUES (?1,?2,NULL,NULL,0) ON CONFLICT(id) DO UPDATE SET name=excluded.name",
                        params![value.id,value.name]).map_err(|error| error.to_string())?;
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
                    tx.execute("INSERT INTO mcp_definitions (id,name,transport,data_json,version) VALUES (?1,?2,?3,?4,?5)
                        ON CONFLICT(id) DO UPDATE SET name=excluded.name,transport=excluded.transport,data_json=excluded.data_json,version=excluded.version",
                        params![definition.id,definition.name,if definition.transport==crate::resources::mcp::McpTransport::Stdio {"stdio"} else {"http"},
                            serde_json::to_string(definition).map_err(|error| error.to_string())?,definition.version as i64]).map_err(|error| error.to_string())?;
                }
                PortablePayload::Skill(value) => {
                    tx.execute("INSERT INTO skill_packages (id,name,description,source,digest,files_json,updated_at) VALUES (?1,?2,?3,'迁移资料包',?4,?5,0)
                        ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,source=excluded.source,digest=excluded.digest,files_json=excluded.files_json,updated_at=excluded.updated_at",
                        params![value.id,value.name,value.description,value.digest,serde_json::to_string(&value.files).map_err(|error| error.to_string())?]).map_err(|error| error.to_string())?;
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
    imported += prepared.len();
    Ok(imported)
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

#[cfg(test)]
#[path = "../../tests/migration/migration.rs"]
mod tests;
