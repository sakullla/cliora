//! ACP entry declarations for the 19 registered agents.
//!
//! Each adapter owns its program, arguments, environment policy and version
//! line; the shared host resolves the launch through `CliAdapter::acp_command`
//! and never branches on a CLI id. The evidence recorded here is the
//! 2026-11-26 Windows check in `docs/verification/acp-agents.md`: an `initialize`
//! handshake distinguishes a reachable entry point from a documented one, and
//! nothing claims an interactive turn that was not run.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::adapters::{
    AcpCapabilities, AcpCapability, AcpDependency, AcpEntry, AcpEnvironmentPolicy, AcpOrigin, AcpYolo,
    CliAdapter, InspectionFields, LaunchMode, Registry,
};
use crate::credentials::CredentialStore;
use crate::native::adapter::{Installation, NativeFile, Scope};
use crate::native::apply::NativeSecrets;
use crate::native::format::FileKind;
use crate::native::profile::{Connection, RegisteredProfile};

const AGENTS: [&str; 19] = [
    "open_code", "codex", "claude_code", "grok", "pi", "omp", "cursor", "kimi_code", "qoder_cn",
    "zcode", "deepseek", "codebuddy", "mimo_code", "minimax_code", "cline", "devin",
    "command_code", "antigravity", "kiro",
];

/// A program name plus the platform suffix the resolver would create.
fn installed_program(home: &Path, name: &str) -> PathBuf {
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    home.join("bin").join(format!("{name}{suffix}"))
}

fn install(home: &Path, name: &str) -> Installation {
    Installation {
        path: installed_program(home, name).display().to_string(),
        version: Some("1.4.0".into()),
        source: "test_fixture",
        status: "available",
        detail: None,
    }
}

fn write_program(home: &Path, name: &str) {
    std::fs::create_dir_all(home.join("bin")).unwrap();
    std::fs::write(installed_program(home, name), b"fixture").unwrap();
}

/// A registry extension that is not a product id: it proves the shared path
/// reads a declaration instead of knowing about a CLI.
const FIXTURE_ENTRY: AcpEntry = AcpEntry {
    executable: "acp-fixture",
    args: &["serve", "--stdio"],
    origin: AcpOrigin::Bridge,
    dependency: Some(AcpDependency {
        name: "fixture-bridge",
        program: Some("fixture-bridge-host"),
        install_hint: "安装 fixture-bridge 后重试",
        help_url: "https://example.invalid/fixture-bridge",
    }),
    environment: AcpEnvironmentPolicy {
        set: &[("FIXTURE_MODE", "acp")],
        bind_installation: &["FIXTURE_CLI"],
        remove: &["FIXTURE_LEAK"],
    },
    version_range: Some(("1.0.0", "2.0.0")),
    version_range_reason: "fixture 只在 1.x 提供 ACP 入口",
    capabilities: AcpCapabilities { session: true, authorization: true, cancel: true, resume: false },
    rejects_system_program: false,
    yolo: Some(AcpYolo::Client),
};

struct AcpFixture;

static ACP_FIXTURE: AcpFixture = AcpFixture;

impl CliAdapter for AcpFixture {
    fn id(&self) -> &'static str {
        "acp_fixture"
    }
    fn name(&self) -> &'static str {
        "ACP fixture"
    }
    fn command(&self) -> &'static str {
        "acp-fixture"
    }
    fn npm_package(&self) -> &'static str {
        ""
    }
    fn version_identity(&self, _basename: &str, output: &str) -> bool {
        output.contains("acp-fixture")
    }
    fn interface_formats(&self) -> &'static [&'static str] {
        &["openai_responses"]
    }
    fn file_kind(&self, _role: &str) -> Result<FileKind, String> {
        Ok(FileKind::Json)
    }
    fn has_native_secret(&self, _role: &str, _root: &Value) -> bool {
        false
    }
    fn launch_args(&self, _session: Option<&str>, _mode: LaunchMode) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    fn native_installations(&self, home: &Path) -> Vec<Installation> {
        vec![install(home, "acp-fixture")]
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
    fn inspect_values(&self, _settings: &Value, _local: &Value, _models: &Value) -> InspectionFields {
        InspectionFields { provider: None, model: None, base: None, wire: None, env: None, reasoning_effort: None }
    }
    fn install_guidance(&self) -> (&'static str, &'static str) {
        ("", "fixture")
    }
    fn acp(&self) -> AcpCapability {
        AcpCapability::unverified("handshake", "fixture 只声明入口，未运行真实对话", FIXTURE_ENTRY)
    }
    /// The account removals come from the delegated adapter, so the resolver's
    /// merge is tested without teaching it any product id.
    fn accounts(&self) -> Option<&dyn crate::adapters::accounts::AccountAdapter> {
        crate::adapters::CODEX.accounts()
    }
}

