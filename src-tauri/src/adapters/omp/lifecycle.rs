//! OMP lifecycle: identity, installation channels, version policy, native
//! launch/resume arguments and maintenance declarations.
//!
//! Evidence read on 2026-11-15: `packages/coding-agent/package.json` declares
//! `bin.omp`, `@oh-my-pi/pi-coding-agent` 18.20.2 and Bun >=1.4.4; the session
//! operations document declares `--resume [value]` and `--continue`. Update
//! commands are declared per identified channel only (Bun, the Windows
//! precompiled image, and an existing npm global install); a channel without a
//! verified command reports none, and an installation channel is never silently
//! switched.
//!
//! npm evidence (2026-11-17, Windows): `npm install -g @oh-my-pi/pi-coding-agent`
//! publishes `%APPDATA%\npm\omp.cmd`, a cmd-shim that runs Bun on
//! `node_modules\@oh-my-pi\pi-coding-agent\dist\cli.js`. Such an install is
//! updated through npm; Cliora never offers npm as a fresh install channel.

use std::env;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::LaunchMode;
use crate::adapters::version::VersionPolicy;
use crate::native::adapter::Dependency;

pub(crate) const PACKAGE: &str = "@oh-my-pi/pi-coding-agent";
/// First verified native baseline. Shown as information only: ordinary releases
/// at or beyond it are accepted without a version-per-version review, and no
/// upper bound is declared. Only a recorded breaking release or a failed
/// identity check rejects an installation.
pub(crate) const BASELINE: &str = "18.20.2";
/// Releases with a verified incompatibility. Empty today: no breaking OMP
/// release has been proven in this repository, so nothing is guessed.
pub(crate) const KNOWN_BROKEN: &[&str] = &[];
pub(crate) const BASELINE_NOTE: &str =
    "18.20.2 仅作为已验证基线展示；更新的普通版本默认接受并可用于启动与维护，未逐版验证";
pub(crate) const REPOSITORY: &str = "https://github.com/can1357/oh-my-pi";
/// `packages/coding-agent/package.json` engines require Bun 1.4.4 or newer.
pub(crate) const MINIMUM_BUN: (u32, u32, u32) = (1, 4, 4);

pub(crate) const YOLO_REASON: &str = "OMP 尚无已验证的自动批准（YOLO）启动参数";
pub(crate) const LAUNCH_REASON: &str =
    "可在外部终端启动已安装的 omp；18.20.2 只是已验证基线，更新的普通版本默认可用（未逐版验证）";
pub(crate) const RESUME_REASON: &str =
    "使用 OMP 的 --resume [value] 恢复指定会话、--continue 恢复最近会话；本机尚未用真实 omp 验收";
pub(crate) const BUN_INSTALL_COMMAND: &str = "bun add -g @oh-my-pi/pi-coding-agent";
pub(crate) const BUN_UPDATE_COMMAND: &str = "bun update -g @oh-my-pi/pi-coding-agent";
pub(crate) const BUN_UNINSTALL_COMMAND: &str = "bun remove -g @oh-my-pi/pi-coding-agent";
/// Package path fragment inside an npm global `node_modules` tree.
const NPM_PACKAGE_FRAGMENT: &str = "node_modules/@oh-my-pi/pi-coding-agent/";
pub(crate) const NPM_HELP_URL: &str = "https://nodejs.org/en/download";
/// Verified by the official Windows installer: precompiled omp 18.20.2 in an
/// isolated LOCALAPPDATA, `omp --version` and `omp update` both exit 0.
pub(crate) const NATIVE_UPDATE_COMMAND: &str = "omp update";
pub(crate) const NATIVE_INSTALL_COMMAND: &str = "irm https://omp.sh/install.ps1 | iex";
pub(crate) const BUN_HELP_URL: &str = "https://bun.sh/docs/installation";
pub(crate) const MISSING_BUN_REASON: &str =
    "未找到 Bun 可执行文件；OMP 由 Bun 运行（官方要求 Bun 1.4.4 或更新），缺少 Bun 时不会改用其他安装来源";
pub(crate) const COMMAND_UNVERIFIED_REASON: &str =
    "官方安装脚本地址与升级命令尚未核实；Cliora 不执行猜测的命令，也不会在预编译二进制与 Bun 安装之间切换来源";

