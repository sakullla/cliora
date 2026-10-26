//! Versioned CLI contracts. The registry key is deliberately open so a future
//! tool can be registered without changing the five legacy serialized IDs.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use crate::credentials::CredentialStore;
use crate::history::{HistorySource, ParsedSession};
use crate::native::adapter::{self, NativeFile, Scope};
use crate::native::apply::NativeSecrets;
use crate::native::format::FileKind;
use crate::native::intake::NativeInspection;
use crate::native::profile::{Connection, ModelRecord, RegisteredProfile};
use crate::resources::mcp::McpDefinition;
use crate::remote::{RemoteCommandResult, RemoteTarget};

const REMOTE_RULE_HOME: &str = "/__cliora_capability_home__";
const REMOTE_RULE_PROJECT: &str = "/__cliora_capability_project__";

pub(crate) fn remote_rule_file(global: Option<&str>, project: Option<&str>, scope: Scope) -> Option<String> {
    match scope {
        Scope::Global => global.map(str::to_owned),
        Scope::Project => project.map(str::to_owned),
    }
}

pub(crate) fn safe_rule_relative(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('/')
        && value.split('/').all(|part| !part.is_empty() && part != "." && part != "..")
        && value.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '/' | '.' | '-' | '_'))
}

fn remote_rule_relative_from_rule_path<T: CliAdapter + ?Sized>(adapter: &T, scope: Scope) -> Option<String> {
    let home = Path::new(REMOTE_RULE_HOME);
    let project = Path::new(REMOTE_RULE_PROJECT);
    let path = adapter.rule_path(
        scope,
        home,
        match scope {
            Scope::Global => None,
            Scope::Project => Some(project),
        },
    )?;
    let text = path.to_string_lossy().replace('\\', "/");
    let marker = match scope {
        Scope::Global => REMOTE_RULE_HOME,
        Scope::Project => REMOTE_RULE_PROJECT,
    };
    let rest = text.strip_prefix(marker)?.trim_start_matches('/');
    safe_rule_relative(rest).then(|| rest.to_owned())
}

