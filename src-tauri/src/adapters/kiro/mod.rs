//! Kiro CLI (AWS, `kiro-cli`) adapter.
//!
//! Registered default-off through the non-enumerated stable id `kiro`.
//! Evidence classes per 01-exploration.md: official kiro.dev docs for the
//! command and resource surfaces (`cli.kiro.dev`, `chat` with `-r/--resume`,
//! `--resume-id <ID>`, `--resume-picker`, `--trust-all-tools`), plus the real
//! local install (2.34.2, V3 engine active) for the data layout. Earlier [RE]
//! community shapes (agentsview kiro.go, threadle) degrade strictly
//! (`partial`) instead of being guessed.
//!
//! * **Paths**: `KIRO_HOME` relocates the whole root; otherwise `~/.kiro`
//!   holds `settings/cli.json`, `settings/mcp.json`, the session stores
//!   (legacy `sessions/cli/<uuid>.jsonl` through the V3
//!   `sessions/<workspace-hash>/` layout), `workspace-roots/` and
//!   `powers/`. The current local install (2.34.2, V3 engine active) keeps
//!   its binary and `data.sqlite3` under `%LOCALAPPDATA%\kiro-cli`;
//!   `data_root` prefers an existing `~/.kiro`, then that directory.
//! * **MCP**: user-level `~/.kiro/settings/mcp.json` and workspace
//!   `.kiro/settings/mcp.json` (`mcpServers` root). Kiro merges both by name
//!   with workspace precedence; Cliora manages each file through its own
//!   scope, and the CLI hot-reloads a saved file. stdio entries are
//!   `{command, args, env}` — `env` values may carry `${VAR}` references that
//!   kiro expands at launch, which stay verbatim (read-only, never resolved
//!   or rewritten here); remote entries are `{url, headers, oauth}`; native
//!   flags `disabled`/`autoApprove` and newer fields such as `disabledTools`
//!   and `oauth`/`oauthScopes` are kept from the existing entry (see
//!   `mcp_document`).
//! * **Skills**: user-level `~/.kiro/skills/` and workspace `.kiro/skills/`
//!   (a same-named workspace skill overrides the user-level one in the CLI);
//!   each skill directory carries a `SKILL.md` whose frontmatter `name` must
//!   match the directory name, so `skill_requires_manifest` is set and the
//!   shared SKILL.md parser applies unchanged.
//! * **Agents**: `~/.kiro/agents/[name].md|.json` and workspace
//!   `.kiro/agents/…` (nested directories form `team/planner` names);
//!   definitions are whole-file content (see `agents`).
//! * **Rules**: steering lives in `~/.kiro/steering/` and
//!   `<project>/.kiro/steering/` (base files product.md/tech.md/
//!   structure.md; the four frontmatter modes are file content the CLI
//!   interprets, never parsed here). The project steering directory is a
//!   project-scope catalog (every `.md` listed and editable); the single-file
//!   port manages the always-included AGENTS.md standard
//!   (`~/.kiro/steering/AGENTS.md` and `<project>/AGENTS.md`). The global
//!   steering directory is not cataloged — the shared catalog port is
//!   project-scope only — and that absence stays recorded (see `rules`).
//!   The same project catalog also lists the V3 workspace permissions file
//!   `~/.kiro/workspace-roots/<hash>/permissions.yaml` when the hash maps to
//!   the selected project through `session.json` `workspacePaths`
//!   (read-only probe; whole-file YAML editing; unmapped hashes hidden).
//! * **Powers**: open Agent Plugins packages installed by
//!   `kiro-cli powers install <name|path>` into
//!   `~/.kiro/powers/installed/<name>/` with the ledger
//!   `~/.kiro/powers/installed.json` (both verified on the local 2.34.2
//!   install). Listing reads that storage; install/uninstall are the native
//!   commands — a failure is never retried and is reported through the
//!   process exit code (see `powers`).
//! * **Memory**: V3 keeps memories per user account, shared between the IDE
//!   and the CLI on one machine, but no storage family exists locally yet
//!   (`memoryConfig` disabled) and the path is unpublished; the declaration
//!   degrades with the in-session `/memories` enable guidance (see `memory`).
//! * **Sessions**: legacy `sessions/cli/<uuid>.jsonl`, the current
//!   `sess_<id>/messages.jsonl` layout and the V3
//!   `sessions/<workspace-hash>/sess_<id>/` layout (session.json metadata,
//!   `session_metadata` rows) are indexed (see `history`).
//!   `data.sqlite3` (`conversations_v2` key/conversation_id/value/
//!   created_at/updated_at — schema read off the real local install, zero
//!   rows there) is a persistent archive whose `value` payload shape has no
//!   row evidence; it is not indexed (known limitation, never guessed).
//! * **Usage**: no session format carries token fields; two native data are
//!   collected — the V3 `session_metadata` contextUsage percentage as the
//!   `context-usage-percent` unit (an instantaneous gauge — dashboards
//!   aggregate it by maximum, never a sum) and the V3 `usage_summary`
//!   per-turn credit consumption as native `credit` usage events (aggregate
//!   summaries; see `history`). The official quota is web-only (credits on
//!   app.kiro.dev), so no quota port is declared.
//! * **Credentials**: `KIRO_API_KEY` (ksk_ prefix, Pro+) is an OS environment
//!   channel only — cli.json carries no key fields in any evidence. The
//!   managed value stays in the system credential store and is injected at
//!   launch under the frozen name `KIRO_API_KEY` (shared launch service).
//! * **Login**: Builder ID/Google/GitHub/IAM IdC flows stay with the product;
//!   no accounts port is declared and no login state is adopted.

