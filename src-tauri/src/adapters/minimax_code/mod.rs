//! MiniMax Code CLI (`mcode`). Stable id `minimax_code`.
//!
//! Not the `minimax` quota provider, not `mimo_code`, and not the desktop or
//! `mmx` products. Version evidence is a bare `mcode --version` semver such as
//! `0.6.8`. Cancelling the preference does not delete local MiniMax files.

mod accounts;
mod agents;
mod configuration;
mod history;
mod plugins;
mod usage;

use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};

use super::{
    AdapterDescriptor, CliAdapter, Facet, InspectionFields, LaunchForm, LaunchMode,
    ManagementCapabilities, SkillObservation,
};
use crate::credentials::CredentialStore;
use crate::native::adapter::{NativeFile, Scope};
use crate::native::apply::NativeSecrets;
use crate::native::format::FileKind;
use crate::native::profile::{Connection, RegisteredProfile};
use crate::native::registered::file;

pub struct MiniMaxCode;

pub(crate) const DEFAULT_SECRET_ENV: &str = "MCODE_PROVIDER_API_KEY";
pub(crate) const TOKEN_PLAN_PROFILE_URL: &str = "https://agent.minimax.io/token-plan";
const GUIDANCE_URL: &str = "https://agent.minimax.io/docs/cli/configuration";

/// Resolved data directory. `Unavailable` means an explicit env value was not a
/// safe absolute path, so neither the other variable nor `~/.minimax` is read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum DataDir {
    Directory(PathBuf),
    Unavailable,
}

/// `MINIMAX_DATA_DIR`, else `MAVIS_DATA_DIR`, else `home/.minimax`.
/// A set variable that is relative or contains `..` does not fall through.
pub(crate) fn resolve_data_dir(home: &Path, minimax: Option<&str>, mavis: Option<&str>) -> DataDir {
    if let Some(raw) = nonempty(minimax) {
        return match safe_absolute(raw) {
            Some(path) => DataDir::Directory(path),
            None => DataDir::Unavailable,
        };
    }
    if let Some(raw) = nonempty(mavis) {
        return match safe_absolute(raw) {
            Some(path) => DataDir::Directory(path),
            None => DataDir::Unavailable,
        };
    }
    DataDir::Directory(home.join(".minimax"))
}