/// Adapter install declarations are authored for the local OS. A Cliora
/// process running on Windows can therefore receive a PowerShell installer
/// even when the selected SSH host is Linux/macOS. Translate the common
/// official `install.ps1` form to its POSIX counterpart before sending it
/// over SSH; all other adapter-owned commands remain unchanged.
fn portable_remote_install_command(command: &str) -> String {
    let trimmed = command.trim();
    if let Some(rest) = trimmed.strip_prefix("irm ") {
        if let Some((url, suffix)) = rest.split_once(" | iex") {
            if url.starts_with("http://") || url.starts_with("https://") {
                return format!("curl -fsSL {} | bash{}", url.replace(".ps1", ".sh"), suffix);
            }
        }
    }
    trimmed.to_owned()
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Facet {
    pub state: &'static str,
    pub reason: &'static str,
}

#[derive(Clone, Debug)]
pub struct McpLocation {
    pub path: PathBuf,
    pub kind: FileKind,
    pub root: &'static str,
    pub child: Option<&'static str>,
}

#[derive(Clone, Debug)]
pub struct SkillSwitchLocation {
    pub path: PathBuf,
    pub kind: FileKind,
    pub field: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterDescriptor {
    pub id: &'static str,
    pub name: &'static str,
    pub interface_formats: &'static [&'static str],
    pub project_model_override: bool,
    pub yolo_available: bool,
    pub launch_form: LaunchForm,
    pub native_config: Facet,
    pub launch: Facet,
    pub resume: Facet,
    pub resources: Facet,
    pub history: Facet,
    pub login: Option<LoginCapability>,
    pub management: ManagementCapabilities,
    pub configuration: Option<super::configuration::ConfigurationDescriptor>,
    pub remote: RemoteCapabilities,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFacet {
    pub state: &'static str,
    pub reason: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCapabilities {
    pub probe: RemoteFacet,
    pub configuration: RemoteFacet,
    pub accounts: RemoteFacet,
    pub resources: RemoteFacet,
    pub history: RemoteFacet,
    pub usage: RemoteFacet,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RemoteCapability {
    Probe,
    Configuration,
    Accounts,
    Resources,
    History,
    Usage,
}

impl RemoteCapability {
    pub fn key(self) -> &'static str {
        match self {
            Self::Probe => "probe",
            Self::Configuration => "configuration",
            Self::Accounts => "accounts",
            Self::Resources => "resources",
            Self::History => "history",
            Self::Usage => "usage",
        }
    }
}

/// Typed operation envelope shared by remote capability consumers. The
/// adapter owns the executable and operation syntax; callers only select the
/// capability and pass sanitized, capability-specific values.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RemoteOperation {
    Configuration { args: Vec<String> },
    Accounts { args: Vec<String> },
    Resources { args: Vec<String> },
    History { args: Vec<String> },
    Usage { args: Vec<String> },
}

impl RemoteOperation {
    fn capability(&self) -> RemoteCapability {
        match self {
            Self::Configuration { .. } => RemoteCapability::Configuration,
            Self::Accounts { .. } => RemoteCapability::Accounts,
            Self::Resources { .. } => RemoteCapability::Resources,
            Self::History { .. } => RemoteCapability::History,
            Self::Usage { .. } => RemoteCapability::Usage,
        }
    }

    fn args(&self) -> &[String] {
        match self {
            Self::Configuration { args }
            | Self::Accounts { args }
            | Self::Resources { args }
            | Self::History { args }
            | Self::Usage { args } => args,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteOperationResult {
    pub capability: &'static str,
    pub source: String,
    pub integrity: &'static str,
    #[serde(flatten)]
    pub command: RemoteCommandResult,
}

impl RemoteCapability {
    fn label(self) -> &'static str {
        match self {
            Self::Probe => "探测",
            Self::Configuration => "配置",
            Self::Accounts => "账号",
            Self::Resources => "资源",
            Self::History => "历史",
            Self::Usage => "额度",
        }
    }
}

impl RemoteCapabilities {
    fn facet(
        supported: bool,
        supported_reason: &'static str,
        unavailable_reason: &'static str,
    ) -> RemoteFacet {
        RemoteFacet {
            state: if supported { "supported" } else { "unsupported" },
            reason: if supported {
                supported_reason
            } else {
                unavailable_reason
            },
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagementCapabilities {
    pub accounts: bool,
    pub mcp: bool,
    pub skills: bool,
    pub agents: bool,
    pub plugins: bool,
    pub project_plugins: bool,
    pub rules: RuleSupport,
    /// Published only when a memory port declares a scope and at least one
    /// operation. The port resolves the storage directory per target; a
    /// recorded unverified reason stays on the port and does not create an entry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory: Option<super::memory::MemoryManagement>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleSupport {
    pub global: bool,
    pub project: bool,
    #[serde(default, skip_serializing_if = "str::is_empty")]
    pub global_reason: &'static str,
    #[serde(default, skip_serializing_if = "str::is_empty")]
    pub project_reason: &'static str,
    #[serde(default, skip_serializing_if = "is_false")]
    pub catalog: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl RuleSupport {
    pub const fn bare(global: bool, project: bool) -> Self {
        Self {
            global,
            project,
            global_reason: "",
            project_reason: "",
            catalog: false,
        }
    }
}

/// One file inside a directory-shaped rule catalog.
#[derive(Clone, Debug)]
pub struct RuleFileSpec {
    pub id: String,
    pub path: PathBuf,
    pub name: String,
    pub kind: &'static str,
    pub enabled: bool,
    pub writable: bool,
    pub detail: &'static str,
}

/// A skill directory that can be listed but not written by this CLI.
#[derive(Clone, Debug)]
pub struct SkillObservation {
    pub root: PathBuf,
    pub detail: &'static str,
}

/// Login-home relative skill directory scanned on a remote host.
/// Read-only roots are bundled or observed directories, same as the local scan.
#[derive(Clone, Copy, Debug)]
pub struct RemoteSkillDirectory {
    pub relative: &'static str,
    pub read_only: bool,
    pub detail: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginCapability {
    pub hint: &'static str,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LaunchMode {
    #[default]
    Normal,
    Yolo,
}

/// How a registered CLI is started: an interactive terminal session or the
/// installed desktop application. Terminal-only concerns (terminal choice,
/// session env markers) never apply to the desktop form.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LaunchForm {
    #[default]
    Terminal,
    Desktop,
}

/// One declared install line: a verified major contract family with its own
/// npm package and npm entry. The default declaration wraps the legacy
/// single-line fields so a single-channel adapter keeps its exact behavior.
/// Native directories and the native source predicate stay in the adapter
/// ports that already own them (`native_binary_directories`,
/// `recognizes_native_install_path`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InstallLine {
    /// Major version family served by this line; 0 marks the version-agnostic
    /// default line of a single-channel adapter.
    pub major: u32,
    pub npm_package: &'static str,
    /// npm entry relative to the shim directory, used to resolve a PowerShell
    /// shim to the real executable. `None` keeps the account port's entry.
    pub npm_entry: Option<&'static str>,
}

/// Parses the major family of a probed version string (`2.0.29`,
/// `v2.0.29-beta.1`).
pub fn version_major(version: &str) -> Option<u32> {
    version.trim().trim_start_matches('v').split('.').next()?.parse().ok()
}

/// Selects a declared line for an identified installed version. A line only
/// matches its own major; the version-agnostic default line (major 0) covers
/// every version. An unknown version only matches the default line, so a
/// specific family is never guessed.
pub fn install_line_for(lines: &[InstallLine], version: Option<&str>) -> Option<InstallLine> {
    match version.and_then(version_major) {
        Some(major) => lines
            .iter()
            .find(|line| line.major == major)
            .or_else(|| lines.iter().find(|line| line.major == 0))
            .copied(),
        None => lines.iter().find(|line| line.major == 0).copied(),
    }
}

/// Explicit cross-major upgrade declared by the adapter for the identified
/// install. The shared UI only renders it; the service only runs `command`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MajorUpgradeAction {
    pub label: &'static str,
    /// Official command. `None` means the identified install has no supported
    /// official path; `guidance` explains the manual route instead.
    pub command: Option<String>,
    pub guidance: Option<&'static str>,
}

#[derive(Default)]
pub struct InspectionFields {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub base: Option<String>,
    pub wire: Option<&'static str>,
    pub env: Option<String>,
    pub reasoning_effort: Option<String>,
}

pub type NativeCredentialRefs = BTreeMap<String, BTreeMap<String, String>>;
pub type PendingSecrets = Vec<(String, String)>;

/// An explicitly writable native key channel grants no HTTP credential access.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCredentialTarget {
    pub identity: String,
    pub label: String,
    pub role: String,
    pub path: Vec<String>,
    pub remove_paths: Vec<Vec<String>>,
}

/// npm registry `latest` URL. A scoped name encodes its separating slash so
/// the query never depends on registry redirects.
fn npm_registry_url(package: &str) -> Option<String> {
    (!package.is_empty()).then(|| format!("https://registry.npmjs.org/{}/latest", package.replace('/', "%2F")))
}

/// Shared npm install policy: optional dependencies, lifecycle scripts and
/// bounded network retries, with the top-level package always script-allowed.
fn npm_install_command_for(package: &str, script_dependencies: &[&str]) -> Option<String> {
    let scripts = std::iter::once(package).chain(script_dependencies.iter().copied()).collect::<Vec<_>>().join(",");
    (!package.is_empty()).then(|| format!("npm install -g {package}@latest --include=optional --ignore-scripts=false --foreground-scripts --allow-scripts={scripts} --no-audit --no-fund --fetch-retries=3 --fetch-timeout=60000 --fetch-retry-mintimeout=1000 --fetch-retry-maxtimeout=10000"))
}

fn npm_uninstall_command_for(package: &str) -> Option<String> {
    (!package.is_empty()).then(|| format!("npm uninstall -g {package}"))
}

fn remote_command(executable: &str, args: &[&str]) -> String {
    let mut command = crate::remote::quote_command_arg(executable);
    for arg in args {
        command.push(' ');
        command.push_str(&crate::remote::quote_command_arg(arg));
    }
    command
}

pub trait CliAdapter: Sync {
    /// Dispatches one adapter-owned, read-only remote command through the
    /// shared OpenSSH transport. Capability checks happen before transport
    /// launch, so unsupported ports never create a remote connection.
    fn dispatch_remote(
        &self,
        target: &RemoteTarget,
        capability: RemoteCapability,
        args: &[&str],
    ) -> Result<RemoteCommandResult, String> {
        let capabilities = self.remote_capabilities();
        let facet = match capability {
            RemoteCapability::Probe => &capabilities.probe,
            RemoteCapability::Configuration => &capabilities.configuration,
            RemoteCapability::Accounts => &capabilities.accounts,
            RemoteCapability::Resources => &capabilities.resources,
            RemoteCapability::History => &capabilities.history,
            RemoteCapability::Usage => &capabilities.usage,
        };
        if facet.state != "supported" {
            return Err(format!("远程{}不可用：{}", capability.label(), facet.reason));
        }
        let command = remote_command(self.command(), args);
        crate::remote::run_command(target, &command).map_err(|error| error.to_string())
    }

    /// Adapter-owned executable probe. The shared transport only carries the
    /// command; the adapter owns the executable and probe arguments.
    fn remote_probe(&self, target: &RemoteTarget) -> Result<RemoteCommandResult, String> {
        self.dispatch_remote(target, RemoteCapability::Probe, &["--version"])
    }

    fn dispatch_remote_owned_command(
        &self,
        target: &RemoteTarget,
        command: &str,
    ) -> Result<RemoteCommandResult, String> {
        let capabilities = self.remote_capabilities();
        if capabilities.probe.state != "supported" {
            return Err(format!("远程探测不可用：{}", capabilities.probe.reason));
        }
        crate::remote::run_command(target, command).map_err(|error| error.to_string())
    }

    fn remote_install(&self, target: &RemoteTarget) -> Result<RemoteCommandResult, String> {
        let command = self
            .install_command()
            .map(|command| portable_remote_install_command(&command))
            .ok_or_else(|| "此 CLI 未声明远程安装命令".to_owned())?;
        self.dispatch_remote_owned_command(target, &command)
    }

    fn remote_upgrade(&self, target: &RemoteTarget, source: &str) -> Result<RemoteCommandResult, String> {
        let command = self.upgrade_command(source).ok_or_else(|| "此 CLI 未声明远程升级命令".to_owned())?;
        self.dispatch_remote_owned_command(target, &command)
    }

    fn remote_uninstall(&self, target: &RemoteTarget) -> Result<RemoteCommandResult, String> {
        let command = self
            .uninstall_command()
            .ok_or_else(|| "此 CLI 未声明远程卸载命令".to_owned())?;
        self.dispatch_remote_owned_command(target, &command)
    }

    /// Capability-specific declarations are opt-in. A local port alone does
    /// not imply that its remote protocol is available.
    fn remote_configuration_declared(&self) -> bool {
        false
    }
    fn remote_accounts_declared(&self) -> bool {
        false
    }
    fn remote_resources_declared(&self) -> bool {
        false
    }
    fn remote_history_declared(&self) -> bool {
        false
    }
    fn remote_usage_declared(&self) -> bool {
        false
    }

    fn remote_port_command(
        &self,
        capability: RemoteCapability,
        args: &[&str],
    ) -> Result<String, String> {
        let capabilities = self.remote_capabilities();
        let facet = match capability {
            RemoteCapability::Probe => &capabilities.probe,
            RemoteCapability::Configuration => &capabilities.configuration,
            RemoteCapability::Accounts => &capabilities.accounts,
            RemoteCapability::Resources => &capabilities.resources,
            RemoteCapability::History => &capabilities.history,
            RemoteCapability::Usage => &capabilities.usage,
        };
        if facet.state != "supported" {
            return Err(format!("远程{}不可用：{}", capability.label(), facet.reason));
        }
        Ok(remote_command(self.command(), args))
    }

    fn remote_configuration_command(&self, args: &[&str]) -> Result<String, String> {
        self.remote_port_command(RemoteCapability::Configuration, args)
    }
    fn remote_accounts_command(&self, args: &[&str]) -> Result<String, String> {
        self.remote_port_command(RemoteCapability::Accounts, args)
    }
    /// Validate adapter-specific account protocol output before a consumer
    /// marks the result as complete. The default keeps the port unavailable.
    fn parse_remote_accounts(&self, _stdout: &str) -> Result<(), String> {
        Err("此 CLI 未声明远程账号结果解析器".into())
    }
    fn remote_resources_command(&self, args: &[&str]) -> Result<String, String> {
        self.remote_port_command(RemoteCapability::Resources, args)
    }
    fn remote_history_command(&self, args: &[&str]) -> Result<String, String> {
        self.remote_port_command(RemoteCapability::History, args)
    }
    fn remote_usage_command(&self, args: &[&str]) -> Result<String, String> {
        self.remote_port_command(RemoteCapability::Usage, args)
    }

    fn dispatch_remote_port(
        &self,
        target: &RemoteTarget,
        capability: RemoteCapability,
        command: Result<String, String>,
    ) -> Result<RemoteCommandResult, String> {
        let command = command?;
        let capabilities = self.remote_capabilities();
        let facet = match capability {
            RemoteCapability::Probe => &capabilities.probe,
            RemoteCapability::Configuration => &capabilities.configuration,
            RemoteCapability::Accounts => &capabilities.accounts,
            RemoteCapability::Resources => &capabilities.resources,
            RemoteCapability::History => &capabilities.history,
            RemoteCapability::Usage => &capabilities.usage,
        };
        if facet.state != "supported" {
            return Err(format!("远程{}不可用：{}", capability.label(), facet.reason));
        }
        crate::remote::run_command(target, &command).map_err(|error| error.to_string())
    }

    fn remote_operation(
        &self,
        target: &RemoteTarget,
        operation: &RemoteOperation,
    ) -> Result<RemoteOperationResult, String> {
        let capability = operation.capability();
        let args = operation
            .args()
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        let command = match capability {
            RemoteCapability::Configuration => self.remote_configuration_command(&args),
            RemoteCapability::Accounts => self.remote_accounts_command(&args),
            RemoteCapability::Resources => self.remote_resources_command(&args),
            RemoteCapability::History => self.remote_history_command(&args),
            RemoteCapability::Usage => self.remote_usage_command(&args),
            RemoteCapability::Probe => unreachable!("probe is not a capability operation"),
        };
        let result = self.dispatch_remote_port(target, capability, command)?;
        Ok(RemoteOperationResult {
            capability: capability.key(),
            source: format!("ssh:{}", result.target_id),
            integrity: if result.exit_code == 0 {
                "transport_verified"
            } else {
                "unverified"
            },
            command: result,
        })
    }

    fn remote_configuration(
        &self,
        target: &RemoteTarget,
        args: &[&str],
    ) -> Result<RemoteCommandResult, String> {
        self.dispatch_remote_port(target, RemoteCapability::Configuration, self.remote_configuration_command(args))
    }
    fn remote_accounts(
        &self,
        target: &RemoteTarget,
        args: &[&str],
    ) -> Result<RemoteCommandResult, String> {
        self.dispatch_remote_port(target, RemoteCapability::Accounts, self.remote_accounts_command(args))
    }
    fn remote_resources(
        &self,
        target: &RemoteTarget,
        args: &[&str],
    ) -> Result<RemoteCommandResult, String> {
        self.dispatch_remote_port(target, RemoteCapability::Resources, self.remote_resources_command(args))
    }
    fn remote_history(
        &self,
        target: &RemoteTarget,
        args: &[&str],
    ) -> Result<RemoteCommandResult, String> {
        self.dispatch_remote_port(target, RemoteCapability::History, self.remote_history_command(args))
    }
    fn remote_usage(
        &self,
        target: &RemoteTarget,
        args: &[&str],
    ) -> Result<RemoteCommandResult, String> {
        self.dispatch_remote_port(target, RemoteCapability::Usage, self.remote_usage_command(args))
    }

    fn remote_capabilities(&self) -> RemoteCapabilities {
        RemoteCapabilities {
            probe: RemoteCapabilities::facet(
                !self.command().trim().is_empty(),
                "远程 CLI 探测沿用适配器 executable",
                "此 CLI 未声明可探测的远程 executable",
            ),
            configuration: RemoteCapabilities::facet(
                self.configuration().is_some() && self.remote_configuration_declared(),
                "适配器已声明远程配置端口",
                "此 CLI 未声明可通过远程传输读写的配置端口",
            ),
            accounts: RemoteCapabilities::facet(
                self.accounts().is_some() && self.remote_accounts_declared(),
                "适配器已声明远程账号观察端口",
                "此 CLI 未声明远程账号观察端口",
            ),
            resources: RemoteCapabilities::facet(
                (self.supports_mcp()
                    || self.supports_skills()
                    || self.agents().is_some()
                    || self.plugins().is_some()
                    || self.memory().is_some())
                    && self.remote_resources_declared(),
                "适配器已声明远程资源端口",
                "此 CLI 未声明可用的远程资源 capability port",
            ),
            history: RemoteCapabilities::facet(
                self.history_supported() && self.remote_history_declared(),
                "适配器已声明远程历史端口",
                "此 CLI 未声明已验证的远程历史格式",
            ),
            usage: RemoteCapabilities::facet(
                self.official_usage().is_some() && self.remote_usage_declared(),
                "适配器已声明远程额度端口",
                "此 CLI 未声明官方远程额度查询端口",
            ),
        }
    }
    fn native_credential_target(&self, _scope: Scope) -> Option<NativeCredentialTarget> { None }
    fn portable_field_kind(&self, path: &[String]) -> super::configuration::PortableFieldKind {
        self.configuration().map_or(super::configuration::PortableFieldKind::Unknown, |port| port.portable_field_kind(path))
    }

    fn configuration(&self) -> Option<&dyn super::configuration::ConfigurationAdapter> { None }
    fn supports_mcp(&self) -> bool { false }
    fn supports_skills(&self) -> bool { false }
    fn official_usage(&self) -> Option<&dyn super::official::OfficialUsageAdapter> {
        None
    }
    fn agents(&self) -> Option<&dyn super::agents::AgentAdapter> {
        None
    }
    fn plugins(&self) -> Option<&dyn super::plugins::PluginAdapter> {
        None
    }
    fn accounts(&self) -> Option<&dyn super::accounts::AccountAdapter> {
        None
    }
    fn memory(&self) -> Option<&dyn super::memory::MemoryAdapter> {
        None
    }
    fn id(&self) -> &'static str;
    fn name(&self) -> &'static str;
    fn command(&self) -> &'static str;
    fn npm_package(&self) -> &'static str;
    /// Declared install lines. The default wraps the legacy single-line fields
    /// so a single-channel adapter keeps its behavior; an adapter with several
    /// verified major families declares one line per family.
    fn install_lines(&self) -> Vec<InstallLine> {
        vec![InstallLine {
            major: 0,
            npm_package: self.npm_package(),
            npm_entry: None,
        }]
    }
    /// The declared line selected for an identified installed version. `None`
    /// means the version cannot select a line; callers must not guess one.
    fn install_line_for_version(&self, version: Option<&str>) -> Option<InstallLine> {
        install_line_for(&self.install_lines(), version)
    }
    /// npm package names that identify this adapter's npm shims. Derived from
    /// the declared lines so a multi-line adapter recognizes every shim.
    fn npm_packages(&self) -> Vec<&'static str> {
        self.install_lines()
            .into_iter()
            .map(|line| line.npm_package)
            .filter(|package| !package.is_empty())
            .collect()
    }
    /// Public release metadata belongs to the adapter; transport and caching
    /// belong to the shared native service. No npm request for standalone CLIs.
    fn latest_version_url(&self) -> Option<String> {
        let package = self.npm_package();
        (!package.is_empty()).then(|| format!("https://registry.npmjs.org/{package}/latest"))
    }
    /// Release URL for the identified install line. The default keeps the
    /// adapter's single-line policy; a multi-line adapter derives the registry
    /// query from the selected line and returns `None` for unknown versions.
    fn latest_version_url_for_version(&self, version: Option<&str>) -> Option<String> {
        match self.install_line_for_version(version) {
            Some(line) if line.major != 0 => npm_registry_url(line.npm_package),
            Some(_) => self.latest_version_url(),
            None => None,
        }
    }
    fn parse_latest_version(&self, text: &str) -> Option<String> {
        serde_json::from_str::<Value>(text).ok()?.get("version")?.as_str().map(str::to_owned)
    }
    fn version_identity(&self, basename: &str, output: &str) -> bool;
    /// Noninteractive version probes may disable adapter-owned startup work.
    /// These overrides never apply to interactive launches or user configuration.
    fn version_probe_environment(&self) -> &'static [(&'static str, &'static str)] { &[] }
    /// Desktop installation evidence; never launch a GUI with `--version`.
    /// Paths and product/version markers belong to the implementation.
    fn native_installations(&self, _home: &Path) -> Vec<crate::native::adapter::Installation> {
        Vec::new()
    }
    /// Adapter-owned versioned binaries outside PATH, validated by the shared
    /// process probe just like ordinary candidates.
    fn extra_binary_candidates(&self, _home: &Path) -> Vec<PathBuf> { Vec::new() }
    fn native_files(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
        known: bool,
    ) -> Vec<NativeFile>;
    fn interface_formats(&self) -> &'static [&'static str];
    fn file_kind(&self, role: &str) -> Result<FileKind, String>;
    /// Top-level native settings that remain meaningful across devices.
    /// All other native fields stay in the local file and are not packed.
    fn portable_root_fields(&self, _role: &str) -> &'static [&'static str] {
        &[]
    }
    fn auth_env_name(&self, connection: &Connection) -> Option<String> {
        if let Some(name) = &connection.auth_env_var {
            return Some(name.clone());
        }
        connection.secret_ref.as_ref()?;
        let tool = self.id().to_ascii_uppercase().replace('-', "_");
        let provider = connection
            .provider_id
            .to_ascii_uppercase()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .collect::<String>();
        Some(format!("CLIORA_{tool}_{provider}_API_KEY"))
    }
    /// Whether this CLI reads its managed connection key only from the OS
    /// environment: application writes no key into native files, and the
    /// shared launch service injects `auth_env_name` into the child process
    /// at spawn time. Default false — the key travels through native files.
    fn connection_secret_via_launch_env(&self) -> bool {
        false
    }
    /// Retained adapter flag. Schema 3 snapshots still copy connection API keys;
    /// a false result must not drop the key or force a rebind.
    fn exports_connection_secret(&self) -> bool {
        true
    }
    fn connection_documents(
        &self,
        connection: &Connection,
        scope: Scope,
    ) -> Result<BTreeMap<String, Value>, String>;
    /// Key, provider-address, and model-projection capability for the loaded scope.
    fn connection_policy(&self, _scope: Scope) -> adapter::ConnectionPolicy {
        adapter::ConnectionPolicy {
            api_key: adapter::api_key_writable(),
            provider_address: adapter::address_configurable(),
            projection: "single_connection",
        }
    }
    /// Models already stored under the selected provider. `None` means this CLI
    /// does not project nested model records.
    fn projected_models(
        &self,
        _settings: &Value,
        _models: &Value,
        _provider: Option<&str>,
    ) -> Option<Vec<ModelRecord>> {
        None
    }
    fn connection_documents_for_existing(
        &self,
        connection: &Connection,
        scope: Scope,
        _existing: &BTreeMap<String, Value>,
    ) -> Result<BTreeMap<String, Value>, String> {
        self.connection_documents(connection, scope)
    }
    /// Form-aware siblings for adapters whose connection documents moved
    /// between native forms. The token comes from the configuration adapter's
    /// resolved native form; `None` keeps the legacy default.
    fn connection_documents_for_version(
        &self,
        connection: &Connection,
        scope: Scope,
        form: Option<&str>,
    ) -> Result<BTreeMap<String, Value>, String> {
        let _ = form;
        self.connection_documents(connection, scope)
    }
    fn connection_documents_for_existing_for_version(
        &self,
        connection: &Connection,
        scope: Scope,
        existing: &BTreeMap<String, Value>,
        form: Option<&str>,
    ) -> Result<BTreeMap<String, Value>, String> {
        let _ = form;
        self.connection_documents_for_existing(connection, scope, existing)
    }
    /// Drop or rewrite fields the CLI rejects after documents are merged.
    fn normalize_applied_document(&self, _role: &str, _document: &mut Value) {}
    /// Top-level collections whose empty object entries are invalid native config.
    /// Profile application removes only empty direct children, including residue
    /// from earlier switches. Nonempty entries and other collections are preserved.
    /// Adapters declare schema; shared services own patching, conflicts and backups.
    fn empty_entry_collections(&self, _role: &str) -> &'static [&'static str] {
        &[]
    }
    fn preserve_native_fields(
        &self,
        _role: &str,
        _original: &Value,
        _fields: &mut BTreeMap<String, Value>,
        _profile: &RegisteredProfile,
    ) -> Result<(), String> {
        Ok(())
    }
    fn write_connection_secret_for_documents(
        &self,
        profile: &RegisteredProfile,
        scope: Scope,
        credentials: &dyn CredentialStore,
        secrets: &mut NativeSecrets,
        _documents: &BTreeMap<String, Value>,
    ) -> Result<(), String> {
        self.write_connection_secret(profile, scope, credentials, secrets)
    }
    fn request_model_id(&self, model: &str) -> String {
        model.into()
    }
    /// Env vars a running instance of this CLI injects into child processes to mark
    /// nested sessions; a fresh terminal launch must not inherit them.
    fn session_env_markers(&self) -> &'static [&'static str] {
        &[]
    }
    fn write_connection_secret(
        &self,
        profile: &RegisteredProfile,
        scope: Scope,
        credentials: &dyn CredentialStore,
        secrets: &mut NativeSecrets,
    ) -> Result<(), String>;
    /// A new key on a scope that cannot store one fails before any file is opened.
    fn reject_new_secret(&self, profile: &RegisteredProfile, scope: Scope) -> Result<(), String> {
        let Some(connection) = &profile.connection else {
            return Ok(());
        };
        if connection.secret_ref.as_deref().is_none_or(str::is_empty) {
            return Ok(());
        }
        let facet = self.connection_policy(scope).api_key;
        if facet.state == "writable" {
            Ok(())
        } else {
            Err(facet.reason.to_owned())
        }
    }
    fn has_native_secret(&self, role: &str, root: &Value) -> bool;
    fn inspect_values(
        &self,
        settings: &Value,
        local_settings: &Value,
        models: &Value,
    ) -> InspectionFields;
    fn import_literal_secrets(
        &self,
        _files: &mut BTreeMap<String, String>,
        _found: &mut NativeInspection,
        _pending: &mut PendingSecrets,
        _native_refs: &mut NativeCredentialRefs,
    ) -> Result<(), String> {
        Ok(())
    }
    fn validate_draft(&self, _role: &str, _parsed: &Value) -> Result<(), String> {
        Ok(())
    }
    fn accepts_native_credential(&self, _role: &str, _name: &str) -> bool {
        false
    }
    fn imported_connection_overrides_native(&self) -> bool {
        false
    }
    fn restore_imported_secrets(
        &self,
        _profile: &RegisteredProfile,
        _scope: Scope,
        _credentials: &dyn CredentialStore,
        _secrets: &mut NativeSecrets,
    ) -> Result<(), String> {
        Ok(())
    }
    fn connection_roles(&self) -> &'static [&'static str] {
        &["settings"]
    }
    fn validate_role_scope(&self, _role: &str, _scope: Scope) -> Result<(), String> {
        Ok(())
    }
    fn validate_documents(
        &self,
        _scope: Scope,
        _documents: &BTreeMap<String, Value>,
    ) -> Result<(), String> {
        Ok(())
    }
    /// Returns arguments only. The caller owns executable selection and process launch.
    fn login_args(&self) -> Option<Vec<String>> {
        None
    }
    fn login_hint(&self) -> &'static str {
        ""
    }
    fn launch_args(&self, session: Option<&str>, mode: LaunchMode) -> Result<Vec<String>, String>;
    /// Version-specific launch arguments. The default ignores the version and
    /// keeps `launch_args`. Adapters override this when a verified major needs
    /// a different flag.
    fn launch_args_for_version(
        &self,
        version: &str,
        session: Option<&str>,
        mode: LaunchMode,
    ) -> Result<Vec<String>, String> {
        let _ = version;
        self.launch_args(session, mode)
    }
    /// Resume the latest session in the working directory. This is not a
    /// session id and must not be combined with `launch_args`'s session flag.
    /// The default has no verified flag.
    fn resume_latest_args(&self, mode: LaunchMode) -> Result<Vec<String>, String> {
        let _ = mode;
        Err("此 CLI 没有已核对的恢复最近会话参数".into())
    }
    /// Declares whether launches open an interactive terminal or start the
    /// installed desktop application directly. Defaults to terminal.
    fn launch_form(&self) -> LaunchForm {
        LaunchForm::Terminal
    }
    /// Directory-dependent arguments for a desktop launch, such as a workspace
    /// flag. Only consulted for the desktop form; terminal launches set the
    /// working directory instead.
    fn desktop_launch_args(&self, _directory: &Path) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    fn history_sources(&self, _home: &Path) -> Result<Vec<HistorySource>, String> {
        Ok(Vec::new())
    }
    /// Session files memory must not overwrite. The default reuses
    /// `history_sources`. Adapters whose source scan also fingerprints every
    /// transcript can list the same paths without that work.
    fn history_exclusion_paths(&self, home: &Path) -> Result<Vec<PathBuf>, String> {
        Ok(self
            .history_sources(home)?
            .into_iter()
            .map(|source| source.path)
            .collect())
    }
    fn parse_history(&self, _source: &HistorySource) -> Result<ParsedSession, String> {
        Err("此 CLI 尚无已验证的历史格式".into())
    }
    fn history_sources_controlled(
        &self,
        home: &Path,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Vec<HistorySource>, String> {
        crate::history::check_cancelled(cancelled)?;
        let sources = self.history_sources(home)?;
        crate::history::check_cancelled(cancelled)?;
        Ok(sources)
    }
    fn parse_history_controlled(
        &self,
        source: &HistorySource,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<ParsedSession, String> {
        crate::history::check_cancelled(cancelled)?;
        let parsed = self.parse_history(source)?;
        crate::history::check_cancelled(cancelled)?;
        Ok(parsed)
    }
    fn history_supported(&self) -> bool {
        false
    }
    /// Directory under the remote login home that holds this CLI's native history.
    /// The records page mirrors that tree and parses it with this adapter.
    /// Absent means the CLI has no verified remote history layout.
    fn native_history_relative(&self) -> Option<&'static str> {
        None
    }
    /// Verified parent/child association for usage records.
    /// `None` means this adapter has not declared one. The catalog then
    /// publishes `unavailable` when history itself is supported, and omits
    /// the facet entirely when it is not.
    fn history_association(&self) -> Option<Facet> {
        None
    }
    fn history_resume_version_supported(&self, _version: &str) -> bool {
        true
    }
    fn supports_project_model_override(&self) -> bool {
        false
    }
    fn project_model_args(&self, model: Option<&str>) -> Result<Vec<String>, String> {
        if model.is_some() {
            return Err("此 CLI 不支持项目启动模型覆盖".into());
        }
        Ok(Vec::new())
    }
    fn skill_switch_location(
        &self,
        _scope: Scope,
        _home: &Path,
        _project: Option<&Path>,
        _name: &str,
    ) -> Option<SkillSwitchLocation> {
        None
    }
    /// Whether the skill switch location follows the identified native major
    /// version. Version-tracked adapters receive the probed install version,
    /// resolved through the shared cached probe so a read and a later write
    /// agree on the same evidence.
    fn skill_switch_requires_version(&self) -> bool {
        false
    }
    /// Version-aware switch location. The default keeps the static location.
    fn skill_switch_location_for_version(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
        name: &str,
        version: Option<&str>,
    ) -> Option<SkillSwitchLocation> {
        let _ = version;
        self.skill_switch_location(scope, home, project, name)
    }
    fn skill_switch_value(&self, _current: &Value, _enabled: bool, _skill_path: &Path) -> Value {
        Value::Null
    }
    fn skill_switch_enabled(&self, _current: &Value, _skill_path: &Path) -> bool {
        true
    }
    fn skill_switch_snapshot(&self, current: &Value, _skill_path: &Path) -> Option<Value> {
        (!current.is_null()).then(|| current.clone())
    }
    /// Value-level switch operations may depend on the located native form
    /// (a scalar entry or an ordered rule array). The defaults keep the
    /// value-only behavior of the legacy methods.
    fn skill_switch_value_at(
        &self,
        _location: &SkillSwitchLocation,
        current: &Value,
        enabled: bool,
        skill_path: &Path,
    ) -> Value {
        self.skill_switch_value(current, enabled, skill_path)
    }
    fn skill_switch_snapshot_at(
        &self,
        _location: &SkillSwitchLocation,
        current: &Value,
        skill_path: &Path,
    ) -> Option<Value> {
        self.skill_switch_snapshot(current, skill_path)
    }
    fn skill_switch_restore(
        &self,
        _current: &Value,
        previous: Option<&Value>,
        _skill_path: &Path,
    ) -> Option<Value> {
        previous.cloned()
    }
    fn mcp_location(
        &self,
        _scope: Scope,
        _home: &Path,
        _project: Option<&Path>,
    ) -> Option<McpLocation> {
        None
    }
    fn mcp_requires_version(&self) -> bool {
        false
    }
    /// Enumerate logical MCP entries. Sequence/composition formats override this
    /// together with mcp_change; shared transactions still own concurrency and backups.
    fn mcp_entries(&self, parsed: &Value, location: &McpLocation) -> Result<serde_json::Map<String, Value>, String> {
        let root = parsed.get(location.root);
        Ok(root.and_then(|root| location.child.map_or(Some(root), |child| root.get(child)))
            .and_then(Value::as_object).cloned().unwrap_or_default())
    }
    /// Normalize an entry for display, including its native enabled/disabled state.
    fn mcp_entry_view(&self, entry: &Value) -> Value { entry.clone() }
    fn mcp_change(&self, _parsed: &Value, location: &McpLocation, name: &str, value: Option<Value>) -> Result<crate::native::transaction::FieldChange, String> {
        let mut path = vec![location.root.to_owned()];
        if let Some(child) = location.child { path.push(child.to_owned()); }
        path.push(name.to_owned());
        Ok(crate::native::transaction::FieldChange { path, value })
    }
    fn mcp_location_for_version(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
        _version: Option<&str>,
    ) -> Option<McpLocation> {
        self.mcp_location(scope, home, project)
    }
    fn mcp_document(
        &self,
        _definition: &McpDefinition,
        _enabled: bool,
        _existing: Option<&Value>,
    ) -> Result<Option<Value>, String> {
        Err("此 CLI 没有已确认的原生 MCP 配置格式".into())
    }
    fn mcp_document_at(
        &self,
        definition: &McpDefinition,
        enabled: bool,
        existing: Option<&Value>,
        _location: &McpLocation,
    ) -> Result<Option<Value>, String> {
        self.mcp_document(definition, enabled, existing)
    }
    fn mcp_disabled_description(&self) -> Option<&'static str> {
        None
    }
    fn skill_root(&self, _scope: Scope, _home: &Path, _project: Option<&Path>) -> Option<PathBuf> {
        None
    }
    /// Directories without SKILL.md are not skills for this CLI.
    fn skill_requires_manifest(&self) -> bool {
        false
    }
    /// Extra skill roots. They are discovered and stay read-only.
    fn skill_observations(
        &self,
        _scope: Scope,
        _home: &Path,
        _project: Option<&Path>,
    ) -> Vec<SkillObservation> {
        Vec::new()
    }
    /// Remote inventory uses these paths under the login home. Empty keeps the
    /// historical single-root fallback in the remote resource store.
    fn remote_skill_directories(&self) -> &'static [RemoteSkillDirectory] {
        &[]
    }
    /// Public MCP views omit literal secrets. Removing the entry keeps those
    /// values in the credential store until the next enable writes them back.
    fn mcp_redacts_secrets(&self) -> bool {
        false
    }
    fn rule_path(&self, _scope: Scope, _home: &Path, _project: Option<&Path>) -> Option<PathBuf> {
        None
    }
    /// Single native rule file on a remote POSIX host. Global results are
    /// relative to the login home. Project results are relative to the project
    /// directory. Local environment variables and Windows paths are not used.
    fn remote_rule_relative(&self, scope: Scope) -> Option<String> {
        remote_rule_relative_from_rule_path(self, scope)
    }
    /// Project or user rules stored as many files instead of one document.
    fn uses_rule_catalog(&self, _scope: Scope) -> bool {
        false
    }
    fn rule_file_specs(
        &self,
        _scope: Scope,
        _home: &Path,
        _project: Option<&Path>,
    ) -> Result<Vec<RuleFileSpec>, String> {
        Err("此 CLI 没有目录型规则".into())
    }
    fn rule_create_path(&self, _project: &Path, _name: &str) -> Result<PathBuf, String> {
        Err("此 CLI 不能新建目录型规则".into())
    }
    fn rule_relocate(&self, _project: &Path, _path: &Path, _enabled: bool) -> Result<PathBuf, String> {
        Err("此 CLI 不能启停目录型规则".into())
    }
    fn rule_unavailable_reason(&self, _scope: Scope) -> Option<&'static str> {
        None
    }
    fn rule_support(&self) -> RuleSupport {
        let home = Path::new("/__cliora_capability_home__");
        let project = Path::new("/__cliora_capability_project__");
        let mut support = RuleSupport::bare(
            self.rule_path(Scope::Global, home, None).is_some() || self.uses_rule_catalog(Scope::Global),
            self.rule_path(Scope::Project, home, Some(project)).is_some() || self.uses_rule_catalog(Scope::Project),
        );
        support.catalog = self.uses_rule_catalog(Scope::Global) || self.uses_rule_catalog(Scope::Project);
        support
    }
    fn published_memory(&self) -> Option<super::memory::MemoryManagement> {
        self.memory().and_then(|port| super::memory::publish(&port.declaration()))
    }
    fn install_guidance(&self) -> (&'static str, &'static str);
    fn node_required_when_missing(&self) -> bool {
        true
    }
    fn minimum_node_version(&self) -> Option<(u32, u32, u32)> {
        None
    }
    fn node_dependency_detail(&self) -> &'static str {
        "npm 命令入口需要 Node.js"
    }
    fn requires_windows_bash(&self) -> bool {
        false
    }
    fn recognizes_native_install_path(&self, _path: &Path) -> bool {
        false
    }
    fn native_binary_directories(&self, _home: &Path) -> Vec<PathBuf> {
        Vec::new()
    }
    fn install_command(&self) -> Option<String> {
        self.npm_install_command()
    }
    fn native_install_command(&self) -> Option<String> {
        None
    }
    fn npm_install_command(&self) -> Option<String> {
        npm_install_command_for(self.npm_package(), self.npm_script_dependencies())
    }
    /// npm install command for the identified install line. A multi-line
    /// adapter derives it from the selected line; the default single line keeps
    /// the adapter's own command policy.
    fn npm_install_command_for_version(&self, version: Option<&str>) -> Option<String> {
        match self.install_line_for_version(version) {
            Some(line) if line.major != 0 => npm_install_command_for(line.npm_package, self.npm_script_dependencies()),
            Some(_) => self.npm_install_command(),
            None => None,
        }
    }
    /// npm 11.17+ script policy. Adapters declare native build dependencies;
    /// the top-level package is always included, scoped to this invocation.
    fn npm_script_dependencies(&self) -> &'static [&'static str] { &[] }
    fn upgrade_command(&self, source: &str) -> Option<String> {
        (source == "npm_shim").then(|| self.npm_install_command()).flatten()
    }
    /// Regular update command for the identified install line. An npm install
    /// stays inside the selected line's package, so a 1.x install never jumps
    /// majors through a routine update. Unknown versions yield no command.
    fn upgrade_command_for_version(&self, source: &str, version: Option<&str>) -> Option<String> {
        if source != "npm_shim" {
            return self.upgrade_command(source);
        }
        match self.install_line_for_version(version) {
            Some(line) if line.major != 0 => npm_install_command_for(line.npm_package, self.npm_script_dependencies()),
            Some(_) => self.upgrade_command(source),
            None => None,
        }
    }
    fn npm_uninstall_command(&self) -> Option<String> {
        npm_uninstall_command_for(self.npm_package())
    }
    /// Adapter-owned uninstall command used by the remote lifecycle port.
    /// Adapters with a native package manager can override this declaration.
    fn uninstall_command(&self) -> Option<String> {
        self.npm_uninstall_command()
    }
    /// npm uninstall command for the identified install line.
    fn npm_uninstall_command_for_version(&self, version: Option<&str>) -> Option<String> {
        match self.install_line_for_version(version) {
            Some(line) if line.major != 0 => npm_uninstall_command_for(line.npm_package),
            Some(_) => self.npm_uninstall_command(),
            None => None,
        }
    }
    /// Explicit cross-major upgrade declared by the adapter for the identified
    /// install. `None` hides the action; a declared action without a command
    /// only shows official guidance and never changes the installation.
    fn major_upgrade(&self, _source: &str, _version: Option<&str>) -> Option<MajorUpgradeAction> {
        None
    }
    fn anthropic_base_url(&self) -> &'static str {
        "https://api.anthropic.com/v1"
    }
    fn explicitly_incompatible_native_version(&self, _version: &str) -> bool {
        false
    }
    fn explicitly_incompatible_launch_version(&self, _version: &str) -> bool {
        false
    }
    fn descriptor(&self) -> AdapterDescriptor {
        AdapterDescriptor {
            remote: self.remote_capabilities(),
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
                plugins: self.plugins().is_some_and(|adapter| !adapter.capability().actions.is_empty()),
                project_plugins: self.plugins().is_some_and(|adapter| adapter.capability().project),
                rules: self.rule_support(),
                memory: self.published_memory(),
            },
            login: self.login_args().map(|_| LoginCapability {
                hint: self.login_hint(),
            }),
            name: self.name(),
            interface_formats: self.interface_formats(),
            project_model_override: self.supports_project_model_override(),
            yolo_available: self.launch_args(None, LaunchMode::Yolo).is_ok(),
            launch_form: self.launch_form(),
            native_config: Facet {
                state: "available",
                reason: "已确认 CLI 身份，可编辑受支持的原生文件格式",
            },
            launch: Facet {
                state: "available",
                reason: if self.launch_form() == LaunchForm::Desktop {
                    "可直接启动已安装的桌面应用"
                } else {
                    "可在外部终端启动"
                },
            },
            resume: Facet {
                state: "available",
                reason: "可用原生会话 ID 在外部终端恢复；历史索引后续接入",
            },
            resources: Facet {
                state: "available",
                reason: "原生资源路径由此 CLI 适配器逐项提供",
            },
            history: Facet {
                state: if self.history_supported() {
                    "available"
                } else {
                    "unknown"
                },
                reason: if self.history_supported() {
                    "可只读索引已验证的本地会话格式"
                } else {
                    "尚无已验证的本地历史格式"
                },
            },
        }
    }
}

