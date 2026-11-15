//! OMP lifecycle: identity, installation channels, version policy, native
//! launch/resume arguments and maintenance declarations.
//!
//! Evidence read on 2026-11-15: `packages/coding-agent/package.json` declares
//! `bin.omp`, `@oh-my-pi/pi-coding-agent` 18.20.2 and Bun >=1.4.4; the session
//! operations document declares `--resume [value]` and `--continue`. The
//! official precompiled download URL and any update command are NOT verified in
//! this repository, so Cliora declares none: a missing command is reported by
//! the shared maintenance service and an installation channel is never
//! silently switched.

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
/// Verified by `omp update` exiting 0 with "Already up to date" in the isolated
/// Bun installation on 2026-11-15.
pub(crate) const NATIVE_UPDATE_COMMAND: &str = "omp update";
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
/// guessed.
pub(crate) fn binary_directories(home: &Path) -> Vec<PathBuf> {
    bun_bin_directories(home, configured_bun_root().as_deref())
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
    channel(path) == Channel::Standalone
}

fn find_bun(directories: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) {
        &["bun.exe", "bun.cmd"]
    } else {
        &["bun"]
    };
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

/// Adapter-owned verified source label. Only Bun's global bin is named here;
/// standalone images keep the shared `native` channel and an unrecognised path
/// still falls back to `unknown`.
pub(crate) fn source_label(path: &Path) -> Option<&'static str> {
    (channel(path) == Channel::Bun).then_some("bun")
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
    // Only a confirmed Bun installation or a missing installation claims a Bun
    // runtime. A standalone/custom path does not invent a requirement it has
    // not verified.
    if installed && source != "bun" {
        return Vec::new();
    }
    let Some(path) = find_bun(directories) else {
        return vec![Dependency {
            name: "Bun",
            status: "missing",
            detail: "OMP 由 Bun 运行；需要 Bun 1.4.4 或更新版本",
            help_url: BUN_HELP_URL,
        }];
    };
    let status = match bun_version(&path) {
        Some(version) if version >= MINIMUM_BUN => "found",
        Some(_) => "outdated",
        // The executable exists but did not answer; report the hard requirement
        // instead of silently claiming it is usable.
        None => "outdated",
    };
    vec![Dependency {
        name: "Bun",
        status,
        detail: "OMP 由 Bun 运行；需要 Bun 1.4.4 或更新版本",
        help_url: BUN_HELP_URL,
    }]
}

pub(crate) fn install_command() -> Option<String> {
    // Bun is the verified install channel. The precompiled downloader stays
    // undeclared because no official URL has been verified.
    Some(BUN_INSTALL_COMMAND.to_owned())
}

pub(crate) fn source_install_command(source: Option<&str>) -> Option<String> {
    match source {
        None | Some("bun") => Some(BUN_INSTALL_COMMAND.to_owned()),
        _ => None,
    }
}

pub(crate) fn source_upgrade_command(source: &str, _version: Option<&str>) -> Option<String> {
    match source {
        "bun" => Some(BUN_UPDATE_COMMAND.to_owned()),
        "native" => Some(NATIVE_UPDATE_COMMAND.to_owned()),
        _ => None,
    }
}

pub(crate) fn source_uninstall_command(source: &str, _version: Option<&str>) -> Option<String> {
    match source {
        "bun" => Some(BUN_UNINSTALL_COMMAND.to_owned()),
        _ => None,
    }
}

pub(crate) fn native_install_command() -> Option<String> {
    None
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
    fn verified_commands_cover_bun_and_native_but_never_guess_the_precompiled_installer() {
        assert_eq!(install_command().unwrap(), BUN_INSTALL_COMMAND);
        assert_eq!(source_install_command(None).unwrap(), BUN_INSTALL_COMMAND);
        assert_eq!(source_install_command(Some("bun")).unwrap(), BUN_INSTALL_COMMAND);
        assert!(source_install_command(Some("native")).is_none());
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
        assert!(native_install_command().is_none(), "预编译下载地址未核实，不得猜测");
        assert!(npm_install_command().is_none());
        assert!(upgrade_command("npm_shim").is_none());
        assert!(install_guidance().1.contains("不会"));
        assert!(!COMMAND_UNVERIFIED_REASON.trim().is_empty());
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
