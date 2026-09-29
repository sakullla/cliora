use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::Path;

use super::{
    file, project_root, CliAdapter, InspectionFields, LaunchMode, McpLocation,
    NativeCredentialRefs, PendingSecrets,
};
use crate::credentials::CredentialStore;
use crate::native::adapter::{NativeFile, Scope};
use crate::native::apply::{read_secret, set_json, NativeSecrets};
use crate::native::format::FileKind;
use crate::native::intake::string_at;
use crate::native::intake::NativeInspection;
use crate::native::profile::{Connection, RegisteredProfile};
use crate::resources::mcp::{self, McpDefinition, McpTransport};

pub struct Claude;

impl CliAdapter for Claude {
    fn id(&self) -> &'static str {
        "claude_code"
    }
    fn name(&self) -> &'static str {
        "Claude Code"
    }
    fn command(&self) -> &'static str {
        "claude"
    }
    fn npm_package(&self) -> &'static str {
        "@anthropic-ai/claude-code"
    }
    fn version_identity(&self, _basename: &str, output: &str) -> bool {
        output.contains("claude")
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
            Some(root) => vec![
                file(
                    "settings",
                    root.join(".claude/settings.json"),
                    FileKind::Json,
                    known,
                    None,
                    false,
                ),
                file(
                    "local_settings",
                    root.join(".claude/settings.local.json"),
                    FileKind::Json,
                    known,
                    None,
                    false,
                ),
            ],
            None => vec![file(
                "settings",
                home.join(".claude/settings.json"),
                FileKind::Json,
                known,
                None,
                false,
            )],
        }
    }
    fn interface_formats(&self) -> &'static [&'static str] {
        &["anthropic_messages"]
    }
    fn file_kind(&self, role: &str) -> Result<FileKind, String> {
        if matches!(role, "settings" | "local_settings") {
            Ok(FileKind::Json)
        } else {
            Err("Claude Code 不支持此原生文件角色".into())
        }
    }
    fn mcp_location(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<McpLocation> {
        let path = match scope {
            Scope::Global => home.join(".claude.json"),
            Scope::Project => project?.join(".mcp.json"),
        };
        Some(McpLocation {
            path,
            kind: FileKind::Json,
            root: "mcpServers",
            child: None,
        })
    }
    fn mcp_disabled_description(&self) -> Option<&'static str> {
        Some("停用会移除原生条目，Cliora 中的定义仍保留")
    }
    fn mcp_document(
        &self,
        definition: &McpDefinition,
        enabled: bool,
        existing: Option<&Value>,
    ) -> Result<Option<Value>, String> {
        // Claude Code has no per-entry enabled flag in .mcp.json. Removing the
        // native entry stops loading it; Cliora keeps the definition for re-enable.
        if !enabled {
            return Ok(None);
        }
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
        Ok(Some(Value::Object(map)))
    }
    fn skill_root(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<std::path::PathBuf> {
        Some(match scope {
            Scope::Global => home.join(".claude/skills"),
            Scope::Project => project?.join(".claude/skills"),
        })
    }
    fn rule_path(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<std::path::PathBuf> {
        Some(match scope {
            Scope::Global => home.join(".claude/CLAUDE.md"),
            Scope::Project => project?.join("CLAUDE.md"),
        })
    }
    fn auth_env_name(&self, connection: &Connection) -> Option<String> {
        connection.auth_env_var.clone().or_else(|| {
            connection
                .secret_ref
                .as_ref()
                .map(|_| "ANTHROPIC_API_KEY".into())
        })
    }
    fn connection_documents(
        &self,
        connection: &Connection,
        _scope: Scope,
    ) -> Result<BTreeMap<String, Value>, String> {
        if connection.interface_format != "anthropic_messages" {
            return Err("Claude Code 此版本只支持 Anthropic Messages 接口".into());
        }
        let mut settings = json!({});
        set_json(&mut settings, &["model"], json!(connection.model));
        set_json(
            &mut settings,
            &["env", "ANTHROPIC_BASE_URL"],
            json!(connection.base_url),
        );
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
        let name = connection
            .auth_env_var
            .as_deref()
            .unwrap_or("ANTHROPIC_API_KEY");
        if !matches!(name, "ANTHROPIC_API_KEY" | "ANTHROPIC_AUTH_TOKEN") {
            return Err(
                "Claude Code 原生认证只支持 ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN".into(),
            );
        }
        let destination = if scope == Scope::Project {
            "local_settings"
        } else {
            "settings"
        };
        secrets.put(destination, &["env", name], read_secret(id, credentials)?);
        secrets.remove(
            destination,
            &[
                "env",
                if name == "ANTHROPIC_API_KEY" {
                    "ANTHROPIC_AUTH_TOKEN"
                } else {
                    "ANTHROPIC_API_KEY"
                },
            ],
        );
        if scope == Scope::Project {
            secrets.remove("settings", &["env", "ANTHROPIC_API_KEY"]);
            secrets.remove("settings", &["env", "ANTHROPIC_AUTH_TOKEN"]);
        }
        Ok(())
    }
    fn has_native_secret(&self, role: &str, root: &Value) -> bool {
        matches!(role, "settings" | "local_settings")
            && root
                .get("env")
                .and_then(Value::as_object)
                .is_some_and(|env| {
                    env.contains_key("ANTHROPIC_API_KEY")
                        || env.contains_key("ANTHROPIC_AUTH_TOKEN")
                })
    }
    fn inspect_values(
        &self,
        settings: &Value,
        local_settings: &Value,
        _: &Value,
    ) -> InspectionFields {
        InspectionFields {
            provider: Some("anthropic".into()),
            model: string_at(local_settings, &["model"])
                .or_else(|| string_at(settings, &["model"]))
                .map(str::to_owned),
            base: string_at(local_settings, &["env", "ANTHROPIC_BASE_URL"])
                .or_else(|| string_at(settings, &["env", "ANTHROPIC_BASE_URL"]))
                .map(str::to_owned),
            wire: Some("anthropic_messages"),
            ..InspectionFields::default()
        }
    }
    fn import_literal_secrets(
        &self,
        files: &mut BTreeMap<String, String>,
        found: &mut NativeInspection,
        pending: &mut PendingSecrets,
        native_refs: &mut NativeCredentialRefs,
    ) -> Result<(), String> {
        for role in ["settings", "local_settings"] {
            let mut text = files.get(role).cloned().unwrap_or_default();
            let parsed = crate::native::format::parse(FileKind::Json, &text)?;
            for name in ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] {
                let Some(key) = string_at(&parsed, &["env", name]) else {
                    continue;
                };
                if key.is_empty() || key.len() > 16_384 {
                    return Err("原生 API 密钥为空或超过系统凭据库限制；原文件未更改".into());
                }
                let id = format!("connection-{}", uuid::Uuid::new_v4());
                text = crate::native::format::set_path(
                    FileKind::Json,
                    &text,
                    &["env".into(), name.into()],
                    None,
                )?;
                native_refs
                    .entry(role.into())
                    .or_default()
                    .insert(name.into(), id.clone());
                pending.push((id.clone(), key.to_owned()));
                if name == "ANTHROPIC_API_KEY" {
                    if let Some(connection) = found.connection.as_mut() {
                        connection.secret_ref = Some(id);
                        connection.auth_env_var = Some(name.into());
                    }
                }
            }
            if native_refs.contains_key(role) {
                files.insert(role.into(), text);
            }
        }
        Ok(())
    }
    fn validate_draft(&self, role: &str, parsed: &Value) -> Result<(), String> {
        if !matches!(role, "settings" | "local_settings") {
            return Ok(());
        }
        if let Some(env) = parsed.get("env").and_then(Value::as_object) {
            if env.contains_key("ANTHROPIC_API_KEY") || env.contains_key("ANTHROPIC_AUTH_TOKEN") {
                return Err(
                    "Claude Code 原生配置中的认证字段不能存入草稿；请通过安全接入迁入系统凭据库"
                        .into(),
                );
            }
        }
        Ok(())
    }
    fn accepts_native_credential(&self, role: &str, name: &str) -> bool {
        matches!(role, "settings" | "local_settings")
            && matches!(name, "ANTHROPIC_API_KEY" | "ANTHROPIC_AUTH_TOKEN")
    }
    fn imported_connection_overrides_native(&self) -> bool {
        true
    }
    fn restore_imported_secrets(
        &self,
        profile: &RegisteredProfile,
        scope: Scope,
        credentials: &dyn CredentialStore,
        secrets: &mut NativeSecrets,
    ) -> Result<(), String> {
        let project = scope == Scope::Project;
        for role in if project {
            &["settings", "local_settings"][..]
        } else {
            &["settings"][..]
        } {
            secrets.remove(role, &["env", "ANTHROPIC_API_KEY"]);
            secrets.remove(role, &["env", "ANTHROPIC_AUTH_TOKEN"]);
        }
        let local = profile.native_credentials.get("local_settings");
        for (role, entries) in &profile.native_credentials {
            for (name, id) in entries {
                if profile
                    .connection
                    .as_ref()
                    .is_some_and(|connection| connection.secret_ref.is_some())
                {
                    secrets.remove(
                        if project {
                            "local_settings"
                        } else {
                            "settings"
                        },
                        &["env", name],
                    );
                    if project {
                        secrets.remove("settings", &["env", name]);
                    }
                    continue;
                }
                if project && role == "settings" {
                    secrets.remove("settings", &["env", name]);
                    if local.is_some_and(|items| items.contains_key(name)) {
                        continue;
                    }
                }
                let destination = if project {
                    "local_settings"
                } else {
                    "settings"
                };
                secrets.put(destination, &["env", name], read_secret(id, credentials)?);
            }
        }
        Ok(())
    }
    fn launch_args(&self, session: Option<&str>, mode: LaunchMode) -> Result<Vec<String>, String> {
        let mut args = Vec::new();
        if let Some(id) = session {
            args.extend(["--resume".into(), id.into()]);
        }
        if matches!(mode, LaunchMode::Yolo) {
            args.push("--dangerously-skip-permissions".into());
        }
        Ok(args)
    }
    fn install_guidance(&self) -> (&'static str, &'static str) {
        (
            "https://code.claude.com/docs/en/setup",
            "按 Claude Code 安装来源更新；原生安装可使用 claude update。",
        )
    }
    fn node_required_when_missing(&self) -> bool {
        false
    }
    fn minimum_node_version(&self) -> Option<(u32, u32, u32)> {
        Some((22, 0, 0))
    }
    fn node_dependency_detail(&self) -> &'static str {
        "Claude Code 的 npm 安装需要 Node.js 22 或更新版本"
    }
    fn recognizes_native_install_path(&self, path: &Path) -> bool {
        path.to_string_lossy()
            .replace('\\', "/")
            .to_ascii_lowercase()
            .contains("/.local/bin/claude")
    }
    fn install_command(&self) -> Option<String> {
        Some(
            if cfg!(windows) {
                "irm https://claude.ai/install.ps1 | iex"
            } else {
                "curl -fsSL https://claude.ai/install.sh | bash"
            }
            .into(),
        )
    }
    fn upgrade_command(&self, source: &str) -> Option<String> {
        match source {
            "npm_shim" => Some(format!("npm install -g {}@latest", self.npm_package())),
            "claude_native" => Some("claude update".into()),
            _ => None,
        }
    }
    fn anthropic_base_url(&self) -> &'static str {
        "https://api.anthropic.com"
    }
}
