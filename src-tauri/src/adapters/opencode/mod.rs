pub mod accounts;
pub(crate) mod agents;
pub mod history;
pub(crate) mod plugins;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::env;
use std::path::{Path, PathBuf};

use super::{
    assign_existing_fields, file, pointer_token, project_root, CliAdapter, InspectionFields,
    LaunchMode, McpLocation, NativeCredentialRefs, PendingSecrets,
};
use crate::credentials::CredentialStore;
use crate::native::adapter::{NativeFile, Scope};
use crate::native::apply::{read_secret, set_json, NativeSecrets};
use crate::native::format::FileKind;
use crate::native::intake::NativeInspection;
use crate::native::intake::{api_format, string_at};
use crate::native::profile::{self, Connection, ModelRecord, RegisteredProfile};
use crate::resources::mcp::{self, McpDefinition, McpTransport};

pub struct OpenCode;

fn unescape_pointer(segment: &str) -> String {
    segment.replace("~1", "/").replace("~0", "~")
}

fn insert_path(root: &mut Value, path: &[String], value: Value) {
    if path.is_empty() || !root.is_object() {
        return;
    }
    let mut cursor = root;
    for segment in &path[..path.len() - 1] {
        if !cursor.get(segment).is_some_and(Value::is_object) {
            cursor
                .as_object_mut()
                .unwrap()
                .insert(segment.clone(), json!({}));
        }
        cursor = cursor.get_mut(segment).unwrap();
    }
    cursor
        .as_object_mut()
        .unwrap()
        .insert(path[path.len() - 1].clone(), value);
}

fn model_from_managed(fields: &BTreeMap<String, Value>, prefix: &str) -> Value {
    let mut model = json!({});
    let needle = format!("{prefix}/");
    for (pointer, value) in fields {
        let Some(rest) = pointer.strip_prefix(&needle) else {
            continue;
        };
        if rest.is_empty() {
            continue;
        }
        let path: Vec<String> = rest.split('/').map(unescape_pointer).collect();
        insert_path(&mut model, &path, value.clone());
    }
    model
}

fn merge_missing(target: &mut serde_json::Map<String, Value>, source: &serde_json::Map<String, Value>) {
    for (key, value) in source {
        if !target.contains_key(key) {
            target.insert(key.clone(), value.clone());
            continue;
        }
        let existing = target.get_mut(key).unwrap();
        if let (Some(existing_map), Some(value_map)) = (existing.as_object_mut(), value.as_object()) {
            merge_missing(existing_map, value_map);
        }
    }
}

fn write_leaves(fields: &mut BTreeMap<String, Value>, prefix: &str, value: &Value, path: &mut Vec<String>) {
    match value {
        Value::Object(map) if !map.is_empty() => {
            for (key, child) in map {
                path.push(key.clone());
                write_leaves(fields, prefix, child, path);
                path.pop();
            }
        }
        _ if !path.is_empty() => {
            let mut pointer = String::from(prefix);
            for segment in path.iter() {
                pointer.push('/');
                pointer.push_str(&pointer_token(segment));
            }
            fields.insert(pointer, value.clone());
        }
        _ => {}
    }
}

fn replace_model_fields(fields: &mut BTreeMap<String, Value>, prefix: &str, model: &Value) {
    let needle = format!("{prefix}/");
    fields.retain(|key, _| !key.starts_with(&needle));
    write_leaves(fields, prefix, model, &mut Vec::new());
}

