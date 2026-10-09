//! Qoder CN native CLI adapter. International Qoder is no longer registered.
//! Paths, command entry and builtin Agent evidence belong to this package.
//! Configuration, MCP, plugin and Agent management consume shared protection
//! services. Native account credentials and transcript parsing stay unavailable.

pub(crate) mod agents;
pub(crate) mod plugins;

use std::collections::BTreeMap;
use std::env;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::{
    file, project_root, CliAdapter, Facet, InspectionFields, LaunchMode, McpLocation,
};
use crate::adapters::agents::AgentAdapter;
use crate::adapters::plugins::PluginAdapter;
use crate::credentials::CredentialStore;
use crate::native::adapter::{NativeFile, Scope};
use crate::native::apply::NativeSecrets;
use crate::native::format::FileKind;
use crate::native::profile::{Connection, RegisteredProfile};
use crate::resources::mcp::{self, McpDefinition, McpTransport};

pub struct QoderAdapter {
    pub id: &'static str,
    pub name: &'static str,
    pub command: &'static str,
    pub directory: &'static str,
    pub plugin_ledger: Option<&'static str>,
    pub config_env: Option<&'static str>,
    pub binary_directory: &'static str,
    pub yolo_flag: &'static str,
    pub npm: &'static str,
    pub install_url: &'static str,
    pub install_hint: &'static str,
    pub install_script: Option<&'static str>,
    pub builtin_agents: &'static [super::agents::BuiltinAgent],
}
pub static QODER_CN: QoderAdapter = QoderAdapter {
    id: "qoder_cn", name: "Qoder CN", command: "qoderclicn",
    directory: ".qoder-cn", config_env: None, plugin_ledger: Some("plugins/installed_plugins_v2.json"),
    binary_directory: "bin/qoderclicn", yolo_flag: "--dangerously-skip-permissions",
    npm: "@qodercn-ai/qoderclicn", install_url: "https://docs.qoder.cn/cli/installation",
    install_hint: "官方推荐原生安装，尤其在 Windows 上启动更快；npm 方式供已有安装兼容使用。",
    install_script: Some(if cfg!(windows) { "irm https://static.qoder.com.cn/qoder-cli-cn/install.ps1 | iex" } else { "curl -fsSL https://static.qoder.com.cn/qoder-cli-cn/install.sh | bash -s -- --force" }),
    builtin_agents: BUILTIN_AGENTS,
};

// Verified with qoderclicn 1.1.65 `agents list` and its bundled definitions.
const BUILTIN_AGENTS: &[super::agents::BuiltinAgent] = &[
    super::agents::BuiltinAgent { name: "Explore", description: "快速查找和阅读代码。" },
    super::agents::BuiltinAgent { name: "general-purpose", description: "处理研究、代码搜索与多步骤任务。" },
    super::agents::BuiltinAgent { name: "Plan", description: "分析实现方案和任务计划。" },
    super::agents::BuiltinAgent { name: "qoder-guide", description: "查询 Qoder CLI 的用法、配置与官方文档。" },
    super::agents::BuiltinAgent { name: "statusline-setup", description: "配置原生 CLI 的状态栏。" },
];


#[cfg(test)]
use self::QODER_CN as Qoder;

impl QoderAdapter {
    pub(crate) fn config_root(&self, home: &Path) -> PathBuf {
        self.config_env.and_then(env::var_os).map(PathBuf::from).unwrap_or_else(|| home.join(self.directory))
    }
}

