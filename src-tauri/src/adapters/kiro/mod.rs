//! Kiro CLI (AWS, `kiro-cli`) adapter.
//!
//! Registered default-off through the non-enumerated stable id `kiro`. The CLI
//! is closed-source and not installed locally, so dimensions follow the
//! evidence classes of 02-technical-solution ADR-2: official docs for the
//! command surface (`cli.kiro.dev`, `chat` with `-r/--resume`,
//! `--resume-id <ID>`, `--resume-picker`, `--trust-all-tools`) and [RE]
//! community reverse engineering (agentsview kiro.go, threadle) for the
//! settings/session layout recorded in 01-exploration.md §4. [RE] shapes
//! degrade strictly (`partial`) instead of being guessed.
//!
//! * **Paths**: `KIRO_HOME` relocates the whole root; otherwise `~/.kiro`
//!   holds `settings/cli.json`, `settings/mcp.json` and the legacy
//!   `sessions/cli/<uuid>.jsonl` logs. The Windows data root was resolved
//!   against a real local install: kiro-cli keeps its data in
//!   `%LOCALAPPDATA%\kiro-cli` (`data.sqlite3` + `tui.js`, no `~/.kiro`);
//!   `data_root` prefers an existing `~/.kiro`, then that directory.
//! * **MCP**: user-level `~/.kiro/settings/mcp.json` and workspace
//!   `.kiro/settings/mcp.json` (`mcpServers` root). Kiro merges both by name
//!   with workspace precedence; Cliora manages each file through its own
//!   scope. stdio entries are `{command, args, env}` — `env` values may carry
//!   `${VAR}` references that kiro expands at launch, which stay verbatim
//!   (read-only, never resolved or rewritten here); remote entries are
//!   `{url, headers, oauth}`; `disabled` and `autoApprove` are native flags.
//! * **Sessions**: legacy `sessions/cli/<uuid>.jsonl` plus current
//!   `<data-root>/<workspace>/sess_<id>/messages.jsonl` (see `history`).
//!   `data.sqlite3` (`conversations_v2` key/conversation_id/value/
//!   created_at/updated_at — schema read off the real local install, zero
//!   rows there) is a persistent archive whose `value` payload shape has no
//!   row evidence; it is not indexed (known limitation, never guessed).
//! * **Usage**: none of the three session formats carries token fields, so
//!   the usage dimension is absent with that recorded reason.
//! * **Credentials**: `KIRO_API_KEY` (ksk_ prefix, Pro+) is an OS environment
//!   channel only — cli.json carries no key fields in any evidence. The
//!   managed value stays in the system credential store and is injected at
//!   launch under the frozen name `KIRO_API_KEY` (shared launch service).
//! * **Login**: Builder ID/Google/GitHub/IAM IdC flows stay with the product;
//!   no accounts port is declared and no login state is adopted.

pub mod history;

use std::collections::BTreeMap;
use std::env;
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

pub struct Kiro;

/// Whole Kiro root: `~/.kiro`, fully relocated by `KIRO_HOME` (settings,
/// sessions and resource directories). Only the real user home honors the
/// override so tests with an isolated home cannot be redirected.
pub(crate) fn kiro_root(home: &Path) -> PathBuf {
    crate::accounts::selection::config_root("kiro", || {
        if dirs::home_dir().as_deref() == Some(home) {
            if let Some(root) = env::var_os("KIRO_HOME") {
                let path = PathBuf::from(root);
                if path.is_absolute() {
                    return path;
                }
            }
        }
        home.join(".kiro")
    })
}

