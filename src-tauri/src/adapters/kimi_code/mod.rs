//! Kimi Code (Moonshot AI) terminal CLI adapter.
//!
//! Evidence base for the delivered capabilities is the locally verified 0.31.1
//! install (`kimi --version` prints a bare semver line; `kimi --help` documents
//! `-S/--session`, `-c`, `--yolo` and the absence of a `--cwd` flag) plus its
//! real data root: `config.toml` providers/models tables, `mcp.json`, session
//! `state.json` + `agents/*/wire.jsonl` and `plugins/managed/<id>` manifests.
//! The embedded bundle confirms the provider types `anthropic`, `openai`,
//! `openai_responses`, `kimi`, `google-genai` and `vertexai`, and that provider
//! credentials resolve from `api_key` inside config.toml (no shell env). See
//! docs/sakullla-workflow/2026-10-03-new-cli-adapters-default-off for sources.

pub(crate) mod agents;
pub mod history;
mod mcp_command;
pub(crate) mod plugins;

use std::collections::BTreeMap;
use std::env;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::{
    file, project_root, AdapterDescriptor, CliAdapter, Facet, InspectionFields, LaunchMode,
    ManagementCapabilities, McpLocation, NativeCredentialRefs, PendingSecrets,
};
use crate::credentials::CredentialStore;
use crate::native::adapter::{NativeFile, Scope};
use crate::native::apply::{read_secret, set_json, NativeSecrets};
use crate::native::format::{self, FileKind};
use crate::native::intake::{NativeInspection, string_at};
use crate::native::profile::{Connection, RegisteredProfile};
use crate::resources::mcp::{self, McpDefinition, McpTransport};

pub struct KimiCode;

/// Every Kimi Code artifact lives under one data root that `KIMI_CODE_HOME`
/// can relocate. Only the real user home honors the override, so tests with an
/// isolated home cannot be redirected into the runner's configuration.
pub(crate) fn config_dir(home: &Path) -> PathBuf {
    if dirs::home_dir().as_deref() == Some(home) {
        if let Some(root) = env::var_os("KIMI_CODE_HOME") {
            let path = PathBuf::from(root);
            if path.is_absolute() {
                return path;
            }
        }
    }
    home.join(".kimi-code")
}

/// Provider `type` values verified in the 0.31.1 bundle's provider switch.
fn provider_type(interface: &str) -> Result<&'static str, String> {
    match interface {
        "openai_completions" => Ok("openai"),
        "openai_responses" => Ok("openai_responses"),
        "anthropic_messages" => Ok("anthropic"),
        _ => Err("Kimi Code 不支持所选接口格式".into()),
    }
}

fn wire_format(value: &str) -> Option<&'static str> {
    match value {
        "openai" => Some("openai_completions"),
        "openai_responses" => Some("openai_responses"),
        "anthropic" => Some("anthropic_messages"),
        _ => None,
    }
}

fn model_alias(provider: &str, model: &str) -> String {
    format!("{provider}/{model}")
}

