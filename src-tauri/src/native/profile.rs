use std::collections::BTreeMap;

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::format::{self, FileKind};
use crate::database::Database;
use crate::domain::CliId;

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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeProfile {
    pub id: String,
    pub tool: CliId,
    pub name: String,
    pub version: u64,
    pub inherit_common: bool,
    pub files: BTreeMap<String, String>,
    #[serde(default)]
    pub suppressed: BTreeMap<String, Vec<String>>,
    pub connection: Option<Connection>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommonConfig {
    pub tool: CliId,
    pub version: u64,
    pub files: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveFile {
    pub role: String,
    pub contents: serde_json::Value,
    pub source_by_path: BTreeMap<String, String>,
}

fn tool_key(tool: CliId) -> String {
    serde_json::to_value(tool)
        .unwrap()
        .as_str()
        .unwrap()
        .to_string()
}

pub fn file_kind(tool: CliId, role: &str) -> Result<FileKind, String> {
    match (tool, role) {
        (CliId::Codex | CliId::Grok, "settings") => Ok(FileKind::Toml),
        (CliId::ClaudeCode | CliId::Pi, "settings") => Ok(FileKind::Json),
        (CliId::ClaudeCode, "local_settings") => Ok(FileKind::Json),
        (CliId::Pi, "models") => Ok(FileKind::Jsonc),
        (CliId::OpenCode, "settings") => Ok(FileKind::Jsonc),
        _ => Err("该工具的原生文件角色不受支持或包含受保护的凭据".into()),
    }
}

fn validate_files(tool: CliId, files: &BTreeMap<String, String>) -> Result<(), String> {
    for (role, text) in files {
        if text.len() > 2_000_000 {
            return Err("单个配置文件超过 2 MB 限制".into());
        }
        let parsed = format::parse(file_kind(tool, role)?, text)?;
        if parsed.to_string().len() > 2_000_000 {
            return Err("单个配置文件解析后超过 2 MB 限制".into());
        }
        reject_plaintext_secrets(&parsed)?;
    }
    Ok(())
}

fn looks_like_env_ref(value: &str) -> bool {
    let name = value
        .strip_prefix("{env:")
        .and_then(|tail| tail.strip_suffix('}'))
        .unwrap_or(value);
    !name.is_empty()
        && name.chars().all(|character| {
            character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'
        })
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
                );
                if sensitive && !looks_like_env_ref(value) {
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
    let kind = file_kind(profile.tool, role)?;
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
    db.with_connection(|conn| {
        let mut statement = conn
            .prepare("SELECT data FROM native_profiles WHERE tool = ?1 ORDER BY id")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([tool_key(tool)], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|row| {
            serde_json::from_str(&row.map_err(|e| e.to_string())?)
                .map_err(|e| format!("命名配置格式无法识别：{e}"))
        })
        .collect()
    })
}

pub fn get_profile(db: &Database, id: &str) -> Result<NativeProfile, String> {
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

pub fn save_profile(
    db: &Database,
    mut profile: NativeProfile,
    expected_version: Option<u64>,
) -> Result<NativeProfile, String> {
    if profile.name.trim().is_empty() {
        return Err("请输入配置名称".into());
    }
    if profile.name.chars().count() > 100 {
        return Err("配置名称不能超过 100 个字符".into());
    }
    validate_files(profile.tool, &profile.files)?;
    if let Some(connection) = &profile.connection {
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
        if connection.auth_env_var.as_deref().is_some_and(|value| {
            value.is_empty()
                || !value.chars().all(|character| {
                    character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'
                })
        }) {
            return Err("认证环境变量名称只能包含大写字母、数字和下划线".into());
        }
    }
    db.with_connection(|conn| {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        if profile.id.is_empty() {
            if expected_version.is_some() { return Err("新建配置不能携带旧版本".into()); }
            profile.id = Uuid::new_v4().to_string();
            profile.version = 1;
        } else {
            let old: Option<(String, i64)> = tx.query_row("SELECT tool, version FROM native_profiles WHERE id = ?1", [&profile.id], |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(|e| e.to_string())?;
            let (old_tool, current) = old.ok_or("命名配置不存在")?;
            if old_tool != tool_key(profile.tool) { return Err("不能修改配置所属工具".into()); }
            if Some(current as u64) != expected_version { return Err("命名配置已由其他操作修改，请重新读取".into()); }
            profile.version = current as u64 + 1;
        }
        let json = serde_json::to_string(&profile).map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO native_profiles (id, tool, version, data) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(id) DO UPDATE SET version = excluded.version, data = excluded.data", params![profile.id, tool_key(profile.tool), profile.version as i64, json]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(profile)
    })
}

pub fn delete_profile(db: &Database, id: &str, expected_version: u64) -> Result<(), String> {
    db.with_connection(|conn| {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let bound: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM applied_bindings WHERE profile_id = ?1",
                [id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if bound != 0 {
            return Err("配置仍在使用；请先切换到其他配置或保留原生文件".into());
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
    db.with_connection(|conn| {
        let json: Option<String> = conn
            .query_row(
                "SELECT data FROM common_configs WHERE tool = ?1",
                [tool_key(tool)],
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
    mut common: CommonConfig,
    expected_version: Option<u64>,
) -> Result<CommonConfig, String> {
    validate_files(common.tool, &common.files)?;
    db.with_connection(|conn| {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let old: Option<i64> = tx.query_row("SELECT version FROM common_configs WHERE tool = ?1", [tool_key(common.tool)], |row| row.get(0)).optional().map_err(|e| e.to_string())?;
        if old.map(|version| version as u64) != expected_version { return Err("通用配置已由其他操作修改，请重新读取".into()); }
        common.version = old.map_or(1, |version| version as u64 + 1);
        let json = serde_json::to_string(&common).map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO common_configs (tool, version, data) VALUES (?1, ?2, ?3) ON CONFLICT(tool) DO UPDATE SET version = excluded.version, data = excluded.data", params![tool_key(common.tool), common.version as i64, json]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(common)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(tool: CliId, name: &str) -> NativeProfile {
        NativeProfile {
            id: String::new(),
            tool,
            name: name.into(),
            version: 0,
            inherit_common: false,
            files: BTreeMap::new(),
            suppressed: BTreeMap::new(),
            connection: None,
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
    fn common_inheritance_preserves_explicit_overrides() {
        let mut named = profile(CliId::Codex, "test");
        named.inherit_common = true;
        named.files.insert(
            "settings".into(),
            "model = \"own\"\nsuppress_unstable_features_warning = false\n".into(),
        );
        let common = CommonConfig { tool: CliId::Codex, version: 1, files: BTreeMap::from([("settings".into(), "model = \"base\"\nservice_tier = \"default\"\nsuppress_unstable_features_warning = true\n".into())]) };
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
        save_profile(&db, item, None).unwrap();
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
