//! Cline CLI (`cline`) adapter.
//!
//! Registered default-off through the non-enumerated stable id `cline`.
//! Delivered dimensions cite the official source at cline/cline@main
//! (2026-10-07) per 02-technical-solution ADR-2 ([src]); the CLI itself is
//! not installed locally, so shapes that the source summary did not pin are
//! treated conservatively (parsed read-only, unknown fields preserved,
//! never guessed).
//!
//! * **Paths**: config root `~/.cline` (`CLINE_DIR` may relocate it), data
//!   root `~/.cline/data` (`CLINE_DATA_DIR`). Managed editing stays
//!   user-level `global-settings.json`; the project `.cline` mirror is not
//!   verified and stays with the product.
//! * **Credentials** (`data/settings/providers.json`): the source confirms
//!   account keys are stored in PLAINTEXT there. The file never enters the
//!   managed surface, no credential port exists, and token/apiKey values
//!   must never reach any IPC, log or test output. Login state is owned by
//!   the product keychain + providers.json; Cliora neither adopts, copies
//!   nor echoes it.
//! * **Launch/resume**: `cline` interactive; `cline --id <session-id>`
//!   resumes a native session. No verified skip-permissions flag exists, so
//!   yolo stays unavailable.
//! * **MCP** ([src] pinned the top-level `mcpServers` object of
//!   `cline_mcp_settings.json` only): entries are parsed conservatively
//!   (stdio `command/args/env`, remote `url/headers`); unknown entry shapes
//!   and unknown fields of known entries are preserved read-only. No
//!   per-entry enabled/disabled key is verified, so disabling removes the
//!   native entry while the Cliora definition survives.
//! * **Skills**: brand root `~/.cline/skills` plus the open-standard
//!   project `.agents/skills` directory the CLI also reads.
//! * **History** (see `history`): `~/.cline/data/sessions/<id>/` with the
//!   zod-v1 manifest `<id>.json`, the array file `<id>.messages.json`
//!   (`StoredMessageWithMetadata[]`, per-message optional
//!   `metrics{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,
//!   cost}` where input EXCLUDES cache), `<id>.compaction.json`, and
//!   subagent/team stems `<agentId>__<teamTaskId>.*` in the same directory;
//!   the session index is the SQLite `~/.cline/data/db/sessions.db`
//!   (`sessions` table with `metadata_json` usage aggregates).
//! * **Agents/plugins/official quota**: no verified contract, absent by
//!   design.

pub mod history;

use std::env;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::{
    file, AdapterDescriptor, CliAdapter, Facet, InspectionFields, LaunchMode, ManagementCapabilities,
    McpLocation, RuleSupport,
};
use crate::native::adapter::{NativeFile, Scope};
use crate::native::apply::NativeSecrets;
use crate::native::format::FileKind;
use crate::native::profile::{Connection, RegisteredProfile};
use crate::resources::mcp::{self, McpDefinition, McpTransport};

pub struct Cline;

/// Config root: `~/.cline`, relocated by `CLINE_DIR`. Only the real user home
/// honors the override so tests with an isolated home cannot redirect reads.
pub(crate) fn config_dir(home: &Path) -> PathBuf {
    crate::accounts::selection::config_root("cline", || {
        if dirs::home_dir().as_deref() == Some(home) {
            if let Some(root) = env::var_os("CLINE_DIR") {
                let path = PathBuf::from(root);
                if path.is_absolute() {
                    return path;
                }
            }
        }
        home.join(".cline")
    })
}

/// Data root: `~/.cline/data`, relocated by `CLINE_DATA_DIR` (same
/// real-home-only rule).
pub(crate) fn data_root(home: &Path) -> PathBuf {
    crate::accounts::selection::history_root("cline", || {
        if dirs::home_dir().as_deref() == Some(home) {
            if let Some(root) = env::var_os("CLINE_DATA_DIR") {
                let path = PathBuf::from(root);
                if path.is_absolute() {
                    return path;
                }
            }
        }
        home.join(".cline").join("data")
    })
}

/// The SQLite session index of the data root.
pub(crate) fn sessions_db(home: &Path) -> PathBuf {
    data_root(home).join("db").join("sessions.db")
}

