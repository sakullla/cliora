//! Windows install markers for the ZCode desktop app (ADR-4 of
//! docs/sakullla-workflow/2026-10-03-new-cli-adapters-default-off).
//!
//! The desktop binary has no `--version` contract (`ZCode.exe --version` opens
//! the app), so installation identity comes from the three official markers
//! verified against the machine and the upstream installer configuration:
//!
//! 1. the `zcode://` protocol registration
//!    (`HKCU\Software\Classes\zcode\shell\open\command`, registered by the app
//!    through `setAsDefaultProtocolClient("zcode")`),
//! 2. the per-user NSIS uninstall entry
//!    (`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall`, written by
//!    electron-builder with `DisplayName`, `DisplayVersion`,
//!    `UninstallString`),
//! 3. the `.zcode-install-manifest` marker file in the install root
//!    (`WINDOWS_INSTALL_MANIFEST_NAME` of electron-builder.config.js), with the
//!    official `ZCODE_WINDOWS_APP_INSTALL_DIR` override honored.
//!
//! A version is reported only when the uninstall table carries
//! `DisplayVersion`; it is never fabricated (ADR-4).

use std::path::{Path, PathBuf};

/// Marker file the installer writes into the install root.
const MANIFEST_NAME: &str = ".zcode-install-manifest";
/// Product identity from the official desktop build (`productName: ZCode`);
/// electron-builder derives the executable name from it.
const EXE_NAME: &str = "ZCode.exe";
const PROTOCOL_KEY: &str = r"HKCU\Software\Classes\zcode\shell\open\command";
const UNINSTALL_ROOTS: [&str; 2] = [
    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall",
    r"HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall",
];

/// Install roots backed by official markers, deduplicated, each verified to
/// hold the desktop executable. Declared through the adapter's native-binary
/// directories and desktop installation evidence.
pub(crate) fn install_directories(home: &Path) -> Vec<PathBuf> {
    directories_with_uninstall(home, uninstall_entry().as_ref())
}

fn directories_with_uninstall(home: &Path, uninstall: Option<&(PathBuf, Option<String>)>) -> Vec<PathBuf> {
    if !cfg!(windows) {
        return Vec::new();
    }
    let mut directories: Vec<PathBuf> = Vec::new();
    let mut push = |directory: PathBuf| {
        if directory.join(EXE_NAME).is_file() && !directories.contains(&directory) {
            directories.push(directory);
        }
    };
    if let Some(exe) = protocol_executable() {
        if let Some(parent) = exe.parent() {
            push(parent.to_path_buf());
        }
    }
    if let Some((directory, _version)) = uninstall {
        push(directory.clone());
    }
    if let Some(root) = manifest_root(home) {
        push(root);
    }
    directories
}

/// Marker 1: the registered `zcode://` handler command, e.g.
/// `"C:\Users\me\AppData\Local\Programs\ZCode\ZCode.exe" "%1"`.
fn protocol_executable() -> Option<PathBuf> {
    parse_protocol_executable(&reg_query(&[PROTOCOL_KEY, "/ve"])?)
}

/// Marker 2: the per-user (or per-machine) uninstall entry. Returns the install
/// directory plus `DisplayVersion` when the table provides one.
fn uninstall_entry() -> Option<(PathBuf, Option<String>)> {
    for root in UNINSTALL_ROOTS {
        if let Some(output) = reg_query(&[root, "/s"]) {
            if let Some(entry) = parse_uninstall_entry(&output) {
                return Some(entry);
            }
        }
    }
    None
}

pub(crate) fn installations(home: &Path) -> Vec<crate::native::adapter::Installation> {
    let uninstall = uninstall_entry();
    directories_with_uninstall(home, uninstall.as_ref()).into_iter().map(|root| {
        let version = uninstall.as_ref().filter(|(path, _)| path == &root || path.canonicalize().ok().zip(root.canonicalize().ok()).is_some_and(|(a, b)| a == b))
            .and_then(|(_, version)| version.clone());
        crate::native::adapter::Installation {
            path: root.join(EXE_NAME).display().to_string(),
            version, source: "native", status: "available", detail: None,
        }
    }).collect()
}

