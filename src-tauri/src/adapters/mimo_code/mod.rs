//! MiMo Code (Xiaomi, `mimo`) adapter.
//!
//! Registered default-off through the non-enumerated stable id `mimo_code`.
//! The CLI is an OpenCode fork (`@mimo-ai/cli` 0.1.15, MIT); every delivered
//! dimension cites the official source at XiaomiMiMo/MiMo-Code ([src] per
//! 02-technical-solution ADR-2):
//!
//! * **Paths** (`packages/shared/src/global.ts`, `xdg-basedir` 5.1.0 has no
//!   Windows special-casing): config `~/.config/mimocode` (XDG_CONFIG_HOME or
//!   `MIMOCODE_HOME/config`), data `~/.local/share/mimocode` (XDG_DATA_HOME or
//!   `MIMOCODE_HOME/data`). Project config lives in `.mimocode/`.
//! * **Configuration**: `mimocode.jsonc` (JSONC; `model`/`small_model` in
//!   `provider/model` form, `provider` record with `npm` +
//!   `options.baseURL`/`options.apiKey`, `agent` record, `skills.paths`) and
//!   `tui.json`. Editing surface is user-level only; project `.mimocode` stays
//!   with the product except for resource locations.
//! * **Launch/resume** (`cli/cmd/tui/thread.ts` `$0` command, identical flag
//!   contract to headless `cli/cmd/run.ts`): `mimo` interactive;
//!   `--session/-s <id>` resumes a native session, `-c/--continue` the last
//!   one, `--fork` forks before continuing; `--yolo` aliases
//!   `--dangerously-skip-permissions`.
//! * **MCP** (`config/mcp.ts`): the `mcp` key of the same config file, Local
//!   `{type:"local",command[],environment,enabled,timeout}` and Remote
//!   `{type:"remote",url,headers,oauth,enabled,timeout}` shapes.
//! * **Skills** (`skill/index.ts`): project `.mimocode/skills`, personal
//!   `~/.config/mimocode/skills` (`{skill,skills}/**/SKILL.md`), plus the
//!   open-standard `~/.agents/skills` which the CLI also reads; only the two
//!   brand roots are managed here.
//! * **Agents** (`config/agent.ts`): config `agent` key
//!   `Record<string, AgentConfig>` plus `{agent,agents}/**/*.md` files (see
//!   `agents`).
//! * **Plugins** (`config/plugin.ts`, `plugin/install.ts`, `plugin/loader.ts`):
//!   config `plugin` array of string or `[string, options]` specs plus
//!   auto-discovered `{plugin,plugins}/*.{ts,js}`; npm dependencies resolve
//!   into the config directory `node_modules` and install on demand at load
//!   (see `plugins`).
//! * **History** (`storage/schema.ts`, `session/*.sql.ts`, `message-v2.ts`,
//!   `session.ts getUsage`, `processor.ts`): the data-root SQLite
//!   `mimocode.db` (session/message/part) is indexed read-only with per-message
//!   token splits and `agent_id`/`parent_id` subagent attribution (see
//!   `history`).
//! * **Credentials**: custom-provider `apiKey` lives in the native config only
//!   as a literal (no `{env:}` reference syntax exists in this fork); the
//!   managed value stays in the system credential store until apply writes it
//!   (kimi_code api_key precedent) and literal imports migrate into the store.
//! * **auth.json** (`mimo auth login`, OAuth or metered key) stays with the
//!   product: read-only discovery is not delivered, the accounts port is
//!   absent by design and no credential file appears in `native_files`.
//! * **Official quota**: none (Token Plan usage is console-web only; `mimo
//!   stats` is a local session aggregate, an audit baseline at best).

pub(crate) mod agents;
pub(crate) mod configuration;
pub mod history;
pub(crate) mod plugins;

use std::collections::BTreeMap;
use std::env;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::{
    file, project_root, AdapterDescriptor, CliAdapter, Facet, InspectionFields, LaunchMode,
    ManagementCapabilities, McpLocation, NativeCredentialRefs, PendingSecrets, RuleSupport,
};
use crate::credentials::CredentialStore;
use crate::native::adapter::{NativeFile, Scope};
use crate::native::apply::{read_secret, set_json, NativeSecrets};
use crate::native::format::{self, FileKind};
use crate::native::intake::NativeInspection;
use crate::native::profile::{Connection, RegisteredProfile};
use crate::resources::mcp::{self, McpDefinition, McpTransport};

pub struct MiMoCode;

/// Config root: `~/.config/mimocode`, relocated by `MIMOCODE_HOME`
/// (`<root>/config`) or `XDG_CONFIG_HOME`. Only the real user home honors the
/// overrides so tests with an isolated home cannot redirect writes.
pub(crate) fn config_dir(home: &Path) -> PathBuf {
    crate::accounts::selection::config_root("mimo_code", || {
        if dirs::home_dir().as_deref() == Some(home) {
            if let Some(root) = env::var_os("MIMOCODE_HOME") {
                let path = PathBuf::from(root);
                if path.is_absolute() {
                    return path.join("config");
                }
            }
            if let Some(xdg) = env::var_os("XDG_CONFIG_HOME") {
                let path = PathBuf::from(xdg);
                if path.is_absolute() {
                    return path.join("mimocode");
                }
            }
        }
        home.join(".config").join("mimocode")
    })
}

