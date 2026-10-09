//! Command Code (`cmd`/`cmdc`) adapter.
//!
//! Registered default-off through the non-enumerated stable id `command_code`.
//! Evidence base: Command Code 1.73.4 installed locally (npm `command-code`,
//! `cmdc --version`) and its shipped bundle read for path/shape constants,
//! plus four real local sessions sampled read-only (see `history`). The
//! product command is `cmd`; the official Windows shim resolves through the
//! `cmdc` alias so PATH probing never matches the system shell.
//!
//! * **Paths**: everything lives under the fixed `~/.commandcode` root (the
//!   CLI derives it from HOME/USERPROFILE only; no relocation env exists in
//!   1.73.4). Managed editing stays user-level: `config.json`
//!   (provider/model/reasoningEffort) and `settings.json`; the project
//!   `.commandcode/settings[.local].json` files stay with the product except
//!   for resource locations.
//! * **Launch/resume**: `cmdc` interactive; `--session <path|id>` resumes a
//!   native session (id/prefix match against the project transcripts),
//!   `-r/--resume [name]` and `-c/--continue` are in-CLI pickers;
//!   `--permission-mode` accepts `yolo`.
//! * **MCP**: user-level `~/.commandcode/mcp.json` with the `mcpServers`
//!   root (project `.mcp.json` and the machine-local
//!   `projects/<slug>/mcp.json` layer exist natively but stay unmanaged per
//!   the delivery scope). Entries are `{command,args,env,enabled?}` stdio or
//!   `{url,headers,enabled?}` http; `enabled` is the native per-entry flag.
//! * **Skills**: personal `~/.commandcode/skills` and project
//!   `.commandcode/skills` (`SKILL.md` frontmatter; the CLI also reads the
//!   open-standard `~/.agents/skills`, which stays with the product). Only
//!   the two brand roots are managed here.
//! * **History/usage**: `~/.commandcode/projects/<slug>/<uuid>.jsonl`
//!   append-only transcripts with per-message usage (see `history` for the
//!   sampled usage-semantics finding and the cache-exclusive input).
//! * **Credentials**: `COMMAND_CODE_API_KEY` is the documented env channel
//!   that overrides auth.json for the official gateway (CLI constant
//!   `COMMAND_CODE_API_KEY_ENV_VAR`). The managed value stays in the system
//!   credential store and is injected at launch under the frozen name; no
//!   other env name is accepted.
//! * **auth.json** (login/subscription token) is NEVER read or written: no
//!   accounts port is declared and no credential file appears in
//!   `native_files`. `providers.json` (BYOK, raw literals rejected natively,
//!   `$VAR`/`{env:VAR}`/`!command` references) stays with the product.
//! * **Agents/plugins**: no format evidence (the `mods` command exists but
//!   its on-disk layout is unverified), both stay undelivered.
//! * **Official quota**: credits are subscription-web only; no verified
//!   non-interactive interface.

pub mod history;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::{
    file, project_root, AdapterDescriptor, CliAdapter, Facet, InspectionFields, LaunchMode,
    ManagementCapabilities, McpLocation, RuleSupport,
};
use crate::credentials::CredentialStore;
use crate::native::adapter::{NativeFile, Scope};
use crate::native::apply::NativeSecrets;
use crate::native::format::FileKind;
use crate::native::profile::{Connection, RegisteredProfile};
use crate::resources::mcp::{self, McpDefinition, McpTransport};

pub struct CommandCode;

/// The single `.commandcode` root. No relocation env exists in 1.73.4 (CLI
/// source derives it from HOME/USERPROFILE only).
pub(crate) fn config_root(home: &Path) -> PathBuf {
    crate::accounts::selection::config_root("command_code", || home.join(".commandcode"))
}

/// Frozen env channel: the CLI reads only `COMMAND_CODE_API_KEY`
/// (`COMMAND_CODE_API_KEY_ENV_VAR` in the shipped bundle) and it overrides
/// auth.json for the official gateway.
pub(crate) const CREDENTIAL_ENV_NAME: &str = "COMMAND_CODE_API_KEY";

