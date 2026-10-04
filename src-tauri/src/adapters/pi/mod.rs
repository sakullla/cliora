pub mod accounts;
pub(crate) mod agents;
pub mod history;
pub(crate) mod plugins;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::env;
use std::path::Path;

use super::{
    assign_existing_fields, file, project_root, CliAdapter, InspectionFields, LaunchMode,
    McpLocation, NativeCredentialRefs, PendingSecrets,
};
use crate::credentials::CredentialStore;
use crate::native::adapter::{NativeFile, Scope};
use crate::native::apply::{read_secret, set_json, NativeSecrets};
use crate::native::format::FileKind;
use crate::native::intake::NativeInspection;
use crate::native::intake::{api_format, pi_env_name, string_at};
use crate::native::profile::{self, Connection, ModelRecord, RegisteredProfile};
use crate::resources::mcp::{self, McpDefinition, McpTransport};

pub struct Pi;

/// 0.99.2 and 1.0.0 share the verified auth/package/session protocols.
pub(crate) fn version_policy() -> super::version::VersionPolicy {
    super::version::VersionPolicy { requirement: ">=0.99.2, <2.0.0".into(), excluded: &[] }
}

fn apply_model_record_edits(models: &mut [Value], records: &[ModelRecord]) {
    if records.is_empty() {
        return;
    }
    for item in models {
        let Some(id) = item.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(record) = records.iter().find(|record| record.id == id) else {
            continue;
        };
        let mut edits = record.fields.clone();
        edits.remove("id");
        assign_existing_fields(item, &edits);
    }
}

#[cfg(test)]
mod compatibility_tests {
    use super::*;
    #[test]
    fn verified_zero_and_one_families_share_account_plugin_and_resume_policy() {
        use crate::adapters::{accounts::AccountAdapter, plugins::PluginAdapter};
        for version in ["0.99.2", "0.99.9", "1.0.0", "1.0.7", "1.1.0", "v1.0.0", "1.0.0+build.1"] {
            assert!(AccountAdapter::version_policy(&Pi).accepts(version));
            assert!(PluginAdapter::version_policy(&Pi).accepts(version));
            assert!(Pi.history_resume_version_supported(version));
        }
        for version in ["0.98.0", "1.0.0-beta.1", "2.0.0", "invalid"] {
            assert!(!version_policy().accepts(version));
        }
    }
}

