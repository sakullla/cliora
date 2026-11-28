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

/// Why secret MCP is unavailable to an adapter that has no verified native MCP
/// configuration mapping. The shared UI shows this instead of an empty panel.
pub const SECRET_MCP_UNSUPPORTED_REASON: &str = "此 CLI 没有已确认的原生 MCP 配置映射，秘密使用只提供 CLI 回退";
/// A mapping proves the configuration half only. Real model `initialize`/
/// `tools/list`/tool-call acceptance is recorded per adapter, so the published
/// state stays unverified until that evidence exists.
pub const SECRET_MCP_UNVERIFIED_REASON: &str = "已确认 MCP 配置映射；真实模型工具发现与调用尚未验收";

/// Secret MCP support as the registry declares it. `supported` is only published
/// after both the native mapping and the real protocol acceptance are recorded;
/// a written native entry is placement, not evidence, and is reported separately.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretMcpCapability {
    /// `supported`, `unverified` or `unsupported`.
    pub state: &'static str,
    pub reason: &'static str,
}

impl SecretMcpCapability {
    pub fn supported() -> Self {
        Self { state: "supported", reason: "原生 MCP 映射与真实模型工具调用均已验收" }
    }
    pub fn unverified(reason: &'static str) -> Self {
        Self { state: "unverified", reason }
    }
    pub fn unsupported(reason: &'static str) -> Self {
        Self { state: "unsupported", reason }
    }
    pub fn is_supported(self) -> bool {
        self.state == "supported"
    }
}

/// Why a registered CLI cannot offer an ACP conversation yet. The shared
/// settings and session UI show this instead of hiding the choice.
pub const ACP_UNSUPPORTED_REASON: &str = "此 CLI 没有已核对的 ACP 入口，可用终端启动";
/// A version-shaped entry whose installed CLI falls outside the declared line.
pub const ACP_VERSION_OUT_OF_RANGE: &str = "已安装版本不在该 ACP 入口的兼容范围内";

/// Where an ACP entry point comes from. A local executable of the product, a
/// separately distributed vendor component and a third-party bridge are
/// different claims and stay distinguishable in the UI and the acceptance log.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AcpOrigin {
    /// The product's own CLI binary, e.g. `opencode acp`.
    Native,
    /// A separate program the vendor distributes for ACP, e.g. Antigravity's
    /// `agy_acp_server`. Installing the CLI does not install it.
    Vendor,
    /// A third-party bridge that translates ACP into a private protocol.
    Bridge,
}

impl AcpOrigin {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Native => "native",
            Self::Vendor => "vendor",
            Self::Bridge => "bridge",
        }
    }
    /// A bridge or vendor component can be missing while the CLI itself works,
    /// so the failure names the extra program instead of blaming the agent.
    pub fn needs_own_install(self) -> bool {
        !matches!(self, Self::Native)
    }
}

/// A program the entry point needs but does not ship. `program` is checked
/// before launch when the dependency is a local executable; a package that
/// cannot be probed locally keeps only its install hint.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpDependency {
    pub name: &'static str,
    /// Local executable required by the entry, resolved with the same search
    /// the entry itself uses.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub program: Option<&'static str>,
    pub installer: Option<AcpInstaller>,
    /// A retired npm package that ships the same executable name.
    #[serde(skip)]
    pub obsolete_package: Option<&'static str>,
    pub install_hint: &'static str,
    pub help_url: &'static str,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AcpInstaller { Npm, Pipx }

impl AcpDependency {
    pub fn install_command(&self, remote: bool) -> Option<String> {
        match self.installer? {
            AcpInstaller::Npm => {
                // The local maintenance runner starts in the user's home directory.
                let prefix = if remote { "\"$HOME/.cliora/acp\"" } else { ".cliora/acp" };
                Some(format!("npm install -g --prefix {prefix} {} --no-audit --no-fund", self.name))
            }
            AcpInstaller::Pipx => Some(format!("pipx install {}", self.name)),
        }
    }
}

/// Environment contract for one ACP entry. The shared host applies this before
/// it writes the first protocol frame, so the agent sees the account, provider
/// and permission surface the terminal launch would have produced.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpEnvironmentPolicy {
    /// Literal variables this entry always needs.
    pub set: &'static [(&'static str, &'static str)],
    /// Variables bound to the CLI installation the user selected. A bridge that
    /// can run either its bundled engine or the user's install must be pointed
    /// at the selected install, otherwise ACP would silently use another
    /// identity than the terminal launch.
    pub bind_installation: &'static [&'static str],
    /// Variables that must not reach this agent, including explicit overrides.
    pub remove: &'static [&'static str],
}

impl AcpEnvironmentPolicy {
    pub const NONE: Self = Self { set: &[], bind_installation: &[], remove: &[] };
}

/// What this entry point can do, as far as the recorded evidence shows. A flag
/// is `true` only when the entry point itself declares or demonstrates it;
/// `AcpCapability::evidence` says how that was established.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpCapabilities {
    /// Create a session in the selected working directory and run turns.
    pub session: bool,
    /// Ask the client before a tool or file action (`session/request_permission`).
    pub authorization: bool,
    /// Stop the current turn (`session/cancel`).
    pub cancel: bool,
    /// Load a previous native session (`session/load`) instead of starting over.
    pub resume: bool,
}

impl AcpCapabilities {
    pub const NONE: Self = Self { session: false, authorization: false, cancel: false, resume: false };
}

/// How an ACP entry expresses YOLO (approve everything without asking).
///
/// - `Client`: Cliora approves on the agent's behalf. Every authorization the
///   agent asks through the protocol is answered with its allow option, and the
///   host's own out-of-directory approvals are granted automatically. Nothing
///   upstream has to be verified, because only protocol requests are involved.
/// - `Args`: extra launch arguments that put the agent itself into YOLO.
/// - `Mode`: a session mode the host switches to once the session exists.
///
/// Cliora also approves on the client side for `Args` and `Mode`, so a request
/// the native switch still lets through is not left waiting.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AcpYolo {
    Client,
    Args { args: &'static [&'static str] },
    Mode { mode_id: &'static str },
}

/// The reason shown when an ACP entry declares no YOLO form.
pub const ACP_YOLO_UNDECLARED: &str = "此 CLI 的 ACP 入口没有声明 YOLO 方式，请改用普通模式或终端启动";

