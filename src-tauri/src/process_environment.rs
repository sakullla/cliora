use std::env;
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Command;

/// Finder-launched macOS apps do not inherit the user's terminal PATH. Keep the
/// recovered PATH on child commands rather than mutating the process environment.
pub(crate) fn path() -> Option<OsString> {
    #[cfg(target_os = "macos")]
    {
        static SHELL_PATH: std::sync::LazyLock<Option<OsString>> =
            std::sync::LazyLock::new(login_shell_path);
        merged_macos_path(
            SHELL_PATH.as_deref(),
            env::var_os("PATH").as_deref(),
            dirs::home_dir().as_deref(),
        )
    }
    #[cfg(not(target_os = "macos"))]
    env::var_os("PATH")
}

pub(crate) fn directories() -> Vec<PathBuf> {
    path()
        .map(|value| env::split_paths(&value).collect())
        .unwrap_or_default()
}

pub(crate) fn apply(command: &mut Command) {
    if let Some(path) = path() {
        command.env("PATH", path);
    }
}

#[cfg(any(target_os = "macos", test))]
fn merged_macos_path(
    shell: Option<&std::ffi::OsStr>,
    inherited: Option<&std::ffi::OsStr>,
    home: Option<&std::path::Path>,
) -> Option<OsString> {
    let mut directories = Vec::new();
    let mut add = |directory: PathBuf| {
        // Empty/relative PATH entries must not make a project-local file a CLI.
        if directory.is_absolute() && !directories.contains(&directory) {
            directories.push(directory);
        }
    };
    for value in [shell, inherited].into_iter().flatten() {
        for directory in env::split_paths(value) {
            add(directory);
        }
    }
    if let Some(home) = home {
        for directory in [
            ".local/bin",
            ".npm-global/bin",
            ".npm/bin",
            ".volta/bin",
            ".asdf/shims",
            ".local/share/mise/shims",
            ".bun/bin",
        ] {
            add(home.join(directory));
        }
    }
    for directory in [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ] {
        add(PathBuf::from(directory));
    }
    env::join_paths(directories).ok()
}

#[cfg(any(target_os = "macos", test))]
fn parse_shell_path(bytes: &[u8]) -> Option<OsString> {
    let marker = b"\0CLIORA_PATH\0";
    let start = bytes
        .windows(marker.len())
        .rposition(|part| part == marker)?
        + marker.len();
    let end = bytes[start..].iter().position(|byte| *byte == 0)? + start;
    let value = std::str::from_utf8(&bytes[start..end]).ok()?;
    (!value.is_empty()).then(|| OsString::from(value))
}

#[cfg(target_os = "macos")]
fn login_shell_path() -> Option<OsString> {
    use std::io::Read;
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    let shell = env::var_os("SHELL")
        .map(PathBuf::from)
        .filter(|shell| shell.is_absolute() && shell.is_file())
        .unwrap_or_else(|| PathBuf::from("/bin/zsh"));
    // printf is available in zsh, bash and fish. Fish stores PATH as a list.
    let script = if shell.file_name().is_some_and(|name| name == "fish") {
        "printf '\\0CLIORA_PATH\\0%s\\0' (string join : $PATH)"
    } else {
        "printf '\\0CLIORA_PATH\\0%s\\0' \"$PATH\""
    };
    let mut child = Command::new(shell)
        .args(["-ilc", script])
        .current_dir(dirs::home_dir().unwrap_or_else(|| PathBuf::from("/")))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let (sender, receiver) = std::sync::mpsc::channel();
    // Drain startup output while waiting, so a noisy shell rc cannot fill the pipe.
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.take(64 * 1024).read_to_end(&mut bytes);
        let _ = sender.send(bytes);
    });
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                let bytes = receiver.recv_timeout(Duration::from_millis(100)).ok()?;
                return parse_shell_path(&bytes);
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(unix)]
    fn finder_path_recovers_shell_tools_and_homebrew_without_duplicates() {
        let value = merged_macos_path(
            Some(std::ffi::OsStr::new(
                "/Users/test/.nvm/versions/node/v24/bin:/opt/homebrew/bin:/usr/bin",
            )),
            Some(std::ffi::OsStr::new("/usr/bin:/bin:.:")),
            Some(std::path::Path::new("/Users/test")),
        )
        .unwrap();
        let paths: Vec<_> = env::split_paths(&value).collect();
        assert_eq!(
            paths[0],
            PathBuf::from("/Users/test/.nvm/versions/node/v24/bin")
        );
        assert_eq!(
            paths
                .iter()
                .filter(|path| path.as_path() == std::path::Path::new("/usr/bin"))
                .count(),
            1
        );
        assert!(paths.contains(&PathBuf::from("/Users/test/.local/bin")));
        assert!(paths.contains(&PathBuf::from("/opt/homebrew/bin")));
        assert!(paths.iter().all(|path| path.is_absolute()));
    }

    #[test]
    #[cfg(unix)]
    fn failed_shell_still_has_native_and_system_locations() {
        let value =
            merged_macos_path(None, None, Some(std::path::Path::new("/Users/test"))).unwrap();
        let paths: Vec<_> = env::split_paths(&value).collect();
        assert!(paths.contains(&PathBuf::from("/Users/test/.local/bin")));
        assert!(paths.contains(&PathBuf::from("/usr/local/bin")));
        assert!(paths.contains(&PathBuf::from("/usr/bin")));
    }

    #[test]
    fn shell_startup_messages_are_not_interpreted_as_path() {
        assert_eq!(
            parse_shell_path(b"welcome\n\0CLIORA_PATH\0/a path/bin:/usr/bin\0goodbye\n"),
            Some(OsString::from("/a path/bin:/usr/bin"))
        );
        assert!(parse_shell_path(b"/unmarked/bin").is_none());
        assert!(parse_shell_path(b"\0CLIORA_PATH\0/truncated/bin").is_none());
        assert!(parse_shell_path(b"\0CLIORA_PATH\0\0").is_none());
    }
}