impl CliAdapter for Cline {
    fn id(&self) -> &'static str {
        "cline"
    }
    fn name(&self) -> &'static str {
        "Cline"
    }
    fn command(&self) -> &'static str {
        "cline"
    }
    fn npm_package(&self) -> &'static str {
        "cline"
    }
    fn supports_mcp(&self) -> bool {
        true
    }
    fn supports_skills(&self) -> bool {
        true
    }
    /// No verified `--version` transcript exists yet; identity only accepts the
    /// documented command name with a self-named or bare semver response.
    fn version_identity(&self, basename: &str, output: &str) -> bool {
        (basename == "cline" || basename.starts_with("cline-"))
            && (output.contains("cline")
                || semver::Version::parse(output.trim().trim_start_matches('v')).is_ok())
    }
    fn native_files(
        &self,
        scope: Scope,
        home: &Path,
        _project: Option<&Path>,
        known: bool,
    ) -> Vec<NativeFile> {
        if scope != Scope::Global {
            return Vec::new();
        }
        vec![file(
            "settings",
            config_dir(home).join("global-settings.json"),
            FileKind::Json,
            known,
            Some("Cline 全局设置；providers.json 含明文密钥，绝不进入管理面；项目 .cline 未核验不接管"),
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
            Err("Cline 不支持此原生文件角色".into())
        }
    }
    fn mcp_location(
        &self,
        scope: Scope,
        home: &Path,
        _project: Option<&Path>,
    ) -> Option<McpLocation> {
        // [src] pins the global file and its top-level mcpServers key; a
        // project-level MCP file is not verified and stays undelivered.
        if scope != Scope::Global {
            return None;
        }
        Some(McpLocation {
            path: config_dir(home).join("cline_mcp_settings.json"),
            kind: FileKind::Json,
            root: "mcpServers",
            child: None,
        })
    }
    fn mcp_disabled_description(&self) -> Option<&'static str> {
        Some("停用会移除原生条目（条目内部停用键未取证），Cliora 中的定义仍保留")
    }
    fn mcp_document(
        &self,
        definition: &McpDefinition,
        enabled: bool,
        existing: Option<&Value>,
    ) -> Result<Option<Value>, String> {
        // Conservative shape: only the generic stdio command/args/env and
        // remote url/headers fields are written; unknown fields of an existing
        // entry (autoApprove/timeout/...) are preserved untouched. No enabled
        // or disabled key is invented, so disabling removes the entry.
        if !enabled {
            return Ok(None);
        }
        let map = match definition.transport {
            McpTransport::Stdio => mcp::stdio_doc(definition, existing),
            McpTransport::Http => mcp::http_doc(definition, existing, "headers"),
        };
        Ok(Some(Value::Object(map)))
    }
    fn skill_root(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<PathBuf> {
        Some(match scope {
            // Brand root plus the open-standard .agents/skills the CLI reads.
            Scope::Global => config_dir(home).join("skills"),
            Scope::Project => project?.join(".agents").join("skills"),
        })
    }
    /// Cline has no verified env-var credential channel; the default synthetic
    /// name would promise a variable the CLI ignores.
    fn auth_env_name(&self, _connection: &Connection) -> Option<String> {
        None
    }
    fn connection_policy(&self, _scope: Scope) -> crate::native::adapter::ConnectionPolicy {
        crate::native::adapter::ConnectionPolicy {
            api_key: crate::native::adapter::api_key_unsupported(
                "Cline 密钥存于系统 keychain 与明文 providers.json，Cliora 绝不写入",
            ),
            provider_address: crate::native::adapter::address_unsupported(
                "Cline 连接与凭据由产品登录态（keychain 与 providers.json）保管，Cliora 不接管",
            ),
            projection: "single_connection",
        }
    }
    fn connection_documents(
        &self,
        _connection: &Connection,
        _scope: Scope,
    ) -> Result<std::collections::BTreeMap<String, Value>, String> {
        Err("Cline 连接与凭据由产品登录态（keychain 与 providers.json）保管，Cliora 不接管".into())
    }
    fn write_connection_secret(
        &self,
        _profile: &RegisteredProfile,
        _scope: Scope,
        _credentials: &dyn crate::credentials::CredentialStore,
        _secrets: &mut NativeSecrets,
    ) -> Result<(), String> {
        Err("Cline 密钥存于系统 keychain 与明文 providers.json，Cliora 绝不写入".into())
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
        // The global-settings.json field inventory is not pinned by source
        // evidence; nothing is inferred from unknown shapes.
        InspectionFields::default()
    }
    fn launch_args(
        &self,
        session: Option<&str>,
        mode: LaunchMode,
    ) -> Result<Vec<String>, String> {
        if matches!(mode, LaunchMode::Yolo) {
            return Err("Cline 未验证跳过权限旗标，仅支持普通启动".into());
        }
        let mut args = Vec::new();
        if let Some(id) = session {
            args.extend(["--id".into(), id.into()]);
        }
        Ok(args)
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
        // Schema evidence covers 3.0.x; allow ordinary movement inside 3.
        version.trim().trim_start_matches('v').starts_with("3.")
    }
    fn minimum_node_version(&self) -> Option<(u32, u32, u32)> {
        Some((22, 0, 0))
    }
    fn node_dependency_detail(&self) -> &'static str {
        "官方 npm 包 cline 3.0.x 要求 Node.js 22+"
    }
    fn install_guidance(&self) -> (&'static str, &'static str) {
        (
            "https://github.com/cline/cline",
            "Cline CLI 通过官方 npm 包 cline 安装（Node.js 22+）；MCP 与 Skills 由原生路径提供，providers.json 密钥不接管。",
        )
    }
    fn install_command(&self) -> Option<String> {
        self.npm_install_command()
    }
    fn descriptor(&self) -> AdapterDescriptor {
        AdapterDescriptor {
            id: self.id(),
            configuration: None,
            name: self.name(),
            interface_formats: self.interface_formats(),
            project_model_override: false,
            yolo_available: false,
            launch_form: self.launch_form(),
            native_config: Facet {
                state: "available",
                reason: "可编辑用户级 ~/.cline/global-settings.json；providers.json 含明文密钥，绝不进入管理面",
            },
            launch: Facet {
                state: "available",
                reason: "以所选工作目录在外部终端启动 cline；未验证跳过权限旗标，仅普通模式",
            },
            resume: Facet {
                state: "available",
                reason: "可用原生会话 ID 以 cline --id 在外部终端恢复；索引来自 sessions.db 与 sessions/<id>/ 清单",
            },
            resources: Facet {
                state: "available",
                reason: "MCP（cline_mcp_settings.json 顶层 mcpServers，条目内部形状保守解析、未知字段保留）、Skills（~/.cline/skills 与项目 .agents/skills 开放标准）由原生路径提供；自定义子代理无契约",
            },
            history: Facet {
                state: "available",
                reason: "只读索引 sessions/<id>/（zod v1 清单+messages.json 逐条 metrics+compaction+子代理 __ 词干）与 sessions.db 会话表；input 不含 cache，缓存读写显式分列",
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
    use crate::native::adapter::Scope;
    use crate::resources::mcp::McpTransport;
    use serde_json::json;

    const NATIVE_FIXTURE: &str =
        include_str!("../../../../tests/fixtures/native/cline-3.0.json");

    #[test]
    fn identity_accepts_only_the_official_command_name() {
        assert!(Cline.version_identity("cline", "3.0.69"));
        assert!(Cline.version_identity("cline", "cline/3.0.69"));
        assert!(Cline.version_identity("cline-3.0.69", "3.0.69\n"));
        assert!(!Cline.version_identity("cline", "claude 2.1.283"));
        assert!(!Cline.version_identity("decliner", "3.0.69"));
        assert!(Cline.history_resume_version_supported("3.0.69"));
        assert!(Cline.history_resume_version_supported("v3.1.0"));
        assert!(!Cline.history_resume_version_supported("2.9.9"));
        assert!(!Cline.history_resume_version_supported("4.0.0"));
    }

    #[test]
    fn native_files_map_the_managed_settings_and_keep_secrets_out() {
        let home = Path::new("/home/example");
        let global = Cline.native_files(Scope::Global, home, None, true);
        assert_eq!(global.len(), 1);
        assert_eq!(global[0].role, "settings");
        assert_eq!(global[0].format, "json");
        assert!(global[0]
            .path
            .replace('\\', "/")
            .ends_with(".cline/global-settings.json"));
        assert!(global[0].writable, "已确认身份后 global-settings.json 可编辑");
        // Plaintext account keys never enter the managed surface; the project
        // mirror is unverified and stays with the product.
        assert!(global.iter().all(|item| !item.path.contains("providers.json")));
        assert!(Cline
            .native_files(Scope::Project, home, Some(Path::new("/work/p")), true)
            .is_empty());
        assert_eq!(Cline.file_kind("settings").unwrap(), FileKind::Json);
        assert!(Cline.file_kind("providers").is_err());
        assert_eq!(Cline.minimum_node_version(), Some((22, 0, 0)));
    }

    #[test]
    fn native_fixture_parses_conservatively_and_carries_no_secret_material() {
        let parsed = crate::native::format::parse(FileKind::Json, NATIVE_FIXTURE).unwrap();
        assert!(parsed.is_object(), "cline_mcp_settings.json 须为 JSON 对象");
        // No sanitized fixture may carry credential-shaped keys: token values
        // must never reach any IPC, log or test output.
        fn assert_no_secrets(value: &Value) {
            match value {
                Value::Object(map) => {
                    for (key, item) in map {
                        let lower = key.to_ascii_lowercase();
                        assert!(
                            !["apikey", "token", "secret", "password", "authorization"]
                                .iter()
                                .any(|word| lower.contains(word)),
                            "fixture 字段名 {key} 不得携带凭据语义"
                        );
                        assert_no_secrets(item);
                    }
                }
                Value::Array(items) => items.iter().for_each(assert_no_secrets),
                _ => {}
            }
        }
        assert_no_secrets(&parsed);
        // Unknown global-settings field inventory: inspection infers nothing.
        let inspection = Cline.inspect_values(&parsed, &Value::Null, &Value::Null);
        assert_eq!(inspection.provider, None);
        assert_eq!(inspection.model, None);
    }

    #[test]
    fn mcp_location_targets_the_documented_top_level_key() {
        let temp = tempfile::tempdir().unwrap();
        let location = Cline.mcp_location(Scope::Global, temp.path(), None).unwrap();
        assert!(location
            .path
            .to_string_lossy()
            .replace('\\', "/")
            .ends_with(".cline/cline_mcp_settings.json"));
        assert_eq!(location.root, "mcpServers");
        assert_eq!(location.child, None);
        assert!(Cline
            .mcp_location(Scope::Project, temp.path(), Some(Path::new("/work/p")),)
            .is_none(), "项目级 MCP 文件未取证，不交付");
        // Conservative parsing of the sanitized fixture: known stdio/remote
        // fields are read, unknown entry shapes are preserved verbatim.
        let parsed = crate::native::format::parse(FileKind::Json, NATIVE_FIXTURE).unwrap();
        let entries = Cline.mcp_entries(&parsed, &location).unwrap();
        assert_eq!(entries.len(), 3, "{entries:?}");
        assert_eq!(entries["example-local"]["command"], "npx");
        assert_eq!(entries["example-local"]["args"], json!(["-y", "example-mcp"]));
        assert_eq!(
            entries["example-local"]["env"]["EXAMPLE_MODE"], "fixture",
            "未知字段 autoApprove/timeout 原样保留"
        );
        assert_eq!(
            entries["unverified-shape"]["transport"]["kind"], "stdio",
            "未取证形状只读保留，不猜测"
        );
    }

    #[test]
    fn mcp_documents_write_only_the_generic_shape_and_preserve_unknown_fields() {
        let definition = McpDefinition {
            id: "fixture-definition".into(),
            name: "example".into(),
            transport: McpTransport::Stdio,
            command: "fixture-runner".into(),
            args: vec!["-y".into(), "example-mcp".into()],
            url: String::new(),
            env: std::collections::BTreeMap::from([("EXAMPLE_MODE".into(), "fixture".into())]),
            headers: std::collections::BTreeMap::new(),
            in_library: true,
            version: 0,
        };
        let existing = json!({ "autoApprove": ["tool"], "timeout": 5000 });
        let local = Cline
            .mcp_document(&definition, true, Some(&existing))
            .unwrap()
            .unwrap();
        assert_eq!(local["command"], "fixture-runner");
        assert_eq!(local["args"], json!(["-y", "example-mcp"]));
        assert_eq!(local["env"]["EXAMPLE_MODE"], "fixture");
        assert_eq!(local["autoApprove"], json!(["tool"]), "未知字段保留");
        assert_eq!(local["timeout"], 5000, "未知字段保留");
        assert!(
            local.get("disabled").is_none() && local.get("enabled").is_none(),
            "停用键未取证，不得虚构"
        );
        // Disabling removes the native entry; the definition survives.
        assert!(Cline.mcp_document(&definition, false, None).unwrap().is_none());
        assert_eq!(
            Cline.mcp_disabled_description().unwrap(),
            "停用会移除原生条目（条目内部停用键未取证），Cliora 中的定义仍保留"
        );
        let remote_definition = McpDefinition {
            transport: McpTransport::Http,
            url: "https://mcp.example.com/sse".into(),
            headers: std::collections::BTreeMap::from([("X-Example".into(), "1".into())]),
            ..definition
        };
        let remote = Cline
            .mcp_document(&remote_definition, true, None)
            .unwrap()
            .unwrap();
        assert_eq!(remote["url"], "https://mcp.example.com/sse");
        assert_eq!(remote["headers"]["X-Example"], "1");
        assert!(remote.get("command").is_none());
    }

    #[test]
    fn resource_roots_follow_the_brand_and_open_standard_skills() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        assert_eq!(
            Cline.skill_root(Scope::Global, temp.path(), None).unwrap(),
            config_dir(temp.path()).join("skills")
        );
        assert_eq!(
            Cline
                .skill_root(Scope::Project, temp.path(), Some(&project))
                .unwrap(),
            project.join(".agents/skills")
        );
    }

    #[test]
    fn launch_args_cover_normal_and_id_resume_only() {
        assert!(Cline
            .launch_args(None, LaunchMode::Normal)
            .unwrap()
            .is_empty());
        assert_eq!(
            Cline
                .launch_args(Some("ses_2026_10_07_1042_a1b2c3d4"), LaunchMode::Normal)
                .unwrap(),
            vec!["--id", "ses_2026_10_07_1042_a1b2c3d4"]
        );
        assert!(Cline.launch_args(None, LaunchMode::Yolo).is_err());
        assert!(Cline
            .launch_args(Some("ses_2026_10_07_1042_a1b2c3d4"), LaunchMode::Yolo)
            .is_err());
    }

    fn connection() -> Connection {
        Connection {
            provider_id: "anthropic".into(),
            interface_format: "anthropic_messages".into(),
            base_url: "https://api.example.com".into(),
            model: "demo-model".into(),
            secret_ref: None,
            auth_env_var: None,
            model_records: Vec::new(),
        }
    }

    #[test]
    fn credential_surface_stays_closed_and_honest() {
        // No managed credential port: providers.json keys are plaintext and
        // product-owned; nothing is adopted, echoed or written.
        assert!(Cline
            .connection_documents(&connection(), Scope::Global)
            .is_err());
        assert!(Cline.accounts().is_none());
        assert!(Cline.official_usage().is_none());
        assert!(Cline.plugins().is_none());
        assert!(Cline.agents().is_none());
        assert!(!Cline.has_native_secret("settings", &json!({"apiKey": "x"})));
        assert_eq!(Cline.auth_env_name(&connection()), None);
        assert!(Cline.descriptor().login.is_none());
    }

    #[test]
    fn delivered_dimensions_declare_only_verified_ports() {
        assert!(Cline.history_supported());
        assert!(Cline.supports_mcp());
        assert!(Cline.supports_skills());
        assert!(Cline.configuration().is_none());
        let descriptor = Cline.descriptor();
        for (facet, dimension) in [
            (&descriptor.native_config, "native_config"),
            (&descriptor.launch, "launch"),
            (&descriptor.resume, "resume"),
            (&descriptor.resources, "resources"),
            (&descriptor.history, "history"),
        ] {
            assert_eq!(facet.state, "available", "cline 的 {dimension}");
            assert!(!facet.reason.trim().is_empty());
        }
        assert_eq!(descriptor.launch_form, LaunchForm::Terminal);
        assert!(!descriptor.yolo_available);
        assert!(descriptor.management.mcp && descriptor.management.skills);
        assert!(!descriptor.management.accounts);
        assert!(!descriptor.management.agents);
        assert!(!descriptor.management.plugins);
        assert!(!descriptor.management.rules.global && !descriptor.management.rules.project);
        assert!(descriptor.login.is_none());
        assert!(descriptor.configuration.is_none());
    }
}