/// Wide compatibility policy: no upper bound and no exact match. Every parseable
/// ordinary release is accepted; prereleases stay unverified, and only a
/// recorded breaking release (none today) is excluded.
pub(crate) fn version_policy() -> VersionPolicy {
    policy_with_exclusions(KNOWN_BROKEN)
}

/// The same wide policy with an explicit exclusion list. Kept as a separate
/// function so recorded breakage can be added without changing the shape, and
/// so the exclusion mechanism can be tested without inventing a real version.
pub(crate) fn policy_with_exclusions(excluded: &'static [&'static str]) -> VersionPolicy {
    VersionPolicy {
        requirements: vec![">=0.0.0".into()],
        excluded,
    }
}

pub(crate) fn launch_facet() -> crate::adapters::Facet {
    crate::adapters::Facet {
        state: "available",
        reason: LAUNCH_REASON,
    }
}

pub(crate) fn resume_facet() -> crate::adapters::Facet {
    crate::adapters::Facet {
        state: "available",
        reason: RESUME_REASON,
    }
}

pub(crate) fn install_guidance() -> (&'static str, &'static str) {
    (
        REPOSITORY,
        "OMP 由官方安装脚本、Bun 或预编译二进制安装。Cliora 只识别已安装的 omp，并按检测到的来源保留状态；尚未核实的安装或升级命令不会被执行，也不会在来源之间切换。版本不受精确锁定，更新版本默认可用但未逐版验证。",
    )
}

/// Which officially described channel an `omp` executable belongs to.
///
/// Classification uses only observable layout facts, never an assumed OMP
/// directory: a Bun global bin directory, a package payload under
/// `node_modules`, a standalone `omp`/`omp.exe` image, or an unclassified path.
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Channel {
    /// Found inside Bun's global binary directory (`BUN_INSTALL/bin`).
    Bun,
    /// A package payload under `node_modules` (Bun resolves its global bin here).
    Package,
    /// A standalone executable outside any package manager layout.
    Standalone,
    /// Neither an identified OMP image nor a recognised package manager layout.
    Unknown,
}

/// Bun's global root. `BUN_INSTALL` is Bun's documented relocation variable.
pub(crate) fn bun_install_root(home: &Path, configured: Option<&Path>) -> PathBuf {
    configured
        .map(Path::to_path_buf)
        .unwrap_or_else(|| home.join(".bun"))
}

pub(crate) fn bun_bin_directories(home: &Path, configured: Option<&Path>) -> Vec<PathBuf> {
    vec![bun_install_root(home, configured).join("bin")]
}

fn configured_bun_root() -> Option<PathBuf> {
    env::var_os("BUN_INSTALL")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// Extra discovery directories. Bun's global bin directory is a documented
/// installation location and is not always on PATH; no OMP-owned directory is
/// guessed. The Windows precompiled installer's verified target is added too.
pub(crate) fn binary_directories(home: &Path) -> Vec<PathBuf> {
    let mut directories = bun_bin_directories(home, configured_bun_root().as_deref());
    directories.extend(precompiled_directories(
        env::var_os("LOCALAPPDATA").filter(|value| !value.is_empty()).map(PathBuf::from).as_deref(),
    ));
    directories
}

/// Official Windows precompiled target (`%LOCALAPPDATA%\omp`, verified with the
/// official installer). Other platforms have no verified target.
pub(crate) fn precompiled_directories(local_app_data: Option<&Path>) -> Vec<PathBuf> {
    if !cfg!(windows) {
        return Vec::new();
    }
    local_app_data
        .map(|root| vec![root.join("omp")])
        .unwrap_or_default()
}

fn components(path: &Path) -> Vec<String> {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy().to_ascii_lowercase())
        .collect()
}

fn inside(path: &Path, directory: &Path) -> bool {
    if cfg!(windows) {
        let child = components(path);
        let parent = components(directory);
        child.len() >= parent.len() && child[..parent.len()] == parent
    } else {
        path.starts_with(directory)
    }
}

