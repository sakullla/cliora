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

pub struct OpenCode;

impl CliAdapter for OpenCode {
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
            env::var_os("XDG_CONFIG_HOME")
                .map(Into::into)
                .unwrap_or_else(|| home.join(".config"))
                .join("opencode")
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
                let mut map = mcp::stdio_doc_with_env(definition, existing, "environment");
                map.remove("args");
                map.insert(
                    "command".into(),
                    json!(std::iter::once(&definition.command)
                        .chain(definition.args.iter())
                        .collect::<Vec<_>>()),
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
            Scope::Global => env::var_os("XDG_CONFIG_HOME")
                .map(Into::into)
                .unwrap_or_else(|| home.join(".config"))
                .join("opencode/skills"),
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
            Scope::Global => env::var_os("XDG_CONFIG_HOME")
                .map(Into::into)
                .unwrap_or_else(|| home.join(".config"))
                .join("opencode/AGENTS.md"),
            Scope::Project => project?.join("AGENTS.md"),
        })
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
    fn install_guidance(&self) -> (&'static str, &'static str) {
        (
            "https://opencode.ai/docs/",
            "使用 opencode upgrade 或原安装来源更新。",
        )
    }
}
