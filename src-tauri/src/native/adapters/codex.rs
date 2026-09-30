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

impl CliAdapter for Codex {
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
            None => env::var_os("CODEX_HOME")
                .map(Into::into)
                .unwrap_or_else(|| home.join(".codex"))
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
        if role == "settings" { &["model", "model_provider", "model_reasoning_effort", "service_tier", "features", "model_providers", "approval_policy", "sandbox_mode"] } else { &[] }
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
            Scope::Global => home.join(".agents/skills"),
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
            Scope::Global => env::var_os("CODEX_HOME")
                .map(Into::into)
                .unwrap_or_else(|| home.join(".codex"))
                .join("AGENTS.md"),
            Scope::Project => project?.join("AGENTS.md"),
        })
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
        let provider = connection.provider_id.as_str();
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
        secrets.put(
            "settings",
            &[
                "model_providers",
                &connection.provider_id,
                "experimental_bearer_token",
            ],
            read_secret(id, credentials)?,
        );
        secrets.remove(
            "settings",
            &["model_providers", &connection.provider_id, "env_key"],
        );
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
        crate::history::codex::sources(home)
    }
    fn parse_history(
        &self,
        source: &crate::history::HistorySource,
    ) -> Result<crate::history::ParsedSession, String> {
        crate::history::codex::parse(source)
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
            "按官方文档更新 Codex CLI；使用原安装来源升级。",
        )
    }
}
