//! Devin CLI (Cognition, `devin`) adapter.
//!
//! Registered default-off through the non-enumerated stable id `devin`.
//! Delivered dimensions and their evidence (local install 3000.11.3, official
//! docs + `--help` transcripts + structure-only inspection of the real config
//! layout and transcripts on this machine):
//!
//! * **Paths**: config root `%APPDATA%\devin` (`dirs::config_dir()`; the CLI
//!   resolves the known-folder path and ignores `APPDATA` env overrides, so no
//!   env override is honored here either). Project config lives in
//!   `.devin/config.json`.
//! * **Configuration**: global `config.json` is JSONC-content under a `.json`
//!   name (verified keys: `version`, `devin{org_id}`, `shell`, `theme_mode`,
//!   `agent{model,preferred_family_models}`; `permissions`/`sandbox`/`proxy`/
//!   `subagents_enabled` are documented keys absent from the inspected file).
//!   The project `.devin/config.json` plays the secondary role only.
//! * **Launch/resume** (`devin --help`): interactive `devin`; `-c/--continue`
//!   the most recent conversation, `-r/--resume <SESSION_ID>` a specific one;
//!   `--permission-mode dangerous` auto-approves all tools and is mapped to
//!   the shared Yolo launch mode.
//! * **MCP** (`devin mcp add --scope user …` probe, isolated native state
//!   restored afterwards): `%APPDATA%\devin\mcp_config.json` with a top-level
//!   `mcpServers` map since v3000.3 (migrated out of config.json). Stdio
//!   entries are `{command, args[], env{}, transport:"stdio"}`, HTTP entries
//!   `{url, headers{}, transport:"http"|"sse"}`; `devin mcp disable` writes
//!   `"disabled": true` in place. Project scope mirrors
//!   `.devin/mcp_config.json` (plus a gitignored `.local` variant that stays
//!   with the product).
//! * **History**: read-only index of the ATIF-v1.7 transcripts under
//!   `cli/transcripts/<slug>.json` (see `history`); the slug is the session id
//!   `--resume` accepts. The transcript has no cwd; `cli/sessions.db`
//!   `sessions.working_directory` supplies it (those two columns only).
//! * **Usage**: delivered (devin-usage 2026-10-08). Each agent step's
//!   `metrics{prompt_tokens, completion_tokens, cached_tokens}` becomes one
//!   inclusive-bucket usage event — `prompt_tokens` is the full step context
//!   and includes `cached_tokens` (verified against all 8 real local
//!   transcripts: step N+1's cached equals step N's prompt and Σ per session
//!   matches `final_metrics` exactly); `metrics.extra
//!   .cache_creation_input_tokens` (3/8 files) maps to `cache_write`.
//! * **Skills** (docs.devin.ai CLI skills overview): global
//!   `%APPDATA%\devin\skills/<name>/SKILL.md` (`~/.config/devin/skills` off
//!   Windows) and project `.devin/skills/<name>/SKILL.md`. The CLI also reads
//!   `.agents/skills`, `.windsurf/skills`, `~/.agents/skills`, and
//!   `~/.codeium/<channel>/skills`; those stay with the product. Only the two
//!   brand roots are managed here.
//! * **Credentials**: `credentials.toml` is the product-owned credential store
//!   and is NEVER read or written; no managed credential port, no accounts
//!   port, and no credential file appears in `native_files`. Agents have no
//!   separate directory contract and stay undelivered.

pub(crate) mod history;

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::{
    file, project_root, AdapterDescriptor, CliAdapter, Facet, InspectionFields, LaunchMode,
    ManagementCapabilities, RuleSupport,
};
use crate::credentials::CredentialStore;
use crate::native::adapter::{NativeFile, Scope};
use crate::native::apply::NativeSecrets;
use crate::native::format::FileKind;
use crate::native::profile::{Connection, RegisteredProfile};
use crate::resources::mcp::{self, McpDefinition, McpTransport};

pub struct Devin;