/// Process environment applies only for the real user home. Isolated tests pass
/// a stand-in home and keep `home/.minimax`, so a developer-set variable cannot
/// redirect them. Version probes do not call this.
pub(crate) fn data_dir(home: &Path) -> DataDir {
    if dirs::home_dir().as_deref() == Some(home) {
        let minimax = std::env::var("MINIMAX_DATA_DIR").ok();
        let mavis = std::env::var("MAVIS_DATA_DIR").ok();
        resolve_data_dir(home, minimax.as_deref(), mavis.as_deref())
    } else {
        DataDir::Directory(home.join(".minimax"))
    }
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn safe_absolute(raw: &str) -> Option<PathBuf> {
    let path = PathBuf::from(raw.trim());
    if !path.is_absolute() || path.components().any(|part| matches!(part, Component::ParentDir)) {
        return None;
    }
    Some(path)
}

pub(crate) fn existing_data_dir(home: &Path) -> Option<PathBuf> {
    match data_dir(home) {
        DataDir::Directory(path) if path.is_dir() => Some(path),
        _ => None,
    }
}

impl CliAdapter for MiniMaxCode {
    fn id(&self) -> &'static str {
        "minimax_code"
    }
    fn name(&self) -> &'static str {
        "MiniMax Code"
    }
    fn command(&self) -> &'static str {
        "mcode"
    }
    fn npm_package(&self) -> &'static str {
        // The public registry document supplies the version card. Install and
        // uninstall stay on the official guide and are not enabled by this name.
        "@minimax-ai/code"
    }
    fn version_identity(&self, basename: &str, output: &str) -> bool {
        command_name(basename) == "mcode" && semver::Version::parse(output.trim().trim_start_matches('v')).is_ok()
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
        let Some(dir) = existing_data_dir(home) else {
            return Vec::new();
        };
        vec![
            file("config", dir.join("config.yaml"), FileKind::Yaml, known, None, false),
            file("mcp", dir.join("mcp.json"), FileKind::Json, known, None, false),
        ]
    }
    fn interface_formats(&self) -> &'static [&'static str] {
        &[
            "anthropic_messages",
            "openai_completions",
            "openai_responses",
        ]
    }
    fn file_kind(&self, role: &str) -> Result<FileKind, String> {
        match role {
            "config" => Ok(FileKind::Yaml),
            "mcp" => Ok(FileKind::Json),
            _ => Err("MiniMax Code 没有此原生文件角色".into()),
        }
    }
    fn portable_root_fields(&self, role: &str) -> &'static [&'static str] {
        if role == "config" {
            &[
                "defaultModel",
                "defaultModelVariant",
                "minimaxModelSource",
                "permissionMode",
                "minimax_api",
                "custom_provider",
            ]
        } else {
            &[]
        }
    }
    fn exports_connection_secret(&self) -> bool {
        false
    }
    fn configuration(&self) -> Option<&dyn super::configuration::ConfigurationAdapter> {
        Some(self)
    }
    fn supports_mcp(&self) -> bool {
        true
    }
    fn mcp_location(
        &self,
        scope: Scope,
        home: &Path,
        _project: Option<&Path>,
    ) -> Option<super::McpLocation> {
        if scope != Scope::Global {
            return None;
        }
        let dir = existing_data_dir(home)?;
        Some(super::McpLocation {
            path: dir.join("mcp.json"),
            kind: FileKind::Json,
            root: "mcpServers",
            child: None,
        })
    }
    fn mcp_document(
        &self,
        definition: &crate::resources::mcp::McpDefinition,
        enabled: bool,
        existing: Option<&Value>,
    ) -> Result<Option<Value>, String> {
        use crate::resources::mcp::{self, McpTransport};
        let mut map = match definition.transport {
            McpTransport::Stdio => {
                let mut map = mcp::stdio_doc(definition, existing);
                map.insert("type".into(), json!("stdio"));
                map
            }
            McpTransport::Http => {
                let mut map = mcp::http_doc(definition, existing, "headers");
                let remote = existing
                    .and_then(|value| value.get("type"))
                    .and_then(Value::as_str)
                    .filter(|kind| matches!(*kind, "http" | "sse" | "streamable-http"))
                    .unwrap_or("streamable-http");
                map.insert("type".into(), json!(remote));
                map
            }
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
    fn skill_requires_manifest(&self) -> bool {
        true
    }
    fn skill_root(&self, scope: Scope, home: &Path, _project: Option<&Path>) -> Option<PathBuf> {
        if scope != Scope::Global {
            return None;
        }
        let DataDir::Directory(dir) = data_dir(home) else {
            return None;
        };
        // The CLI joins `<data-dir>/skills` even when that folder is absent.
        // The data directory itself must already exist; a missing one is not a
        // place to create a parallel root.
        dir.is_dir().then(|| dir.join("skills"))
    }
    fn skill_observations(
        &self,
        scope: Scope,
        home: &Path,
        _project: Option<&Path>,
    ) -> Vec<SkillObservation> {
        if scope != Scope::Global {
            return Vec::new();
        }
        let DataDir::Directory(dir) = data_dir(home) else {
            return Vec::new();
        };
        let root = dir.join(".builtin-skills");
        if !root.is_dir() {
            return Vec::new();
        }
        vec![SkillObservation {
            root,
            detail: "MiniMax Code 内置 Skill，只读",
        }]
    }
    fn rule_path(&self, scope: Scope, _home: &Path, project: Option<&Path>) -> Option<PathBuf> {
        match scope {
            Scope::Project => Some(project?.join("AGENTS.md")),
            Scope::Global => None,
        }
    }
    fn plugins(&self) -> Option<&dyn super::plugins::PluginAdapter> {
        Some(self)
    }
    fn agents(&self) -> Option<&dyn super::agents::AgentAdapter> {
        Some(self)
    }
    fn accounts(&self) -> Option<&dyn super::accounts::AccountAdapter> {
        Some(self)
    }
    fn official_usage(&self) -> Option<&dyn super::official::OfficialUsageAdapter> {
        Some(self)
    }
    fn auth_env_name(&self, connection: &Connection) -> Option<String> {
        if connection.provider_id == "token_plan" {
            return None;
        }
        if let Some(name) = connection.auth_env_var.as_deref() {
            return crate::native::profile::valid_env_name(name).then(|| name.to_owned());
        }
        connection.secret_ref.as_ref()?;
        Some(DEFAULT_SECRET_ENV.to_owned())
    }
    fn connection_secret_via_launch_env(&self) -> bool {
        true
    }
    fn connection_policy(&self, scope: Scope) -> crate::native::adapter::ConnectionPolicy {
        crate::native::adapter::ConnectionPolicy {
            api_key: if scope == Scope::Project {
                crate::native::adapter::api_key_scope_denied(
                    "MiniMax Code 连接只写入用户数据目录的 config.yaml",
                )
            } else {
                crate::native::adapter::api_key_writable()
            },
            provider_address: crate::native::adapter::address_configurable(),
            projection: "single_connection",
        }
    }
    fn connection_roles(&self) -> &'static [&'static str] {
        &["config"]
    }
    fn connection_documents(
        &self,
        connection: &Connection,
        scope: Scope,
    ) -> Result<std::collections::BTreeMap<String, Value>, String> {
        if scope != Scope::Global {
            return Err("MiniMax Code 连接只写入用户数据目录的 config.yaml".into());
        }
        Ok(std::collections::BTreeMap::from([(
            "config".into(),
            configuration::overlay(connection)?,
        )]))
    }
    fn write_connection_secret(
        &self,
        _profile: &RegisteredProfile,
        _scope: Scope,
        _credentials: &dyn CredentialStore,
        _secrets: &mut NativeSecrets,
    ) -> Result<(), String> {
        Ok(())
    }
    fn has_native_secret(&self, role: &str, root: &Value) -> bool {
        role == "config" && configuration::contains_plaintext_secret(root)
    }
    fn accepts_native_credential(&self, role: &str, name: &str) -> bool {
        role == "config" && crate::native::profile::valid_env_name(name)
    }
    fn inspect_values(
        &self,
        settings: &Value,
        _local_settings: &Value,
        _models: &Value,
    ) -> InspectionFields {
        configuration::inspect(settings)
    }
    fn import_literal_secrets(
        &self,
        files: &mut std::collections::BTreeMap<String, String>,
        found: &mut crate::native::intake::NativeInspection,
        pending: &mut super::PendingSecrets,
        native_refs: &mut super::NativeCredentialRefs,
    ) -> Result<(), String> {
        configuration::import_literal_secrets(files, found, pending, native_refs)
    }
    fn validate_draft(&self, role: &str, parsed: &Value) -> Result<(), String> {
        if role == "config" {
            configuration::reject_config(parsed)?;
        }
        Ok(())
    }
    fn validate_documents(
        &self,
        _scope: Scope,
        documents: &std::collections::BTreeMap<String, Value>,
    ) -> Result<(), String> {
        if let Some(config) = documents.get("config") {
            configuration::reject_config(config)?;
        }
        Ok(())
    }
    fn login_args(&self) -> Option<Vec<String>> {
        Some(vec!["login".into()])
    }
    fn login_hint(&self) -> &'static str {
        "在终端执行 mcode login。默认中国区；国际区追加 --region global。取消后不关闭已打开的终端。"
    }
    fn launch_form(&self) -> LaunchForm {
        LaunchForm::Terminal
    }
    fn launch_args(&self, session: Option<&str>, mode: LaunchMode) -> Result<Vec<String>, String> {
        if matches!(mode, LaunchMode::Yolo) {
            return Err("MiniMax Code 没有已核对的交互式全权限参数".into());
        }
        if let Some(id) = session {
            if id.starts_with('-') || id.chars().any(char::is_whitespace) {
                return Err("会话 ID 无效".into());
            }
            // Numbered resume is only `--session`. `--continue` is a separate
            // request and is never added here.
            return Ok(vec!["--session".into(), id.into()]);
        }
        Ok(Vec::new())
    }
    fn resume_latest_args(&self, mode: LaunchMode) -> Result<Vec<String>, String> {
        if matches!(mode, LaunchMode::Yolo) {
            return Err("MiniMax Code 没有已核对的交互式全权限参数".into());
        }
        Ok(vec!["--continue".into()])
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
    fn node_required_when_missing(&self) -> bool {
        false
    }
    fn install_command(&self) -> Option<String> {
        None
    }
    fn npm_install_command(&self) -> Option<String> {
        None
    }
    fn npm_uninstall_command(&self) -> Option<String> {
        None
    }
    fn upgrade_command(&self, _source: &str) -> Option<String> {
        // `mcode update` is the documented updater, but only after the
        // installation channel is identified. This adapter has no verified
        // Windows install path, so npm, native, and unknown all stay empty.
        None
    }
    fn install_guidance(&self) -> (&'static str, &'static str) {
        (
            GUIDANCE_URL,
            "MiniMax Code CLI 的命令是 mcode。未找到时只显示官方说明和重新检查，不提供桌面端、mmx 或 npm 安装命令。",
        )
    }
    fn descriptor(&self) -> AdapterDescriptor {
        AdapterDescriptor {
            id: self.id(),
            configuration: self.configuration().map(|port| port.describe(Scope::Global)),
            management: ManagementCapabilities {
                accounts: self.accounts().is_some_and(|adapter| {
                    let capability = adapter.capability();
                    capability.managed_login || capability.import_native
                }),
                mcp: self.supports_mcp(),
                skills: self.supports_skills(),
                agents: self.agents().is_some_and(|adapter| adapter.capability().supported),
                plugins: self
                    .plugins()
                    .is_some_and(|adapter| !adapter.capability().actions.is_empty()),
                project_plugins: self.plugins().is_some_and(|adapter| adapter.capability().project),
                rules: self.rule_support(),
            },
            login: self.login_args().map(|_| super::LoginCapability {
                hint: self.login_hint(),
            }),
            name: self.name(),
            interface_formats: self.interface_formats(),
            project_model_override: false,
            yolo_available: self.launch_args(None, LaunchMode::Yolo).is_ok(),
            launch_form: self.launch_form(),
            native_config: Facet {
                state: "available",
                reason: "可编辑用户数据目录的 config.yaml；显式应用才写回，不改写已保存的 permissionMode",
            },
            launch: Facet {
                state: "available",
                reason: "可在外部终端于所选项目目录启动 mcode；启动不改写已保存的 permissionMode",
            },
            resume: Facet {
                state: "available",
                reason: "恢复最近会话使用 --continue；按编号恢复使用 --session。两者不同时使用",
            },
            resources: Facet {
                state: "available",
                reason: "项目 AGENTS.md、数据目录 agents、skills 与 mcp.json，以及已安装插件按已核对契约管理",
            },
            history: Facet {
                state: "available",
                reason: "可只读索引本机 mcode 会话。记录没有标题、目录或 token 时，这些项保持未知，不显示 0",
            },
        }
    }
}

