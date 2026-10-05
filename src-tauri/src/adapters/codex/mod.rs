pub mod accounts;
pub(crate) mod agents;
pub mod history;
pub(crate) mod plugins;
pub(crate) mod settings;
mod configuration;
pub(crate) mod usage;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::env;
use std::path::Path;

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

pub struct Codex;

const RESERVED_MODEL_PROVIDERS: &[&str] = &["openai", "ollama", "lmstudio"];

fn model_provider_id(id: &str) -> String {
    if RESERVED_MODEL_PROVIDERS.contains(&id) {
        format!("{id}-custom")
    } else {
        id.to_owned()
    }
}

fn skill_path_matches(item: &Value, skill_path: &Path) -> bool {
    let Some(raw) = item.get("path").and_then(Value::as_str) else {
        return false;
    };
    let expected = skill_path.join("SKILL.md");
    match (Path::new(raw).canonicalize(), expected.canonicalize()) {
        (Ok(actual), Ok(expected)) => actual == expected,
        _ => {
            let normalize = |path: &Path| {
                let raw = path.to_string_lossy().replace('\\', "/");
                let raw = raw
                    .strip_prefix("//?/UNC/")
                    .map(|p| format!("//{p}"))
                    .unwrap_or_else(|| raw.strip_prefix("//?/").unwrap_or(&raw).to_owned());
                if cfg!(windows) {
                    raw.to_lowercase()
                } else {
                    raw
                }
            };
            normalize(Path::new(raw)) == normalize(&expected)
        }
    }
}

