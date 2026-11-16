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
//!   `config/mcp_config.json`, skills `antigravity-cli/skills/`; data roots
//!   `~/.gemini/antigravity` (agy ≤1.3) and, since the 1.5.9 migration,
//!   `~/.gemini/antigravity-cli/` (the CLI settings directory, which then
//!   also holds the session stores; the legacy root stays empty with a
//!   `~/.gemini/config/.migrated` marker) — each with
//!   `conversation_summaries.db`, `conversations/<id>.db`,
//!   `brain/<id>/.system_generated/logs/transcript_full.jsonl` (see
//!   [`history`]; session ids are deduplicated across the two roots).
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
//!   Version-shaped since the 1.5.9 evidence run
//!   (`docs/verification/remote-workflow/agy-1.5.9/`, fixture
//!   `tests/fixtures/native/antigravity-cli-1.5.9/mcp-config.json`): the
//!   native writer still spells remote entries `serverUrl` but stamps an
//!   explicit per-entry `disabled` boolean (`agy mcp enable` removes the key),
//!   native edits canonicalize legacy `url` entries back to `serverUrl`, and
//!   disable keeps the entry with `disabled: true`. Installs below 1.5 keep
//!   the 1.3.x shape (no per-entry flag; disabling removes the entry, legacy
//!   `url`/`httpUrl` entries stay read-only). `<workspace>/.agents/
//!   mcp_config.json` is the runtime project scope: it loads in sessions but
//!   `agy mcp` subcommands never list or write it, so Cliora manages it as a
//!   native config file directly.
//! * **Skills** (1.5.9 evidence run, see [`skills`]): writable roots stay the
//!   personal `antigravity-cli/skills/<dir>/SKILL.md` and the open-standard
//!   project `.agents/skills/<dir>/SKILL.md`. The product `/skills` panel
//!   additionally discovers the Shared `~/.gemini/skills`, the config root
//!   `~/.gemini/config/skills` and the builtin
//!   `~/.gemini/antigravity-cli/builtin/skills` trees plus the explicit
//!   `.agents/skills.json` declaration source; those appear as read-only
//!   observations/declarations. Frontmatter `name` (matching the directory)
//!   and `description` are required before agy loads a skill, so directories
//!   without `SKILL.md` are not skills here and enabling a contract-breaking
//!   package is refused.
//! * **History/usage** ([RE] for 1.2.x plus the 1.5.9 remote capture, see
//!   [`history`] and [`protobuf`]): the conversation index, transcripts and
//!   per-conversation protobuf usage rows of both data roots are read-only
//!   indexed and deduplicated by native session id; any schema drift skips
//!   the row and degrades the session to partial instead of guessing.
//! * **Credentials**: the OS-keyring browser login is never adopted or logged
//!   out. Only the documented headless env channel `GEMINI_API_KEY` may be
//!   managed: the value stays in the system credential store and is injected
//!   into the child process at launch time, never serialized to the frontend
//!   or written into `settings.json`.
//! * **Agents** (1.5.9 evidence run, see [`agents`]): standalone definitions
//!   are one directory per agent holding `agent.md` — workspace
//!   `<project>/.agents/agents/{name}/` and global
//!   `~/.gemini/config/agents/{name}/`; frontmatter `name`/`description`
//!   required, `mainAgent`/`subagent` type the roster membership, and the
//!   `--agent` launch flag (1.5+ only) selects a main agent for a new
//!   session. Plugin agents stay owned by the shared plugin scan.
//! * Plugins/quota: no verified contract (`agy plugin` exists but its storage
//!   is undocumented; `/usage` is a TUI subscription panel, not a local
//!   statistic) — those ports stay absent by design.

pub(crate) mod agents;
pub(crate) mod history;
pub(crate) mod memory;
pub(crate) mod protobuf;
pub(crate) mod skills;

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::{
    file, AdapterDescriptor, CliAdapter, Facet, InspectionFields, LaunchMode, ManagementCapabilities,
    McpLocation, RuleSupport, SkillDeclaration, SkillObservation,
};
use crate::native::adapter::{NativeFile, Scope};
use crate::native::format::FileKind;
use crate::resources::mcp::{self, McpDefinition, McpTransport};

/// The `~/.gemini` root shared by settings, MCP config, skills and the
/// conversation data tree.
fn gemini_root(home: &Path) -> PathBuf {
    crate::accounts::selection::config_root("antigravity", || home.join(".gemini"))
}

/// Conversation data root, legacy layout: `~/.gemini/antigravity` with
/// `conversation_summaries.db`, `conversations/` and `brain/`.
pub(crate) fn data_root(home: &Path) -> PathBuf {
    crate::accounts::selection::history_root("antigravity", || home.join(".gemini").join("antigravity"))
}

/// Conversation data root, 1.5.9 layout: `~/.gemini/antigravity-cli/`. After
/// the native migration the CLI settings directory also holds the session
/// stores (`conversation_summaries.db` with the `conversation_id` column
/// set, `conversations/`, `brain/`), while the legacy root stays behind —
/// empty on the evidence machine, with a `~/.gemini/config/.migrated`
/// marker. Read-only like [`data_root`]; both roots are scanned and
/// deduplicated by session id (see [`history`]).
pub(crate) fn cli_data_root(home: &Path) -> PathBuf {
    gemini_root(home).join("antigravity-cli")
}

pub struct Antigravity;