/// Update keys that already exist. Nested objects recurse; absent keys are not created.
pub(crate) fn assign_existing_fields(target: &mut Value, edits: &serde_json::Map<String, Value>) {
    let Some(target_map) = target.as_object_mut() else {
        return;
    };
    for (key, edit) in edits {
        if !target_map.contains_key(key) {
            continue;
        }
        let current = target_map.get_mut(key).unwrap();
        if current.is_object() && edit.as_object().is_some_and(|map| !map.is_empty()) {
            let nested = edit.as_object().unwrap().clone();
            assign_existing_fields(current, &nested);
        } else {
            *current = edit.clone();
        }
    }
}

pub(crate) fn pointer_token(value: &str) -> String {
    value.replace('~', "~0").replace('/', "~1")
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnknownAdapterRecord {
    pub id: String,
    pub profile_count: u32,
    pub read_only: bool,
    pub reason: &'static str,
}

/// Reason published when a history adapter has not declared association.
pub const HISTORY_ASSOCIATION_UNAVAILABLE_REASON: &str = "不提供主子代理关联";

/// Association facet for the catalog. History adapters that do not declare one
/// get `unavailable`. A CLI that does not provide usage records gets `None`,
/// so the field does not create an association entry. The tool id is not read.
pub fn history_association_facet(adapter: &dyn CliAdapter) -> Option<Facet> {
    if !adapter.history_supported() {
        return None;
    }
    Some(adapter.history_association().unwrap_or(Facet {
        state: "unavailable",
        reason: HISTORY_ASSOCIATION_UNAVAILABLE_REASON,
    }))
}

/// Catalog entry. Resume-latest and parent/child association are published
/// here so existing descriptor literals stay valid. Neither is inferred from
/// the tool id.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedDescriptor {
    #[serde(flatten)]
    pub descriptor: AdapterDescriptor,
    pub resume_latest_available: bool,
    /// Omitted when this CLI does not provide usage records.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub association: Option<Facet>,
}