/// Classify one candidate path for a home and an optional explicit Bun root.
pub(crate) fn channel_at(home: &Path, bun_root: Option<&Path>, path: &Path) -> Channel {
    for directory in bun_bin_directories(home, bun_root) {
        if inside(path, &directory) {
            return Channel::Bun;
        }
    }
    // A probe may point at another home or an isolated root. Bun's global bin
    // layout is the same on every platform, so it is named without trusting a
    // caller-supplied home.
    let parts = components(path);
    if parts.len() >= 3 && parts[parts.len() - 2] == "bin" && parts[parts.len() - 3] == ".bun" {
        return Channel::Bun;
    }
    let lowered = path.to_string_lossy().to_ascii_lowercase();
    if components(path).iter().any(|part| part == "node_modules")
        && (lowered.contains(&PACKAGE.to_ascii_lowercase())
            || lowered.contains("pi-coding-agent"))
    {
        return Channel::Package;
    }
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(name.as_str(), "omp" | "omp.exe") {
        return Channel::Standalone;
    }
    Channel::Unknown
}

/// Classification for the current process environment.
pub(crate) fn channel(path: &Path) -> Channel {
    let Some(home) = dirs::home_dir() else {
        return Channel::Unknown;
    };
    channel_at(&home, configured_bun_root().as_deref(), path)
}

/// The shared probe asks this before the npm/package check. Only a standalone
/// image is "native"; a Bun or package shim stays in the package channel so a
/// native upgrade never replaces it.
pub(crate) fn is_standalone_binary(path: &Path) -> bool {
    // A Unix npm global link is named `omp` too; it belongs to npm, not to the
    // precompiled channel, so `omp update` is never offered for it.
    channel(path) == Channel::Standalone && !is_npm_shim(path)
}

/// Whether `path` is an npm global entry for the OMP package.
///
/// Windows npm writes `omp.cmd`/`omp.ps1` shims that name the package payload;
/// Unix npm links `omp` into `node_modules`. Bun's global tree (`.bun/...`) uses
/// the same `node_modules` layout and is explicitly excluded so a Bun install is
/// never updated through npm.
pub(crate) fn is_npm_shim(path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(extension.as_str(), "cmd" | "ps1") {
        let Ok(file) = std::fs::File::open(path) else {
            return false;
        };
        let mut bytes = Vec::new();
        if file.take(16_384).read_to_end(&mut bytes).is_err() {
            return false;
        }
        return npm_shim_text(&String::from_utf8_lossy(&bytes));
    }
    if cfg!(windows) {
        return false;
    }
    path.canonicalize()
        .map(|real| npm_shim_text(&real.to_string_lossy()))
        .unwrap_or(false)
}

fn npm_shim_text(text: &str) -> bool {
    let normalized = text.replace('\\', "/").to_ascii_lowercase();
    normalized.contains(NPM_PACKAGE_FRAGMENT) && !normalized.contains("/.bun/")
}

fn find_bun(directories: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) {
        &["bun.exe", "bun.cmd"]
    } else {
        &["bun"]
    };
    find_named(directories, names)
}

fn find_npm(directories: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) { &["npm.cmd"] } else { &["npm"] };
    find_named(directories, names)
}

fn find_named(directories: impl IntoIterator<Item = PathBuf>, names: &[&str]) -> Option<PathBuf> {
    for directory in directories {
        for name in names {
            let candidate = directory.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

pub(crate) fn bun_executable(home: &Path) -> Option<PathBuf> {
    let mut directories = crate::process_environment::directories();
    directories.extend(binary_directories(home));
    find_bun(directories)
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BunStatus {
    pub path: Option<String>,
    /// Empty when Bun is present. Never empty when Bun is missing, so a missing
    /// dependency is always observable and never silently substituted.
    pub reason: &'static str,
}

pub(crate) fn bun_status(home: &Path) -> BunStatus {
    match bun_executable(home) {
        Some(path) => BunStatus {
            path: Some(path.display().to_string()),
            reason: "",
        },
        None => BunStatus {
            path: None,
            reason: MISSING_BUN_REASON,
        },
    }
}

pub(crate) fn launch_args(session: Option<&str>, mode: LaunchMode) -> Result<Vec<String>, String> {
    if matches!(mode, LaunchMode::Yolo) {
        return Err(YOLO_REASON.into());
    }
    Ok(session
        .map(|id| vec!["--resume".to_owned(), id.to_owned()])
        .unwrap_or_default())
}

pub(crate) fn resume_latest_args(mode: LaunchMode) -> Result<Vec<String>, String> {
    if matches!(mode, LaunchMode::Yolo) {
        return Err(YOLO_REASON.into());
    }
    Ok(vec!["--continue".to_owned()])
}

/// Adapter-owned verified source label. Bun's global bin is named first, then an
/// npm global entry; standalone images keep the shared `native` channel and an
/// unrecognised path still falls back to `unknown`.
pub(crate) fn source_label(path: &Path) -> Option<&'static str> {
    if channel(path) == Channel::Bun {
        return Some("bun");
    }
    is_npm_shim(path).then_some("npm_shim")
}

fn bun_version_tuple(text: &str) -> Option<(u32, u32, u32)> {
    let mut parts = text.trim().trim_start_matches('v').split('.');
    Some((
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    ))
}

fn bun_version(path: &Path) -> Option<(u32, u32, u32)> {
    let mut child = crate::background_process::command(path)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut output = String::new();
                if let Some(mut stream) = child.stdout.take() {
                    let _ = stream.read_to_string(&mut output);
                }
                if !status.success() {
                    return None;
                }
                return bun_version_tuple(&output);
            }
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            _ => {
                crate::background_process::terminate(&mut child);
                return None;
            }
        }
    }
}

