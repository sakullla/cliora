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

/// Some CLIs print Windows paths in URL form, `/C:/work/a.ts`. On Windows that is the drive path.
fn url_style_drive_path(value: &str) -> &str {
    let bytes = value.as_bytes();
    let url_form = cfg!(windows) && bytes.len() > 3 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() && bytes[2] == b':' && matches!(bytes[3], b'/' | b'\\');
    if url_form { &value[1..] } else { value }
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
        PathBuf::from(url_style_drive_path(value))
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
    // On Windows, joining a rooted, drive-less path keeps only the session's
    // drive/share prefix (D:\work + /Users/x => D:\Users\x). The desktop
    // process's working drive is unrelated to the terminal that printed it.
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
                let metadata = path.metadata().map_err(|_| format!("无法读取文件路径：{}", path.display()))?;
                if !metadata.is_file() && !metadata.is_dir() { return Err(format!("仅支持普通文件和文件夹：{}", path.display())); }
                return Ok(path);
            }
            // Report the actual resolved target so users can tell "not on this machine" from a form-parsing issue.
            Err(error) => last_error = format!("文件或文件夹不存在，或无法访问：{}（系统错误：{error}）", path.display()),
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

/// Resolve a path a session showed: against a terminal session's current
/// directory, or else an ACP conversation's own directory (an id neither host
/// knows keeps the terminal host's error). A terminal session opens what its own
/// output names. An ACP conversation offers only locations inside its directory,
/// so the resolved target must still lie under that directory once every link
/// and junction is followed; otherwise it is refused.
pub(crate) fn resolve_for_session(session_id: &str, home: &Path, value: &str) -> Result<PathBuf, String> {
    match crate::session_host::local_directory(session_id) {
        Ok(directory) => resolve(directory.as_deref(), home, value),
        Err(error) => match crate::acp::local_directory(session_id) {
            Ok(Some(directory)) => resolve_inside(&directory, home, value),
            Ok(None) => Err("远程 ACP 路径不能在本机打开".into()),
            _ => Err(error),
        },
    }
}

/// Resolve `value` against `directory` and require the canonical target to lie
/// under the canonical directory (component-wise; without case on Windows). A
/// symbolic link or junction inside the directory that points elsewhere is
/// refused, as is `..` or an absolute path outside it.
fn resolve_inside(directory: &Path, home: &Path, value: &str) -> Result<PathBuf, String> {
    let path = resolve(Some(directory), home, value)?;
    let root = crate::safe_fs::canonical_root(directory)?;
    if crate::safe_fs::is_protected(&path, &[root]) {
        Ok(path)
    } else {
        Err(format!("该路径不在对话目录内（可能经符号链接或联接点指向别处），不能从对话中打开：{}", path.display()))
    }
}