impl CliAdapter for Antigravity {
    fn remote_resource_layout(&self) -> super::RemoteResourceLayout {
        super::RemoteResourceLayout { skill_root: Some(".gemini/antigravity-cli/skills"), ..Default::default() }
    }
    fn memory(&self) -> Option<&dyn super::memory::MemoryAdapter> {
        Some(self)
    }
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
    fn latest_version_url(&self) -> Option<String> {
        let os = if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "darwin" } else { "linux" };
        let arch = if cfg!(target_arch = "aarch64") { "arm64" } else if cfg!(target_arch = "x86_64") { "amd64" } else { return None };
        let libc = if cfg!(all(target_os = "linux", target_env = "musl")) { "_musl" } else { "" };
        Some(format!("https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/{os}_{arch}{libc}.json"))
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
        project: Option<&Path>,
        known: bool,
    ) -> Vec<NativeFile> {
        match scope {
            Scope::Global => vec![file(
                "settings",
                gemini_root(home)
                    .join("antigravity-cli")
                    .join("settings.json"),
                FileKind::Json,
                known,
                Some("Antigravity CLI（agy）设置（纯 JSON）；keyring 登录态不接管，headless 密钥经 GEMINI_API_KEY 注入"),
                false,
            )],
            Scope::Project => {
                // Runtime project MCP scope (1.5.9 evidence): sessions load
                // `<workspace>/.agents/mcp_config.json`, but `agy mcp`
                // subcommands manage only the user-level global file. Cliora
                // edits this file directly through the registered-file path,
                // which the shared transaction service protects.
                let Some(project) = project else {
                    return Vec::new();
                };
                vec![file(
                    "mcp",
                    project.join(".agents").join("mcp_config.json"),
                    FileKind::Json,
                    known,
                    Some("项目级 MCP 运行时作用域（.agents/mcp_config.json）；agy mcp 子命令不管理此文件，仅在会话内加载"),
                    false,
                )]
            }
        }
    }
    fn interface_formats(&self) -> &'static [&'static str] {
        &[]
    }
    fn file_kind(&self, role: &str) -> Result<FileKind, String> {
        if role == "settings" || role == "mcp" {
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
    /// The verified entry shape differs between the 1.3.x and 1.5.9 install
    /// lines (per-entry `disabled` flag, legacy-key canonicalization), so the
    /// MCP contract follows the probed version.
    fn mcp_requires_version(&self) -> bool {
        true
    }
    fn mcp_location_for_version(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
        version: Option<&str>,
    ) -> Option<McpLocation> {
        if let Some(text) = version {
            let parsed = semver::Version::parse(text.trim().trim_start_matches('v')).ok()?;
            if parsed.major != 1 {
                // Only the 1.3.x and 1.5.9 shapes are evidenced; a newer
                // major's contract stays unconfirmed instead of guessed.
                return None;
            }
        }
        self.mcp_location(scope, home, project)
    }
    fn mcp_entry_view(&self, entry: &Value) -> Value {
        // Remote entries spell the URL `serverUrl` (legacy entries keep their
        // own `url`/`httpUrl` key); surface the address through the shared
        // `url` view key without rewriting the native document. The current
        // key wins when a hand-edited entry carries both spellings.
        let Some(object) = entry.as_object() else {
            return entry.clone();
        };
        let mirror = ["serverUrl", "url", "httpUrl"]
            .into_iter()
            .find_map(|key| object.get(key).and_then(Value::as_str));
        if let Some(url) = mirror {
            if object.get("url").and_then(Value::as_str) != Some(url) {
                let mut view = object.clone();
                view.insert("url".into(), json!(url));
                return Value::Object(view);
            }
        }
        entry.clone()
    }
    fn mcp_document(
        &self,
        definition: &McpDefinition,
        enabled: bool,
        existing: Option<&Value>,
    ) -> Result<Option<Value>, String> {
        // Without a probed install line the long-standing 1.3.x shape stays:
        // no per-entry enabled flag is guessed onto the document.
        mcp_document_for_shape(definition, enabled, existing, false)
    }
    fn mcp_document_for_version(
        &self,
        definition: &McpDefinition,
        enabled: bool,
        existing: Option<&Value>,
        _location: &McpLocation,
        version: Option<&str>,
    ) -> Result<Option<Value>, String> {
        mcp_document_for_shape(definition, enabled, existing, per_entry_disabled(version)?)
    }
    fn mcp_disabled_description(&self) -> Option<&'static str> {
        Some("停用会移除原生条目，Cliora 中的定义仍保留")
    }
    fn mcp_disabled_description_for_version(&self, version: Option<&str>) -> Option<&'static str> {
        if per_entry_disabled(version).unwrap_or(false) {
            Some("停用会写入 disabled:true 并保留原生条目；启用时移除该键")
        } else {
            self.mcp_disabled_description()
        }
    }
    fn mcp_supports_cwd(&self) -> bool {
        true
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
    // A skill is `<dir>/SKILL.md` on every verified install line; a directory
    // without the file is not an enableable skill for agy (1.5.9 /skills and
    // plugin validate both require the manifest).
    fn skill_requires_manifest(&self) -> bool {
        true
    }
    /// Additional read-only discovery roots of the product `/skills` panel:
    /// the Shared `~/.gemini/skills`, the config root
    /// `~/.gemini/config/skills` (labeled `From ~/.gemini/config` natively)
    /// and the builtin tree. Only the brand roots above stay writable.
    fn skill_observations(
        &self,
        scope: Scope,
        home: &Path,
        _project: Option<&Path>,
    ) -> Vec<SkillObservation> {
        if scope != Scope::Global {
            return Vec::new();
        }
        let root = gemini_root(home);
        vec![
            SkillObservation {
                root: root.join("skills"),
                detail: "Shared 目录（~/.gemini/skills）",
            },
            SkillObservation {
                root: root.join("config").join("skills"),
                detail: "config 目录（~/.gemini/config/skills）",
            },
            SkillObservation {
                root: root
                    .join("antigravity-cli")
                    .join("builtin")
                    .join("skills"),
                detail: "内置 Skill（builtin/skills）",
            },
        ]
    }
    /// Explicit declaration source `.agents/skills.json` (1.5.9 evidence):
    /// non-standard workspace directories, resolved by the adapter with the
    /// native containment and name-filter rules (see [`skills`]). Read-only
    /// discovery rows; the writable roots are unchanged.
    fn skill_declarations(
        &self,
        scope: Scope,
        _home: &Path,
        project: Option<&Path>,
    ) -> Vec<SkillDeclaration> {
        if scope != Scope::Project {
            return Vec::new();
        }
        project.map(skills::declared_sources).unwrap_or_default()
    }
    // Same-name skills across the discovery roots: the native precedence is
    // the CLI's own and was not observed, so every copy is marked instead of
    // guessing a winner.
    fn skill_marks_duplicate_names(&self) -> bool {
        true
    }
    // Verified 1.5.9 frontmatter contract: `name` (matching the directory)
    // and `description` are required before agy loads a skill, so enabling a
    // contract-breaking package would claim a load that never happens.
    fn skill_enable_requires_contract(&self) -> Option<&'static str> {
        Some("此 Skill 的 SKILL.md 不符合 agy frontmatter 契约（name 需与目录一致且为规范形式、description 必填），agy 不会加载它；请先修正后再启用。问题：")
    }
    /// Remote POSIX inventory mirrors the local global discovery: the
    /// writable brand root plus the Shared/config/builtin read-only trees
    /// (Linux layout verified by the 1.5.9 evidence run). Project
    /// `skills.json` declarations are workspace-relative and stay local.
    fn remote_skill_directories(&self) -> Vec<super::RemoteSkillDirectory> {
        vec![
            super::RemoteSkillDirectory {
                relative: ".gemini/antigravity-cli/skills",
                read_only: false,
                detail: "远程主机目录",
            },
            super::RemoteSkillDirectory {
                relative: ".gemini/skills",
                read_only: true,
                detail: "Shared 目录",
            },
            super::RemoteSkillDirectory {
                relative: ".gemini/config/skills",
                read_only: true,
                detail: "config 目录",
            },
            super::RemoteSkillDirectory {
                relative: ".gemini/antigravity-cli/builtin/skills",
                read_only: true,
                detail: "内置 Skill",
            },
        ]
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
    fn connection_policy(&self, _scope: Scope) -> crate::native::adapter::ConnectionPolicy {
        crate::native::adapter::ConnectionPolicy {
            api_key: crate::native::adapter::api_key_unsupported(
                "Antigravity 不向 settings.json 写入密钥；headless GEMINI_API_KEY 只在启动时注入，Cliora 暂不接管",
            ),
            provider_address: crate::native::adapter::address_unsupported(
                "Antigravity 连接编辑面暂不交付：settings.json 以原生 JSON 编辑",
            ),
            projection: "single_connection",
        }
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
    fn agents(&self) -> Option<&dyn super::agents::AgentAdapter> {
        Some(self)
    }
    /// Verified on 1.5.9 (`agy --help`: `--agent <name>`; the roster holds
    /// main agents only, see [`agents`]). The version-less form is the
    /// capability declaration used by the descriptor and remote launches.
    fn launch_agent_args(&self, agent: Option<&str>) -> Result<Vec<String>, String> {
        Ok(agent
            .map(|name| vec!["--agent".into(), name.into()])
            .unwrap_or_default())
    }
    /// The flag was verified on the 1.5.9 line only: the local 1.3.1 help has
    /// no `--agent`, so an identified older or unverified major refuses the
    /// selection instead of passing a flag the CLI may not know.
    fn launch_agent_args_for_version(
        &self,
        version: &str,
        agent: Option<&str>,
    ) -> Result<Vec<String>, String> {
        let parsed = semver::Version::parse(version.trim().trim_start_matches('v'))
            .map_err(|_| format!("无法识别的 agy 版本号「{version}」；未执行 Agent 选择"))?;
        if parsed.major != 1 || parsed.minor < 5 {
            return Err(format!(
                "agy {parsed} 的 --agent 启动参数尚未验证（1.5 起有实证）；未执行启动"
            ));
        }
        self.launch_agent_args(agent)
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
    fn history_association(&self) -> Option<Facet> {
        Some(Facet {
            state: "available",
            reason: "直接 parent_conversation_id 子行挂到父会话（1.5.9 另含 conversation_parents 表链接）；用量库或记录缺失时该子节点不可读",
        })
    }
    fn history_resume_version_supported(&self, version: &str) -> bool {
        // [RE] storage evidence covers agy 1.2.x and the local 1.3.1; allow
        // ordinary movement inside major 1, nothing beyond.
        semver::Version::parse(version.trim().trim_start_matches('v'))
            .is_ok_and(|version| version.major == 1)
    }
    fn install_guidance(&self) -> (&'static str, &'static str) {
        (
            "https://antigravity.google/cli",
            "Windows：irm https://antigravity.google/cli/install.ps1 | iex，安装到 %LOCALAPPDATA%\\agy\\bin。macOS/Linux 使用 install.sh，安装到 ~/.local/bin。已安装后用 agy update；安装脚本发现已有二进制时不会覆盖。",
        )
    }
    fn recognizes_native_install_path(&self, path: &Path) -> bool {
        let name = path.file_name().and_then(|name| name.to_str()).unwrap_or("");
        let agy = name.eq_ignore_ascii_case("agy") || name.eq_ignore_ascii_case("agy.exe");
        agy && path.parent().is_some_and(|parent| parent.ends_with("agy/bin") || parent.ends_with(".local/bin"))
    }
    fn install_command(&self) -> Option<String> {
        self.native_install_command()
    }
    fn native_install_command(&self) -> Option<String> {
        Some(
            if cfg!(windows) {
                "irm https://antigravity.google/cli/install.ps1 | iex"
            } else {
                "curl -fsSL https://antigravity.google/cli/install.sh | bash"
            }
            .into(),
        )
    }
    fn upgrade_command(&self, source: &str) -> Option<String> {
        (source == "native").then(|| "agy update".to_owned())
    }
    fn descriptor(&self) -> AdapterDescriptor {
        AdapterDescriptor {
            remote: self.remote_capabilities(),
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
                reason: "MCP（~/.gemini/config/mcp_config.json mcpServers：stdio command/args/env/cwd 与远程 serverUrl+headers/oauth；1.5+ 按实测写逐条 disabled（停用保留条目），1.3.x 停用移除条目且旧版 url/httpUrl 条目只读；项目 .agents/mcp_config.json 为运行时作用域，agy mcp 子命令不管理）、Skills（可写根 antigravity-cli/skills 与项目 .agents/skills；只读发现 Shared ~/.gemini/skills、config 目录、builtin 与 skills.json 声明目录；SKILL.md frontmatter name/description 契约强制）与 Agents（独立定义 <project>/.agents/agents/{name}/agent.md 与 ~/.gemini/config/agents/{name}/agent.md；mainAgent/subagent 决定 --agent 启动名单；插件 Agent 随插件只读管理）由原生路径提供",
            },
            history: Facet {
                state: "available",
                reason: "只读双根索引 conversation_summaries.db（1.3 ~/.gemini/antigravity 与 1.5.9 ~/.gemini/antigravity-cli，按会话 ID 去重）与 brain/<id>/transcript_full.jsonl；用量来自 conversations/<id>.db gen_metadata protobuf，1.5.9 缺用量库时以转录行计数降级补充（字段不符时按行跳过并降级 partial，不猜测）",
            },
            login: None,
            management: ManagementCapabilities {
                accounts: false,
                mcp: true,
                skills: true,
                agents: true,
                plugins: false,
                project_plugins: false,
                rules: RuleSupport::bare(false, false),
                memory: self.published_memory(),
                memory_reason: "",
            },
        }
    }
}

/// Whether the probed install line writes the 1.5.9 per-entry `disabled`
/// contract (verified on 1.5.9: `agy mcp add` stamps `disabled:false`,
/// `disable` keeps the entry with `disabled:true`, `enable` removes the key).
/// 1.3.x has no per-entry flag. An absent version keeps the 1.3.x shape —
/// the long-standing Cliora behavior — while an unverified major refuses
/// writes instead of guessing.
fn per_entry_disabled(version: Option<&str>) -> Result<bool, String> {
    let Some(text) = version else {
        return Ok(false);
    };
    let parsed = semver::Version::parse(text.trim().trim_start_matches('v'))
        .map_err(|_| format!("无法识别的 agy 版本号「{text}」；未执行 MCP 写入"))?;
    if parsed.major != 1 {
        return Err(format!("agy {parsed} 的 MCP 键契约尚未验证；未执行写入"));
    }
    Ok(parsed.minor >= 5)
}

/// Native entry document for one shape line. `per_entry_flag` is the 1.5.9
/// contract above; without it the 1.3.x shape applies (disabling removes the
/// entry, legacy `url`/`httpUrl` entries stay read-only).
fn mcp_document_for_shape(
    definition: &McpDefinition,
    enabled: bool,
    existing: Option<&Value>,
    per_entry_flag: bool,
) -> Result<Option<Value>, String> {
    // 1.3.x: no documented per-entry enabled flag — disabling removes the
    // native entry while the Cliora definition stays for re-enabling.
    if !enabled && !per_entry_flag {
        return Ok(None);
    }
    let legacy = existing
        .and_then(Value::as_object)
        .is_some_and(|map| map.get("url").is_some() || map.get("httpUrl").is_some());
    if legacy && !per_entry_flag {
        return Err(
            "该条目仍是旧版 url/httpUrl 拼写（现行键为 serverUrl）；为避免误写，此条目只读保留，请先在原生文件中确认或改名"
                .into(),
        );
    }
    let mut map = match definition.transport {
        McpTransport::Stdio => {
            // stdio shape: command/args/env/cwd (+ other native keys the CLI
            // owns). Remote keys never survive a stdio entry.
            let mut map = mcp::stdio_doc_with_env(definition, existing, "env");
            map.remove("serverUrl");
            map.remove("httpUrl");
            mcp::apply_cwd(&mut map, definition);
            map
        }
        McpTransport::Sse => {
            return Err("Antigravity 没有已确认的旧版 HTTP+SSE 映射，未改写为 Streamable HTTP".into());
        }
        McpTransport::Http => {
            // Remote shape: serverUrl + headers; the oauth/trust fields of an
            // existing entry stay untouched, and sensitive existing headers
            // keep their protected values through the shared builder. Legacy
            // `url`/`httpUrl` spellings canonicalize back to the native
            // writer's `serverUrl` on 1.5.9 — never both keys on one entry.
            let mut map = mcp::http_doc(definition, existing, "headers");
            map.remove("url");
            map.remove("httpUrl");
            map.insert("serverUrl".into(), json!(definition.url));
            map
        }
    };
    if per_entry_flag {
        // 1.5.9 native writer semantics: `mcp add` stamps an explicit
        // `disabled:false`, disable flips the flag in place with the entry
        // kept, and enable removes the key entirely (implicit enabled).
        let was_disabled = existing
            .and_then(Value::as_object)
            .and_then(|map| map.get("disabled"))
            == Some(&Value::Bool(true));
        if !enabled {
            map.insert("disabled".into(), json!(true));
        } else if was_disabled {
            map.remove("disabled");
        } else {
            map.insert("disabled".into(), json!(false));
        }
    }
    Ok(Some(Value::Object(map)))
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

    // Sanitized 1.5.9 sample pinned by the remote evidence run.
    const MCP_159_FIXTURE: &str =
        include_str!("../../../../tests/fixtures/native/antigravity-cli-1.5.9/mcp-config.json");

    fn definition(transport: McpTransport) -> McpDefinition {
        McpDefinition {
            id: "fixture-definition".into(),
            name: "example".into(),
            cwd: String::new(),
            transport,
            command: "npx -y example-mcp".into(),
            args: Vec::new(),
            url: "https://mcp.example.com/sse".into(),
            env: indexmap::IndexMap::from([("EXAMPLE_MODE".into(), "fixture".into())]),
            headers: indexmap::IndexMap::from([("X-Example".into(), "1".into())]),
            in_library: true,
            version: 0,
            updated_at: None,
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

    struct MemoryStore;
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
        assert!(Antigravity.native_files(Scope::Project, home, None, true).is_empty());
        // The project runtime MCP scope is a native config file role: `agy mcp`
        // subcommands manage only the user-level global file (1.5.9 evidence).
        let project = Antigravity.native_files(Scope::Project, home, Some(Path::new("/work/p")), true);
        assert_eq!(project.len(), 1);
        assert_eq!(project[0].role, "mcp");
        assert_eq!(project[0].format, "json");
        assert!(project[0].writable);
        assert!(!project[0].sensitive);
        assert!(
            project[0]
                .path
                .replace('\\', "/")
                .ends_with("/work/p/.agents/mcp_config.json")
        );
        assert_eq!(Antigravity.file_kind("settings").unwrap(), FileKind::Json);
        assert_eq!(Antigravity.file_kind("mcp").unwrap(), FileKind::Json);
        assert!(Antigravity.file_kind("config").is_err());
        assert!(!Antigravity.node_required_when_missing());
        let install = Antigravity.install_command().unwrap();
        assert!(install.contains(if cfg!(windows) { "install.ps1" } else { "install.sh" }));
        assert_eq!(Antigravity.upgrade_command("native").as_deref(), Some("agy update"));
        assert!(Antigravity.upgrade_command("unknown").is_none());
        // Forward slashes exercise the directory rule on every host; backslashes are Windows separators.
        assert!(Antigravity.recognizes_native_install_path(Path::new("C:/Users/me/AppData/Local/agy/bin/agy.exe")));
        #[cfg(windows)]
        assert!(Antigravity.recognizes_native_install_path(Path::new(r"C:\Users\me\AppData\Local\agy\bin\agy.exe")));
        assert!(Antigravity.recognizes_native_install_path(Path::new("/home/example/.local/bin/agy")));
        assert!(!Antigravity.recognizes_native_install_path(Path::new("/home/example/.local/bin/other")));
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
        // stdio: command/args split like Grok/Codex, env map, cwd set from the definition.
        let mut with_cwd = definition(McpTransport::Stdio);
        with_cwd.cwd = "C:\\tools\\example".into();
        assert!(Antigravity.mcp_supports_cwd());
        let stdio = Antigravity
            .mcp_document(&with_cwd, true, Some(&entries["example-stdio"]))
            .unwrap()
            .unwrap();
        assert_eq!(stdio["command"], "npx");
        assert_eq!(stdio["args"], json!(["-y", "example-mcp"]));
        assert_eq!(stdio["env"]["EXAMPLE_MODE"], "fixture");
        assert_eq!(stdio["cwd"], "C:\\tools\\example");
        assert!(stdio.get("url").is_none(), "stdio 条目不带远程键");
        // An empty cwd clears the native working directory; legacy SSE has no mapping.
        let cleared = Antigravity
            .mcp_document(&definition(McpTransport::Stdio), true, Some(&entries["example-stdio"]))
            .unwrap()
            .unwrap();
        assert!(cleared.get("cwd").is_none());
        assert!(!Antigravity.mcp_supports_sse());
        assert!(Antigravity.mcp_document(&definition(McpTransport::Sse), true, None).is_err());
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

    fn mcp_location_global() -> McpLocation {
        Antigravity
            .mcp_location(Scope::Global, Path::new("/home/example"), None)
            .unwrap()
    }

    #[test]
    fn mcp_shape_gating_follows_the_probed_install_line() {
        // 1.3.x and unparsed lines keep the flag-free shape; 1.5+ flip to the
        // per-entry disabled contract; other majors refuse writes.
        assert!(!per_entry_disabled(None).unwrap());
        assert!(!per_entry_disabled(Some("1.3.1")).unwrap());
        assert!(!per_entry_disabled(Some("v1.4.2")).unwrap());
        assert!(per_entry_disabled(Some("1.5.9")).unwrap());
        assert!(per_entry_disabled(Some("1.6.0")).unwrap());
        assert!(per_entry_disabled(Some("2.0.0"))
            .unwrap_err()
            .contains("尚未验证"));
        assert!(per_entry_disabled(Some("junk"))
            .unwrap_err()
            .contains("版本"));
        // The location stays the documented file for every verified line...
        assert!(Antigravity
            .mcp_location_for_version(Scope::Global, Path::new("/h"), None, Some("1.5.9"))
            .is_some());
        assert!(Antigravity
            .mcp_location_for_version(Scope::Global, Path::new("/h"), None, None)
            .is_some());
        // ...but an unverified major keeps the contract unconfirmed.
        assert!(Antigravity
            .mcp_location_for_version(Scope::Global, Path::new("/h"), None, Some("2.0.0"))
            .is_none());
        assert!(Antigravity.mcp_requires_version());
        // Disable descriptions differ per shape.
        assert_eq!(
            Antigravity.mcp_disabled_description_for_version(Some("1.3.1")),
            Some("停用会移除原生条目，Cliora 中的定义仍保留")
        );
        assert_eq!(
            Antigravity.mcp_disabled_description_for_version(Some("1.5.9")),
            Some("停用会写入 disabled:true 并保留原生条目；启用时移除该键")
        );
        assert_eq!(
            Antigravity.mcp_disabled_description_for_version(None),
            Antigravity.mcp_disabled_description()
        );
    }

    #[test]
    fn mcp_159_writes_stamp_the_disabled_flag_and_disable_keeps_the_entry() {
        let location = mcp_location_global();
        // Create (no existing entry): the native writer stamps disabled:false.
        let stdio = Antigravity
            .mcp_document_for_version(
                &definition(McpTransport::Stdio),
                true,
                None,
                &location,
                Some("1.5.9"),
            )
            .unwrap()
            .unwrap();
        assert_eq!(stdio["disabled"], false);
        assert!(stdio.get("serverUrl").is_none());
        // Disable keeps the entry and flips the flag in place.
        let disabled = Antigravity
            .mcp_document_for_version(
                &definition(McpTransport::Stdio),
                false,
                Some(&stdio),
                &location,
                Some("1.5.9"),
            )
            .unwrap()
            .unwrap();
        assert_eq!(disabled["disabled"], true);
        assert_eq!(disabled["command"], "npx");
        // Enable removes the key entirely (implicit enabled, `agy mcp enable`).
        let enabled = Antigravity
            .mcp_document_for_version(
                &definition(McpTransport::Stdio),
                true,
                Some(&disabled),
                &location,
                Some("1.5.9"),
            )
            .unwrap()
            .unwrap();
        assert!(enabled.get("disabled").is_none());
        // An enabled write of an already-enabled native entry re-stamps
        // disabled:false, matching `agy mcp add`.
        let edited = Antigravity
            .mcp_document_for_version(
                &definition(McpTransport::Stdio),
                true,
                Some(&stdio),
                &location,
                Some("1.5.9"),
            )
            .unwrap()
            .unwrap();
        assert_eq!(edited["disabled"], false);
        // The 1.3.x line never carries the flag and still removes the entry
        // on disable.
        assert!(Antigravity
            .mcp_document_for_version(
                &definition(McpTransport::Stdio),
                true,
                None,
                &location,
                Some("1.3.1")
            )
            .unwrap()
            .unwrap()
            .get("disabled")
            .is_none());
        assert!(Antigravity
            .mcp_document_for_version(
                &definition(McpTransport::Stdio),
                false,
                Some(&stdio),
                &location,
                Some("1.3.1")
            )
            .unwrap()
            .is_none());
        // SSE stays rejected on the new line as well.
        assert!(Antigravity
            .mcp_document_for_version(
                &definition(McpTransport::Sse),
                true,
                None,
                &location,
                Some("1.5.9")
            )
            .is_err());
    }

    #[test]
    fn mcp_159_edits_canonicalize_legacy_url_entries_without_dual_writes() {
        let location = mcp_location_global();
        let legacy_http = json!({
            "url": "https://legacy.example.com/sse",
            "headers": { "X-Legacy": "fixture" },
            "trust": true
        });
        // A 1.5.9 edit rewrites the legacy key back to serverUrl and never
        // leaves both spellings on the entry; unknown fields survive.
        let rewritten = Antigravity
            .mcp_document_for_version(
                &definition(McpTransport::Http),
                true,
                Some(&legacy_http),
                &location,
                Some("1.5.9"),
            )
            .unwrap()
            .unwrap();
        assert_eq!(rewritten["serverUrl"], "https://mcp.example.com/sse");
        assert!(rewritten.get("url").is_none(), "不允许 url/serverUrl 双写");
        assert!(rewritten.get("httpUrl").is_none());
        assert_eq!(rewritten["trust"], true);
        assert_eq!(rewritten["headers"]["X-Example"], "1");
        // Disabling a legacy entry on 1.5.9 keeps it with disabled:true.
        let disabled = Antigravity
            .mcp_document_for_version(
                &definition(McpTransport::Http),
                false,
                Some(&legacy_http),
                &location,
                Some("1.5.9"),
            )
            .unwrap()
            .unwrap();
        assert_eq!(disabled["disabled"], true);
        assert!(disabled.get("url").is_none());
        assert_eq!(disabled["serverUrl"], "https://mcp.example.com/sse");
        // The 1.3.x line keeps the read-only rejection for the same entry.
        let error = Antigravity
            .mcp_document_for_version(
                &definition(McpTransport::Http),
                true,
                Some(&legacy_http),
                &location,
                Some("1.3.1"),
            )
            .unwrap_err();
        assert!(error.contains("只读保留"), "{error}");
        // A legacy entry also survives a stdio rewrite without remote keys.
        let stdio = Antigravity
            .mcp_document_for_version(
                &definition(McpTransport::Stdio),
                true,
                Some(&legacy_http),
                &location,
                Some("1.5.9"),
            )
            .unwrap()
            .unwrap();
        assert!(
            stdio.get("serverUrl").is_none()
                && stdio.get("url").is_none()
                && stdio.get("httpUrl").is_none()
        );
        assert_eq!(stdio["command"], "npx");
    }

    #[test]
    fn mcp_reads_the_159_fixture_including_the_legacy_and_disabled_entries() {
        let location = mcp_location_global();
        let parsed = crate::native::format::parse(FileKind::Json, MCP_159_FIXTURE).unwrap();
        let entries = Antigravity.mcp_entries(&parsed, &location).unwrap();
        assert_eq!(entries.len(), 3, "{entries:?}");
        // The current-key entry surfaces through the shared url view.
        let current = Antigravity.mcp_entry_view(&entries["fixture-http-current"]);
        assert_eq!(current["url"], "https://mcp.fixture.invalid/mcp");
        assert_eq!(current["serverUrl"], "https://mcp.fixture.invalid/mcp");
        assert_eq!(current["disabled"], false);
        // The legacy url entry keeps its own key and its disabled state.
        let legacy = Antigravity.mcp_entry_view(&entries["fixture-http-legacy-url"]);
        assert_eq!(legacy["url"], "https://legacy.fixture.invalid/mcp");
        assert_eq!(legacy["disabled"], true);
        // httpUrl mirrors into the shared view key as well.
        let http_url_only = json!({"httpUrl": "https://older.example.invalid/mcp"});
        assert_eq!(
            Antigravity.mcp_entry_view(&http_url_only)["url"],
            "https://older.example.invalid/mcp"
        );
        // stdio entries read unchanged.
        let stdio = Antigravity.mcp_entry_view(&entries["fixture-stdio"]);
        assert_eq!(stdio["command"], "/bin/cat");
        assert_eq!(stdio["env"]["FIXTURE_MODE"], "sanitized");
    }

    #[test]
    fn dual_history_roots_follow_the_documented_layouts() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let gemini = home.join(".gemini");
        assert_eq!(data_root(home), gemini.join("antigravity"));
        assert_eq!(cli_data_root(home), gemini.join("antigravity-cli"));
        // Resume targets the chosen conversation id on either layout, never
        // an implicit "latest" continuation.
        let cli_id = "conv_159_root_0000000000000000000000000a1";
        assert_eq!(
            Antigravity.launch_args(Some(cli_id), LaunchMode::Normal).unwrap(),
            vec!["--conversation", cli_id]
        );
        assert_eq!(
            Antigravity.launch_args(Some(cli_id), LaunchMode::Yolo).unwrap(),
            vec!["--conversation", cli_id, "--dangerously-skip-permissions"]
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
        // A skill is `<dir>/SKILL.md` on both verified install lines; the
        // 1.5.9 /skills panel and plugin validate both require the manifest.
        assert!(Antigravity.skill_requires_manifest());
        // The product panel's extra discovery roots are read-only
        // observations of the global scope only.
        assert!(Antigravity.skill_observations(Scope::Project, temp.path(), Some(&project)).is_empty());
        let observations = Antigravity.skill_observations(Scope::Global, temp.path(), None);
        let roots: Vec<String> = observations
            .iter()
            .map(|observation| observation.root.display().to_string().replace('\\', "/"))
            .collect();
        assert_eq!(
            roots,
            vec![
                gemini_root(temp.path()).join("skills").display().to_string().replace('\\', "/"),
                gemini_root(temp.path()).join("config").join("skills").display().to_string().replace('\\', "/"),
                gemini_root(temp.path()).join("antigravity-cli").join("builtin").join("skills").display().to_string().replace('\\', "/"),
            ]
        );
        // Same-name sources are marked, not guessed: the native precedence
        // itself was never observed.
        assert!(Antigravity.skill_marks_duplicate_names());
        // Enabling a contract-breaking package is refused instead of claiming
        // agy will load it (frontmatter name/description verified contract).
        let reason = Antigravity.skill_enable_requires_contract().unwrap();
        assert!(reason.contains("frontmatter"), "{reason}");
    }

    #[test]
    fn skill_declarations_come_from_the_workspace_skills_json_only() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        std::fs::create_dir_all(project.join(".agents")).unwrap();
        // No manifest, no declared sources; the global scope never declares.
        assert!(Antigravity.skill_declarations(Scope::Global, temp.path(), None).is_empty());
        assert!(Antigravity.skill_declarations(Scope::Project, temp.path(), Some(&project)).is_empty());
        std::fs::write(
            project.join(".agents").join("skills.json"),
            r#"{"entries":[{"path":"shared-skills","exclude":["experimental-.*"]}]}"#,
        )
        .unwrap();
        std::fs::create_dir_all(project.join("shared-skills").join("linter-skill")).unwrap();
        std::fs::create_dir_all(project.join("shared-skills").join("experimental-mock")).unwrap();
        let declarations = Antigravity.skill_declarations(Scope::Project, temp.path(), Some(&project));
        assert_eq!(declarations.len(), 1, "{declarations:?}");
        assert_eq!(
            declarations[0].root,
            project.join("shared-skills").join("linter-skill")
        );
        assert_eq!(declarations[0].label, "skills.json · shared-skills");
    }

    #[test]
    fn remote_skill_directories_mirror_the_verified_global_discovery_roots() {
        let directories = Antigravity.remote_skill_directories();
        let writable: Vec<&str> = directories
            .iter()
            .filter(|directory| !directory.read_only)
            .map(|directory| directory.relative)
            .collect();
        assert_eq!(writable, vec![".gemini/antigravity-cli/skills"]);
        let read_only: Vec<&str> = directories
            .iter()
            .filter(|directory| directory.read_only)
            .map(|directory| directory.relative)
            .collect();
        assert_eq!(
            read_only,
            vec![
                ".gemini/skills",
                ".gemini/config/skills",
                ".gemini/antigravity-cli/builtin/skills",
            ]
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
        // Agents: standalone agent.md directories verified by the 1.5.9
        // evidence run. Plugins (native `agy plugin` storage undocumented),
        // accounts (keyring login never adopted) and official quota (/usage is
        // a TUI panel) stay absent.
        assert!(Antigravity.configuration().is_none());
        assert!(Antigravity.agents().is_some());
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
        let keys = MemoryStore;
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
        let association = Antigravity.history_association().expect("association");
        assert_eq!(association.state, "available");
        assert!(!association.reason.trim().is_empty());
        assert_ne!(association.reason, crate::adapters::HISTORY_ASSOCIATION_UNAVAILABLE_REASON);
        assert_eq!(
            crate::adapters::history_association_facet(&Antigravity).unwrap().state,
            "available"
        );
        assert!(descriptor.login.is_none());
        assert!(descriptor.management.mcp && descriptor.management.skills);
        assert!(!descriptor.management.accounts);
        assert!(descriptor.management.agents);
        assert!(!descriptor.management.plugins);
        assert!(!descriptor.management.rules.global && !descriptor.management.rules.project);
    }

    #[test]
    fn agent_selection_args_are_version_gated_and_never_touch_other_flags() {
        // The capability probe (descriptor / remote) sees the verified flag.
        assert_eq!(
            Antigravity.launch_agent_args(Some("probe-main")).unwrap(),
            vec!["--agent", "probe-main"]
        );
        assert!(Antigravity.launch_agent_args(None).unwrap().is_empty());
        // The local launch path follows the identified install line: 1.5+
        // carries the verified flag, older or unverified lines refuse it.
        assert_eq!(
            Antigravity
                .launch_agent_args_for_version("1.5.9", Some("probe-main"))
                .unwrap(),
            vec!["--agent", "probe-main"]
        );
        assert!(Antigravity
            .launch_agent_args_for_version("1.3.1", Some("probe-main"))
            .unwrap_err()
            .contains("尚未验证"));
        assert!(Antigravity
            .launch_agent_args_for_version("2.0.0", Some("probe-main"))
            .unwrap_err()
            .contains("尚未验证"));
        assert!(Antigravity
            .launch_agent_args_for_version("junk", Some("probe-main"))
            .unwrap_err()
            .contains("版本号"));
        assert!(Antigravity
            .launch_agent_args_for_version("1.5.9", None)
            .unwrap()
            .is_empty());
        // The published catalog derives launchability from the port, and the
        // default trait refuses selections for every other CLI.
        assert!(crate::adapters::PublishedDescriptor::from_adapter(&Antigravity).agent_launch_available);
        let grok = crate::adapters::Registry::builtins().get("grok").unwrap();
        assert!(!crate::adapters::PublishedDescriptor::from_adapter(grok).agent_launch_available);
        assert!(grok.launch_agent_args(Some("probe")).is_err());
        assert!(grok.launch_agent_args(None).unwrap().is_empty());
        // Only antigravity has verified the flag so far: no other builtin
        // publishes agent launchability.
        let publishers: Vec<&str> = crate::adapters::Registry::builtins()
            .iter()
            .filter(|adapter| {
                crate::adapters::PublishedDescriptor::from_adapter(*adapter).agent_launch_available
            })
            .map(crate::adapters::contract::CliAdapter::id)
            .collect();
        assert_eq!(publishers, ["antigravity"]);
    }
}