impl CliAdapter for Codex {
    fn configuration(&self) -> Option<&dyn super::configuration::ConfigurationAdapter> {
        Some(self)
    }
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
        "codex"
    }
    fn name(&self) -> &'static str {
        "Codex"
    }
    fn command(&self) -> &'static str {
        "codex"
    }
    fn npm_package(&self) -> &'static str {
        "@openai/codex"
    }
    fn version_identity(&self, _basename: &str, output: &str) -> bool {
        output.contains("codex")
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
        let path = match root {
            Some(root) => root.join(".codex/config.toml"),
            None => crate::accounts::selection::config_root("codex", || {
                env::var_os("CODEX_HOME")
                    .map(Into::into)
                    .unwrap_or_else(|| home.join(".codex"))
            })
            .join("config.toml"),
        };
        vec![file("settings", path, FileKind::Toml, known, None, false)]
    }
    fn interface_formats(&self) -> &'static [&'static str] {
        &["openai_responses"]
    }
    fn file_kind(&self, role: &str) -> Result<FileKind, String> {
        if role == "settings" {
            Ok(FileKind::Toml)
        } else {
            Err("Codex 不支持此原生文件角色".into())
        }
    }
    fn portable_root_fields(&self, role: &str) -> &'static [&'static str] {
        if role == "settings" {
            &[
                "model",
                "model_provider",
                "model_reasoning_effort",
                "model_context_window",
                "model_reasoning_summary",
                "model_verbosity",
                "service_tier",
                "features",
                "model_providers",
                "approval_policy",
                "sandbox_mode",
            ]
        } else {
            &[]
        }
    }
    fn skill_switch_location(
        &self,
        _: Scope,
        home: &Path,
        _: Option<&Path>,
        _: &str,
    ) -> Option<super::SkillSwitchLocation> {
        let file = self
            .native_files(Scope::Global, home, None, true)
            .into_iter()
            .find(|file| file.role == "settings")?;
        Some(super::SkillSwitchLocation {
            path: file.path.into(),
            kind: FileKind::Toml,
            field: vec!["skills".into(), "config".into()],
        })
    }
    fn skill_switch_value(&self, current: &Value, enabled: bool, skill_path: &Path) -> Value {
        let mut entries = current.as_array().cloned().unwrap_or_default();
        let path = skill_path.join("SKILL.md");
        if let Some(item) = entries
            .iter_mut()
            .find(|item| skill_path_matches(item, skill_path))
        {
            item["enabled"] = json!(enabled);
        } else {
            entries.push(json!({"path":path.display().to_string(),"enabled":enabled}));
        }
        json!(entries)
    }
    fn skill_switch_enabled(&self, current: &Value, skill_path: &Path) -> bool {
        !current.as_array().is_some_and(|items| {
            items.iter().any(|item| {
                skill_path_matches(item, skill_path) && item.get("enabled") == Some(&json!(false))
            })
        })
    }
    fn skill_switch_snapshot(&self, current: &Value, skill_path: &Path) -> Option<Value> {
        current
            .as_array()?
            .iter()
            .find(|item| skill_path_matches(item, skill_path))
            .cloned()
    }
    fn skill_switch_restore(
        &self,
        current: &Value,
        previous: Option<&Value>,
        skill_path: &Path,
    ) -> Option<Value> {
        let mut entries = current.as_array().cloned().unwrap_or_default();
        if let Some(index) = entries
            .iter()
            .position(|item| skill_path_matches(item, skill_path))
        {
            if let Some(previous) = previous {
                entries[index] = previous.clone();
            } else {
                entries.remove(index);
            }
        } else if let Some(previous) = previous {
            entries.push(previous.clone());
        }
        (!entries.is_empty()).then(|| json!(entries))
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
            McpTransport::Http => mcp::http_doc(definition, existing, "http_headers"),
        };
        map.insert("enabled".into(), json!(enabled));
        Ok(Some(Value::Object(map)))
    }
    fn skill_root(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<std::path::PathBuf> {
        Some(match scope {
            Scope::Global => crate::accounts::selection::current("codex")
                .map(|ctx| ctx.resource_root.join("skills"))
                .unwrap_or_else(|| home.join(".agents/skills")),
            Scope::Project => project?.join(".agents/skills"),
        })
    }
    fn rule_path(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<std::path::PathBuf> {
        Some(match scope {
            Scope::Global => crate::accounts::selection::config_root("codex", || {
                env::var_os("CODEX_HOME")
                    .map(Into::into)
                    .unwrap_or_else(|| home.join(".codex"))
            })
            .join("AGENTS.md"),
            Scope::Project => project?.join("AGENTS.md"),
        })
    }
    fn connection_policy(&self, scope: Scope) -> crate::native::adapter::ConnectionPolicy {
        crate::native::adapter::ConnectionPolicy {
            api_key: if scope == Scope::Project {
                crate::native::adapter::api_key_scope_denied(
                    "Codex 项目层不能写入供应商密钥；请使用全局配置",
                )
            } else {
                crate::native::adapter::api_key_writable()
            },
            provider_address: crate::native::adapter::address_configurable(),
            projection: "current_model",
        }
    }
    fn connection_documents(
        &self,
        connection: &Connection,
        scope: Scope,
    ) -> Result<BTreeMap<String, Value>, String> {
        if scope == Scope::Project {
            return Err("Codex 项目层不能安全写入供应商连接；请使用全局配置".into());
        }
        if connection.interface_format != "openai_responses" {
            return Err("Codex 此版本只支持 Responses 供应商接口".into());
        }
        let mut settings = json!({});
        let provider_id = model_provider_id(&connection.provider_id);
        let provider = provider_id.as_str();
        set_json(&mut settings, &["model"], json!(connection.model));
        set_json(&mut settings, &["model_provider"], json!(provider));
        set_json(
            &mut settings,
            &["model_providers", provider, "name"],
            json!(provider),
        );
        set_json(
            &mut settings,
            &["model_providers", provider, "base_url"],
            json!(connection.base_url),
        );
        set_json(
            &mut settings,
            &["model_providers", provider, "wire_api"],
            json!("responses"),
        );
        if let Some(env) = profile::auth_env_name(crate::domain::CliId::Codex, connection) {
            set_json(
                &mut settings,
                &["model_providers", provider, "env_key"],
                json!(env),
            );
        }
        Ok(BTreeMap::from([("settings".into(), settings)]))
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
            return Err("Codex 项目层不能写入供应商密钥；请使用全局配置".into());
        }
        let provider_id = model_provider_id(&connection.provider_id);
        let provider = provider_id.as_str();
        secrets.put(
            "settings",
            &["model_providers", provider, "experimental_bearer_token"],
            read_secret(id, credentials)?,
        );
        secrets.remove("settings", &["model_providers", provider, "env_key"]);
        Ok(())
    }
    fn has_native_secret(&self, role: &str, root: &Value) -> bool {
        role == "settings"
            && root
                .get("model_providers")
                .and_then(Value::as_object)
                .is_some_and(|providers| {
                    providers
                        .values()
                        .any(|item| item.get("experimental_bearer_token").is_some())
                })
    }
    fn inspect_values(&self, settings: &Value, _: &Value, _: &Value) -> InspectionFields {
        let provider = string_at(settings, &["model_provider"]).map(str::to_owned);
        let model = string_at(settings, &["model"]).map(str::to_owned);
        let (base, wire, env) = provider
            .as_ref()
            .map(|id| {
                (
                    string_at(settings, &["model_providers", id, "base_url"]).map(str::to_owned),
                    string_at(settings, &["model_providers", id, "wire_api"]).and_then(api_format),
                    string_at(settings, &["model_providers", id, "env_key"]).map(str::to_owned),
                )
            })
            .unwrap_or((None, None, None));
        InspectionFields {
            provider,
            model,
            base,
            wire,
            env,
            reasoning_effort: string_at(settings, &["model_reasoning_effort"]).map(str::to_owned),
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
            "model_providers",
            "experimental_bearer_token",
            found.provider_id.as_deref().map(str::to_owned).as_deref(),
            files,
            found,
            pending,
        )
    }
    fn normalize_applied_document(&self, role: &str, document: &mut Value) {
        if role != "settings" {
            return;
        }
        let Some(root) = document.as_object_mut() else {
            return;
        };
        let renamed = {
            let Some(providers) = root
                .get_mut("model_providers")
                .and_then(Value::as_object_mut)
            else {
                return;
            };
            let mut renamed = Vec::new();
            for reserved in RESERVED_MODEL_PROVIDERS {
                if !providers.contains_key(*reserved) {
                    continue;
                }
                let custom = format!("{reserved}-custom");
                let entry = providers.remove(*reserved).unwrap();
                if !providers.contains_key(&custom) {
                    providers.insert(custom.clone(), entry);
                }
                renamed.push((*reserved, custom));
            }
            renamed
        };
        if let Some(current) = root
            .get("model_provider")
            .and_then(Value::as_str)
            .map(str::to_owned)
        {
            if let Some((_, custom)) = renamed.iter().find(|(reserved, _)| *reserved == current) {
                root.insert("model_provider".into(), json!(custom));
            }
        }
        if root
            .get("model_providers")
            .and_then(Value::as_object)
            .is_some_and(|providers| providers.is_empty())
        {
            root.remove("model_providers");
        }
    }
    fn validate_documents(
        &self,
        scope: Scope,
        documents: &BTreeMap<String, Value>,
    ) -> Result<(), String> {
        if scope == Scope::Project {
            let settings = documents.get("settings");
            if settings.and_then(|v| v.get("model_provider")).is_some()
                || settings.and_then(|v| v.get("model_providers")).is_some()
            {
                return Err("Codex 项目配置不能声明模型供应商".into());
            }
        }
        Ok(())
    }
    fn login_args(&self) -> Option<Vec<String>> {
        Some(vec!["login".into()])
    }
    fn login_hint(&self) -> &'static str {
        "在终端完成 Codex 原生登录。"
    }
    fn launch_args(&self, session: Option<&str>, mode: LaunchMode) -> Result<Vec<String>, String> {
        let mut args = Vec::new();
        if matches!(mode, LaunchMode::Yolo) {
            args.push("--yolo".into());
        }
        if let Some(id) = session {
            args.extend(["resume".into(), id.into()]);
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
        version.starts_with("0.")
    }
    fn install_guidance(&self) -> (&'static str, &'static str) {
        (
            "https://developers.openai.com/codex/cli",
            "原生安装用官方安装脚本更新；npm 安装用 npm 更新。不要同时留两份。",
        )
    }
    fn recognizes_native_install_path(&self, path: &Path) -> bool {
        let value = path
            .to_string_lossy()
            .replace('\\', "/")
            .to_ascii_lowercase();
        value.contains("/programs/openai/codex/") || value.contains("/.local/bin/codex")
    }
    fn install_command(&self) -> Option<String> {
        self.native_install_command()
    }
    fn native_install_command(&self) -> Option<String> {
        Some(
            if cfg!(windows) {
                "irm https://chatgpt.com/codex/install.ps1 | iex"
            } else {
                "curl -fsSL https://chatgpt.com/codex/install.sh | sh"
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