/// The adapter-owned declaration of one ACP entry point. Everything the shared
/// host needs is here, so no shared service branches on a CLI id.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpEntry {
    /// Program to run. This may differ from `CliAdapter::command()`: the Cursor
    /// adapter's command is the desktop editor while its ACP entry is
    /// `cursor-agent acp`, and Command Code's Windows shim is `cmdc`.
    pub executable: &'static str,
    pub args: &'static [&'static str],
    pub origin: AcpOrigin,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dependency: Option<AcpDependency>,
    pub environment: AcpEnvironmentPolicy,
    /// Compatible CLI line as `[since, before)`; `None` is not version-shaped.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_range: Option<(&'static str, &'static str)>,
    /// Why the range starts there, e.g. the archived predecessor that shares
    /// the executable name. Shown when the installed version is too old.
    pub version_range_reason: &'static str,
    pub capabilities: AcpCapabilities,
    /// Windows only: the executable name also names a system program
    /// (`cmd`), so a candidate outside the adapter's own installs is refused.
    pub rejects_system_program: bool,
    /// How this entry runs a YOLO launch; none means YOLO is unavailable over
    /// ACP and a YOLO request is refused with `ACP_YOLO_UNDECLARED`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub yolo: Option<AcpYolo>,
}

/// Whether `path` is a Windows system program. `cmd acp` must never be
/// answered by `C:\Windows\System32\cmd.exe`, which is on PATH.
fn acp_is_system_program(path: &Path) -> bool {
    let text = path.to_string_lossy().to_ascii_lowercase().replace('/', "\\");
    let roots = std::env::var_os("SystemRoot")
        .map(|root| root.to_string_lossy().to_ascii_lowercase().replace('/', "\\"))
        .unwrap_or_else(|| "c:\\windows".to_string());
    ["\\system32\\", "\\syswow64\\"]
        .iter()
        .any(|suffix| text.starts_with(&format!("{roots}{suffix}")))
}

/// Platform filename suffixes of a program an ACP host can start directly,
/// most specific first. It shares the terminal launch's Windows policy, minus
/// the PowerShell script: a `.ps1` entry cannot be a child process image, so
/// publishing it would report a launch that can never start.
fn acp_program_suffixes() -> &'static [&'static str] {
    #[cfg(windows)]
    return crate::process_environment::windows_spawn_suffixes();
    #[cfg(not(windows))]
    return &[""];
}

/// Where an ACP program's suffix comes from, for the Windows diagnostics: a
/// `.cmd`/`.bat` entry needs the command interpreter, so the shared host
/// starts it through one instead of handing the file to `CreateProcess`.
pub fn acp_needs_command_interpreter(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat"))
}

/// Resolve the program an ACP entry must start.
///
/// The version line and the identity both come from the installation the user
/// selected, so a program from a different installation must never answer the
/// entry: the archived release that shares an executable name would otherwise
/// bypass the version check, and two installations would run the wrong one.
fn resolve_acp_program(
    entry: &AcpEntry,
    directories: &[PathBuf],
    installation: Option<&Path>,
) -> Result<PathBuf, AcpIssue> {
    let selected = installation.filter(|path| path.exists());
    if let Some(installation) = selected {
        // The selected installation's own directory wins: an npm or vendor
        // install publishes the entry beside the executable the user chose.
        if let Some(parent) = installation.parent().filter(|parent| !parent.as_os_str().is_empty()) {
            if let Ok(found) = entry.locate(std::slice::from_ref(&parent.to_path_buf())) {
                return Ok(found);
            }
        }
        // The selected program may already be the entry itself.
        if entry.same_program(installation) && entry.accepts_candidate(installation) {
            return Ok(installation.to_path_buf());
        }
    }
    let found = entry.locate(directories)?;
    // A product-binary entry searched elsewhere resolved to another install.
    // Report the disagreement instead of running a version the launch never
    // validated.
    let same_install = selected
        .and_then(Path::parent)
        .is_some_and(|parent| found.parent() == Some(parent));
    if let Some(installation) = selected.filter(|_| entry.origin == AcpOrigin::Native && !same_install) {
        return Err(AcpIssue {
            code: "identity-unresolved",
            reason: format!(
                "命中程序与所选安装不一致：{} 解析到 {}，所选安装是 {}；请重装该 CLI 或重新检测安装路径",
                entry.command_line(),
                found.display(),
                installation.display()
            ),
            help: entry.dependency.map(|item| item.help_url).unwrap_or(""),
        });
    }
    Ok(found)
}

impl AcpEntry {
    /// The `program args…` shape an operator would type, for diagnostics.
    pub fn command_line(&self) -> String {
        std::iter::once(self.executable)
            .chain(self.args.iter().copied())
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// Whether this candidate may answer the entry. A same-named system
    /// program is refused for entries that declare the collision.
    pub fn accepts_candidate(&self, path: &Path) -> bool {
        if self.rejects_system_program && acp_is_system_program(path) { return false; }
        if let Some(package) = self.dependency.and_then(|d| d.obsolete_package) {
            let marker = format!("/{package}/");
            let contains = |s: &str| s.replace('\\', "/").contains(&marker);
            if path.canonicalize().is_ok_and(|p| contains(&p.to_string_lossy())) { return false; }
            if acp_needs_command_interpreter(path) && path.metadata().is_ok_and(|m| m.len() <= 16 * 1024)
                && std::fs::read_to_string(path).is_ok_and(|s| contains(&s)) { return false; }
        }
        true
    }

    /// Whether `path` names the same program as `executable`, ignoring the
    /// platform suffix an installation adds (`kimi.cmd` answers `kimi`). The
    /// selected installation may itself be the entry instead of sitting beside
    /// it; this is the only case where that is allowed.
    pub fn same_program(&self, path: &Path) -> bool {
        path.file_stem()
            .and_then(|stem| stem.to_str())
            .is_some_and(|stem| stem.eq_ignore_ascii_case(self.executable))
    }

    /// Search `directories` in order and return the first accepted program.
    pub fn locate(&self, directories: &[PathBuf]) -> Result<PathBuf, AcpIssue> {
        let mut rejected_system_program = false;
        for directory in directories {
            for suffix in acp_program_suffixes() {
                let candidate = directory.join(format!("{}{suffix}", self.executable));
                if !candidate.is_file() {
                    continue;
                }
                if !self.accepts_candidate(&candidate) {
                    rejected_system_program = true;
                    continue;
                }
                return Ok(candidate);
            }
        }
        if rejected_system_program {
            return Err(AcpIssue {
                code: "system-program",
                reason: format!(
                    "只找到同名的系统程序，不是该 CLI 的 ACP 入口（{}）；请确认产品自身的安装位置",
                    self.command_line()
                ),
                help: self.dependency.map(|item| item.help_url).unwrap_or(""),
            });
        }
        Err(AcpIssue {
            code: if self.origin.needs_own_install() { "dependency-missing" } else { "not-installed" },
            reason: match self.dependency {
                Some(dependency) => format!(
                    "未找到 {}（{}）：{}",
                    self.executable, dependency.name, dependency.install_hint
                ),
                None => format!("未找到 {}；请先安装该 CLI 或修复 PATH", self.executable),
            },
            help: self.dependency.map(|item| item.help_url).unwrap_or(""),
        })
    }
}

/// What an adapter publishes about its ACP conversation route. `state` is the
/// launch decision, `evidence` records how far the claim was actually verified,
/// and `reason` explains both to the user.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpCapability {
    /// `supported` requires a verified interactive turn; `unverified` is a
    /// declared, reachable entry point; `unsupported` has no route.
    pub state: &'static str,
    /// `interactive`, `handshake` (the agent answered `initialize`) or
    /// `documented` (upstream distribution and command checked, not started).
    pub evidence: &'static str,
    pub reason: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry: Option<AcpEntry>,
}

