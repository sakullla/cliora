//! ZCode (Z.ai) desktop-application adapter.
//!
//! ZCode is an Electron desktop app, so there is no `--version` pipeline:
//! installation is identified through the official Windows install markers
//! (`zcode://` protocol registration, the per-user uninstall entry and the
//! `.zcode-install-manifest` file; see `install`). The managed native config
//! surface is `~/.zcode/v2/setting.json`; the product-owned encrypted
//! `~/.zcode/v2/credentials.json` is never read or written. MCP entries live in
//! `~/.zcode/cli/config.json` under the nested `mcp.servers` key; Skills and
//! agent definitions use the shared resource roots (`~/.zcode/skills`,
//! `~/.zcode/agents`); sessions come from the bundled agent's model-io rollout
//! logs plus legacy task snapshots (see `history`); plugins are listed read-only
//! from `installed_plugins.json` (see `plugins`). Session resume, YOLO and
//! credential management have no verified desktop contract and stay
//! undelivered.

pub(crate) mod agents;
pub mod history;
mod install;
pub(crate) mod plugins;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::{
    file, AdapterDescriptor, CliAdapter, Facet, InspectionFields, LaunchForm, LaunchMode,
    ManagementCapabilities, McpLocation,
};
use crate::credentials::CredentialStore;
use crate::native::adapter::{NativeFile, Scope};
use crate::native::apply::NativeSecrets;
use crate::native::format::FileKind;
use crate::native::profile::{Connection, RegisteredProfile};
use crate::resources::mcp::{self, McpDefinition, McpTransport};

pub struct ZCode;

