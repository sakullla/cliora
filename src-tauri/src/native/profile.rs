use std::collections::BTreeMap;

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::format::{self, FileKind};
use crate::database::Database;
use crate::domain::CliId;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProfileAuthentication {
    #[default]
    Native,
    ApiKey,
    #[serde(rename = "oauth")]
    OAuth { #[serde(rename = "accountId")] account_id: String },
    RebindRequired,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub provider_id: String,
    pub interface_format: String,
    pub base_url: String,
    pub model: String,
    pub secret_ref: Option<String>,
    #[serde(default)]
    pub auth_env_var: Option<String>,
}

/// Environment name used by the launcher's child process and by profiles
/// that explicitly use a native environment reference.
pub fn auth_env_name(tool: CliId, connection: &Connection) -> Option<String> {
    super::adapters::known(tool).auth_env_name(connection)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeProfile {
    pub id: String,
    pub tool: CliId,
    pub name: String,
    pub version: u64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub revision: String,
    pub inherit_common: bool,
    pub files: BTreeMap<String, String>,
    #[serde(default)]
    pub suppressed: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub authentication: ProfileAuthentication,
    pub connection: Option<Connection>,
    /// Opaque keyring IDs for credentials removed from native file roles.
    /// The outer key is the file role; the inner key is the CLI environment name.
    #[serde(default)]
    pub native_credentials: BTreeMap<String, BTreeMap<String, String>>,
}

/// Open-ID storage shape. Legacy `NativeProfile` remains the five-tool IPC
/// facade while every registered adapter uses this same persistence shape.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredProfile {
    pub id: String,
    pub tool: String,
    pub name: String,
    pub version: u64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub revision: String,
    pub inherit_common: bool,
    pub files: BTreeMap<String, String>,
    #[serde(default)]
    pub suppressed: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub authentication: ProfileAuthentication,
    pub connection: Option<Connection>,
    #[serde(default)]
    pub native_credentials: BTreeMap<String, BTreeMap<String, String>>,
}

impl From<NativeProfile> for RegisteredProfile {
    fn from(profile: NativeProfile) -> Self {
        Self {
            id: profile.id,
            tool: profile.tool.stable_id().into(),
            name: profile.name,
            version: profile.version,
            revision: profile.revision,
            inherit_common: profile.inherit_common,
            files: profile.files,
            suppressed: profile.suppressed,
            authentication: profile.authentication,
            connection: profile.connection,
            native_credentials: profile.native_credentials,
        }
    }
}

impl TryFrom<RegisteredProfile> for NativeProfile {
    type Error = String;
    fn try_from(profile: RegisteredProfile) -> Result<Self, Self::Error> {
        Ok(Self {
            id: profile.id,
            tool: CliId::from_stable_id(&profile.tool).ok_or("未注册 CLI 的配置只能只读保留")?,
            name: profile.name,
            version: profile.version,
            revision: profile.revision,
            inherit_common: profile.inherit_common,
            files: profile.files,
            suppressed: profile.suppressed,
            authentication: profile.authentication,
            connection: profile.connection,
            native_credentials: profile.native_credentials,
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommonConfig {
    pub tool: CliId,
    pub version: u64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub revision: String,
    pub files: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredCommon {
    pub tool: String,
    pub version: u64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub revision: String,
    pub files: BTreeMap<String, String>,
}

impl From<CommonConfig> for RegisteredCommon {
    fn from(common: CommonConfig) -> Self {
        Self {
            tool: common.tool.stable_id().into(),
            version: common.version,
            revision: common.revision,
            files: common.files,
        }
    }
}

impl TryFrom<RegisteredCommon> for CommonConfig {
    type Error = String;
    fn try_from(common: RegisteredCommon) -> Result<Self, Self::Error> {
        Ok(Self {
            tool: CliId::from_stable_id(&common.tool).ok_or("未注册 CLI 的通用配置只能只读保留")?,
            version: common.version,
            revision: common.revision,
            files: common.files,
        })
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveFile {
    pub role: String,
    pub contents: serde_json::Value,
    pub source_by_path: BTreeMap<String, String>,
}

pub fn file_kind(tool: CliId, role: &str) -> Result<FileKind, String> {
    super::adapters::known(tool).file_kind(role)
}

pub fn validate_registered_files(
    registry: &super::adapters::Registry,
    id: &str,
    files: &BTreeMap<String, String>,
) -> Result<(), String> {
    let adapter = registry
        .get(id)
        .ok_or("未注册的 CLI 适配器，不能保存配置")?;
    for (role, text) in files {
        if text.len() > 2_000_000 {
            return Err("单个配置文件超过 2 MB 限制".into());
        }
        let parsed = format::parse(adapter.file_kind(role)?, text)?;
        if parsed.to_string().len() > 2_000_000 {
            return Err("单个配置文件解析后超过 2 MB 限制".into());
        }
        reject_plaintext_secrets(&parsed)?;
        adapter.validate_draft(role, &parsed)?;
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn validate_files(tool: CliId, files: &BTreeMap<String, String>) -> Result<(), String> {
    validate_registered_files(
        &super::adapters::Registry::builtins(),
        tool.stable_id(),
        files,
    )
}

pub(crate) fn valid_env_name(name: &str) -> bool {
    name.chars()
        .next()
        .is_some_and(|first| first.is_ascii_uppercase() || first == '_')
        && name.chars().all(|character| {
            character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'
        })
}

pub(crate) fn env_ref_name(value: &str) -> Option<&str> {
    let name = value
        .strip_prefix("{env:")
        .and_then(|tail| tail.strip_suffix('}'))
        .or_else(|| {
            value
                .strip_prefix("${")
                .and_then(|tail| tail.strip_suffix('}'))
        })
        .or_else(|| value.strip_prefix('$'))?;
    valid_env_name(name).then_some(name)
}

fn reject_plaintext_secrets(value: &serde_json::Value) -> Result<(), String> {
    fn visit(value: &serde_json::Value, path: &mut Vec<String>) -> Result<(), String> {
        match value {
            serde_json::Value::Object(map) => {
                for (key, value) in map {
                    path.push(key.clone());
                    visit(value, path)?;
                    path.pop();
                }
            }
            serde_json::Value::Array(items) => {
                for item in items {
                    visit(item, path)?;
                }
            }
            serde_json::Value::String(value) => {
                let key = path
                    .last()
                    .map(|value| value.to_ascii_lowercase())
                    .unwrap_or_default();
                let sensitive = matches!(
                    key.as_str(),
                    "apikey"
                        | "api_key"
                        | "anthropic_api_key"
                        | "anthropic_auth_token"
                        | "authorization"
                        | "password"
                        | "secret"
                        | "token"
                        | "experimental_bearer_token"
                );
                if sensitive && env_ref_name(value).is_none() {
                    return Err(format!(
                        "原生字段 {} 可能包含明文密钥；请使用 CLI 原生登录或环境变量引用",
                        path.join(".")
                    ));
                }
            }
            _ => {}
        }
        Ok(())
    }
    visit(value, &mut Vec::new())
}

pub fn resolve_file(
    profile: &NativeProfile,
    common: Option<&CommonConfig>,
    role: &str,
) -> Result<EffectiveFile, String> {
    let registered = RegisteredProfile::from(profile.clone());
    let common = common.cloned().map(RegisteredCommon::from);
    resolve_registered_file(
        &super::adapters::Registry::builtins(),
        &registered,
        common.as_ref(),
        role,
    )
}

pub fn resolve_registered_file(
    registry: &super::adapters::Registry,
    profile: &RegisteredProfile,
    common: Option<&RegisteredCommon>,
    role: &str,
) -> Result<EffectiveFile, String> {
    let kind = registry
        .get(&profile.tool)
        .ok_or("未注册的 CLI 适配器，不能解析配置")?
        .file_kind(role)?;
    let own = format::parse(
        kind,
        profile.files.get(role).map(String::as_str).unwrap_or(""),
    )?;
    let base = if profile.inherit_common {
        match common {
            Some(common) if common.tool == profile.tool => format::parse(
                kind,
                common.files.get(role).map(String::as_str).unwrap_or(""),
            )?,
            _ => return Err("此配置继承通用配置，但通用配置不存在".into()),
        }
    } else {
        serde_json::json!({})
    };
    let (contents, source_by_path) = format::resolve(
        &base,
        &own,
        profile
            .suppressed
            .get(role)
            .map(Vec::as_slice)
            .unwrap_or(&[]),
    )?;
    Ok(EffectiveFile {
        role: role.into(),
        contents,
        source_by_path,
    })
}

pub fn list_profiles(db: &Database, tool: CliId) -> Result<Vec<NativeProfile>, String> {
    list_registered_profiles(db, tool.stable_id())?
        .into_iter()
        .map(NativeProfile::try_from)
        .collect()
}

pub fn list_registered_profiles(
    db: &Database,
    tool: &str,
) -> Result<Vec<RegisteredProfile>, String> {
    db.with_connection(|conn| {
        let mut statement = conn
            .prepare("SELECT data FROM native_profiles WHERE tool = ?1 ORDER BY id")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([tool], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|row| {
            serde_json::from_str(&row.map_err(|e| e.to_string())?)
                .map_err(|e| format!("命名配置格式无法识别：{e}"))
        })
        .collect()
    })
}

pub fn get_profile(db: &Database, id: &str) -> Result<NativeProfile, String> {
    NativeProfile::try_from(get_registered_profile(db, id)?)
}

pub fn get_registered_profile(db: &Database, id: &str) -> Result<RegisteredProfile, String> {
    db.with_connection(|conn| {
        let json: Option<String> = conn
            .query_row(
                "SELECT data FROM native_profiles WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        serde_json::from_str(&json.ok_or("命名配置不存在")?)
            .map_err(|e| format!("命名配置格式无法识别：{e}"))
    })
}

pub(crate) fn validate_connection(connection: &Connection) -> Result<(), String> {
    if connection.provider_id.trim().is_empty() {
        return Err("供应商 ID 不能为空".into());
    }
    if connection.provider_id.len() > 80
        || !connection
            .provider_id
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_alphanumeric())
        || !connection.provider_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
        })
    {
        return Err("供应商 ID 只能使用字母、数字、点、连字符和下划线".into());
    }
    if connection.model.trim().is_empty() {
        return Err("模型 ID 不能为空".into());
    }
    if connection.model.len() > 200 || connection.model.chars().any(char::is_control) {
        return Err("模型 ID 不能包含控制字符或超过 200 个字符".into());
    }
    if connection.base_url.trim().is_empty() {
        return Err("连接地址不能为空".into());
    }
    let url = url::Url::parse(&connection.base_url).map_err(|_| "连接地址不是有效 URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.query().is_some()
    {
        return Err("连接地址须为不含凭据、查询和片段的 HTTP(S) URL".into());
    }
    if url.scheme() == "http"
        && !matches!(
            url.host_str(),
            Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
        )
    {
        return Err("远程供应商地址须使用 HTTPS".into());
    }
    if connection
        .auth_env_var
        .as_deref()
        .is_some_and(|value| !valid_env_name(value))
    {
        return Err("认证环境变量名称只能包含大写字母、数字和下划线".into());
    }
    if connection
        .secret_ref
        .as_deref()
        .is_some_and(|id| !valid_connection_secret_ref(id))
    {
        return Err("连接密钥标识无效；请重新保存密钥".into());
    }
    Ok(())
}

pub(crate) fn validate_native_credentials(profile: &NativeProfile) -> Result<(), String> {
    validate_registered_native_credentials(
        &super::adapters::Registry::builtins(),
        &RegisteredProfile::from(profile.clone()),
    )
}

pub fn validate_registered_native_credentials(
    registry: &super::adapters::Registry,
    profile: &RegisteredProfile,
) -> Result<(), String> {
    let adapter = registry
        .get(&profile.tool)
        .ok_or("未注册的 CLI 适配器，不能使用原生凭据")?;
    for (role, credentials) in &profile.native_credentials {
        for (name, id) in credentials {
            if !adapter.accepts_native_credential(role, name) || !valid_connection_secret_ref(id) {
                return Err("原生凭据标识无效，请重新安全接入".into());
            }
        }
    }
    Ok(())
}

pub fn save_profile(
    db: &Database,
    profile: NativeProfile,
    expected_version: Option<u64>,
) -> Result<NativeProfile, String> {
    NativeProfile::try_from(save_registered_profile(
        db,
        &super::adapters::Registry::builtins(),
        profile.into(),
        expected_version,
    )?)
}

pub fn save_registered_profile(
    db: &Database,
    registry: &super::adapters::Registry,
    mut profile: RegisteredProfile,
    expected_version: Option<u64>,
) -> Result<RegisteredProfile, String> {
    registry
        .get(&profile.tool)
        .ok_or("未注册的 CLI 适配器，不能保存配置")?;
    if profile.name.trim().is_empty() {
        return Err("请输入配置名称".into());
    }
    if profile.name.chars().count() > 100 {
        return Err("配置名称不能超过 100 个字符".into());
    }
    match &profile.authentication {
        ProfileAuthentication::OAuth { account_id } => {
            let account = crate::accounts::get(db, account_id)?;
            if account.tool_id != profile.tool { return Err("账号属于另一个 CLI".into()); }
            if profile.connection.is_some() || !profile.native_credentials.is_empty() { return Err("OAuth 配置不能同时包含 API Key 连接或原生密钥".into()); }
        }
        ProfileAuthentication::ApiKey if profile.connection.is_none() => return Err("API Key 配置需要连接设置".into()),
        _ => (),
    }
    validate_registered_files(registry, &profile.tool, &profile.files)?;
    validate_registered_native_credentials(registry, &profile)?;
    if let Some(connection) = &profile.connection {
        validate_connection(connection)?;
    }
    db.with_connection(|conn| {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        if profile.id.is_empty() {
            if expected_version.is_some() { return Err("新建配置不能携带旧版本".into()); }
            profile.id = Uuid::new_v4().to_string();
            profile.version = 1;
        } else {
            let old: Option<(String, i64, String)> = tx.query_row("SELECT tool, version, data FROM native_profiles WHERE id = ?1", [&profile.id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional().map_err(|e| e.to_string())?;
            let (old_tool, current, data) = old.ok_or("命名配置不存在")?;
            let old: RegisteredProfile = serde_json::from_str(&data).map_err(|e| e.to_string())?;
            if old_tool != profile.tool { return Err("不能修改配置所属工具".into()); }
            if Some(current as u64) != expected_version || old.revision != profile.revision { return Err("命名配置已由其他操作修改，请重新读取".into()); }
            profile.version = current as u64 + 1;
        }
        profile.revision = Uuid::new_v4().to_string();
        let json = serde_json::to_string(&profile).map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO native_profiles (id, tool, version, data) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(id) DO UPDATE SET version = excluded.version, data = excluded.data", params![profile.id, profile.tool, profile.version as i64, json]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(profile)
    })
}

pub fn valid_connection_secret_ref(id: &str) -> bool {
    id.strip_prefix("connection-")
        .is_some_and(|uuid| Uuid::parse_str(uuid).is_ok())
}

pub fn delete_profile(db: &Database, id: &str, expected_version: u64, expected_revision: &str) -> Result<(), String> {
    delete_registered_profile(
        db,
        &super::adapters::Registry::builtins(),
        id,
        expected_version,
        expected_revision,
    )
}

pub fn delete_registered_profile(
    db: &Database,
    registry: &super::adapters::Registry,
    id: &str,
    expected_version: u64,
    expected_revision: &str,
) -> Result<(), String> {
    db.with_connection(|conn| {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let bound: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM applied_bindings WHERE profile_id = ?1 AND scope_key NOT LIKE 'context:%'",
                [id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if bound != 0 {
            return Err("配置仍在使用；请先切换到其他配置或保留原生文件".into());
        }
        let data: Option<String> = tx
            .query_row(
                "SELECT data FROM native_profiles WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let data = data.ok_or("配置不存在或版本已变化")?;
        let profile: RegisteredProfile = serde_json::from_str(&data).map_err(|e| e.to_string())?;
        if registry.get(&profile.tool).is_none() {
            return Err("未注册的 CLI 适配器，只能只读保留原资料".into());
        }
        if profile.revision != expected_revision {
            return Err("配置不存在或版本已变化，请重新读取".into());
        }
        let changed = tx
            .execute(
                "DELETE FROM native_profiles WHERE id = ?1 AND version = ?2",
                params![id, expected_version as i64],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err("配置不存在或版本已变化".into());
        }
        tx.commit().map_err(|e| e.to_string())
    })
}

pub fn get_common(db: &Database, tool: CliId) -> Result<Option<CommonConfig>, String> {
    get_registered_common(db, tool.stable_id())?
        .map(CommonConfig::try_from)
        .transpose()
}

pub fn get_registered_common(
    db: &Database,
    tool: &str,
) -> Result<Option<RegisteredCommon>, String> {
    db.with_connection(|conn| {
        let json: Option<String> = conn
            .query_row(
                "SELECT data FROM common_configs WHERE tool = ?1",
                [tool],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        json.map(|text| {
            serde_json::from_str(&text).map_err(|e| format!("通用配置格式无法识别：{e}"))
        })
        .transpose()
    })
}

pub fn save_common(
    db: &Database,
    common: CommonConfig,
    expected_version: Option<u64>,
) -> Result<CommonConfig, String> {
    CommonConfig::try_from(save_registered_common(
        db,
        &super::adapters::Registry::builtins(),
        common.into(),
        expected_version,
    )?)
}

pub fn save_registered_common(
    db: &Database,
    registry: &super::adapters::Registry,
    mut common: RegisteredCommon,
    expected_version: Option<u64>,
) -> Result<RegisteredCommon, String> {
    validate_registered_files(registry, &common.tool, &common.files)?;
    db.with_connection(|conn| {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let old: Option<(i64, String)> = tx.query_row("SELECT version,data FROM common_configs WHERE tool = ?1", [&common.tool], |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(|e| e.to_string())?;
        let old_revision = old.as_ref().map(|(_, data)| serde_json::from_str::<RegisteredCommon>(data).map(|value| value.revision)).transpose().map_err(|e| e.to_string())?;
        if old.as_ref().map(|(version, _)| *version as u64) != expected_version || old_revision.as_deref().unwrap_or("") != common.revision { return Err("通用配置已由其他操作修改，请重新读取".into()); }
        common.version = old.map_or(1, |(version, _)| version as u64 + 1);
        common.revision = Uuid::new_v4().to_string();
        let json = serde_json::to_string(&common).map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO common_configs (tool, version, data) VALUES (?1, ?2, ?3) ON CONFLICT(tool) DO UPDATE SET version = excluded.version, data = excluded.data", params![common.tool, common.version as i64, json]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(common)
    })
}

/// Incoming Common changes retain native files and invalidate only inheriting bindings.
pub(crate) fn invalidate_common_bindings(conn: &rusqlite::Connection, tool: &str) -> Result<(), String> {
    let mut statement = conn.prepare("SELECT id,data FROM native_profiles WHERE tool=?1").map_err(|e| e.to_string())?;
    let rows = statement.query_map([tool], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).map_err(|e| e.to_string())?;
    for row in rows {
        let (id, data) = row.map_err(|e| e.to_string())?;
        let profile: RegisteredProfile = serde_json::from_str(&data).map_err(|e| e.to_string())?;
        if profile.inherit_common {
            conn.execute("UPDATE applied_bindings SET profile_version=-1 WHERE profile_id=?1", [id]).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(tool: CliId, name: &str) -> NativeProfile {
        NativeProfile {
            revision: String::new(),
            id: String::new(),
            tool,
            name: name.into(),
            version: 0,
            inherit_common: false,
            files: BTreeMap::new(),
            suppressed: BTreeMap::new(),
            connection: None,
            authentication: crate::native::profile::ProfileAuthentication::Native,
            native_credentials: BTreeMap::new(),
        }
    }

    #[test]
    fn independent_named_profiles_and_optimistic_versions_survive_restart() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("app.db");
        let (codex_id, claude_id);
        {
            let db = Database::open(&path).unwrap();
            let codex = save_profile(&db, profile(CliId::Codex, "工作"), None).unwrap();
            let claude = save_profile(&db, profile(CliId::ClaudeCode, "工作"), None).unwrap();
            codex_id = codex.id.clone();
            claude_id = claude.id.clone();
            assert!(save_profile(&db, codex.clone(), None).is_err());
            let mut second = codex;
            second.name = "个人".into();
            save_profile(&db, second, Some(1)).unwrap();
        }
        let db = Database::open(&path).unwrap();
        assert_eq!(get_profile(&db, &codex_id).unwrap().version, 2);
        assert_eq!(
            get_profile(&db, &claude_id).unwrap().tool,
            CliId::ClaudeCode
        );
        assert_eq!(list_profiles(&db, CliId::Codex).unwrap().len(), 1);
    }

    #[test]
    fn deleting_registered_profile_still_checks_version_and_active_binding() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let saved = save_profile(&db, profile(CliId::Codex, "工作"), None).unwrap();
        assert!(delete_profile(&db, &saved.id, saved.version + 1, &saved.revision)
            .unwrap_err()
            .contains("版本已变化"));
        db.with_connection(|conn| {
            conn.execute(
                "INSERT INTO applied_bindings (scope_key, tool, profile_id, profile_version, managed) VALUES (?1, ?2, ?3, ?4, ?5)",
                params!["global", "codex", saved.id, saved.version as i64, "{}"],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })
        .unwrap();
        assert!(delete_profile(&db, &saved.id, saved.version, &saved.revision)
            .unwrap_err()
            .contains("仍在使用"));
        assert_eq!(get_profile(&db, &saved.id).unwrap().version, saved.version);
        db.with_connection(|conn| {
            conn.execute(
                "DELETE FROM applied_bindings WHERE profile_id = ?1",
                [&saved.id],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })
        .unwrap();
        delete_profile(&db, &saved.id, saved.version, &saved.revision).unwrap();
        assert!(get_profile(&db, &saved.id).is_err());
    }

    #[test]
    fn common_inheritance_preserves_explicit_overrides() {
        let mut named = profile(CliId::Codex, "test");
        named.inherit_common = true;
        named.files.insert(
            "settings".into(),
            "model = \"own\"\nsuppress_unstable_features_warning = false\n".into(),
        );
        let common = CommonConfig {
            revision: String::new(), tool: CliId::Codex, version: 1, files: BTreeMap::from([("settings".into(), "model = \"base\"\nservice_tier = \"default\"\nsuppress_unstable_features_warning = true\n".into())]) };
        let effective = resolve_file(&named, Some(&common), "settings").unwrap();
        assert_eq!(effective.contents["model"], "own");
        assert_eq!(effective.contents["service_tier"], "default");
        assert_eq!(
            effective.contents["suppress_unstable_features_warning"],
            false
        );
    }

    #[test]
    fn profile_database_refuses_literal_native_api_keys() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let mut item = profile(CliId::Pi, "secret test");
        item.files.insert(
            "models".into(),
            r#"{"providers":{"mine":{"apiKey":"sk-private-value"}}}"#.into(),
        );
        assert!(save_profile(&db, item.clone(), None)
            .unwrap_err()
            .contains("明文密钥"));
        assert!(list_profiles(&db, CliId::Pi).unwrap().is_empty());
        item.files.insert(
            "models".into(),
            r#"{"providers":{"mine":{"apiKey":"MY_KEY"}}}"#.into(),
        );
        assert!(save_profile(&db, item.clone(), None).is_err());
        assert!(list_profiles(&db, CliId::Pi).unwrap().is_empty());
        for reference in ["$MY_KEY", "${MY_KEY}"] {
            item.files.insert(
                "models".into(),
                format!(r#"{{"providers":{{"mine":{{"apiKey":"{reference}"}}}}}}"#),
            );
            let saved = save_profile(&db, item.clone(), None).unwrap();
            assert!(saved.files["models"].contains(reference));
            delete_profile(&db, &saved.id, saved.version, &saved.revision).unwrap();
        }
        assert_eq!(env_ref_name("MY_KEY"), None);
    }

    #[test]
    fn unsafe_connection_url_does_not_enter_native_profile() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let mut item = profile(CliId::Codex, "URL test");
        item.connection = Some(Connection {
            provider_id: "demo".into(),
            interface_format: "openai_responses".into(),
            base_url: "http://remote.example/v1?token=private".into(),
            model: "m".into(),
            secret_ref: None,
            auth_env_var: None,
        });
        assert!(save_profile(&db, item, None).is_err());
        assert!(list_profiles(&db, CliId::Codex).unwrap().is_empty());
    }
}