impl PublishedDescriptor {
    pub fn from_adapter(adapter: &dyn CliAdapter) -> Self {
        Self {
            resume_latest_available: adapter.resume_latest_args(LaunchMode::Normal).is_ok(),
            association: history_association_facet(adapter),
            descriptor: adapter.descriptor(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterCatalog {
    pub registered: Vec<PublishedDescriptor>,
    pub managed_ids: Vec<String>,
    pub preserved_unknown: Vec<UnknownAdapterRecord>,
}

#[cfg(test)]
mod remote_install_command_tests {
    use super::portable_remote_install_command;

    #[test]
    fn translates_windows_official_installer_for_posix_hosts() {
        assert_eq!(
            portable_remote_install_command("irm https://x.ai/cli/install.ps1 | iex"),
            "curl -fsSL https://x.ai/cli/install.sh | bash"
        );
    }

    #[test]
    fn leaves_adapter_owned_posix_commands_unchanged() {
        assert_eq!(
            portable_remote_install_command("curl -fsSL https://x.ai/cli/install.sh | bash"),
            "curl -fsSL https://x.ai/cli/install.sh | bash"
        );
    }
}

#[cfg(test)]
mod association_facet_tests {
    use std::collections::BTreeMap;
    use std::path::Path;

    use serde_json::Value;

    use super::*;
    use crate::credentials::CredentialStore;
    use crate::native::adapter::{NativeFile, Scope};
    use crate::native::apply::NativeSecrets;
    use crate::native::format::FileKind;
    use crate::native::profile::{Connection, RegisteredProfile};

    /// Fixture ids are not registered CLI ids. The facet must follow the
    /// declaration and history support, not the id text.
    #[derive(Clone, Copy)]
    enum AssociationCase {
        Undeclared,
        Declared,
        NoHistory,
        NoProbe,
    }

    struct AssociationCli(AssociationCase);

    impl CliAdapter for AssociationCli {
        fn id(&self) -> &'static str {
            match self.0 {
                AssociationCase::Undeclared => "association_undeclared",
                AssociationCase::Declared => "association_declared",
                AssociationCase::NoHistory => "association_no_history",
                AssociationCase::NoProbe => "",
            }
        }
        fn name(&self) -> &'static str {
            "association fixture"
        }
        fn command(&self) -> &'static str {
            match self.0 {
                AssociationCase::NoProbe => "",
                _ => "association-fixture",
            }
        }
        fn npm_package(&self) -> &'static str {
            ""
        }
        fn version_identity(&self, _basename: &str, _output: &str) -> bool {
            false
        }
        fn native_files(
            &self,
            _scope: Scope,
            _home: &Path,
            _project: Option<&Path>,
            _known: bool,
        ) -> Vec<NativeFile> {
            Vec::new()
        }
        fn interface_formats(&self) -> &'static [&'static str] {
            &[]
        }
        fn file_kind(&self, _role: &str) -> Result<FileKind, String> {
            Err("fixture has no native config".into())
        }
        fn connection_documents(
            &self,
            _connection: &Connection,
            _scope: Scope,
        ) -> Result<BTreeMap<String, Value>, String> {
            Ok(BTreeMap::new())
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
        fn launch_args(&self, _session: Option<&str>, _mode: LaunchMode) -> Result<Vec<String>, String> {
            Ok(Vec::new())
        }
        fn install_guidance(&self) -> (&'static str, &'static str) {
            ("https://example.invalid/association", "fixture only")
        }
        fn history_supported(&self) -> bool {
            !matches!(self.0, AssociationCase::NoHistory)
        }
        fn remote_history_declared(&self) -> bool {
            matches!(self.0, AssociationCase::Declared)
        }
        fn history_association(&self) -> Option<Facet> {
            match self.0 {
                AssociationCase::Undeclared => None,
                AssociationCase::Declared | AssociationCase::NoHistory | AssociationCase::NoProbe => Some(Facet {
                    state: "available",
                    reason: "已核对直接子会话",
                }),
            }
        }
    }