/// ZCode relocates its whole data root through `ZCODE_DATA_BASE_DIR`
/// (official packages/services/src/paths.ts); the default is `~/.zcode`.
pub(crate) fn data_root(home: &Path) -> PathBuf {
    std::env::var_os("ZCODE_DATA_BASE_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".zcode"))
}

impl CliAdapter for ZCode {
    fn agents(&self) -> Option<&dyn crate::adapters::agents::AgentAdapter> {
        Some(self)
    }
    fn plugins(&self) -> Option<&dyn crate::adapters::plugins::PluginAdapter> {
        Some(self)
    }
    fn id(&self) -> &'static str {
        "zcode"
    }
    fn name(&self) -> &'static str {
        "ZCode"
    }
    fn command(&self) -> &'static str {
        "zcode"
    }
    fn npm_package(&self) -> &'static str {
        ""
    }
    /// The desktop binary has no verified `--version` contract (it opens the
    /// app instead of printing); installation identity comes from the official
    /// install markers, never from a fabricated version string.
    fn version_identity(&self, _basename: &str, _output: &str) -> bool {
        false
    }
    fn native_files(
        &self,
        scope: Scope,
        home: &Path,
        _project: Option<&Path>,
        known: bool,
    ) -> Vec<NativeFile> {
        // setting.json is the app-level config the desktop writes atomically;
        // there is no per-project native config file.
        if scope != Scope::Global {
            return Vec::new();
        }
        vec![file(
            "settings",
            data_root(home).join("v2").join("setting.json"),
            FileKind::Json,
            known,
            None,
            false,
        )]
    }
    fn interface_formats(&self) -> &'static [&'static str] {
        &[]
    }
    fn file_kind(&self, role: &str) -> Result<FileKind, String> {
        if role == "settings" {
            Ok(FileKind::Json)
        } else {
            Err("ZCode 桌面端只管理 ~/.zcode/v2/setting.json".into())
        }
    }
    fn connection_documents(
        &self,
        _connection: &Connection,
        _scope: Scope,
    ) -> Result<BTreeMap<String, Value>, String> {
        Err("ZCode 桌面端经产品内账号登录；setting.json 无文档化 API 连接字段".into())
    }
    fn write_connection_secret(
        &self,
        _profile: &RegisteredProfile,
        _scope: Scope,
        _credentials: &dyn CredentialStore,
        _secrets: &mut NativeSecrets,
    ) -> Result<(), String> {
        Err("ZCode 凭据由产品加密保管（credentials.json），不提供凭据管理".into())
    }
    fn has_native_secret(&self, _role: &str, _root: &Value) -> bool {
        false
    }
    fn inspect_values(
        &self,
        _settings: &Value,
        _local_settings: &Value,
        _models: &Value,
    ) -> InspectionFields {
        InspectionFields::default()
    }
    fn launch_args(
        &self,
        session: Option<&str>,
        mode: LaunchMode,
    ) -> Result<Vec<String>, String> {
        if session.is_some() {
            return Err("ZCode 桌面端官方无会话恢复启动契约".into());
        }
        if matches!(mode, LaunchMode::Yolo) {
            return Err("ZCode 桌面端无已验证的跳过审批启动参数".into());
        }
        // Bare launch: the shared desktop channel resolves the installed exe.
        Ok(Vec::new())
    }
    fn launch_form(&self) -> LaunchForm {
        LaunchForm::Desktop
    }
    /// Official desktop argument: `--open-workspace=<path>` is forwarded to a
    /// running instance through the single-instance lock
    /// (packages/desktop desktopDeepLinkUrl.ts OPEN_WORKSPACE_ARG).
    fn desktop_launch_args(&self, directory: &Path) -> Result<Vec<String>, String> {
        Ok(vec![format!("--open-workspace={}", directory.display())])
    }
    fn supports_mcp(&self) -> bool {
        true
    }
    fn mcp_location(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<McpLocation> {
        let path = match scope {
            Scope::Global => data_root(home).join("cli").join("config.json"),
            Scope::Project => project?.join(".zcode").join("config.json"),
        };
        Some(McpLocation {
            path,
            kind: FileKind::Json,
            root: "mcp",
            child: Some("servers"),
        })
    }
    fn mcp_document(
        &self,
        definition: &McpDefinition,
        enabled: bool,
        existing: Option<&Value>,
    ) -> Result<Option<Value>, String> {
        // ZCode's own MCP source reads `mcp.servers` entries shaped as
        // McpServerConfig (packages/shared/src/mcp.ts): command/args/env for
        // stdio, url/headers for HTTP, with a real `enabled` flag.
        let mut map = match definition.transport {
            McpTransport::Stdio => mcp::stdio_doc(definition, existing),
            McpTransport::Http => mcp::http_doc(definition, existing, "headers"),
        };
        map.insert(
            "type".into(),
            Value::String(
                if definition.transport == McpTransport::Http {
                    "http"
                } else {
                    "stdio"
                }
                .into(),
            ),
        );
        map.insert("enabled".into(), Value::Bool(enabled));
        Ok(Some(Value::Object(map)))
    }
    fn mcp_disabled_description(&self) -> Option<&'static str> {
        Some("停用会保留条目并写入 enabled: false，ZCode 不再加载该服务")
    }
    fn supports_skills(&self) -> bool {
        true
    }
    fn skill_root(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<PathBuf> {
        Some(match scope {
            Scope::Global => data_root(home).join("skills"),
            Scope::Project => project?.join(".zcode").join("skills"),
        })
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
    fn install_guidance(&self) -> (&'static str, &'static str) {
        (
            "https://zcode.z.ai",
            "ZCode 桌面应用请从官网 zcode.z.ai 下载安装；更新由应用内自动更新完成。",
        )
    }
    fn node_required_when_missing(&self) -> bool {
        false
    }
    fn install_command(&self) -> Option<String> {
        None
    }
    fn recognizes_native_install_path(&self, path: &Path) -> bool {
        path.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("ZCode.exe"))
    }
    fn native_binary_directories(&self, home: &Path) -> Vec<PathBuf> {
        install::install_directories(home)
    }
    fn descriptor(&self) -> AdapterDescriptor {
        AdapterDescriptor {
            id: self.id(),
            name: self.name(),
            interface_formats: self.interface_formats(),
            project_model_override: false,
            yolo_available: false,
            launch_form: self.launch_form(),
            native_config: Facet {
                state: "available",
                reason: "可编辑 ~/.zcode/v2/setting.json（JSON）",
            },
            launch: Facet {
                state: "available",
                reason: "可直接启动已安装的 ZCode 桌面应用并打开工作区",
            },
            resume: Facet {
                state: "unsupported",
                reason: "ZCode 桌面端官方无会话恢复启动契约；会话仅供浏览与用量统计",
            },
            resources: Facet {
                state: "available",
                reason: "MCP 经 ~/.zcode/cli/config.json（mcp.servers），Skills 与 Agents 走共享资源根，插件只读列举 installed_plugins.json",
            },
            history: Facet {
                state: "available",
                reason: "只读索引 ZCode 会话记录与 token 用量",
            },
            login: None,
            management: ManagementCapabilities {
                accounts: false,
                mcp: true,
                skills: true,
                agents: true,
                plugins: true,
                project_plugins: false,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resources::mcp::McpDraft;
    use serde_json::json;

    #[derive(Default)]
    struct TestKeys(std::sync::Mutex<std::collections::BTreeMap<String, String>>);
    impl crate::credentials::CredentialStore for TestKeys {
        fn put(&self, id: &str, secret: &str) -> Result<(), String> {
            self.0
                .lock()
                .map_err(|_| "凭据存储锁定".to_owned())?
                .insert(id.into(), secret.into());
            Ok(())
        }
        fn get(&self, id: &str) -> Result<String, String> {
            self.0
                .lock()
                .map_err(|_| "凭据存储锁定".to_owned())?
                .get(id)
                .cloned()
                .ok_or("没有此凭据".into())
        }
        fn delete(&self, id: &str) -> Result<(), String> {
            self.0
                .lock()
                .map_err(|_| "凭据存储锁定".to_owned())?
                .remove(id);
            Ok(())
        }
    }

    fn connection() -> Connection {
        Connection {
            provider_id: "zhipu".into(),
            interface_format: "anthropic_messages".into(),
            base_url: String::new(),
            model: String::new(),
            secret_ref: None,
            auth_env_var: None,
        }
    }

    #[test]
    fn native_surface_is_the_desktop_setting_json_only() {
        let home = Path::new("/home/example");
        let files = ZCode.native_files(Scope::Global, home, None, true);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].role, "settings");
        assert_eq!(files[0].format, "json");
        assert!(
            files[0]
                .path
                .replace('\\', "/")
                .ends_with(".zcode/v2/setting.json")
        );
        assert!(files[0].writable);
        // The product's encrypted credential file must stay out of the
        // managed surface entirely (read or write).
        assert!(!files[0].path.contains("credentials"));
        assert!(ZCode
            .native_files(Scope::Project, home, Some(Path::new("/work/p")), true)
            .is_empty());
        assert_eq!(
            ZCode.file_kind("settings").unwrap(),
            FileKind::Json
        );
        assert!(ZCode.file_kind("credentials").is_err());
        // No documented connection surface: credential management is refused.
        assert!(ZCode
            .connection_documents(&connection(), Scope::Global)
            .is_err());
        let profile: RegisteredProfile = serde_json::from_str(
            r#"{"id":"","tool":"zcode","name":"p","version":0,"inheritCommon":false,"files":{}}"#,
        )
        .unwrap();
        let mut secrets = NativeSecrets::default();
        assert!(ZCode
            .write_connection_secret(
                &profile,
                Scope::Global,
                &TestKeys::default(),
                &mut secrets
            )
            .is_err());
    }

    #[test]
    fn desktop_launch_declares_workspace_arg_and_guards_yolo_and_resume() {
        assert_eq!(ZCode.launch_form(), LaunchForm::Desktop);
        assert_eq!(
            ZCode.launch_args(None, LaunchMode::Normal).unwrap(),
            Vec::<String>::new()
        );
        assert!(ZCode.launch_args(None, LaunchMode::Yolo).is_err());
        assert!(ZCode.launch_args(Some("sess_1"), LaunchMode::Normal).is_err());
        let dir = Path::new("/work/demo");
        assert_eq!(
            ZCode.desktop_launch_args(dir).unwrap(),
            vec![format!("--open-workspace={}", dir.display())]
        );
        let descriptor = ZCode.descriptor();
        assert_eq!(descriptor.launch_form, LaunchForm::Desktop);
        assert!(!descriptor.yolo_available);
        assert_eq!(descriptor.resume.state, "unsupported");
        assert!(descriptor.login.is_none());
        assert!(!descriptor.management.accounts);
        assert!(descriptor.management.mcp);
        assert!(descriptor.management.skills);
        assert!(descriptor.management.agents);
        assert!(descriptor.management.plugins);
    }

    #[test]
    fn mcp_targets_the_nested_mcp_servers_key_in_the_cli_config() {
        let home = Path::new("/home/example");
        let location = ZCode
            .mcp_location(Scope::Global, home, None)
            .expect("zcode mcp location");
        assert!(
            location
                .path
                .to_string_lossy()
                .replace('\\', "/")
                .ends_with(".zcode/cli/config.json")
        );
        assert_eq!(location.root, "mcp");
        assert_eq!(location.child, Some("servers"));
        let project = ZCode
            .mcp_location(Scope::Project, home, Some(Path::new("/work/p")))
            .unwrap();
        assert!(project
            .path
            .to_string_lossy()
            .replace('\\', "/")
            .ends_with("p/.zcode/config.json"));
    }

    #[test]
    fn mcp_entry_round_trips_through_the_shared_transaction() {
        let temp = tempfile::tempdir().unwrap();
        let db = crate::database::Database::open(&temp.path().join("cliora.db")).unwrap();
        let keys = TestKeys::default();
        let registry = crate::adapters::Registry::builtins();
        let config = temp.path().join(".zcode/cli/config.json");
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();
        std::fs::write(
            &config,
            "{\"storage\":{\"dir\":\"kept\"},\"mcp\":{\"servers\":{\"other\":{\"command\":\"echo\"}}}}",
        )
        .unwrap();
        let definition = crate::resources::mcp::save_definition(
            &db,
            McpDraft {
                id: None,
                name: "example".into(),
                transport: McpTransport::Stdio,
                command: "npx".into(),
                args: vec!["-y".into(), "example-mcp".into()],
                url: String::new(),
                env: std::collections::BTreeMap::from([(
                    "API_KEY".into(),
                    "${EXAMPLE_KEY}".into(),
                )]),
                headers: std::collections::BTreeMap::new(),
                in_library: true,
                expected_version: None,
            },
        )
        .unwrap();
        let target = crate::resources::mcp::McpTargetRequest {
            context_id: None,
            tool_id: "zcode".into(),
            scope: Scope::Global,
            project_path: None,
            enabled: true,
            baseline_hash: None,
            allow_replace: false,
            preview_token: None,
        };
        let preview = crate::resources::mcp::preview_targets(
            &db,
            &registry,
            temp.path(),
            &definition.id,
            vec![target.clone()],
        );
        assert_eq!(preview[0].status, "ready", "{preview:?}");
        let mut requested = target.clone();
        requested.baseline_hash = preview[0].baseline_hash.clone();
        requested.preview_token = preview[0].preview_token.clone();
        let written = crate::resources::mcp::distribute(
            &db,
            &keys,
            &registry,
            temp.path(),
            &definition.id,
            vec![requested],
        );
        assert_eq!(written[0].status, "written", "{written:?}");
        let text = std::fs::read_to_string(&config).unwrap();
        let parsed: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed["storage"]["dir"], "kept");
        assert_eq!(parsed["mcp"]["servers"]["other"]["command"], "echo");
        let entry = &parsed["mcp"]["servers"]["example"];
        assert_eq!(entry["command"], "npx");
        assert_eq!(entry["type"], "stdio");
        assert_eq!(entry["enabled"], true);
        assert_eq!(entry["env"]["API_KEY"], "${EXAMPLE_KEY}");
        let listed =
            crate::resources::mcp::list_native(&db, &registry, temp.path(), &target).unwrap();
        let example = listed
            .iter()
            .find(|entry| entry.name == "example")
            .unwrap();
        assert!(example.enabled);
        assert_eq!(example.command, "npx");
        // Disabling keeps the native entry with the official enabled: false.
        let mut disable = target.clone();
        disable.enabled = false;
        let preview = crate::resources::mcp::preview_targets(
            &db,
            &registry,
            temp.path(),
            &definition.id,
            vec![disable.clone()],
        );
        let mut requested = disable;
        requested.baseline_hash = preview[0].baseline_hash.clone();
        requested.preview_token = preview[0].preview_token.clone();
        let written = crate::resources::mcp::distribute(
            &db,
            &keys,
            &registry,
            temp.path(),
            &definition.id,
            vec![requested],
        );
        assert_eq!(written[0].status, "written", "{written:?}");
        let parsed: Value =
            serde_json::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
        assert_eq!(parsed["mcp"]["servers"]["example"]["enabled"], false);
    }

    #[test]
    fn versioned_native_fixture_round_trips_as_json() {
        let text = include_str!("../../../../tests/fixtures/native/zcode-3.14.4.json");
        let parsed = crate::native::format::parse(FileKind::Json, text).unwrap();
        assert_eq!(parsed["locale"], "zh-CN");
        let edited = crate::native::format::set_path(
            FileKind::Json,
            text,
            &["locale".into()],
            Some(&json!("en-US")),
        )
        .unwrap();
        let reparsed = crate::native::format::parse(FileKind::Json, &edited).unwrap();
        assert_eq!(reparsed["locale"], "en-US");
        assert_eq!(
            reparsed["taskAutoArchiveEnabled"],
            parsed["taskAutoArchiveEnabled"]
        );
    }

    #[test]
    fn capability_ports_stay_available_and_honest() {
        assert!(ZCode.agents().is_some_and(|a| a.capability().supported));
        assert!(ZCode.plugins().is_some_and(|a| !a.capability().actions.is_empty()));
        assert!(ZCode.supports_mcp());
        assert!(ZCode.supports_skills());
        assert!(ZCode.history_supported());
        assert!(ZCode.official_usage().is_none());
        assert!(ZCode.accounts().is_none());
    }
}
