pub mod accounts;
pub(crate) mod agents;
pub mod history;
pub(crate) mod plugins;
pub(crate) mod usage;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::env;
use std::path::{Path, PathBuf};

use super::{
    file, project_root, CliAdapter, InspectionFields, LaunchMode, McpLocation,
    NativeCredentialRefs, PendingSecrets,
};
use crate::credentials::CredentialStore;
use crate::native::adapter::{NativeFile, Scope};
use crate::native::apply::{read_secret, set_json, NativeSecrets};
use crate::native::format::FileKind;
use crate::native::intake::NativeInspection;
use crate::native::intake::{api_format, string_at};
use crate::native::profile::{self, Connection, RegisteredProfile};
use crate::resources::mcp::{self, McpDefinition, McpTransport};

pub struct Grok;

impl CliAdapter for Grok {
    fn supports_mcp(&self) -> bool { true }
    fn supports_skills(&self) -> bool { true }
    fn official_usage(&self) -> Option<&dyn crate::adapters::official::OfficialUsageAdapter> {
        Some(self)
    }
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
        "grok"
    }
    fn name(&self) -> &'static str {
        "Grok"
    }
    fn command(&self) -> &'static str {
        "grok"
    }
    fn npm_package(&self) -> &'static str {
        "@xai-official/grok"
    }
    fn version_identity(&self, _basename: &str, output: &str) -> bool {
        output.contains("grok")
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
                root.join(".grok/config.toml"),
                FileKind::Toml,
                known,
                Some("Grok 的项目配置只读取 MCP、插件和权限规则；模型与连接在用户配置中设置"),
                false,
            )],
            None => vec![file(
                "settings",
                env::var_os("GROK_HOME")
                    .map(Into::into)
                    .unwrap_or_else(|| home.join(".grok"))
                    .join("config.toml"),
                FileKind::Toml,
                known,
                None,
                false,
            )],
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
        if role == "settings" {
            Ok(FileKind::Toml)
        } else {
            Err("Grok 不支持此原生文件角色".into())
        }
    }
    fn portable_root_fields(&self, role: &str) -> &'static [&'static str] {
        if role == "settings" {
            &["model", "permissions", "plugins", "mcp_servers"]
        } else {
            &[]
        }
    }
    fn mcp_location(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<McpLocation> {
        let path = self
            .native_files(scope, home, project, true)
            .first()?
            .path
            .clone();
        Some(McpLocation {
            path: path.into(),
            kind: FileKind::Toml,
            root: "mcp_servers",
            child: None,
        })
    }
    fn mcp_document(
        &self,
        definition: &McpDefinition,
        enabled: bool,
        existing: Option<&Value>,
    ) -> Result<Option<Value>, String> {
        let mut map = match definition.transport {
            McpTransport::Stdio => mcp::stdio_doc(definition, existing),
            McpTransport::Http => mcp::http_doc(definition, existing, "headers"),
        };
        map.insert("enabled".into(), serde_json::json!(enabled));
        Ok(Some(Value::Object(map)))
    }
    fn skill_root(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<std::path::PathBuf> {
        Some(match scope {
            Scope::Global => home.join(".grok/skills"),
            Scope::Project => project?.join(".grok/skills"),
        })
    }
    fn rule_path(
        &self,
        scope: Scope,
        _home: &Path,
        project: Option<&Path>,
    ) -> Option<std::path::PathBuf> {
        match scope {
            Scope::Global => None,
            Scope::Project => Some(project?.join("AGENTS.md")),
        }
    }
    fn connection_documents(
        &self,
        connection: &Connection,
        scope: Scope,
    ) -> Result<BTreeMap<String, Value>, String> {
        if scope == Scope::Project {
            return Err("Grok 项目层不能安全写入供应商连接；请使用全局配置".into());
        }
        let backend = match connection.interface_format.as_str() {
            "openai_completions" => "chat_completions",
            "openai_responses" => "responses",
            "anthropic_messages" => "messages",
            _ => return Err("Grok 不支持所选接口格式".into()),
        };
        let mut settings = json!({});
        let model = connection.model.as_str();
        set_json(&mut settings, &["models", "default"], json!(model));
        set_json(&mut settings, &["model", model, "model"], json!(model));
        set_json(
            &mut settings,
            &["model", model, "base_url"],
            json!(connection.base_url),
        );
        set_json(
            &mut settings,
            &["model", model, "api_backend"],
            json!(backend),
        );
        if let Some(env) = profile::auth_env_name(crate::domain::CliId::Grok, connection) {
            set_json(&mut settings, &["model", model, "env_key"], json!(env));
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
        let Some(current) = existing.get("settings") else {
            return Ok(docs);
        };
        let default = string_at(current, &["models", "default"]);
        let alias = default
            .filter(|id| {
                string_at(current, &["model", id, "model"]) == Some(connection.model.as_str())
            })
            .map(str::to_owned)
            .or_else(|| {
                current
                    .get("model")
                    .and_then(Value::as_object)
                    .and_then(|models| {
                        models
                            .iter()
                            .find(|(_, item)| {
                                item.get("model").and_then(Value::as_str)
                                    == Some(connection.model.as_str())
                            })
                            .map(|(alias, _)| alias.clone())
                    })
            });
        if let Some(alias) = alias {
            let root = docs.get_mut("settings").unwrap();
            let mut entry = root["model"][&connection.model].clone();
            if let Some(old) = current["model"][&alias].as_object() {
                let mut merged = old.clone();
                merged.extend(entry.as_object().unwrap().clone());
                entry = Value::Object(merged);
            }
            root["model"] = json!({alias.clone():entry});
            root["models"]["default"] = json!(alias);
        }
        Ok(docs)
    }
    fn write_connection_secret_for_documents(
        &self,
        profile: &RegisteredProfile,
        scope: Scope,
        credentials: &dyn CredentialStore,
        secrets: &mut NativeSecrets,
        documents: &BTreeMap<String, Value>,
    ) -> Result<(), String> {
        let Some(connection) = &profile.connection else {
            return Ok(());
        };
        let Some(id) = &connection.secret_ref else {
            return Ok(());
        };
        if scope == Scope::Project {
            return Err("Grok 项目层不能写入供应商密钥".into());
        }
        let alias = documents
            .get("settings")
            .and_then(|root| string_at(root, &["models", "default"]))
            .unwrap_or(&connection.model);
        secrets.put(
            "settings",
            &["model", alias, "api_key"],
            read_secret(id, credentials)?,
        );
        secrets.remove("settings", &["model", alias, "env_key"]);
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
            return Err("Grok 项目层不能写入供应商密钥；请使用全局配置".into());
        }
        secrets.put(
            "settings",
            &["model", &connection.model, "api_key"],
            read_secret(id, credentials)?,
        );
        secrets.remove("settings", &["model", &connection.model, "env_key"]);
        Ok(())
    }
    fn has_native_secret(&self, role: &str, root: &Value) -> bool {
        role == "settings"
            && root
                .get("model")
                .and_then(Value::as_object)
                .is_some_and(|models| models.values().any(|item| item.get("api_key").is_some()))
    }
    fn inspect_values(&self, settings: &Value, _: &Value, _: &Value) -> InspectionFields {
        let alias = string_at(settings, &["models", "default"]).map(str::to_owned);
        let model = alias
            .as_deref()
            .and_then(|id| string_at(settings, &["model", id, "model"]))
            .map(str::to_owned)
            .or_else(|| alias.clone());
        let (base, wire, env) = alias
            .as_ref()
            .map(|id| {
                (
                    string_at(settings, &["model", id, "base_url"]).map(str::to_owned),
                    string_at(settings, &["model", id, "api_backend"]).and_then(api_format),
                    string_at(settings, &["model", id, "env_key"]).map(str::to_owned),
                )
            })
            .unwrap_or((None, None, None));
        InspectionFields {
            provider: Some("grok".into()),
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
        super::import_toml_key(
            "model",
            "api_key",
            files
                .get("settings")
                .and_then(|text| crate::native::format::parse(FileKind::Toml, text).ok())
                .and_then(|root| string_at(&root, &["models", "default"]).map(str::to_owned))
                .as_deref(),
            files,
            found,
            pending,
        )
    }
    fn launch_args(&self, session: Option<&str>, mode: LaunchMode) -> Result<Vec<String>, String> {
        let mut args = Vec::new();
        if let Some(id) = session {
            args.extend(["--resume".into(), id.into()]);
        }
        if matches!(mode, LaunchMode::Yolo) {
            args.push("--yolo".into());
        }
        Ok(args)
    }
    fn supports_project_model_override(&self) -> bool {
        true
    }
    fn project_model_args(&self, model: Option<&str>) -> Result<Vec<String>, String> {
        let Some(model) = model else {
            return Ok(Vec::new());
        };
        if model.trim().is_empty() {
            return Err("请输入 Grok 项目启动模型".into());
        }
        Ok(vec!["-m".into(), model.into()])
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
            "https://docs.x.ai/build/overview",
            "按 Grok Build 官方安装说明更新；原生可用 grok update，npm 使用 npm 更新。",
        )
    }
    fn node_required_when_missing(&self) -> bool {
        false
    }
    fn minimum_node_version(&self) -> Option<(u32, u32, u32)> {
        Some((20, 0, 0))
    }
    fn node_dependency_detail(&self) -> &'static str {
        "npm 安装的 Grok 启动器要求 Node.js 20+；原生可执行文件不要求 Node.js"
    }
    fn native_binary_directories(&self, home: &Path) -> Vec<PathBuf> {
        vec![home.join(".grok/bin")]
    }
    fn recognizes_native_install_path(&self, path: &Path) -> bool {
        path.parent()
            .is_some_and(|parent| parent.ends_with(".grok/bin"))
    }
    fn install_command(&self) -> Option<String> {
        self.native_install_command()
    }
    fn native_install_command(&self) -> Option<String> {
        Some(
            if cfg!(windows) {
                "irm https://x.ai/cli/install.ps1 | iex"
            } else {
                "curl -fsSL https://x.ai/cli/install.sh | bash"
            }
            .into(),
        )
    }
    fn upgrade_command(&self, source: &str) -> Option<String> {
        match source {
            "npm_shim" => Some(format!("npm install -g {}@latest", self.npm_package())),
            "native" => self.native_install_command(),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_toml_keeps_native_permission_and_unrecognized_fields() {
        let text =
            "[permission]\nrules = [{ action = 'allow', tool = 'read' }]\n[future]\nflag = true\n";
        let parsed = crate::native::format::parse(FileKind::Toml, text).unwrap();
        let documents = BTreeMap::from([("settings".into(), parsed)]);
        Grok.validate_documents(Scope::Project, &documents).unwrap();
    }
}