    #[test]
    fn undeclared_history_adapter_is_unavailable_without_using_its_id() {
        let published = PublishedDescriptor::from_adapter(&AssociationCli(AssociationCase::Undeclared));
        let facet = published.association.as_ref().expect("history adapter publishes association");
        assert_eq!(facet.state, "unavailable");
        assert_eq!(facet.reason, HISTORY_ASSOCIATION_UNAVAILABLE_REASON);
        let value = serde_json::to_value(&published).unwrap();
        assert_eq!(value["association"]["state"], "unavailable");
        assert_eq!(value["association"]["reason"], HISTORY_ASSOCIATION_UNAVAILABLE_REASON);
    }

    #[test]
    fn declared_association_stays_available_with_the_adapter_reason() {
        let published = PublishedDescriptor::from_adapter(&AssociationCli(AssociationCase::Declared));
        let facet = published.association.as_ref().expect("declared association");
        assert_eq!(facet.state, "available");
        assert_eq!(facet.reason, "已核对直接子会话");
        assert_eq!(published.descriptor.history.state, "available");
    }

    #[test]
    fn cli_without_usage_records_omits_association_even_when_declared() {
        let published = PublishedDescriptor::from_adapter(&AssociationCli(AssociationCase::NoHistory));
        assert!(published.association.is_none());
        assert_eq!(published.descriptor.history.state, "unknown");
        let value = serde_json::to_value(&published).unwrap();
        assert!(value.get("association").is_none());
        assert!(value.get("history").is_some());
    }