impl CliAdapter for KimiCode {
    fn supports_mcp(&self) -> bool {
        true
    }
    fn supports_skills(&self) -> bool {
        true
    }
    fn agents(&self) -> Option<&dyn crate::adapters::agents::AgentAdapter> {
        Some(self)
    }
    fn plugins(&self) -> Option<&dyn crate::adapters::plugins::PluginAdapter> {
        Some(self)
    }
    fn id(&self) -> &'static str {
        "kimi_code"
    }
    fn name(&self) -> &'static str {
        "Kimi Code"
    }
    fn command(&self) -> &'static str {
        "kimi"
    }
    fn npm_package(&self) -> &'static str {
        "@moonshot-ai/kimi-code"
    }
    /// `kimi --version` on 0.31.1 prints only the bare semver line ("0.31.1").
    fn version_identity(&self, basename: &str, output: &str) -> bool {
        basename == "kimi"
            && output
                .trim()
                .trim_start_matches('v')
                .starts_with(|character: char| character.is_ascii_digit())
    }
    fn native_files(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
        known: bool,
    ) -> Vec<NativeFile> {
        // The managed editing surface is the user-level config.toml only;
        // project-level `.kimi-code/local.toml` stays with the product.
        let Some(root) = project_root(scope, project) else {
            return vec![];
        };
        match root {
            Some(_) => Vec::new(),
            None => vec![file(
                "settings",
                config_dir(home).join("config.toml"),
                FileKind::Toml,
                known,
                None,
                false,
            ), file("tui", config_dir(home).join("tui.toml"), FileKind::Toml, known, Some("Kimi Code 终端界面配置；新终端会话读取"), false)],
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
        if matches!(role, "settings" | "tui") {
            Ok(FileKind::Toml)
        } else {
            Err("Kimi Code 不支持此原生文件角色".into())
        }
    }
    /// `providers` stays behind the managed boundary because it carries
    /// `api_key`; portable data never contains the credential.
    fn portable_root_fields(&self, role: &str) -> &'static [&'static str] {
        if role == "settings" {
            &["default_model", "models"]
        } else {
            &[]
        }
    }
    fn normalize_applied_document(&self, role: &str, document: &mut Value) {
        if role != "settings" { return; }
        if let Some(control) = document.get_mut("loop_control").and_then(Value::as_object_mut) {
            if let Some(value) = control.remove("max_retries_per_step") {
                control.entry("max_attempts_per_step").or_insert(value);
            }
        }
    }
    fn mcp_location(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<McpLocation> {
        let path = match scope {
            Scope::Global => config_dir(home).join("mcp.json"),
            Scope::Project => project?.join(".kimi-code/mcp.json"),
        };
        Some(McpLocation {
            path,
            kind: FileKind::Json,
            root: "mcpServers",
            child: None,
        })
    }
    fn rule_path(&self, scope: Scope, home: &Path, project: Option<&Path>) -> Option<PathBuf> {
        Some(match scope {
            Scope::Global => config_dir(home).join("AGENTS.md"),
            Scope::Project => {
                let root = project?;
                [root.join(".kimi-code/AGENTS.md"), root.join("AGENTS.md"), root.join("agents.md")]
                    .into_iter().find(|path| path.is_file()).unwrap_or_else(|| root.join("AGENTS.md"))
            }
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
        if definition.transport == McpTransport::Stdio { mcp_command::normalize(&mut map)?; }
        map.insert("enabled".into(), json!(enabled));
        Ok(Some(Value::Object(map)))
    }
    fn skill_root(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<PathBuf> {
        Some(match scope {
            Scope::Global => config_dir(home).join("skills"),
            Scope::Project => project?.join(".kimi-code/skills"),
        })
    }
    fn connection_documents(
        &self,
        connection: &Connection,
        scope: Scope,
    ) -> Result<BTreeMap<String, Value>, String> {
        if scope == Scope::Project {
            return Err("Kimi Code 连接只在用户级 config.toml 管理；项目层请使用原生 local.toml".into());
        }
        let kind = provider_type(&connection.interface_format)?;
        let alias = model_alias(&connection.provider_id, &connection.model);
        let mut settings = json!({});
        set_json(&mut settings, &["default_model"], json!(alias));
        set_json(
            &mut settings,
            &["models", &alias, "provider"],
            json!(connection.provider_id),
        );
        set_json(
            &mut settings,
            &["models", &alias, "model"],
            json!(connection.model),
        );
        set_json(
            &mut settings,
            &["providers", &connection.provider_id, "type"],
            json!(kind),
        );
        set_json(
            &mut settings,
            &["providers", &connection.provider_id, "base_url"],
            json!(connection.base_url),
        );
        Ok(BTreeMap::from([("settings".into(), settings)]))
    }
    fn connection_documents_for_existing(
        &self,
        connection: &Connection,
        scope: Scope,
        existing: &BTreeMap<String, Value>,
    ) -> Result<BTreeMap<String, Value>, String> {
        let mut documents = self.connection_documents(connection, scope)?;
        let Some(current) = existing.get("settings") else {
            return Ok(documents);
        };
        // Reuse the native alias already pointing at this provider+model and
        // keep unrelated provider fields (oauth tables, display_name) intact.
        let alias = current
            .get("models")
            .and_then(Value::as_object)
            .and_then(|models| {
                models.iter().find(|(_, entry)| {
                    entry.get("provider").and_then(Value::as_str)
                        == Some(connection.provider_id.as_str())
                        && entry.get("model").and_then(Value::as_str)
                            == Some(connection.model.as_str())
                })
            })
            .map(|(alias, _)| alias.clone());
        let Some(alias) = alias else {
            return Ok(documents);
        };
        let generated = model_alias(&connection.provider_id, &connection.model);
        let root = documents.get_mut("settings").unwrap();
        let entry = root
            .get_mut("models")
            .and_then(Value::as_object_mut)
            .and_then(|models| models.remove(&generated))
            .unwrap_or_else(|| json!({"provider": connection.provider_id, "model": connection.model}));
        root["models"][alias.as_str()] = entry;
        root["default_model"] = json!(alias);
        if let (Some(old), Some(new)) = (
            current
                .get("providers")
                .and_then(|providers| providers.get(&connection.provider_id)),
            root.get_mut("providers")
                .and_then(Value::as_object_mut)
                .and_then(|providers| providers.get_mut(&connection.provider_id)),
        ) {
            if let (Some(old), Some(new)) = (old.as_object(), new.as_object_mut()) {
                let mut merged = old.clone();
                merged.extend(new.clone());
                *new = merged;
            }
        }
        Ok(documents)
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
            return Err("Kimi Code 密钥只在用户级 config.toml 管理".into());
        }
        // config.toml api_key is the only channel Kimi Code reads for provider
        // credentials; the OS credential store owns the value until apply.
        secrets.put(
            "settings",
            &["providers", &connection.provider_id, "api_key"],
            read_secret(id, credentials)?,
        );
        Ok(())
    }
    fn has_native_secret(&self, role: &str, root: &Value) -> bool {
        role == "settings"
            && root
                .get("providers")
                .and_then(Value::as_object)
                .is_some_and(|providers| {
                    providers.values().any(|item| {
                        item.get("api_key")
                            .and_then(Value::as_str)
                            .is_some_and(|key| !key.is_empty())
                    })
                })
    }
    fn inspect_values(&self, settings: &Value, _: &Value, _: &Value) -> InspectionFields {
        let alias = string_at(settings, &["default_model"]).map(str::to_owned);
        let entry = alias.as_deref().and_then(|id| {
            settings.get("models").and_then(|models| models.get(id))
        });
        let provider = entry
            .and_then(|value| value.get("provider"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| {
                alias
                    .as_deref()
                    .and_then(|id| id.split_once('/').map(|(head, _)| head.to_owned()))
            });
        let model = entry
            .and_then(|value| value.get("model"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| {
                alias
                    .as_deref()
                    .and_then(|id| id.rsplit_once('/').map(|(_, tail)| tail.to_owned()))
            });
        let provider_entry = provider
            .as_deref()
            .and_then(|id| settings.get("providers").and_then(|value| value.get(id)));
        let base = provider_entry
            .and_then(|value| value.get("base_url"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let wire = provider_entry
            .and_then(|value| value.get("type"))
            .and_then(Value::as_str)
            .and_then(wire_format);
        InspectionFields {
            provider,
            model,
            base,
            wire,
            env: None,
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
        let text = files.get("settings").cloned().unwrap_or_default();
        let parsed = format::parse(FileKind::Toml, &text)?;
        // The active provider is the one behind default_model's alias.
        let active = string_at(&parsed, &["default_model"])
            .and_then(|alias| {
                parsed
                    .get("models")
                    .and_then(|models| models.get(alias))
                    .and_then(|entry| entry.get("provider"))
                    .and_then(Value::as_str)
            })
            .map(str::to_owned);
        if let Some(providers) = parsed.get("providers").and_then(Value::as_object) {
            for (name, entry) in providers {
                // An empty api_key is the OAuth-managed placeholder (verified
                // on the managed:kimi-code provider) and carries no secret.
                let Some(key) = entry
                    .get("api_key")
                    .and_then(Value::as_str)
                    .filter(|key| !key.is_empty())
                else {
                    continue;
                };
                if active.as_deref() != Some(name.as_str()) || found.connection.is_none() {
                    return Err(format!(
                        "providers.{name}.api_key 含字面密钥，但不是当前默认连接；请先在 CLI 中选定该供应商与模型，原文件未更改"
                    ));
                }
                if key.len() > 16_384 {
                    return Err("原生 API 密钥为空或过长；原文件未更改".into());
                }
                let id = format!("connection-{}", uuid::Uuid::new_v4());
                let replaced = format::set_path(
                    FileKind::Toml,
                    &text,
                    &["providers".into(), name.clone(), "api_key".into()],
                    None,
                )?;
                files.insert("settings".into(), replaced);
                found.connection.as_mut().unwrap().secret_ref = Some(id.clone());
                pending.push((id, key.to_owned()));
            }
        }
        Ok(())
    }
    /// Kimi Code does not read provider keys from a shell environment; the
    /// default synthetic name would promise a channel the CLI ignores.
    fn auth_env_name(&self, connection: &Connection) -> Option<String> {
        connection.auth_env_var.clone().filter(|name| {
            crate::native::profile::valid_env_name(name)
        })
    }
    fn launch_args(&self, session: Option<&str>, mode: LaunchMode) -> Result<Vec<String>, String> {
        let mut args = Vec::new();
        if let Some(id) = session {
            args.extend(["-S".into(), id.into()]);
        }
        if matches!(mode, LaunchMode::Yolo) {
            args.push("--yolo".into());
        }
        Ok(args)
    }
    fn history_sources(&self, home: &Path) -> Result<Vec<crate::history::HistorySource>, String> {
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
        home: &Path,
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
        // Both the original 0.x CLI and the locally verified 2.1.1 use -S.
        semver::Version::parse(version.trim().trim_start_matches('v'))
            .is_ok_and(|version| version.major <= 2)
    }
    fn install_guidance(&self) -> (&'static str, &'static str) {
        (
            "https://kimi.com/code/docs",
            "Windows 原生安装：irm https://code.kimi.com/kimi-code/install.ps1 | iex（macOS/Linux 使用 install.sh）；npm 安装需要 Node.js 22.19+。更新可用 kimi upgrade。",
        )
    }
    fn node_required_when_missing(&self) -> bool {
        false
    }
    fn minimum_node_version(&self) -> Option<(u32, u32, u32)> {
        Some((22, 19, 0))
    }
    fn node_dependency_detail(&self) -> &'static str {
        "npm 安装的 @moonshot-ai/kimi-code 要求 Node.js 22.19+；原生可执行文件不要求 Node.js"
    }
    fn native_binary_directories(&self, home: &Path) -> Vec<PathBuf> {
        vec![config_dir(home).join("bin")]
    }
    fn recognizes_native_install_path(&self, path: &Path) -> bool {
        path.parent()
            .is_some_and(|parent| parent.ends_with(".kimi-code/bin"))
    }
    fn install_command(&self) -> Option<String> {
        self.native_install_command()
    }
    fn native_install_command(&self) -> Option<String> {
        Some(
            if cfg!(windows) {
                "irm https://code.kimi.com/kimi-code/install.ps1 | iex"
            } else {
                "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash"
            }
            .into(),
        )
    }
    fn upgrade_command(&self, source: &str) -> Option<String> {
        match source {
            "npm_shim" => Some(format!("npm install -g {}@latest", self.npm_package())),
            "native" => Some("kimi upgrade".into()),
            _ => None,
        }
    }
    fn descriptor(&self) -> AdapterDescriptor {
        AdapterDescriptor {
            id: self.id(),
            name: self.name(),
            interface_formats: self.interface_formats(),
            project_model_override: false,
            yolo_available: true,
            launch_form: self.launch_form(),
            native_config: Facet {
                state: "available",
                reason: "已确认 CLI 身份，可编辑用户级 config.toml（TOML）",
            },
            launch: Facet {
                state: "available",
                reason: "以所选工作目录启动外部终端；--yolo 为 Ask When Needed：常规操作自动执行、高危操作仍会询问",
            },
            resume: Facet {
                state: "available",
                reason: "可用原生会话 ID 以 -S 参数在外部终端恢复",
            },
            resources: Facet {
                state: "available",
                reason: "MCP（mcp.json）、Skills、Agents 由原生路径提供；插件只读列举托管目录",
            },
            history: Facet {
                state: "available",
                reason: "可只读索引 sessions 下的 state.json 与 wire.jsonl 并统计 token 用量",
            },
            login: None,
            management: ManagementCapabilities {
                accounts: false,
                mcp: true,
                skills: true,
                agents: true,
                // Read-only listing only ("list" is the sole capability verb);
                // every management verb stays inside the session UI (/plugins)
                // and the shared surface hides all operation buttons.
                plugins: true,
                project_plugins: false,
                rules: self.rule_support(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::LaunchForm;
    use crate::adapters::plugins::PluginAdapter as _;
    use crate::resources::mcp::{self, McpTargetRequest, McpTransport};
    use std::collections::HashMap;
    use std::sync::Mutex;

    const CONFIG_FIXTURE: &str =
        include_str!("../../../../tests/fixtures/native/kimi-code-0.31.1.toml");

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
                .ok_or("missing key".into())
        }
        fn delete(&self, id: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(id);
            Ok(())
        }
    }

    fn connection() -> Connection {
        Connection {
            provider_id: "custom-openai".into(),
            interface_format: "openai_completions".into(),
            base_url: "https://api.example.com/v1".into(),
            model: "demo-model".into(),
            secret_ref: Some("connection-930b8796-7d77-4e70-a8ba-6209ff1272e8".into()),
            auth_env_var: None,
        }
    }

    #[test]
    fn config_fixture_round_trips_and_inspects_without_secrets() {
        let parsed = format::parse(FileKind::Toml, CONFIG_FIXTURE).unwrap();
        let rendered = format::render(FileKind::Toml, &parsed).unwrap();
        let reparsed = format::parse(FileKind::Toml, &rendered).unwrap();
        assert_eq!(parsed, reparsed);
        // The real managed provider keeps an empty api_key placeholder.
        assert!(!KimiCode.has_native_secret("settings", &parsed));
        let inspection = KimiCode.inspect_values(&parsed, &Value::Null, &Value::Null);
        assert_eq!(inspection.provider.as_deref(), Some("managed:kimi-code"));
        assert_eq!(inspection.model.as_deref(), Some("k3"));
        assert_eq!(
            inspection.base.as_deref(),
            Some("https://api.kimi.com/coding/v1")
        );
        // The managed provider speaks the native "kimi" wire, which has no
        // Cliora interface-format counterpart.
        assert_eq!(inspection.wire, None);
        assert_eq!(provider_type("openai_completions").unwrap(), "openai");
        assert_eq!(provider_type("openai_responses").unwrap(), "openai_responses");
        assert_eq!(provider_type("anthropic_messages").unwrap(), "anthropic");
        assert!(provider_type("unknown_wire").is_err());
        assert_eq!(wire_format("openai"), Some("openai_completions"));
        assert_eq!(wire_format("anthropic"), Some("anthropic_messages"));
        assert_eq!(wire_format("kimi"), None);
    }

    #[test]
    fn connection_documents_target_provider_api_key_and_portable_fields_exclude_it() {
        let documents = KimiCode
            .connection_documents(&connection(), Scope::Global)
            .unwrap();
        let settings = documents.get("settings").unwrap();
        assert_eq!(
            settings["default_model"], "custom-openai/demo-model",
            "默认模型别名应指向新连接"
        );
        assert_eq!(settings["models"]["custom-openai/demo-model"]["provider"], "custom-openai");
        assert_eq!(settings["providers"]["custom-openai"]["type"], "openai");
        // The rendered draft never contains api_key; only the secret channel writes it.
        let text = format::render(FileKind::Toml, settings).unwrap();
        assert!(!text.contains("api_key"));
        for field in KimiCode.portable_root_fields("settings") {
            assert!(
                !field.contains("provider"),
                "可携带字段不得包含 providers（含 api_key）"
            );
        }
    }

    #[test]
    fn apply_profile_writes_secret_to_config_and_keeps_native_fields() {
        let temp = tempfile::tempdir().unwrap();
        let db = crate::database::Database::open(&temp.path().join("cliora.db")).unwrap();
        let keys = MemoryStore::default();
        keys.put("connection-930b8796-7d77-4e70-a8ba-6209ff1272e8", "sk-test-secret-value")
            .unwrap();
        let config = temp.path().join(".kimi-code/config.toml");
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();
        std::fs::write(&config, CONFIG_FIXTURE).unwrap();
        // The apply pipeline verifies the stored profile snapshot, so save it
        // first exactly like the IPC layer does.
        let profile = crate::native::profile::save_registered_profile(
            &db,
            &crate::adapters::Registry::builtins(),
            RegisteredProfile {
                id: String::new(),
                tool: "kimi_code".into(),
                name: "demo".into(),
                version: 1,
                revision: String::new(),
                inherit_common: false,
                files: BTreeMap::new(),
                suppressed: BTreeMap::new(),
                authentication: Default::default(),
                connection: Some(connection()),
                native_credentials: BTreeMap::new(),
            },
            None,
        )
        .unwrap();
        let native_files = KimiCode.native_files(Scope::Global, temp.path(), None, true);
        crate::native::apply::apply_registered_validated(
            &crate::adapters::Registry::builtins(),
            &db,
            &keys,
            &profile,
            None,
            &native_files,
            "global",
            Scope::Global,
            true,
        )
        .unwrap();
        let written = std::fs::read_to_string(&config).unwrap();
        assert!(
            written.contains("sk-test-secret-value"),
            "应用后 config.toml 应包含来自系统凭据库的 api_key：{written}"
        );
        assert!(written.contains("[services.moonshot_search]"), "无关原生段应保留");
        assert!(
            written.contains("custom-openai"),
            "新供应商与模型别名应写入：{written}"
        );
        // The stored profile documents and the DB never hold the plaintext.
        let row: Option<String> = db
            .with_connection(|conn| {
                conn.query_row(
                    "SELECT value FROM applied_bindings LIMIT 1",
                    [],
                    |row| row.get(0),
                )
                .map_err(|_| "no binding".into())
            })
            .ok();
        if let Some(value) = row {
            assert!(!value.contains("sk-test-secret-value"));
        }
    }

    #[test]
    fn import_moves_literal_api_key_into_credential_store() {
        let literal = CONFIG_FIXTURE.replace(
            "base_url = \"https://api.kimi.com/coding/v1\"\napi_key = \"\"",
            "base_url = \"https://api.kimi.com/coding/v1\"\napi_key = \"sk-live-literal\"",
        );
        assert!(literal.contains("sk-live-literal"));
        let mut files = BTreeMap::from([("settings".into(), literal)]);
        let mut found = NativeInspection {
            provider_id: Some("managed:kimi-code".into()),
            model: Some("k3".into()),
            connection: Some(connection()),
            reasoning_effort: None,
        };
        let mut pending = Vec::new();
        let mut refs = NativeCredentialRefs::new();
        KimiCode
            .import_literal_secrets(&mut files, &mut found, &mut pending, &mut refs)
            .unwrap();
        let rewritten = files.get("settings").unwrap();
        assert!(!rewritten.contains("sk-live-literal"), "明文密钥必须移出文件");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].1, "sk-live-literal");
        assert_eq!(
            found.connection.as_ref().unwrap().secret_ref.as_deref(),
            Some(pending[0].0.as_str())
        );
    }

    #[test]
    fn import_rejects_literal_key_on_inactive_provider_and_keeps_file() {
        let literal = CONFIG_FIXTURE.replace(
            "[providers.\"managed:kimi-code\"]",
            "[providers.\"other\"]\napi_key = \"sk-other\"\n\n[providers.\"managed:kimi-code\"]",
        );
        let mut files = BTreeMap::from([("settings".into(), literal.clone())]);
        let mut found = NativeInspection {
            provider_id: Some("managed:kimi-code".into()),
            model: Some("k3".into()),
            connection: Some(connection()),
            reasoning_effort: None,
        };
        let error = KimiCode
            .import_literal_secrets(&mut files, &mut found, &mut Vec::new(), &mut NativeCredentialRefs::new())
            .unwrap_err();
        assert!(error.contains("other"), "{error}");
        assert_eq!(files.get("settings").unwrap(), &literal, "原文件不得更改");
    }

    #[test]
    fn launch_args_cover_normal_yolo_and_resume() {
        assert!(KimiCode.launch_args(None, LaunchMode::Normal).unwrap().is_empty());
        assert_eq!(
            KimiCode.launch_args(None, LaunchMode::Yolo).unwrap(),
            vec!["--yolo"]
        );
        assert_eq!(
            KimiCode
                .launch_args(Some("session_abc"), LaunchMode::Normal)
                .unwrap(),
            vec!["-S", "session_abc"]
        );
        assert_eq!(
            KimiCode
                .launch_args(Some("session_abc"), LaunchMode::Yolo)
                .unwrap(),
            vec!["-S", "session_abc", "--yolo"]
        );
        let descriptor = KimiCode.descriptor();
        assert!(descriptor.yolo_available);
        assert_eq!(descriptor.launch_form, LaunchForm::Terminal);
        assert!(!descriptor.management.accounts);
        assert!(descriptor.management.mcp && descriptor.management.skills && descriptor.management.agents);
        assert!(descriptor.management.plugins && !descriptor.management.project_plugins);
        // The plugin surface is listing-only: "list" is the sole verb and the
        // shared UI offers no install/enable/disable/uninstall button.
        assert_eq!(KimiCode.capability().actions, vec!["list"]);
    }

    #[test]
    fn version_identity_matches_bare_semver_of_the_kimi_binary() {
        assert!(KimiCode.version_identity("kimi", "0.31.1"));
        assert!(KimiCode.version_identity("kimi", "0.32.0\r\n"));
        assert!(!KimiCode.version_identity("kimi", "some other tool 1.0"));
        assert!(!KimiCode.version_identity("other", "0.31.1"));
    }

    #[test]
    fn mcp_entries_round_trip_through_the_shared_transaction() {
        let temp = tempfile::tempdir().unwrap();
        let db = crate::database::Database::open(&temp.path().join("cliora.db")).unwrap();
        let keys = MemoryStore::default();
        let registry = crate::adapters::Registry::builtins();
        let user_file = temp.path().join(".kimi-code/mcp.json");
        std::fs::create_dir_all(user_file.parent().unwrap()).unwrap();
        std::fs::write(
            &user_file,
            "{\"mcpServers\":{\"other\":{\"command\":\"echo\",\"args\":[]}}}",
        )
        .unwrap();
        let definition = mcp::save_definition(
            &db,
            mcp::McpDraft {
                id: None,
                name: "example".into(),
                transport: McpTransport::Stdio,
                command: "fixture-runner".into(),
                args: vec!["-y".into(), "example-mcp".into()],
                url: String::new(),
                env: BTreeMap::from([("API_KEY".into(), "${EXAMPLE_KEY}".into())]),
                headers: BTreeMap::new(),
                in_library: true,
                expected_version: None,
            },
        )
        .unwrap();
        let target = |enabled: bool| McpTargetRequest {
            context_id: None,
            tool_id: "kimi_code".into(),
            scope: Scope::Global,
            project_path: None,
            enabled,
            baseline_hash: None,
            allow_replace: false,
            preview_token: None,
        };
        // Mirror the shared preview→distribute handshake: the token handed to
        // distribute must come from a fresh preview of the current native file.
        let previewed = |enabled: bool| {
            let inspected = mcp::preview_targets(
                &db,
                &registry,
                temp.path(),
                &definition.id,
                vec![target(enabled)],
            )
            .remove(0);
            assert_eq!(inspected.status, "ready", "{inspected:?}");
            mcp::McpTargetRequest {
                baseline_hash: inspected.baseline_hash.clone(),
                preview_token: inspected.preview_token.clone(),
                ..target(enabled)
            }
        };
        let preview = mcp::preview_targets(
            &db,
            &registry,
            temp.path(),
            &definition.id,
            vec![target(true)],
        );
        assert_eq!(preview[0].status, "ready", "{preview:?}");
        assert_eq!(
            std::path::PathBuf::from(preview[0].path.clone().unwrap()),
            user_file,
            "Kimi Code 全局 MCP 应写到 ~/.kimi-code/mcp.json"
        );
        let written = mcp::distribute(
            &db,
            &keys,
            &registry,
            temp.path(),
            &definition.id,
            vec![previewed(true)],
        );
        assert_eq!(written[0].status, "written", "{written:?}");
        let text = std::fs::read_to_string(&user_file).unwrap();
        assert!(text.contains("\"mcpServers\""));
        assert!(text.contains("\"other\""), "原生既有条目应保留");
        assert!(text.contains("\"command\": \"fixture-runner\""));
        assert!(text.contains("\"enabled\": true"));
        let listed = mcp::list_native(&db, &registry, temp.path(), &target(true)).unwrap();
        let example = listed.iter().find(|entry| entry.name == "example").unwrap();
        assert!(example.enabled);
        assert_eq!(example.command, "fixture-runner");
        // Disabling keeps the native entry with the documented enabled flag;
        // the file changed, so a fresh preview is required first.
        let after = mcp::distribute(
            &db,
            &keys,
            &registry,
            temp.path(),
            &definition.id,
            vec![previewed(false)],
        );
        assert_eq!(after[0].status, "written", "{after:?}");
        let disabled_text = std::fs::read_to_string(&user_file).unwrap();
        assert!(disabled_text.contains("\"enabled\": false"));
        assert!(disabled_text.contains("\"other\""));
    }

    #[test]
    fn deprecated_loop_field_migrates_without_overwriting_current_value() {
        let mut document = json!({"loop_control":{"max_retries_per_step":3,"other":true},"models":{}});
        KimiCode.normalize_applied_document("settings", &mut document);
        assert_eq!(document["loop_control"], json!({"max_attempts_per_step":3,"other":true}));
        document["loop_control"]["max_retries_per_step"] = json!(8);
        KimiCode.normalize_applied_document("settings", &mut document);
        assert_eq!(document["loop_control"]["max_attempts_per_step"], 3);
        assert!(document["loop_control"].get("max_retries_per_step").is_none());
        let mut tui = json!({"loop_control":{"max_retries_per_step":8}});
        let original = tui.clone();
        KimiCode.normalize_applied_document("tui", &mut tui);
        assert_eq!(tui, original);
    }

    #[test]
    fn resource_roots_follow_official_kimi_directories() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        assert_eq!(
            KimiCode.skill_root(Scope::Global, temp.path(), None).unwrap(),
            temp.path().join(".kimi-code/skills")
        );
        assert_eq!(
            KimiCode
                .skill_root(Scope::Project, temp.path(), Some(&project))
                .unwrap(),
            project.join(".kimi-code/skills")
        );
        let mcp = KimiCode
            .mcp_location(Scope::Project, temp.path(), Some(&project))
            .unwrap();
        assert_eq!(mcp.path, project.join(".kimi-code/mcp.json"));
        assert_eq!(mcp.root, "mcpServers");
        assert!(KimiCode
            .native_files(Scope::Project, temp.path(), Some(&project), true)
            .is_empty());
        assert!(crate::adapters::agents::validate(
            "kimi_code",
            "markdown",
            agent_template(),
            "fallback"
        )
        .is_ok());
    }

    fn agent_template() -> &'static str {
        crate::adapters::agents::get("kimi_code")
            .unwrap()
            .capability()
            .template
    }
}
