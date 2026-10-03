//! Qoder (Alibaba) official CLI adapter.
//!
//! Terminal-form adapter for the Qoder CLI. Delivered dimensions follow
//! docs.qoder.com evidence: `qoder --version` detection, `~/.qoder/settings.json`
//! (JSON) editing, external-terminal launch with `--yolo` and `-r <id>` resume
//! arguments (the working directory itself is provided by the terminal session,
//! which is qoder's documented `--cwd` semantics), MCP written straight into the
//! settings.json `mcpServers` object (no `qoder mcp` subprocess), Skills and
//! Agents directories, and plugin management driven through `qoder plugins`
//! subcommands. Session browsing, resume entry and token usage stay undelivered:
//! the transcript `.jsonl` fields are undocumented and no verified native sample
//! exists, and Qoder meters usage in Credits with no token record contract.
//! Credentials are not managed; the product login state (Qoder account token)
//! is never read, copied or refreshed.

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

pub struct Qoder;

/// QODER_CONFIG_DIR relocates the whole native config root (settings.json,
/// skills/, agents/, projects/). Adapters own the environment override.
pub(crate) fn config_root(home: &Path) -> PathBuf {
    env::var_os("QODER_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".qoder"))
}

impl CliAdapter for Qoder {
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
        "qoder"
    }
    fn name(&self) -> &'static str {
        "Qoder"
    }
    fn command(&self) -> &'static str {
        "qoder"
    }
    fn npm_package(&self) -> &'static str {
        // Legacy but official channel; the recommended install is the native
        // installer at qoder.com/install.ps1.
        "@qoder-ai/qodercli"
    }
    fn version_identity(&self, _basename: &str, output: &str) -> bool {
        output.contains("qoder")
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
                    root.join(".qoder/settings.json"),
                    FileKind::Json,
                    known,
                    Some("Qoder 项目配置参与 MCP、插件与本地覆盖；模型与账号在用户配置中设置"),
                    false,
                ),
                file(
                    "local_settings",
                    root.join(".qoder/settings.local.json"),
                    FileKind::Json,
                    known,
                    None,
                    false,
                ),
            ],
            None => vec![file(
                "settings",
                config_root(home).join("settings.json"),
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
            Scope::Global => config_root(home).join("settings.json"),
            Scope::Project => project?.join(".qoder/settings.json"),
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
            Scope::Global => config_root(home).join("skills"),
            Scope::Project => project?.join(".qoder/skills"),
        })
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
        Err("Qoder 凭据管理不提供：唯一官方凭据是 QODER_PERSONAL_ACCESS_TOKEN 环境变量，产品登录态不由 Cliora 触碰".into())
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
            args.push("--yolo".into());
        }
        Ok(args)
    }
    fn history_resume_version_supported(&self, version: &str) -> bool {
        // 1.x is the verified line; the resume entry itself stays gated on the
        // undelivered session dimension.
        version.starts_with("1.")
    }
    fn install_guidance(&self) -> (&'static str, &'static str) {
        (
            "https://docs.qoder.com/cli/installation",
            "官方推荐 irm https://qoder.com/install.ps1 | iex；npm @qoder-ai/qodercli 为 legacy 渠道（Node.js 20+）。",
        )
    }
    fn node_required_when_missing(&self) -> bool {
        false
    }
    fn minimum_node_version(&self) -> Option<(u32, u32, u32)> {
        Some((20, 0, 0))
    }
    fn node_dependency_detail(&self) -> &'static str {
        "npm legacy 安装的 Qoder CLI 要求 Node.js 20+；官方 Windows 安装器不依赖 Node.js"
    }
    fn install_command(&self) -> Option<String> {
        self.native_install_command()
            .or_else(|| self.npm_install_command())
    }
    fn native_install_command(&self) -> Option<String> {
        // Only the Windows installer script is documented; other platforms fall
        // back to the legacy npm channel.
        cfg!(windows).then(|| "irm https://qoder.com/install.ps1 | iex".into())
    }
    fn descriptor(&self) -> super::AdapterDescriptor {
        super::AdapterDescriptor {
            id: self.id(),
            management: super::ManagementCapabilities {
                accounts: false,
                mcp: self.supports_mcp(),
                skills: self.supports_skills(),
                agents: self.agents().is_some_and(|port| port.capability().supported),
                plugins: self
                    .plugins()
                    .is_some_and(|port| !port.capability().actions.is_empty()),
                project_plugins: self.plugins().is_some_and(|port| port.capability().project),
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
                reason: "可在外部终端启动；工作目录由终端会话提供，跳过审批使用 --yolo",
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
        assert!(Qoder.version_identity("qoder", "qoder 1.1.63 (windows x64)"));
        assert!(Qoder.version_identity("qoder", "qoder cli v1.1.63"));
        assert!(!Qoder.version_identity("qoder", "claude 2.1.283"));
        assert!(!Qoder.version_identity("qoder", ""));
    }

    #[test]
    fn launch_args_cover_normal_yolo_and_resume_modes() {
        assert_eq!(
            Qoder.launch_args(None, LaunchMode::Normal).unwrap(),
            Vec::<String>::new()
        );
        assert_eq!(Qoder.launch_args(None, LaunchMode::Yolo).unwrap(), ["--yolo"]);
        assert_eq!(
            Qoder.launch_args(Some("abc123"), LaunchMode::Normal).unwrap(),
            ["-r", "abc123"]
        );
        assert_eq!(
            Qoder.launch_args(Some("abc123"), LaunchMode::Yolo).unwrap(),
            ["-r", "abc123", "--yolo"]
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
        assert!(global[0].path.replace('\\', "/").ends_with(".qoder/settings.json"));
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
        assert!(project[0].path.replace('\\', "/").ends_with(".qoder/settings.json"));
        assert!(project[1]
            .path
            .replace('\\', "/")
            .ends_with(".qoder/settings.local.json"));
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
            .ends_with(".qoder/settings.json"));
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
            config_root(home).join("skills")
        );
        assert_eq!(
            Qoder
                .skill_root(Scope::Project, home, Some(Path::new("/proj")))
                .unwrap(),
            Path::new("/proj/.qoder/skills")
        );
        // No independent native skill switch file is documented; disable goes
        // through the shared archive fallback.
        assert!(Qoder
            .skill_switch_location(Scope::Global, home, None, "any")
            .is_none());
    }

    #[test]
    fn agent_definitions_validate_through_the_shared_markdown_contract() {
        let capability = agent_port::capability("qoder").unwrap();
        assert!(capability.supported);
        assert_eq!(capability.format, "markdown");
        let (name, description) =
            agent_port::validate("qoder", "markdown", capability.template, "fallback").unwrap();
        assert_eq!(name, "reviewer");
        assert_eq!(description, "Review code");
        assert!(agent_port::validate(
            "qoder",
            "markdown",
            "---\nname: broken\ndescription:  \n---\nbody",
            "fallback"
        )
        .is_err());
        let home = Path::new("/home");
        assert_eq!(
            agent_port::root("qoder", Scope::Global, home, None).unwrap(),
            config_root(home)
        );
        assert_eq!(
            agent_port::root("qoder", Scope::Project, home, Some(Path::new("/proj"))).unwrap(),
            Path::new("/proj/.qoder")
        );
    }
}
