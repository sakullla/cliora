use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::adapter::{self, NativeFile, Scope};
use super::auth;
use super::format;
use super::profile::{self, Connection, NativeProfile};
use super::transaction::{self, ApplyOutcome, FieldChange, FilePatch};
use crate::credentials::CredentialStore;
use crate::database::Database;
use crate::domain::CliId;

type Managed = BTreeMap<String, BTreeMap<String, Value>>;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedBinding {
    pub scope_key: String,
    pub tool: CliId,
    pub profile_id: String,
    pub profile_version: u64,
    pub managed: Managed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePreview {
    pub documents: BTreeMap<String, Value>,
    pub sources: BTreeMap<String, BTreeMap<String, String>>,
}

fn tool_key(tool: CliId) -> String {
    serde_json::to_value(tool)
        .unwrap()
        .as_str()
        .unwrap()
        .to_string()
}

fn pointer(path: &[String]) -> String {
    path.iter()
        .map(|segment| format!("/{}", segment.replace('~', "~0").replace('/', "~1")))
        .collect()
}

fn path_from_pointer(pointer: &str) -> Vec<String> {
    pointer
        .split('/')
        .skip(1)
        .map(|segment| segment.replace("~1", "/").replace("~0", "~"))
        .collect()
}

fn flatten(value: &Value, path: &mut Vec<String>, output: &mut BTreeMap<String, Value>) {
    match value {
        Value::Object(map) if !map.is_empty() => {
            for (key, value) in map {
                path.push(key.clone());
                flatten(value, path, output);
                path.pop();
            }
        }
        _ if !path.is_empty() => {
            output.insert(pointer(path), value.clone());
        }
        _ => {}
    }
}

fn set_json(root: &mut Value, path: &[&str], value: Value) {
    let mut cursor = root;
    for segment in &path[..path.len() - 1] {
        if !cursor.get(*segment).is_some_and(Value::is_object) {
            cursor
                .as_object_mut()
                .unwrap()
                .insert((*segment).into(), json!({}));
        }
        cursor = cursor.get_mut(*segment).unwrap();
    }
    cursor
        .as_object_mut()
        .unwrap()
        .insert(path.last().unwrap().to_string(), value);
}

fn connection_documents(
    tool: CliId,
    connection: &Connection,
    scope: Scope,
) -> Result<BTreeMap<String, Value>, String> {
    if scope == Scope::Project && matches!(tool, CliId::Codex | CliId::Grok | CliId::Pi) {
        return Err("此工具的项目层不能安全写入供应商连接；请使用全局配置".into());
    }
    let mut result = BTreeMap::new();
    let mut settings = json!({});
    let format = connection.interface_format.as_str();
    let provider = connection.provider_id.as_str();
    let model = connection.model.as_str();
    let base = connection.base_url.as_str();
    let env_name = profile::auth_env_name(tool, connection);
    let env = env_name.as_deref();
    match tool {
        CliId::Codex => {
            if format != "openai_responses" {
                return Err("Codex 此版本只支持 Responses 供应商接口".into());
            }
            set_json(&mut settings, &["model"], json!(model));
            set_json(&mut settings, &["model_provider"], json!(provider));
            set_json(
                &mut settings,
                &["model_providers", provider, "name"],
                json!(provider),
            );
            set_json(
                &mut settings,
                &["model_providers", provider, "base_url"],
                json!(base),
            );
            set_json(
                &mut settings,
                &["model_providers", provider, "wire_api"],
                json!("responses"),
            );
            if let Some(env) = env {
                set_json(
                    &mut settings,
                    &["model_providers", provider, "env_key"],
                    json!(env),
                );
            }
        }
        CliId::ClaudeCode => {
            if format != "anthropic_messages" {
                return Err("Claude Code 此版本只支持 Anthropic Messages 接口".into());
            }
            set_json(&mut settings, &["model"], json!(model));
            set_json(&mut settings, &["env", "ANTHROPIC_BASE_URL"], json!(base));
        }
        CliId::Grok => {
            let backend = match format {
                "openai_completions" => "chat_completions",
                "openai_responses" => "responses",
                "anthropic_messages" => "messages",
                _ => return Err("Grok 不支持所选接口格式".into()),
            };
            set_json(&mut settings, &["models", "default"], json!(model));
            set_json(&mut settings, &["model", model, "model"], json!(model));
            set_json(&mut settings, &["model", model, "base_url"], json!(base));
            set_json(
                &mut settings,
                &["model", model, "api_backend"],
                json!(backend),
            );
            if let Some(env) = env {
                set_json(&mut settings, &["model", model, "env_key"], json!(env));
            }
        }
        CliId::Pi => {
            let api = match format {
                "openai_completions" => "openai-completions",
                "openai_responses" => "openai-responses",
                "anthropic_messages" => "anthropic-messages",
                _ => return Err("Pi 不支持所选接口格式".into()),
            };
            set_json(&mut settings, &["defaultProvider"], json!(provider));
            set_json(&mut settings, &["defaultModel"], json!(model));
            let mut models = json!({});
            set_json(
                &mut models,
                &["providers", provider, "baseUrl"],
                json!(base),
            );
            set_json(&mut models, &["providers", provider, "api"], json!(api));
            set_json(
                &mut models,
                &["providers", provider, "models"],
                json!([{"id":model}]),
            );
            if let Some(env) = env {
                set_json(&mut models, &["providers", provider, "apiKey"], json!(env));
            }
            result.insert("models".into(), models);
        }
        CliId::OpenCode => {
            let npm = match format {
                "openai_completions" => "@ai-sdk/openai-compatible",
                "openai_responses" => "@ai-sdk/openai",
                "anthropic_messages" => "@ai-sdk/anthropic",
                _ => return Err("OpenCode 不支持所选接口格式".into()),
            };
            set_json(
                &mut settings,
                &["model"],
                json!(format!("{provider}/{model}")),
            );
            set_json(&mut settings, &["provider", provider, "npm"], json!(npm));
            set_json(
                &mut settings,
                &["provider", provider, "name"],
                json!(provider),
            );
            set_json(
                &mut settings,
                &["provider", provider, "options", "baseURL"],
                json!(base),
            );
            set_json(
                &mut settings,
                &["provider", provider, "models", model, "name"],
                json!(model),
            );
            if let Some(env) = env {
                set_json(
                    &mut settings,
                    &["provider", provider, "options", "apiKey"],
                    json!(format!("{{env:{env}}}")),
                );
            }
        }
    }
    result.insert("settings".into(), settings);
    Ok(result)
}

fn scope_key(scope: Scope, project: Option<&Path>) -> Result<String, String> {
    match scope {
        Scope::Global => Ok("global".into()),
        Scope::Project => {
            let path = project
                .ok_or("请选择项目目录")?
                .canonicalize()
                .map_err(|_| "项目目录不存在或无法访问")?;
            if !path.is_dir() {
                return Err("项目路径不是目录".into());
            }
            Ok(format!("project:{}", path.display()))
        }
    }
}

pub fn get_binding(
    db: &Database,
    tool: CliId,
    key: &str,
) -> Result<Option<AppliedBinding>, String> {
    db.with_connection(|conn| {
        let row: Option<(String, i64, String)> = conn.query_row("SELECT profile_id, profile_version, managed FROM applied_bindings WHERE scope_key = ?1 AND tool = ?2", params![key, tool_key(tool)], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional().map_err(|e| e.to_string())?;
        row.map(|(profile_id, profile_version, managed)| {
            Ok(AppliedBinding { scope_key: key.into(), tool, profile_id, profile_version: profile_version as u64, managed: serde_json::from_str(&managed).map_err(|_| "活动配置记录损坏")? })
        }).transpose()
    })
}

pub fn desired_documents(
    profile: &NativeProfile,
    common: Option<&profile::CommonConfig>,
    scope: Scope,
) -> Result<BTreeMap<String, Value>, String> {
    let mut roles: BTreeSet<String> = profile.files.keys().cloned().collect();
    if profile.inherit_common {
        if let Some(common) = common {
            roles.extend(common.files.keys().cloned());
        }
    }
    if profile.connection.is_some() {
        roles.insert("settings".into());
        if profile.tool == CliId::Pi {
            roles.insert("models".into());
        }
    }
    let mut result = BTreeMap::new();
    for role in roles {
        if scope == Scope::Project && profile.tool == CliId::Pi && role == "models" {
            return Err("Pi 项目层不支持自定义 models.json".into());
        }
        let effective = profile::resolve_file(profile, common, &role)?;
        result.insert(role, effective.contents);
    }
    if let Some(connection) = &profile.connection {
        for (role, overlay) in connection_documents(profile.tool, connection, scope)? {
            let existing = result.entry(role).or_insert_with(|| json!({}));
            let (merged, _) = format::resolve(existing, &overlay, &[])?;
            *existing = merged;
        }
    }
    if scope == Scope::Project {
        match profile.tool {
            CliId::Codex => {
                let settings = result.get("settings");
                if settings.and_then(|v| v.get("model_provider")).is_some()
                    || settings.and_then(|v| v.get("model_providers")).is_some()
                {
                    return Err("Codex 项目配置不能声明模型供应商".into());
                }
            }
            CliId::Grok => {
                if let Some(settings) = result.get("settings").and_then(Value::as_object) {
                    if settings.keys().any(|key| {
                        !matches!(key.as_str(), "mcp_servers" | "plugins" | "permissions")
                    }) {
                        return Err("Grok 项目配置仅支持 MCP、插件和权限".into());
                    }
                }
            }
            _ => {}
        }
    }
    Ok(result)
}

pub fn preview(
    profile: &NativeProfile,
    common: Option<&profile::CommonConfig>,
    scope: Scope,
) -> Result<NativePreview, String> {
    let documents = desired_documents(profile, common, scope)?;
    let mut sources = BTreeMap::new();
    for role in documents.keys() {
        sources.insert(
            role.clone(),
            profile::resolve_file(profile, common, role)?.source_by_path,
        );
    }
    if let Some(connection) = &profile.connection {
        for (role, root) in connection_documents(profile.tool, connection, scope)? {
            let mut fields = BTreeMap::new();
            flatten(&root, &mut Vec::new(), &mut fields);
            let entry = sources.entry(role).or_default();
            for path in fields.keys() {
                entry.insert(path.clone(), "连接设置".into());
            }
        }
    }
    Ok(NativePreview { documents, sources })
}

pub fn apply_validated(
    db: &Database,
    credentials: &dyn CredentialStore,
    profile: &NativeProfile,
    common: Option<&profile::CommonConfig>,
    native_files: &[NativeFile],
    key: &str,
    scope: Scope,
    allow_takeover: bool,
) -> Result<ApplyOutcome, String> {
    let desired = desired_documents(profile, common, scope)?;
    let old = get_binding(db, profile.tool, key)?;
    let mut new_managed = Managed::new();
    for (role, root) in desired {
        let mut fields = BTreeMap::new();
        flatten(&root, &mut Vec::new(), &mut fields);
        new_managed.insert(role, fields);
    }
    let old_managed = old.as_ref().map(|value| &value.managed);
    let roles: BTreeSet<_> = new_managed
        .keys()
        .chain(old_managed.into_iter().flat_map(|managed| managed.keys()))
        .cloned()
        .collect();
    let mut patches = Vec::new();
    let mut matching_baselines = Vec::new();
    for role in roles {
        let native = native_files
            .iter()
            .find(|file| file.role == role)
            .ok_or_else(|| format!("当前范围没有 {role} 文件"))?;
        if !native.writable || native.sensitive {
            return Err(native.reason.unwrap_or("原生文件不可安全写入").into());
        }
        let kind = match native.format {
            "toml" => format::FileKind::Toml,
            "json" => format::FileKind::Json,
            "jsonc" => format::FileKind::Jsonc,
            _ => return Err("原生文件格式不受支持".into()),
        };
        let file_path = Path::new(&native.path);
        let baseline = transaction::read_native(file_path)?;
        matching_baselines.push((file_path.to_path_buf(), baseline.clone()));
        let original = format::parse(kind, &baseline)?;
        let next_fields = new_managed.get(&role);
        let previous_fields = old_managed.and_then(|managed| managed.get(&role));
        let pointers: BTreeSet<_> = next_fields
            .into_iter()
            .flat_map(|map| map.keys())
            .chain(previous_fields.into_iter().flat_map(|map| map.keys()))
            .cloned()
            .collect();
        let mut changes = Vec::new();
        for pointer in pointers {
            let path = path_from_pointer(&pointer);
            let current = path
                .iter()
                .try_fold(&original, |value, part| value.get(part));
            let old_value = previous_fields.and_then(|fields| fields.get(&pointer));
            let new_value = next_fields.and_then(|fields| fields.get(&pointer));
            if let Some(old_value) = old_value {
                if current != Some(old_value) && current != new_value {
                    return Err(format!("上次管理的字段已被外部修改：{role}{pointer}"));
                }
            } else if current.is_some() && current != new_value && !allow_takeover {
                return Err(format!(
                    "原生文件已有不同的字段值：{role}{pointer}；请确认接管"
                ));
            }
            if current != new_value {
                changes.push(FieldChange {
                    path,
                    value: new_value.cloned(),
                });
            }
        }
        if !changes.is_empty() {
            patches.push(FilePatch {
                path: file_path.to_path_buf(),
                kind,
                baseline,
                changes,
            });
        }
    }
    if patches.is_empty() {
        return transaction::commit_matching(db, &matching_baselines, |tx| {
            let json = serde_json::to_string(&new_managed).map_err(|e| e.to_string())?;
            tx.execute("INSERT INTO applied_bindings (scope_key, tool, profile_id, profile_version, managed) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(scope_key, tool) DO UPDATE SET profile_id = excluded.profile_id, profile_version = excluded.profile_version, managed = excluded.managed", params![key, tool_key(profile.tool), profile.id, profile.version as i64, json]).map_err(|e| e.to_string())?;
            Ok(())
        });
    }
    transaction::apply(db, credentials, &patches, |tx| {
        let json = serde_json::to_string(&new_managed).map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO applied_bindings (scope_key, tool, profile_id, profile_version, managed) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(scope_key, tool) DO UPDATE SET profile_id = excluded.profile_id, profile_version = excluded.profile_version, managed = excluded.managed", params![key, tool_key(profile.tool), profile.id, profile.version as i64, json]).map_err(|e| e.to_string())?;
        Ok(())
    })
}

pub fn apply_profile(
    db: &Database,
    credentials: &dyn CredentialStore,
    tool: CliId,
    profile_id: &str,
    scope: Scope,
    home: &Path,
    project: Option<&Path>,
    custom_path: Option<&Path>,
    allow_takeover: bool,
) -> Result<ApplyOutcome, String> {
    let profile = profile::get_profile(db, profile_id)?;
    if profile.tool != tool {
        return Err("配置属于另一个 CLI".into());
    }
    if let Some(connection) = &profile.connection {
        auth::verify_stored_credential(connection, credentials)?;
    }
    let common = profile::get_common(db, tool)?;
    let key = scope_key(scope, project)?;
    let probe = adapter::probe(tool, custom_path, home, project, scope);
    if probe.native_writes.state != "supported" {
        return Err(probe.native_writes.reason.into());
    }
    apply_validated(
        db,
        credentials,
        &profile,
        common.as_ref(),
        &probe.native_files,
        &key,
        scope,
        allow_takeover,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::fs;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemoryStore(Mutex<HashMap<String, String>>);
    impl CredentialStore for MemoryStore {
        fn put(&self, id: &str, secret: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert(id.into(), secret.into());
            Ok(())
        }
        fn get(&self, id: &str) -> Result<String, String> {
            self.0
                .lock()
                .unwrap()
                .get(id)
                .cloned()
                .ok_or("missing".into())
        }
        fn delete(&self, id: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(id);
            Ok(())
        }
    }
    fn profile(name: &str, model: &str) -> NativeProfile {
        NativeProfile {
            id: name.into(),
            tool: CliId::Codex,
            name: name.into(),
            version: 1,
            inherit_common: false,
            files: BTreeMap::from([("settings".into(), format!("model = \"{model}\"\n"))]),
            suppressed: BTreeMap::new(),
            connection: None,
        }
    }
    fn native(path: &Path) -> NativeFile {
        NativeFile {
            role: "settings",
            path: path.display().to_string(),
            format: "toml",
            writable: true,
            reason: None,
            sensitive: false,
        }
    }

    #[test]
    fn switching_named_profiles_removes_only_old_managed_keys() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config.toml");
        fs::write(&path, "# external\nunrelated = 7\n").unwrap();
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let store = MemoryStore::default();
        let first = profile("first", "a");
        apply_validated(
            &db,
            &store,
            &first,
            None,
            &[native(&path)],
            "global",
            Scope::Global,
            false,
        )
        .unwrap();
        let second = profile("second", "b");
        apply_validated(
            &db,
            &store,
            &second,
            None,
            &[native(&path)],
            "global",
            Scope::Global,
            false,
        )
        .unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("# external"));
        assert!(text.contains("unrelated = 7"));
        assert!(text.contains("model = \"b\""));
        assert_eq!(
            get_binding(&db, CliId::Codex, "global")
                .unwrap()
                .unwrap()
                .profile_id,
            "second"
        );
        fs::write(&path, text.replace("model = \"b\"", "model = \"external\"")).unwrap();
        assert!(apply_validated(
            &db,
            &store,
            &first,
            None,
            &[native(&path)],
            "global",
            Scope::Global,
            false
        )
        .unwrap_err()
        .contains("外部修改"));
        assert_eq!(
            get_binding(&db, CliId::Codex, "global")
                .unwrap()
                .unwrap()
                .profile_id,
            "second"
        );
    }

    #[test]
    fn native_format_mapping_is_tool_specific() {
        let connection = Connection {
            provider_id: "demo".into(),
            interface_format: "openai_responses".into(),
            base_url: "https://example.test/v1".into(),
            model: "m1".into(),
            secret_ref: None,
            auth_env_var: Some("DEMO_KEY".into()),
        };
        let codex = connection_documents(CliId::Codex, &connection, Scope::Global).unwrap();
        assert_eq!(
            codex["settings"]["model_providers"]["demo"]["wire_api"],
            "responses"
        );
        let grok = connection_documents(CliId::Grok, &connection, Scope::Global).unwrap();
        assert_eq!(grok["settings"]["model"]["m1"]["api_backend"], "responses");
        let pi = connection_documents(CliId::Pi, &connection, Scope::Global).unwrap();
        assert_eq!(pi["models"]["providers"]["demo"]["api"], "openai-responses");
        assert_eq!(pi["settings"]["defaultProvider"], "demo");
        assert_eq!(pi["settings"]["defaultModel"], "m1");
        let opencode = connection_documents(CliId::OpenCode, &connection, Scope::Global).unwrap();
        assert_eq!(
            opencode["settings"]["provider"]["demo"]["npm"],
            "@ai-sdk/openai"
        );
        assert!(connection_documents(CliId::Codex, &connection, Scope::Project).is_err());
    }
}
