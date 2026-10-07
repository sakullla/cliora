//! Antigravity CLI (Google, `agy`) adapter.
//!
//! Registered default-off through the non-enumerated stable id `antigravity`.
//! Version 1.3.1 verified on this machine via read-only probes
//! (`agy --version`, `agy --help`); the remaining storage evidence is
//! third-party reverse engineering ([RE], codeburn against agy 1.2.x — 02
//! ADR-2 evidence policy: strict degradation, never guessed fields):
//!
//! * **Paths**: config root `~/.gemini` — settings
//!   `antigravity-cli/settings.json` (plain JSON), MCP
//!   `config/mcp_config.json`, skills `antigravity-cli/skills/`; data root
//!   `~/.gemini/antigravity` — `conversation_summaries.db`,
//!   `conversations/<id>.db`, `brain/<id>/.system_generated/logs/
//!   transcript_full.jsonl` (see [`history`]).
//! * **Launch/resume** (`agy --help`, local 1.3.1): interactive `agy`;
//!   `--conversation <id>` resumes a previous conversation,
//!   `-c/--continue` the most recent one; `--dangerously-skip-permissions`
//!   auto-approves tool permission requests (the Yolo channel). The official
//!   install.ps1 places the binary at `%LOCALAPPDATA%\agy\bin`.
//! * **MCP** (`config/mcp_config.json`, present on this machine): top-level
//!   `mcpServers`; stdio entries use `command`/`args`/`env`/`cwd`, remote
//!   entries use `serverUrl` + `headers`/`oauth`. Legacy remote entries that
//!   still carry `url`/`httpUrl` keys are surfaced read-only and never
//!   rewritten — the current key spelling is not guessed for them.
//! * **Skills**: personal `antigravity-cli/skills/<dir>/SKILL.md` and the
//!   open-standard project `.agents/skills/`; only the two brand roots are
//!   managed here.
//! * **History/usage** ([RE], see [`history`] and [`protobuf`]): the
//!   conversation index, transcripts and per-conversation protobuf usage rows
//!   are read-only indexed; any schema drift skips the row and degrades the
//!   session to partial instead of guessing.
//! * **Credentials**: the OS-keyring browser login is never adopted or logged
//!   out. Only the documented headless env channel `GEMINI_API_KEY` may be
//!   managed: the value stays in the system credential store and is injected
//!   into the child process at launch time, never serialized to the frontend
//!   or written into `settings.json`.
//! * Agents/plugins/quota: no verified contract (subagent definition format
//!   not obtained; `agy plugin` exists but its storage is undocumented;
//!   `/usage` is a TUI subscription panel, not a local statistic) — those
//!   ports stay absent by design.

pub(crate) mod history;
pub(crate) mod protobuf;

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::{
    file, AdapterDescriptor, CliAdapter, Facet, InspectionFields, LaunchMode, ManagementCapabilities,
    McpLocation, RuleSupport,
};
use crate::native::adapter::{NativeFile, Scope};
use crate::native::format::FileKind;
use crate::resources::mcp::{self, McpDefinition, McpTransport};

/// The `~/.gemini` root shared by settings, MCP config, skills and the
/// conversation data tree.
fn gemini_root(home: &Path) -> PathBuf {
    crate::accounts::selection::config_root("antigravity", || home.join(".gemini"))
}

/// Conversation data root: `~/.gemini/antigravity` with
/// `conversation_summaries.db`, `conversations/` and `brain/`.
pub(crate) fn data_root(home: &Path) -> PathBuf {
    crate::accounts::selection::history_root("antigravity", || home.join(".gemini").join("antigravity"))
}

pub struct Antigravity;

