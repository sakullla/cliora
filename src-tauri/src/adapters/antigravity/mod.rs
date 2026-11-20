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
//! * **Settings** (1.5.9 evidence run, see [`configuration`]): the signed-in
//!   machine's `antigravity-cli/settings.json` held exactly `model` (the
//!   display-name string the native `/model` panel persists) and
//!   `trustedWorkspaces` (the folder-trust prompt's string array). The typed
//!   port maps only those two keys, and only on the resolved 1.5 native form;
//!   1.3.x and unverified installations keep the raw JSON editor with no
//!   typed write. Unknown fields are preserved through the shared apply path.
//!   Session-only launch flags (`--model`, `--mode accept-edits|auto|plan`,
//!   `--effort low|medium|high|xhigh|max`) never persist — the native
//!   `/config` panel holds no model/effort entries. They are published as
//!   adapter-owned launch capabilities on the resolved 1.5 install line:
//!   `--model` rides the project model preference and mode/effort are
//!   validated session options; older or unverified installs publish neither
//!   and receive no extra argument.
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
//! * **Plugins** (1.5.9 evidence run, see [`plugins`]): installs are
//!   directories under `~/.gemini/config/plugins/<name>/`; enable/disable is
//!   a ledger inside `~/.gemini/config/config.json`
//!   (`plugins.<dir>.enabled` — separate from the plugin tree, so toggles
//!   never rewrite plugin files; `plugin uninstall` removes the row
//!   natively). Listing is file-backed; install/uninstall run
//!   `agy plugin install|uninstall` through the shared native command
//!   channel, enable/disable are shared-transaction ledger writes. Builtins
//!   surface read-only (the real machine's `swarm` is a ledger row without
//!   an install directory). The contract is verified on the 1.5 line only,
//!   so mutations are gated to `>=1.5.0, <2.0.0`.
//! * **Rules** (1.5.9 evidence run, see [`rules`]): plain markdown only. The
//!   single-file port manages the hierarchical AGENTS.md standard — global
//!   `~/.gemini/config/AGENTS.md` and `<project>/AGENTS.md`, also the
//!   long-term-rule distribution targets — and the catalog port covers both
//!   scopes: trigger-frontmatter `.md` directory rules
//!   (`<project>/.agents/rules/` and `~/.gemini/config/rules/`, removable
//!   and toggleable through the `.cliora-disabled-rules` relocation slot)
//!   plus every hierarchical `AGENTS.md`/`GEMINI.md` in the tree (editable,
//!   never removed or toggled). Plugin rules stay plugin-detail read-only
//!   resources; no formats are converted into each other.
//! * **Hooks** (1.5.9 evidence run, see [`hooks`]): standalone documents at
//!   `<workspace>/.agents/hooks.json` and `~/.gemini/config/hooks.json` are
//!   declared native-file roles and edited through the registered-file path;
//!   plugin-root `hooks.json` files are editable in place through the shared
//!   plugin-file write path (adapter-declared editability + schema check).
//!   Both validate the named-hooks contract before any write and leave the
//!   original file unchanged on rejection. There is no separate Hooks
//!   lifecycle surface: plugin hooks follow their plugin's enable state and
//!   stay distinct from the standalone files.
//! * Quota: no verified contract (`/usage` is a TUI subscription panel, not
//!   a local statistic) — that port stays absent by design.

