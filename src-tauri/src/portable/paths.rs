//! Portable paths describe a location relative to the user's home, never the
//! source OS's drive letter or user name. Native CLI paths remain adapter-owned.
use std::path::{Path, PathBuf};

const HOME: &str = "cliora-home:/";

pub(super) fn home() -> Option<PathBuf> {
    #[cfg(test)]
    if let Some((home, _)) = super::RESTORE_ROOTS.with(|roots| roots.borrow().clone()) {
        return Some(home);
    }
    dirs::home_dir()
}

fn valid_relative(value: &str) -> bool {
    !value.contains(['\\', ':', '\0'])
        && value.split('/').all(|part| !matches!(part, "" | "." | ".."))
}

pub(super) fn encode_at(value: &str, home: &Path) -> String {
    let value_normal = value.replace('\\', "/");
    let home_normal = home.to_string_lossy().replace('\\', "/");
    let prefix = format!("{}/", home_normal.trim_end_matches('/'));
    let windows = home_normal.as_bytes().get(1) == Some(&b':');
    let matches = if windows {
        value_normal.get(..prefix.len()).is_some_and(|part| part.eq_ignore_ascii_case(&prefix))
    } else {
        value_normal.starts_with(&prefix)
    };
    if matches {
        let relative = &value_normal[prefix.len()..];
        if valid_relative(relative) {
            return format!("{HOME}{relative}");
        }
    }
    value.to_owned()
}

pub(super) fn encode(value: &str) -> String {
    home().map_or_else(|| value.to_owned(), |home| encode_at(value, &home))
}

pub(super) fn decode_at(value: &str, home: &Path) -> Result<String, String> {
    let Some(relative) = value.strip_prefix(HOME) else { return Ok(value.to_owned()) };
    if !valid_relative(relative) {
        return Err("迁移路径包含无效目录片段".into());
    }
    Ok(relative.split('/').fold(home.to_path_buf(), |path, part| path.join(part)).to_string_lossy().into_owned())
}

pub(super) fn decode(value: &str) -> Result<String, String> {
    if !value.starts_with(HOME) { return Ok(value.to_owned()) }
    decode_at(value, &home().ok_or("无法定位本机用户目录")?)
}

pub(super) fn is_portable(value: &str) -> bool {
    value.strip_prefix(HOME).is_some_and(valid_relative)
}

pub(super) fn encode_scope(scope: &str) -> String {
    match scope.split_once("project:") {
        Some((prefix, path)) => format!("{prefix}project:{}", encode(path)),
        None => scope.to_owned(),
    }
}

pub(super) fn decode_scope(scope: &str) -> Result<String, String> {
    match scope.split_once("project:") {
        Some((prefix, path)) => Ok(format!("{prefix}project:{}", decode(path)?)),
        None => Ok(scope.to_owned()),
    }
}

pub(super) fn command(value: &str) -> String {
    let normalized = value.replace('\\', "/");
    let name = normalized.rsplit('/').next().unwrap_or(value);
    let bare = name.strip_suffix(".cmd").or_else(|| name.strip_suffix(".exe")).unwrap_or(name);
    // These are package runners, not CLI adapters. A source installation's
    // absolute launcher path is not useful on another OS; resolve via its PATH.
    if matches!(bare, "npx" | "npm" | "node" | "uv" | "uvx" | "bun" | "bunx" | "deno" | "python" | "python3") {
        bare.to_owned()
    } else {
        encode(value)
    }
}

pub(super) fn decode_value(value: &mut serde_json::Value) -> Result<(), String> {
    match value {
        serde_json::Value::String(text) => *text = decode(text)?,
        serde_json::Value::Array(items) => for item in items { decode_value(item)?; },
        serde_json::Value::Object(items) => for item in items.values_mut() { decode_value(item)?; },
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_home_and_runner_move_to_macos_without_user_names_or_drive_letters() {
        let portable = encode_at(r"C:\Users\Alice\projects\demo", Path::new(r"C:\Users\Alice"));
        assert_eq!(portable, "cliora-home:/projects/demo");
        assert_eq!(decode_at(&portable, Path::new("/Users/bob")).unwrap().replace('\\', "/"), "/Users/bob/projects/demo");
        assert_eq!(command(r"C:\Program Files\nodejs\npx.cmd"), "npx");
        assert_eq!(command("/opt/homebrew/bin/uvx"), "uvx");
        assert_eq!(command("npx.cmd"), "npx");
    }
    #[test]
    fn outside_paths_and_unsafe_relative_paths_are_not_relocated() {
        assert_eq!(encode_at("/Users/alice2/repo", Path::new("/Users/alice")), "/Users/alice2/repo");
        for value in ["cliora-home:/../outside", "cliora-home:/C:/outside", "cliora-home://outside", "cliora-home:/a\\b"] {
            assert!(decode_at(value, Path::new("/Users/bob")).is_err());
        }
    }
}
