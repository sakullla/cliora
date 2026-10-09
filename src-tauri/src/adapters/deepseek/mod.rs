//! DeepSeek Harness (`dsh`) desktop-application adapter.
//!
//! Evidence-backed capabilities: native editing of the desktop profile patch
//! layer (`~/.dsh/profiles/desktop/cordis.patch.yml`, YAML through the shared
//! format layer), bare desktop launches, MCP entries as `insert` patch items,
//! skills in the ranked `.dsh/skills` directories and read-only parsing of the
//! zstd-framed session logs (`sessions/*/session.v4.jsonl.zstd`, one frame per
//! appended record) with token usage aggregation.
//!
//! User-installed profile bundles are listed from the desktop manifest and can
//! be enabled or disabled through shared configuration transactions. Agents,
//! session resume, YOLO and product credential management remain unavailable.

pub(crate) mod detect;
pub mod history;
mod mcp;
mod plugins;

use std::collections::BTreeMap;
use std::env;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::{file, AdapterDescriptor, CliAdapter, Facet, InspectionFields, LaunchForm, LaunchMode, McpLocation};
use crate::credentials::CredentialStore;
use crate::native::adapter::{NativeFile, Scope};
use crate::native::apply::NativeSecrets;
use crate::native::format::FileKind;
use crate::native::profile::{Connection, RegisteredProfile};
use crate::resources::mcp::{self as shared_mcp, McpDefinition, McpTransport};

pub struct DeepSeek;

/// `$DSH_HOME` relocates the harness home. A caller-supplied home that is not
/// the real user home (tests, isolated profiles) stays under that home so CI
/// cannot redirect reads to the runner's real `.dsh` directory.
pub(crate) fn dsh_home(home: &Path) -> PathBuf {
    if dirs::home_dir().as_deref() == Some(home) {
        if let Some(root) = env::var_os("DSH_HOME") {
            let path = PathBuf::from(root);
            if path.is_absolute() {
                return path;
            }
        }
    }
    home.join(".dsh")
}