pub(crate) mod agents;
pub mod history;
pub(crate) mod memory;
pub(crate) mod powers;
pub(crate) mod rules;

use std::collections::BTreeMap;
use std::env;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::{
    file, project_root, AdapterDescriptor, CliAdapter, Facet, InspectionFields,
    HISTORY_ASSOCIATION_UNAVAILABLE_REASON, LaunchMode, ManagementCapabilities, McpLocation,
    RuleFileSpec, RuleSupport,
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
    fn remote_resource_layout(&self) -> super::RemoteResourceLayout {
        super::RemoteResourceLayout { mcp: Some(super::RemoteMcpLayout { relative: ".kiro/settings/mcp.json", format: "json", table: "mcpServers", nested: false }), skill_root: Some(".kiro/skills"), agent_root: None, agent_extension: None }
    }

    fn memory(&self) -> Option<&dyn super::memory::MemoryAdapter> {
        Some(self)
    }
    fn agents(&self) -> Option<&dyn super::agents::AgentAdapter> {
        Some(self)
    }
    fn plugins(&self) -> Option<&dyn super::plugins::PluginAdapter> {
        Some(self)
    }
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
    /// Verified transcript: the local 2.34.2 install prints
    /// `kiro-cli 2.34.2`. Identity only accepts the documented command name
    /// with a self-named or bare semver response.
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
    fn supports_skills(&self) -> bool {
        true
    }
    fn skill_root(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<PathBuf> {
        // Official skills layout: user-level ~/.kiro/skills and workspace
        // .kiro/skills; a same-named workspace skill overrides the user-level
        // one in the CLI, and each scope stays managed on its own root.
        Some(match scope {
            Scope::Global => kiro_root(home).join("skills"),
            Scope::Project => project?.join(".kiro").join("skills"),
        })
    }
    fn skill_requires_manifest(&self) -> bool {
        // A skill is a directory with SKILL.md (frontmatter name must match
        // the directory name); directories without it are not skills.
        true
    }
    fn rule_path(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<PathBuf> {
        // The single-file port manages the always-included AGENTS.md standard
        // (see rules); the project steering directory is managed through the
        // catalog port below.
        rules::rule_path(scope, home, project)
    }
    fn uses_rule_catalog(&self, scope: Scope) -> bool {
        // The shared catalog port (list_files/save_file) is project-scope
        // only, so only <project>/.kiro/steering is cataloged; the global
        // steering directory stays a described native location with the
        // recorded reason (see rules::GLOBAL_CATALOG_REASON).
        scope == Scope::Project
    }
    fn rule_file_specs(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Result<Vec<RuleFileSpec>, String> {
        if scope != Scope::Project {
            return Err(rules::GLOBAL_CATALOG_REASON.into());
        }
        let project = project.ok_or("请选择项目目录")?;
        let mut specs = rules::list_steering_specs(project)?;
        // The V3 workspace permissions file joins the same project catalog
        // when its hash maps to this project (read-only probe; unmapped
        // hashes produce no entry).
        specs.extend(rules::workspace_permissions_specs(home, project));
        Ok(specs)
    }
    fn rule_create_path(&self, project: &Path, name: &str) -> Result<PathBuf, String> {
        rules::steering_create_path(project, name)
    }
    fn rule_unavailable_reason(&self, scope: Scope) -> Option<&'static str> {
        (scope == Scope::Global).then_some(rules::GLOBAL_CATALOG_REASON)
    }
    fn rule_support(&self) -> RuleSupport {
        // Derived from the ports above: the AGENTS.md single file on both
        // scopes plus the project-only steering catalog, with the global
        // catalog absence recorded instead of silently defaulting.
        RuleSupport {
            global: true,
            project: true,
            global_reason: rules::GLOBAL_CATALOG_REASON,
            project_reason: "",
            catalog: true,
        }
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
        // Shapes pinned by official docs plus the [RE] evidence: stdio
        // {command, args, env} — `${VAR}` env values expand natively at
        // launch and stay verbatim — and remote {url, headers, oauth}. The
        // shared builders start from the existing entry, so native flags and
        // newer fields survive a rewrite: `disabled`/`autoApprove`,
        // `disabledTools`, and the remote `oauth{clientId, clientSecret,
        // redirectUri, clientMetadataUrl, oauthScopes}`/`oauthScopes` group.
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
            "Windows：irm https://cli.kiro.dev/install.ps1 | iex，安装到 Program Files\\Kiro-Cli。macOS/Linux：curl -fsSL https://cli.kiro.dev/install | bash。已安装后重新执行同一安装命令。登录由 CLI 原生管理。",
        )
    }
    fn native_binary_directories(&self, home: &Path) -> Vec<PathBuf> {
        let mut dirs = vec![home.join(".local/bin")];
        #[cfg(windows)]
        {
            if let Some(program_files) = std::env::var_os("ProgramFiles") {
                dirs.push(PathBuf::from(program_files).join("Kiro-Cli"));
            }
            // The official PowerShell installer currently uses the per-user
            // LocalAppData location even though its completion text mentions
            // Program Files. Keep both locations so a successful install is
            // immediately discoverable by the app.
            if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
                dirs.push(PathBuf::from(local_app_data).join("Kiro-Cli"));
            }
        }
        dirs
    }
    fn recognizes_native_install_path(&self, path: &Path) -> bool {
        let name = path.file_name().and_then(|name| name.to_str()).unwrap_or("");
        let kiro = name.eq_ignore_ascii_case("kiro-cli") || name.eq_ignore_ascii_case("kiro-cli.exe");
        kiro && path.parent().is_some_and(|parent| {
            parent.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.eq_ignore_ascii_case("Kiro-Cli"))
                || parent.ends_with(".local/bin")
        })
    }
    fn install_command(&self) -> Option<String> {
        self.native_install_command()
    }
    fn native_install_command(&self) -> Option<String> {
        Some(
            if cfg!(windows) {
                "irm https://cli.kiro.dev/install.ps1 | iex"
            } else {
                "curl -fsSL https://cli.kiro.dev/install | bash"
            }
            .into(),
        )
    }
    fn upgrade_command(&self, source: &str) -> Option<String> {
        (source == "native").then(|| self.native_install_command()).flatten()
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
    fn history_association(&self) -> Option<Facet> {
        // Unread fields, including querySource, are not a parent/child link.
        Some(Facet {
            state: "unavailable",
            reason: HISTORY_ASSOCIATION_UNAVAILABLE_REASON,
        })
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
                reason: "已登记官方命令身份（本机 2.34.2 实装于 %LOCALAPPDATA%\\kiro-cli，V3 引擎已启用），可编辑用户级 ~/.kiro/settings/cli.json（JSON；KIRO_HOME 覆盖整个根目录）",
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
                reason: "MCP 由原生路径提供：用户级 ~/.kiro/settings/mcp.json 与工作区 .kiro/settings/mcp.json（按名合并、工作区优先；${VAR} 由 CLI 原生展开，保存即热重载为 CLI 行为，disabledTools/oauth 等原生字段保留）；Skills 为 ~/.kiro/skills 与 .kiro/skills（SKILL.md 的 name 须与目录同名）；Agents 为 ~/.kiro/agents 与 .kiro/agents 的 [name].md/.json；Powers 为 ~/.kiro/powers（本机实测 installed/ 目录 + installed.json 清单，install/uninstall 走原生命令、失败不重试并以退出码如实上报）；规则：项目 .kiro/steering 目录可清单与整文件编辑（product.md/tech.md/structure.md 等，四种 frontmatter 模式为文件内容不解析），已映射工作区的 ~/.kiro/workspace-roots/<hash>/permissions.yaml 整文件编辑（未映射哈希不展示），AGENTS.md 单文件在全局 ~/.kiro/steering/AGENTS.md 与项目根可编辑；全局 steering 目录清单受共享目录型端口仅项目范围的限制，原因已记录",
            },
            history: Facet {
                state: "available",
                reason: "只读索引 legacy sessions/cli/<uuid>.jsonl、现行 sess_<id>/messages.jsonl 与 V3 sessions/<workspace-hash>/sess_<id>/（session.json 元数据；session_metadata 行已核对形状，缺字段降级 partial）；V3 会话内 contextUsage 以 context-usage-percent 进入用量（瞬时采样，报表取最大值），usage_summary 的逐轮 credit 消耗以原生 credit 单位进入用量（聚合摘要，无请求计数）；三种会话格式均无 token 字段；官方配额为网页 credits 制（app.kiro.dev 账号设置），不接入；data.sqlite3 conversations_v2 归档表结构已实测但无消息行样本，未索引",
            },
            login: None,
            management: ManagementCapabilities {
                accounts: false,
                mcp: self.supports_mcp(),
                skills: self.supports_skills(),
                agents: self.agents().is_some_and(|port| port.capability().supported),
                plugins: self
                    .plugins()
                    .is_some_and(|port| !port.capability().actions.is_empty()),
                project_plugins: self.plugins().is_some_and(|port| port.capability().project),
                rules: self.rule_support(),
                memory: self.published_memory(),
                // The V3 memory feature exists but local storage is not
                // verified; the recorded reason (with the native enable
                // guidance) reaches the shared UI instead of a hidden tab.
                memory_reason: memory::UNVERIFIED_REASON,
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
        let install = Kiro.install_command().unwrap();
        assert!(install.contains(if cfg!(windows) { "install.ps1" } else { "cli.kiro.dev/install" }));
        assert_eq!(Kiro.upgrade_command("native"), Kiro.native_install_command());
        assert!(Kiro.upgrade_command("unknown").is_none());
        // Forward slashes exercise the directory rule on every host; backslashes are Windows separators.
        assert!(Kiro.recognizes_native_install_path(Path::new("C:/Program Files/Kiro-Cli/kiro-cli.exe")));
        #[cfg(windows)]
        assert!(Kiro.recognizes_native_install_path(Path::new(r"C:\Program Files\Kiro-Cli\kiro-cli.exe")));
        #[cfg(windows)]
        assert!(Kiro.recognizes_native_install_path(Path::new(r"C:\Users\me\AppData\Local\Kiro-Cli\kiro-cli.exe")));
        assert!(Kiro.recognizes_native_install_path(Path::new("/home/example/.local/bin/kiro-cli")));
        assert!(!Kiro.recognizes_native_install_path(Path::new("C:/npm/kiro-cli.cmd")));
        #[cfg(windows)]
        assert!(!Kiro.recognizes_native_install_path(Path::new(r"C:\npm\kiro-cli.cmd")));
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
        assert_eq!(
            stdio["disabledTools"],
            json!(["write_file", "apply_patch"]),
            "原生 disabledTools 列表原样读出"
        );
        assert_eq!(stdio["disabled"], false);
        let remote = &entries["example-remote"];
        assert_eq!(remote["url"], "https://mcp.example.com/mcp");
        assert_eq!(remote["headers"]["X-Example"], "fixture");
        assert_eq!(
            remote["oauth"]["clientId"], "fixture-client",
            "oauth 组为原生对象"
        );
        assert_eq!(
            remote["oauth"]["oauthScopes"],
            json!(["read", "write"])
        );
        assert_eq!(
            remote["oauth"]["clientSecret"], "${OAUTH_CLIENT_SECRET}",
            "oauth 凭据引用保持原样"
        );
        assert_eq!(remote["oauthScopes"], json!(["read"]));
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
            env: indexmap::IndexMap::from([("API_KEY".into(), "${EXAMPLE_KEY}".into())]),
            headers: indexmap::IndexMap::new(),
            in_library: true,
            version: 0,
            updated_at: None,
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
        // Rewriting an existing stdio entry keeps the native disabledTools
        // list and autoApprove flag; only disabled follows the toggle.
        let stdio_existing = json!({
            "command": "old-runner",
            "args": ["-y", "old"],
            "env": {"API_KEY": "${OLD_KEY}"},
            "autoApprove": ["list_tools"],
            "disabledTools": ["write_file", "apply_patch"],
            "disabled": true
        });
        let rewritten = Kiro
            .mcp_document(&definition, true, Some(&stdio_existing))
            .unwrap()
            .unwrap();
        assert_eq!(rewritten["command"], "fixture-runner");
        assert_eq!(rewritten["env"]["API_KEY"], "${EXAMPLE_KEY}");
        assert_eq!(rewritten["disabled"], false);
        assert_eq!(
            rewritten["disabledTools"],
            json!(["write_file", "apply_patch"]),
            "原生 disabledTools 保留"
        );
        assert_eq!(
            rewritten["autoApprove"],
            json!(["list_tools"]),
            "原生 autoApprove 标志保留"
        );
        let remote_definition = McpDefinition {
            transport: McpTransport::Http,
            url: "https://mcp.example.com/mcp".into(),
            headers: indexmap::IndexMap::from([("X-Example".into(), "1".into())]),
            ..definition
        };
        let existing = json!({
            "url": "https://old.example.com/mcp",
            "autoApprove": ["list_tools"],
            "oauth": {
                "clientId": "fixture-client",
                "clientSecret": "${OAUTH_CLIENT_SECRET}",
                "redirectUri": "https://mcp.example.com/oauth/callback",
                "clientMetadataUrl": "https://mcp.example.com/.well-known/oauth-authorization-server",
                "oauthScopes": ["read", "write"]
            },
            "oauthScopes": ["read"],
            "disabled": false
        });
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
            disabled["disabledTools"],
            Value::Null,
            "远端条目无 disabledTools，不凭空生成"
        );
        // The oauth group and sibling oauthScopes survive a rewrite verbatim.
        assert_eq!(disabled["oauth"]["clientId"], "fixture-client");
        assert_eq!(disabled["oauth"]["clientSecret"], "${OAUTH_CLIENT_SECRET}");
        assert_eq!(
            disabled["oauth"]["oauthScopes"],
            json!(["read", "write"])
        );
        assert_eq!(disabled["oauthScopes"], json!(["read"]));
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
    fn skill_and_rule_roots_cover_the_official_dual_scope_layout() {
        let temp = tempfile::tempdir().unwrap();
        let global = Kiro.skill_root(Scope::Global, temp.path(), None).unwrap();
        assert_eq!(global, temp.path().join(".kiro/skills"));
        let project = Path::new("/work/demo");
        assert_eq!(
            Kiro.skill_root(Scope::Project, temp.path(), Some(project)).unwrap(),
            project.join(".kiro/skills")
        );
        assert!(Kiro.skill_root(Scope::Project, temp.path(), None).is_none());
        assert!(
            Kiro.skill_requires_manifest(),
            "无 SKILL.md 的目录不是 Kiro skill"
        );
        // The managed rule document is the always-included AGENTS.md standard;
        // the steering directory itself stays a native location without a
        // catalog.
        assert_eq!(
            Kiro.rule_path(Scope::Global, temp.path(), None).unwrap(),
            temp.path().join(".kiro/steering/AGENTS.md")
        );
        assert_eq!(
            Kiro.rule_path(Scope::Project, temp.path(), Some(project)).unwrap(),
            project.join("AGENTS.md")
        );
        let support = Kiro.rule_support();
        assert!(support.global);
        assert!(support.project);
        // Project steering directory is cataloged; the global one is not,
        // with the shared-port scope limit recorded instead of silently
        // defaulting.
        assert!(Kiro.uses_rule_catalog(Scope::Project));
        assert!(!Kiro.uses_rule_catalog(Scope::Global));
        assert!(support.catalog);
        assert!(support.global_reason.contains("仅项目范围"));
    }

    #[test]
    fn delivered_dimensions_declare_no_fabricated_ports() {
        assert!(Kiro.history_supported());
        assert!(Kiro.supports_mcp());
        // Skills/agents/steering/powers follow the official docs plus the
        // local 2.34.2 evidence; memory degrades with the enable guidance,
        // and accounts/login flows plus the official quota (web-only) stay
        // undelivered with reasons.
        assert!(Kiro.supports_skills());
        assert!(Kiro
            .agents()
            .is_some_and(|port| port.capability().supported));
        let powers = Kiro.plugins().expect("powers 端口随实测证据交付");
        assert_eq!(powers.capability().actions, vec!["list", "install", "uninstall"]);
        // Unverified memory storage publishes no management entry; the
        // recorded reason is checked against the descriptor below.
        assert!(Kiro.memory().is_some());
        assert!(Kiro.published_memory().is_none());
        assert!(Kiro.accounts().is_none());
        assert!(Kiro.official_usage().is_none());
        assert!(Kiro.configuration().is_none());
        let descriptor = Kiro.descriptor();
        assert_eq!(descriptor.native_config.state, "available");
        assert!(descriptor.native_config.reason.contains("2.34.2"));
        assert_eq!(descriptor.launch.state, "available");
        assert_eq!(descriptor.resume.state, "available");
        assert_eq!(descriptor.resources.state, "available");
        assert!(descriptor.resources.reason.contains("permissions.yaml"));
        assert_eq!(descriptor.history.state, "available");
        assert!(descriptor.history.reason.contains("context-usage-percent"));
        assert_eq!(descriptor.launch_form, LaunchForm::Terminal);
        assert!(descriptor.yolo_available);
        assert!(descriptor.login.is_none());
        assert!(!descriptor.management.accounts);
        assert!(descriptor.management.mcp);
        assert!(descriptor.management.skills);
        assert!(descriptor.management.agents);
        assert!(descriptor.management.plugins);
        assert!(!descriptor.management.project_plugins);
        assert!(descriptor.management.memory.is_none());
        // The unverified reason reaches the shared UI through the descriptor
        // so the memory tab shows "unavailable + reason" instead of hiding.
        assert_eq!(descriptor.management.memory_reason, memory::UNVERIFIED_REASON);
        assert!(descriptor.management.memory_reason.contains("/memories"));
        // Adapters without a memory verdict keep the field empty: their
        // memory tabs stay hidden exactly as before.
        for id in ["claude_code", "cline", "kimi_code"] {
            let other = crate::adapters::Registry::builtins()
                .get(id)
                .unwrap()
                .descriptor();
            assert_eq!(other.management.memory_reason, "", "{id} 不受影响");
        }
        assert!(descriptor.management.rules.global);
        assert!(descriptor.management.rules.project);
        // The recorded token-absence reason stays part of the descriptor.
        assert!(descriptor.history.reason.contains("无 token 字段"));
        assert_eq!(
            Kiro.install_guidance().0,
            "https://cli.kiro.dev"
        );
    }
}