#[test]
fn every_registered_agent_declares_its_acp_route() {
    let registry = Registry::builtins();
    assert_eq!(
        registry.iter().count(),
        AGENTS.len(),
        "新增适配器必须同时声明 ACP 入口，而不是静默缺失"
    );
    for id in AGENTS {
        let adapter = registry
            .get(id)
            .unwrap_or_else(|| panic!("{id} 应注册进内置注册表"));
        let acp = adapter.acp();
        let entry = acp
            .entry
            .unwrap_or_else(|| panic!("{id} 必须声明 ACP 入口或明确的不可用原因"));
        assert!(
            matches!(acp.state, "supported" | "unverified"),
            "{id} 的 ACP 状态越界：{}",
            acp.state
        );
        assert!(
            matches!(acp.evidence, "interactive" | "handshake" | "documented"),
            "{id} 的 ACP 证据级别越界：{}",
            acp.evidence
        );
        assert!(!acp.reason.trim().is_empty(), "{id} 必须给出可诊断原因");
        assert!(!entry.executable.trim().is_empty(), "{id} 的入口程序为空");
        assert!(
            matches!(entry.origin, AcpOrigin::Native | AcpOrigin::Vendor | AcpOrigin::Bridge),
            "{id} 的来源标记越界"
        );
        assert!(acp.is_launchable(), "{id} 声明了入口却不可启动");
        // Publishing "supported" without a real turn would overclaim the
        // acceptance record.
        if acp.state == "supported" {
            assert_eq!(acp.evidence, "interactive", "{id} 的 supported 必须来自真实交互");
        }
        // A route that cannot hold a turn, ask for authorization or stop the
        // current turn is not an ACP conversation; the entry must say so.
        assert!(entry.capabilities.session, "{id} 必须声明会话");
        assert!(entry.capabilities.authorization, "{id} 必须声明工具授权");
        assert!(entry.capabilities.cancel, "{id} 必须声明停止");
        // A bridge or vendor component must explain its own install; the
        // product's own executable does not need a second package.
        assert_eq!(
            entry.origin.needs_own_install(),
            entry.dependency.is_some(),
            "{id} 的桥接依赖与非原生来源必须同时出现"
        );
        if entry.version_range.is_some() {
            assert!(
                !entry.version_range_reason.trim().is_empty(),
                "{id} 声明了版本线就必须说明起点原因"
            );
        }
    }
}

#[test]
fn acp_entry_points_match_the_checked_upstream_commands() {
    let registry = Registry::builtins();
    // executable, args — from the 2026-11-26 ACP registry, upstream docs, the
    // local --help output, or the recorded initialize handshake.
    let expected: [(&str, &str, &[&str]); 19] = [
        ("open_code", "opencode", &["acp"]),
        ("codex", "codex-acp", &[]),
        ("claude_code", "claude-agent-acp", &[]),
        ("grok", "grok", &["agent", "stdio"]),
        ("pi", "pi-acp", &[]),
        ("omp", "omp", &["acp"]),
        ("cursor", "cursor-agent", &["acp"]),
        ("kimi_code", "kimi", &["acp"]),
        ("qoder_cn", "qoderclicn", &["--acp"]),
        ("zcode", "zcode-acp", &[]),
        ("deepseek", "dsh", &["acp"]),
        ("codebuddy", "codebuddy", &["--acp"]),
        ("mimo_code", "mimo", &["acp"]),
        ("minimax_code", "mcode", &["acp"]),
        ("cline", "cline", &["--acp"]),
        ("devin", "devin", &["acp"]),
        ("command_code", if cfg!(windows) { "cmdc" } else { "cmd" }, &["acp"]),
        ("antigravity", "agy_acp_server", &[]),
        ("kiro", "kiro-cli", &["acp"]),
    ];
    for (id, executable, args) in expected {
        let entry = registry.get(id).unwrap().acp().entry.unwrap();
        assert_eq!(entry.executable, executable, "{id} 的入口程序");
        assert_eq!(entry.args, args, "{id} 的启动参数");
    }
}