    #[test]
    fn remote_capabilities_are_declared_per_port_without_inference_from_id() {
        let published = PublishedDescriptor::from_adapter(&AssociationCli(AssociationCase::Declared));
        assert_eq!(published.descriptor.remote.configuration.state, "unsupported");
        assert_eq!(published.descriptor.remote.accounts.state, "unsupported");
        assert_eq!(
            published.descriptor.remote.accounts.reason,
            "此 CLI 未声明远程账号观察端口"
        );
        assert_eq!(published.descriptor.remote.history.state, "supported");
        assert_eq!(published.descriptor.remote.usage.state, "unsupported");
        assert_eq!(
            published.descriptor.remote.usage.reason,
            "此 CLI 未声明官方远程额度查询端口"
        );
        let value = serde_json::to_value(&published).unwrap();
        assert_eq!(value["remote"]["history"]["state"], "supported");
        assert!(value["remote"]["history"]["reason"].as_str().is_some());
    }

    #[test]
    fn unsupported_remote_port_fails_before_transport_launch() {
        let adapter = AssociationCli(AssociationCase::Declared);
        let target = RemoteTarget {
            id: "fixture".into(),
            name: "fixture".into(),
            host: "invalid.example".into(),
            port: 22,
            user: "root".into(),
            auth_method: "key".into(),
            identity_file: None,
            ssh_config: None,
            default_path: None,
            enabled: true,
            created_at: 0,
            updated_at: 0,
        };
        let error = adapter.remote_accounts(&target, &["status"]).unwrap_err();
        assert!(error.contains("远程账号不可用"));
        assert!(error.contains("未声明远程账号观察端口"));
    }