fn command_name(basename: &str) -> &str {
    let name = basename
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(basename);
    name.strip_suffix(".exe")
        .or_else(|| name.strip_suffix(".cmd"))
        .or_else(|| name.strip_suffix(".ps1"))
        .unwrap_or(name)
}

pub(crate) fn env_reference(name: &str) -> String {
    format!("${{{name}}}")
}

pub(crate) fn referenced_env(value: &str) -> Option<&str> {
    let name = value.strip_prefix("${")?.strip_suffix('}')?;
    crate::native::profile::valid_env_name(name).then_some(name)
}

pub(crate) fn custom_secret_env(provider: &str) -> String {
    let mut name = String::from("MCODE_CUSTOM_");
    for character in provider.chars() {
        if character.is_ascii_alphanumeric() {
            name.push(character.to_ascii_uppercase());
        } else {
            name.push('_');
        }
    }
    name.push_str("_API_KEY");
    name
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::configuration::{ConfigurationAdapter, PortableFieldKind};
    use crate::adapters::plugins::PluginAdapter;
    use crate::native::format::{self, FileKind};
    use crate::native::intake::NativeInspection;
    use crate::native::profile::ProfileAuthentication;
    use crate::resources::mcp::{McpDefinition, McpTransport};
    use serde_json::json;
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    const MIXED: &str = include_str!("../../../../tests/fixtures/minimax-code/config-mixed.yaml");
    const PLAINTEXT: &str = include_str!("../../../../tests/fixtures/minimax-code/config-plaintext.yaml");
    const CORRUPT: &str = include_str!("../../../../tests/fixtures/minimax-code/config-corrupt.yaml");
    const PLUGINS: &str = include_str!("../../../../tests/fixtures/minimax-code/plugin-list.json");

    fn connection(provider: &str, interface: &str, base: &str, model: &str, secret: bool) -> Connection {
        Connection {
            provider_id: provider.into(),
            interface_format: interface.into(),
            base_url: base.into(),
            model: model.into(),
            secret_ref: secret.then(|| "connection-00000000-0000-4000-8000-000000000001".into()),
            auth_env_var: None,
            model_records: Vec::new(),
        }
    }

    #[test]
    fn data_dir_prefers_minimax_then_mavis_then_home() {
        let home = Path::new("/home/example");
        let minimax = std::env::temp_dir().join("cliora-minimax-data");
        let mavis = std::env::temp_dir().join("cliora-mavis-data");
        let minimax_text = minimax.to_str().unwrap();
        let mavis_text = mavis.to_str().unwrap();
        assert_eq!(
            resolve_data_dir(home, Some(minimax_text), Some(mavis_text)),
            DataDir::Directory(minimax.clone())
        );
        assert_eq!(
            resolve_data_dir(home, Some("   "), Some(mavis_text)),
            DataDir::Directory(mavis.clone())
        );
        assert_eq!(
            resolve_data_dir(home, None, None),
            DataDir::Directory(home.join(".minimax"))
        );
        assert_eq!(
            resolve_data_dir(home, Some("relative/dir"), Some(mavis_text)),
            DataDir::Unavailable
        );
        let parent = minimax.join("..").join("escaped");
        assert_eq!(
            resolve_data_dir(home, Some(parent.to_str().unwrap()), None),
            DataDir::Unavailable
        );
        assert_eq!(data_dir(home), DataDir::Directory(home.join(".minimax")));
    }

    #[test]
    fn missing_directory_exposes_no_native_files_and_no_parallel_root() {
        let home = Path::new("/home/example");
        assert!(MiniMaxCode
            .native_files(Scope::Global, home, None, true)
            .is_empty());
        assert!(MiniMaxCode.mcp_location(Scope::Global, home, None).is_none());
        assert!(MiniMaxCode.skill_root(Scope::Global, home, None).is_none());
        assert!(MiniMaxCode
            .skill_observations(Scope::Global, home, None)
            .is_empty());
        let project = Path::new("/work/demo");
        assert_eq!(
            MiniMaxCode.rule_path(Scope::Project, home, Some(project)),
            Some(project.join("AGENTS.md"))
        );
        assert!(MiniMaxCode.rule_path(Scope::Global, home, None).is_none());
    }

    #[test]
    fn skills_use_the_data_directory_and_keep_builtins_read_only() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let data = home.join(".minimax");
        let user = data.join("skills").join("demo");
        let builtin = data.join(".builtin-skills").join("bundled");
        std::fs::create_dir_all(&user).unwrap();
        std::fs::create_dir_all(&builtin).unwrap();
        std::fs::write(user.join("SKILL.md"), "---\nname: demo\ndescription: Demo\n---\n").unwrap();
        std::fs::write(builtin.join("SKILL.md"), "---\nname: bundled\n---\n").unwrap();

        assert!(MiniMaxCode.supports_skills());
        assert!(MiniMaxCode.skill_requires_manifest());
        assert_eq!(
            MiniMaxCode.skill_root(Scope::Global, home, None),
            Some(data.join("skills"))
        );
        assert!(MiniMaxCode
            .skill_root(Scope::Project, home, Some(Path::new("/work/demo")))
            .is_none());
        let observed = MiniMaxCode.skill_observations(Scope::Global, home, None);
        assert_eq!(observed.len(), 1);
        assert_eq!(observed[0].root, data.join(".builtin-skills"));
        assert!(observed[0].detail.contains("只读"));
        assert!(MiniMaxCode
            .skill_observations(Scope::Project, home, None)
            .is_empty());
        assert!(MiniMaxCode.descriptor().management.skills);
        assert!(MiniMaxCode.descriptor().resources.reason.contains("skills"));
    }

    #[test]
    fn version_identity_accepts_bare_mcode_semver_only() {
        assert!(MiniMaxCode.version_identity("mcode", "0.6.8"));
        assert!(MiniMaxCode.version_identity("mcode.cmd", "v0.6.8\r\n"));
        assert!(!MiniMaxCode.version_identity("mmx", "0.6.8"));
        assert!(!MiniMaxCode.version_identity("mcode", "mcode 1.0.0"));
        assert!(MiniMaxCode.install_command().is_none());
        assert!(MiniMaxCode.npm_install_command().is_none());
        assert!(MiniMaxCode.npm_uninstall_command().is_none());
        assert!(!MiniMaxCode.node_required_when_missing());
        assert_eq!(MiniMaxCode.npm_package(), "@minimax-ai/code");
        assert_eq!(
            MiniMaxCode.latest_version_url().as_deref(),
            Some("https://registry.npmjs.org/@minimax-ai/code/latest")
        );
        assert_eq!(
            MiniMaxCode
                .parse_latest_version(r#"{"name":"@minimax-ai/code","version":"0.6.8"}"#)
                .as_deref(),
            Some("0.6.8")
        );
        assert!(MiniMaxCode.upgrade_command("npm_shim").is_none());
        assert!(MiniMaxCode.upgrade_command("unknown").is_none());
        assert!(MiniMaxCode.upgrade_command("native").is_none());
        let (url, text) = MiniMaxCode.install_guidance();
        assert!(url.contains("agent.minimax.io"));
        assert!(text.contains("重新检查"));
        assert!(text.contains("mmx"));
        assert!(!text.contains("npm install"));
    }

    #[test]
    fn launch_splits_continue_and_session_and_rejects_yolo() {
        assert!(MiniMaxCode
            .launch_args(None, LaunchMode::Normal)
            .unwrap()
            .is_empty());
        let latest = CliAdapter::resume_latest_args(&MiniMaxCode, LaunchMode::Normal).unwrap();
        assert_eq!(latest, vec!["--continue".to_string()]);
        assert!(!latest.iter().any(|arg| arg == "--session"));
        assert!(CliAdapter::resume_latest_args(&MiniMaxCode, LaunchMode::Yolo).is_err());
        let published = crate::adapters::PublishedDescriptor {
            resume_latest_available: MiniMaxCode
                .resume_latest_args(LaunchMode::Normal)
                .is_ok(),
            descriptor: MiniMaxCode.descriptor(),
        };
        assert!(published.resume_latest_available);
        assert!(!published.descriptor.yolo_available);
        let planned = crate::native::registered::plan_launch(
            &crate::adapters::Registry::builtins(),
            "minimax_code",
            "0.6.8",
            None,
            true,
            LaunchMode::Normal,
        )
        .unwrap();
        assert_eq!(planned, vec!["--continue".to_string()]);
        assert!(crate::native::registered::plan_launch(
            &crate::adapters::Registry::builtins(),
            "minimax_code",
            "0.6.8",
            Some("sess-1"),
            true,
            LaunchMode::Normal,
        )
        .is_err());
        assert!(crate::native::registered::plan_launch(
            &crate::adapters::Registry::builtins(),
            "minimax_code",
            "0.6.8",
            None,
            false,
            LaunchMode::Normal,
        )
        .unwrap()
        .is_empty());
        let session = MiniMaxCode
            .launch_args(Some("sess-1"), LaunchMode::Normal)
            .unwrap();
        assert_eq!(session, vec!["--session".to_string(), "sess-1".to_string()]);
        assert!(!session.iter().any(|arg| arg == "--continue"));
        let error = MiniMaxCode
            .launch_args(None, LaunchMode::Yolo)
            .unwrap_err();
        assert_eq!(error, "MiniMax Code 没有已核对的交互式全权限参数");
        assert!(!MiniMaxCode.descriptor().yolo_available);
        assert!(MiniMaxCode.descriptor().management.agents);
        assert!(MiniMaxCode.agents().unwrap().capability().supported);
        assert!(MiniMaxCode.history_supported());
        assert!(MiniMaxCode.descriptor().history.reason.contains("不显示 0"));
        assert_eq!(MiniMaxCode.descriptor().history.state, "available");
    }

    #[test]
    fn project_resume_latest_command_has_continue_directory_and_no_session() {
        let temp = tempfile::tempdir().unwrap();
        let db = crate::database::Database::open(&temp.path().join("cliora.db")).unwrap();
        // This test constructs commands without spawning them. Select a known
        // executable explicitly so headless CI needs no installed GUI terminal.
        crate::launch::set_custom_terminal(
            &db,
            std::env::current_exe().unwrap().display().to_string(),
            vec!["{script}".into()],
        )
        .unwrap();
        let registry = crate::adapters::Registry::builtins()
            .with_fixture_installation("minimax_code", "0.6.8");
        let workspace = temp.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let project = crate::projects::add(
            &db,
            &registry,
            workspace.to_str().unwrap(),
            Some("demo"),
            Some("minimax_code"),
        )
        .unwrap();
        let canonical = workspace.canonicalize().unwrap();
        let request = |session_id: Option<String>, resume_latest: bool, mode: LaunchMode| {
            crate::launch::LaunchRequest {
                tool_id: "minimax_code".into(),
                project_id: Some(project.id.clone()),
                session_id,
                directory: None,
                initial_prompt: None,
                mode,
                resume_latest,
            }
        };
        let latest = crate::launch::plan(&db, &registry, temp.path(), request(None, true, LaunchMode::Normal)).unwrap();
        assert_eq!(latest.terminal, crate::launch::TerminalId::Custom);
        assert_eq!(latest.directory, canonical);
        assert_eq!(latest.cli_args, vec!["--continue".to_string()]);
        assert!(latest.cli_args.iter().all(|arg| arg != "--session" && !arg.contains("permission")));
        let command = crate::launch::native_command(&latest).unwrap();
        assert!(command.contains("--continue"), "{command}");
        assert!(!command.contains("--session"), "{command}");
        let shown = canonical.display().to_string();
        let shown = shown.strip_prefix(r"\\?\").unwrap_or(&shown);
        assert!(command.contains(shown), "{command}");

        let numbered = crate::launch::plan(
            &db,
            &registry,
            temp.path(),
            request(Some("sess-1".into()), false, LaunchMode::Normal),
        )
        .unwrap();
        assert_eq!(numbered.cli_args, vec!["--session".to_string(), "sess-1".to_string()]);
        assert!(!numbered.cli_args.iter().any(|arg| arg == "--continue"));
        assert_eq!(numbered.directory, canonical);

        let fresh = crate::launch::plan(&db, &registry, temp.path(), request(None, false, LaunchMode::Normal)).unwrap();
        assert!(fresh.cli_args.is_empty());
        let yolo = crate::launch::plan(&db, &registry, temp.path(), request(None, true, LaunchMode::Yolo)).unwrap_err();
        assert!(yolo.contains("全权限"));
        let unscoped = crate::launch::plan(
            &db,
            &registry,
            temp.path(),
            crate::launch::LaunchRequest {
                tool_id: "minimax_code".into(),
                project_id: None,
                session_id: Some("sess-1".into()),
                directory: None,
                initial_prompt: None,
                mode: LaunchMode::Normal,
                resume_latest: false,
            },
        )
        .unwrap_err();
        assert!(unscoped.contains("原工作目录"), "{unscoped}");
    }

    #[test]
    fn overlays_keep_the_other_address_key_and_permission_mode() {
        let existing = format::parse(FileKind::Yaml, MIXED).unwrap();
        let token = connection("token_plan", "anthropic_messages", "https://api.minimaxi.com/anthropic", "MiniMax-M2", true);
        let token_overlay = configuration::overlay(&token).unwrap();
        assert!(token_overlay.get("minimax_api").is_none());
        assert!(token_overlay.get("custom_provider").is_none());
        assert!(token_overlay.get("permissionMode").is_none());
        assert!(token_overlay.get("provider").is_none());
        assert_eq!(token_overlay["minimaxModelSource"], json!("token_plan"));
        assert_eq!(token_overlay["defaultModel"], json!("minimax/MiniMax-M2"));
        let merged = format::resolve(&existing, &token_overlay, &[]).unwrap().0;
        assert_eq!(merged["permissionMode"], json!("bypassPermissions"));
        assert_eq!(
            merged.pointer("/minimax_api/baseURL").and_then(Value::as_str),
            Some("https://api.minimaxi.com/anthropic")
        );
        assert_eq!(
            merged.pointer("/minimax_api/apiKey").and_then(Value::as_str),
            Some("${MCODE_PROVIDER_API_KEY}")
        );
        assert_eq!(
            merged.pointer("/custom_provider/demo/options/baseURL").and_then(Value::as_str),
            Some("https://example.com/v1")
        );
        assert_eq!(
            merged.pointer("/custom_provider/demo/options/apiKey").and_then(Value::as_str),
            Some("${MCODE_CUSTOM_DEMO_API_KEY}")
        );
        assert_eq!(merged.pointer("/provider/minimax/name").and_then(Value::as_str), Some("MiniMax"));
        assert!(!serde_json::to_string(&merged).unwrap().contains("sk-"));

        let api = connection(
            "minimax",
            "anthropic_messages",
            "https://api.minimax.io/anthropic",
            "MiniMax-M2",
            true,
        );
        let api_overlay = configuration::overlay(&api).unwrap();
        assert!(api_overlay.get("custom_provider").is_none());
        assert!(api_overlay.get("permissionMode").is_none());
        assert_eq!(api_overlay["minimaxModelSource"], json!("minimax_api_key"));
        assert_eq!(
            api_overlay.pointer("/minimax_api/apiKey").and_then(Value::as_str),
            Some("${MCODE_PROVIDER_API_KEY}")
        );
        let api_merged = format::resolve(&merged, &api_overlay, &[]).unwrap().0;
        assert_eq!(
            api_merged.pointer("/custom_provider/demo/options/baseURL").and_then(Value::as_str),
            Some("https://example.com/v1")
        );
        assert_eq!(api_merged["permissionMode"], json!("bypassPermissions"));

        let custom = connection("demo", "openai_completions", "https://other.example/v1", "demo-model", true);
        let custom_overlay = configuration::overlay(&custom).unwrap();
        assert!(custom_overlay.get("minimax_api").is_none());
        assert!(custom_overlay.get("minimaxModelSource").is_none());
        assert!(custom_overlay.get("permissionMode").is_none());
        assert_eq!(custom_overlay["defaultModel"], json!("custom_provider:demo/demo-model"));
        assert_eq!(
            custom_overlay.pointer("/custom_provider/demo/options/apiKey").and_then(Value::as_str),
            Some("${MCODE_CUSTOM_DEMO_API_KEY}")
        );
        let custom_merged = format::resolve(&api_merged, &custom_overlay, &[]).unwrap().0;
        assert_eq!(
            custom_merged.pointer("/minimax_api/baseURL").and_then(Value::as_str),
            Some("https://api.minimax.io/anthropic")
        );
        assert_eq!(
            custom_merged.pointer("/minimax_api/apiKey").and_then(Value::as_str),
            Some("${MCODE_PROVIDER_API_KEY}")
        );
        assert_eq!(custom_merged["permissionMode"], json!("bypassPermissions"));
        assert!(!format::render(FileKind::Yaml, &custom_merged).unwrap().contains("sk-"));
    }

    #[test]
    fn configuration_editor_actions_write_address_format_name_and_model() {
        let registry = crate::adapters::Registry::builtins();
        let profile = serde_json::from_value(json!({
            "id": "",
            "tool": "minimax_code",
            "name": "新建",
            "version": 0,
            "inheritCommon": false,
            "files": {},
            "connection": null,
            "nativeCredentials": {}
        }))
        .unwrap();
        let mut draft = crate::native::configuration::open(
            &registry,
            profile,
            crate::native::adapter::Scope::Global,
            "mcode-editor".into(),
        )
        .unwrap();
        let set = |field: &str, value: Value| crate::adapters::configuration::ConfigurationAction {
            version: crate::adapters::configuration::EDITING_VERSION,
            target: json!({"kind": "connection"}),
            operation: "set".into(),
            field: Some(field.into()),
            value: Some(value),
        };
        let edit = |draft, action| {
            let next = crate::native::configuration::edit(&registry, draft, action).unwrap();
            assert!(next.issues.is_empty(), "{:?}", next.issues);
            next
        };
        draft = edit(draft, set("permissionMode", json!("bypassPermissions")));
        draft = edit(draft, set("source", json!("minimax_api_key")));
        draft = edit(draft, set("baseUrl", json!("https://api.minimaxi.com/anthropic")));
        draft = edit(draft, set("interfaceFormat", json!("anthropic_messages")));
        draft = edit(draft, set("model", json!("MiniMax-M2")));
        let root = format::parse(FileKind::Yaml, draft.profile.files.get("config").unwrap()).unwrap();
        assert_eq!(root["minimaxModelSource"], json!("minimax_api_key"));
        assert_eq!(root["defaultModel"], json!("minimax/MiniMax-M2"));
        assert_eq!(root["permissionMode"], json!("bypassPermissions"));
        assert_eq!(
            root.pointer("/minimax_api/baseURL").and_then(Value::as_str),
            Some("https://api.minimaxi.com/anthropic")
        );
        assert!(root.pointer("/minimax_api/apiKey").is_none());
        assert!(!serde_json::to_string(&root).unwrap().contains("sk-"));
        let connection = draft.profile.connection.as_ref().unwrap();
        assert_eq!(connection.provider_id, "minimax");
        assert_eq!(connection.interface_format, "anthropic_messages");
        assert_eq!(connection.model, "MiniMax-M2");
        assert_eq!(draft.view["providerId"], json!("minimax"));

        draft = edit(draft, set("provider", json!("demo")));
        draft = edit(draft, set("name", json!("Demo")));
        draft = edit(draft, set("baseUrl", json!("https://example.com/v1")));
        draft = edit(draft, set("interfaceFormat", json!("openai_completions")));
        draft = edit(draft, set("model", json!("demo-model")));
        let root = format::parse(FileKind::Yaml, draft.profile.files.get("config").unwrap()).unwrap();
        assert_eq!(root["defaultModel"], json!("custom_provider:demo/demo-model"));
        assert_eq!(root.pointer("/custom_provider/demo/name").and_then(Value::as_str), Some("Demo"));
        assert_eq!(
            root.pointer("/custom_provider/demo/api").and_then(Value::as_str),
            Some("openai-completions")
        );
        assert_eq!(
            root.pointer("/custom_provider/demo/options/baseURL").and_then(Value::as_str),
            Some("https://example.com/v1")
        );
        assert!(root.pointer("/custom_provider/demo/options/apiKey").is_none());
        assert_eq!(
            root.pointer("/minimax_api/baseURL").and_then(Value::as_str),
            Some("https://api.minimaxi.com/anthropic")
        );
        assert_eq!(root["permissionMode"], json!("bypassPermissions"));
        let custom = draft.profile.connection.as_ref().unwrap();
        assert_eq!(custom.provider_id, "demo");
        assert_eq!(custom.base_url, "https://example.com/v1");
        assert_eq!(custom.interface_format, "openai_completions");
        assert_eq!(custom.model, "demo-model");

        draft = edit(draft, set("source", json!("token_plan")));
        let root = format::parse(FileKind::Yaml, draft.profile.files.get("config").unwrap()).unwrap();
        assert_eq!(root["minimaxModelSource"], json!("token_plan"));
        assert_eq!(root["defaultModel"], json!("minimax/MiniMax-M2"));
        assert_eq!(
            root.pointer("/minimax_api/baseURL").and_then(Value::as_str),
            Some("https://api.minimaxi.com/anthropic")
        );
        assert_eq!(
            root.pointer("/custom_provider/demo/options/baseURL").and_then(Value::as_str),
            Some("https://example.com/v1")
        );
        assert!(root.pointer("/custom_provider/demo/models/demo-model").is_some());
        assert_eq!(root["permissionMode"], json!("bypassPermissions"));
        let token = draft.profile.connection.as_ref().unwrap();
        assert_eq!(token.provider_id, "token_plan");
        assert_eq!(token.base_url, TOKEN_PLAN_PROFILE_URL);
        assert_eq!(token.model, "MiniMax-M2");
        assert!(!draft.profile.files["config"].contains(TOKEN_PLAN_PROFILE_URL));
        assert!(!draft.profile.files["config"].contains("sk-"));

        draft = edit(draft, set("provider", json!("demo")));
        let root = format::parse(FileKind::Yaml, draft.profile.files.get("config").unwrap()).unwrap();
        assert_eq!(root["defaultModel"], json!("custom_provider:demo/demo-model"));
        assert_eq!(
            root.pointer("/minimax_api/baseURL").and_then(Value::as_str),
            Some("https://api.minimaxi.com/anthropic")
        );
        assert_eq!(draft.view["model"], json!("demo-model"));
        assert_eq!(draft.view["baseUrl"], json!("https://example.com/v1"));
        assert_eq!(draft.view["interfaceFormat"], json!("openai_completions"));
    }

    #[test]
    fn token_plan_projection_does_not_bind_the_api_key_quota() {
        let parsed = format::parse(FileKind::Yaml, MIXED).unwrap();
        let mut documents = BTreeMap::new();
        documents.insert("config".into(), parsed);
        let state = crate::adapters::configuration::EditingState::default();
        let projected = MiniMaxCode.connection(&documents, &state).unwrap().unwrap();
        assert_eq!(projected.provider_id, "token_plan");
        assert_eq!(projected.base_url, TOKEN_PLAN_PROFILE_URL);
        assert!(projected.secret_ref.is_none());
        assert!(projected.auth_env_var.is_none());
        assert!(crate::adapters::providers::ProviderRegistry::builtins()
            .profile_preset(&projected)
            .is_none());
        let usage = MiniMaxCode.official_usage().unwrap().capability();
        assert!(!usage.query_available);
        assert!(usage.description.contains("CLI"));

        let api = connection(
            "minimax",
            "anthropic_messages",
            "https://api.minimaxi.com/anthropic",
            "MiniMax-M2",
            true,
        );
        let api_docs = BTreeMap::from([(
            "config".into(),
            format::resolve(&documents["config"], &configuration::overlay(&api).unwrap(), &[]).unwrap().0,
        )]);
        let api_projected = MiniMaxCode.connection(&api_docs, &state).unwrap().unwrap();
        assert_eq!(api_projected.provider_id, "minimax");
        assert_eq!(api_projected.base_url, "https://api.minimaxi.com/anthropic");
        assert!(crate::adapters::providers::ProviderRegistry::builtins()
            .profile_preset(&api_projected)
            .is_some());
        let back = connection("token_plan", "anthropic_messages", &api_projected.base_url, "MiniMax-M2", false);
        let back_docs = BTreeMap::from([(
            "config".into(),
            format::resolve(&api_docs["config"], &configuration::overlay(&back).unwrap(), &[]).unwrap().0,
        )]);
        let back_projected = MiniMaxCode.connection(&back_docs, &state).unwrap().unwrap();
        assert!(crate::adapters::providers::ProviderRegistry::builtins()
            .profile_preset(&back_projected)
            .is_none());
        assert_eq!(
            back_docs["config"].pointer("/minimax_api/baseURL").and_then(Value::as_str),
            Some("https://api.minimaxi.com/anthropic")
        );
    }

    #[test]
    fn corrupt_yaml_stays_unparsed_and_plaintext_keys_are_rejected() {
        assert!(format::parse(FileKind::Yaml, CORRUPT).is_err());
        let plaintext = format::parse(FileKind::Yaml, PLAINTEXT).unwrap();
        assert!(configuration::contains_plaintext_secret(&plaintext));
        assert!(MiniMaxCode.validate_draft("config", &plaintext).is_err());
        let clean = format::parse(FileKind::Yaml, MIXED).unwrap();
        assert!(!configuration::contains_plaintext_secret(&clean));
        assert!(MiniMaxCode.validate_draft("config", &clean).is_ok());
    }

    #[test]
    fn import_replaces_plaintext_keys_with_distinct_env_references() {
        let mut files = BTreeMap::from([("config".into(), PLAINTEXT.to_owned())]);
        let mut found = NativeInspection {
            provider_id: None,
            model: None,
            connection: None,
            reasoning_effort: None,
            projected_models: None,
        };
        let mut pending = Vec::new();
        let mut refs = BTreeMap::new();
        MiniMaxCode
            .import_literal_secrets(&mut files, &mut found, &mut pending, &mut refs)
            .unwrap();
        let text = &files["config"];
        assert!(!text.contains("sk-official-example"));
        assert!(!text.contains("sk-custom-example"));
        assert!(text.contains("${MCODE_PROVIDER_API_KEY}"));
        assert!(text.contains("${MCODE_CUSTOM_DEMO_API_KEY}"));
        assert_eq!(pending.len(), 2);
        assert_ne!(pending[0].1, pending[1].1);
        let envs: Vec<_> = refs["config"].keys().cloned().collect();
        assert!(envs.contains(&"MCODE_PROVIDER_API_KEY".into()));
        assert!(envs.contains(&"MCODE_CUSTOM_DEMO_API_KEY".into()));
    }

    #[test]
    fn env_references_survive_portable_classification() {
        let path = ["config".into(), "minimax_api".into(), "apiKey".into()];
        assert_eq!(
            CliAdapter::portable_field_kind(&MiniMaxCode, &path),
            PortableFieldKind::CredentialReference
        );
        assert!(MiniMaxCode
            .configuration()
            .unwrap()
            .portable_reference_valid(&path, &json!("${MCODE_PROVIDER_API_KEY}")));
        assert!(!MiniMaxCode
            .configuration()
            .unwrap()
            .portable_reference_valid(&path, &json!("sk-official-example")));
        assert!(!MiniMaxCode.exports_connection_secret());
        assert!(crate::adapters::CLAUDE.exports_connection_secret());
    }

    #[test]
    fn plugins_mark_marketplace_rows_not_installed_and_skip_agents() {
        let value: Value = serde_json::from_str(PLUGINS).unwrap();
        let target = crate::resources::plugins::PluginTarget {
            tool_id: "minimax_code".into(),
            scope: Scope::Global,
            project_path: None,
            context_id: None,
        };
        let entries = MiniMaxCode.parse_list(&value, &target).unwrap();
        let local = entries.iter().find(|entry| entry.id == "review@local").unwrap();
        assert_eq!(local.state, "installed_load_unknown");
        assert!(!local.read_only);
        let official = entries.iter().find(|entry| entry.id == "lark@official").unwrap();
        assert_eq!(official.state, "not_installed");
        assert!(official.read_only);
        assert!(official.enabled.is_none());
        assert_eq!(MiniMaxCode.list_command_args(), ["plugin", "list", "--json"]);
        assert_eq!(
            MiniMaxCode.command_args("install", "lark@official", false).unwrap(),
            ["plugin", "add", "lark@official"]
        );
        assert_eq!(
            MiniMaxCode.command_args("enable", "review@local", false).unwrap(),
            ["plugin", "enable", "review@local"]
        );
        assert_eq!(
            MiniMaxCode.command_args("disable", "review@local", false).unwrap(),
            ["plugin", "disable", "review@local"]
        );
        assert_eq!(
            MiniMaxCode.command_args("uninstall", "review@local", false).unwrap(),
            ["plugin", "remove", "review@local"]
        );
        assert!(!MiniMaxCode.plugins().unwrap().capability().project);
        assert!(MiniMaxCode.agents().unwrap().capability().supported);
    }

    #[test]
    fn mcp_document_uses_verified_types_without_rewriting_permission_mode() {
        let definition = McpDefinition {
            id: "mcp-1".into(),
            name: "local".into(),
            transport: McpTransport::Stdio,
            command: "echo".into(),
            args: vec!["hi".into()],
            url: String::new(),
            env: BTreeMap::from([("TOKEN".into(), "${MCP_TOKEN}".into())]),
            headers: BTreeMap::new(),
            in_library: true,
            version: 1,
        };
        let document = MiniMaxCode.mcp_document(&definition, true, None).unwrap().unwrap();
        assert_eq!(document["type"], json!("stdio"));
        assert_eq!(document["enabled"], json!(true));
        assert_eq!(document["command"], json!("echo"));
        let remote = McpDefinition {
            transport: McpTransport::Http,
            command: String::new(),
            args: vec![],
            url: "https://example.com/mcp".into(),
            env: BTreeMap::new(),
            headers: BTreeMap::new(),
            ..definition
        };
        let existing = json!({"type": "sse", "timeout": 30, "headers": {"Authorization": "kept"}});
        let http = MiniMaxCode.mcp_document(&remote, false, Some(&existing)).unwrap().unwrap();
        assert_eq!(http["type"], json!("sse"));
        assert_eq!(http["enabled"], json!(false));
        assert_eq!(http["url"], json!("https://example.com/mcp"));
        assert_eq!(http["timeout"], json!(30));
    }

    #[test]
    fn login_is_terminal_and_isolated_until_auth_state_exists() {
        use crate::accounts::AccountState;
        use crate::adapters::accounts::AccountAdapter;
        assert_eq!(CliAdapter::login_args(&MiniMaxCode).unwrap(), vec!["login".to_string()]);
        assert_eq!(
            AccountAdapter::login_args(&MiniMaxCode, "browser").unwrap(),
            vec!["login".to_string()]
        );
        assert_eq!(
            AccountAdapter::login_args(&MiniMaxCode, "global").unwrap(),
            vec!["login".to_string(), "--region".to_string(), "global".to_string()]
        );
        assert_eq!(MiniMaxCode.logout_args(), vec!["logout".to_string()]);
        assert!(MiniMaxCode.terminal_logout());
        let root = tempfile::tempdir().unwrap();
        let root = root.path().join(".minimax");
        let context = MiniMaxCode.context(root.clone(), "native".into()).unwrap();
        assert_eq!(
            context.environment.get("MINIMAX_DATA_DIR").map(String::as_str),
            Some(root.to_string_lossy().as_ref())
        );
        assert!(!context.auth_files.is_empty());
        assert!(MiniMaxCode.private_directories(&context).is_empty());
        let observation = MiniMaxCode.observe(Path::new("mcode"), &context).unwrap();
        assert_eq!(observation.state, AccountState::SignedOut);
        assert!(observation.identity.is_none());
        assert!(!AccountAdapter::capability(&MiniMaxCode).import_native);
        assert!(!AccountAdapter::sign_in_requires_identity(&MiniMaxCode));
    }

    #[derive(Default)]
    struct MemoryStore(Mutex<BTreeMap<String, String>>);
    impl CredentialStore for MemoryStore {
        fn put(&self, id: &str, secret: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert(id.into(), secret.into());
            Ok(())
        }
        fn get(&self, id: &str) -> Result<String, String> {
            self.0.lock().unwrap().get(id).cloned().ok_or("missing".into())
        }
        fn delete(&self, id: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(id);
            Ok(())
        }
    }

    #[test]
    fn applying_a_profile_does_not_require_a_settings_role_or_clear_mcp() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let data = home.join(".minimax");
        std::fs::create_dir_all(&data).unwrap();
        let mcp = "{\"mcpServers\":{}}\n";
        std::fs::write(data.join("mcp.json"), mcp).unwrap();
        std::fs::write(data.join("config.yaml"), "permissionMode: default\n").unwrap();
        let db = crate::database::Database::open(&dir.path().join("cliora.db")).unwrap();
        let registry = crate::adapters::Registry::builtins();
        let profile = crate::native::profile::save_registered_profile(
            &db,
            &registry,
            RegisteredProfile {
                editing: Some(crate::adapters::configuration::EditingState::default()),
                id: String::new(),
                tool: "minimax_code".into(),
                name: "mcode".into(),
                version: 0,
                revision: String::new(),
                inherit_common: false,
                files: BTreeMap::from([(
                    "config".into(),
                    "minimaxModelSource: token_plan\ndefaultModel: MiniMax-M2\npermissionMode: default\n".into(),
                )]),
                suppressed: BTreeMap::new(),
                authentication: ProfileAuthentication::Native,
                connection: None,
                native_credentials: BTreeMap::new(),
            },
            None,
        )
        .unwrap();
        let comparison = crate::native::apply::compare_registered_application(
            &registry,
            &db,
            &home,
            Scope::Global,
            None,
            &profile.id,
        )
        .unwrap();
        let mcp_file = comparison.files.iter().find(|file| file.role == "mcp").unwrap();
        assert_eq!(mcp_file.current, mcp);
        assert_eq!(mcp_file.proposed_text, mcp);
        assert!(!mcp_file.proposed_text.contains("没有此原生文件角色"));
        let native = MiniMaxCode.native_files(Scope::Global, &home, None, true);
        crate::native::apply::apply_registered_validated(
            &registry,
            &db,
            &MemoryStore::default(),
            &profile,
            None,
            &native,
            "global",
            Scope::Global,
            false,
        )
        .expect("apply uses config.yaml and must not ask for a settings role");
        assert_eq!(std::fs::read_to_string(data.join("mcp.json")).unwrap(), mcp);
        let written = std::fs::read_to_string(data.join("config.yaml")).unwrap();
        assert!(written.contains("MiniMax-M2"), "{written}");
        assert!(!written.contains("没有此原生文件角色"));
    }

    #[test]
    fn portable_export_omits_login_token_and_api_key_plaintext() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::database::Database::open(&dir.path().join("cliora.db")).unwrap();
        let store = MemoryStore::default();
        let secret_id = "connection-00000000-0000-4000-8000-000000000004";
        let native_id = "connection-00000000-0000-4000-8000-000000000005";
        store.put(secret_id, "sk-export-connection").unwrap();
        store.put(native_id, "sk-export-native").unwrap();
        let mut native_credentials = BTreeMap::new();
        native_credentials.insert(
            "config".into(),
            BTreeMap::from([("MCODE_CUSTOM_DEMO_API_KEY".into(), native_id.into())]),
        );
        let profile = RegisteredProfile {
            editing: Some(crate::adapters::configuration::EditingState::default()),
            id: String::new(),
            tool: "minimax_code".into(),
            name: "mcode".into(),
            version: 0,
            revision: String::new(),
            inherit_common: false,
            files: BTreeMap::from([(
                "config".into(),
                "minimaxModelSource: minimax_api_key\ndefaultModel: minimax/MiniMax-M2\nminimax_api:\n  baseURL: https://api.minimaxi.com/anthropic\n  apiKey: ${MCODE_PROVIDER_API_KEY}\n".into(),
            )]),
            suppressed: BTreeMap::new(),
            authentication: ProfileAuthentication::ApiKey,
            connection: Some(connection(
                "minimax",
                "anthropic_messages",
                "https://api.minimaxi.com/anthropic",
                "MiniMax-M2",
                false,
            )),
            native_credentials,
        };
        let mut profile = profile;
        profile.connection.as_mut().unwrap().secret_ref = Some(secret_id.into());
        profile.connection.as_mut().unwrap().auth_env_var = Some(DEFAULT_SECRET_ENV.into());
        crate::native::profile::save_registered_profile(
            &db,
            &crate::adapters::Registry::builtins(),
            profile,
            None,
        )
        .unwrap();
        let snapshot = crate::portable::collect_snapshot(
            &db,
            &store,
            &crate::adapters::Registry::builtins(),
        )
        .unwrap();
        let rendered = serde_json::to_string(&snapshot).unwrap();
        assert!(!rendered.contains("sk-export-connection"));
        assert!(!rendered.contains("sk-export-native"));
        assert!(!rendered.contains("sk-official-example"));
        let crate::portable::PortablePayload::Profile(portable) = &snapshot
            .entities
            .iter()
            .find(|entity| matches!(entity.payload, crate::portable::PortablePayload::Profile(_)))
            .unwrap()
            .payload
        else {
            unreachable!();
        };
        assert!(portable.connection_secret.is_none());
        assert!(portable
            .pending_fields
            .iter()
            .any(|field| field.contains("重新绑定")));
        assert!(portable.native_secrets.is_empty());
    }
}