/// Bun runtime dependency for the shared install panel. A standalone (native)
/// installation does not claim a Bun requirement it has not verified.
pub(crate) fn runtime_dependencies(source: &str, installed: bool, home: &Path) -> Vec<Dependency> {
    let mut directories = crate::process_environment::directories();
    directories.extend(binary_directories(home));
    runtime_dependencies_at(directories, source, installed)
}

fn runtime_dependencies_at(
    directories: impl IntoIterator<Item = PathBuf>,
    source: &str,
    installed: bool,
) -> Vec<Dependency> {
    // Only a confirmed Bun or npm installation, or a missing installation,
    // claims a Bun runtime (the npm shim runs Bun too). A standalone/custom path
    // does not invent a requirement it has not verified.
    if installed && source != "bun" && source != "npm_shim" {
        return Vec::new();
    }
    let directories: Vec<PathBuf> = directories.into_iter().collect();
    let status = match find_bun(directories.clone()) {
        None => "missing",
        Some(path) => match bun_version(&path) {
            Some(version) if version >= MINIMUM_BUN => "found",
            // An old Bun, or one that did not answer: report the hard
            // requirement instead of silently claiming it is usable.
            _ => "outdated",
        },
    };
    let mut dependencies = vec![Dependency {
        name: "Bun",
        status,
        detail: "OMP 由 Bun 运行；需要 Bun 1.4.4 或更新版本",
        help_url: BUN_HELP_URL,
    }];
    if installed && source == "npm_shim" {
        dependencies.push(Dependency {
            name: "npm",
            status: if find_npm(directories).is_some() { "found" } else { "missing" },
            detail: "更新 npm 安装的 OMP 需要 npm",
            help_url: NPM_HELP_URL,
        });
    }
    dependencies
}

pub(crate) fn install_command() -> Option<String> {
    // Bun is the verified install channel. The precompiled downloader stays
    // undeclared because no official URL has been verified.
    Some(BUN_INSTALL_COMMAND.to_owned())
}

pub(crate) fn source_install_command(source: Option<&str>) -> Option<String> {
    match source {
        None | Some("bun") => Some(BUN_INSTALL_COMMAND.to_owned()),
        Some("native") => native_install_command(),
        _ => None,
    }
}

pub(crate) fn source_upgrade_command(source: &str, _version: Option<&str>) -> Option<String> {
    match source {
        "bun" => Some(BUN_UPDATE_COMMAND.to_owned()),
        "native" => Some(NATIVE_UPDATE_COMMAND.to_owned()),
        // Only an identified npm install is updated through npm; npm is never
        // offered as a fresh install channel.
        "npm_shim" => crate::adapters::contract::npm_install_command_for(PACKAGE, &[]),
        _ => None,
    }
}

pub(crate) fn source_uninstall_command(source: &str, _version: Option<&str>) -> Option<String> {
    match source {
        "bun" => Some(BUN_UNINSTALL_COMMAND.to_owned()),
        "npm_shim" => crate::adapters::contract::npm_uninstall_command_for(PACKAGE),
        _ => None,
    }
}

pub(crate) fn native_install_command() -> Option<String> {
    // Verified on Windows with the official installer in an isolated
    // LOCALAPPDATA. The script is the documented official entry; no download
    // URL or command is guessed for other platforms.
    cfg!(windows).then(|| NATIVE_INSTALL_COMMAND.to_owned())
}