    #[test]
    fn remote_probe_command_is_owned_by_the_adapter() {
        let adapter = AssociationCli(AssociationCase::Declared);
        assert_eq!(remote_command(adapter.command(), &["--version"]), "'association-fixture' '--version'");
        assert_eq!(adapter.remote_capabilities().probe.state, "supported");
    }

    #[test]
    fn unsupported_remote_probe_fails_before_transport_launch() {
        let adapter = AssociationCli(AssociationCase::NoProbe);
        let target = RemoteTarget {
            id: "fixture".into(),
            name: "fixture".into(),
            host: "invalid.example".into(),
            port: 22,
            user: "root".into(),
            auth_method: "key".into(),
            identity_file: None,
            ssh_config: None,
            default_path: None,
            enabled: true,
            created_at: 0,
            updated_at: 0,
        };
        let error = adapter.remote_probe(&target).unwrap_err();
        assert!(error.contains("远程探测不可用"));
        assert!(error.contains("未声明可探测的远程 executable"));
    }

    #[test]
    fn undeclared_remote_lifecycle_command_fails_before_transport_launch() {
        let adapter = AssociationCli(AssociationCase::Declared);
        let target = RemoteTarget {
            id: "fixture".into(),
            name: "fixture".into(),
            host: "invalid.example".into(),
            port: 22,
            user: "root".into(),
            auth_method: "key".into(),
            identity_file: None,
            ssh_config: None,
            default_path: None,
            enabled: true,
            created_at: 0,
            updated_at: 0,
        };
        let install_error = adapter.remote_install(&target).unwrap_err();
        assert!(install_error.contains("未声明远程安装命令"));
        let uninstall_error = adapter.remote_uninstall(&target).unwrap_err();
        assert!(uninstall_error.contains("未声明远程卸载命令"));
    }