pub(crate) mod agents;
pub(crate) mod configuration;
pub(crate) mod history;
pub(crate) mod hooks;
pub(crate) mod memory;
pub(crate) mod plugins;
pub(crate) mod protobuf;
pub(crate) mod rules;
pub(crate) mod skills;

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::{
    file, AdapterDescriptor, CliAdapter, Facet, InspectionFields, LaunchMode, ManagementCapabilities,
    McpLocation, RuleFileSpec, RuleKindPolicy, RuleSupport, SkillDeclaration, SkillObservation,
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

const REMOTE_NATIVE_DOCUMENTS: &[super::RemoteNativeDocument] = &[
    super::RemoteNativeDocument {
        role: "settings",
        relative: ".gemini/antigravity-cli/settings.json",
        format: "json",
        scope: "global",
    },
    super::RemoteNativeDocument {
        role: "hooks",
        relative: ".gemini/config/hooks.json",
        format: "json",
        scope: "global",
    },
    super::RemoteNativeDocument {
        role: "mcp",
        relative: ".agents/mcp_config.json",
        format: "json",
        scope: "project",
    },
    super::RemoteNativeDocument {
        role: "hooks",
        relative: ".agents/hooks.json",
        format: "json",
        scope: "project",
    },
];

pub struct Antigravity;

impl CliAdapter for Antigravity {
    fn remote_resource_layout(&self) -> super::RemoteResourceLayout {
        super::RemoteResourceLayout {
            mcp: Some(super::RemoteMcpLayout {
                relative: ".gemini/config/mcp_config.json",
                format: "json",
                table: "mcpServers",
                nested: false,
            }),
            skill_root: Some(".gemini/antigravity-cli/skills"),
            agent_root: Some(".gemini/config/agents"),
            agent_extension: Some("md"),
        }
    }
    fn remote_native_documents(&self) -> &'static [super::RemoteNativeDocument] {
        REMOTE_NATIVE_DOCUMENTS
    }
    fn parse_remote_mcp(&self, text: &str) -> Result<Value, String> {
        parse_remote_mcp_document(text)
    }
    fn render_remote_mcp(&self, text: &str, value: &Value) -> Result<Vec<u8>, String> {
        render_remote_mcp_document(text, value)
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
            Scope::Global => vec![
                file(
                    "settings",
                    gemini_root(home)
                        .join("antigravity-cli")
                        .join("settings.json"),
                    FileKind::Json,
                    known,
                    Some("Antigravity CLI（agy）设置（纯 JSON）；keyring 登录态不接管，headless 密钥经 GEMINI_API_KEY 注入"),
                    false,
                ),
                // Standalone global hooks (1.5.9 evidence): a native file the
                // loader reads alongside the plugin roots; editing goes through
                // the registered-file editor with the adapter schema check.
                file(
                    "hooks",
                    gemini_root(home).join("config").join("hooks.json"),
                    FileKind::Json,
                    known,
                    Some("独立全局 Hooks（~/.gemini/config/hooks.json，非插件）；命名 hook/事件/command 处理器契约按 1.5.9 实证校验后写入"),
                    false,
                ),
            ],
            Scope::Project => {
                // Runtime project MCP scope (1.5.9 evidence): sessions load
                // `<workspace>/.agents/mcp_config.json`, but `agy mcp`
                // subcommands manage only the user-level global file. Cliora
                // edits this file directly through the registered-file path,
                // which the shared transaction service protects.
                let Some(project) = project else {
                    return Vec::new();
                };
                vec![
                    file(
                        "mcp",
                        project.join(".agents").join("mcp_config.json"),
                        FileKind::Json,
                        known,
                        Some("项目级 MCP 运行时作用域（.agents/mcp_config.json）；agy mcp 子命令不管理此文件，仅在会话内加载"),
                        false,
                    ),
                    // Standalone project hooks (1.5.9 evidence:
                    // `<workspace>/.agents/hooks.json`).
                    file(
                        "hooks",
                        project.join(".agents").join("hooks.json"),
                        FileKind::Json,
                        known,
                        Some("独立项目 Hooks（.agents/hooks.json，非插件）；命名 hook/事件/command 处理器契约按 1.5.9 实证校验后写入"),
                        false,
                    ),
                ]
            }
        }
    }
    fn interface_formats(&self) -> &'static [&'static str] {
        &[]
    }
    fn file_kind(&self, role: &str) -> Result<FileKind, String> {
        if role == "settings" || role == "mcp" || role == "hooks" {
            Ok(FileKind::Json)
        } else {
            Err("Antigravity 不支持此原生文件角色".into())
        }
    }
    /// The standalone hooks documents are validated against the 1.5.9 named
    /// hooks contract before any write (see [`hooks`]); settings and the
    /// project MCP file carry no adapter-level document restriction beyond
    /// being JSON.
    fn validate_draft(&self, role: &str, parsed: &Value) -> Result<(), String> {
        if role == "hooks" {
            hooks::validate_document(parsed)
        } else {
            Ok(())
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
        profile: &crate::native::profile::RegisteredProfile,
        _scope: Scope,
        _credentials: &dyn crate::credentials::CredentialStore,
        _secrets: &mut crate::native::apply::NativeSecrets,
    ) -> Result<(), String> {
        if profile.connection.is_none()
            && profile.native_credentials.is_empty()
            && matches!(
                profile.authentication,
                crate::native::profile::ProfileAuthentication::Native
            )
        {
            // A settings-only application still traverses the shared secret
            // plan; there is no credential mutation for an agy settings draft.
            return Ok(());
        }
        Err("Antigravity 不向 settings.json 写入密钥；headless GEMINI_API_KEY 只在启动时注入".into())
    }
    fn has_native_secret(&self, _role: &str, _root: &Value) -> bool {
        false
    }
    fn configuration(&self) -> Option<&dyn super::configuration::ConfigurationAdapter> {
        // Typed settings port (see [`configuration`]): only the two persisted
        // keys verified on the 1.5.9 evidence machine are mapped; everything
        // else stays raw JSON with unknown-field preservation.
        Some(self)
    }
    /// 1.5.9 verified settings keys: `model` is the display-name string the
    /// native `/model` panel persists; no other inspection field is verified.
    fn inspect_values(
        &self,
        settings: &Value,
        _local_settings: &Value,
        _models: &Value,
    ) -> InspectionFields {
        InspectionFields {
            model: crate::native::intake::string_at(settings, &["model"]).map(str::to_owned),
            ..InspectionFields::default()
        }
    }
    /// The per-project model preference is the verified channel for the
    /// session-only `--model <id-or-name>` flag (`agy --help`, 1.5.9).
    fn supports_project_model_override(&self) -> bool {
        true
    }
    /// `--model` was verified on the 1.5 line only; older and unverified
    /// installs neither publish the field nor receive the flag.
    fn project_model_override_range(&self) -> Option<(&'static str, &'static str)> {
        Some(("1.5", "2.0"))
    }
    fn project_model_args(&self, model: Option<&str>) -> Result<Vec<String>, String> {
        let Some(model) = model else {
            return Ok(Vec::new());
        };
        let trimmed = model.trim();
        if trimmed.is_empty() {
            return Err("请输入 Antigravity 启动模型（--model 的模型 ID 或名称）".into());
        }
        if trimmed.chars().count() > 200 || trimmed.chars().any(char::is_control) {
            return Err("Antigravity 启动模型名称无效；未执行启动".into());
        }
        Ok(vec!["--model".into(), trimmed.to_owned()])
    }
    /// Verified session-only flags of the 1.5.9 `--help`: execution mode and
    /// reasoning effort. No native default was evidenced for either flag, so
    /// leaving a selector unset passes no argument.
    fn launch_session_option_specs(&self) -> Vec<super::LaunchSessionOption> {
        vec![
            super::LaunchSessionOption {
                id: "mode",
                label: "执行模式",
                label_en: Some("Execution mode"),
                choices: configuration::MODE_VALUES,
                default: None,
            },
            super::LaunchSessionOption {
                id: "effort",
                label: "推理强度",
                label_en: Some("Reasoning effort"),
                choices: configuration::EFFORT_VALUES,
                default: None,
            },
        ]
    }
    fn launch_session_options_range(&self) -> Option<(&'static str, &'static str)> {
        Some(("1.5", "2.0"))
    }
    fn launch_session_args(
        &self,
        version: Option<&str>,
        options: &std::collections::BTreeMap<String, String>,
    ) -> Result<Vec<String>, String> {
        if options.is_empty() {
            return Ok(Vec::new());
        }
        let published = self.launch_session_options(version);
        if published.is_empty() {
            return Err("Antigravity 会话参数仅在已核验的 1.5 安装可用；请升级 CLI".into());
        }
        // Adapter-owned mapping in the published order keeps the argument
        // list deterministic; the shared launch service already validated the
        // ids and choices, and this repeats it instead of forwarding unknowns.
        let mut args = Vec::new();
        for option in &published {
            let Some(value) = options.get(option.id) else {
                continue;
            };
            if value.is_empty() || !option.choices.contains(&value.as_str()) {
                return Err(format!("Antigravity 会话参数 {} 的取值无效：{value}", option.id));
            }
            match option.id {
                "mode" => args.extend(["--mode".into(), value.clone()]),
                "effort" => args.extend(["--effort".into(), value.clone()]),
                other => return Err(format!("Antigravity 未发布会话参数 {other}")),
            }
        }
        if let Some(unknown) = options.keys().find(|id| !published.iter().any(|option| option.id == id.as_str())) {
            return Err(format!("Antigravity 未发布会话参数 {unknown}"));
        }
        Ok(args)
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
    fn plugins(&self) -> Option<&dyn super::plugins::PluginAdapter> {
        Some(self)
    }
    /// Single-file port: the hierarchical AGENTS.md standard the CLI always
    /// reads on both scopes (see [`rules`]). This is also the long-term-rule
    /// distribution target through the shared service.
    fn rule_path(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<PathBuf> {
        rules::rule_path(scope, home, project)
    }
    // The catalog port covers both scopes: the evidence-verified directory
    // rules exist per project (`.agents/rules/`) and globally
    // (`~/.gemini/config/rules/`), so the shared project-only default is
    // widened by declaration here instead of by the shared service.
    fn uses_rule_catalog(&self, _scope: Scope) -> bool {
        true
    }
    fn rule_file_specs(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Result<Vec<RuleFileSpec>, String> {
        rules::list_specs(scope, home, project)
    }
    fn rule_kind_policy(&self, kind: &str) -> RuleKindPolicy {
        rules::kind_policy(kind)
    }
    fn rule_create_path_scoped(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
        name: &str,
    ) -> Result<PathBuf, String> {
        rules::create_path(scope, home, project, name)
    }
    fn rule_relocate_scoped(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
        path: &Path,
        enabled: bool,
    ) -> Result<PathBuf, String> {
        rules::relocate(scope, home, project, path, enabled)
    }
    // Created rules carry the verified `always_on` trigger frontmatter so
    // agy actually loads them; the historical heading-only default would
    // produce a file whose load behavior is unverified.
    fn rule_create_template(&self, path: &Path, name: &str) -> String {
        rules::create_template(path, name)
    }
    fn rule_support(&self) -> RuleSupport {
        RuleSupport {
            global: true,
            project: true,
            global_reason: "",
            project_reason: "",
            catalog: true,
            catalog_global: true,
        }
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
    fn remote_history_layout(&self) -> Option<super::RemoteHistoryLayout> {
        Some(super::RemoteHistoryLayout {
            relative: ".gemini/antigravity-cli", fallbacks: &[".gemini/antigravity"], pinned: &[], sessions: &["transcript_full.jsonl"], companion: None,
            order: super::RemoteHistoryOrder::MtimeDesc, catalogs: &[],
            sqlite: Some(super::RemoteHistorySqlite {
                index: "conversation_summaries.db",
                files: &["brain/{id}/.system_generated/logs/transcript_full.jsonl", "conversations/{id}.db"],
                file_tables: &["gen_metadata"],
                tables: &[
                    super::RemoteHistoryTable {
                        name: "conversation_summaries",
                        query: "WITH roots AS (SELECT conversation_id FROM conversation_summaries WHERE parent_conversation_id IS NULL OR trim(parent_conversation_id) = '' ORDER BY last_modified_time DESC LIMIT :limit) SELECT conversation_id,title,workspace_uris,status,parent_conversation_id,last_modified_time FROM conversation_summaries WHERE conversation_id IN roots OR parent_conversation_id IN roots",
                        required_columns: &["conversation_id", "workspace_uris", "last_modified_time", "parent_conversation_id"], id: Some("conversation_id"), link: None,
                    },
                    super::RemoteHistoryTable {
                        name: "conversation_summaries",
                        query: "WITH roots AS (SELECT id FROM conversation_summaries WHERE parent_conversation_id IS NULL OR trim(parent_conversation_id) = '' ORDER BY rowid DESC LIMIT :limit) SELECT id,title,workspace,status,parent_conversation_id FROM conversation_summaries WHERE id IN roots OR parent_conversation_id IN roots",
                        required_columns: &["id", "workspace", "parent_conversation_id"], id: Some("id"), link: None,
                    },
                ],
            }),
        })
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
            configuration: self
                .configuration()
                .map(|port| port.describe(Scope::Global)),
            name: self.name(),
            interface_formats: self.interface_formats(),
            project_model_override: self.supports_project_model_override(),
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
                reason: "MCP（~/.gemini/config/mcp_config.json mcpServers：stdio command/args/env/cwd 与远程 serverUrl+headers/oauth；1.5+ 按实测写逐条 disabled（停用保留条目），1.3.x 停用移除条目且旧版 url/httpUrl 条目只读；项目 .agents/mcp_config.json 为运行时作用域，agy mcp 子命令不管理）、Skills（可写根 antigravity-cli/skills 与项目 .agents/skills；只读发现 Shared ~/.gemini/skills、config 目录、builtin 与 skills.json 声明目录；SKILL.md frontmatter name/description 契约强制）、Agents（独立定义 <project>/.agents/agents/{name}/agent.md 与 ~/.gemini/config/agents/{name}/agent.md；mainAgent/subagent 决定 --agent 启动名单；插件 Agent 随插件只读管理）、Plugins（~/.gemini/config/plugins/ 目录 + config.json plugins.<目录>.enabled 分类账；安装/卸载走原生命令，启停写分类账（重装后保留用户选择）；详情列出 Skills/Agents/规则/MCP/Hooks 五类资源；内置插件只读，1.5 以下安装线拒绝写入）与 Rules（纯 Markdown：单文件端口管理全局 ~/.gemini/config/AGENTS.md 与项目 <project>/AGENTS.md；目录端口覆盖全局 ~/.gemini/config/rules/ 与项目 .agents/rules/ 触发式 .md 规则及全部层级 AGENTS.md/GEMINI.md，目录规则可删除/启停，层级文件只编辑；插件规则随插件详情只读）与 Hooks（独立全局 ~/.gemini/config/hooks.json 与项目 .agents/hooks.json 为原生文件角色，插件根 hooks.json 经插件详情受控编辑；写入前按 1.5.9 实证命名 hook/事件/command 处理器契约校验，禁用插件的 Hook 不视为全局生效）由原生路径提供",
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
                plugins: self
                    .plugins()
                    .is_some_and(|adapter| !adapter.capability().actions.is_empty()),
                project_plugins: self.plugins().is_some_and(|adapter| adapter.capability().project),
                rules: self.rule_support(),
                memory: self.published_memory(),
                // No editable native memory store exists on any verified
                // line (1.3.1 verdict confirmed by the 1.5.9 evidence run);
                // the recorded reason reaches the shared UI instead of a
                // hidden memory tab.
                memory_reason: memory::UNVERIFIED_REASON,
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

fn valid_remote_mcp_name(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 160 && !value.chars().any(char::is_control)
}

fn parse_remote_mcp_document(text: &str) -> Result<Value, String> {
    if text.trim().is_empty() {
        return Ok(json!({ "entries": [], "definitions": [] }));
    }
    let document: Value =
        serde_json::from_str(text).map_err(|e| format!("远程 MCP JSON 无效：{e}"))?;
    let entries: Vec<Value> = document
        .get("mcpServers")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .map(|(name, server)| {
            let url = ["serverUrl", "url", "httpUrl"]
                .into_iter()
                .find_map(|key| server.get(key).and_then(Value::as_str))
                .unwrap_or_default();
            let transport = if url.is_empty() { "stdio" } else { "http" };
            let enabled = if server.get("disabled").and_then(Value::as_bool) == Some(true) {
                false
            } else {
                server
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(true)
            };
            json!({
                "name": name,
                "transport": transport,
                "cwd": server.get("cwd").and_then(Value::as_str).unwrap_or_default(),
                "command": server.get("command").and_then(Value::as_str).unwrap_or_default(),
                "args": server.get("args").cloned().unwrap_or_else(|| json!([])),
                "url": url,
                "env": server.get("env").cloned().unwrap_or_else(|| json!({})),
                "headers": server.get("headers").cloned().unwrap_or_else(|| json!({})),
                "inLibrary": false,
                "enabled": enabled,
                "protectedValues": false
            })
        })
        .collect();
    Ok(json!({ "entries": entries, "definitions": [] }))
}

fn render_remote_mcp_document(text: &str, value: &Value) -> Result<Vec<u8>, String> {
    let mut document = if text.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str::<Value>(text)
            .map_err(|error| format!("远程配置不是 JSON 对象：{error}"))?
    };
    let on_disk = document.get("mcpServers").cloned();
    let entries = value
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut servers = serde_json::Map::new();
    for item in entries {
        let Some(name) = item
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| valid_remote_mcp_name(name))
        else {
            continue;
        };
        let existing = on_disk
            .as_ref()
            .and_then(|map| map.get(name))
            .and_then(Value::as_object);
        let mut server = existing.cloned().unwrap_or_default();
        let transport = item
            .get("transport")
            .and_then(Value::as_str)
            .unwrap_or("stdio");
        if transport == "sse" {
            return Err(
                "Antigravity 没有已确认的旧版 HTTP+SSE 映射，未改写为 Streamable HTTP".into(),
            );
        }
        if transport == "http" {
            for key in ["command", "args", "env", "cwd", "url", "httpUrl"] {
                server.remove(key);
            }
            if let Some(url) = item.get("url").and_then(Value::as_str) {
                server.insert("serverUrl".into(), Value::String(url.into()));
            }
            match item.get("headers").and_then(Value::as_object) {
                Some(headers) if !headers.is_empty() => {
                    server.insert("headers".into(), Value::Object(headers.clone()));
                }
                _ => {
                    server.remove("headers");
                }
            }
        } else {
            for key in ["serverUrl", "url", "httpUrl", "headers"] {
                server.remove(key);
            }
            if let Some(command) = item.get("command").and_then(Value::as_str) {
                server.insert("command".into(), Value::String(command.into()));
            }
            match item.get("args").and_then(Value::as_array) {
                Some(args) if !args.is_empty() => {
                    server.insert("args".into(), Value::Array(args.clone()));
                }
                _ => {
                    server.remove("args");
                }
            }
            match item.get("env").and_then(Value::as_object) {
                Some(env) if !env.is_empty() => {
                    server.insert("env".into(), Value::Object(env.clone()));
                }
                _ => {
                    server.remove("env");
                }
            }
            match item
                .get("cwd")
                .and_then(Value::as_str)
                .filter(|cwd| !cwd.is_empty())
            {
                Some(cwd) => {
                    server.insert("cwd".into(), Value::String(cwd.into()));
                }
                None => {
                    server.remove("cwd");
                }
            }
        }
        server.remove("enabled");
        let enabled = item
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let was_disabled = existing
            .and_then(|map| map.get("disabled"))
            == Some(&Value::Bool(true));
        if !enabled {
            server.insert("disabled".into(), Value::Bool(true));
        } else if was_disabled {
            server.remove("disabled");
        }
        servers.insert(name.into(), Value::Object(server));
    }
    let object = document
        .as_object_mut()
        .ok_or_else(|| "远程配置不是 JSON 对象".to_owned())?;
    object.insert("mcpServers".into(), Value::Object(servers));
    serde_json::to_vec_pretty(&document).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::LaunchForm;
    use crate::native::adapter::Scope;

    #[derive(Default)]
    struct MemoryStore(std::cell::RefCell<std::collections::BTreeMap<String, String>>);
    impl crate::credentials::CredentialStore for MemoryStore {
        fn put(&self, id: &str, secret: &str) -> Result<(), String> {
            self.0.borrow_mut().insert(id.into(), secret.into());
            Ok(())
        }
        fn get(&self, id: &str) -> Result<String, String> {
            self.0.borrow().get(id).cloned().ok_or_else(|| "missing".into())
        }
        fn delete(&self, id: &str) -> Result<(), String> {
            self.0.borrow_mut().remove(id);
            Ok(())
        }
    }

    const NATIVE_FIXTURE: &str =
        include_str!("../../../../tests/fixtures/native/antigravity-cli-1.3.json");

    // Sanitized 1.5.9 settings sample (verified keys: model display name +
    // trustedWorkspaces) pinned by the remote evidence run.
    const SETTINGS_159_FIXTURE: &str =
        include_str!("../../../../tests/fixtures/native/antigravity-cli-1.5.9.json");

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
        assert_eq!(global.len(), 2);
        assert_eq!(global[0].role, "settings");
        assert_eq!(global[0].format, "json");
        assert!(
            global[0]
                .path
                .replace('\\', "/")
                .ends_with(".gemini/antigravity-cli/settings.json")
        );
        // Standalone global hooks are a declared native-file role (1.5.9
        // evidence: ~/.gemini/config/hooks.json), edited through the
        // registered-file path with the adapter schema check.
        assert_eq!(global[1].role, "hooks");
        assert_eq!(global[1].format, "json");
        assert!(global[1].writable);
        assert!(!global[1].sensitive);
        assert!(
            global[1]
                .path
                .replace('\\', "/")
                .ends_with(".gemini/config/hooks.json")
        );
        assert!(Antigravity.native_files(Scope::Project, home, None, true).is_empty());
        // The project runtime MCP scope is a native config file role: `agy mcp`
        // subcommands manage only the user-level global file (1.5.9 evidence).
        let project = Antigravity.native_files(Scope::Project, home, Some(Path::new("/work/p")), true);
        assert_eq!(project.len(), 2);
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
        // Standalone project hooks: <workspace>/.agents/hooks.json.
        assert_eq!(project[1].role, "hooks");
        assert!(project[1].writable);
        assert!(
            project[1]
                .path
                .replace('\\', "/")
                .ends_with("/work/p/.agents/hooks.json")
        );
        assert_eq!(Antigravity.file_kind("settings").unwrap(), FileKind::Json);
        assert_eq!(Antigravity.file_kind("mcp").unwrap(), FileKind::Json);
        assert_eq!(Antigravity.file_kind("hooks").unwrap(), FileKind::Json);
        assert!(Antigravity.file_kind("config").is_err());
        // The hooks role validates the named-hooks contract before any write;
        // the other roles carry no adapter document restriction.
        assert!(Antigravity
            .validate_draft(
                "hooks",
                &serde_json::json!({"a": {"Stop": [{"type": "command", "command": "/bin/true"}]}})
            )
            .is_ok());
        assert!(Antigravity
            .validate_draft("hooks", &serde_json::json!({"a": {"SessionEnd": []}}))
            .is_err());
        assert!(Antigravity
            .validate_draft(
                "settings",
                &serde_json::json!({"anything": "unchanged"})
            )
            .is_ok());
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
        // 1.5.9 typed settings: only the verified display-name string maps to
        // the inspection model; the 1.3.x sample keeps a null model.
        let parsed_159 =
            crate::native::format::parse(FileKind::Json, SETTINGS_159_FIXTURE).unwrap();
        assert_eq!(
            Antigravity
                .inspect_values(&parsed_159, &Value::Null, &Value::Null)
                .model
                .as_deref(),
            Some("Gemini 4 Carbon (Medium)")
        );
        assert!(Antigravity
            .inspect_values(&parsed, &Value::Null, &Value::Null)
            .model
            .is_none());
        // The typed settings port is registered and describes exactly the two
        // verified keys; the project model preference carries --model.
        let port = Antigravity
            .configuration()
            .expect("typed settings port");
        assert_eq!(
            port.describe(Scope::Global)
                .fields
                .iter()
                .map(|field| field.id.as_str())
                .collect::<Vec<_>>(),
            vec!["model", "trustedWorkspaces"]
        );
        assert!(Antigravity.supports_project_model_override());
        assert_eq!(Antigravity.project_model_override_range(), Some(("1.5", "2.0")));
        assert_eq!(
            Antigravity
                .project_model_args_for_version(Some("1.5.9"), Some("Gemini 4 Carbon (Medium)"))
                .unwrap(),
            vec!["--model".to_string(), "Gemini 4 Carbon (Medium)".to_string()]
        );
        assert!(Antigravity
            .project_model_args_for_version(Some("1.3.1"), Some("Gemini 4 Carbon (Medium)"))
            .is_err());
        assert!(Antigravity
            .project_model_args_for_version(Some("1.3.1"), None)
            .unwrap()
            .is_empty());
        let options = Antigravity.launch_session_options(Some("1.5.9"));
        assert_eq!(
            options.iter().map(|option| option.id).collect::<Vec<_>>(),
            vec!["mode", "effort"]
        );
        assert_eq!(options[0].choices, ["accept-edits", "auto", "plan"]);
        assert_eq!(options[1].choices, ["low", "medium", "high", "xhigh", "max"]);
        assert!(Antigravity.launch_session_options(Some("1.3.1")).is_empty());
        assert!(Antigravity.launch_session_options(None).is_empty());
        let chosen = std::collections::BTreeMap::from([
            ("mode".to_string(), "plan".to_string()),
            ("effort".to_string(), "high".to_string()),
        ]);
        assert_eq!(
            Antigravity.launch_session_args(Some("1.5.9"), &chosen).unwrap(),
            vec!["--mode", "plan", "--effort", "high"]
        );
        assert!(Antigravity.launch_session_args(Some("1.3.1"), &chosen).is_err());
        assert!(Antigravity
            .launch_session_args(
                Some("1.5.9"),
                &std::collections::BTreeMap::from([("mode".to_string(), "bogus".to_string())]),
            )
            .is_err());
        assert!(Antigravity
            .launch_session_args(
                Some("1.5.9"),
                &std::collections::BTreeMap::from([("invented".to_string(), "plan".to_string())]),
            )
            .is_err());
        assert!(Antigravity.project_model_args(None).unwrap().is_empty());
        assert!(Antigravity.project_model_args(Some("  ")).is_err());
        assert!(Antigravity.project_model_args(Some("two\nlines")).is_err());
    }

    #[test]
    fn standalone_hooks_roles_edit_through_the_registered_file_path() {
        // ADR-8.2: the standalone hooks documents are plain native-file
        // roles — the existing registered-file editor reads, schema-validates
        // and saves them; every rejection leaves the original unchanged.
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let db = crate::database::Database::open(&home.join("hooks.db")).unwrap();
        let store = MemoryStore::default();
        let registry = crate::adapters::Registry::builtins();
        let global = gemini_root(home).join("config").join("hooks.json");
        std::fs::create_dir_all(global.parent().unwrap()).unwrap();
        let original = "{\n  \"workspace-hook\": {\n    \"Stop\": [\n      { \"type\": \"command\", \"command\": \"/bin/true\" }\n    ]\n  }\n}\n";
        std::fs::write(&global, original).unwrap();

        // A valid edit saves through the shared transaction.
        let edited = original.replace("\"/bin/true\"", "\"./after.sh\"");
        crate::adapters::save_registered_text(&registry, "antigravity", "hooks", Scope::Global, home, None, "1.5.9", &db, &store, original, &edited).unwrap();
        let after = std::fs::read_to_string(&global).unwrap();
        assert!(after.contains("./after.sh"), "{after}");

        // An unsupported structure or invalid JSON is refused before the
        // write; the file keeps its content.
        let current = after;
        for bad in [
            current.replace("\"Stop\"", "\"SessionEnd\""),
            "{not json".to_string(),
        ] {
            let error = crate::adapters::save_registered_text(&registry, "antigravity", "hooks", Scope::Global, home, None, "1.5.9", &db, &store, &current, &bad).unwrap_err();
            assert!(!error.is_empty());
            assert_eq!(std::fs::read_to_string(&global).unwrap(), current);
        }

        // The project role creates the workspace hooks.json on first save.
        let work = temp.path().join("work");
        std::fs::create_dir_all(&work).unwrap();
        let created = "{\n  \"project-hook\": {\n    \"SessionStart\": [\n      { \"type\": \"command\", \"command\": \"/bin/true\" }\n    ]\n  }\n}\n";
        crate::adapters::save_registered_text(&registry, "antigravity", "hooks", Scope::Project, home, Some(&work), "1.5.9", &db, &store, "", created).unwrap();
        assert_eq!(std::fs::read_to_string(work.join(".agents").join("hooks.json")).unwrap(), created);
        // Reading the role back goes through the same declared file.
        assert_eq!(crate::adapters::read_registered_file(&registry, "antigravity", "hooks", Scope::Project, home, Some(&work), true).unwrap(), created);
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
        // evidence run. Plugins: the 1.5.9 evidence run pinned the
        // ~/.gemini/config/plugins storage and the config.json ledger (see
        // plugins.rs). Typed settings: the two persisted keys of the signed-in
        // evidence machine (see [`configuration`]). Accounts (keyring login
        // never adopted) and official quota (/usage is a TUI panel) stay
        // absent.
        assert!(Antigravity.configuration().is_some());
        assert!(Antigravity.agents().is_some());
        assert!(Antigravity.plugins().is_some());
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
        let keys = MemoryStore::default();
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
        assert!(descriptor.management.plugins);
        assert!(!descriptor.management.project_plugins);
        // Rules (1.5.9 evidence run): the hierarchical AGENTS.md single-file
        // port on both scopes plus the dual-scope trigger-rule catalog.
        assert!(descriptor.management.rules.global && descriptor.management.rules.project);
        assert!(descriptor.management.rules.catalog && descriptor.management.rules.catalog_global);
    }

    #[test]
    fn rules_ports_map_the_agents_standard_and_dual_scope_catalog() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let project = home.join("project");
        std::fs::create_dir_all(project.join(".agents").join("rules")).unwrap();
        // Single-file port: the hierarchical AGENTS.md documents on both
        // scopes, which are also the long-term-rule distribution targets.
        assert_eq!(
            Antigravity.rule_path(Scope::Global, home, None).unwrap(),
            gemini_root(home).join("config").join("AGENTS.md")
        );
        assert_eq!(
            Antigravity.rule_path(Scope::Project, home, Some(&project)).unwrap(),
            project.join("AGENTS.md")
        );
        assert_eq!(
            Antigravity.remote_rule_relative(Scope::Global).as_deref(),
            Some(".gemini/config/AGENTS.md")
        );
        assert_eq!(
            Antigravity.remote_rule_relative(Scope::Project).as_deref(),
            Some("AGENTS.md")
        );
        // The catalog is declared for both scopes; the kind policy keeps
        // structural operations on the evidence-verified directory rules.
        assert!(Antigravity.uses_rule_catalog(Scope::Global));
        assert!(Antigravity.uses_rule_catalog(Scope::Project));
        let md = Antigravity.rule_kind_policy("md");
        assert!(md.removable && md.toggleable);
        for kind in ["agents", "gemini"] {
            let hierarchical = Antigravity.rule_kind_policy(kind);
            assert!(!hierarchical.removable && !hierarchical.toggleable, "{kind}");
        }
        // Created rules carry the verified always_on trigger frontmatter.
        let created = Antigravity.rule_create_path_scoped(
            Scope::Project,
            home,
            Some(&project),
            "review",
        )
        .unwrap();
        assert_eq!(created, project.join(".agents").join("rules").join("review.md"));
        let template = Antigravity.rule_create_template(&created, "review");
        assert!(template.contains("trigger: always_on"), "{template}");
        let global_created = Antigravity
            .rule_create_path_scoped(Scope::Global, home, None, "style")
            .unwrap();
        assert_eq!(
            global_created,
            gemini_root(home).join("config").join("rules").join("style.md")
        );
        // Invalid names and duplicates stay rejected on both scopes.
        assert!(Antigravity
            .rule_create_path_scoped(Scope::Project, home, Some(&project), "bad name")
            .is_err());
        std::fs::write(&created, "exists").unwrap();
        assert!(Antigravity
            .rule_create_path_scoped(Scope::Project, home, Some(&project), "review")
            .is_err());
        // Relocation swaps the scan directory and the disabled slot (a pure
        // path plan; the shared transaction performs the move).
        let disabled = Antigravity
            .rule_relocate_scoped(Scope::Project, home, Some(&project), &created, false)
            .unwrap();
        assert_eq!(
            disabled,
            project.join(".agents").join(".cliora-disabled-rules").join("review.md")
        );
        std::fs::create_dir_all(disabled.parent().unwrap()).unwrap();
        std::fs::rename(&created, &disabled).unwrap();
        let restored = Antigravity
            .rule_relocate_scoped(Scope::Project, home, Some(&project), &disabled, true)
            .unwrap();
        assert_eq!(restored, created);
        // Hierarchical documents and foreign paths are never relocated.
        assert!(Antigravity
            .rule_relocate_scoped(Scope::Project, home, Some(&project), &project.join("AGENTS.md"), false)
            .is_err());
        assert!(Antigravity
            .rule_relocate_scoped(Scope::Project, home, Some(&project), Path::new("/outside/review.md"), false)
            .is_err());
    }

    #[test]
    fn rule_specs_list_directory_and_hierarchical_files_per_scope() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let project = home.join("project");
        let rules = project.join(".agents").join("rules");
        std::fs::create_dir_all(&rules).unwrap();
        std::fs::create_dir_all(project.join(".agents").join(".cliora-disabled-rules")).unwrap();
        std::fs::create_dir_all(project.join("sub")).unwrap();
        std::fs::write(rules.join("review.md"), "---\ntrigger: manual\n---\nbody").unwrap();
        std::fs::write(rules.join("notes.txt"), "not a rule").unwrap();
        std::fs::write(
            project.join(".agents").join(".cliora-disabled-rules").join("old.md"),
            "parked",
        )
        .unwrap();
        std::fs::write(project.join("AGENTS.md"), "root agents").unwrap();
        std::fs::write(project.join("GEMINI.md"), "root gemini").unwrap();
        std::fs::write(project.join("sub").join("AGENTS.md"), "sub agents").unwrap();
        let specs = Antigravity
            .rule_file_specs(Scope::Project, home, Some(&project))
            .unwrap();
        let summary: Vec<(&str, &str, bool, bool)> = specs
            .iter()
            .map(|spec| (spec.kind, spec.id.as_str(), spec.enabled, spec.writable))
            .collect();
        assert_eq!(
            summary,
            vec![
                ("agents", "agents:AGENTS.md", true, true),
                ("agents", "agents:sub/AGENTS.md", true, true),
                ("gemini", "gemini:GEMINI.md", true, true),
                ("md", "md:.agents/.cliora-disabled-rules/old.md", false, true),
                ("md", "md:.agents/rules/review.md", true, true),
            ],
            "{specs:?}"
        );
        // Global catalog: the config-root rules folder and the two
        // hierarchical documents the changelog names as global customizations.
        let config = gemini_root(home).join("config");
        std::fs::create_dir_all(config.join("rules")).unwrap();
        std::fs::write(config.join("rules").join("style.md"), "global style").unwrap();
        std::fs::write(config.join("AGENTS.md"), "global agents").unwrap();
        std::fs::write(config.join("GEMINI.md"), "global gemini").unwrap();
        let global_specs = Antigravity.rule_file_specs(Scope::Global, home, None).unwrap();
        let ids: Vec<&str> = global_specs.iter().map(|spec| spec.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "agents:AGENTS.md",
                "gemini:GEMINI.md",
                "md:rules/style.md",
            ],
            "{global_specs:?}"
        );
        assert!(global_specs.iter().all(|spec| spec.enabled));
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

    #[test]
    fn remote_layout_and_native_documents_cover_config_mcp_skills_and_agents() {
        let layout = Antigravity.remote_resource_layout();
        let mcp = layout.mcp.expect("antigravity remote mcp layout");
        assert_eq!(mcp.relative, ".gemini/config/mcp_config.json");
        assert_eq!(mcp.format, "json");
        assert_eq!(mcp.table, "mcpServers");
        assert!(!mcp.nested);
        assert_eq!(layout.skill_root, Some(".gemini/antigravity-cli/skills"));
        assert_eq!(layout.agent_root, Some(".gemini/config/agents"));
        assert_eq!(layout.agent_extension, Some("md"));

        let docs: Vec<(&str, &str, &str, &str)> = Antigravity
            .remote_native_documents()
            .iter()
            .map(|doc| (doc.scope, doc.role, doc.relative, doc.format))
            .collect();
        assert_eq!(
            docs,
            vec![
                ("global", "settings", ".gemini/antigravity-cli/settings.json", "json"),
                ("global", "hooks", ".gemini/config/hooks.json", "json"),
                ("project", "mcp", ".agents/mcp_config.json", "json"),
                ("project", "hooks", ".agents/hooks.json", "json"),
            ]
        );
    }

    #[test]
    fn remote_mcp_round_trip_uses_server_url_and_disabled_flag_and_preserves_unknown_keys() {
        let empty = Antigravity.parse_remote_mcp("").unwrap();
        assert_eq!(empty["entries"].as_array().unwrap().len(), 0);

        let disk = r#"{
          "extraTop": true,
          "mcpServers": {
            "stdio-tool": {
              "command": "npx",
              "args": ["-y", "demo"],
              "env": { "TOKEN": "1" },
              "cwd": "/srv/app",
              "disabled": true,
              "trust": true
            },
            "http-tool": {
              "serverUrl": "https://example.test/mcp",
              "headers": { "X-Api": "abc" },
              "oauth": { "clientId": "cid" }
            },
            "legacy-http": {
              "httpUrl": "https://legacy.test/mcp"
            }
          }
        }"#;
        let mut parsed = Antigravity.parse_remote_mcp(disk).unwrap();
        let entries = parsed["entries"].as_array_mut().unwrap();
        let find = |items: &[Value], name: &str| {
            items
                .iter()
                .find(|item| item["name"] == name)
                .cloned()
                .unwrap()
        };
        let stdio = find(entries, "stdio-tool");
        assert_eq!(stdio["transport"], "stdio");
        assert_eq!(stdio["cwd"], "/srv/app");
        assert_eq!(stdio["enabled"], false);
        let http = find(entries, "http-tool");
        assert_eq!(http["transport"], "http");
        assert_eq!(http["url"], "https://example.test/mcp");
        assert_eq!(http["enabled"], true);
        let legacy = find(entries, "legacy-http");
        assert_eq!(legacy["transport"], "http");
        assert_eq!(legacy["url"], "https://legacy.test/mcp");

        // Re-enable stdio-tool and disable http-tool.
        for item in entries.iter_mut() {
            if item["name"] == "stdio-tool" {
                item["enabled"] = json!(true);
            }
            if item["name"] == "http-tool" {
                item["enabled"] = json!(false);
            }
        }
        let rendered = Antigravity.render_remote_mcp(disk, &parsed).unwrap();
        let out: Value = serde_json::from_slice(&rendered).unwrap();
        assert_eq!(out["extraTop"], true);
        assert_eq!(out["mcpServers"]["stdio-tool"]["cwd"], "/srv/app");
        assert_eq!(out["mcpServers"]["stdio-tool"]["trust"], true);
        assert!(out["mcpServers"]["stdio-tool"].get("disabled").is_none());
        assert!(out["mcpServers"]["stdio-tool"].get("enabled").is_none());
        assert_eq!(out["mcpServers"]["http-tool"]["serverUrl"], "https://example.test/mcp");
        assert!(out["mcpServers"]["http-tool"].get("url").is_none());
        assert_eq!(out["mcpServers"]["http-tool"]["disabled"], true);
        assert_eq!(out["mcpServers"]["http-tool"]["oauth"]["clientId"], "cid");
        assert_eq!(out["mcpServers"]["legacy-http"]["serverUrl"], "https://legacy.test/mcp");
        assert!(out["mcpServers"]["legacy-http"].get("httpUrl").is_none());

        let sse = json!({"entries": [{"name": "s", "transport": "sse", "url": "https://e.test/sse"}]});
        assert!(Antigravity.render_remote_mcp("{}", &sse).unwrap_err().contains("HTTP+SSE"));
    }
}