impl CliAdapter for Antigravity {
    fn id(&self) -> &'static str {
        "antigravity"
    }
    fn name(&self) -> &'static str {
        "Antigravity"
    }
    fn command(&self) -> &'static str {
        "agy"
    }
    fn npm_package(&self) -> &'static str {
        ""
    }
    /// 1.3.1 verified locally; identity only accepts the documented command
    /// name with a self-named or bare semver response.
    fn version_identity(&self, basename: &str, output: &str) -> bool {
        (basename == "agy" || basename.starts_with("agy-"))
            && (output.contains("agy")
                || output.contains("antigravity")
                || semver::Version::parse(output.trim().trim_start_matches('v')).is_ok())
    }
    /// The official install.ps1 ships a standalone binary into
    /// `%LOCALAPPDATA%\agy\bin` (Windows) even when PATH registration is lost.
    fn native_binary_directories(&self, _home: &Path) -> Vec<PathBuf> {
        dirs::data_local_dir()
            .map(|root| root.join("agy").join("bin"))
            .into_iter()
            .collect()
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
            gemini_root(home)
                .join("antigravity-cli")
                .join("settings.json"),
            FileKind::Json,
            known,
            Some("Antigravity CLI（agy）设置（纯 JSON）；keyring 登录态不接管，headless 密钥经 GEMINI_API_KEY 注入"),
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
            Err("Antigravity 不支持此原生文件角色".into())
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
        let path = match scope {
            Scope::Global => gemini_root(home).join("config").join("mcp_config.json"),
            Scope::Project => project?.join(".agents").join("mcp_config.json"),
        };
        Some(McpLocation {
            path,
            kind: FileKind::Json,
            root: "mcpServers",
            child: None,
        })
    }
    fn mcp_entry_view(&self, entry: &Value) -> Value {
        // Remote entries spell the URL `serverUrl`; surface it through the
        // shared `url` view key without rewriting the native document.
        let Some(object) = entry.as_object() else {
            return entry.clone();
        };
        if let Some(server_url) = object.get("serverUrl").and_then(Value::as_str) {
            let mut view = object.clone();
            view.insert("url".into(), json!(server_url));
            return Value::Object(view);
        }
        entry.clone()
    }
    fn mcp_document(
        &self,
        definition: &McpDefinition,
        enabled: bool,
        existing: Option<&Value>,
    ) -> Result<Option<Value>, String> {
        // No documented per-entry enabled flag: disabling removes the native
        // entry while the Cliora definition stays for re-enabling.
        if !enabled {
            return Ok(None);
        }
        let legacy = existing.and_then(Value::as_object).is_some_and(|map| {
            map.get("url").is_some() || map.get("httpUrl").is_some()
        });
        if legacy {
            return Err(
                "该条目仍是旧版 url/httpUrl 拼写（现行键为 serverUrl）；为避免误写，此条目只读保留，请先在原生文件中确认或改名"
                    .into(),
            );
        }
        let map = match definition.transport {
            McpTransport::Stdio => {
                // stdio shape: command/args/env (+ preserved cwd and other
                // native keys the CLI owns).
                mcp::stdio_doc_with_env(definition, existing, "env")
            }
            McpTransport::Http => {
                // Remote shape: serverUrl + headers; the oauth/trust fields of
                // an existing entry stay untouched, and sensitive existing
                // headers keep their protected values through the shared
                // builder. The shared builder writes `url`, which this CLI
                // spells `serverUrl`.
                let mut map = mcp::http_doc(definition, existing, "headers");
                map.remove("url");
                map.insert("serverUrl".into(), json!(definition.url));
                map
            }
        };
        Ok(Some(Value::Object(map)))
    }
    fn mcp_disabled_description(&self) -> Option<&'static str> {
        Some("停用会移除原生条目，Cliora 中的定义仍保留")
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
            Scope::Global => gemini_root(home)
                .join("antigravity-cli")
                .join("skills"),
            Scope::Project => project?.join(".agents").join("skills"),
        })
    }
    /// The only documented headless credential channel is `GEMINI_API_KEY`
    /// (with `modelProvider: "gemini"`); a custom name would promise a
    /// variable the CLI ignores.
    fn auth_env_name(
        &self,
        connection: &crate::native::profile::Connection,
    ) -> Option<String> {
        if connection.auth_env_var.as_deref() == Some("GEMINI_API_KEY")
            || connection.secret_ref.is_some()
        {
            return Some("GEMINI_API_KEY".into());
        }
        None
    }
    fn connection_secret_via_launch_env(&self) -> bool {
        // settings.json never carries the key; the shared launch service
        // injects the headless GEMINI_API_KEY at spawn time.
        true
    }
    fn connection_documents(
        &self,
        _connection: &crate::native::profile::Connection,
        _scope: Scope,
    ) -> Result<std::collections::BTreeMap<String, Value>, String> {
        Err("Antigravity 连接编辑面暂不交付：settings.json 以原生 JSON 编辑，headless 密钥仅经 GEMINI_API_KEY 注入".into())
    }
    fn write_connection_secret(
        &self,
        _profile: &crate::native::profile::RegisteredProfile,
        _scope: Scope,
        _credentials: &dyn crate::credentials::CredentialStore,
        _secrets: &mut crate::native::apply::NativeSecrets,
    ) -> Result<(), String> {
        Err("Antigravity 不向 settings.json 写入密钥；headless GEMINI_API_KEY 只在启动时注入".into())
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
        let mut args = Vec::new();
        if let Some(id) = session {
            args.extend(["--conversation".into(), id.into()]);
        }
        if matches!(mode, LaunchMode::Yolo) {
            args.push("--dangerously-skip-permissions".into());
        }
        Ok(args)
    }
    fn node_required_when_missing(&self) -> bool {
        // The official installer ships a standalone binary.
        false
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
        // [RE] storage evidence covers agy 1.2.x and the local 1.3.1; allow
        // ordinary movement inside major 1, nothing beyond.
        semver::Version::parse(version.trim().trim_start_matches('v'))
            .is_ok_and(|version| version.major == 1)
    }
    fn install_guidance(&self) -> (&'static str, &'static str) {
        (
            "https://antigravity.google",
            "Antigravity CLI（agy）经官方 install.ps1 安装到 %LOCALAPPDATA%\\agy\\bin。",
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
                reason: "已确认 CLI 身份，可编辑 ~/.gemini/antigravity-cli/settings.json（纯 JSON）；keyring 登录态不接管",
            },
            launch: Facet {
                state: "available",
                reason: "以所选工作目录在外部终端启动 agy；--dangerously-skip-permissions 提供免确认通道",
            },
            resume: Facet {
                state: "available",
                reason: "可用原生会话 ID 以 --conversation 在外部终端恢复；与 agy -c/--continue 同一契约",
            },
            resources: Facet {
                state: "available",
                reason: "MCP（~/.gemini/config/mcp_config.json mcpServers：stdio command/args/env/cwd 与远程 serverUrl+headers/oauth，旧版 url/httpUrl 条目只读保留）与 Skills（antigravity-cli/skills 与项目 .agents/skills）由原生路径提供",
            },
            history: Facet {
                state: "available",
                reason: "只读索引 conversation_summaries.db 与 brain/<id>/transcript_full.jsonl；用量来自 conversations/<id>.db gen_metadata protobuf（[RE] 证据，字段不符时按行跳过并降级 partial，不猜测）",
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

    const NATIVE_FIXTURE: &str =
        include_str!("../../../../tests/fixtures/native/antigravity-cli-1.3.json");

    const MCP_FIXTURE: &str = r#"{
  "mcpServers": {
    "example-stdio": {
      "command": "npx",
      "args": ["-y", "example-mcp"],
      "env": { "EXAMPLE_MODE": "fixture" },
      "cwd": "C:\\tools\\example"
    },
    "example-remote": {
      "serverUrl": "https://mcp.example.com/sse",
      "headers": { "X-Example": "fixture" },
      "oauth": true
    },
    "legacy-remote": {
      "url": "https://legacy.example.com/sse",
      "headers": { "X-Legacy": "fixture" }
    }
  }
}"#;

    fn definition(transport: McpTransport) -> McpDefinition {
        McpDefinition {
            id: "fixture-definition".into(),
            name: "example".into(),
            transport,
            command: "npx -y example-mcp".into(),
            args: Vec::new(),
            url: "https://mcp.example.com/sse".into(),
            env: std::collections::BTreeMap::from([("EXAMPLE_MODE".into(), "fixture".into())]),
            headers: std::collections::BTreeMap::from([("X-Example".into(), "1".into())]),
            in_library: true,
            version: 0,
        }
    }

    fn connection() -> crate::native::profile::Connection {
        crate::native::profile::Connection {
            provider_id: "gemini".into(),
            interface_format: String::new(),
            base_url: String::new(),
            model: String::new(),
            secret_ref: Some("connection-00000000-0000-4000-8000-000000000001".into()),
            auth_env_var: None,
            model_records: Vec::new(),
        }
    }

    struct MemoryStore(std::collections::HashMap<String, String>);
    impl crate::credentials::CredentialStore for MemoryStore {
        fn put(&self, _id: &str, _secret: &str) -> Result<(), String> {
            Ok(())
        }
        fn get(&self, _id: &str) -> Result<String, String> {
            Ok(String::new())
        }
        fn delete(&self, _id: &str) -> Result<(), String> {
            Ok(())
        }
    }

    #[test]
    fn identity_accepts_only_the_official_command_name() {
        assert!(Antigravity.version_identity("agy", "1.3.1"));
        assert!(Antigravity.version_identity("agy", "antigravity 1.3.1"));
        assert!(!Antigravity.version_identity("agy", "claude 2.1.283"));
        assert!(!Antigravity.version_identity("other", "1.3.1"));
        assert!(Antigravity.history_resume_version_supported("1.3.1"));
        assert!(Antigravity.history_resume_version_supported("1.2.0"));
        assert!(!Antigravity.history_resume_version_supported("2.0.0"));
        assert!(!Antigravity.history_resume_version_supported("junk"));
    }

    #[test]
    fn native_files_map_the_documented_settings_and_binary_directory() {
        let home = Path::new("/home/example");
        let global = Antigravity.native_files(Scope::Global, home, None, true);
        assert_eq!(global.len(), 1);
        assert_eq!(global[0].role, "settings");
        assert_eq!(global[0].format, "json");
        assert!(
            global[0]
                .path
                .replace('\\', "/")
                .ends_with(".gemini/antigravity-cli/settings.json")
        );
        assert!(Antigravity
            .native_files(Scope::Project, home, Some(Path::new("/work/p")), true)
            .is_empty());
        assert_eq!(Antigravity.file_kind("settings").unwrap(), FileKind::Json);
        assert!(Antigravity.file_kind("config").is_err());
        assert!(!Antigravity.node_required_when_missing());
        // The official installer's binary directory is probed even when PATH
        // registration is lost.
        for directory in Antigravity.native_binary_directories(home) {
            let text = directory.to_string_lossy().replace('\\', "/");
            assert!(text.ends_with("agy/bin"), "{text}");
        }
        // The sanitized settings sample parses as the declared plain JSON.
        let parsed = crate::native::format::parse(FileKind::Json, NATIVE_FIXTURE).unwrap();
        assert_eq!(parsed["modelProvider"], "gemini");
        assert!(Antigravity
            .inspect_values(&parsed, &Value::Null, &Value::Null)
            .provider
            .is_none());
    }

    #[test]
    fn mcp_locations_follow_the_gemini_config_and_agents_project_roots() {
        let temp = tempfile::tempdir().unwrap();
        let global = Antigravity
            .mcp_location(Scope::Global, temp.path(), None)
            .unwrap();
        assert!(global
            .path
            .to_string_lossy()
            .replace('\\', "/")
            .ends_with(".gemini/config/mcp_config.json"));
        assert_eq!(global.root, "mcpServers");
        assert_eq!(global.child, None);
        let project = Antigravity
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
            .ends_with("/work/demo/.agents/mcp_config.json"));
    }

    #[test]
    fn mcp_entries_surface_server_url_and_keep_legacy_entries_read_only() {
        let location = Antigravity
            .mcp_location(Scope::Global, Path::new("/home/example"), None)
            .unwrap();
        let parsed = crate::native::format::parse(FileKind::Json, MCP_FIXTURE).unwrap();
        let entries = Antigravity.mcp_entries(&parsed, &location).unwrap();
        assert_eq!(entries.len(), 3, "{entries:?}");
        // serverUrl is surfaced through the shared view key.
        let remote = Antigravity.mcp_entry_view(&entries["example-remote"]);
        assert_eq!(remote["url"], "https://mcp.example.com/sse");
        assert_eq!(remote["serverUrl"], "https://mcp.example.com/sse");
        // A legacy url entry keeps displaying through its own key.
        let legacy = Antigravity.mcp_entry_view(&entries["legacy-remote"]);
        assert_eq!(legacy["url"], "https://legacy.example.com/sse");
        // Rewriting a legacy entry is rejected instead of guessed.
        let error = Antigravity
            .mcp_document(&definition(McpTransport::Http), true, Some(&entries["legacy-remote"]))
            .unwrap_err();
        assert!(error.contains("serverUrl"), "{error}");
    }

    #[test]
    fn mcp_documents_match_the_official_stdio_and_remote_shapes() {
        let location = Antigravity
            .mcp_location(Scope::Global, Path::new("/home/example"), None)
            .unwrap();
        let parsed = crate::native::format::parse(FileKind::Json, MCP_FIXTURE).unwrap();
        let entries = Antigravity.mcp_entries(&parsed, &location).unwrap();
        // stdio: command/args split like Grok/Codex, env map, preserved cwd.
        let stdio = Antigravity
            .mcp_document(&definition(McpTransport::Stdio), true, Some(&entries["example-stdio"]))
            .unwrap()
            .unwrap();
        assert_eq!(stdio["command"], "npx");
        assert_eq!(stdio["args"], json!(["-y", "example-mcp"]));
        assert_eq!(stdio["env"]["EXAMPLE_MODE"], "fixture");
        assert_eq!(stdio["cwd"], "C:\\tools\\example");
        assert!(stdio.get("url").is_none(), "stdio 条目不带远程键");
        // Remote: serverUrl + headers; the native oauth flag survives.
        let remote = Antigravity
            .mcp_document(&definition(McpTransport::Http), true, Some(&entries["example-remote"]))
            .unwrap()
            .unwrap();
        assert_eq!(remote["serverUrl"], "https://mcp.example.com/sse");
        assert_eq!(remote["headers"]["X-Example"], "1");
        assert_eq!(remote["oauth"], true);
        assert!(remote.get("url").is_none(), "现行远程键是 serverUrl");
        assert!(remote.get("command").is_none());
        // Disabling removes the native entry (no documented enabled flag).
        assert!(Antigravity
            .mcp_document(&definition(McpTransport::Stdio), false, None)
            .unwrap()
            .is_none());
        assert_eq!(
            Antigravity.mcp_disabled_description(),
            Some("停用会移除原生条目，Cliora 中的定义仍保留")
        );
    }

    #[test]
    fn skill_roots_follow_the_official_personal_and_project_directories() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        assert_eq!(
            Antigravity.skill_root(Scope::Global, temp.path(), None).unwrap(),
            gemini_root(temp.path()).join("antigravity-cli").join("skills")
        );
        assert_eq!(
            Antigravity
                .skill_root(Scope::Project, temp.path(), Some(&project))
                .unwrap(),
            project.join(".agents").join("skills")
        );
    }

    #[test]
    fn launch_args_cover_normal_yolo_and_conversation_resume() {
        assert!(Antigravity
            .launch_args(None, LaunchMode::Normal)
            .unwrap()
            .is_empty());
        assert_eq!(
            Antigravity.launch_args(None, LaunchMode::Yolo).unwrap(),
            vec!["--dangerously-skip-permissions"]
        );
        let id = "conv_root_20261005_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6";
        assert_eq!(
            Antigravity.launch_args(Some(id), LaunchMode::Normal).unwrap(),
            vec!["--conversation", id]
        );
        assert_eq!(
            Antigravity.launch_args(Some(id), LaunchMode::Yolo).unwrap(),
            vec!["--conversation", id, "--dangerously-skip-permissions"]
        );
        // Only the documented headless channel name is ever injected.
        let mut connection = crate::native::profile::Connection {
            provider_id: "gemini".into(),
            interface_format: String::new(),
            base_url: String::new(),
            model: String::new(),
            secret_ref: Some("connection-00000000-0000-4000-8000-000000000001".into()),
            auth_env_var: None,
            model_records: Vec::new(),
        };
        assert_eq!(
            Antigravity.auth_env_name(&connection).as_deref(),
            Some("GEMINI_API_KEY")
        );
        connection.secret_ref = None;
        assert!(Antigravity.auth_env_name(&connection).is_none());
        connection.auth_env_var = Some("GEMINI_API_KEY".into());
        assert_eq!(
            Antigravity.auth_env_name(&connection).as_deref(),
            Some("GEMINI_API_KEY")
        );
        connection.auth_env_var = Some("SOMETHING_ELSE".into());
        assert!(Antigravity.auth_env_name(&connection).is_none());
    }

    #[test]
    fn delivered_dimensions_declare_no_fabricated_ports() {
        assert!(Antigravity.history_supported());
        assert!(Antigravity.supports_mcp());
        assert!(Antigravity.supports_skills());
        // Agents (definition format not obtained), plugins (native `agy
        // plugin` storage undocumented), accounts (keyring login never
        // adopted) and official quota (/usage is a TUI panel) stay absent.
        assert!(Antigravity.configuration().is_none());
        assert!(Antigravity.agents().is_none());
        assert!(Antigravity.plugins().is_none());
        assert!(Antigravity.accounts().is_none());
        assert!(Antigravity.official_usage().is_none());
        // No native file ever carries a key and no secret is written to
        // settings.json: the headless channel is env-only.
        assert!(Antigravity
            .connection_documents(&connection(), Scope::Global)
            .is_err());
        let profile = crate::native::profile::RegisteredProfile {
            editing: None,
            id: String::new(),
            tool: "antigravity".into(),
            name: "demo".into(),
            version: 1,
            revision: String::new(),
            inherit_common: false,
            files: std::collections::BTreeMap::new(),
            suppressed: std::collections::BTreeMap::new(),
            authentication: Default::default(),
            connection: Some(connection()),
            native_credentials: std::collections::BTreeMap::new(),
        };
        let keys = MemoryStore(std::collections::HashMap::new());
        let mut secrets = crate::native::apply::NativeSecrets::default();
        assert!(Antigravity
            .write_connection_secret(&profile, Scope::Global, &keys, &mut secrets)
            .is_err());
        let parsed = crate::native::format::parse(FileKind::Json, NATIVE_FIXTURE).unwrap();
        assert!(!Antigravity.has_native_secret("settings", &parsed));
        let descriptor = Antigravity.descriptor();
        assert_eq!(descriptor.launch_form, LaunchForm::Terminal);
        assert!(descriptor.yolo_available);
        for (facet, dimension) in [
            (&descriptor.native_config, "native_config"),
            (&descriptor.launch, "launch"),
            (&descriptor.resume, "resume"),
            (&descriptor.resources, "resources"),
            (&descriptor.history, "history"),
        ] {
            assert_eq!(facet.state, "available", "antigravity 的 {dimension}");
            assert!(!facet.reason.trim().is_empty());
        }
        assert!(descriptor.login.is_none());
        assert!(descriptor.management.mcp && descriptor.management.skills);
        assert!(!descriptor.management.accounts);
        assert!(!descriptor.management.agents);
        assert!(!descriptor.management.plugins);
        assert!(!descriptor.management.rules.global && !descriptor.management.rules.project);
    }
}