impl CliAdapter for CommandCode {
    fn id(&self) -> &'static str {
        "command_code"
    }
    fn name(&self) -> &'static str {
        "Command Code"
    }
    /// The product command is `cmd`; the official Windows shim resolves through
    /// the `cmdc` alias so PATH probing never matches the system shell.
    fn command(&self) -> &'static str {
        if cfg!(windows) {
            "cmdc"
        } else {
            "cmd"
        }
    }
    fn npm_package(&self) -> &'static str {
        "command-code"
    }
    fn minimum_node_version(&self) -> Option<(u32, u32, u32)> { Some((22, 0, 0)) }
    fn node_dependency_detail(&self) -> &'static str { "Command Code 的 npm 安装需要 Node.js 22 或更新版本" }
    fn version_probe_environment(&self) -> &'static [(&'static str, &'static str)] {
        // 1.79.x initializes OpenTelemetry before Commander handles --version.
        // Its SDK shutdown can wait on the network even for this local query.
        &[("OTEL_SDK_DISABLED", "true")]
    }
    /// `cmdc --version` prints a bare semver string ("1.73.4"), so the probed
    /// binary name is the only identity signal; the Windows `cmd.exe`
    /// collision stays out of scope.
    fn version_identity(&self, basename: &str, output: &str) -> bool {
        let name = basename == "cmdc" || basename.starts_with("cmdc-")
            || (!cfg!(windows) && basename == "cmd");
        name && (output.contains("cmdc")
            || semver::Version::parse(output.trim().trim_start_matches('v')).is_ok())
    }
    fn native_files(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
        known: bool,
    ) -> Vec<NativeFile> {
        // Managed editing stays user-level; project `.commandcode` config
        // files stay with the product (skills are a resource location only).
        let Some(root) = project_root(scope, project) else {
            return vec![];
        };
        match root {
            Some(_) => Vec::new(),
            None => {
                let root = config_root(home);
                vec![
                    file(
                        "config",
                        root.join("config.json"),
                        FileKind::Json,
                        known,
                        Some("Command Code 全局 config.json（provider/model/reasoningEffort）；auth.json 含登录令牌绝不读写，providers.json BYOK 不接管"),
                        false,
                    ),
                    file(
                        "settings",
                        root.join("settings.json"),
                        FileKind::Json,
                        known,
                        None,
                        false,
                    ),
                ]
            }
        }
    }
    fn interface_formats(&self) -> &'static [&'static str] {
        // Third-party providers live in providers.json (BYOK, env-reference
        // apiKey syntax) which Cliora does not adopt; the official gateway
        // has no OpenAI/Anthropic-compatible address.
        &[]
    }
    fn file_kind(&self, role: &str) -> Result<FileKind, String> {
        if matches!(role, "config" | "settings") {
            Ok(FileKind::Json)
        } else {
            Err("Command Code 不支持此原生文件角色".into())
        }
    }
    fn portable_root_fields(&self, role: &str) -> &'static [&'static str] {
        if role == "config" {
            &["provider", "model", "reasoningEffort", "featureModels"]
        } else {
            &[]
        }
    }
    fn supports_mcp(&self) -> bool {
        true
    }
    fn mcp_location(
        &self,
        scope: Scope,
        home: &Path,
        _project: Option<&Path>,
    ) -> Option<McpLocation> {
        // User level only per the delivery scope: project `.mcp.json` and the
        // machine-local projects/<slug>/mcp.json layer stay with the product.
        if scope != Scope::Global {
            return None;
        }
        Some(McpLocation {
            path: config_root(home).join("mcp.json"),
            kind: FileKind::Json,
            root: "mcpServers",
            child: None,
        })
    }
    fn mcp_document(
        &self,
        definition: &McpDefinition,
        enabled: bool,
        existing: Option<&Value>,
    ) -> Result<Option<Value>, String> {
        // Shapes pinned by the shipped bundle (`toServerConfig`): stdio
        // {command,args,env} and http {url,headers}; `enabled` is the native
        // per-entry boolean flag, so a disabled entry stays in the file.
        let mut map = match definition.transport {
            McpTransport::Stdio => mcp::stdio_doc(definition, existing),
            McpTransport::Http => mcp::http_doc(definition, existing, "headers"),
        };
        map.insert("enabled".into(), json!(enabled));
        Ok(Some(Value::Object(map)))
    }
    fn mcp_disabled_description(&self) -> Option<&'static str> {
        Some("停用会写入 enabled: false，原生条目保留")
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
            Scope::Global => config_root(home).join("skills"),
            Scope::Project => project?.join(".commandcode").join("skills"),
        })
    }
    fn auth_env_name(&self, connection: &Connection) -> Option<String> {
        // Frozen channel: the CLI reads only COMMAND_CODE_API_KEY; a custom
        // name would promise a channel it ignores.
        if let Some(name) = connection.auth_env_var.as_deref() {
            return (name == CREDENTIAL_ENV_NAME).then(|| name.to_owned());
        }
        connection
            .secret_ref
            .as_ref()
            .map(|_| CREDENTIAL_ENV_NAME.to_owned())
    }
    fn connection_secret_via_launch_env(&self) -> bool {
        // providers.json accepts only `$VAR` references; the shared launch
        // service injects the frozen COMMAND_CODE_API_KEY at spawn time.
        true
    }
    fn connection_policy(&self, scope: Scope) -> crate::native::adapter::ConnectionPolicy {
        crate::native::adapter::ConnectionPolicy {
            api_key: if scope == Scope::Project {
                crate::native::adapter::api_key_scope_denied(
                    "Command Code 密钥仅以启动环境变量 COMMAND_CODE_API_KEY 注入，不在项目层管理",
                )
            } else {
                crate::native::adapter::api_key_writable()
            },
            provider_address: crate::native::adapter::address_unsupported(
                "Command Code 经官方网关访问；第三方供应商走原生 providers.json（BYOK，不接管）",
            ),
            projection: "single_connection",
        }
    }
    fn connection_documents(
        &self,
        _connection: &Connection,
        scope: Scope,
    ) -> Result<BTreeMap<String, Value>, String> {
        if scope == Scope::Project {
            return Err("Command Code 连接不在项目层管理".into());
        }
        // The key channel is the launch-time environment, so no native
        // document field is written for a connection.
        Ok(BTreeMap::from([("config".into(), json!({}))]))
    }
    fn write_connection_secret(
        &self,
        _profile: &RegisteredProfile,
        _scope: Scope,
        _credentials: &dyn CredentialStore,
        _secrets: &mut NativeSecrets,
    ) -> Result<(), String> {
        // Deliberately nothing is written into native files:
        // COMMAND_CODE_API_KEY is an OS environment channel, injected at
        // launch under the frozen name from the system credential store.
        Ok(())
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
        // config.json provider/model describe the official gateway lane, and
        // settings.json field semantics (beyond legacy migration fields) have
        // no verified inspection contract; nothing is inferred.
        InspectionFields::default()
    }
    fn launch_args(
        &self,
        session: Option<&str>,
        mode: LaunchMode,
    ) -> Result<Vec<String>, String> {
        let mut args = Vec::new();
        if let Some(id) = session {
            args.extend(["--session".into(), id.into()]);
        }
        if matches!(mode, LaunchMode::Yolo) {
            args.extend(["--permission-mode".into(), "yolo".into()]);
        }
        Ok(args)
    }
    fn node_required_when_missing(&self) -> bool {
        // Locally verified installation is the npm package `command-code`.
        true
    }
    fn install_guidance(&self) -> (&'static str, &'static str) {
        (
            "https://www.npmjs.com/package/command-code",
            "Command Code 通过官方 npm 包 command-code 安装（Windows 以 cmdc 别名解析实际 shim）；登录与订阅令牌由 CLI 原生管理。",
        )
    }
    fn history_sources(
        &self,
        home: &Path,
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
        // Session format v3 and the --session contract verified on 1.73.4;
        // allow ordinary movement inside 1.x.
        semver::Version::parse(version.trim().trim_start_matches('v'))
            .is_ok_and(|version| version.major == 1)
    }
    fn descriptor(&self) -> AdapterDescriptor {
        AdapterDescriptor {
            id: self.id(),
            configuration: None,
            name: self.name(),
            interface_formats: self.interface_formats(),
            project_model_override: false,
            yolo_available: true,
            launch_form: self.launch_form(),
            native_config: Facet {
                state: "available",
                reason: "已确认 CLI 身份，可编辑用户级 ~/.commandcode/config.json 与 settings.json（auth.json/providers.json 不接管）",
            },
            launch: Facet {
                state: "available",
                reason: "以所选工作目录在外部终端启动 cmdc（Windows 别名）；--permission-mode yolo 对应信任全部工具",
            },
            resume: Facet {
                state: "available",
                reason: "可用原生会话 ID 以 --session <id|路径> 在外部终端恢复；-r/-c 为 CLI 内交互选择",
            },
            resources: Facet {
                state: "available",
                reason: "MCP（用户级 ~/.commandcode/mcp.json，mcpServers + enabled 标志）、Skills（个人 ~/.commandcode/skills 与项目 .commandcode/skills，SKILL.md frontmatter）由原生路径提供",
            },
            history: Facet {
                state: "available",
                reason: "只读索引 projects/<slug>/<uuid>.jsonl（version 3 头 + 逐消息 usage 四分项与 costUsd；input 不含 cache）；标题来自 <id>.meta.json sidecar",
            },
            login: None,
            management: ManagementCapabilities {
                accounts: false,
                mcp: true,
                skills: true,
                agents: false,
                plugins: false,
                project_plugins: false,
                rules: RuleSupport {
                    global: false,
                    project: false,
                },
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::LaunchForm;
    use crate::native::profile::valid_env_name;
    use crate::resources::mcp::McpTransport;

    const MCP_FIXTURE: &str = include_str!("../../../../tests/fixtures/native/command-code-1.73.json");

    fn connection() -> Connection {
        Connection {
            provider_id: "command-code".into(),
            interface_format: String::new(),
            base_url: String::new(),
            model: String::new(),
            secret_ref: Some("connection-930b8796-7d77-4e70-a8ba-6209ff1272e8".into()),
            auth_env_var: None,
            model_records: Vec::new(),
        }
    }

    #[test]
    fn identity_accepts_only_the_official_names() {
        assert!(CommandCode.version_identity("cmdc", "1.73.4"));
        assert!(CommandCode.version_identity("cmdc", "cmdc 1.73.4"));
        assert!(!CommandCode.version_identity("cmdc", "claude 2.1.283"));
        assert!(!CommandCode.version_identity("other", "1.73.4"));
        if !cfg!(windows) {
            assert!(CommandCode.version_identity("cmd", "1.73.4"));
        }
        // The Windows system shell (basename `cmd`) never verifies identity
        // through generic help output.
        assert!(!CommandCode.version_identity(
            "cmd",
            "starts a new instance of the windows command interpreter"
        ));
        assert!(CommandCode.history_resume_version_supported("1.73.4"));
        assert!(CommandCode.history_resume_version_supported("1.77.0"));
        assert!(!CommandCode.history_resume_version_supported("2.0.0"));
        assert_eq!(CommandCode.npm_package(), "command-code");
        assert!(CommandCode.node_required_when_missing());
    }

    #[test]
    fn native_files_map_the_documented_config_only() {
        let home = Path::new("/home/example");
        assert!(config_root(home).ends_with(".commandcode"));
        let global = CommandCode.native_files(Scope::Global, home, None, true);
        assert_eq!(global.len(), 2);
        assert_eq!(global[0].role, "config");
        assert!(global[0]
            .path
            .replace('\\', "/")
            .ends_with(".commandcode/config.json"));
        assert!(global[1]
            .path
            .replace('\\', "/")
            .ends_with(".commandcode/settings.json"));
        // Credential files never enter the managed surface.
        assert!(global.iter().all(|item| !item.path.contains("auth.json")));
        assert!(global
            .iter()
            .all(|item| !item.path.contains("providers.json")));
        assert!(CommandCode
            .native_files(Scope::Project, home, Some(Path::new("/work/p")), true)
            .is_empty());
        assert_eq!(CommandCode.file_kind("config").unwrap(), FileKind::Json);
        assert_eq!(CommandCode.file_kind("settings").unwrap(), FileKind::Json);
        assert!(CommandCode.file_kind("auth").is_err());
        assert!(CommandCode
            .portable_root_fields("config")
            .contains(&"model"));
        assert!(CommandCode.portable_root_fields("settings").is_empty());
    }

    #[test]
    fn mcp_is_user_level_only_with_native_enabled_flag() {
        let temp = tempfile::tempdir().unwrap();
        let location = CommandCode
            .mcp_location(Scope::Global, temp.path(), None)
            .unwrap();
        assert_eq!(
            location.path,
            config_root(temp.path()).join("mcp.json")
        );
        assert_eq!(location.kind, FileKind::Json);
        assert_eq!(location.root, "mcpServers");
        assert_eq!(location.child, None);
        // Project .mcp.json and the projects/<slug>/mcp.json local layer stay
        // with the product per the delivery scope.
        assert!(CommandCode
            .mcp_location(
                Scope::Project,
                temp.path(),
                Some(Path::new("/work/demo"))
            )
            .is_none());
        // The sanitized fixture parses through the shared entry reader.
        std::fs::create_dir_all(location.path.parent().unwrap()).unwrap();
        std::fs::write(&location.path, MCP_FIXTURE).unwrap();
        let text = crate::native::transaction::read_native(&location.path).unwrap();
        let parsed = crate::native::format::parse(location.kind, &text).unwrap();
        let entries = CommandCode.mcp_entries(&parsed, &location).unwrap();
        assert_eq!(entries.len(), 2, "{entries:?}");
        assert_eq!(entries["example-stdio"]["command"], "npx");
        assert_eq!(
            entries["example-stdio"]["args"],
            json!(["-y", "example-mcp"])
        );
        assert_eq!(entries["example-stdio"]["env"]["EXAMPLE_MODE"], "fixture");
        assert_eq!(entries["example-stdio"]["enabled"], true);
        assert_eq!(
            entries["example-remote"]["url"],
            "https://mcp.example.com/mcp"
        );
        assert_eq!(entries["example-remote"]["headers"]["X-Example"], "fixture");
        assert_eq!(entries["example-remote"]["enabled"], false);
    }

    #[test]
    fn mcp_documents_match_the_native_stdio_and_http_shapes() {
        let definition = McpDefinition {
            id: "fixture-definition".into(),
            name: "example".into(),
            transport: McpTransport::Stdio,
            command: "fixture-runner".into(),
            args: vec!["-y".into(), "example-mcp".into()],
            url: String::new(),
            env: BTreeMap::new(),
            headers: BTreeMap::new(),
            in_library: true,
            version: 0,
        };
        let enabled = CommandCode
            .mcp_document(&definition, true, None)
            .unwrap()
            .unwrap();
        assert_eq!(enabled["command"], "fixture-runner");
        assert_eq!(enabled["args"], json!(["-y", "example-mcp"]));
        assert_eq!(enabled["enabled"], true);
        let remote_definition = McpDefinition {
            transport: McpTransport::Http,
            url: "https://mcp.example.com/mcp".into(),
            headers: BTreeMap::from([("X-Example".into(), "1".into())]),
            ..definition
        };
        let existing = json!({"enabled": true, "env": {"OLD": "1"}});
        let disabled = CommandCode
            .mcp_document(&remote_definition, false, Some(&existing))
            .unwrap()
            .unwrap();
        assert_eq!(disabled["url"], "https://mcp.example.com/mcp");
        assert_eq!(disabled["headers"]["X-Example"], "1");
        assert_eq!(disabled["enabled"], false, "停用写 enabled: false");
        assert!(disabled.get("command").is_none(), "http 条目不保留 stdio 字段");
        assert_eq!(
            CommandCode.mcp_disabled_description(),
            Some("停用会写入 enabled: false，原生条目保留")
        );
    }

    #[test]
    fn skill_roots_follow_the_official_directories() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        assert_eq!(
            CommandCode.skill_root(Scope::Global, temp.path(), None).unwrap(),
            config_root(temp.path()).join("skills")
        );
        assert_eq!(
            CommandCode
                .skill_root(Scope::Project, temp.path(), Some(&project))
                .unwrap(),
            project.join(".commandcode/skills")
        );
    }

    #[test]
    fn launch_args_cover_session_resume_and_yolo() {
        assert!(CommandCode
            .launch_args(None, LaunchMode::Normal)
            .unwrap()
            .is_empty());
        assert_eq!(
            CommandCode.launch_args(None, LaunchMode::Yolo).unwrap(),
            vec!["--permission-mode", "yolo"]
        );
        assert_eq!(
            CommandCode
                .launch_args(Some("4d2c0a55-3b7e-4f6a-9c21-8e0a11d57b34"), LaunchMode::Normal)
                .unwrap(),
            vec![
                "--session",
                "4d2c0a55-3b7e-4f6a-9c21-8e0a11d57b34"
            ]
        );
        assert_eq!(
            CommandCode
                .launch_args(Some("4d2c0a55-3b7e-4f6a-9c21-8e0a11d57b34"), LaunchMode::Yolo)
                .unwrap(),
            vec![
                "--session",
                "4d2c0a55-3b7e-4f6a-9c21-8e0a11d57b34",
                "--permission-mode",
                "yolo"
            ]
        );
    }

    #[test]
    fn auth_env_name_is_frozen_to_the_official_command_code_api_key() {
        let mut connection = connection();
        assert_eq!(
            CommandCode.auth_env_name(&connection).as_deref(),
            Some("COMMAND_CODE_API_KEY")
        );
        connection.auth_env_var = Some("COMMAND_CODE_API_KEY".into());
        assert_eq!(
            CommandCode.auth_env_name(&connection).as_deref(),
            Some("COMMAND_CODE_API_KEY")
        );
        // A custom name would promise a channel the CLI never reads.
        connection.auth_env_var = Some("SOMETHING_ELSE".into());
        assert!(valid_env_name("SOMETHING_ELSE"));
        assert_eq!(CommandCode.auth_env_name(&connection), None);
    }

    #[test]
    fn connection_documents_never_touch_credential_files() {
        let documents = CommandCode
            .connection_documents(&connection(), Scope::Global)
            .unwrap();
        assert!(documents["config"].as_object().unwrap().is_empty());
        assert!(CommandCode
            .connection_documents(&connection(), Scope::Project)
            .is_err());
        let policy = CommandCode.connection_policy(Scope::Global);
        assert_eq!(policy.api_key.state, "writable");
        assert_eq!(policy.provider_address.state, "unsupported");
        // The credential store stays the only home of the key: the secret
        // channel writes nothing into native files.
        struct MissingStore;
        impl CredentialStore for MissingStore {
            fn put(&self, _: &str, _: &str) -> Result<(), String> {
                unreachable!("Command Code 密钥不写入原生文件")
            }
            fn get(&self, _: &str) -> Result<String, String> {
                Err("missing".into())
            }
            fn delete(&self, _: &str) -> Result<(), String> {
                unreachable!("Command Code 密钥不写入原生文件")
            }
        }
        let profile = RegisteredProfile {
            editing: None,
            id: String::new(),
            tool: "command_code".into(),
            name: "demo".into(),
            version: 1,
            revision: String::new(),
            inherit_common: false,
            files: BTreeMap::new(),
            suppressed: BTreeMap::new(),
            authentication: Default::default(),
            connection: Some(connection()),
            native_credentials: BTreeMap::new(),
        };
        let mut secrets = NativeSecrets::default();
        CommandCode
            .write_connection_secret(&profile, Scope::Global, &MissingStore, &mut secrets)
            .unwrap();
        assert!(!CommandCode.has_native_secret(
            "config",
            &json!({"env": {"COMMAND_CODE_API_KEY": "sk-x"}})
        ));
        assert!(CommandCode
            .write_connection_secret(&profile, Scope::Project, &MissingStore, &mut secrets)
            .is_ok(),
            "项目层由 connection_documents/policy 拒绝，密钥通道本身无文件写入");
    }

    #[test]
    fn delivered_dimensions_declare_no_fabricated_ports() {
        assert!(CommandCode.history_supported());
        assert!(CommandCode.supports_mcp());
        assert!(CommandCode.supports_skills());
        // Agents (`mods` command, layout unverified), plugins and the
        // official quota (web-only credits) stay undelivered with reasons;
        // auth.json is deliberately not adopted, so no accounts port.
        assert!(CommandCode.agents().is_none());
        assert!(CommandCode.plugins().is_none());
        assert!(CommandCode.accounts().is_none());
        assert!(CommandCode.official_usage().is_none());
        assert!(CommandCode.configuration().is_none());
        let descriptor = CommandCode.descriptor();
        assert_eq!(descriptor.native_config.state, "available");
        assert_eq!(descriptor.launch.state, "available");
        assert_eq!(descriptor.resume.state, "available");
        assert_eq!(descriptor.resources.state, "available");
        assert_eq!(descriptor.history.state, "available");
        assert_eq!(descriptor.launch_form, LaunchForm::Terminal);
        assert!(descriptor.yolo_available);
        assert!(descriptor.login.is_none());
        assert!(!descriptor.management.accounts);
        assert!(descriptor.management.mcp);
        assert!(descriptor.management.skills);
        assert!(!descriptor.management.agents);
        assert!(!descriptor.management.plugins);
        assert!(!descriptor.management.rules.global);
        assert!(!descriptor.management.rules.project);
        assert_eq!(
            CommandCode.install_guidance().0,
            "https://www.npmjs.com/package/command-code"
        );
        assert!(CommandCode.install_command().is_some());
    }
}