/// Data root: `~/.local/share/mimocode`, relocated by `MIMOCODE_HOME`
/// (`<root>/data`) or `XDG_DATA_HOME` (shared/global.ts resolveMimocodeHome
/// over xdg-basedir 5.1.0).
pub(crate) fn data_root(home: &Path) -> PathBuf {
    crate::accounts::selection::history_root("mimo_code", || {
        if dirs::home_dir().as_deref() == Some(home) {
            if let Some(root) = env::var_os("MIMOCODE_HOME") {
                let path = PathBuf::from(root);
                if path.is_absolute() {
                    return path.join("data");
                }
            }
            if let Some(xdg) = env::var_os("XDG_DATA_HOME") {
                let path = PathBuf::from(xdg);
                if path.is_absolute() {
                    return path.join("mimocode");
                }
            }
        }
        home.join(".local").join("share").join("mimocode")
    })
}

/// Native loads `mimocode.jsonc` with `mimocode.json` as the alternate name
/// (config/paths.ts fileInDirectory); prefer the JSONC spelling when neither
/// exists.
fn settings_file(dir: &Path) -> (PathBuf, FileKind) {
    let jsonc = dir.join("mimocode.jsonc");
    if jsonc.exists() || !dir.join("mimocode.json").exists() {
        (jsonc, FileKind::Jsonc)
    } else {
        (dir.join("mimocode.json"), FileKind::Json)
    }
}

/// Exported by the CLI entry into its subprocesses (index.ts middleware); a
/// fresh terminal launch must not inherit them.
const SESSION_ENV_MARKERS: &[&str] = &["MIMOCODE", "MIMOCODE_PID", "AGENT"];

/// MiMo starts local MCP servers with `child_process.spawn(..., shell:false)`
/// (`packages/cli/src/mcp/stdio-transport.ts`), which cannot execute Windows
/// `.cmd`/`.bat` shims — the native session reports
/// `ENOENT ... uv_spawn 'npx'` for a bare `npx` and the server stays failed.
/// Wrap those commands in `cmd /c`, the same shape Claude Code's own
/// `~/.claude.json` entries use (verified connected under MiMo 0.1.15).
#[cfg(windows)]
fn windows_batch_command(command: Vec<String>) -> Vec<String> {
    wrap_batch_command(command, &crate::process_environment::directories())
}

#[cfg(any(windows, test))]
fn wrap_batch_command(command: Vec<String>, directories: &[PathBuf]) -> Vec<String> {
    let Some(program) = command.first().cloned() else {
        return command;
    };
    if program.eq_ignore_ascii_case("cmd") || program.eq_ignore_ascii_case("cmd.exe") {
        return command;
    }
    let path = Path::new(&program);
    let batch = if let Some(extension) = path.extension() {
        extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
    } else {
        // A bare name only wraps with PATH evidence, so `node` and friends
        // stay untouched.
        !program.contains(['/', '\\'])
            && directories.iter().any(|dir| {
                dir.is_absolute()
                    && (dir.join(format!("{program}.cmd")).is_file()
                        || dir.join(format!("{program}.bat")).is_file())
            })
    };
    if !batch {
        return command;
    }
    let mut wrapped = Vec::with_capacity(command.len() + 2);
    wrapped.push("cmd".into());
    wrapped.push("/c".into());
    wrapped.extend(command);
    wrapped
}