#[test]
fn descriptor_publishes_the_acp_capability_without_a_product_id_branch() {
    let registry = Registry::with_adapters(vec![&ACP_FIXTURE]).unwrap();
    let descriptor = registry.get("acp_fixture").unwrap().descriptor();
    let entry = descriptor.acp.entry.expect("注册表扩展必须带出自己的 ACP 声明");
    assert_eq!(entry.executable, "acp-fixture");
    assert_eq!(entry.args, ["serve", "--stdio"]);
    assert_eq!(entry.origin, AcpOrigin::Bridge);
    assert_eq!(descriptor.acp.state, "unverified");
    assert_eq!(descriptor.acp.evidence, "handshake");
    assert!(descriptor.acp.is_launchable());

    // The same field appears for a builtin, so the shared UI reads one shape.
    let opencode = Registry::builtins().get("open_code").unwrap().descriptor();
    assert_eq!(opencode.acp.entry.unwrap().executable, "opencode");
    assert_eq!(opencode.acp.state, "unverified");
}

#[test]
fn resolved_command_carries_arguments_and_environment() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    write_program(home, "acp-fixture");
    write_program(home, "fixture-bridge-host");
    let cli = installed_program(home, "acp-fixture");

    let command = ACP_FIXTURE
        .acp_command(home, Some(&cli), Some("1.4.0"))
        .expect("在场入口与依赖应解析成功");
    assert_eq!(command.program, cli);
    assert_eq!(command.args, ["serve", "--stdio"]);
    assert_eq!(command.origin, "bridge");
    let environment = command.environment.to_vec();
    assert!(environment.contains(&("FIXTURE_MODE".to_string(), "acp".to_string())));
    // The selected installation is bound, so the bridge runs that identity.
    assert!(environment.contains(&("FIXTURE_CLI".to_string(), cli.display().to_string())));
    // ACP-only removals stay, and the account adapter's own list is merged in
    // instead of being duplicated here.
    assert!(command.remove_environment.contains(&"FIXTURE_LEAK".to_string()));
    assert!(
        command.remove_environment.contains(&"OPENAI_API_KEY".to_string()),
        "账号环境隔离必须沿用共享账号适配器：{:?}",
        command.remove_environment
    );
    let serialized = serde_json::to_value(command).unwrap();
    assert_eq!(serialized["origin"], "bridge");
    assert!(serialized["program"].is_string());
}

#[test]
fn missing_bridge_dependency_names_the_install_hint() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    write_program(home, "acp-fixture");
    let issue = ACP_FIXTURE
        .acp_command(home, Some(&installed_program(home, "acp-fixture")), Some("1.4.0"))
        .expect_err("缺桥接宿主时必须失败");
    assert_eq!(issue.code, "dependency-missing");
    assert!(issue.reason.contains("fixture-bridge"), "{}", issue.reason);
    assert!(issue.reason.contains("安装 fixture-bridge"), "{}", issue.reason);
    assert_eq!(issue.help, "https://example.invalid/fixture-bridge");

    // An absent entry program still produces a reason rather than a silent
    // fallback to another agent.
    let empty = tempfile::tempdir().unwrap();
    let issue = ACP_FIXTURE
        .acp_command(empty.path(), Some(empty.path()), Some("1.4.0"))
        .expect_err("入口不在场时必须失败");
    assert!(!issue.reason.trim().is_empty());
    assert!(issue.code == "dependency-missing" || issue.code == "not-installed");
}