impl AcpCapability {
    pub fn unsupported(reason: &'static str) -> Self {
        Self { state: "unsupported", evidence: "none", reason, entry: None }
    }

    /// A declared entry point that has not yet completed a real turn.
    pub fn unverified(evidence: &'static str, reason: &'static str, entry: AcpEntry) -> Self {
        Self { state: "unverified", evidence, reason, entry: Some(entry) }
    }

    /// A declared entry point with a recorded interactive acceptance.
    pub fn supported(reason: &'static str, entry: AcpEntry) -> Self {
        Self { state: "supported", evidence: "interactive", reason, entry: Some(entry) }
    }

    /// ACP can be attempted: the entry exists and its version line was already
    /// checked by `acp_for_version`.
    pub fn is_launchable(self) -> bool {
        self.entry.is_some() && self.state != "unsupported"
    }
}

/// One resolved ACP launch: the program to spawn, its arguments and the
/// environment the shared host must apply. The account adapter's own removals
/// are merged in so ACP isolation matches the terminal launch.
#[derive(Clone, Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub environment: Vec<(String, String)>,
    pub remove_environment: Vec<String>,
    pub origin: &'static str,
    /// The entry's YOLO form, carried to the planner. Not part of the wire shape.
    #[serde(skip)]
    pub yolo: Option<AcpYolo>,
    /// A session mode the host must switch to after the session exists (a
    /// `Mode` YOLO launch); none otherwise.
    #[serde(default)]
    pub yolo_mode: Option<String>,
}

/// Why an ACP launch cannot start, in the shape the UI reports. `code` is a
/// closed set; the reason names the missing program and what to install.
#[derive(Clone, Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpIssue {
    pub code: &'static str,
    pub reason: String,
    pub help: &'static str,
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
    /// Secret MCP capability for this CLI. Published even when unsupported so the
    /// library shows a reason and the CLI fallback instead of hiding the choice.
    pub secret_mcp: SecretMcpCapability,
    /// ACP conversation route. Published even when unsupported so the launch
    /// setting shows a reason and keeps the terminal fallback.
    pub acp: AcpCapability,
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
    /// Recorded absence reason when no `memory` entry is published (e.g. the
    /// feature exists natively but local storage is not verified). Shared UI
    /// then shows an unavailable memory view carrying this text instead of
    /// hiding the tab. Empty keeps the historical hidden behavior, so
    /// adapters without a memory verdict do not change.
    #[serde(default, skip_serializing_if = "str::is_empty")]
    pub memory_reason: &'static str,
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
    /// The catalog port also covers the global scope (adapter-declared
    /// through `uses_rule_catalog(Scope::Global)`). Absent keeps the
    /// historical project-only catalog surface, so every existing adapter
    /// serializes exactly as before.
    #[serde(default, skip_serializing_if = "is_false")]
    pub catalog_global: bool,
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
            catalog_global: false,
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

/// Catalog operations one adapter's rule kind supports, declared next to
/// `rule_file_specs`. Editability stays the per-file `writable` flag; this
/// policy covers the destructive/structural operations of the shared
/// catalog service (`delete_file`, `set_file_enabled`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RuleKindPolicy {
    /// The kind's files may be removed through the catalog delete port.
    pub removable: bool,
    /// The kind's files may be switched on/off through relocation.
    pub toggleable: bool,
}

/// Historical shared create template: the Cursor `.mdc` frontmatter, and a
/// plain heading for layouts whose native files are plain markdown. It is
/// the default of [`CliAdapter::rule_create_template`].
fn default_rule_create_template(path: &Path, name: &str) -> String {
    if path.extension().and_then(|ext| ext.to_str()) == Some("mdc") {
        "---\ndescription: \"\"\nalwaysApply: false\n---\n".to_owned()
    } else {
        format!("# {name}\n")
    }
}

/// A skill directory that can be listed but not written by this CLI.
#[derive(Clone, Debug)]
pub struct SkillObservation {
    pub root: PathBuf,
    pub detail: &'static str,
}

/// One skill directory an adapter resolved from a native declaration
/// manifest (for example agy 1.5.9 `<workspace>/.agents/skills.json`).
/// The adapter owns the manifest semantics and name filters; the shared
/// scan only reads the resolved directory, listed read-only with the
/// declaration's own label. Declared directories never become write targets.
#[derive(Clone, Debug)]
pub struct SkillDeclaration {
    /// A concrete skill directory (`<declared dir>/<name>`), already filtered
    /// by the manifest's `include_only`/`exclude` name rules.
    pub root: PathBuf,
    /// Source label shown in the list, e.g. `skills.json · shared-skills`.
    pub label: String,
}

