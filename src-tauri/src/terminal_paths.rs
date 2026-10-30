//! Terminal path activation. No filesystem work is performed for output or hover.
use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::path::Component;

fn without_location(value: &str) -> &str {
    let number = |part: &str| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());
    if let Some(value_without_close) = value.strip_suffix(')') {
        if let Some((path, location)) = value_without_close.rsplit_once('(') {
            let valid = match location.split_once(',') {
                Some((line, column)) => number(line) && number(column.trim_start()),
                None => number(location),
            };
            if valid { return path; }
        }
    }
    if let Some((path, column)) = value.rsplit_once(':') {
        if number(column) {
            return match path.rsplit_once(':') {
                Some((path, line)) if number(line) => path,
                _ => path,
            };
        }
    }
    value
}

fn expand(value: &str, directory: &Path, home: &Path) -> Result<PathBuf, String> {
    let path = if value.to_ascii_lowercase().starts_with("file://") {
        let url = url::Url::parse(value).map_err(|_| "文件链接格式无效")?;
        if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
            return Err("文件链接格式无效".into());
        }
        url.to_file_path().map_err(|_| "文件链接不是此系统支持的路径")?
    } else if let Some(relative) = value.strip_prefix("~/").or_else(|| value.strip_prefix("~\\")) {
        home.join(relative)
    } else {
        if value.contains("://") { return Err("仅支持本机文件路径".into()); }
        PathBuf::from(value)
    };
    if path.to_string_lossy().chars().any(char::is_control) {
        return Err("文件路径包含无效字符".into());
    }
    #[cfg(windows)]
    {
        use std::path::Prefix;
        for component in path.components() {
            match component {
                Component::Prefix(prefix) if matches!(prefix.kind(), Prefix::DeviceNS(_)) => return Err("不支持设备路径".into()),
                Component::Normal(name) if name.to_string_lossy().contains(':') => return Err("不支持文件数据流路径".into()),
                _ => {}
            }
        }
        if matches!(path.components().next(), Some(Component::Prefix(_))) && !path.is_absolute() {
            return Err("请使用完整的盘符路径".into());
        }
    }
    #[cfg(not(windows))]
    {
        let value = path.to_string_lossy();
        if value.starts_with("\\\\") || value.as_bytes().get(1) == Some(&b':') {
            return Err("Windows 路径无法在此系统打开".into());
        }
    }
    Ok(if path.is_absolute() { path } else { directory.join(path) })
}

/// Resolve against the host's current session cwd, not a browser-supplied base.
/// Try the literal filename first so POSIX filenames ending in ':12' still work.
pub(crate) fn resolve(directory: Option<&Path>, home: &Path, value: &str) -> Result<PathBuf, String> {
    let directory = directory.ok_or("远程终端路径不能作为本机文件打开")?;
    if value.is_empty() || value.len() > 8192 || value.chars().any(char::is_control) {
        return Err("文件路径格式无效".into());
    }
    let location = without_location(value);
    let mut last_error = String::new();
    for candidate in [value, location] {
        let path = match expand(candidate, directory, home) {
            Ok(path) => path,
            Err(error) => { last_error = error; continue; }
        };
        match path.canonicalize() {
            Ok(path) => {
                let metadata = path.metadata().map_err(|_| "无法读取文件路径")?;
                if !metadata.is_file() && !metadata.is_dir() { return Err("仅支持普通文件和文件夹".into()); }
                return Ok(path);
            }
            Err(error) => last_error = format!("文件或文件夹不存在，或无法访问：{error}"),
        }
        if location == value { break; }
    }
    Err(last_error)
}