impl CliAdapter for Pi {
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
        "pi"
    }
    fn name(&self) -> &'static str {
        "Pi"
    }
    fn command(&self) -> &'static str {
        "pi"
    }
    fn npm_package(&self) -> &'static str {
        "@earendil-works/pi-coding-agent"
    }
    fn version_identity(&self, basename: &str, output: &str) -> bool {
        output.contains("pi ")
            || (basename == "pi"
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
        match root {
            Some(root) => vec![file(
                "settings",
                root.join(".pi/settings.json"),
                FileKind::Json,
                known,
                None,
                false,
            )],
            None => {
                let dir = crate::accounts::selection::config_root("pi", || {
                    env::var_os("PI_CODING_AGENT_DIR")
                        .map(Into::into)
                        .unwrap_or_else(|| home.join(".pi/agent"))
                });
                vec![
                    file(
                        "settings",
                        dir.join("settings.json"),
                        FileKind::Json,
                        known,
                        None,
                        false,
                    ),
                    file(
                        "models",
                        dir.join("models.json"),
                        FileKind::Jsonc,
                        known,
                        None,
                        false,
                    ),
                    file(
                        "auth",
                        dir.join("auth.json"),
                        FileKind::Json,
                        known,
                        Some("原生凭据文件独立保护，不进入配置草稿"),
                        true,
                    ),
                ]
            }
        }
    }
    fn interface_formats(&self) -> &'static [&'static str] {
        &[
            "openai_completions",
            "openai_responses",
            "anthropic_messages",
        ]
    }
    fn file_kind(&self, role: &str) -> Result<FileKind, String> {
        match role {
            "settings" => Ok(FileKind::Json),
            "models" => Ok(FileKind::Jsonc),
            _ => Err("Pi 不支持此原生文件角色".into()),
        }
    }
    fn portable_root_fields(&self, role: &str) -> &'static [&'static str] {
        match role {
            "settings" => &[
                "defaultProvider",
                "defaultModel",
                "defaultThinkingLevel",
                "models",
            ],
            "models" => &["providers"],
            _ => &[],
        }
    }
    fn skill_root(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<std::path::PathBuf> {
        Some(match scope {
            Scope::Global => crate::accounts::selection::config_root("pi", || {
                env::var_os("PI_CODING_AGENT_DIR")
                    .map(Into::into)
                    .unwrap_or_else(|| home.join(".pi/agent"))
            })
            .join("skills"),
            Scope::Project => project?.join(".pi/skills"),
        })
    }
    fn rule_path(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<std::path::PathBuf> {
        Some(match scope {
            Scope::Global => crate::accounts::selection::config_root("pi", || {
                env::var_os("PI_CODING_AGENT_DIR")
                    .map(Into::into)
                    .unwrap_or_else(|| home.join(".pi/agent"))
            })
            .join("AGENTS.md"),
            Scope::Project => project?.join("AGENTS.md"),
        })
    }
    fn mcp_location(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<McpLocation> {
        let path = match scope {
            Scope::Global => crate::accounts::selection::config_root("pi", || {
                env::var_os("PI_CODING_AGENT_DIR")
                    .map(Into::into)
                    .unwrap_or_else(|| home.join(".pi/agent"))
            })
            .join("mcp.json"),
            Scope::Project => project?.join(".pi/mcp.json"),
        };
        Some(McpLocation {
            path,
            kind: FileKind::Json,
            root: "mcpServers",
            child: None,
        })
    }
    fn mcp_document(
        &self,
        definition: &McpDefinition,
        enabled: bool,
        existing: Option<&Value>,
    ) -> Result<Option<Value>, String> {
        // Pi reads ~/.pi/agent/mcp.json and .pi/mcp.json. type is optional;
        // command selects stdio and url selects streamable HTTP. enabled: false
        // keeps the entry without connecting. SSE is rejected.
        let mut map = match definition.transport {
            McpTransport::Stdio => mcp::stdio_doc(definition, existing),
            McpTransport::Http => mcp::http_doc(definition, existing, "headers"),
        };
        map.insert(
            "type".into(),
            json!(if definition.transport == McpTransport::Http {
                "http"
            } else {
                "stdio"
            }),
        );
        map.insert("enabled".into(), json!(enabled));
        Ok(Some(Value::Object(map)))
    }
    fn connection_policy(&self, scope: Scope) -> crate::native::adapter::ConnectionPolicy {
        crate::native::adapter::ConnectionPolicy {
            api_key: if scope == Scope::Project {
                crate::native::adapter::api_key_scope_denied(
                    "Pi 项目层不能写入供应商密钥；请使用全局配置",
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
        _settings: &Value,
        models: &Value,
        provider: Option<&str>,
    ) -> Option<Vec<ModelRecord>> {
        let Some(provider) = provider.filter(|id| !id.is_empty()) else {
            return Some(Vec::new());
        };
        let Some(list) = models
            .get("providers")
            .and_then(|root| root.get(provider))
            .and_then(|entry| entry.get("models"))
            .and_then(Value::as_array)
        else {
            return Some(Vec::new());
        };
        Some(
            list.iter()
                .filter_map(|item| {
                    let id = item.get("id").and_then(Value::as_str)?.to_owned();
                    let mut fields = item.as_object()?.clone();
                    fields.remove("id");
                    Some(ModelRecord { id, fields })
                })
                .collect(),
        )
    }
    fn connection_documents(
        &self,
        connection: &Connection,
        scope: Scope,
    ) -> Result<BTreeMap<String, Value>, String> {
        if scope == Scope::Project {
            return Err("Pi 项目层不能安全写入供应商连接；请使用全局配置".into());
        }
        let api = match connection.interface_format.as_str() {
            "openai_completions" => "openai-completions",
            "openai_responses" => "openai-responses",
            "anthropic_messages" => "anthropic-messages",
            _ => return Err("Pi 不支持所选接口格式".into()),
        };
        let provider = connection.provider_id.as_str();
        let model = connection.model.as_str();
        let mut settings = json!({});
        set_json(&mut settings, &["defaultProvider"], json!(provider));
        set_json(&mut settings, &["defaultModel"], json!(model));
        let mut models = json!({});
        set_json(
            &mut models,
            &["providers", provider, "baseUrl"],
            json!(connection.base_url),
        );
        set_json(&mut models, &["providers", provider, "api"], json!(api));
        set_json(
            &mut models,
            &["providers", provider, "models"],
            json!([{"id":model}]),
        );
        if let Some(env) = profile::auth_env_name(crate::domain::CliId::Pi, connection) {
            set_json(
                &mut models,
                &["providers", provider, "apiKey"],
                json!(format!("${{{env}}}")),
            );
        }
        Ok(BTreeMap::from([
            ("settings".into(), settings),
            ("models".into(), models),
        ]))
    }
    fn connection_documents_for_existing(
        &self,
        connection: &Connection,
        scope: Scope,
        existing: &BTreeMap<String, Value>,
    ) -> Result<BTreeMap<String, Value>, String> {
        let mut docs = self.connection_documents(connection, scope)?;
        if let Some(models) = docs.get_mut("models") {
            let old = existing
                .get("models")
                .and_then(|root| root.get("providers"))
                .and_then(|root| root.get(&connection.provider_id))
                .and_then(|root| root.get("models"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let mut values = old;
            if !values.iter().any(|item| {
                item.get("id").and_then(Value::as_str) == Some(connection.model.as_str())
            }) {
                values.push(json!({"id":connection.model}));
            }
            set_json(
                models,
                &["providers", &connection.provider_id, "models"],
                json!(values),
            );
            if let Some(list) = models
                .get_mut("providers")
                .and_then(|root| root.get_mut(&connection.provider_id))
                .and_then(|provider| provider.get_mut("models"))
                .and_then(Value::as_array_mut)
            {
                apply_model_record_edits(list, &connection.model_records);
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
        if role != "models" {
            return Ok(());
        }
        let Some(connection) = &profile.connection else {
            return Ok(());
        };
        let pointer = format!(
            "/providers/{}/models",
            connection.provider_id.replace('~', "~0").replace('/', "~1")
        );
        let Some(next) = fields.get_mut(&pointer).and_then(Value::as_array_mut) else {
            return Ok(());
        };
        if let Some(old) = original.pointer(&pointer).and_then(Value::as_array) {
            for item in old {
                if let Some(found) = next
                    .iter_mut()
                    .find(|value| value.get("id") == item.get("id"))
                {
                    if let (Some(current), Some(changes)) = (item.as_object(), found.as_object()) {
                        let mut merged = current.clone();
                        merged.extend(changes.clone());
                        *found = Value::Object(merged);
                    }
                } else {
                    next.push(item.clone());
                }
            }
        }
        apply_model_record_edits(next, &connection.model_records);
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
            return Err("Pi 项目层不能写入供应商密钥；请使用全局配置".into());
        }
        secrets.put(
            "models",
            &["providers", &connection.provider_id, "apiKey"],
            read_secret(id, credentials)?,
        );
        Ok(())
    }
    fn has_native_secret(&self, role: &str, root: &Value) -> bool {
        role == "models"
            && root
                .get("providers")
                .and_then(Value::as_object)
                .is_some_and(|providers| {
                    providers.values().any(|item| item.get("apiKey").is_some())
                })
    }
    fn inspect_values(&self, settings: &Value, _: &Value, models: &Value) -> InspectionFields {
        let provider = string_at(settings, &["defaultProvider"])
            .map(str::to_owned)
            .or_else(|| models.get("providers")?.as_object()?.keys().next().cloned());
        let mut model = string_at(settings, &["defaultModel"]).map(str::to_owned);
        let entry = provider
            .as_ref()
            .and_then(|id| models.get("providers").and_then(|value| value.get(id)));
        let base = entry
            .and_then(|value| value.get("baseUrl"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let wire = entry
            .and_then(|value| value.get("api"))
            .and_then(Value::as_str)
            .and_then(api_format);
        let env = entry
            .and_then(|value| value.get("apiKey"))
            .and_then(Value::as_str)
            .and_then(pi_env_name)
            .map(str::to_owned);
        if model.is_none() {
            model = entry
                .and_then(|value| value.get("models"))
                .and_then(Value::as_array)
                .and_then(|list| list.first())
                .and_then(|value| value.get("id"))
                .and_then(Value::as_str)
                .map(str::to_owned);
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
        let raw = files.get("models").cloned().unwrap_or_default();
        let models = crate::native::format::parse(FileKind::Jsonc, &raw)?;
        if let Some(providers) = models.get("providers").and_then(Value::as_object) {
            for (name, provider) in providers {
                let Some(key) = provider.get("apiKey").and_then(Value::as_str) else {
                    continue;
                };
                if pi_env_name(key).is_some() {
                    continue;
                }
                if found.provider_id.as_deref() != Some(name.as_str()) || found.connection.is_none()
                {
                    return Err(format!("Pi 供应商 {name} 含字面 apiKey；请先在原生配置中选择完整的默认供应商与模型，再逐一安全接入。原文件未更改"));
                }
                if key.is_empty() || key.len() > 16_384 {
                    return Err("Pi 原生 apiKey 为空或超过系统凭据库限制；原文件未更改".into());
                }
                let id = format!("connection-{}", uuid::Uuid::new_v4());
                let connection = found.connection.as_mut().unwrap();
                connection.secret_ref = Some(id.clone());
                let env = self
                    .auth_env_name(connection)
                    .ok_or("无法确定 Pi 的认证环境变量")?;
                connection.auth_env_var = Some(env.clone());
                let replaced = crate::native::format::set_path(
                    FileKind::Jsonc,
                    &raw,
                    &["providers".into(), name.clone(), "apiKey".into()],
                    Some(&json!(format!("${{{env}}}"))),
                )?;
                files.insert("models".into(), replaced);
                pending.push((id, key.to_owned()));
            }
        }
        Ok(())
    }
    fn validate_draft(&self, role: &str, parsed: &Value) -> Result<(), String> {
        if role != "models" {
            return Ok(());
        }
        if let Some(providers) = parsed.get("providers").and_then(Value::as_object) {
            for (name, provider) in providers {
                if let Some(key) = provider.get("apiKey").and_then(Value::as_str) {
                    if pi_env_name(key).is_none() {
                        return Err(format!("Pi 供应商 {name} 的 apiKey 须使用 $NAME 或 ${{NAME}} 环境变量引用；请通过安全接入迁移字面密钥"));
                    }
                }
            }
        }
        Ok(())
    }
    fn connection_roles(&self) -> &'static [&'static str] {
        &["settings", "models"]
    }
    fn empty_entry_collections(&self, role: &str) -> &'static [&'static str] {
        match role {
            "models" => &["providers"],
            _ => &[],
        }
    }
    fn validate_role_scope(&self, role: &str, scope: Scope) -> Result<(), String> {
        if scope == Scope::Project && role == "models" {
            Err("Pi 项目层不支持自定义 models.json".into())
        } else {
            Ok(())
        }
    }
    fn launch_args(&self, session: Option<&str>, mode: LaunchMode) -> Result<Vec<String>, String> {
        if matches!(mode, LaunchMode::Yolo) {
            return Err("Pi 尚无已验证的 YOLO 启动参数".into());
        }
        Ok(session
            .map(|id| vec!["--session".into(), id.into()])
            .unwrap_or_default())
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
        version_policy().accepts(version)
    }
    fn install_guidance(&self) -> (&'static str, &'static str) {
        (
            "https://github.com/earendil-works/pi/tree/main/packages/coding-agent",
            "使用安装 Pi 的同一包管理器更新。",
        )
    }
    fn minimum_node_version(&self) -> Option<(u32, u32, u32)> {
        Some((22, 19, 0))
    }
    fn node_dependency_detail(&self) -> &'static str {
        "Pi 的 npm 安装需要 Node.js 22.19 或更新版本"
    }
    fn requires_windows_bash(&self) -> bool {
        true
    }
    fn install_command(&self) -> Option<String> {
        self.npm_install_command()
    }
    fn npm_install_command(&self) -> Option<String> {
        Some(format!(
            "npm install -g --ignore-scripts {}",
            self.npm_package()
        ))
    }
    fn upgrade_command(&self, source: &str) -> Option<String> {
        (source == "npm_shim").then(|| {
            format!(
                "npm install -g --ignore-scripts {}@latest",
                self.npm_package()
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pi_has_no_cli_login() {
        let adapter = Pi;
        assert!(adapter.login_args().is_none());
        assert!(adapter.descriptor().login.is_none());
    }
}