impl CliAdapter for DeepSeek {
    fn plugins(&self) -> Option<&dyn crate::adapters::plugins::PluginAdapter> { Some(self) }
    fn supports_mcp(&self) -> bool {
        true
    }
    fn supports_skills(&self) -> bool {
        true
    }
    fn id(&self) -> &'static str {
        "deepseek"
    }
    fn name(&self) -> &'static str {
        "DeepSeek Harness"
    }
    fn command(&self) -> &'static str {
        "dsh"
    }
    fn npm_package(&self) -> &'static str {
        ""
    }
    fn latest_version_url(&self) -> Option<String> {
        // Official desktop-auto-update-environment.mjs production feeds.
        let target = if cfg!(all(windows, target_arch = "x86_64")) { "win-x64/nightly.yml" }
            else if cfg!(all(target_os = "macos", target_arch = "aarch64")) { "mac-arm64/nightly-mac.yml" }
            else if cfg!(all(target_os = "macos", target_arch = "x86_64")) { "mac-x64/nightly-mac.yml" }
            else { return None };
        Some(format!("https://download.deepseek.com/dsh-desk/feeds/{target}"))
    }
    fn parse_latest_version(&self, text: &str) -> Option<String> {
        serde_yaml::from_str::<Value>(text).ok()?.get("version")?.as_str().map(str::to_owned)
    }
    /// The desktop app has no verified `--version` contract; install evidence
    /// is the Windows uninstall table (see `detect`), never a version probe.
    fn version_identity(&self, _basename: &str, _output: &str) -> bool {
        false
    }
    fn native_installations(&self, _home: &Path) -> Vec<crate::native::adapter::Installation> {
        detect::installations()
    }
    fn recognizes_native_install_path(&self, path: &Path) -> bool {
        detect::native_install_directory()
            .is_some_and(|root| path.starts_with(&root))
    }
    fn native_binary_directories(&self, _home: &Path) -> Vec<PathBuf> {
        detect::native_install_directory().into_iter().collect()
    }
    fn native_files(
        &self,
        scope: Scope,
        home: &Path,
        _project: Option<&Path>,
        known: bool,
    ) -> Vec<NativeFile> {
        if scope != Scope::Global {
            // The cordis profile layer is user-level only; dsh has no
            // documented project-scope native configuration file.
            return Vec::new();
        }
        let path = crate::accounts::selection::config_root("deepseek", || dsh_home(home))
            .join("profiles")
            .join("desktop")
            .join("cordis.patch.yml");
        vec![file("profile", path, FileKind::Yaml, known, None, false)]
    }
    fn interface_formats(&self) -> &'static [&'static str] {
        &[]
    }
    fn file_kind(&self, role: &str) -> Result<FileKind, String> {
        if role == "profile" {
            Ok(FileKind::Yaml)
        } else {
            Err("DeepSeek Harness 不支持此原生文件角色".into())
        }
    }
    fn validate_draft(&self, role: &str, parsed: &Value) -> Result<(), String> {
        if role != "profile" {
            return Ok(());
        }
        // The managed MCP port indexes `insert` entries by server name. A real
        // on-disk patch list with a different shape fails closed here instead
        // of being silently rewritten by later managed edits.
        mcp::rows(parsed)?;
        Ok(())
    }
    fn mcp_entries(&self, parsed: &Value, _location: &McpLocation) -> Result<serde_json::Map<String, Value>, String> {
        mcp::entries(parsed)
    }
    fn mcp_entry_view(&self, entry: &Value) -> Value {
        let mut config = entry.get("config").cloned().unwrap_or_default();
        if let Some(object) = config.as_object_mut() {
            object.insert("disabled".into(), json!(entry.get("disabled").and_then(Value::as_bool).unwrap_or(false)));
        }
        config
    }
    fn mcp_change(&self, parsed: &Value, _location: &McpLocation, name: &str, value: Option<Value>) -> Result<crate::native::transaction::FieldChange, String> {
        mcp::change(parsed, name, value)
    }
    fn connection_policy(&self, _scope: Scope) -> crate::native::adapter::ConnectionPolicy {
        crate::native::adapter::ConnectionPolicy {
            api_key: crate::native::adapter::api_key_unsupported(
                "DeepSeek Harness 凭据管理不交付：.credentials.yaml 由官方 dsh-credentials-local 插件管理，适配器不读取也不改写",
            ),
            provider_address: crate::native::adapter::address_unsupported(
                "DeepSeek Harness 原生连接写入不交付：凭据由官方插件经 .credentials.yaml 管理（UI 只写），适配器不触碰",
            ),
            projection: "single_connection",
        }
    }
    fn connection_documents(
        &self,
        _connection: &Connection,
        _scope: Scope,
    ) -> Result<BTreeMap<String, Value>, String> {
        Err("DeepSeek Harness 原生连接写入不交付：凭据由官方插件经 .credentials.yaml 管理（UI 只写），适配器不触碰".into())
    }
    fn write_connection_secret(
        &self,
        _profile: &RegisteredProfile,
        _scope: Scope,
        _credentials: &dyn CredentialStore,
        _secrets: &mut NativeSecrets,
    ) -> Result<(), String> {
        Err("DeepSeek Harness 凭据管理不交付：.credentials.yaml 由官方 dsh-credentials-local 插件管理，适配器不读取也不改写".into())
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
    fn launch_form(&self) -> LaunchForm {
        LaunchForm::Desktop
    }
    fn launch_args(
        &self,
        session: Option<&str>,
        mode: LaunchMode,
    ) -> Result<Vec<String>, String> {
        if session.is_some() {
            return Err("DeepSeek Harness 桌面端官方无会话恢复契约，不能带会话启动".into());
        }
        if matches!(mode, LaunchMode::Yolo) {
            return Err("DeepSeek Harness 桌面端尚无已验证的跳审批启动参数".into());
        }
        // Bare launch: the official desktop binary takes no workspace argument.
        Ok(Vec::new())
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
    fn history_resume_version_supported(&self, _version: &str) -> bool {
        // No verified resume contract exists for the desktop form at all.
        false
    }
    fn mcp_location(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<McpLocation> {
        if scope != Scope::Global {
            // MCP patch entries are documented for the harness home only.
            return None;
        }
        let native = self.native_files(scope, home, project, true).pop()?;
        Some(McpLocation {
            path: PathBuf::from(native.path),
            kind: FileKind::Yaml,
            root: "insert",
            child: None,
        })
    }
    fn mcp_document(
        &self,
        definition: &McpDefinition,
        enabled: bool,
        existing: Option<&Value>,
    ) -> Result<Option<Value>, String> {
        if !enabled {
            // dsh 停用即从 patch 层移除条目（无独立 disabled 标记）。
            return Ok(None);
        }
        let name = definition.name.trim();
        if name.is_empty()
            || name.chars().count() > 32
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        {
            return Err("dsh 的 serverName 只可用 1–32 个字母、数字、连字符或下划线".into());
        }
        let previous = existing.and_then(|entry| entry.get("config"));
        let mut config = match definition.transport {
            McpTransport::Stdio => shared_mcp::stdio_doc_with_env(definition, previous, "env"),
            McpTransport::Http => shared_mcp::http_doc(definition, previous, "headers"),
        };
        config.insert("serverName".into(), json!(name));
        config.insert(
            "transport".into(),
            json!(match definition.transport {
                McpTransport::Stdio => "stdio",
                McpTransport::Http => "streamable-http",
            }),
        );
        let mut entry = existing.and_then(Value::as_object).cloned().unwrap_or_default();
        entry.entry("id").or_insert_with(|| json!(format!("mcp:{name}")));
        entry.insert("name".into(), json!("@deepseek-ai/dsh-mcp-client"));
        entry.insert("config".into(), Value::Object(config));
        entry.remove("disabled");
        Ok(Some(Value::Object(entry)))
    }
    fn mcp_disabled_description(&self) -> Option<&'static str> {
        Some("停用即从 cordis.patch.yml 移除该 insert 条目")
    }
    fn skill_root(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<PathBuf> {
        Some(match scope {
            Scope::Global => dsh_home(home).join("skills"),
            Scope::Project => project?.join(".dsh/skills"),
        })
    }
    // Installation identity and native shape validation decide support. Tested
    // releases are evidence, not a product-version allowlist.
    fn node_required_when_missing(&self) -> bool {
        false
    }
    fn rule_path(&self, scope: Scope, home: &Path, project: Option<&Path>) -> Option<PathBuf> {
        Some(match scope {
            Scope::Global => crate::accounts::selection::config_root(self.id(), || dsh_home(home)).join("AGENTS.md"),
            Scope::Project => project?.join("AGENTS.md"),
        })
    }
    fn install_guidance(&self) -> (&'static str, &'static str) {
        (
            "https://github.com/deepseek-ai/deepseek-harness",
            "developer preview，破坏性变更频繁；Windows 安装器 https://download.deepseek.com/desktop/dsh-latest-windows-x64.exe，更新走应用内 nightly feeds。按实际原生配置和会话格式检查兼容性。",
        )
    }
    fn install_command(&self) -> Option<String> {
        None
    }
    fn descriptor(&self) -> AdapterDescriptor {
        AdapterDescriptor {
            id: self.id(),
            configuration: self.configuration().map(|port| port.describe(Scope::Global)),
            name: self.name(),
            interface_formats: self.interface_formats(),
            project_model_override: false,
            yolo_available: self.launch_args(None, LaunchMode::Yolo).is_ok(),
            launch_form: self.launch_form(),
            native_config: Facet {
                state: "available",
                reason: "已确认 desktop profile 的 cordis.patch.yml YAML 编辑面",
            },
            launch: Facet {
                state: "available",
                reason: "可直接启动已安装的桌面应用；官方无带项目启动契约，仅裸启动",
            },
            resume: Facet {
                state: "unsupported",
                reason: "DeepSeek Harness 官方无会话恢复契约，恢复不交付",
            },
            resources: Facet {
                state: "available",
                reason: "MCP 以 cordis.patch.yml 的 insert 条目交付，Skills 走 .dsh/skills 目录；用户插件读取 desktop profile 依赖和 bundle 声明，支持启停",
            },
            history: Facet {
                state: "available",
                reason: "可只读解析 sessions/*/session.v4.jsonl.zstd 会话日志（逐记录 zstd 帧）并统计 TokenUsage",
            },
            login: None,
            management: super::ManagementCapabilities {
                accounts: false,
                mcp: self.supports_mcp(),
                skills: self.supports_skills(),
                agents: false,
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
    use crate::resources::mcp::{McpDefinition, McpTransport};

    fn definition(name: &str, transport: McpTransport) -> McpDefinition {
        McpDefinition {
            id: "def-1".into(),
            name: name.into(),
            transport,
            command: "npx".into(),
            args: vec!["-y".into(), "@modelcontextprotocol/server-memory".into()],
            url: "https://mcp.example.test/sse".into(),
            env: BTreeMap::from([("LOG_LEVEL".into(), "debug".into())]),
            headers: BTreeMap::from([("X-Api-Key".into(), "${MCP_TOKEN}".into())]),
            in_library: true,
            version: 1,
        }
    }

    #[test]
    fn native_disabled_mcp_is_visible_and_can_be_enabled() {
        let existing = json!({"id":"native", "name":"@deepseek-ai/dsh-mcp-client", "disabled":true, "config":{"serverName":"memory", "transport":"stdio", "command":"node"}});
        assert_eq!(DeepSeek.mcp_entry_view(&existing)["disabled"], true);
        let enabled = DeepSeek.mcp_document(&definition("memory", McpTransport::Stdio), true, Some(&existing)).unwrap().unwrap();
        assert_eq!(DeepSeek.mcp_entry_view(&enabled)["disabled"], false);
    }

    #[test]
    fn cordis_fixture_round_trips_managed_insert_entries() {
        let text = include_str!("../../../../tests/fixtures/native/dsh-0.2.0-rc.2.yml");
        let before = crate::native::format::parse(FileKind::Yaml, text).unwrap();
        DeepSeek.validate_draft("profile", &before).unwrap();
        let location = DeepSeek.mcp_location(Scope::Global, Path::new("/fixture"), None).unwrap();
        let document = DeepSeek.mcp_document(&definition("fetch", McpTransport::Stdio), true, None).unwrap();
        let change = DeepSeek.mcp_change(&before, &location, "fetch", document).unwrap();
        let edited = crate::native::format::set_path(FileKind::Yaml, text, &change.path, change.value.as_ref()).unwrap();
        let after = crate::native::format::parse(FileKind::Yaml, &edited).unwrap();
        assert_eq!(before[0], after[0]);
        assert_eq!(before[1], after[1]);
        let entries = DeepSeek.mcp_entries(&after, &location).unwrap();
        assert_eq!(entries["fetch"].pointer("/config/command"), Some(&json!("npx")));
        let change = DeepSeek.mcp_change(&after, &location, "fetch", None).unwrap();
        let removed = crate::native::format::set_path(FileKind::Yaml, &edited, &change.path, change.value.as_ref()).unwrap();
        let remaining = DeepSeek.mcp_entries(&crate::native::format::parse(FileKind::Yaml, &removed).unwrap(), &location).unwrap();
        assert!(!remaining.contains_key("fetch"));
        assert!(remaining.contains_key("memory"));
    }

    #[test]
    fn mcp_documents_shape_stdio_and_streamable_http_entries() {
        let stdio = DeepSeek
            .mcp_document(&definition("memory", McpTransport::Stdio), true, None)
            .unwrap()
            .unwrap();
        assert_eq!(stdio.pointer("/name"), Some(&json!("@deepseek-ai/dsh-mcp-client")));
        assert_eq!(stdio.pointer("/config/serverName"), Some(&json!("memory")));
        assert_eq!(stdio.pointer("/config/transport"), Some(&json!("stdio")));
        assert_eq!(stdio.pointer("/config/command"), Some(&json!("npx")));
        assert_eq!(
            stdio.pointer("/config/env/LOG_LEVEL"),
            Some(&json!("debug"))
        );
        let http = DeepSeek
            .mcp_document(&definition("fetch", McpTransport::Http), true, None)
            .unwrap()
            .unwrap();
        assert_eq!(http.pointer("/config/transport"), Some(&json!("streamable-http")));
        assert_eq!(
            http.pointer("/config/url"),
            Some(&json!("https://mcp.example.test/sse"))
        );
        // Sensitive headers keep their shared ${VAR} reference validation.
        assert_eq!(http.pointer("/config/headers/X-Api-Key"), Some(&json!("${MCP_TOKEN}")));
        // A sensitive literal from a previous native entry must survive edits.
        let previous = json!({"config": {"env": {"SECRET_KEY": "literal-value"}}});
        let preserved = DeepSeek
            .mcp_document(&definition("memory", McpTransport::Stdio), true, Some(&previous))
            .unwrap()
            .unwrap();
        assert_eq!(
            preserved.pointer("/config/env/SECRET_KEY"),
            Some(&json!("literal-value"))
        );
        // Disabling removes the patch entry entirely; invalid serverNames fail.
        assert!(DeepSeek
            .mcp_document(&definition("memory", McpTransport::Stdio), false, None)
            .unwrap()
            .is_none());
        for invalid in ["memory server", "", &"a".repeat(33), "mcp/server"] {
            assert!(
                DeepSeek
                    .mcp_document(&definition(invalid, McpTransport::Stdio), true, None)
                    .is_err(),
                "{invalid:?}"
            );
        }
    }

    #[test]
    fn mcp_location_is_the_global_patch_layer_only() {
        let home = Path::new("/home/example");
        let location = DeepSeek.mcp_location(Scope::Global, home, None).unwrap();
        assert!(location.path.ends_with("profiles/desktop/cordis.patch.yml"));
        assert_eq!(location.kind, FileKind::Yaml);
        assert_eq!(location.root, "insert");
        assert_eq!(location.child, None);
        assert!(DeepSeek
            .mcp_location(Scope::Project, home, Some(Path::new("/work/app")))
            .is_none());
    }

    #[test]
    fn native_profile_file_declares_yaml_and_accepts_native_patch_sequence() {
        let home = Path::new("/home/example");
        let files = DeepSeek.native_files(Scope::Global, home, None, true);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].role, "profile");
        assert_eq!(files[0].format, "yaml");
        assert!(
            files[0].path.ends_with("profiles/desktop/cordis.patch.yml")
                || files[0].path.ends_with("profiles\\desktop\\cordis.patch.yml")
        );
        assert!(DeepSeek.native_files(Scope::Project, home, Some(home), true).is_empty());
        assert_eq!(DeepSeek.file_kind("profile").unwrap(), FileKind::Yaml);
        DeepSeek
            .validate_draft("profile", &json!([{"insert": [{"id": "memory"}]}]))
            .unwrap();
        assert!(DeepSeek
            .validate_draft("profile", &json!({"insert": [{"id": "memory"}]}))
            .is_err());
    }

    #[test]
    fn launch_is_bare_desktop_only_and_never_yolo_or_resume() {
        assert_eq!(DeepSeek.launch_form(), LaunchForm::Desktop);
        assert_eq!(
            DeepSeek.launch_args(None, LaunchMode::Normal).unwrap(),
            Vec::<String>::new()
        );
        assert_eq!(
            DeepSeek.desktop_launch_args(Path::new("/work/app")).unwrap(),
            Vec::<String>::new()
        );
        let yolo = DeepSeek.launch_args(None, LaunchMode::Yolo).unwrap_err();
        assert!(yolo.contains("跳审批"));
        let resume = DeepSeek.launch_args(Some("session 1"), LaunchMode::Normal).unwrap_err();
        assert!(resume.contains("会话恢复"));
        assert!(!DeepSeek.history_resume_version_supported("0.2.1"));
    }

    #[test]
    fn desktop_versions_are_not_a_tested_release_allowlist() {
        for version in ["0.2.0-rc.2", "0.2.1-alpha.1", "0.2.5-alpha.1", "0.3.0", "1.0.0"] {
            assert!(!DeepSeek.explicitly_incompatible_native_version(version));
            assert!(!DeepSeek.explicitly_incompatible_launch_version(version));
        }
    }

    #[test]
    fn descriptor_and_ports_stay_honest() {
        assert!(DeepSeek.official_usage().is_none());
        assert!(DeepSeek.agents().is_none());
        assert!(DeepSeek.plugins().is_some());
        assert!(DeepSeek.accounts().is_none());
        assert!(DeepSeek.supports_mcp());
        assert!(DeepSeek.supports_skills());
        assert!(DeepSeek.history_supported());
        let descriptor = DeepSeek.descriptor();
        assert_eq!(descriptor.id, "deepseek");
        assert_eq!(descriptor.launch_form, LaunchForm::Desktop);
        assert!(!descriptor.yolo_available);
        assert!(!descriptor.project_model_override);
        assert!(descriptor.login.is_none());
        let management = descriptor.management;
        assert!(!management.accounts);
        assert!(management.mcp);
        assert!(management.skills);
        assert!(!management.agents);
        assert!(management.plugins);
        assert!(!management.project_plugins);
        assert_ne!(descriptor.native_config.state, "planned");
        assert_ne!(descriptor.launch.state, "planned");
        assert_ne!(descriptor.resume.state, "available");
        for facet in [
            &descriptor.native_config,
            &descriptor.launch,
            &descriptor.resume,
            &descriptor.resources,
            &descriptor.history,
        ] {
            assert!(!facet.reason.trim().is_empty());
        }
    }

    #[test]
    fn skill_roots_follow_the_official_ranked_directories() {
        let home = Path::new("/home/example");
        assert_eq!(
            DeepSeek.skill_root(Scope::Global, home, None).unwrap(),
            PathBuf::from("/home/example/.dsh/skills")
        );
        assert_eq!(
            DeepSeek.skill_root(Scope::Project, home, Some(Path::new("/work/app"))).unwrap(),
            PathBuf::from("/work/app/.dsh/skills")
        );
    }

    #[test]
    fn install_evidence_comes_from_the_uninstall_table_not_a_version_probe() {
        assert!(!DeepSeek.version_identity("dsh", "dsh 0.2.1"));
        assert!(!DeepSeek.node_required_when_missing());
        assert!(DeepSeek.install_command().is_none());
        assert!(DeepSeek.npm_install_command().is_none());
        let (url, hint) = DeepSeek.install_guidance();
        assert_eq!(url, "https://github.com/deepseek-ai/deepseek-harness");
        assert!(hint.contains("download.deepseek.com"));
        assert!(detect::matches_product("DeepSeek Harness"));
        assert!(detect::matches_product("deepseek harness (dsh)"));
        assert!(!detect::matches_product("Dashwood Studio"));
        assert!(!detect::matches_product(""));
    }
}