/// Devin keeps its config under the OS config directory (`%APPDATA%\devin` on
/// Windows); tests with a synthetic home fall back to the conventional layout.
/// The native binary resolves the known-folder path itself and ignores
/// `APPDATA` overrides, so no env override is honored for the real home.
pub(crate) fn config_root(home: &Path) -> PathBuf {
    if dirs::home_dir().as_deref() == Some(home) {
        if let Some(dir) = dirs::config_dir() {
            return dir.join("devin");
        }
    }
    home.join(if cfg!(windows) {
        "AppData/Roaming/devin"
    } else {
        ".config/devin"
    })
}

impl CliAdapter for Devin {
    fn id(&self) -> &'static str {
        "devin"
    }
    fn name(&self) -> &'static str {
        "Devin"
    }
    fn command(&self) -> &'static str {
        "devin"
    }
    fn npm_package(&self) -> &'static str {
        ""
    }
    fn latest_version_url(&self) -> Option<String> {
        // Official setup.sh / setup.ps1 use this promoted public channel.
        Some("https://static.devin.ai/cli/current/manifest.json".into())
    }
    /// No verified `--version` transcript exists yet; identity only accepts the
    /// documented command name with a self-named or bare semver response.
    fn version_identity(&self, basename: &str, output: &str) -> bool {
        (basename == "devin" || basename.starts_with("devin-"))
            && (output.contains("devin")
                || semver::Version::parse(output.trim().trim_start_matches('v')).is_ok())
    }
    /// Self-updating standalone installer; no npm shim resolves this CLI.
    fn extra_binary_candidates(&self, home: &Path) -> Vec<PathBuf> {
        if cfg!(windows) {
            vec![home.join("AppData/Local/devin/cli/bin/devin.exe")]
        } else {
            Vec::new()
        }
    }
    fn native_binary_directories(&self, home: &Path) -> Vec<PathBuf> {
        if cfg!(windows) {
            vec![home.join("AppData/Local/devin/cli/bin")]
        } else {
            Vec::new()
        }
    }
    fn recognizes_native_install_path(&self, path: &Path) -> bool {
        cfg!(windows)
            && path
                .parent()
                .is_some_and(|parent| parent.ends_with("devin/cli/bin"))
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
            // Secondary role only: the project file keeps workspace-local
            // preferences; MCP has its own project file via mcp_location.
            Some(root) => vec![file(
                "settings",
                root.join(".devin").join("config.json"),
                FileKind::Jsonc,
                known,
                Some("Devin 项目级配置（JSONC，次要角色）；credentials.toml 为产品凭据存储，绝不读写"),
                false,
            )],
            None => vec![file(
                "settings",
                config_root(home).join("config.json"),
                FileKind::Jsonc,
                known,
                Some("Devin CLI 全局配置（JSONC 内容，.json 名）；credentials.toml 为产品凭据存储，绝不读写"),
                false,
            )],
        }
    }
    fn interface_formats(&self) -> &'static [&'static str] {
        &[]
    }
    fn file_kind(&self, role: &str) -> Result<FileKind, String> {
        if role == "settings" {
            Ok(FileKind::Jsonc)
        } else {
            Err("Devin 不支持此原生配置文件角色".into())
        }
    }
    fn portable_root_fields(&self, role: &str) -> &'static [&'static str] {
        // `devin{org_id}` is account-scoped and `version` is a schema marker;
        // both stay out of portable data.
        if role == "settings" {
            &["agent", "permissions", "sandbox", "proxy", "subagents_enabled"]
        } else {
            &[]
        }
    }
    fn connection_policy(&self, _scope: Scope) -> crate::native::adapter::ConnectionPolicy {
        crate::native::adapter::ConnectionPolicy {
            api_key: crate::native::adapter::api_key_unsupported(
                "Devin 无托管连接通道：登录凭据由 credentials.toml 保管，Cliora 绝不读写",
            ),
            provider_address: crate::native::adapter::address_unsupported(
                "Devin 固定走官方服务，config.json 无文档化的供应商连接字段",
            ),
            projection: "single_connection",
        }
    }
    fn connection_documents(
        &self,
        _connection: &Connection,
        _scope: Scope,
    ) -> Result<std::collections::BTreeMap<String, Value>, String> {
        Err("Devin 无托管连接通道：登录凭据由 credentials.toml 保管，Cliora 绝不读写".into())
    }
    fn write_connection_secret(
        &self,
        _profile: &RegisteredProfile,
        _scope: Scope,
        _credentials: &dyn CredentialStore,
        _secrets: &mut NativeSecrets,
    ) -> Result<(), String> {
        Err("Devin 凭据由 credentials.toml 保管，Cliora 绝不读写".into())
    }
    fn has_native_secret(&self, _role: &str, _root: &Value) -> bool {
        false
    }
    fn inspect_values(
        &self,
        settings: &Value,
        _local_settings: &Value,
        _models: &Value,
    ) -> InspectionFields {
        // Verified shape: agent.model names the selected model family variant.
        InspectionFields {
            model: settings
                .get("agent")
                .and_then(|agent| agent.get("model"))
                .and_then(Value::as_str)
                .filter(|model| !model.is_empty())
                .map(str::to_owned),
            ..InspectionFields::default()
        }
    }
    fn launch_args(
        &self,
        session: Option<&str>,
        mode: LaunchMode,
    ) -> Result<Vec<String>, String> {
        let mut args = Vec::new();
        if let Some(id) = session {
            args.extend(["--resume".into(), id.into()]);
        }
        if matches!(mode, LaunchMode::Yolo) {
            // `--permission-mode dangerous` auto-approves all tools
            // (devin --help, five documented modes).
            args.push("--permission-mode".into());
            args.push("dangerous".into());
        }
        Ok(args)
    }
    fn node_required_when_missing(&self) -> bool {
        // The official installer ships a standalone self-updating binary.
        false
    }
    fn supports_mcp(&self) -> bool {
        true
    }
    fn mcp_location(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<super::McpLocation> {
        let path = match scope {
            Scope::Global => config_root(home).join("mcp_config.json"),
            // Project scope; the gitignored `.local` variant stays with the
            // product (`devin mcp add --scope local`).
            Scope::Project => project?.join(".devin").join("mcp_config.json"),
        };
        Some(super::McpLocation {
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
        // Shapes pinned by `devin mcp add/disable` output on 3000.11.3:
        // stdio {command, args[], env{}, transport:"stdio"},
        // remote {url, headers{}, transport:"http"}, disabled in place via
        // `"disabled": true` (devin mcp enable removes the flag again).
        let mut map = match definition.transport {
            McpTransport::Stdio => {
                let mut map = mcp::stdio_doc(definition, existing);
                map.insert("transport".into(), json!("stdio"));
                map
            }
            McpTransport::Http => {
                let mut map = mcp::http_doc(definition, existing, "headers");
                map.insert("transport".into(), json!("http"));
                map
            }
        };
        if enabled {
            map.remove("disabled");
        } else {
            map.insert("disabled".into(), json!(true));
        }
        Ok(Some(Value::Object(map)))
    }
    fn mcp_disabled_description(&self) -> Option<&'static str> {
        Some("停用会按 devin mcp disable 写入 disabled 标记，Cliora 中的定义仍保留")
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
            // Official global root: %APPDATA%\devin\skills, or
            // ~/.config/devin/skills when the home is not the real profile.
            Scope::Global => config_root(home).join("skills"),
            Scope::Project => project?.join(".devin").join("skills"),
        })
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
        // Transcript/CLI evidence covers 3000.x; allow ordinary movement inside
        // the 3000 major line only.
        semver::Version::parse(version.trim().trim_start_matches('v'))
            .is_ok_and(|version| version.major == 3000)
    }
    fn install_guidance(&self) -> (&'static str, &'static str) {
        (
            "https://devin.ai",
            "Devin CLI 经官方 setup.ps1/install.sh 安装并自更新（AppData\\Local\\devin\\cli\\bin）；登录由 devin auth login 原生完成，Cliora 不接管凭据。",
        )
    }
    fn install_command(&self) -> Option<String> {
        None
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
                reason: "已确认 CLI 身份，可编辑用户级 config.json（JSONC 内容）；项目 .devin/config.json 为次要角色",
            },
            launch: Facet {
                state: "available",
                reason: "以所选工作目录在外部终端启动 devin；Yolo 即 --permission-mode dangerous（自动批准全部工具）",
            },
            resume: Facet {
                state: "available",
                reason: "可用原生会话 slug 以 --resume <id> 恢复（-c 继续最近会话）；工作目录来自 cli/sessions.db 的 working_directory",
            },
            resources: Facet {
                state: "available",
                reason: "MCP 由 %APPDATA%/devin/mcp_config.json（mcpServers，stdio/http + disabled 标记）提供；Skills 写入 %APPDATA%/devin/skills 与项目 .devin/skills（SKILL.md）。.agents/skills、.windsurf/skills、~/.agents/skills 与 ~/.codeium/<channel>/skills 由 CLI 另读，不在此代管；Agents 无独立目录契约暂不交付",
            },
            history: Facet {
                state: "available",
                reason: "只读索引 cli/transcripts ATIF-v1.7 transcript（会话身份/模型/消息/时间）；工作目录只读 sessions.working_directory，消息与凭据不读；用量已交付：逐 agent step metrics{prompt_tokens(含 cached_tokens),completion_tokens,cached_tokens} 按含缓存口径入账，extra.cache_creation_input_tokens 计 cache_write，8 个本机真实 transcript 与 final_metrics 总计逐一对账一致",
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
    use std::collections::BTreeMap;

    const NATIVE_FIXTURE: &str =
        include_str!("../../../../tests/fixtures/native/devin-3000.json");
    const MCP_SAMPLE: &str = r#"{
  "mcpServers": {
    "example-stdio": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "example-mcp"],
      "env": { "EXAMPLE_MODE": "fixture" },
      "transport": "stdio"
    },
    "example-remote": {
      "url": "https://mcp.example.com/sse",
      "transport": "http",
      "disabled": true
    }
  }
}"#;

    #[test]
    fn identity_accepts_only_the_official_command_name() {
        assert!(Devin.version_identity("devin", "3000.11.3"));
        assert!(Devin.version_identity("devin", "devin 3000.11.3"));
        assert!(!Devin.version_identity("devin", "claude 2.1.283"));
        assert!(!Devin.version_identity("other", "3000.11.3"));
        assert!(Devin.history_resume_version_supported("3000.11.3"));
        assert!(Devin.history_resume_version_supported("3000.12.0"));
        assert!(!Devin.history_resume_version_supported("3001.0.0"));
        assert!(!Devin.history_resume_version_supported("2999.9.9"));
        assert!(!Devin.node_required_when_missing());
        assert_eq!(Devin.install_command(), None);
    }

    #[test]
    fn native_files_map_global_and_project_config_without_credentials() {
        let home = Path::new("/home/example");
        let global = Devin.native_files(Scope::Global, home, None, true);
        assert_eq!(global.len(), 1);
        assert_eq!(global[0].role, "settings");
        assert_eq!(global[0].format, "jsonc");
        assert!(
            global[0]
                .path
                .replace('\\', "/")
                .ends_with("devin/config.json")
        );
        let project = Devin.native_files(Scope::Project, home, Some(Path::new("/work/p")), true);
        assert_eq!(project.len(), 1);
        assert_eq!(project[0].role, "settings");
        assert!(
            project[0]
                .path
                .replace('\\', "/")
                .ends_with("/work/p/.devin/config.json")
        );
        // The product credential store never enters the managed surface.
        for item in global.iter().chain(project.iter()) {
            assert!(!item.path.contains("credentials"));
        }
        assert_eq!(Devin.file_kind("settings").unwrap(), FileKind::Jsonc);
        assert!(Devin.file_kind("credentials").is_err());
        assert!(Devin
            .portable_root_fields("settings")
            .contains(&"agent"));
        // Self-update layout outside PATH (Windows evidence only).
        if cfg!(windows) {
            assert_eq!(
                Devin.native_binary_directories(home),
                vec![PathBuf::from("/home/example/AppData/Local/devin/cli/bin")]
            );
        }
    }

    #[test]
    fn jsonc_fixture_parses_and_inspects_the_selected_model() {
        let parsed = crate::native::format::parse(FileKind::Jsonc, NATIVE_FIXTURE).unwrap();
        let inspection = Devin.inspect_values(&parsed, &Value::Null, &Value::Null);
        assert_eq!(inspection.model.as_deref(), Some("example-opus-medium"));
        assert_eq!(inspection.provider, None);
        assert_eq!(inspection.base, None);
        assert_eq!(inspection.env, None);
        assert!(parsed.get("devin").is_some(), "账号绑定的 org_id 不进可移植字段");
    }

    #[test]
    fn launch_args_cover_normal_yolo_and_resume() {
        assert!(Devin
            .launch_args(None, LaunchMode::Normal)
            .unwrap()
            .is_empty());
        assert_eq!(
            Devin.launch_args(None, LaunchMode::Yolo).unwrap(),
            vec!["--permission-mode", "dangerous"]
        );
        assert_eq!(
            Devin.launch_args(Some("serene-example"), LaunchMode::Normal).unwrap(),
            vec!["--resume", "serene-example"]
        );
        assert_eq!(
            Devin.launch_args(Some("serene-example"), LaunchMode::Yolo).unwrap(),
            vec!["--resume", "serene-example", "--permission-mode", "dangerous"]
        );
        let descriptor = Devin.descriptor();
        assert_eq!(descriptor.launch_form, LaunchForm::Terminal);
        assert!(descriptor.yolo_available);
    }

    fn mcp_definition(transport: McpTransport) -> McpDefinition {
        McpDefinition {
            id: "fixture-definition".into(),
            name: "example".into(),
            transport,
            command: "fixture-runner".into(),
            args: vec!["-y".into(), "example-mcp".into()],
            url: "https://mcp.example.com/sse".into(),
            env: BTreeMap::from([("EXAMPLE_MODE".into(), "fixture".into())]),
            headers: BTreeMap::from([("X-Example".into(), "1".into())]),
            in_library: true,
            version: 0,
        }
    }

    #[test]
    fn mcp_entries_read_the_native_file_and_locations_follow_evidence() {
        let temp = tempfile::tempdir().unwrap();
        let location = Devin
            .mcp_location(Scope::Global, temp.path(), None)
            .unwrap();
        assert!(location
            .path
            .to_string_lossy()
            .replace('\\', "/")
            .ends_with("devin/mcp_config.json"));
        assert_eq!(location.kind, FileKind::Json);
        assert_eq!(location.root, "mcpServers");
        assert_eq!(location.child, None);
        std::fs::create_dir_all(location.path.parent().unwrap()).unwrap();
        std::fs::write(&location.path, MCP_SAMPLE).unwrap();
        let text = crate::native::transaction::read_native(&location.path).unwrap();
        let parsed = crate::native::format::parse(location.kind, &text).unwrap();
        let entries = Devin.mcp_entries(&parsed, &location).unwrap();
        assert_eq!(entries.len(), 2, "{entries:?}");
        assert_eq!(entries["example-stdio"]["transport"], "stdio");
        assert_eq!(
            entries["example-stdio"]["command"],
            json!("cmd")
        );
        assert_eq!(entries["example-stdio"]["env"]["EXAMPLE_MODE"], "fixture");
        assert_eq!(entries["example-remote"]["transport"], "http");
        assert_eq!(entries["example-remote"]["disabled"], true);
        let project = Devin
            .mcp_location(
                Scope::Project,
                temp.path(),
                Some(Path::new("/work/demo")),
            )
            .unwrap();
        assert!(project
            .path
            .to_string_lossy()
            .replace('\\', "/")
            .ends_with("/work/demo/.devin/mcp_config.json"));
    }

    #[test]
    fn mcp_documents_match_the_native_add_and_disable_shapes() {
        let stdio = Devin
            .mcp_document(&mcp_definition(McpTransport::Stdio), true, None)
            .unwrap()
            .unwrap();
        assert_eq!(stdio["transport"], "stdio");
        assert_eq!(stdio["command"], "fixture-runner");
        assert_eq!(stdio["args"], json!(["-y", "example-mcp"]));
        assert_eq!(stdio["env"]["EXAMPLE_MODE"], "fixture");
        assert!(stdio.get("disabled").is_none(), "启用时清除 disabled 标记");
        let remote = Devin
            .mcp_document(&mcp_definition(McpTransport::Http), false, None)
            .unwrap()
            .unwrap();
        assert_eq!(remote["transport"], "http");
        assert_eq!(remote["url"], "https://mcp.example.com/sse");
        assert_eq!(remote["headers"]["X-Example"], "1");
        assert_eq!(remote["disabled"], true, "停用按 devin mcp disable 原地置标记");
        // Re-enabling an existing disabled entry strips the flag.
        let existing = Some(&remote);
        let reenabled = Devin
            .mcp_document(&mcp_definition(McpTransport::Http), true, existing)
            .unwrap()
            .unwrap();
        assert!(reenabled.get("disabled").is_none());
        assert!(Devin.mcp_disabled_description().is_some());
    }

    #[test]
    fn skill_roots_follow_the_official_brand_directories() {
        let home = Path::new("/home/example");
        let global = Devin.skill_root(Scope::Global, home, None).unwrap();
        let global = global.to_string_lossy().replace('\\', "/");
        assert!(global.ends_with("devin/skills"), "{global}");
        assert!(!global.contains("codeium") && !global.contains(".agents"));
        let project = Devin
            .skill_root(Scope::Project, home, Some(Path::new("/work/p")))
            .unwrap();
        assert!(project
            .to_string_lossy()
            .replace('\\', "/")
            .ends_with("/work/p/.devin/skills"));
        assert!(Devin.skill_root(Scope::Project, home, None).is_none());
    }

    #[test]
    fn delivered_dimensions_stay_within_the_verified_surface() {
        assert!(Devin.history_supported());
        assert!(Devin.supports_mcp());
        // No managed credential port, no accounts port, no configuration port.
        // Agents stay undelivered; skills use the documented brand directories.
        assert!(Devin.configuration().is_none());
        assert!(Devin.supports_skills());
        assert!(Devin.agents().is_none());
        assert!(Devin.plugins().is_none());
        assert!(Devin.accounts().is_none());
        assert!(Devin.official_usage().is_none());
        assert!(Devin
            .connection_documents_for_existing(
                &Connection {
                    provider_id: String::new(),
                    interface_format: String::new(),
                    base_url: String::new(),
                    model: String::new(),
                    secret_ref: None,
                    auth_env_var: None,
                    model_records: Vec::new(),
                },
                Scope::Global,
                &BTreeMap::new(),
            )
            .is_err());
        assert!(Devin
            .write_connection_secret(
                &RegisteredProfile {
                    editing: None,
                    id: String::new(),
                    tool: "devin".into(),
                    name: String::new(),
                    version: 0,
                    revision: String::new(),
                    inherit_common: false,
                    files: BTreeMap::new(),
                    suppressed: BTreeMap::new(),
                    authentication: Default::default(),
                    connection: None,
                    native_credentials: BTreeMap::new(),
                },
                Scope::Global,
                &NoopStore,
                &mut NativeSecrets::default(),
            )
            .is_err());
    }

    struct NoopStore;
    impl CredentialStore for NoopStore {
        fn put(&self, _id: &str, _secret: &str) -> Result<(), String> {
            Ok(())
        }
        fn get(&self, id: &str) -> Result<String, String> {
            Err(format!("no secret {id}"))
        }
        fn delete(&self, _id: &str) -> Result<(), String> {
            Ok(())
        }
    }

    #[test]
    fn descriptor_states_available_dimensions_and_delivers_usage() {
        let descriptor = Devin.descriptor();
        for (facet, dimension) in [
            (&descriptor.native_config, "native_config"),
            (&descriptor.launch, "launch"),
            (&descriptor.resume, "resume"),
            (&descriptor.resources, "resources"),
            (&descriptor.history, "history"),
        ] {
            assert_eq!(facet.state, "available", "devin 的 {dimension}");
            assert!(!facet.reason.trim().is_empty());
        }
        // The devin-usage task flipped the usage dimension from
        // absence-with-reason to delivered with the verified semantics.
        assert!(descriptor.history.reason.contains("用量已交付"));
        assert!(descriptor.history.reason.contains("prompt_tokens"));
        assert!(!descriptor.history.reason.contains("未接入"));
        assert!(descriptor.management.mcp);
        assert!(descriptor.management.skills);
        assert!(descriptor.resources.reason.contains(".devin/skills"));
        assert!(!descriptor.management.agents);
        assert!(!descriptor.management.plugins);
        assert!(!descriptor.management.accounts);
        assert!(!descriptor.management.rules.global);
        assert!(!descriptor.management.rules.project);
        assert!(descriptor.login.is_none());
        assert!(descriptor.configuration.is_none());
    }
}