pub(crate) fn open(app: &tauri::AppHandle, session_id: &str, home: &Path, value: &str) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let path = resolve_for_session(session_id, home, value)?;
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

    #[cfg(windows)]
    #[test]
    fn url_style_drive_paths_open_the_drive_path() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("a.txt"), "test").unwrap();
        let expected = temp.path().join("a.txt").canonicalize().unwrap();
        let url_form = format!("/{}:204", temp.path().join("a.txt").display().to_string().replace('\\', "/"));
        assert_eq!(resolve(Some(temp.path()), temp.path(), &url_form).unwrap(), expected);
        assert_eq!(url_style_drive_path("/tmp/a.txt"), "/tmp/a.txt");
    }

    #[cfg(windows)]
    #[test]
    fn rooted_paths_use_the_session_drive_without_its_subdirectories() {
        let temp = tempfile::tempdir().unwrap();
        let real = temp.path().join("y.md");
        std::fs::write(&real, "test").unwrap();
        let display = real.to_string_lossy().into_owned();
        assert_eq!(&display[1..2], ":", "{display}");
        // The same file written in POSIX form: `/Users/...` with no drive prefix.
        let posix = format!("/{}", display[2..].trim_start_matches(['\\', '/']).replace('\\', "/"));
        let expected = real.canonicalize().unwrap();
        let session = temp.path().join("sessions/elsewhere");
        assert_eq!(resolve(Some(&session), temp.path(), &posix).unwrap(), expected);
        assert_eq!(resolve(Some(&session), temp.path(), &posix.replace('/', "\\")).unwrap(), expected);
        // Check multiple drives without requiring any particular drive to exist
        // or assuming TEMP and the desktop process are on the same drive.
        for drive in ["C:", "D:"] {
            let session = PathBuf::from(format!("{drive}\\sessions\\elsewhere"));
            for value in ["/Users/example/y.md", "\\Users\\example\\y.md"] {
                assert_eq!(expand(value, &session, temp.path()).unwrap(), PathBuf::from(format!("{drive}\\Users\\example\\y.md")));
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn drive_prefixed_unc_and_url_forms_keep_their_existing_handling() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("a.txt");
        std::fs::write(&file, "test").unwrap();
        let expected = file.canonicalize().unwrap();
        // Bare drive-prefixed absolute paths stay as they are.
        assert_eq!(resolve(Some(temp.path()), temp.path(), &file.to_string_lossy()).unwrap(), expected);
        // `/C:/` URL form is stripped to the drive path before resolution.
        let url_form = format!("/{}", file.to_string_lossy().replace('\\', "/"));
        assert_eq!(resolve(Some(Path::new("D:\\sessions\\elsewhere")), temp.path(), &url_form).unwrap(), expected);
        // UNC and device paths are untouched by the drive-root resolution: this share
        // does not exist, and the failure must not claim a current-drive target.
        let unc = resolve(Some(temp.path()), temp.path(), "\\\\server\\share\\file.txt");
        assert!(unc.is_err());
        assert!(unc.unwrap_err().contains("\\\\server\\share\\file.txt"));
    }

    #[test]
    fn missing_absolute_paths_report_the_exact_target_without_searching_elsewhere() {
        let temp = tempfile::tempdir().unwrap();
        let session = temp.path().join("session");
        std::fs::create_dir(&session).unwrap();
        std::fs::write(session.join("missing.md"), "a different file").unwrap();
        let missing = temp.path().join("missing.md");
        let error = resolve(Some(&session), temp.path(), &missing.to_string_lossy()).unwrap_err();
        assert!(error.contains(&missing.display().to_string()), "{error}");
    }

    #[test]
    fn a_conversation_opens_only_paths_that_stay_in_its_directory() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("session");
        let outside = temp.path().join("outside");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join("src/a.ts"), "a").unwrap();
        std::fs::write(outside.join("key.txt"), "k").unwrap();
        let link = root.join("link");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        #[cfg(windows)]
        {
            let status = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(&link)
                .arg(&outside)
                .stdout(std::process::Stdio::null())
                .status()
                .unwrap();
            assert!(status.success(), "无法创建联接点");
        }
        // Inside the directory, relative or absolute, a file or a folder: allowed.
        assert_eq!(resolve_inside(&root, temp.path(), "src/a.ts:3").unwrap(), root.join("src/a.ts").canonicalize().unwrap());
        assert!(resolve_inside(&root, temp.path(), &root.join("src").display().to_string()).is_ok());
        // The plain resolver follows the link; a conversation refuses where it lands.
        assert!(resolve(Some(&root), temp.path(), "link/key.txt").is_ok());
        let error = resolve_inside(&root, temp.path(), "link/key.txt").unwrap_err();
        assert!(error.contains("不在对话目录内"), "{error}");
        assert!(resolve_inside(&root, temp.path(), &link.join("key.txt").display().to_string()).is_err());
        assert!(resolve_inside(&root, temp.path(), "link").is_err());
        // `..` and an absolute path outside are refused as well.
        assert!(resolve_inside(&root, temp.path(), "../outside/key.txt").is_err());
        assert!(resolve_inside(&root, temp.path(), &outside.join("key.txt").display().to_string()).is_err());
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