    #[test]
    fn registry_remote_account_consumer_preserves_unavailable_reason() {
        let target = RemoteTarget {
            id: "fixture".into(),
            name: "fixture".into(),
            host: "invalid.example".into(),
            port: 22,
            user: "root".into(),
            auth_method: "key".into(),
            identity_file: None,
            ssh_config: None,
            default_path: None,
            enabled: true,
            created_at: 0,
            updated_at: 0,
        };
        let error = crate::accounts::remote_observe(
            &crate::adapters::Registry::builtins(),
            "claude_code",
            &target,
            &[],
        )
        .unwrap_err();
        assert!(error.contains("远程账号不可用"));
        assert!(error.contains("未声明远程账号观察端口"));
    }

    #[test]
    fn all_registry_remote_consumers_fail_closed_with_capability_reasons() {
        let target = RemoteTarget {
            id: "fixture".into(),
            name: "fixture".into(),
            host: "invalid.example".into(),
            port: 22,
            user: "root".into(),
            auth_method: "key".into(),
            identity_file: None,
            ssh_config: None,
            default_path: None,
            enabled: true,
            created_at: 0,
            updated_at: 0,
        };
        let registry = crate::adapters::Registry::builtins();
        let args = Vec::new();
        let results = [
            crate::adapters::configuration::remote_configuration(&registry, "claude_code", &target, &args),
            crate::accounts::remote_observe(&registry, "claude_code", &target, &args),
            crate::resources::remote_resources(&registry, "claude_code", &target, &args),
            crate::history::remote_history(&registry, "claude_code", &target, &args),
            crate::usage::remote_usage(&registry, "claude_code", &target, &args),
        ];
        let expected = ["配置", "账号", "资源", "历史", "额度"];
        for (result, capability) in results.into_iter().zip(expected) {
            let error = result.expect_err("undeclared remote port must fail before SSH");
            assert!(error.contains(&format!("远程{capability}不可用")), "{error}");
            assert!(error.contains("未声明"), "{error}");
        }
    }
}