/// A read-only MCP server discovered from another tool or plugin package.
/// `source` is the display label, `path` the native file that owns it.
#[derive(Clone, Debug)]
pub struct McpObservation {
    pub name: String,
    pub entry: Value,
    pub source: &'static str,
    pub path: PathBuf,
    pub enabled: bool,
    pub detail: &'static str,
}

/// One foreign MCP source file that could not be read or parsed. Valid entries
/// from other files stay visible next to this error.
#[derive(Clone, Debug)]
pub struct McpObservationIssue {
    pub source: &'static str,
    pub path: PathBuf,
    pub message: String,
}

/// Foreign servers plus the per-source read errors of one discovery pass.
#[derive(Clone, Debug, Default)]
pub struct McpObservations {
    pub servers: Vec<McpObservation>,
    pub issues: Vec<McpObservationIssue>,
}

/// A CLI-owned file where an imported server is enabled or disabled. The
/// source file is never the target.
#[derive(Clone, Debug)]
pub struct McpExternalSwitch {
    pub path: PathBuf,
    pub kind: FileKind,
}

/// Adapter-owned remote resource mappings. Absence is an unsupported capability;
/// shared transports never substitute another CLI's native directory.
#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteResourceLayout {
    pub mcp: Option<RemoteMcpLayout>,
    pub skill_root: Option<&'static str>,
    pub agent_root: Option<&'static str>,
    pub agent_extension: Option<&'static str>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMcpLayout {
    pub relative: &'static str,
    pub format: &'static str,
    pub table: &'static str,
    pub nested: bool,
}

/// Login-home relative skill directory scanned on a remote host.
/// Read-only roots are bundled or observed directories, same as the local scan.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
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

/// Environment a CLI needs around a remote interactive launch. Shared launch
/// owns the shell; the adapter only names variables. `when_root` is exported
/// only when the remote uid is 0.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct RemoteLaunchEnvironment {
    pub environment: &'static [(&'static str, &'static str)],
    pub when_root: &'static [(&'static str, &'static str)],
}

/// One native document the shared remote store can read and write.
/// `relative` is under the login home for `global` and under the project
/// directory for `project`. The shared service does not infer the path from
/// the CLI id.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteNativeDocument {
    pub role: &'static str,
    pub relative: &'static str,
    pub format: &'static str,
    pub scope: &'static str,
}

/// Which copy of a remote history tree is kept when the archive is bounded.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteHistoryOrder {
    /// Newest path first. Use this when the file name already contains the date.
    PathDesc,
    /// Newest modification time first. GNU find supplies the time.
    MtimeDesc,
}

/// Files under the remote login home that this CLI's history parser can read.
/// The shared archiver copies this declaration and does not match on a CLI id.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct RemoteHistoryLayout {
    /// Directory under the login home, for example `.claude/projects`.
    pub relative: &'static str,
    /// Older roots with the same layout; exported paths are mirrored to `relative`.
    pub fallbacks: &'static [&'static str],
    /// Basename globs copied in full, such as an index or a state database.
    pub pinned: &'static [&'static str],
    /// Basename globs of session transcripts. The archive keeps a bounded set.
    pub sessions: &'static [&'static str],
    /// Directory next to a selected transcript: `<dir>/<stem>/<companion>/`.
    /// Files there that match `sessions` are copied with that transcript.
    pub companion: Option<&'static str>,
    pub order: RemoteHistoryOrder,
    /// Optional bounded SQLite projection. SQL and relationships belong to the adapter.
    pub sqlite: Option<RemoteHistorySqlite>,
    /// Bounded projections for optional pinned SQLite catalogs in a file layout.
    pub catalogs: &'static [RemoteHistoryTable],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct RemoteHistorySqlite {
    pub index: &'static str,
    pub tables: &'static [RemoteHistoryTable],
    /// Relative file templates for the selected native ids; only `{id}` is substituted.
    pub files: &'static [&'static str],
    /// Only these tables are copied from per-session databases named in `files`.
    pub file_tables: &'static [&'static str],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct RemoteHistoryTable {
    pub name: &'static str,
    /// Index selection query with `:limit`; for linked tables, an optional row predicate.
    pub query: &'static str,
    pub required_columns: &'static [&'static str],
    /// Index id column (collected for linked tables/files).
    pub id: Option<&'static str>,
    /// Copy rows whose value is one of the selected index ids.
    pub link: Option<&'static str>,
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

/// One session-only launch parameter an adapter can receive. Choices are
/// native values from verified CLI evidence; `default` is the native default
/// when the flag is omitted (`None` keeps the CLI's own default).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchSessionOption {
    pub id: &'static str,
    pub label: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label_en: Option<&'static str>,
    pub choices: &'static [&'static str],
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<&'static str>,
}

/// Major/minor installation line (`v1.5.9` -> `(1, 5)`). Unparseable values
/// stay unverified instead of matching a guessed line.
fn version_line(value: &str) -> Option<(u32, u32)> {
    let value = value.trim().trim_start_matches('v');
    let mut parts = value.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().and_then(|part| part.parse().ok()).unwrap_or(0);
    Some((major, minor))
}