fn draft_models(profile: &RegisteredProfile, provider: &str) -> Result<serde_json::Map<String, Value>, String> {
    let Some(text) = profile.files.get("settings") else {
        return Ok(serde_json::Map::new());
    };
    let parsed = crate::native::format::parse(FileKind::Jsonc, text)?;
    Ok(parsed
        .get("provider")
        .and_then(|root| root.get(provider))
        .and_then(|entry| entry.get("models"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default())
}

/// OpenCode follows `XDG_CONFIG_HOME` for the signed-in user. A caller-supplied
/// home that is not the real user home (tests, isolated profiles) stays under
/// that home so CI cannot redirect writes to the runner's config directory.
fn config_base(home: &Path) -> PathBuf {
    if dirs::home_dir().as_deref() == Some(home) {
        if let Some(xdg) = env::var_os("XDG_CONFIG_HOME") {
            let path = PathBuf::from(xdg);
            if path.is_absolute() {
                return path;
            }
        }
    }
    home.join(".config")
}

impl CliAdapter for OpenCode {
    fn supports_mcp(&self) -> bool { true }
    fn supports_skills(&self) -> bool { true }
    fn agents(&self) -> Option<&dyn crate::adapters::agents::AgentAdapter> {
        Some(self)
    }
    fn plugins(&self) -> Option<&dyn crate::adapters::plugins::PluginAdapter> {
        Some(self)
    }
    fn accounts(&self) -> Option<&dyn crate::adapters::accounts::AccountAdapter> {
        Some(self)
    }
    fn id(&self) -> &'static str {
        "open_code"
    }
    fn name(&self) -> &'static str {
        "OpenCode"
    }
    fn command(&self) -> &'static str {
        "opencode"
    }
    fn npm_package(&self) -> &'static str {
        "opencode-ai"
    }
    fn native_binary_directories(&self, home: &Path) -> Vec<PathBuf> {
        vec![home.join(".opencode/bin")]
    }
    fn version_identity(&self, basename: &str, output: &str) -> bool {
        output.contains("opencode")
            || (basename == "opencode"
                && (output.starts_with('v')
                    || output.chars().next().is_some_and(|c| c.is_ascii_digit())))
    }
    fn native_files(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
        known: bool,
    ) -> Vec<NativeFile> {
        let Some(root) = project_root(scope, project) else {
            return vec![];
        };
        let dir = root.map(Path::to_path_buf).unwrap_or_else(|| {
            crate::accounts::selection::config_root("open_code", || {
                config_base(home).join("opencode")
            })
        });
        let jsonc = dir.join("opencode.jsonc");
        let (path, kind) = if jsonc.exists() {
            (jsonc, FileKind::Jsonc)
        } else {
            (dir.join("opencode.json"), FileKind::Json)
        };
        vec![file("settings", path, kind, known, None, false)]
    }
    fn interface_formats(&self) -> &'static [&'static str] {
        &[
            "openai_completions",
            "openai_responses",
            "anthropic_messages",
        ]
    }
    fn file_kind(&self, role: &str) -> Result<FileKind, String> {
        if role == "settings" {
            Ok(FileKind::Jsonc)
        } else {
            Err("OpenCode 不支持此原生文件角色".into())
        }
    }
    fn portable_root_fields(&self, role: &str) -> &'static [&'static str] {
        if role == "settings" {
            &["model", "provider", "agent", "permission", "mcp"]
        } else {
            &[]
        }
    }
    fn skill_switch_location(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
        name: &str,
    ) -> Option<super::SkillSwitchLocation> {
        let file = self
            .native_files(scope, home, project, true)
            .into_iter()
            .find(|file| file.role == "settings")?;
        let kind = FileKind::for_name(&file.path).ok()?;
        Some(super::SkillSwitchLocation {
            path: file.path.into(),
            kind,
            field: vec!["permission".into(), "skill".into(), name.into()],
        })
    }
    fn skill_switch_value(&self, _: &Value, enabled: bool, _: &Path) -> Value {
        json!(if enabled { "allow" } else { "deny" })
    }
    fn skill_switch_enabled(&self, current: &Value, _: &Path) -> bool {
        current.as_str() != Some("deny")
    }
    fn mcp_location(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<McpLocation> {
        self.mcp_location_for_version(scope, home, project, None)
    }
    fn mcp_requires_version(&self) -> bool {
        true
    }
    fn mcp_location_for_version(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
        version: Option<&str>,
    ) -> Option<McpLocation> {
        let file = self
            .native_files(scope, home, project, true)
            .into_iter()
            .next()?;
        let path: std::path::PathBuf = file.path.into();
        let kind = if file.format == "jsonc" {
            FileKind::Jsonc
        } else {
            FileKind::Json
        };
        let major = version.and_then(|text| {
            text.trim()
                .trim_start_matches('v')
                .split('.')
                .next()?
                .parse::<u32>()
                .ok()
        });
        let child = match major {
            Some(2) => Some("servers"),
            Some(1) => None,
            Some(_) => return None,
            None => {
                let text = crate::native::transaction::read_native(&path).ok()?;
                let parsed = crate::native::format::parse(kind, &text).ok()?;
                let root = parsed.get("mcp")?.as_object()?;
                if root
                    .get("servers")
                    .is_some_and(serde_json::Value::is_object)
                {
                    Some("servers")
                } else if root.keys().any(|key| key != "timeout") {
                    None
                } else {
                    return None;
                }
            }
        };
        Some(McpLocation {
            path,
            kind,
            root: "mcp",
            child,
        })
    }
    fn mcp_document(
        &self,
        definition: &McpDefinition,
        enabled: bool,
        existing: Option<&Value>,
    ) -> Result<Option<Value>, String> {
        let mut map = match definition.transport {
            McpTransport::Stdio => {
                let (command, args) = mcp::stdio_command(&definition.command, &definition.args);
                let mut map = mcp::stdio_doc_with_env(definition, existing, "environment");
                map.remove("args");
                map.insert(
                    "command".into(),
                    json!(std::iter::once(command).chain(args).collect::<Vec<_>>()),
                );
                map.insert("type".into(), json!("local"));
                map
            }
            McpTransport::Http => {
                let mut map = mcp::http_doc(definition, existing, "headers");
                map.insert("type".into(), json!("remote"));
                map
            }
        };
        map.insert("enabled".into(), json!(enabled));
        Ok(Some(Value::Object(map)))
    }
    fn mcp_document_at(
        &self,
        definition: &McpDefinition,
        enabled: bool,
        existing: Option<&Value>,
        location: &McpLocation,
    ) -> Result<Option<Value>, String> {
        let mut document = self.mcp_document(definition, enabled, existing)?;
        if location.child == Some("servers") {
            if let Some(map) = document.as_mut().and_then(Value::as_object_mut) {
                map.remove("enabled");
                map.insert("disabled".into(), json!(!enabled));
            }
        }
        Ok(document)
    }
    fn skill_root(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<std::path::PathBuf> {
        Some(match scope {
            Scope::Global => crate::accounts::selection::config_root("open_code", || {
                config_base(home).join("opencode")
            })
            .join("skills"),
            Scope::Project => project?.join(".opencode/skills"),
        })
    }
    fn rule_path(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<std::path::PathBuf> {
        Some(match scope {
            Scope::Global => crate::accounts::selection::config_root("open_code", || {
                config_base(home).join("opencode")
            })
            .join("AGENTS.md"),
            Scope::Project => project?.join("AGENTS.md"),
        })
    }
    fn connection_policy(&self, scope: Scope) -> crate::native::adapter::ConnectionPolicy {
        crate::native::adapter::ConnectionPolicy {
            api_key: if scope == Scope::Project {
                crate::native::adapter::api_key_scope_denied(
                    "OpenCode 项目共享配置不能写入明文密钥；请使用全局配置或原生登录",
                )
            } else {
                crate::native::adapter::api_key_writable()
            },
            provider_address: crate::native::adapter::address_configurable(),
            projection: "provider_models",
        }
    }
    fn projected_models(
        &self,
        settings: &Value,
        _models: &Value,
        provider: Option<&str>,
    ) -> Option<Vec<ModelRecord>> {
        let Some(provider) = provider.filter(|id| !id.is_empty()) else {
            return Some(Vec::new());
        };
        let Some(models) = settings
            .get("provider")
            .and_then(|root| root.get(provider))
            .and_then(|entry| entry.get("models"))
            .and_then(Value::as_object)
        else {
            return Some(Vec::new());
        };
        Some(
            models
                .iter()
                .map(|(id, fields)| ModelRecord {
                    id: id.clone(),
                    fields: fields.as_object().cloned().unwrap_or_default(),
                })
                .collect(),
        )
    }
    fn connection_documents(
        &self,
        connection: &Connection,
        _scope: Scope,
    ) -> Result<BTreeMap<String, Value>, String> {
        let npm = match connection.interface_format.as_str() {
            "openai_completions" => "@ai-sdk/openai-compatible",
            "openai_responses" => "@ai-sdk/openai",
            "anthropic_messages" => "@ai-sdk/anthropic",
            _ => return Err("OpenCode 不支持所选接口格式".into()),
        };
        let provider = connection.provider_id.as_str();
        let model = connection.model.as_str();
        let mut settings = json!({});
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
            json!(connection.base_url),
        );
        set_json(
            &mut settings,
            &["provider", provider, "models", model, "name"],
            json!(model),
        );
        if let Some(env) = profile::auth_env_name(crate::domain::CliId::OpenCode, connection) {
            set_json(
                &mut settings,
                &["provider", provider, "options", "apiKey"],
                json!(format!("{{env:{env}}}")),
            );
        }
        Ok(BTreeMap::from([("settings".into(), settings)]))
    }
    fn connection_documents_for_existing(
        &self,
        connection: &Connection,
        scope: Scope,
        existing: &BTreeMap<String, Value>,
    ) -> Result<BTreeMap<String, Value>, String> {
        let mut docs = self.connection_documents(connection, scope)?;
        let draft = existing
            .get("settings")
            .and_then(|root| root.get("provider"))
            .and_then(|root| root.get(&connection.provider_id))
            .and_then(|entry| entry.get("models"))
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let Some(models) = docs
            .get_mut("settings")
            .and_then(|root| root.get_mut("provider"))
            .and_then(|root| root.get_mut(&connection.provider_id))
            .and_then(|entry| entry.get_mut("models"))
            .and_then(Value::as_object_mut)
        else {
            return Ok(docs);
        };
        if let Some(current) = draft.get(&connection.model) {
            models.insert(connection.model.clone(), current.clone());
        }
        for (id, value) in &draft {
            if id != &connection.model {
                models.insert(id.clone(), value.clone());
            }
        }
        for (id, model) in models.iter_mut() {
            if let Some(record) = connection.model_records.iter().find(|record| &record.id == id) {
                assign_existing_fields(model, &record.fields);
            }
        }
        Ok(docs)
    }
    fn preserve_native_fields(
        &self,
        role: &str,
        original: &Value,
        fields: &mut BTreeMap<String, Value>,
        profile: &RegisteredProfile,
    ) -> Result<(), String> {
        if role != "settings" {
            return Ok(());
        }
        let Some(connection) = &profile.connection else {
            return Ok(());
        };
        let Some(disk_models) = original
            .get("provider")
            .and_then(|providers| providers.get(&connection.provider_id))
            .and_then(|provider| provider.get("models"))
            .and_then(Value::as_object)
        else {
            return Ok(());
        };
        let draft = draft_models(profile, &connection.provider_id)?;
        let provider_token = pointer_token(&connection.provider_id);
        for (model_id, disk_model) in disk_models {
            let Some(disk_object) = disk_model.as_object() else {
                continue;
            };
            let prefix = format!("/provider/{provider_token}/models/{}", pointer_token(model_id));
            let mut model = model_from_managed(fields, &prefix);
            if let Some(target) = model.as_object_mut() {
                merge_missing(target, disk_object);
            }
            let edited = connection
                .model_records
                .iter()
                .find(|record| &record.id == model_id);
            let name_edited = edited.is_some_and(|record| record.fields.contains_key("name"));
            if !draft.contains_key(model_id) && !name_edited {
                let model_map = model.as_object_mut().unwrap();
                match disk_model.get("name") {
                    Some(name) => {
                        model_map.insert("name".into(), name.clone());
                    }
                    None => {
                        model_map.remove("name");
                    }
                }
            }
            if let Some(record) = edited {
                assign_existing_fields(&mut model, &record.fields);
            }
            replace_model_fields(fields, &prefix, &model);
        }
        Ok(())
    }
    fn write_connection_secret(
        &self,
        profile: &RegisteredProfile,
        scope: Scope,
        credentials: &dyn CredentialStore,
        secrets: &mut NativeSecrets,
    ) -> Result<(), String> {
        let Some(connection) = &profile.connection else {
            return Ok(());
        };
        let Some(id) = &connection.secret_ref else {
            return Ok(());
        };
        if scope == Scope::Project {
            return Err("OpenCode 项目共享配置不能写入明文密钥；请使用全局配置或原生登录".into());
        }
        secrets.put(
            "settings",
            &["provider", &connection.provider_id, "options", "apiKey"],
            read_secret(id, credentials)?,
        );
        Ok(())
    }
    fn has_native_secret(&self, role: &str, root: &Value) -> bool {
        role == "settings"
            && root
                .get("provider")
                .and_then(Value::as_object)
                .is_some_and(|providers| {
                    providers.values().any(|item| {
                        item.get("options")
                            .and_then(|options| options.get("apiKey"))
                            .is_some()
                    })
                })
    }
    fn inspect_values(&self, settings: &Value, _: &Value, _: &Value) -> InspectionFields {
        let mut provider = None;
        let mut model = None;
        if let Some(full) = string_at(settings, &["model"]) {
            if let Some((id, name)) = full.split_once('/') {
                provider = Some(id.into());
                model = Some(name.into());
            }
        }
        if provider.is_none() {
            provider = settings
                .get("provider")
                .and_then(Value::as_object)
                .and_then(|items| items.keys().next())
                .cloned();
        }
        let entry = provider
            .as_ref()
            .and_then(|id| settings.get("provider").and_then(|value| value.get(id)));
        let base = entry
            .and_then(|value| value.get("options"))
            .and_then(|value| value.get("baseURL"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let wire = entry
            .and_then(|value| value.get("npm"))
            .and_then(Value::as_str)
            .and_then(api_format);
        let env = entry
            .and_then(|value| value.get("options"))
            .and_then(|value| value.get("apiKey"))
            .and_then(Value::as_str)
            .and_then(|value| value.strip_prefix("{env:"))
            .and_then(|value| value.strip_suffix('}'))
            .map(str::to_owned);
        if model.is_none() {
            model = entry
                .and_then(|value| value.get("models"))
                .and_then(Value::as_object)
                .and_then(|items| items.keys().next())
                .cloned();
        }
        InspectionFields {
            provider,
            model,
            base,
            wire,
            env,
            ..InspectionFields::default()
        }
    }
    fn import_literal_secrets(
        &self,
        files: &mut BTreeMap<String, String>,
        found: &mut NativeInspection,
        pending: &mut PendingSecrets,
        _: &mut NativeCredentialRefs,
    ) -> Result<(), String> {
        let raw = files.get("settings").cloned().unwrap_or_default();
        let settings = crate::native::format::parse(FileKind::Jsonc, &raw)?;
        if let Some(providers) = settings.get("provider").and_then(Value::as_object) {
            for (name, provider) in providers {
                let Some(key) = provider
                    .get("options")
                    .and_then(|value| value.get("apiKey"))
                    .and_then(Value::as_str)
                else {
                    continue;
                };
                if key
                    .strip_prefix("{env:")
                    .and_then(|tail| tail.strip_suffix('}'))
                    .is_some_and(profile::valid_env_name)
                {
                    continue;
                }
                if found.provider_id.as_deref() != Some(name.as_str()) || found.connection.is_none()
                {
                    return Err(format!("OpenCode 供应商 {name} 含字面 apiKey；请先选择完整的默认供应商与模型，再逐一安全接入。原文件未更改"));
                }
                if key.is_empty() || key.len() > 16_384 {
                    return Err("原生 apiKey 为空或超过系统凭据库限制；原文件未更改".into());
                }
                let id = format!("connection-{}", uuid::Uuid::new_v4());
                let connection = found.connection.as_mut().unwrap();
                connection.secret_ref = Some(id.clone());
                let env = self
                    .auth_env_name(connection)
                    .ok_or("无法确定 OpenCode 的认证环境变量")?;
                connection.auth_env_var = Some(env.clone());
                let replaced = crate::native::format::set_path(
                    FileKind::Jsonc,
                    &raw,
                    &[
                        "provider".into(),
                        name.clone(),
                        "options".into(),
                        "apiKey".into(),
                    ],
                    Some(&json!(format!("{{env:{env}}}"))),
                )?;
                files.insert("settings".into(), replaced);
                pending.push((id, key.to_owned()));
            }
        }
        Ok(())
    }
    fn validate_draft(&self, role: &str, parsed: &Value) -> Result<(), String> {
        if role != "settings" {
            return Ok(());
        }
        if let Some(providers) = parsed.get("provider").and_then(Value::as_object) {
            for (name, provider) in providers {
                if let Some(key) = provider
                    .get("options")
                    .and_then(|value| value.get("apiKey"))
                    .and_then(Value::as_str)
                {
                    if !key
                        .strip_prefix("{env:")
                        .and_then(|tail| tail.strip_suffix('}'))
                        .is_some_and(profile::valid_env_name)
                    {
                        return Err(format!("OpenCode 供应商 {name} 的 apiKey 须使用 {{env:NAME}}；请通过安全接入迁移字面密钥"));
                    }
                }
            }
        }
        Ok(())
    }
    fn login_args(&self) -> Option<Vec<String>> {
        Some(vec!["auth".into(), "login".into()])
    }
    fn login_hint(&self) -> &'static str {
        "在终端选择供应商并完成原生登录。"
    }
    fn launch_args(&self, session: Option<&str>, mode: LaunchMode) -> Result<Vec<String>, String> {
        let mut args = Vec::new();
        if let Some(id) = session {
            args.extend(["--session".into(), id.into()]);
        }
        if matches!(mode, LaunchMode::Yolo) {
            args.push("--auto".into());
        }
        Ok(args)
    }
    fn history_sources(
        &self,
        home: &std::path::Path,
    ) -> Result<Vec<crate::history::HistorySource>, String> {
        history::sources(home)
    }
    fn parse_history(
        &self,
        source: &crate::history::HistorySource,
    ) -> Result<crate::history::ParsedSession, String> {
        history::parse(source)
    }
    fn history_sources_controlled(
        &self,
        home: &std::path::Path,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Vec<crate::history::HistorySource>, String> {
        history::sources_controlled(home, cancelled)
    }
    fn parse_history_controlled(
        &self,
        source: &crate::history::HistorySource,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<crate::history::ParsedSession, String> {
        history::parse_controlled(source, cancelled)
    }
    fn history_supported(&self) -> bool {
        true
    }
    fn history_resume_version_supported(&self, version: &str) -> bool {
        version.starts_with("1.")
    }
    fn install_guidance(&self) -> (&'static str, &'static str) {
        (
            "https://opencode.ai/docs/",
            "使用 opencode upgrade 或原安装来源更新。",
        )
    }
}
