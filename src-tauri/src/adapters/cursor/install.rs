//! Windows install evidence for the Cursor desktop editor.
//!
//! The uninstall table is the install record. A matching DisplayName is
//! `Cursor` or `Cursor (User)`. The quoted uninstaller lives in the install
//! root, next to `Cursor.exe`. `agent` is a different product and is never
//! accepted. No default directory is guessed when the table has no row.

use std::path::PathBuf;

use crate::native::adapter::Installation;

pub(crate) fn matches_editor(display_name: &str) -> bool {
    let lower = display_name.trim().to_ascii_lowercase();
    if lower.is_empty() || lower.contains("agent") {
        return false;
    }
    lower == "cursor" || lower.starts_with("cursor ") || lower.starts_with("cursor(")
}

/// Parent of a quoted `unins*.exe` command. Windows separators are parsed
/// explicitly so the fixture does not depend on the host's path style.
pub(crate) fn install_root_from_uninstall(command: &str) -> Option<PathBuf> {
    let quoted = command
        .split('"')
        .nth(1)
        .filter(|text| !text.trim().is_empty())?;
    let file = quoted.rsplit(['\\', '/']).next()?;
    if !file.to_ascii_lowercase().starts_with("unins") {
        return None;
    }
    let end = quoted.rfind(['\\', '/'])?;
    if end == 0 {
        return None;
    }
    Some(PathBuf::from(&quoted[..end]))
}

pub(crate) fn installations() -> Vec<Installation> {
    #[cfg(windows)]
    {
        let Some(record) = crate::windows_registry::application(matches_editor) else {
            return Vec::new();
        };
        let Some(command) = record.uninstall.as_deref() else {
            return Vec::new();
        };
        let Some(root) = install_root_from_uninstall(command) else {
            return Vec::new();
        };
        let path = root.join("Cursor.exe");
        if !path.is_file() {
            return Vec::new();
        }
        return vec![Installation {
            path: path.display().to_string(),
            version: record.version,
            source: "native",
            status: "available",
            detail: None,
        }];
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::*;

    #[test]
    fn editor_name_accepts_the_desktop_product_and_rejects_agent() {
        assert!(matches_editor("Cursor"));
        assert!(matches_editor("Cursor (User)"));
        assert!(matches_editor("  cursor  "));
        assert!(!matches_editor("Cursor Agent"));
        assert!(!matches_editor("agent"));
        assert!(!matches_editor("Anysphere Cursor"));
        assert!(!matches_editor(""));
    }

    #[test]
    fn uninstall_command_points_at_the_install_root_without_guessing() {
        assert_eq!(
            install_root_from_uninstall(
                r#""C:\Users\example\AppData\Local\Programs\cursor\unins000.exe""#
            )
            .unwrap(),
            PathBuf::from(r"C:\Users\example\AppData\Local\Programs\cursor")
        );
        assert!(install_root_from_uninstall(r#""C:\Tools\agent\agent.exe""#).is_none());
        assert!(install_root_from_uninstall("Cursor Agent").is_none());
        assert!(install_root_from_uninstall("").is_none());
    }

    #[cfg(windows)]
    #[test]
    fn recorded_install_is_cursor_exe_or_absent() {
        for item in installations() {
            let path = Path::new(&item.path);
            assert!(path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case("Cursor.exe")));
            assert!(!item.path.to_ascii_lowercase().contains("agent"));
            assert_eq!(item.source, "native");
            assert_eq!(item.status, "available");
            assert!(path.is_file());
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn non_windows_hosts_have_no_cursor_install_marker() {
        assert!(installations().is_empty());
    }
}