/// Marker 3: the install root confirmed by the manifest marker file, honoring
/// the official `ZCODE_WINDOWS_APP_INSTALL_DIR` override and the per-user
/// Programs layout relative to the profile home.
fn manifest_root(home: &Path) -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("ZCODE_WINDOWS_APP_INSTALL_DIR")
        .filter(|value| !value.is_empty())
    {
        return manifest_verified(&PathBuf::from(dir));
    }
    let base = std::env::var_os("LOCALAPPDATA")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("AppData").join("Local"));
    manifest_verified(&base.join("Programs").join("ZCode"))
}

fn manifest_verified(root: &Path) -> Option<PathBuf> {
    (root.join(MANIFEST_NAME).is_file() && root.join(EXE_NAME).is_file())
        .then(|| root.to_path_buf())
}

fn reg_query(args: &[&str]) -> Option<String> {
    if !cfg!(windows) {
        return None;
    }
    let output = crate::background_process::command("reg")
        .arg("query")
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Extracts the quoted executable path from a `reg query ... /ve` output line
/// such as `    (默认)    REG_SZ    "C:\...\ZCode.exe" "%1"` (any value-name
/// locale). Pure so tests can drive it with captured output.
pub(crate) fn parse_protocol_executable(output: &str) -> Option<PathBuf> {
    for line in output.lines() {
        let Some(position) = line.find("REG_SZ") else {
            continue;
        };
        let rest = &line[position + "REG_SZ".len()..];
        let Some(start) = rest.find('"') else {
            continue;
        };
        let after = &rest[start + 1..];
        let Some(end) = after.find('"') else {
            continue;
        };
        let candidate = Path::new(&after[..end]);
        if candidate
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("exe"))
        {
            return Some(candidate.to_path_buf());
        }
    }
    None
}

/// Finds the ZCode block in a recursive `reg query ... /s` output and returns
/// its install directory with `DisplayVersion` when present. Blocks are keyed
/// by `HKEY_` header lines; a missing `DisplayVersion` yields `None` rather
/// than a fabricated version.
pub(crate) fn parse_uninstall_entry(output: &str) -> Option<(PathBuf, Option<String>)> {
    let mut blocks: Vec<Vec<&str>> = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("HKEY_") {
            blocks.push(Vec::new());
        } else if !trimmed.is_empty() {
            if let Some(block) = blocks.last_mut() {
                block.push(trimmed);
            }
        }
    }
    for block in blocks {
        let mut display_name = None;
        let mut version = None;
        let mut uninstall_string = None;
        for line in block {
            let Some((name, value)) = reg_value(line) else {
                continue;
            };
            match name {
                "DisplayName" => display_name = Some(value.to_owned()),
                "DisplayVersion" => version = Some(value.to_owned()),
                "UninstallString" => uninstall_string = Some(value.to_owned()),
                _ => {}
            }
        }
        let Some(name) = display_name.as_deref() else {
            continue;
        };
        if !name.trim_start().starts_with("ZCode") {
            continue;
        }
        let Some(uninstall) = uninstall_string else {
            continue;
        };
        let Some(start) = uninstall.find('"') else {
            continue;
        };
        let after = &uninstall[start + 1..];
        let Some(end) = after.find('"') else {
            continue;
        };
        // "C:\...\ZCode\Uninstall ZCode.exe" /currentuser -> install root.
        let uninstaller = Path::new(&after[..end]);
        let Some(directory) = uninstaller.parent() else {
            continue;
        };
        return Some((directory.to_path_buf(), version));
    }
    None
}