/// Whether an installation version falls inside an adapter-declared
/// `[since, before)` line. `None` means the capability is not version-shaped;
/// an unverified version never satisfies a declared range.
fn version_in_range(version: Option<&str>, range: Option<(&'static str, &'static str)>) -> bool {
    let Some((since, before)) = range else { return true };
    let (Some(version), Some(since), Some(before)) = (
        version.and_then(version_line),
        version_line(since),
        version_line(before),
    ) else {
        return false;
    };
    version >= since && version < before
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
pub(crate) fn npm_install_command_for(package: &str, script_dependencies: &[&str]) -> Option<String> {
    let scripts = std::iter::once(package).chain(script_dependencies.iter().copied()).collect::<Vec<_>>().join(",");
    (!package.is_empty()).then(|| format!("npm install -g {package}@latest --include=optional --ignore-scripts=false --foreground-scripts --allow-scripts={scripts} --no-audit --no-fund --fetch-retries=3 --fetch-timeout=60000 --fetch-retry-mintimeout=1000 --fetch-retry-maxtimeout=10000"))
}

pub(crate) fn npm_uninstall_command_for(package: &str) -> Option<String> {
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
        let command = crate::remote::with_remote_user_path(&remote_command(self.command(), args));
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
        crate::remote::run_command(target, &crate::remote::with_remote_user_path(command)).map_err(|error| error.to_string())
    }

    fn remote_install(&self, target: &RemoteTarget) -> Result<RemoteCommandResult, String> {
        let command = self
            .install_command()
            .map(|command| portable_remote_install_command(&command))
            .ok_or_else(|| "此 CLI 未声明远程安装命令".to_owned())?;
        self.dispatch_remote_owned_command(target, &format!("{}; {command}", crate::remote::LINUX_TMUX_INSTALL))
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
    /// The native mapping label this adapter owns, in the verification document's
    /// form (relative home path plus the top-level table). A record only publishes
    /// support when it names this exact label, so a changed mapping cannot inherit
    /// an older observation. An adapter without a mapping leaves this `None`.
    fn secret_mcp_mapping(&self) -> Option<&'static str> { None }
    /// Secret MCP capability. The gate in `secret_access` publishes `unverified`
    /// for an adapter that owns a native MCP mapping and `unsupported` without one;
    /// `supported` additionally needs a complete live acceptance record for this
    /// target and mapping. A configuration write, a protocol probe or a CLI name
    /// cannot substitute for that record, and the declaration comes from the
    /// adapter rather than from its id.
    fn secret_mcp_capability(&self) -> SecretMcpCapability {
        super::secret_access::published(
            super::secret_access::ACCEPTANCES,
            self.supports_mcp(),
            self.secret_mcp_mapping(),
            self.id(),
        )
    }
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
    /// Paths in the native document about to be written whose value the CLI rejects as a
    /// whole, such as an object left without a required member after an owned field was
    /// removed. The shared apply service removes them with the same write; adapters only
    /// declare the schema rule.
    fn invalid_native_paths(&self, _role: &str, _document: &Value) -> Vec<Vec<String>> {
        Vec::new()
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
    /// Advisory drift for a key slot the last application wrote through the
    /// credential channel. `value` is what the native file holds there now and
    /// `connection` is the applied connection. True means the current apply
    /// would never leave that value (for example a reference written by an
    /// older credential channel), so the binding reads as changed and the
    /// existing re-apply action rewrites it. Must judge shape only: never log,
    /// return, or compare the value against stored credentials.
    fn outdated_applied_secret(
        &self,
        _connection: &Connection,
        _role: &str,
        _path: &[String],
        _value: &Value,
    ) -> bool {
        false
    }
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
    /// Some bridges use an ACP permission request to ask a question. Its
    /// answer always belongs to the user, including in YOLO mode.
    fn acp_user_question(&self, _tool: &Value) -> bool { false }

    fn acp_terminal_login_args(&self) -> Option<Vec<String>> { self.login_args() }

    fn login_hint(&self) -> &'static str {
        ""
    }
    /// The ACP conversation route this CLI declares. The adapter owns the
    /// program, arguments, environment and version line; shared settings and
    /// sessions read this through the registry and never branch on a CLI id.
    fn acp(&self) -> AcpCapability {
        AcpCapability::unsupported(ACP_UNSUPPORTED_REASON)
    }
    /// The same declaration after checking the installed version against the
    /// adapter's own line. An unverified version never satisfies a range, so a
    /// version-shaped entry stays unavailable until the version is known.
    fn acp_for_version(&self, version: Option<&str>) -> AcpCapability {
        let capability = self.acp();
        match capability.entry {
            Some(entry) if !version_in_range(version, entry.version_range) => AcpCapability {
                state: "unsupported",
                reason: entry.version_range_reason,
                ..capability
            },
            _ => capability,
        }
    }
    /// Directories searched for an ACP program: the adapter's own install
    /// locations first, so the selected installation wins over PATH, then the
    /// process PATH that a terminal launch would also use.
    fn acp_search_directories(&self, home: &Path) -> Vec<PathBuf> {
        let mut directories = self.native_binary_directories(home);
        if matches!(self.acp().entry.and_then(|e| e.dependency).and_then(|d| d.installer), Some(AcpInstaller::Npm)) {
            let prefix = home.join(".cliora").join("acp");
            directories.insert(0, if cfg!(windows) { prefix } else { prefix.join("bin") });
        }
        for directory in self
            .native_installations(home)
            .into_iter()
            .filter_map(|item| PathBuf::from(item.path).parent().map(Path::to_path_buf))
        {
            if !directories.contains(&directory) {
                directories.push(directory);
            }
        }
        for candidate in self.extra_binary_candidates(home) {
            if let Some(directory) = candidate.parent() {
                if !directories.contains(&directory.to_path_buf()) {
                    directories.push(directory.to_path_buf());
                }
            }
        }
        for directory in crate::process_environment::directories() {
            if !directories.contains(&directory) {
                directories.push(directory);
            }
        }
        directories
    }
    /// Resolve the ACP launch for this CLI. `installation` is the CLI executable
    /// the user selected for terminal launches; a bridge that can run either a
    /// bundled engine or the user's install is bound to it, so ACP never runs a
    /// different identity. Returns the concrete reason when it cannot start.
    fn acp_command(
        &self,
        home: &Path,
        installation: Option<&Path>,
        version: Option<&str>,
    ) -> Result<AcpCommand, AcpIssue> {
        let capability = self.acp_for_version(version);
        let Some(entry) = capability.entry else {
            return Err(AcpIssue { code: "unsupported", reason: capability.reason.into(), help: "" });
        };
        if capability.state == "unsupported" {
            let reason = match (entry.version_range, version) {
                (Some((since, before)), Some(version)) => format!(
                    "{}：{}；当前 {}，该 ACP 入口适用 {} 起、{} 之前（{}）",
                    ACP_VERSION_OUT_OF_RANGE, capability.reason, version, since, before,
                    entry.version_range_reason
                ),
                _ => format!("{}：{}", ACP_VERSION_OUT_OF_RANGE, capability.reason),
            };
            return Err(AcpIssue { code: "version-unsupported", reason, help: "" });
        }
        let directories = self.acp_search_directories(home);
        if let Some(dependency) = entry.dependency {
            if let Some(program) = dependency.program {
                let found = AcpEntry {
                    executable: program,
                    args: &[],
                    origin: entry.origin,
                    dependency: None,
                    environment: AcpEnvironmentPolicy::NONE,
                    version_range: None,
                    version_range_reason: "",
                    capabilities: AcpCapabilities::NONE,
                    rejects_system_program: false,
                    yolo: None,
                };
                found.locate(&directories).map_err(|mut issue| {
                    issue.code = "dependency-missing";
                    issue.reason = format!("{}：{}", dependency.name, dependency.install_hint);
                    issue.help = dependency.help_url;
                    issue
                })?;
            }
        }
        // The program must come from the installation the version was read
        // from; a different install would run a version this launch never
        // validated.
        let program = resolve_acp_program(&entry, &directories, installation)?;
        let mut environment = entry
            .environment
            .set
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect::<Vec<_>>();
        if !entry.environment.bind_installation.is_empty() {
            let installation = installation.ok_or_else(|| AcpIssue {
                code: "identity-unresolved",
                reason: format!(
                    "{} 需要已选定的 CLI 安装路径才能运行用户选中的安装，当前未解析到安装",
                    entry.command_line()
                ),
                help: entry.dependency.map(|item| item.help_url).unwrap_or(""),
            })?;
            let value = installation.to_string_lossy().to_string();
            environment.extend(
                entry
                    .environment
                    .bind_installation
                    .iter()
                    .map(|key| ((*key).to_string(), value.clone())),
            );
        }
        // Account isolation belongs to the selected NativeContext. A native
        // login without a managed binding inherits the same environment as a PTY.
        let remove_environment = entry.environment.remove.iter().map(|key| (*key).to_owned()).collect();
        Ok(AcpCommand {
            program,
            args: entry.args.iter().map(|arg| (*arg).to_string()).collect(),
            environment,
            remove_environment,
            origin: entry.origin.as_str(),
            yolo: entry.yolo,
            yolo_mode: None,
        })
    }
    fn launch_args(&self, session: Option<&str>, mode: LaunchMode) -> Result<Vec<String>, String>;
    /// Extra environment for a remote interactive session. Local launches
    /// ignore it. The default adds nothing.
    fn remote_launch_environment(&self, mode: LaunchMode) -> RemoteLaunchEnvironment {
        let _ = mode;
        RemoteLaunchEnvironment::default()
    }
    /// Login-home or project-relative native documents a remote host can edit
    /// in place. Empty means this CLI has not declared a remote native file.
    fn parse_remote_mcp(&self, text: &str) -> Result<Value, String> {
        let layout = self.remote_resource_layout().mcp.ok_or("适配器未声明远程 MCP 能力")?;
        super::remote_resources::parse(layout, text)
    }
    fn render_remote_mcp(&self, text: &str, value: &Value) -> Result<Vec<u8>, String> {
        let layout = self.remote_resource_layout().mcp.ok_or("适配器未声明远程 MCP 能力")?;
        super::remote_resources::render(layout, text, value)
    }
    fn remote_resource_layout(&self) -> RemoteResourceLayout { RemoteResourceLayout::default() }
    fn remote_native_documents(&self) -> &'static [RemoteNativeDocument] {
        &[]
    }
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
    /// Arguments that start a new conversation under a caller-chosen native
    /// id, so the launcher knows the exact conversation to resume later.
    /// `None` means this CLI/version has no verified flag; callers then fall
    /// back to history matching.
    fn assigned_session_args(&self, version: &str, id: &str) -> Option<Vec<String>> {
        let _ = (version, id);
        None
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
    /// Recovery identity only: the fields a restore match needs. An adapter may
    /// read just these and skip messages, usage and child logs; the default
    /// keeps full-parse correctness by trimming a normal parse.
    fn restore_identity(
        &self,
        source: &HistorySource,
    ) -> Result<crate::history::SessionIdentity, String> {
        Ok(crate::history::SessionIdentity::from_parsed(
            self.parse_history(source)?,
        ))
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
    /// Remote transcript layout. Absent means the records page has no verified
    /// copy of this CLI's native history.
    fn remote_history_layout(&self) -> Option<RemoteHistoryLayout> {
        None
    }
    /// Directory under the remote login home that holds this CLI's native history.
    fn native_history_relative(&self) -> Option<&'static str> {
        self.remote_history_layout().map(|layout| layout.relative)
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
    /// Installation range that publishes the project model override. `None`
    /// keeps the historical fixed-shape behavior for every verified install;
    /// a declared range hides the field and refuses the flag outside it.
    fn project_model_override_range(&self) -> Option<(&'static str, &'static str)> {
        None
    }
    /// Version-aware project model arguments. The default keeps
    /// `project_model_args` for fixed-shape adapters; a version-shaped
    /// override is composed by the shared launch service with the resolved
    /// installation version.
    fn project_model_args_for_version(
        &self,
        version: Option<&str>,
        model: Option<&str>,
    ) -> Result<Vec<String>, String> {
        if !version_in_range(version, self.project_model_override_range()) {
            if model.is_some() {
                return Err("此 CLI 安装版本未核验项目启动模型参数；请清除项目模型或升级 CLI".into());
            }
            return Ok(Vec::new());
        }
        self.project_model_args(model)
    }
    /// Static declaration of the session-only launch parameters this adapter
    /// can receive. The catalog publishes the specs plus the version range so
    /// the UI hides selectors for an unverified install; `launch_session_options`
    /// applies that range to the resolved installation.
    fn launch_session_option_specs(&self) -> Vec<LaunchSessionOption> {
        Vec::new()
    }
    fn launch_session_options_range(&self) -> Option<(&'static str, &'static str)> {
        None
    }
    /// Session parameters published for one resolved installation. The shared
    /// launch service validates the request against this list, so an older or
    /// unverified install accepts none.
    fn launch_session_options(&self, version: Option<&str>) -> Vec<LaunchSessionOption> {
        if version_in_range(version, self.launch_session_options_range()) {
            self.launch_session_option_specs()
        } else {
            Vec::new()
        }
    }
    /// Map the already-validated session parameters to native arguments. The
    /// default adds nothing; an adapter that publishes options above maps them
    /// here instead of relying on a shared guess.
    fn launch_session_args(
        &self,
        _version: Option<&str>,
        _options: &BTreeMap<String, String>,
    ) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    /// Optional agent selection for a new session, composed by the shared
    /// launch service after `launch_args`. `None` keeps the historical
    /// argument list; a selection is refused unless the adapter verified a
    /// native flag for it. The default has no verified selection.
    fn launch_agent_args(&self, agent: Option<&str>) -> Result<Vec<String>, String> {
        if agent.is_some() {
            return Err("此 CLI 不支持启动时选择 Agent".into());
        }
        Ok(Vec::new())
    }
    /// Version-aware agent selection arguments. The default ignores the
    /// version and keeps `launch_agent_args`, so fixed-shape adapters never
    /// change. Adapters whose selection flag follows the install line refuse
    /// unverified versions here instead of guessing.
    fn launch_agent_args_for_version(
        &self,
        version: &str,
        agent: Option<&str>,
    ) -> Result<Vec<String>, String> {
        let _ = version;
        self.launch_agent_args(agent)
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
    /// Whether the native MCP contract (location or entry shape) follows the
    /// identified native version. The shared MCP service then resolves the
    /// probed install version once per target and hands it to the
    /// `*_for_version` hooks, so a read and a later write agree on the same
    /// evidence.
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
    /// Read-only servers this CLI also discovers from other tools or packages.
    /// The shared MCP view appends them with their source and never writes the
    /// source file. Adapters that do not translate foreign configs return empty.
    /// An unreadable or malformed foreign file is reported in `issues`; it does
    /// not turn the whole discovery into an empty list.
    fn mcp_observations(
        &self,
        _scope: Scope,
        _home: &Path,
        _project: Option<&Path>,
    ) -> Result<McpObservations, String> {
        Ok(McpObservations::default())
    }
    /// CLI-owned override file for an imported server. `None` means this CLI
    /// has no verified external enable/disable path.
    fn mcp_external_switch(
        &self,
        _scope: Scope,
        _home: &Path,
        _project: Option<&Path>,
    ) -> Option<McpExternalSwitch> {
        None
    }
    /// Field changes for one imported server in the parsed override document.
    /// The adapter owns the native list shape; shared services own the write.
    fn mcp_external_changes(
        &self,
        _parsed: &Value,
        _name: &str,
        _enabled: bool,
        _source_enabled: bool,
    ) -> Option<Vec<crate::native::transaction::FieldChange>> {
        None
    }
    /// Whether this CLI currently loads project-scoped MCP sources.
    fn mcp_project_scope_effective(&self, _home: &Path) -> Result<bool, String> {
        Ok(true)
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
    /// Version-aware native entry shape. The default keeps the location-shaped
    /// document; adapters whose verified entry shape follows the install line
    /// override this together with `mcp_requires_version`.
    fn mcp_document_for_version(
        &self,
        definition: &McpDefinition,
        enabled: bool,
        existing: Option<&Value>,
        location: &McpLocation,
        version: Option<&str>,
    ) -> Result<Option<Value>, String> {
        let _ = version;
        self.mcp_document_at(definition, enabled, existing, location)
    }
    fn mcp_disabled_description(&self) -> Option<&'static str> {
        None
    }
    /// Version-aware disable description for previews. The default keeps the
    /// static description.
    fn mcp_disabled_description_for_version(&self, version: Option<&str>) -> Option<&'static str> {
        let _ = version;
        self.mcp_disabled_description()
    }
    /// Whether the native format has a verified stdio working-directory mapping.
    /// Undeclared targets report unsupported instead of dropping a non-empty `cwd`.
    fn mcp_supports_cwd(&self) -> bool {
        false
    }
    /// Whether the native format has a verified legacy HTTP+SSE remote mapping.
    /// Legacy SSE is never rewritten as Streamable HTTP on a target without one.
    fn mcp_supports_sse(&self) -> bool {
        false
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
    /// Skill directories a native declaration manifest resolved for this
    /// scope (agy 1.5.9 `.agents/skills.json`). They join the scan read-only
    /// with their own source label and are never write targets. The default
    /// keeps every adapter without a declaration manifest unchanged.
    fn skill_declarations(
        &self,
        _scope: Scope,
        _home: &Path,
        _project: Option<&Path>,
    ) -> Vec<SkillDeclaration> {
        Vec::new()
    }
    /// Whether the shared scan marks skills whose name exists in several
    /// discovered sources with the `duplicate_name` issue. The CLI's own
    /// native precedence stays authoritative; the marker only states that
    /// several sources carry the name. The default keeps every adapter's
    /// listing unchanged.
    fn skill_marks_duplicate_names(&self) -> bool {
        false
    }
    /// When Some, enabling a package whose SKILL.md breaks the shared load
    /// contract (frontmatter present and parseable, name valid and matching
    /// the directory, description non-empty) is refused with this reason
    /// instead of claiming the CLI will use it. The default keeps the shared
    /// enable behavior.
    fn skill_enable_requires_contract(&self) -> Option<&'static str> {
        None
    }
    /// Remote POSIX inventory under the login home. The adapter's writable root
    /// is scanned by default; adapters add bundled/observed roots explicitly.
    /// Empty means unavailable and never substitutes another CLI's directory.
    fn remote_skill_directories(&self) -> Vec<RemoteSkillDirectory> {
        self.remote_resource_layout().skill_root.map(|relative| vec![RemoteSkillDirectory {
            relative, read_only: false, detail: "远程主机目录",
        }]).unwrap_or_default()
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
    /// Catalog operations one rule kind supports. The default pins the
    /// historical shared-service whitelist — only `mdc` rules are removable
    /// or toggleable — so every existing adapter keeps today's behavior.
    /// Adapters whose verified native contract covers other kinds (for
    /// example plain-markdown directory rules) override this together with
    /// `rule_file_specs`.
    fn rule_kind_policy(&self, kind: &str) -> RuleKindPolicy {
        let historical = kind == "mdc";
        RuleKindPolicy { removable: historical, toggleable: historical }
    }
    /// Scope-aware create target for catalog rules. The default keeps the
    /// project-only port; the shared service calls it only for scopes the
    /// adapter declared through `uses_rule_catalog`.
    fn rule_create_path_scoped(
        &self,
        _scope: Scope,
        _home: &Path,
        project: Option<&Path>,
        name: &str,
    ) -> Result<PathBuf, String> {
        self.rule_create_path(project.ok_or("请选择项目目录")?, name)
    }
    /// Scope-aware relocation target for catalog enable/disable. The default
    /// keeps the project-only port.
    fn rule_relocate_scoped(
        &self,
        _scope: Scope,
        _home: &Path,
        project: Option<&Path>,
        path: &Path,
        enabled: bool,
    ) -> Result<PathBuf, String> {
        self.rule_relocate(project.ok_or("请选择项目目录")?, path, enabled)
    }
    /// Body for a newly created catalog rule when the caller passes no text.
    /// The default keeps the historical template (Cursor `.mdc` frontmatter;
    /// a plain heading for plain-markdown layouts); adapters whose native
    /// rule files carry required frontmatter of their own override this so a
    /// created file is actually loaded by the CLI.
    fn rule_create_template(&self, path: &Path, name: &str) -> String {
        default_rule_create_template(path, name)
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
        support.catalog_global = self.uses_rule_catalog(Scope::Global);
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
    /// Adapter-owned installation source label for a probed path. Shared source
    /// detection applies it after the native/npm checks and before falling back
    /// to `unknown`, so an adapter can name a verified channel (for example a
    /// Bun global install) without shared services branching on CLI ids.
    fn installation_source(&self, _path: &Path) -> Option<&'static str> {
        None
    }
    /// Runtime dependencies required by an identified installation source.
    /// Empty keeps the historical shared Node/npm dependency panel.
    fn runtime_dependencies(
        &self,
        _source: &str,
        _installed: bool,
        _home: &Path,
    ) -> Vec<adapter::Dependency> {
        Vec::new()
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
    /// Source-aware install command. The default preserves the historical
    /// single-channel behavior; an adapter with more channels overrides this so
    /// shared maintenance never has to know CLI-specific source names.
    fn source_install_command(&self, source: Option<&str>) -> Option<String> {
        match source {
            None => self.install_command(),
            Some("npm_shim") => self.npm_install_command(),
            Some("native") => self.native_install_command(),
            Some(_) => None,
        }
    }
    /// Source-aware upgrade command. The default keeps the identified install
    /// line policy.
    fn source_upgrade_command(&self, source: &str, version: Option<&str>) -> Option<String> {
        self.upgrade_command_for_version(source, version)
    }
    /// Source-aware uninstall command. The default keeps the legacy npm-only
    /// uninstall surface.
    fn source_uninstall_command(&self, source: &str, version: Option<&str>) -> Option<String> {
        (source == "npm_shim")
            .then(|| self.npm_uninstall_command_for_version(version))
            .flatten()
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
                memory_reason: "",
            },
            secret_mcp: self.secret_mcp_capability(),
            acp: self.acp(),
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
    /// Whether a new-session launch may carry an agent selection
    /// (`LaunchRequest::agent`). Derived from `launch_agent_args`, never
    /// inferred from the tool id.
    pub agent_launch_available: bool,
    /// Session-only launch parameters this adapter publishes. The UI renders
    /// selectors only when the resolved installation satisfies the range.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub launch_session_options: Vec<LaunchSessionOption>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launch_session_options_since: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launch_session_options_before: Option<&'static str>,
    /// Installation range that publishes the project model override; `None`
    /// means the adapter's declaration is not version-shaped.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_model_override_since: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_model_override_before: Option<&'static str>,
    /// Omitted when this CLI does not provide usage records.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub association: Option<Facet>,
    /// Native files this CLI lets a remote host read and write directly.
    pub remote_resources: RemoteResourceLayout,
    pub remote_skill_directories: Vec<RemoteSkillDirectory>,
    #[serde(default, skip_serializing_if = "remote_native_files_empty")]
    pub remote_native_files: &'static [RemoteNativeDocument],
}

fn remote_native_files_empty(files: &&'static [RemoteNativeDocument]) -> bool {
    files.is_empty()
}

impl PublishedDescriptor {
    pub fn from_adapter(adapter: &dyn CliAdapter) -> Self {
        let session_range = adapter.launch_session_options_range();
        let model_range = adapter.project_model_override_range();
        Self {
            resume_latest_available: adapter.resume_latest_args(LaunchMode::Normal).is_ok(),
            agent_launch_available: adapter.launch_agent_args(Some("probe")).is_ok(),
            launch_session_options: adapter.launch_session_option_specs(),
            launch_session_options_since: session_range.map(|(since, _)| since),
            launch_session_options_before: session_range.map(|(_, before)| before),
            project_model_override_since: model_range.map(|(since, _)| since),
            project_model_override_before: model_range.map(|(_, before)| before),
            association: history_association_facet(adapter),
            descriptor: adapter.descriptor(),
            remote_resources: adapter.remote_resource_layout(),
            remote_skill_directories: adapter.remote_skill_directories(),
            remote_native_files: adapter.remote_native_documents(),
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
        fn remote_resource_layout(&self) -> RemoteResourceLayout {
            match self.0 {
                AssociationCase::Declared => RemoteResourceLayout {
                    mcp: Some(RemoteMcpLayout { relative: ".fixture/native.json", format: "json", table: "serviceTable", nested: true }),
                    ..RemoteResourceLayout::default()
                },
                _ => RemoteResourceLayout::default(),
            }
        }
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
    fn a_registered_extension_owns_remote_paths_and_mcp_codec_without_service_switches() {
        static FIXTURE: AssociationCli = AssociationCli(AssociationCase::Declared);
        let registry = super::super::Registry::with_adapters(vec![&FIXTURE]).unwrap();
        let adapter = registry.get("association_declared").unwrap();
        assert_eq!(PublishedDescriptor::from_adapter(adapter).remote_resources.mcp.unwrap().relative, ".fixture/native.json");
        let original = r#"{"model":"keep","mcp":{"unrelated":true,"serviceTable":{}}}"#;
        let rendered = adapter.render_remote_mcp(original, &serde_json::json!({"entries":[{"name":"fixture","command":"fixture-command","args":["--safe"]}]})).unwrap();
        let text = String::from_utf8(rendered).unwrap();
        let document: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(document["model"], "keep");
        assert_eq!(document["mcp"]["unrelated"], true);
        assert_eq!(adapter.parse_remote_mcp(&text).unwrap()["entries"][0]["name"], "fixture");
        assert!(super::super::Registry::builtins().get("unknown").is_none());
        assert!(AssociationCli(AssociationCase::Undeclared).render_remote_mcp("{}", &Value::Null).is_err());
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