pub(crate) fn npm_install_command() -> Option<String> {
    // No verified npm channel exists; Bun installs must not be reported as npm.
    None
}

pub(crate) fn upgrade_command(_source: &str) -> Option<String> {
    // Source-aware updates go through source_upgrade_command.
    None
}

pub(crate) fn uninstall_command() -> Option<String> {
    None
}

pub(crate) fn npm_uninstall_command() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn home() -> PathBuf {
        PathBuf::from("/home/example")
    }

    #[test]
    fn wide_policy_accepts_newer_ordinary_releases_and_the_baseline() {
        let policy = version_policy();
        for version in [
            "18.20.2",
            "18.20.3",
            "18.21.0",
            "18.19.0",
            "19.0.0",
            "19.4.2",
            "20.0.0",
            "25.1.7",
            "v20.3.1",
            "18.20.2+build.7",
        ] {
            assert!(policy.accepts(version), "{version}");
        }
        // Only unparseable versions and prereleases stay unverified.
        for version in ["invalid", "1.0", "20", "19.0.0-beta.1", ""] {
            assert!(!policy.accepts(version), "{version}");
        }
        assert_eq!(policy.excluded, KNOWN_BROKEN);
        assert!(KNOWN_BROKEN.is_empty(), "没有已证实的破坏版本时不得编造排除项");
        assert!(BASELINE_NOTE.contains("18.20.2"));
        assert!(BASELINE_NOTE.contains("未逐版验证"));
    }

    #[test]
    fn recorded_breakage_is_the_only_version_rejection_mechanism() {
        let policy = policy_with_exclusions(&["19.0.0"]);
        assert!(!policy.accepts("19.0.0"));
        assert!(!policy.accepts("v19.0.0"));
        assert!(policy.accepts("19.0.1"));
        assert!(policy.accepts("20.0.0"));
        // The product policy carries no invented exclusion.
        assert!(version_policy().accepts("19.0.0"));
    }

    #[test]
    fn bun_layout_is_recognised_for_default_and_relocated_roots() {
        let home = home();
        assert_eq!(
            channel_at(&home, None, &home.join(".bun/bin/omp")),
            Channel::Bun
        );
        assert_eq!(
            channel_at(&home, None, &home.join(".bun/bin/omp.exe")),
            Channel::Bun
        );
        let relocated = PathBuf::from("/opt/bun-root");
        assert_eq!(
            channel_at(&home, Some(&relocated), Path::new("/opt/bun-root/bin/omp")),
            Channel::Bun
        );
        assert_eq!(
            channel_at(&home, None, Path::new("/opt/bun-root/bin/omp")),
            Channel::Standalone
        );
    }

    #[test]
    fn package_payload_and_standalone_images_stay_distinct() {
        let home = home();
        let package = Path::new(
            "/home/example/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/cli.ts",
        );
        assert_eq!(channel_at(&home, None, package), Channel::Package);
        assert_eq!(
            channel_at(&home, None, Path::new("/usr/local/bin/omp")),
            Channel::Standalone
        );
        assert_eq!(
            channel_at(&home, None, Path::new("/opt/tools/omp.exe")),
            Channel::Standalone
        );
        assert_eq!(
            channel_at(&home, None, Path::new("/usr/local/bin/pi")),
            Channel::Unknown
        );
        assert_eq!(
            channel_at(&home, None, home.join(".bun/bin/other").as_path()),
            Channel::Bun,
            "Bun 全局目录中的任何可执行文件都属于 Bun 渠道"
        );
        assert_eq!(
            channel_at(&home, None, Path::new("/opt/tools/agent")),
            Channel::Unknown
        );
        assert_ne!(
            channel_at(&home, None, &home.join(".bun/bin/omp")),
            Channel::Standalone
        );
    }

    #[test]
    fn discovery_adds_buns_documented_global_bin_directory() {
        let home = home();
        assert_eq!(
            bun_bin_directories(&home, None),
            vec![home.join(".bun/bin")]
        );
        let names: BTreeSet<PathBuf> = binary_directories(&home).into_iter().collect();
        assert!(names.contains(&home.join(".bun/bin")));
        assert_eq!(
            precompiled_directories(Some(Path::new("C:/Users/me/AppData/Local"))),
            if cfg!(windows) { vec![PathBuf::from("C:/Users/me/AppData/Local/omp")] } else { Vec::new() }
        );
        assert_eq!(
            find_bun(Vec::new()),
            None,
            "空目录列表不会把其他可执行文件当作 Bun"
        );
    }

    #[test]
    fn resume_uses_omp_arguments_and_never_pi_session() {
        assert_eq!(
            launch_args(None, LaunchMode::Normal).unwrap(),
            Vec::<String>::new()
        );
        assert_eq!(
            launch_args(Some("ses_01H"), LaunchMode::Normal).unwrap(),
            vec!["--resume".to_string(), "ses_01H".to_string()]
        );
        assert!(!launch_args(Some("ses_01H"), LaunchMode::Normal)
            .unwrap()
            .iter()
            .any(|arg| arg == "--session"));
        assert_eq!(
            resume_latest_args(LaunchMode::Normal).unwrap(),
            vec!["--continue".to_string()]
        );
        assert!(launch_args(None, LaunchMode::Yolo).is_err());
        assert!(resume_latest_args(LaunchMode::Yolo).is_err());
    }

    #[test]
    fn verified_commands_cover_bun_and_windows_precompiled_install() {
        assert_eq!(install_command().unwrap(), BUN_INSTALL_COMMAND);
        assert_eq!(source_install_command(None).unwrap(), BUN_INSTALL_COMMAND);
        assert_eq!(source_install_command(Some("bun")).unwrap(), BUN_INSTALL_COMMAND);
        assert!(source_install_command(Some("npm_shim")).is_none());
        assert_eq!(
            source_upgrade_command("bun", Some("18.20.2")).unwrap(),
            BUN_UPDATE_COMMAND
        );
        assert_eq!(
            source_upgrade_command("native", Some("18.20.2")).unwrap(),
            NATIVE_UPDATE_COMMAND
        );
        assert!(source_upgrade_command("unknown", Some("18.20.2")).is_none());
        assert_eq!(
            source_uninstall_command("bun", Some("18.20.2")).unwrap(),
            BUN_UNINSTALL_COMMAND
        );
        assert!(source_uninstall_command("native", Some("18.20.2")).is_none());
        assert_eq!(
            source_install_command(Some("native")).is_some(),
            cfg!(windows),
            "仅 Windows 官方预编译安装脚本已核实"
        );
        assert_eq!(
            native_install_command().is_some(),
            cfg!(windows),
            "预编译安装入口按平台核实"
        );
        if cfg!(windows) {
            assert_eq!(
                native_install_command().as_deref(),
                Some("irm https://omp.sh/install.ps1 | iex")
            );
        }
        assert!(npm_install_command().is_none());
        assert!(upgrade_command("npm_shim").is_none());
        assert!(install_guidance().1.contains("不会"));
        assert!(!COMMAND_UNVERIFIED_REASON.trim().is_empty());
    }

    /// Sanitized copy of the cmd-shim npm writes for `npm install -g
    /// @oh-my-pi/pi-coding-agent` on Windows (observed 2026-11-17).
    const NPM_CMD_SHIM: &str = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST \"%dp0%\\bun.exe\" (\r\n  SET \"_prog=%dp0%\\bun.exe\"\r\n) ELSE (\r\n  SET \"_prog=bun\"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@oh-my-pi\\pi-coding-agent\\dist\\cli.js\" %*\r\n";

    #[test]
    fn npm_global_shim_is_identified_and_updated_through_npm() {
        let temporary = tempfile::tempdir().unwrap();
        let shim = temporary.path().join("omp.cmd");
        std::fs::write(&shim, NPM_CMD_SHIM).unwrap();
        assert!(is_npm_shim(&shim));
        assert_eq!(source_label(&shim), Some("npm_shim"));
        assert!(!is_standalone_binary(&shim));

        let ps1 = temporary.path().join("omp.ps1");
        std::fs::write(&ps1, "& \"bun$exe\"  \"$basedir/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js\" $args").unwrap();
        assert_eq!(source_label(&ps1), Some("npm_shim"));

        // Another package's shim, or a Bun global tree, is not an npm OMP install.
        let other = temporary.path().join("pi.cmd");
        std::fs::write(&other, NPM_CMD_SHIM.replace("@oh-my-pi", "@earendil-works")).unwrap();
        assert_eq!(source_label(&other), None);
        assert!(!npm_shim_text(
            "/home/example/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js"
        ));

        let upgrade = source_upgrade_command("npm_shim", Some("18.20.3")).unwrap();
        assert!(upgrade.starts_with("npm install -g @oh-my-pi/pi-coding-agent@latest "), "{upgrade}");
        assert_eq!(
            source_uninstall_command("npm_shim", Some("18.20.3")).as_deref(),
            Some("npm uninstall -g @oh-my-pi/pi-coding-agent")
        );
        // npm stays an update-only channel: never a fresh install.
        assert!(source_install_command(Some("npm_shim")).is_none());
        assert!(npm_install_command().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn unix_npm_link_is_npm_not_standalone() {
        let temporary = tempfile::tempdir().unwrap();
        let package = temporary
            .path()
            .join("lib/node_modules/@oh-my-pi/pi-coding-agent/dist");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(package.join("cli.js"), "#!/usr/bin/env bun\n").unwrap();
        let bin = temporary.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let link = bin.join("omp");
        std::os::unix::fs::symlink(package.join("cli.js"), &link).unwrap();
        assert_eq!(source_label(&link), Some("npm_shim"));
        assert!(!is_standalone_binary(&link));
    }

    #[test]
    fn npm_install_reports_bun_and_npm_dependencies() {
        let temporary = tempfile::tempdir().unwrap();
        let dependencies =
            runtime_dependencies_at(vec![temporary.path().to_path_buf()], "npm_shim", true);
        let names: Vec<_> = dependencies.iter().map(|item| item.name).collect();
        assert_eq!(names, ["Bun", "npm"]);
        assert!(dependencies.iter().all(|item| item.status == "missing"));
        let npm = temporary
            .path()
            .join(if cfg!(windows) { "npm.cmd" } else { "npm" });
        std::fs::write(&npm, "").unwrap();
        let dependencies =
            runtime_dependencies_at(vec![temporary.path().to_path_buf()], "npm_shim", true);
        assert_eq!(dependencies[1].status, "found");
    }

    #[test]
    fn bun_paths_are_the_only_adapter_named_source() {
        let home = home();
        assert_eq!(
            source_label(&home.join(".bun/bin/omp")),
            Some("bun"),
            "真实 Bun 全局 bin 由适配器标注"
        );
        assert_eq!(source_label(Path::new("/usr/local/bin/omp")), None);
        assert_eq!(source_label(Path::new("/usr/local/bin/pi")), None);
        assert_eq!(
            source_label(Path::new(
                "/home/example/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/cli.ts"
            )),
            None
        );
    }

    #[test]
    fn bun_dependency_is_reported_without_claiming_node_or_npm() {
        let dependencies = runtime_dependencies_at(Vec::new(), "unknown", false);
        assert_eq!(dependencies.len(), 1, "只报告 Bun，不误报 Node/npm");
        assert_eq!(dependencies[0].name, "Bun");
        assert_eq!(dependencies[0].status, "missing");
        assert!(dependencies[0].help_url.contains("bun.sh"));
        // A standalone (native) or unclassified installed path does not claim a
        // Bun requirement it has not verified.
        let temporary = tempfile::tempdir().unwrap();
        assert!(runtime_dependencies("native", true, temporary.path()).is_empty());
        assert!(runtime_dependencies("unknown", true, temporary.path()).is_empty());
        // Version parsing is exact enough for the 1.4.4 floor.
        assert_eq!(bun_version_tuple("1.4.4\n"), Some((1, 4, 4)));
        assert_eq!(bun_version_tuple("v20.1.0"), Some((20, 1, 0)));
        assert_eq!(bun_version_tuple("bun 1.4.4"), None);
    }

    #[test]
    fn missing_bun_reports_an_explicit_reason_and_never_a_substitute() {
        let temporary = tempfile::tempdir().unwrap();
        assert_eq!(find_bun(Vec::new()), None);
        let status = BunStatus {
            path: None,
            reason: MISSING_BUN_REASON,
        };
        assert!(status.reason.contains("Bun 1.4.4"));
        // A real host Bun is still reported by path, never by substitution.
        let host = bun_status(temporary.path());
        if let Some(path) = host.path {
            assert!(Path::new(&path).is_absolute());
            assert!(host.reason.is_empty());
        } else {
            assert_eq!(host.reason, MISSING_BUN_REASON);
        }
    }
}