/// Session data root. Resolved by existence: `~/.kiro` first — the root
/// every [RE] source reads — then `%LOCALAPPDATA%\kiro-cli`, which a real
/// Windows install on this machine confirmed as its data root (holds
/// `data.sqlite3` + `tui.js`, with `~/.kiro` absent). `KIRO_HOME` always wins
/// because it relocates the entire root; when no candidate exists the
/// documented `~/.kiro` default is returned. Only the real user home resolves
/// machine directories so isolated test homes stay deterministic.
pub(crate) fn data_root(home: &Path) -> PathBuf {
    crate::accounts::selection::history_root("kiro", || {
        let real_home = dirs::home_dir().as_deref() == Some(home);
        let kiro = if real_home {
            env::var_os("KIRO_HOME")
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
                .unwrap_or_else(|| home.join(".kiro"))
        } else {
            home.join(".kiro")
        };
        if kiro.is_dir() {
            return kiro;
        }
        if real_home {
            if let Some(local) = env::var_os("LOCALAPPDATA") {
                let candidate = PathBuf::from(local).join("kiro-cli");
                if candidate.is_dir() {
                    return candidate;
                }
            }
        }
        kiro
    })
}

impl CliAdapter for Kiro {
    fn id(&self) -> &'static str {
        "kiro"
    }
    fn name(&self) -> &'static str {
        "Kiro"
    }
    fn command(&self) -> &'static str {
        "kiro-cli"
    }
    fn npm_package(&self) -> &'static str {
        ""
    }
    fn latest_version_url(&self) -> Option<String> {
        Some("https://prod.download.cli.kiro.dev/stable/latest/manifest.json".into())
    }
    /// No verified `--version` transcript exists (the CLI is not installed
    /// locally); identity only accepts the documented command name with a
    /// self-named or bare semver response.
    fn version_identity(&self, basename: &str, output: &str) -> bool {
        // Only kiro-cli names identify the CLI; a bare `kiro` binary may be
        // the Kiro IDE launcher and never verifies identity here.
        (basename == "kiro-cli" || basename.starts_with("kiro-cli-"))
            && (output.contains("kiro")
                || semver::Version::parse(output.trim().trim_start_matches('v')).is_ok())
    }
    fn native_files(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
        known: bool,
    ) -> Vec<NativeFile> {
        // Managed editing stays user-level; the workspace `.kiro` tree is a
        // resource location only (MCP), never a managed file here.
        let Some(root) = project_root(scope, project) else {
            return vec![];
        };
        match root {
            Some(_) => Vec::new(),
            None => vec![file(
                "settings",
                kiro_root(home).join("settings").join("cli.json"),
                FileKind::Json,
                known,
                None,
                false,
            )],
        }
    }
    fn interface_formats(&self) -> &'static [&'static str] {
        &[]
    }
    fn file_kind(&self, role: &str) -> Result<FileKind, String> {
        if role == "settings" {
            Ok(FileKind::Json)
        } else {
            Err("Kiro 不支持此原生文件角色".into())
        }
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
        // kiro merges user-level and workspace entries by name with workspace
        // precedence; each file stays managed in its own scope.
        let path = match scope {
            Scope::Global => kiro_root(home).join("settings").join("mcp.json"),
            Scope::Project => project?.join(".kiro").join("settings").join("mcp.json"),
        };
        Some(McpLocation {
            path,
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
        // Shapes pinned by the [RE] evidence: stdio {command, args, env} —
        // `${VAR}` env values expand natively at launch and stay verbatim —
        // and remote {url, headers, oauth}; `disabled`/`autoApprove` are
        // native flags kept from the existing entry.
        let mut map = match definition.transport {
            McpTransport::Stdio => mcp::stdio_doc(definition, existing),
            McpTransport::Http => mcp::http_doc(definition, existing, "headers"),
        };
        map.insert("disabled".into(), json!(!enabled));
        Ok(Some(Value::Object(map)))
    }
    fn mcp_disabled_description(&self) -> Option<&'static str> {
        Some("停用会写入 disabled: true，原生条目保留")
    }
    fn auth_env_name(&self, connection: &Connection) -> Option<String> {
        // Frozen channel: kiro reads only the OS env KIRO_API_KEY (ksk_
        // prefix, Pro+); a custom name would promise a channel it ignores.
        if let Some(name) = connection.auth_env_var.as_deref() {
            return (name == "KIRO_API_KEY").then(|| name.to_owned());
        }
        connection
            .secret_ref
            .as_ref()
            .map(|_| "KIRO_API_KEY".to_owned())
    }
    fn connection_secret_via_launch_env(&self) -> bool {
        // No native file carries the key; the shared launch service injects
        // the frozen KIRO_API_KEY at spawn time.
        true
    }
    fn connection_policy(&self, scope: Scope) -> crate::native::adapter::ConnectionPolicy {
        crate::native::adapter::ConnectionPolicy {
            api_key: if scope == Scope::Project {
                crate::native::adapter::api_key_scope_denied(
                    "Kiro 密钥仅以启动环境变量 KIRO_API_KEY 注入，不在项目层管理",
                )
            } else {
                crate::native::adapter::api_key_writable()
            },
            provider_address: crate::native::adapter::address_unsupported(
                "Kiro 经官方网关与 Builder ID/IAM IdC 登录访问，无已验证的第三方供应商地址配置",
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
            return Err("Kiro 连接不在项目层管理".into());
        }
        // No cli.json connection field has evidence; the key channel is the
        // launch-time environment, so the settings document stays untouched.
        Ok(BTreeMap::from([("settings".into(), json!({}))]))
    }
    fn write_connection_secret(
        &self,
        _profile: &RegisteredProfile,
        _scope: Scope,
        _credentials: &dyn CredentialStore,
        _secrets: &mut NativeSecrets,
    ) -> Result<(), String> {
        // Deliberately nothing is written into native files: KIRO_API_KEY is
        // an OS environment channel, injected at launch under the frozen name
        // from the system credential store (shared launch service).
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
        // cli.json field semantics have no evidence; nothing is inferred.
        InspectionFields::default()
    }
    fn launch_args(
        &self,
        session: Option<&str>,
        mode: LaunchMode,
    ) -> Result<Vec<String>, String> {
        let mut args = vec!["chat".to_owned()];
        if let Some(id) = session {
            args.extend(["--resume-id".to_owned(), id.to_owned()]);
        }
        if matches!(mode, LaunchMode::Yolo) {
            args.push("--trust-all-tools".to_owned());
        }
        Ok(args)
    }
    fn node_required_when_missing(&self) -> bool {
        // The official installer ships a standalone binary.
        false
    }
    fn install_guidance(&self) -> (&'static str, &'static str) {
        (
            "https://cli.kiro.dev",
            "Kiro CLI 经官方脚本（cli.kiro.dev 的 curl/PowerShell 命令）安装；登录 Builder ID/Google/GitHub/IAM IdC 由 CLI 原生管理。",
        )
    }
    fn install_command(&self) -> Option<String> {
        None
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
                reason: "已登记官方命令身份，可编辑用户级 ~/.kiro/settings/cli.json（JSON；KIRO_HOME 覆盖整个根目录）",
            },
            launch: Facet {
                state: "available",
                reason: "以所选工作目录在外部终端启动 kiro-cli chat；--trust-all-tools 对应信任全部工具",
            },
            resume: Facet {
                state: "available",
                reason: "可用原生会话 ID 以 --resume-id 在外部终端恢复；-r/--resume 与 --resume-picker 为 CLI 内交互选择",
            },
            resources: Facet {
                state: "available",
                reason: "MCP 由原生路径提供：用户级 ~/.kiro/settings/mcp.json 与工作区 .kiro/settings/mcp.json（按名合并、工作区优先；${VAR} 由 CLI 原生展开）",
            },
            history: Facet {
                state: "available",
                reason: "只读索引 legacy sessions/cli/<uuid>.jsonl 与现行 sess_<id>/messages.jsonl（[RE] 证据，缺字段降级 partial）；legacy/现行/data.sqlite3 三种格式均无 token 字段，用量维度不交付；data.sqlite3 conversations_v2 归档表结构已实测但无消息行样本，未索引",
            },
            login: None,
            management: ManagementCapabilities {
                accounts: false,
                mcp: true,
                skills: false,
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

    const MCP_FIXTURE: &str = include_str!("../../../../tests/fixtures/native/kiro-cli.json");

    #[test]
    fn identity_accepts_only_the_official_command_name() {
        assert!(Kiro.version_identity("kiro-cli", "1.0.0"));
        assert!(Kiro.version_identity("kiro-cli", "kiro-cli 1.0.0"));
        assert!(!Kiro.version_identity("kiro-cli", "claude 2.1.283"));
        assert!(!Kiro.version_identity("kiro", "1.0.0"));
        assert!(!Kiro.version_identity("other", "1.0.0"));
    }

    #[test]
    fn roots_default_to_dot_kiro_and_settings_map_the_official_files() {
        let home = Path::new("/home/example");
        assert!(kiro_root(home).ends_with(".kiro"));
        // An isolated home never resolves real machine directories, so the
        // documented default is deterministic even on a machine that has a
        // real %LOCALAPPDATA%\kiro-cli install.
        assert_eq!(data_root(home), home.join(".kiro"));
        let global = Kiro.native_files(Scope::Global, home, None, true);
        assert_eq!(global.len(), 1);
        assert_eq!(global[0].role, "settings");
        assert_eq!(global[0].format, "json");
        assert!(global[0]
            .path
            .replace('\\', "/")
            .ends_with(".kiro/settings/cli.json"));
        // The workspace .kiro tree is a resource location only.
        assert!(Kiro
            .native_files(Scope::Project, home, Some(Path::new("/work/p")), true)
            .is_empty());
        assert_eq!(Kiro.file_kind("settings").unwrap(), FileKind::Json);
        assert!(Kiro.file_kind("mcp").is_err());
        assert!(!Kiro.node_required_when_missing());
        assert!(Kiro.install_command().is_none());
        // An existing ~/.kiro wins over the Windows fallback candidates.
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join(".kiro")).unwrap();
        assert_eq!(data_root(temp.path()), temp.path().join(".kiro"));
    }

    #[test]
    fn mcp_locations_cover_user_and_workspace_settings_files() {
        let temp = tempfile::tempdir().unwrap();
        let global = Kiro
            .mcp_location(Scope::Global, temp.path(), None)
            .unwrap();
        assert_eq!(
            global.path,
            temp.path().join(".kiro/settings/mcp.json")
        );
        assert_eq!(global.kind, FileKind::Json);
        assert_eq!(global.root, "mcpServers");
        assert_eq!(global.child, None);
        let project = Kiro
            .mcp_location(
                Scope::Project,
                temp.path(),
                Some(Path::new("/work/demo")),
            )
            .unwrap();
        assert_eq!(
            project.path,
            Path::new("/work/demo").join(".kiro/settings/mcp.json")
        );
    }

    #[test]
    fn mcp_fixture_lists_entries_with_disabled_flags_and_verbatim_refs() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(".kiro/settings/mcp.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, MCP_FIXTURE).unwrap();
        let location = Kiro
            .mcp_location(Scope::Global, temp.path(), None)
            .unwrap();
        let text = crate::native::transaction::read_native(&location.path).unwrap();
        let parsed = crate::native::format::parse(FileKind::Json, &text).unwrap();
        let entries = Kiro.mcp_entries(&parsed, &location).unwrap();
        assert_eq!(entries.len(), 2, "{entries:?}");
        let stdio = &entries["example-stdio"];
        assert_eq!(stdio["command"], "npx");
        assert_eq!(stdio["args"], json!(["-y", "example-mcp"]));
        // ${VAR} references stay verbatim: kiro expands them at launch.
        assert_eq!(stdio["env"]["API_KEY"], "${EXAMPLE_KEY}");
        assert_eq!(stdio["autoApprove"], json!(["list_tools", "read_file"]));
        assert_eq!(stdio["disabled"], false);
        let remote = &entries["example-remote"];
        assert_eq!(remote["url"], "https://mcp.example.com/mcp");
        assert_eq!(remote["headers"]["X-Example"], "fixture");
        assert_eq!(remote["oauth"], true);
        assert_eq!(remote["disabled"], true);
    }

    #[test]
    fn mcp_documents_match_the_native_stdio_and_remote_shapes() {
        let definition = McpDefinition {
            id: "fixture-definition".into(),
            name: "example".into(),
            transport: McpTransport::Stdio,
            command: "fixture-runner".into(),
            args: vec!["-y".into(), "example-mcp".into()],
            url: String::new(),
            env: BTreeMap::from([("API_KEY".into(), "${EXAMPLE_KEY}".into())]),
            headers: BTreeMap::new(),
            in_library: true,
            version: 0,
        };
        let enabled = Kiro
            .mcp_document(&definition, true, None)
            .unwrap()
            .unwrap();
        assert_eq!(enabled["command"], "fixture-runner");
        assert_eq!(enabled["args"], json!(["-y", "example-mcp"]));
        assert_eq!(enabled["env"]["API_KEY"], "${EXAMPLE_KEY}");
        assert_eq!(enabled["disabled"], false);
        assert!(enabled.get("enabled").is_none(), "Kiro 用 disabled 标志，无 enabled 字段");
        let remote_definition = McpDefinition {
            transport: McpTransport::Http,
            url: "https://mcp.example.com/mcp".into(),
            headers: BTreeMap::from([("X-Example".into(), "1".into())]),
            ..definition
        };
        let existing = json!({"autoApprove": ["list_tools"], "disabled": false});
        let disabled = Kiro
            .mcp_document(&remote_definition, false, Some(&existing))
            .unwrap()
            .unwrap();
        assert_eq!(disabled["url"], "https://mcp.example.com/mcp");
        assert_eq!(disabled["headers"]["X-Example"], "1");
        assert_eq!(disabled["disabled"], true);
        assert_eq!(
            disabled["autoApprove"],
            json!(["list_tools"]),
            "原生 autoApprove 标志保留"
        );
        assert_eq!(
            Kiro.mcp_disabled_description(),
            Some("停用会写入 disabled: true，原生条目保留")
        );
    }

    #[test]
    fn launch_args_cover_chat_resume_and_trust_all_tools() {
        assert_eq!(
            Kiro.launch_args(None, LaunchMode::Normal).unwrap(),
            vec!["chat"]
        );
        assert_eq!(
            Kiro.launch_args(None, LaunchMode::Yolo).unwrap(),
            vec!["chat", "--trust-all-tools"]
        );
        assert_eq!(
            Kiro.launch_args(Some("sess_a1b2c3d4e5f67890"), LaunchMode::Normal).unwrap(),
            vec!["chat", "--resume-id", "sess_a1b2c3d4e5f67890"]
        );
        assert_eq!(
            Kiro
                .launch_args(Some("6f5813aa-9d04-4d7b-b3e2-5c1f0a67d2e4"), LaunchMode::Yolo)
                .unwrap(),
            vec![
                "chat",
                "--resume-id",
                "6f5813aa-9d04-4d7b-b3e2-5c1f0a67d2e4",
                "--trust-all-tools"
            ]
        );
    }

    #[test]
    fn auth_env_name_is_frozen_to_the_official_kiro_api_key() {
        let mut connection = Connection {
            provider_id: "kiro".into(),
            interface_format: String::new(),
            base_url: String::new(),
            model: String::new(),
            secret_ref: Some("connection-930b8796-7d77-4e70-a8ba-6209ff1272e8".into()),
            auth_env_var: None,
            model_records: Vec::new(),
        };
        assert_eq!(
            Kiro.auth_env_name(&connection).as_deref(),
            Some("KIRO_API_KEY")
        );
        connection.auth_env_var = Some("KIRO_API_KEY".into());
        assert_eq!(
            Kiro.auth_env_name(&connection).as_deref(),
            Some("KIRO_API_KEY")
        );
        // A custom name would promise a channel kiro never reads.
        connection.auth_env_var = Some("SOMETHING_ELSE".into());
        assert!(valid_env_name("SOMETHING_ELSE"));
        assert_eq!(Kiro.auth_env_name(&connection), None);
    }

    #[test]
    fn connection_documents_never_touch_cli_json_and_secrets_stay_env_only() {
        let connection = Connection {
            provider_id: "kiro".into(),
            interface_format: String::new(),
            base_url: String::new(),
            model: String::new(),
            secret_ref: Some("connection-930b8796-7d77-4e70-a8ba-6209ff1272e8".into()),
            auth_env_var: None,
            model_records: Vec::new(),
        };
        let documents = Kiro
            .connection_documents(&connection, Scope::Global)
            .unwrap();
        assert!(documents["settings"].as_object().unwrap().is_empty());
        assert!(Kiro
            .connection_documents(&connection, Scope::Project)
            .is_err());
        let policy = Kiro.connection_policy(Scope::Global);
        assert_eq!(policy.api_key.state, "writable");
        assert_eq!(policy.provider_address.state, "unsupported");
        // The credential store stays the only home of the key: the secret
        // channel writes nothing into native files.
        struct MissingStore;
        impl CredentialStore for MissingStore {
            fn put(&self, _: &str, _: &str) -> Result<(), String> {
                unreachable!("Kiro 密钥不写入原生文件")
            }
            fn get(&self, _: &str) -> Result<String, String> {
                Err("missing".into())
            }
            fn delete(&self, _: &str) -> Result<(), String> {
                unreachable!("Kiro 密钥不写入原生文件")
            }
        }
        let profile = RegisteredProfile {
            editing: None,
            id: String::new(),
            tool: "kiro".into(),
            name: "demo".into(),
            version: 1,
            revision: String::new(),
            inherit_common: false,
            files: BTreeMap::new(),
            suppressed: BTreeMap::new(),
            authentication: Default::default(),
            connection: Some(connection),
            native_credentials: BTreeMap::new(),
        };
        let mut secrets = NativeSecrets::default();
        Kiro.write_connection_secret(&profile, Scope::Global, &MissingStore, &mut secrets)
            .unwrap();
        assert!(!Kiro.has_native_secret("settings", &json!({"env": {"KIRO_API_KEY": "ksk-x"}})));
    }

    #[test]
    fn delivered_dimensions_declare_no_fabricated_ports() {
        assert!(Kiro.history_supported());
        assert!(Kiro.supports_mcp());
        // Skills/agents/plugins directories under ~/.kiro are referenced by
        // official docs without verified locations; accounts/login flows and
        // the official quota (web-only) stay undelivered with reasons.
        assert!(!Kiro.supports_skills());
        assert!(Kiro.agents().is_none());
        assert!(Kiro.plugins().is_none());
        assert!(Kiro.accounts().is_none());
        assert!(Kiro.official_usage().is_none());
        assert!(Kiro.configuration().is_none());
        let descriptor = Kiro.descriptor();
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
        assert!(!descriptor.management.skills);
        assert!(!descriptor.management.agents);
        assert!(!descriptor.management.plugins);
        assert!(!descriptor.management.rules.global);
        assert!(!descriptor.management.rules.project);
        // The recorded usage absence reason stays part of the descriptor.
        assert!(descriptor.history.reason.contains("无 token 字段"));
        assert_eq!(
            Kiro.install_guidance().0,
            "https://cli.kiro.dev"
        );
    }
}