/// Splits `    DisplayName    REG_SZ    ZCode 3.14.4` into the value name and
/// the value text after the type token.
fn reg_value(line: &str) -> Option<(&str, &str)> {
    let line = line.trim_start();
    let (name, rest) = line.split_once("    ")?;
    let rest = rest.trim_start();
    let position = rest.find("REG_SZ")?;
    let value = rest[position + "REG_SZ".len()..].trim();
    Some((name.trim(), value))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Captured from a real ZCode 3.14.4 per-user install (reg.exe output,
    // user name replaced).
    const PROTOCOL_OUTPUT: &str = "\r\n\r\nHKEY_CURRENT_USER\\Software\\Classes\\zcode\\shell\\open\\command\r\n    (默认)    REG_SZ    \"C:\\Users\\user\\AppData\\Local\\Programs\\ZCode\\ZCode.exe\" \"%1\"\r\n\r\n";

    const UNINSTALL_OUTPUT: &str = "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\268ce9e6-a30b-5890-ad18-d4b3ebba5377\r\n    DisplayName    REG_SZ    ZCode 3.14.4\r\n    UninstallString    REG_SZ    \"C:\\Users\\user\\AppData\\Local\\Programs\\ZCode\\Uninstall ZCode.exe\" /currentuser\r\n    DisplayVersion    REG_SZ    3.14.4\r\n    Publisher    REG_SZ    ZCode\r\n\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\31df50fe-edbb-5d76-969b-4e1d47e4b7d7\r\n    DisplayName    REG_SZ    Netcatty 1.1.79\r\n    UninstallString    REG_SZ    \"C:\\Users\\user\\AppData\\Local\\Programs\\Netcatty\\Uninstall Netcatty.exe\" /currentuser\r\n\r\n";

    #[test]
    fn protocol_registration_resolves_the_desktop_executable() {
        let exe = parse_protocol_executable(PROTOCOL_OUTPUT).unwrap();
        assert!(
            exe.to_string_lossy()
                .replace('\\', "/")
                .ends_with("Programs/ZCode/ZCode.exe")
        );
        // A command line without a quoted executable is not evidence.
        assert!(parse_protocol_executable(
            "    (默认)    REG_SZ    zcode\r\n"
        )
        .is_none());
    }

    #[test]
    fn uninstall_table_distinguishes_zcode_and_keeps_the_reported_version() {
        let (directory, version) = parse_uninstall_entry(UNINSTALL_OUTPUT).unwrap();
        assert!(
            directory
                .to_string_lossy()
                .replace('\\', "/")
                .ends_with("Programs/ZCode")
        );
        assert_eq!(version.as_deref(), Some("3.14.4"));
    }

    #[test]
    fn missing_display_version_is_not_fabricated() {
        let without_version =
            UNINSTALL_OUTPUT.replace("    DisplayVersion    REG_SZ    3.14.4\r\n", "");
        let (_, version) = parse_uninstall_entry(&without_version).unwrap();
        assert_eq!(version, None);
        // No ZCode block: not installed.
        let other = UNINSTALL_OUTPUT.replace("ZCode 3.14.4", "Other App 3.14.4");
        assert!(parse_uninstall_entry(&other).is_none());
    }

    #[test]
    fn manifest_marker_needs_both_the_marker_file_and_the_executable() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("ZCode");
        std::fs::create_dir_all(&root).unwrap();
        assert!(manifest_verified(&root).is_none(), "空目录不算已安装");
        std::fs::write(root.join(EXE_NAME), "binary").unwrap();
        assert!(
            manifest_verified(&root).is_none(),
            "只有 exe 没有安装标记不算已安装"
        );
        std::fs::write(root.join(MANIFEST_NAME), "files\n").unwrap();
        assert_eq!(manifest_verified(&root), Some(root.clone()));
        std::fs::remove_file(root.join(EXE_NAME)).unwrap();
        assert!(
            manifest_verified(&root).is_none(),
            "标记存在但 exe 已移除不算已安装"
        );
    }

    #[test]
    fn reg_value_splitting_handles_multi_token_values() {
        assert_eq!(
            reg_value("    DisplayName    REG_SZ    ZCode 3.14.4"),
            Some(("DisplayName", "ZCode 3.14.4"))
        );
        assert_eq!(reg_value("HKEY_CURRENT_USER\\Software"), None);
    }
}