fn reveal_only(path: &Path) -> bool {
    if path.is_dir() { return false; }
    // Opening executable associations would run terminal output as a program.
    // Such targets are selected in the file manager instead.
    let extension = path.extension().and_then(|ext| ext.to_str()).unwrap_or("").to_ascii_lowercase();
    if matches!(extension.as_str(), "exe" | "com" | "bat" | "cmd" | "ps1" | "msi" | "msp" | "scr" | "lnk" | "url" | "desktop" | "app" | "hta" | "vbs" | "vbe" | "jse" | "wsf" | "wsh" | "cpl" | "reg" | "inf" | "application" | "appref-ms") { return true; }
    #[cfg(windows)]
    if matches!(extension.as_str(), "js" | "py" | "pyw" | "rb" | "pl" | "sh") { return true; }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if path.metadata().is_ok_and(|meta| meta.permissions().mode() & 0o111 != 0) { return true; }
    }
    false
}

pub(crate) fn open(app: &tauri::AppHandle, session_id: &str, home: &Path, value: &str) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let directory = crate::session_host::local_directory(session_id)?;
    let path = resolve(directory.as_deref(), home, value)?;
    if reveal_only(&path) {
        app.opener().reveal_item_in_dir(&path).map_err(|_| "无法在文件管理器中显示此文件".into())
    } else {
        let path = crate::launch::terminal_path(&path)?;
        app.opener().open_path(path, None::<&str>).map_err(|_| "无法使用默认应用打开，请检查文件关联".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absolute_relative_home_and_location_paths_use_the_current_directory() {
        let temp = tempfile::tempdir().unwrap();
        let first = temp.path().join("first");
        let second = temp.path().join("second");
        std::fs::create_dir_all(first.join("src")).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        std::fs::write(first.join("src/文档 file.txt"), "one").unwrap();
        std::fs::write(second.join("file.txt"), "two").unwrap();
        let expected = first.join("src/文档 file.txt").canonicalize().unwrap();
        for value in ["src/文档 file.txt", "./src/文档 file.txt:12:3", "src/文档 file.txt(12, 3)", "~/first/src/文档 file.txt"] {
            assert_eq!(resolve(Some(&first), temp.path(), value).unwrap(), expected);
        }
        assert_eq!(resolve(Some(&second), temp.path(), "../first/src/文档 file.txt").unwrap(), expected);
        assert_eq!(resolve(Some(&second), temp.path(), &expected.display().to_string()).unwrap(), expected);
        let uri = url::Url::from_file_path(&expected).unwrap();
        assert_eq!(resolve(Some(&second), temp.path(), uri.as_str()).unwrap(), expected);
        assert!(resolve(Some(&first), temp.path(), "file.txt").is_err());
        assert_eq!(resolve(Some(&second), temp.path(), "file.txt").unwrap(), second.join("file.txt").canonicalize().unwrap());
        assert_eq!(resolve(Some(&first), temp.path(), "src/").unwrap(), first.join("src").canonicalize().unwrap());
    }

    #[test]
    fn remote_missing_and_non_file_targets_never_open_local_files() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("file.txt"), "test").unwrap();
        assert!(resolve(None, temp.path(), &temp.path().join("file.txt").display().to_string()).is_err());
        for value in ["", "missing.txt", "file.txt\n", "file:///tmp/%00", "https://example.com/file.txt", "javascript:alert(1)"] {
            assert!(resolve(Some(temp.path()), temp.path(), value).is_err(), "{value}");
        }
        assert!(resolve(Some(temp.path()), temp.path(), &"a".repeat(8193)).is_err());
        assert!(reveal_only(Path::new("run.cmd")));
        assert!(reveal_only(Path::new("run.exe")));
        assert!(!reveal_only(&temp.path().join("file.txt")));
    }

    #[cfg(unix)]
    #[test]
    fn literal_colon_filename_precedes_line_suffix() {
        let temp = tempfile::tempdir().unwrap();
        let exact = temp.path().join("file.txt:12");
        std::fs::write(&exact, "test").unwrap();
        std::fs::write(temp.path().join("file.txt"), "other").unwrap();
        assert_eq!(resolve(Some(temp.path()), temp.path(), "file.txt:12").unwrap(), exact.canonicalize().unwrap());
    }
}