#[test]
fn bridge_without_a_selected_installation_refuses_a_different_identity() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    write_program(home, "acp-fixture");
    write_program(home, "fixture-bridge-host");
    let issue = ACP_FIXTURE
        .acp_command(home, None, Some("1.4.0"))
        .expect_err("桥接需要已选定的安装");
    assert_eq!(issue.code, "identity-unresolved");
    assert!(issue.reason.contains("acp-fixture serve --stdio"), "{}", issue.reason);

    // Codex and Claude bridges bind the same way, so a shared host that omits
    // the installation cannot silently run the bundled engine.
    for id in ["codex", "claude_code"] {
        let entry = Registry::builtins().get(id).unwrap().acp().entry.unwrap();
        assert_eq!(entry.environment.bind_installation.len(), 1, "{id} 必须绑定安装");
    }
}

#[test]
fn version_outside_the_line_is_refused_with_its_reason() {
    let issue = ACP_FIXTURE
        .acp_command(Path::new("/nonexistent"), Some(Path::new("/nonexistent/cli")), Some("2.5.0"))
        .expect_err("越界版本必须失败");
    assert_eq!(issue.code, "version-unsupported");
    assert!(issue.reason.contains("2.5.0"), "{}", issue.reason);
    assert!(issue.reason.contains("1.0.0"), "{}", issue.reason);
    assert!(issue.reason.contains("fixture 只在 1.x 提供 ACP 入口"), "{}", issue.reason);

    // Kimi Code shares its executable name with the archived 1.x CLI.
    let kimi = Registry::builtins().get("kimi_code").unwrap();
    let legacy = kimi.acp_for_version(Some("1.52.0"));
    assert_eq!(legacy.state, "unsupported");
    assert!(legacy.reason.contains("旧版 Kimi CLI"), "{}", legacy.reason);
    assert_eq!(kimi.acp_for_version(Some("2.7.0")).state, "unverified");
    // An unverified version never satisfies a declared line.
    assert_eq!(kimi.acp_for_version(None).state, "unsupported");
    assert_eq!(kimi.acp_for_version(Some("9.9.9")).state, "unsupported");
    // A version-free entry keeps its state for any version.
    let opencode = Registry::builtins().get("open_code").unwrap();
    assert_eq!(opencode.acp_for_version(Some("0.0.1")).state, "unverified");
    assert_eq!(opencode.acp_for_version(None).state, "unverified");
}

#[test]
fn system_shell_is_never_accepted_as_the_acp_entry() {
    let entry = Registry::builtins()
        .get("command_code")
        .unwrap()
        .acp()
        .entry
        .unwrap();
    assert!(entry.rejects_system_program);
    assert!(!entry.accepts_candidate(Path::new("C:\\Windows\\System32\\cmd.exe")));
    assert!(!entry.accepts_candidate(Path::new("C:/WINDOWS/SysWOW64/cmd.exe")));
    assert!(entry.accepts_candidate(Path::new("C:\\Users\\someone\\AppData\\Roaming\\npm\\cmdc.cmd")));
    if cfg!(windows) {
        // The declared program is the product alias, so the system shell on
        // PATH cannot be mistaken for the ACP entry.
        assert_eq!(entry.executable, "cmdc");
        // A directory holding only the system shell yields an explicit reason.
        let shell = AcpEntry { executable: "cmd", ..entry };
        let directories = vec![PathBuf::from("C:\\Windows\\System32")];
        let issue = shell.locate(&directories).expect_err("系统目录不得提供 ACP 入口");
        assert_eq!(issue.code, "system-program");
        assert!(issue.reason.contains("cmd acp"), "{}", issue.reason);
    }
}

#[test]
fn resolved_program_search_prefers_the_adapter_installation() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    write_program(home, "acp-fixture");
    let directories = ACP_FIXTURE.acp_search_directories(home);
    assert_eq!(directories.first(), Some(&home.join("bin")));
    assert!(!directories.iter().any(|item| item.to_string_lossy().is_empty()));
}