impl CliAdapter for MiMoCode {
    fn configuration(&self) -> Option<&dyn crate::adapters::configuration::ConfigurationAdapter> {
        Some(self)
    }
    fn supports_mcp(&self) -> bool {
        true
    }
    fn supports_skills(&self) -> bool {
        true
    }
    fn agents(&self) -> Option<&dyn crate::adapters::agents::AgentAdapter> {
        Some(self)
    }
    fn plugins(&self) -> Option<&dyn crate::adapters::plugins::PluginAdapter> {
        Some(self)
    }
    fn id(&self) -> &'static str {
        "mimo_code"
    }
    fn name(&self) -> &'static str {
        "MiMo Code"
    }
    fn command(&self) -> &'static str {
        "mimo"
    }
    fn npm_package(&self) -> &'static str {
        "@mimo-ai/cli"
    }
    /// No verified `--version` transcript exists yet; identity only accepts the
    /// documented command name with a self-named or bare semver response.
    fn version_identity(&self, basename: &str, output: &str) -> bool {
        (basename == "mimo" || basename.starts_with("mimo-"))
            && (output.contains("mimo")
                || semver::Version::parse(output.trim().trim_start_matches('v')).is_ok())
    }
    fn native_files(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
        known: bool,
    ) -> Vec<NativeFile> {
        // Managed editing stays user-level; the project `.mimocode` config is
        // only a resource location (MCP/agents), never a managed file here.
        let Some(root) = project_root(scope, project) else {
            return vec![];
        };
        match root {
            Some(_) => Vec::new(),
            None => {
                let dir = config_dir(home);
                let (settings, kind) = settings_file(&dir);
                vec![
                    file(
                        "settings",
                        settings,
                        kind,
                        known,
                        None,
                        false,
                    ),
                    file(
                        "tui",
                        dir.join("tui.json"),
                        FileKind::Json,
                        known,
                        Some("MiMo Code 终端界面配置"),
                        false,
                    ),
                ]
            }
        }
    }
    fn interface_formats(&self) -> &'static [&'static str] {
        &[
            "openai_completions",
            "openai_responses",
            "anthropic_messages",
        ]
    }
    fn file_kind(&self, role: &str) -> Result<FileKind, String> {
        match role {
            "settings" => Ok(FileKind::Jsonc),
            "tui" => Ok(FileKind::Json),
            _ => Err("MiMo Code 不支持此原生文件角色".into()),
        }
    }
    fn portable_root_fields(&self, role: &str) -> &'static [&'static str] {
        if role == "settings" {
            &["model", "small_model", "default_agent", "provider", "agent", "mcp", "skills"]
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
        let (path, kind) = match scope {
            Scope::Global => settings_file(&config_dir(home)),
            Scope::Project => (
                project?.join(".mimocode").join("mimocode.jsonc"),
                FileKind::Jsonc,
            ),
        };
        Some(McpLocation {
            path,
            kind,
            root: "mcp",
            child: None,
        })
    }
    fn mcp_document(
        &self,
        definition: &McpDefinition,
        enabled: bool,
        existing: Option<&Value>,
    ) -> Result<Option<Value>, String> {
        // Shapes pinned by config/mcp.ts: Local{type:"local",command[],
        // environment,enabled,timeout} / Remote{type:"remote",url,headers,
        // oauth,enabled,timeout}.
        let mut map = match definition.transport {
            McpTransport::Stdio => {
                let (command, args) = mcp::stdio_command(&definition.command, &definition.args);
                let mut map = mcp::stdio_doc_with_env(definition, existing, "environment");
                map.remove("args");
                let mut command: Vec<String> =
                    std::iter::once(command).chain(args).collect::<Vec<_>>();
                #[cfg(windows)]
                {
                    command = windows_batch_command(command);
                }
                map.insert("command".into(), json!(command));
                map.insert("type".into(), json!("local"));
                map
            }
            McpTransport::Http => {
                let mut map = mcp::http_doc(definition, existing, "headers");
                map.insert("type".into(), json!("remote"));
                map
            }
        };
        map.insert("enabled".into(), json!(enabled));
        Ok(Some(Value::Object(map)))
    }
    fn skill_root(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<PathBuf> {
        Some(match scope {
            Scope::Global => config_dir(home).join("skills"),
            Scope::Project => project?.join(".mimocode").join("skills"),
        })
    }
    fn connection_policy(&self, scope: Scope) -> crate::native::adapter::ConnectionPolicy {
        crate::native::adapter::ConnectionPolicy {
            api_key: if scope == Scope::Project {
                crate::native::adapter::api_key_scope_denied(
                    "MiMo Code 项目共享配置不能写入明文密钥；请使用用户级配置",
                )
            } else {
                crate::native::adapter::api_key_writable()
            },
            provider_address: crate::native::adapter::address_configurable(),
            projection: "provider_models",
        }
    }
    fn connection_documents(
        &self,
        connection: &Connection,
        scope: Scope,
    ) -> Result<BTreeMap<String, Value>, String> {
        if scope == Scope::Project {
            return Err("MiMo Code 连接只在用户级 mimocode.jsonc 管理".into());
        }
        let npm = match connection.interface_format.as_str() {
            "openai_completions" => "@ai-sdk/openai-compatible",
            "openai_responses" => "@ai-sdk/openai",
            "anthropic_messages" => "@ai-sdk/anthropic",
            _ => return Err("MiMo Code 不支持所选接口格式".into()),
        };
        let provider = connection.provider_id.as_str();
        let model = connection.model.as_str();
        let mut settings = json!({});
        set_json(&mut settings, &["model"], json!(format!("{provider}/{model}")));
        set_json(&mut settings, &["provider", provider, "npm"], json!(npm));
        set_json(&mut settings, &["provider", provider, "name"], json!(provider));
        set_json(
            &mut settings,
            &["provider", provider, "options", "baseURL"],
            json!(connection.base_url),
        );
        set_json(
            &mut settings,
            &["provider", provider, "models", model, "name"],
            json!(model),
        );
        // apiKey never enters the draft: the secret channel writes the literal
        // at apply time (the fork has no {env:NAME} reference syntax).
        Ok(BTreeMap::from([("settings".into(), settings)]))
    }
    fn write_connection_secret(
        &self,
        profile: &RegisteredProfile,
        scope: Scope,
        credentials: &dyn CredentialStore,
        secrets: &mut NativeSecrets,
    ) -> Result<(), String> {
        let Some(connection) = &profile.connection else {
            return Ok(());
        };
        let Some(id) = &connection.secret_ref else {
            return Ok(());
        };
        if scope == Scope::Project {
            return Err("MiMo Code 项目共享配置不能写入明文密钥；请使用用户级配置".into());
        }
        secrets.put(
            "settings",
            &[
                "provider",
                &connection.provider_id,
                "options",
                "apiKey",
            ],
            read_secret(id, credentials)?,
        );
        Ok(())
    }
    fn has_native_secret(&self, role: &str, root: &Value) -> bool {
        role == "settings"
            && root
                .get("provider")
                .and_then(Value::as_object)
                .is_some_and(|providers| {
                    providers.values().any(|item| {
                        item.get("options")
                            .and_then(|options| options.get("apiKey"))
                            .and_then(Value::as_str)
                            .is_some_and(|key| !key.is_empty())
                    })
                })
    }
    fn inspect_values(
        &self,
        settings: &Value,
        _: &Value,
        _: &Value,
    ) -> InspectionFields {
        let mut provider = None;
        let mut model = None;
        if let Some(full) = settings.get("model").and_then(Value::as_str) {
            if let Some((id, name)) = full.split_once('/') {
                provider = Some(id.into());
                model = Some(name.into());
            }
        }
        if provider.is_none() {
            provider = settings
                .get("provider")
                .and_then(Value::as_object)
                .and_then(|items| items.keys().next())
                .cloned();
        }
        let entry = provider
            .as_ref()
            .and_then(|id| settings.get("provider").and_then(|value| value.get(id)));
        let base = entry
            .and_then(|value| value.get("options"))
            .and_then(|value| value.get("baseURL"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let wire = entry
            .and_then(|value| value.get("npm"))
            .and_then(Value::as_str)
            .and_then(crate::native::intake::api_format);
        if model.is_none() {
            model = entry
                .and_then(|value| value.get("models"))
                .and_then(Value::as_object)
                .and_then(|items| items.keys().next())
                .cloned();
        }
        InspectionFields {
            provider,
            model,
            base,
            wire,
            env: None,
            ..InspectionFields::default()
        }
    }
    fn import_literal_secrets(
        &self,
        files: &mut BTreeMap<String, String>,
        found: &mut NativeInspection,
        pending: &mut PendingSecrets,
        _: &mut NativeCredentialRefs,
    ) -> Result<(), String> {
        let text = files.get("settings").cloned().unwrap_or_default();
        let parsed = format::parse(FileKind::Jsonc, &text)?;
        // The active provider is the one the `model` reference points at.
        let active = parsed
            .get("model")
            .and_then(Value::as_str)
            .and_then(|value| value.split_once('/').map(|(head, _)| head.to_owned()));
        if let Some(providers) = parsed.get("provider").and_then(Value::as_object) {
            for (name, entry) in providers {
                let Some(key) = entry
                    .get("options")
                    .and_then(|options| options.get("apiKey"))
                    .and_then(Value::as_str)
                    .filter(|key| !key.is_empty())
                else {
                    continue;
                };
                if active.as_deref() != Some(name.as_str()) || found.connection.is_none() {
                    return Err(format!(
                        "provider.{name}.options.apiKey 含字面密钥，但不是当前默认连接；请先选定该供应商与模型，原文件未更改"
                    ));
                }
                if key.len() > 16_384 {
                    return Err("原生 API 密钥为空或过长；原文件未更改".into());
                }
                let id = format!("connection-{}", uuid::Uuid::new_v4());
                // The fork has no {env:NAME} syntax, so the literal is removed
                // from the file and re-applied from the credential store.
                let replaced = format::set_path(
                    FileKind::Jsonc,
                    &text,
                    &[
                        "provider".into(),
                        name.clone(),
                        "options".into(),
                        "apiKey".into(),
                    ],
                    None,
                )?;
                files.insert("settings".into(), replaced);
                found.connection.as_mut().unwrap().secret_ref = Some(id.clone());
                pending.push((id, key.to_owned()));
            }
        }
        Ok(())
    }
    /// The fork reads provider keys from the config file (or native
    /// provider-specific env lists / auth store), never from a synthetic
    /// CLIORA_* variable; the default name would promise a channel it ignores.
    fn auth_env_name(&self, connection: &Connection) -> Option<String> {
        connection
            .auth_env_var
            .clone()
            .filter(|name| crate::native::profile::valid_env_name(name))
    }
    fn session_env_markers(&self) -> &'static [&'static str] {
        SESSION_ENV_MARKERS
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
            args.push("--yolo".into());
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
        // Schema evidence covers 0.1.x; allow ordinary minor movement inside 0.
        semver::Version::parse(version.trim().trim_start_matches('v'))
            .is_ok_and(|version| version.major == 0)
    }
    fn install_guidance(&self) -> (&'static str, &'static str) {
        (
            "https://www.npmjs.com/package/@mimo-ai/cli",
            "MiMo Code 通过官方 npm 包 @mimo-ai/cli 或官方脚本安装；密钥型自定义供应商经用户级 mimocode.jsonc 接入。",
        )
    }
    fn install_command(&self) -> Option<String> {
        self.npm_install_command()
    }
    fn descriptor(&self) -> AdapterDescriptor {
        AdapterDescriptor {
            id: self.id(),
            configuration: self.configuration().map(|port| port.describe(Scope::Global)),
            name: self.name(),
            interface_formats: self.interface_formats(),
            project_model_override: false,
            yolo_available: true,
            launch_form: self.launch_form(),
            native_config: Facet {
                state: "available",
                reason: "已确认 CLI 身份，可编辑用户级 mimocode.jsonc（JSONC）与 tui.json",
            },
            launch: Facet {
                state: "available",
                reason: "以所选工作目录在外部终端启动 mimo；--yolo 即 --dangerously-skip-permissions",
            },
            resume: Facet {
                state: "available",
                reason: "可用原生会话 ID 以 --session 在外部终端恢复；与 headless mimo run -c/--session/--fork 同一契约",
            },
            resources: Facet {
                state: "available",
                reason: "MCP（mimocode.jsonc mcp 键 Local/Remote 形状）、Skills（项目 .mimocode/skills 与个人 ~/.config/mimocode/skills）、Agents（config agent 键与 {agent,agents}/**/*.md）、Plugins（config plugin 键与 {plugin,plugins}/*.ts|js 自动发现）由原生路径提供",
            },
            history: Facet {
                state: "available",
                reason: "只读索引数据根 mimocode.db（session/message/part），逐消息 tokens 分项与 agent_id/parent_id 子代理归属",
            },
            login: None,
            management: ManagementCapabilities {
                accounts: false,
                mcp: true,
                skills: true,
                agents: true,
                plugins: true,
                project_plugins: true,
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
    use crate::resources::plugins::PluginTarget;
    use std::collections::HashMap;
    use std::sync::Mutex;

    const NATIVE_FIXTURE: &str =
        include_str!("../../../../tests/fixtures/native/mimo-code-0.1.15.json");

    #[derive(Default)]
    struct MemoryStore(Mutex<HashMap<String, String>>);
    impl CredentialStore for MemoryStore {
        fn put(&self, id: &str, secret: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert(id.into(), secret.into());
            Ok(())
        }
        fn get(&self, id: &str) -> Result<String, String> {
            self.0
                .lock()
                .unwrap()
                .get(id)
                .cloned()
                .ok_or("missing key".into())
        }
        fn delete(&self, id: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(id);
            Ok(())
        }
    }

    fn connection() -> Connection {
        Connection {
            provider_id: "custom-openai".into(),
            interface_format: "openai_completions".into(),
            base_url: "https://api.example.com/v1".into(),
            model: "demo-model".into(),
            secret_ref: Some("connection-930b8796-7d77-4e70-a8ba-6209ff1272e8".into()),
            auth_env_var: None,
            model_records: Vec::new(),
        }
    }

    #[test]
    fn identity_accepts_only_the_official_command_name() {
        assert!(MiMoCode.version_identity("mimo", "0.1.15"));
        assert!(MiMoCode.version_identity("mimo", "mimo cli v0.1.15"));
        assert!(MiMoCode.version_identity("mimo-0.1.15", "0.1.15\n"));
        assert!(!MiMoCode.version_identity("mimo", "claude 2.1.283"));
        assert!(!MiMoCode.version_identity("other", "0.1.15"));
        assert!(MiMoCode.history_resume_version_supported("0.1.15"));
        assert!(MiMoCode.history_resume_version_supported("0.2.0"));
        assert!(!MiMoCode.history_resume_version_supported("1.0.0"));
    }

    #[test]
    fn native_files_map_the_official_global_config_and_project_stays_native() {
        let home = Path::new("/home/example");
        let global = MiMoCode.native_files(Scope::Global, home, None, true);
        assert_eq!(global.len(), 2);
        assert_eq!(global[0].role, "settings");
        assert_eq!(global[0].format, "jsonc");
        assert!(global[0]
            .path
            .replace('\\', "/")
            .ends_with(".config/mimocode/mimocode.jsonc"));
        assert!(global[1]
            .path
            .replace('\\', "/")
            .ends_with(".config/mimocode/tui.json"));
        // Credential files never appear; project scope stays with the product.
        assert!(global.iter().all(|item| !item.path.contains("auth")));
        assert!(MiMoCode
            .native_files(Scope::Project, home, Some(Path::new("/work/p")), true)
            .is_empty());
        assert_eq!(MiMoCode.file_kind("settings").unwrap(), FileKind::Jsonc);
        assert_eq!(MiMoCode.file_kind("tui").unwrap(), FileKind::Json);
        assert!(MiMoCode.file_kind("auth").is_err());
        // The data root carrying mimocode.db follows xdg conventions.
        assert!(super::data_root(home)
            .ends_with(".local/share/mimocode"));
    }

    #[test]
    fn jsonc_fixture_parses_inspects_and_lists_mcp_entries() {
        let parsed = format::parse(FileKind::Jsonc, NATIVE_FIXTURE).unwrap();
        let inspection = MiMoCode.inspect_values(&parsed, &Value::Null, &Value::Null);
        assert_eq!(inspection.provider.as_deref(), Some("custom-openai"));
        assert_eq!(inspection.model.as_deref(), Some("demo-model"));
        assert_eq!(
            inspection.base.as_deref(),
            Some("https://api.example.com/v1")
        );
        assert_eq!(inspection.wire, Some("openai_completions"));
        assert_eq!(inspection.env, None, "无 {{env:}} 引用通道");
        let temp = tempfile::tempdir().unwrap();
        let dir = config_dir(temp.path());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("mimocode.jsonc"), NATIVE_FIXTURE).unwrap();
        let location = MiMoCode
            .mcp_location(Scope::Global, temp.path(), None)
            .unwrap();
        assert!(location.path.ends_with("mimocode.jsonc"));
        assert_eq!(location.root, "mcp");
        assert_eq!(location.child, None);
        let text = crate::native::transaction::read_native(&location.path).unwrap();
        let parsed = format::parse(location.kind, &text).unwrap();
        let entries = MiMoCode.mcp_entries(&parsed, &location).unwrap();
        assert_eq!(entries.len(), 2, "{entries:?}");
        assert_eq!(entries["example-local"]["type"], "local");
        assert_eq!(
            entries["example-local"]["command"],
            json!(["npx", "-y", "example-mcp"])
        );
        assert_eq!(entries["example-local"]["environment"]["EXAMPLE_MODE"], "fixture");
        assert_eq!(entries["example-remote"]["type"], "remote");
        assert_eq!(entries["example-remote"]["url"], "https://mcp.example.com/sse");
        assert_eq!(entries["example-remote"]["enabled"], false);
        // The project location is the project .mimocode config dir.
        let project = MiMoCode
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
            .ends_with("/work/demo/.mimocode/mimocode.jsonc"));
    }

    #[test]
    fn mcp_documents_match_the_official_local_and_remote_shapes() {
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
        let local = MiMoCode
            .mcp_document(&definition, true, None)
            .unwrap()
            .unwrap();
        assert_eq!(local["type"], "local");
        assert_eq!(
            local["command"],
            json!(["fixture-runner", "-y", "example-mcp"])
        );
        assert!(local.get("args").is_none(), "Local 形状用 command 数组，无 args");
        assert_eq!(local["enabled"], true);
        assert!(local["environment"].is_object());
        let remote_definition = McpDefinition {
            transport: McpTransport::Http,
            url: "https://mcp.example.com/sse".into(),
            headers: BTreeMap::from([("X-Example".into(), "1".into())]),
            ..definition
        };
        let remote = MiMoCode
            .mcp_document(&remote_definition, false, None)
            .unwrap()
            .unwrap();
        assert_eq!(remote["type"], "remote");
        assert_eq!(remote["url"], "https://mcp.example.com/sse");
        assert_eq!(remote["enabled"], false);
        assert!(remote["headers"].is_object());
    }

    #[test]
    fn windows_mcp_commands_wrap_only_proven_batch_shims() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("npx.cmd"), "").unwrap();
        let directories = vec![temp.path().to_path_buf()];
        assert_eq!(
            wrap_batch_command(vec!["npx".into(), "-y".into(), "pkg".into()], &directories),
            ["cmd", "/c", "npx", "-y", "pkg"]
        );
        let absolute = temp.path().join("uvx.cmd");
        std::fs::write(&absolute, "").unwrap();
        let absolute = absolute.display().to_string();
        let wrapped = wrap_batch_command(vec![absolute, "x".into()], &directories);
        assert_eq!(&wrapped[..2], ["cmd", "/c"]);
        // Extension-bearing shims and bare unknown names stay untouched;
        // `cmd /c` chains are never wrapped twice.
        assert_eq!(
            wrap_batch_command(vec!["npx.cmd".into()], &directories),
            ["cmd", "/c", "npx.cmd"]
        );
        assert_eq!(wrap_batch_command(vec!["node".into()], &directories), ["node"]);
        assert_eq!(wrap_batch_command(vec!["npx".into()], &[]), ["npx"]);
        assert_eq!(
            wrap_batch_command(vec!["cmd".into(), "/c".into(), "npx".into()], &directories),
            ["cmd", "/c", "npx"]
        );
    }

    #[test]
    fn resource_roots_follow_the_official_skills_and_agent_directories() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        assert_eq!(
            MiMoCode.skill_root(Scope::Global, temp.path(), None).unwrap(),
            config_dir(temp.path()).join("skills")
        );
        assert_eq!(
            MiMoCode
                .skill_root(Scope::Project, temp.path(), Some(&project))
                .unwrap(),
            project.join(".mimocode/skills")
        );
        let agent = MiMoCode.agents().unwrap();
        assert_eq!(
            agent.root(Scope::Global, temp.path(), None).unwrap(),
            config_dir(temp.path())
        );
        assert_eq!(
            agent
                .root(Scope::Project, temp.path(), Some(&project))
                .unwrap(),
            project.join(".mimocode")
        );
        assert_eq!(agent.definition_dirs(), &["agents", "agent"]);
        // The config `agent` key yields standalone definition entries.
        let parsed = format::parse(FileKind::Jsonc, NATIVE_FIXTURE).unwrap();
        let target = PluginTarget {
            tool_id: "mimo_code".into(),
            scope: Scope::Project,
            project_path: Some(project.to_string_lossy().into_owned()),
            context_id: None,
        };
        let mut entries = Vec::new();
        agent
            .config_entries(
                &target,
                temp.path(),
                &config_dir(temp.path()).join("mimocode.jsonc"),
                &parsed,
                &mut entries,
            )
            .unwrap();
        assert_eq!(entries.len(), 2, "{entries:?}");
        let review = entries.iter().find(|entry| entry.name == "review").unwrap();
        assert!(review.enabled);
        assert_eq!(review.format, "json");
        let legacy = entries
            .iter()
            .find(|entry| entry.name == "legacy-helper")
            .unwrap();
        assert!(!legacy.enabled, "disable: true 停用条目");
        assert!(crate::adapters::agents::validate(
            "mimo_code",
            "markdown",
            agent.capability().template,
            "fallback"
        )
        .is_ok());
    }

    #[test]
    fn launch_args_cover_normal_yolo_and_session_resume() {
        assert!(MiMoCode
            .launch_args(None, LaunchMode::Normal)
            .unwrap()
            .is_empty());
        assert_eq!(
            MiMoCode.launch_args(None, LaunchMode::Yolo).unwrap(),
            vec!["--yolo"]
        );
        assert_eq!(
            MiMoCode
                .launch_args(Some("ses_root_2026_10_05_a1b2c3d4"), LaunchMode::Normal)
                .unwrap(),
            vec!["--session", "ses_root_2026_10_05_a1b2c3d4"]
        );
        assert_eq!(
            MiMoCode
                .launch_args(Some("ses_root_2026_10_05_a1b2c3d4"), LaunchMode::Yolo)
                .unwrap(),
            vec!["--session", "ses_root_2026_10_05_a1b2c3d4", "--yolo"]
        );
        assert_eq!(MiMoCode.session_env_markers(), SESSION_ENV_MARKERS);
        let descriptor = MiMoCode.descriptor();
        assert_eq!(descriptor.launch_form, LaunchForm::Terminal);
        assert!(descriptor.yolo_available);
        assert!(!descriptor.management.accounts);
        assert!(descriptor.management.mcp && descriptor.management.skills && descriptor.management.agents);
        assert!(descriptor.management.plugins && descriptor.management.project_plugins);
        assert!(!descriptor.management.rules.global && !descriptor.management.rules.project);
        assert!(descriptor.login.is_none());
    }

    #[test]
    fn connection_documents_target_the_user_level_provider_and_never_embed_keys() {
        let documents = MiMoCode
            .connection_documents(&connection(), Scope::Global)
            .unwrap();
        let settings = documents.get("settings").unwrap();
        assert_eq!(settings["model"], "custom-openai/demo-model");
        assert_eq!(
            settings["provider"]["custom-openai"]["options"]["baseURL"],
            "https://api.example.com/v1"
        );
        assert_eq!(
            settings["provider"]["custom-openai"]["models"]["demo-model"]["name"],
            "demo-model"
        );
        let text = format::render(FileKind::Jsonc, settings).unwrap();
        assert!(!text.contains("apiKey"), "草稿不得包含密钥字段");
        assert!(MiMoCode
            .connection_documents(&connection(), Scope::Project)
            .is_err());
        let port = MiMoCode.configuration().unwrap();
        assert_eq!(
            port.portable_field_kind(&["apiKey".into()]),
            crate::adapters::configuration::PortableFieldKind::Credential
        );
        assert_eq!(
            port.portable_field_kind(&["limit.context".into()]),
            crate::adapters::configuration::PortableFieldKind::Parameter
        );
    }

    #[test]
    fn apply_profile_writes_the_literal_key_from_the_credential_store() {
        let keys = MemoryStore::default();
        keys.put(
            "connection-930b8796-7d77-4e70-a8ba-6209ff1272e8",
            "sk-test-secret-value",
        )
        .unwrap();
        let profile = RegisteredProfile {
            editing: None,
            id: String::new(),
            tool: "mimo_code".into(),
            name: "demo".into(),
            version: 1,
            revision: String::new(),
            inherit_common: false,
            files: BTreeMap::from([(
                "settings".into(),
                "{\n  \"model\": \"custom-openai/demo-model\"\n}\n".to_owned(),
            )]),
            suppressed: BTreeMap::new(),
            authentication: Default::default(),
            connection: Some(connection()),
            native_credentials: BTreeMap::new(),
        };
        let mut secrets = NativeSecrets::default();
        MiMoCode
            .write_connection_secret(&profile, Scope::Global, &keys, &mut secrets)
            .unwrap();
        // The secret channel writes the literal into the native file at apply
        // time (the fork has no {env:NAME} reference syntax).
        let draft = profile.files.get("settings").unwrap().clone();
        let applied = secrets
            .apply_text("settings", FileKind::Jsonc, draft)
            .unwrap();
        let document: Value = format::parse(FileKind::Jsonc, &applied).unwrap();
        assert_eq!(
            document.pointer("/provider/custom-openai/options/apiKey"),
            Some(&json!("sk-test-secret-value"))
        );
        assert!(MiMoCode
            .write_connection_secret(&profile, Scope::Project, &keys, &mut secrets)
            .is_err());
    }

    #[test]
    fn import_migrates_literal_api_key_into_the_credential_store() {
        let literal = NATIVE_FIXTURE.replace(
            "\"baseURL\": \"https://api.example.com/v1\"\n      },",
            "\"baseURL\": \"https://api.example.com/v1\",\n        \"apiKey\": \"sk-live-literal\"\n      },",
        );
        assert!(literal.contains("sk-live-literal"));
        let mut files = BTreeMap::from([("settings".into(), literal)]);
        let mut found = NativeInspection {
            provider_id: Some("custom-openai".into()),
            model: Some("demo-model".into()),
            connection: Some(connection()),
            reasoning_effort: None,
            projected_models: None,
        };
        let mut pending = Vec::new();
        MiMoCode
            .import_literal_secrets(
                &mut files,
                &mut found,
                &mut pending,
                &mut NativeCredentialRefs::new(),
            )
            .unwrap();
        let rewritten = files.get("settings").unwrap();
        assert!(!rewritten.contains("sk-live-literal"), "明文密钥必须移出文件");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].1, "sk-live-literal");
        assert_eq!(
            found.connection.as_ref().unwrap().secret_ref.as_deref(),
            Some(pending[0].0.as_str())
        );
    }

    #[test]
    fn import_rejects_literal_key_on_inactive_provider_and_keeps_the_file() {
        let literal = NATIVE_FIXTURE.replace(
            "\"provider\": {",
            "\"provider\": {\n    \"other\": {\n      \"npm\": \"@ai-sdk/openai\",\n      \"options\": {\"apiKey\": \"sk-other\"}\n    },",
        );
        let mut files = BTreeMap::from([("settings".into(), literal.clone())]);
        let mut found = NativeInspection {
            provider_id: Some("custom-openai".into()),
            model: Some("demo-model".into()),
            connection: Some(connection()),
            reasoning_effort: None,
            projected_models: None,
        };
        let error = MiMoCode
            .import_literal_secrets(
                &mut files,
                &mut found,
                &mut Vec::new(),
                &mut NativeCredentialRefs::new(),
            )
            .unwrap_err();
        assert!(error.contains("other"), "{error}");
        assert_eq!(files.get("settings").unwrap(), &literal, "原文件不得更改");
    }

    #[test]
    fn delivered_dimensions_declare_no_fabricated_ports() {
        assert!(MiMoCode.history_supported());
        assert!(MiMoCode.supports_mcp());
        assert!(MiMoCode.supports_skills());
        assert!(MiMoCode.agents().is_some());
        assert!(MiMoCode.configuration().is_some());
        // Plugins deliver through the config `plugin` array (config-only
        // transactions; npm deps install on demand at load); accounts/official
        // quota have no verified non-interactive interface and auth.json is
        // deliberately not adopted.
        assert!(MiMoCode.plugins().is_some());
        assert!(MiMoCode.accounts().is_none());
        assert!(MiMoCode.official_usage().is_none());
        assert!(MiMoCode
            .portable_root_fields("settings")
            .contains(&"provider"));
        let descriptor = MiMoCode.descriptor();
        assert_eq!(descriptor.native_config.state, "available");
        assert_eq!(descriptor.launch.state, "available");
        assert_eq!(descriptor.resume.state, "available");
        assert_eq!(descriptor.resources.state, "available");
        assert_eq!(descriptor.history.state, "available");
        assert!(descriptor.configuration.is_some());
    }
}