impl CliAdapter for QoderAdapter {
    fn supports_mcp(&self) -> bool {
        true
    }
    fn supports_skills(&self) -> bool {
        true
    }
    fn agents(&self) -> Option<&dyn AgentAdapter> {
        Some(self)
    }
    fn plugins(&self) -> Option<&dyn PluginAdapter> {
        Some(self)
    }
    fn id(&self) -> &'static str {
        self.id
    }
    fn name(&self) -> &'static str {
        self.name
    }
    fn command(&self) -> &'static str {
        self.command
    }
    fn npm_package(&self) -> &'static str {
        // Legacy but official channel; the recommended install is the native
        // installer in the CN documentation; never use the international channel.
        self.npm
    }
    fn latest_version_url(&self) -> Option<String> {
        Some("https://static.qoder.com.cn/qoder-cli-cn/channels/manifest.json".into())
    }
    fn parse_latest_version(&self, text: &str) -> Option<String> {
        serde_json::from_str::<Value>(text).ok()?.get("latest")?.as_str().map(str::to_owned)
    }
    fn version_identity(&self, basename: &str, output: &str) -> bool {
        (basename == "qodercn" || basename == self.command || basename.starts_with(&format!("{}-", self.command)))
            && (output.contains(self.command) || semver::Version::parse(output.trim().trim_start_matches('v')).is_ok())
    }
    fn extra_binary_candidates(&self, home: &Path) -> Vec<PathBuf> {
        let directory = home.join(self.directory).join(self.binary_directory);
        let mut paths = Vec::new();
        if let Ok(version) = std::fs::read_to_string(directory.join("version.txt")) {
            let version = version.trim();
            if semver::Version::parse(version).is_ok() {
                paths.push(directory.join(format!("{}-{version}{}", self.command, if cfg!(windows) { ".exe" } else { "" })));
            }
        }
        paths.push(directory.join(format!("{}{}", self.command, if cfg!(windows) { ".exe" } else { "" })));
        for suffix in if cfg!(windows) { &[".exe", ".cmd"][..] } else { &[""][..] } {
            paths.push(home.join(".local/bin").join(format!("qodercn{suffix}")));
        }
        paths.into_iter().filter(|path| path.metadata().is_ok_and(|m| m.is_file() && m.len() > 0)).collect()
    }
    fn native_binary_directories(&self, home: &Path) -> Vec<PathBuf> {
        vec![home.join(self.directory).join(self.binary_directory), home.join(".local/bin")]
    }
    fn recognizes_native_install_path(&self, path: &Path) -> bool {
        let resolved = path.canonicalize().unwrap_or_else(|_| path.to_owned());
        resolved.parent().is_some_and(|parent| parent.ends_with(Path::new(self.directory).join(self.binary_directory)) || parent.ends_with(".local/bin"))
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
                    root.join(self.directory).join("settings.json"),
                    FileKind::Json,
                    known,
                    Some("Qoder 项目配置参与 MCP、插件与本地覆盖；模型与账号在用户配置中设置"),
                    false,
                ),
                file(
                    "local_settings",
                    root.join(self.directory).join("settings.local.json"),
                    FileKind::Json,
                    known,
                    None,
                    false,
                ),
            ],
            None => vec![file(
                "settings",
                self.config_root(home).join("settings.json"),
                FileKind::Json,
                known,
                None,
                false,
            )],
        }
    }
    fn interface_formats(&self) -> &'static [&'static str] {
        // Qoder authenticates through the Qoder account; settings.json has no
        // documented provider connection fields.
        &[]
    }
    fn file_kind(&self, role: &str) -> Result<FileKind, String> {
        if matches!(role, "settings" | "local_settings") {
            Ok(FileKind::Json)
        } else {
            Err("Qoder 不支持此原生文件角色".into())
        }
    }
    fn portable_root_fields(&self, role: &str) -> &'static [&'static str] {
        if role == "settings" {
            &["mcpServers", "enabledPlugins"]
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
        // Written straight into settings.json; the `qoder mcp` subcommands are
        // deliberately not driven so every change keeps the shared transaction
        // backup/CAS boundary.
        let path = match scope {
            Scope::Global => self.config_root(home).join("settings.json"),
            Scope::Project => project?.join(self.directory).join("settings.json"),
        };
        Some(McpLocation {
            path,
            kind: FileKind::Json,
            root: "mcpServers",
            child: None,
        })
    }
    fn mcp_disabled_description(&self) -> Option<&'static str> {
        Some("停用会写入条目的 disabled: true，Cliora 中的定义仍保留")
    }
    fn rule_path(&self, scope: Scope, home: &Path, project: Option<&Path>) -> Option<PathBuf> {
        Some(match scope {
            Scope::Global => self.config_root(home).join("AGENTS.md"),
            Scope::Project => project?.join("AGENTS.md"),
        })
    }
    fn mcp_document(
        &self,
        definition: &McpDefinition,
        enabled: bool,
        existing: Option<&Value>,
    ) -> Result<Option<Value>, String> {
        // Qoder keeps the entry in place with disabled: true, so disabling never
        // drops the native entry (settings-reference documents the field).
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
        map.insert("disabled".into(), json!(!enabled));
        Ok(Some(Value::Object(map)))
    }
    fn skill_root(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<PathBuf> {
        Some(match scope {
            Scope::Global => self.config_root(home).join("skills"),
            Scope::Project => project?.join(self.directory).join("skills"),
        })
    }
    fn connection_policy(&self, _scope: Scope) -> crate::native::adapter::ConnectionPolicy {
        crate::native::adapter::ConnectionPolicy {
            api_key: crate::native::adapter::api_key_unsupported(
                "Qoder CN 凭据由产品登录态管理，Cliora 不读取或复制账号令牌",
            ),
            provider_address: crate::native::adapter::address_unsupported(
                "Qoder 通过官方账号认证，settings.json 没有文档化的供应商连接字段",
            ),
            projection: "single_connection",
        }
    }
    fn connection_documents(
        &self,
        _connection: &Connection,
        _scope: Scope,
    ) -> Result<BTreeMap<String, Value>, String> {
        Err("Qoder 通过官方账号认证，settings.json 没有文档化的供应商连接字段".into())
    }
    fn write_connection_secret(
        &self,
        _profile: &RegisteredProfile,
        _scope: Scope,
        _credentials: &dyn CredentialStore,
        _secrets: &mut NativeSecrets,
    ) -> Result<(), String> {
        Err("Qoder CN 凭据由产品登录态管理，Cliora 不读取或复制账号令牌".into())
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
    fn launch_args(&self, session: Option<&str>, mode: LaunchMode) -> Result<Vec<String>, String> {
        // The working directory is provided by the shared terminal session
        // (qoder's documented --cwd semantics); only mode flags are generated.
        let mut args = Vec::new();
        if let Some(id) = session {
            args.extend(["-r".into(), id.into()]);
        }
        if matches!(mode, LaunchMode::Yolo) {
            args.push(self.yolo_flag.into());
        }
        Ok(args)
    }
    fn history_resume_version_supported(&self, version: &str) -> bool {
        // 1.x is the verified line; the resume entry itself stays gated on the
        // undelivered session dimension.
        version.starts_with("1.")
    }
    fn install_guidance(&self) -> (&'static str, &'static str) {
        (self.install_url, self.install_hint)
    }
    fn node_required_when_missing(&self) -> bool {
        false
    }
    fn minimum_node_version(&self) -> Option<(u32, u32, u32)> {
        Some((20, 18, 1))
    }
    fn node_dependency_detail(&self) -> &'static str {
        "Qoder CN 官方文档要求 npm 兼容安装使用 Node.js 20.18.1+；原生安装不依赖 Node.js"
    }
    fn install_command(&self) -> Option<String> {
        self.native_install_command()
            .or_else(|| self.npm_install_command())
    }
    fn native_install_command(&self) -> Option<String> {
        self.install_script.map(str::to_owned)
    }
    fn upgrade_command(&self, source: &str) -> Option<String> {
        match source {
            "npm_shim" => self.npm_install_command(),
            "native" => self.native_install_command(),
            _ => None,
        }
    }
    fn descriptor(&self) -> super::AdapterDescriptor {
        super::AdapterDescriptor {
            id: self.id(),
            configuration: self.configuration().map(|port| port.describe(Scope::Global)),
            management: super::ManagementCapabilities {
                accounts: false,
                mcp: self.supports_mcp(),
                skills: self.supports_skills(),
                agents: self.agents().is_some_and(|port| port.capability().supported),
                plugins: self
                    .plugins()
                    .is_some_and(|port| !port.capability().actions.is_empty()),
                project_plugins: self.plugins().is_some_and(|port| port.capability().project),
                rules: self.rule_support(),
            },
            login: None,
            name: self.name(),
            interface_formats: self.interface_formats(),
            project_model_override: false,
            yolo_available: self.launch_args(None, LaunchMode::Yolo).is_ok(),
            launch_form: self.launch_form(),
            native_config: Facet {
                state: "available",
                reason: "已确认 CLI 身份，可编辑 settings.json（JSON）与项目 settings.local.json",
            },
            launch: Facet {
                state: "available",
                reason: "可在外部终端启动；工作目录与跳过审批参数由当前 CLI 适配器提供",
            },
            resume: Facet {
                state: "planned",
                reason: "会话 jsonl 字段未从官方来源或实测样本核实，会话维度整体不交付；官方恢复命令为 qoder -r <id>",
            },
            resources: Facet {
                state: "available",
                reason: "MCP 直写 settings.json mcpServers 配置面；Skills 与 Agents 目录和 qoder plugins 子命令由适配器提供",
            },
            history: Facet {
                state: "planned",
                reason: "会话 jsonl 内部字段官方未文档化且无可核实实测样本；用量官方仅以 Credits 计量，无 token 记录契约",
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::agents as agent_port;
    use crate::resources::mcp::McpTransport;
    use std::collections::BTreeMap;

    const SETTINGS_FIXTURE: &str =
        include_str!("../../../../tests/fixtures/native/qoder-1.1.63.json");

    fn stdio_definition() -> McpDefinition {
        McpDefinition {
            id: "definition-1".into(),
            name: "cliora-fixture".into(),
            transport: McpTransport::Stdio,
            command: "npx -y fixture-mcp@1.0.0".into(),
            args: vec![],
            url: String::new(),
            env: BTreeMap::from([("FIXTURE_TOKEN".into(), "${FIXTURE_TOKEN}".into())]),
            headers: BTreeMap::new(),
            in_library: true,
            version: 1,
        }
    }

    fn http_definition() -> McpDefinition {
        McpDefinition {
            id: "definition-2".into(),
            name: "cliora-http".into(),
            transport: McpTransport::Http,
            command: String::new(),
            args: vec![],
            url: "https://mcp.example.test/mcp".into(),
            env: BTreeMap::new(),
            headers: BTreeMap::from([("Authorization".into(), "${MCP_FIXTURE_TOKEN}".into())]),
            in_library: true,
            version: 1,
        }
    }

    #[test]
    fn version_probe_accepts_only_qoder_output() {
        // The probe lowercases the raw `qoder --version` output before matching.
        assert!(Qoder.version_identity("qoderclicn", "1.1.65"));
        assert!(!Qoder.version_identity("qoder", "qoder 1.1.65"));
        assert!(!Qoder.version_identity("qoder", "claude 2.1.283"));
        assert!(!Qoder.version_identity("qoder", ""));
    }

    #[test]
    fn launch_args_cover_normal_yolo_and_resume_modes() {
        assert_eq!(
            Qoder.launch_args(None, LaunchMode::Normal).unwrap(),
            Vec::<String>::new()
        );
        assert_eq!(Qoder.launch_args(None, LaunchMode::Yolo).unwrap(), ["--dangerously-skip-permissions"]);
        assert_eq!(
            Qoder.launch_args(Some("abc123"), LaunchMode::Normal).unwrap(),
            ["-r", "abc123"]
        );
        assert_eq!(
            Qoder.launch_args(Some("abc123"), LaunchMode::Yolo).unwrap(),
            ["-r", "abc123", "--dangerously-skip-permissions"]
        );
        assert!(Qoder.history_resume_version_supported("1.1.63"));
        assert!(!Qoder.history_resume_version_supported("0.9.0"));
        assert!(!Qoder.history_supported());
    }

    #[test]
    fn native_files_follow_the_documented_qoder_layout() {
        let home = Path::new("/home");
        let global = Qoder.native_files(Scope::Global, home, None, true);
        assert_eq!(global.len(), 1);
        assert_eq!(global[0].role, "settings");
        assert!(global[0].path.replace('\\', "/").ends_with(".qoder-cn/settings.json"));
        assert_eq!(Qoder.file_kind("settings").unwrap(), FileKind::Json);
        assert_eq!(Qoder.file_kind("local_settings").unwrap(), FileKind::Json);
        assert!(Qoder.file_kind("auth").is_err());
        let project = Qoder.native_files(
            Scope::Project,
            home,
            Some(Path::new("/proj")),
            true,
        );
        assert_eq!(project.len(), 2);
        assert!(project[0].path.replace('\\', "/").ends_with(".qoder-cn/settings.json"));
        assert!(project[1]
            .path
            .replace('\\', "/")
            .ends_with(".qoder-cn/settings.local.json"));
    }

    #[test]
    fn mcp_document_covers_stdio_http_and_disabled() {
        let stdio = Qoder
            .mcp_document(&stdio_definition(), true, None)
            .unwrap()
            .unwrap();
        assert_eq!(stdio["type"], "stdio");
        assert_eq!(stdio["command"], "npx");
        assert_eq!(stdio["args"], json!(["-y", "fixture-mcp@1.0.0"]));
        assert_eq!(stdio["env"]["FIXTURE_TOKEN"], "${FIXTURE_TOKEN}");
        assert_eq!(stdio["disabled"], false);
        assert!(stdio.get("url").is_none());

        let http = Qoder
            .mcp_document(&http_definition(), true, None)
            .unwrap()
            .unwrap();
        assert_eq!(http["type"], "http");
        assert_eq!(http["url"], "https://mcp.example.test/mcp");
        assert_eq!(http["headers"]["Authorization"], "${MCP_FIXTURE_TOKEN}");
        assert!(http.get("command").is_none());

        // Disabling keeps the entry with the native disabled flag instead of
        // removing it; undocumented native option fields survive a rewrite.
        let mut native_entry = http.clone();
        native_entry["timeout"] = json!(30);
        let disabled = Qoder
            .mcp_document(&http_definition(), false, Some(&native_entry))
            .unwrap()
            .unwrap();
        assert_eq!(disabled["disabled"], true);
        assert_eq!(disabled["timeout"], 30);

        let location = Qoder.mcp_location(Scope::Global, Path::new("/home"), None).unwrap();
        assert_eq!(location.root, "mcpServers");
        assert!(location
            .path
            .to_string_lossy()
            .replace('\\', "/")
            .ends_with(".qoder-cn/settings.json"));
    }

    #[test]
    fn settings_fixture_edit_keeps_unmanaged_native_fields() {
        let parsed =
            crate::native::format::parse(FileKind::Json, SETTINGS_FIXTURE).unwrap();
        assert_eq!(parsed["mcpServers"]["fixture-stdio"]["command"], "npx");
        assert_eq!(
            parsed["enabledPlugins"]["fixture-plugin@fixture-market"],
            true
        );
        let entry = Qoder
            .mcp_document(&stdio_definition(), true, None)
            .unwrap()
            .unwrap();
        let edited = crate::native::format::set_path(
            FileKind::Json,
            SETTINGS_FIXTURE,
            &["mcpServers".into(), "cliora-fixture".into()],
            Some(&entry),
        )
        .unwrap();
        let after = crate::native::format::parse(FileKind::Json, &edited).unwrap();
        assert_eq!(after["customUserField"], parsed["customUserField"]);
        assert_eq!(
            after["mcpServers"]["fixture-http"]["url"],
            parsed["mcpServers"]["fixture-http"]["url"]
        );
        assert_eq!(after["mcpServers"]["cliora-fixture"]["command"], "npx");
    }

    #[test]
    fn skill_roots_follow_official_directories() {
        let home = Path::new("/home");
        assert_eq!(
            Qoder.skill_root(Scope::Global, home, None).unwrap(),
            Qoder.config_root(home).join("skills")
        );
        assert_eq!(
            Qoder
                .skill_root(Scope::Project, home, Some(Path::new("/proj")))
                .unwrap(),
            Path::new("/proj/.qoder-cn/skills")
        );
        // No independent native skill switch file is documented; disable goes
        // through the shared archive fallback.
        assert!(Qoder
            .skill_switch_location(Scope::Global, home, None, "any")
            .is_none());
    }

    #[test]
    fn agent_definitions_validate_through_the_shared_markdown_contract() {
        let capability = agent_port::capability("qoder_cn").unwrap();
        assert!(capability.supported);
        assert_eq!(capability.format, "markdown");
        let (name, description) =
            agent_port::validate("qoder_cn", "markdown", capability.template, "fallback").unwrap();
        assert_eq!(name, "reviewer");
        assert_eq!(description, "Review code");
        assert!(agent_port::validate(
            "qoder_cn",
            "markdown",
            "---\nname: broken\ndescription:  \n---\nbody",
            "fallback"
        )
        .is_err());
        let home = Path::new("/home");
        assert_eq!(
            agent_port::root("qoder_cn", Scope::Global, home, None).unwrap(),
            Qoder.config_root(home)
        );
        assert_eq!(
            agent_port::root("qoder_cn", Scope::Project, home, Some(Path::new("/proj"))).unwrap(),
            Path::new("/proj/.qoder-cn")
        );
    }
}

#[cfg(test)]
mod cn_tests {
    use super::*;
    use crate::adapters::{LaunchMode, Registry};
    use crate::native::adapter::Scope;
    #[test]
    fn native_ledger_uses_cn_settings_and_filters_other_projects() {
        use crate::adapters::plugins::PluginAdapter;
        use crate::resources::plugins::PluginTarget;
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join(".qoder-cn");
        std::fs::create_dir_all(root.join("plugins")).unwrap();
        std::fs::write(root.join("plugins/installed_plugins_v2.json"), r#"{"version":2,"plugins":{"fixture@market":[{"scope":"user","version":"1","enabled":false},{"scope":"project","projectPath":"/other","enabled":false}]}}"#).unwrap();
        std::fs::write(root.join("settings.json"), r#"{"enabledPlugins":{"fixture@market":true}}"#).unwrap();
        let target = PluginTarget { tool_id: "qoder_cn".into(), scope: Scope::Global, project_path: None, context_id: None };
        let entries = QODER_CN.discover(home.path(), &target, &root).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].enabled, Some(true));
        let project = PluginTarget { scope: Scope::Project, project_path: Some("/selected".into()), ..target };
        assert!(QODER_CN.discover(home.path(), &project, &root).unwrap().is_empty());
        std::fs::write(root.join("plugins/installed_plugins_v2.json"), r#"{"version":3,"plugins":{}}"#).unwrap();
        assert!(QODER_CN.discover(home.path(), &project, &root).is_err());
    }

    #[test]
    fn cn_registration_isolated_paths_and_versioned_binary() {
        let home = tempfile::tempdir().unwrap();
        let bin = home.path().join(".qoder-cn/bin/qoderclicn");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("version.txt"), "1.1.65\n").unwrap();
        let filename = format!("qoderclicn-1.1.65{}", if cfg!(windows) { ".exe" } else { "" });
        std::fs::write(bin.join(&filename), "fixture").unwrap();
        let registry = Registry::builtins();
        let cn = registry.get("qoder_cn").unwrap();
        assert_eq!(cn.extra_binary_candidates(home.path()), vec![bin.join(filename)]);
        assert!(cn.version_identity("qoderclicn-1.1.65", "1.1.65\n"));
        assert!(!cn.version_identity("other", "1.1.65"));
        assert!(!cn.version_identity("qoder", "qoder 1.1.65"));
        assert!(cn.native_files(Scope::Global, home.path(), None, true)[0].path.replace('\\', "/").ends_with(".qoder-cn/settings.json"));
        assert_eq!(cn.launch_args(None, LaunchMode::Yolo).unwrap(), ["--dangerously-skip-permissions"]);
        assert!(cn.npm_install_command().unwrap().contains("@qodercn-ai/qoderclicn@latest"));
        assert!(cn.native_install_command().unwrap().contains("static.qoder.com.cn/qoder-cli-cn/install."));
        assert_eq!(cn.upgrade_command("native"), cn.native_install_command());
        assert_eq!(cn.upgrade_command("npm_shim"), cn.npm_install_command());
        assert_eq!(cn.parse_latest_version(r#"{"latest":"1.1.66","files":[]}"#).as_deref(), Some("1.1.66"));
        assert!(cn.recognizes_native_install_path(&bin.join("qoderclicn-1.1.65.exe")));
        assert!(cn.version_identity("qodercn", "1.1.66\n"));
        assert!(registry.get("qoder").is_none());
        assert!(cn.plugins().is_some() && cn.agents().is_some());
    }
}
