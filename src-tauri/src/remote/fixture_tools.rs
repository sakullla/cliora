//! Test-only adapters for the production Linux/GNU transaction contract on macOS.
//! The lock uses the actual kernel flock; metadata comes from lstat, never a no-op.

pub(super) fn bootstrap() -> String {
    #[cfg(target_os = "macos")]
    {
        use base64::Engine;
        let mut script=String::from("umask 077\nmkdir -p \"$HOME/.local/bin\" || exit 90\nchmod 700 \"$HOME/.local\" \"$HOME/.local/bin\" || exit 90\n");
        for (name, text) in [("flock", FLOCK), ("stat", STAT)] {
            let encoded = base64::engine::general_purpose::STANDARD.encode(text);
            script.push_str(&format!("printf '%s' '{encoded}' | base64 -d > \"$HOME/.local/bin/{name}\" || exit 90\nchmod 700 \"$HOME/.local/bin/{name}\" || exit 90\n"));
        }
        script.push_str("export PATH=\"$HOME/.local/bin:$HOME/bin:$PATH\"\n");
        script
    }
    #[cfg(not(target_os = "macos"))]
    {
        String::new()
    }
}

/// Fault wrappers must delegate to the actual host tool, not an absent /usr/bin
/// path on macOS. This changes only the local fixture, never remote production.
pub(super) fn adapt_fault_tool(name: &str, text: &str) -> String {
    #[cfg(target_os = "macos")]
    {
        let native = std::env::var_os("PATH")
            .into_iter()
            .flat_map(|paths| std::env::split_paths(&paths).collect::<Vec<_>>())
            .map(|directory| directory.join(name))
            .find(|path| path.is_file())
            .expect("native fixture tool exists");
        text.replace(
            &format!("exec /usr/bin/{name} "),
            &format!("exec {} ", super::shell_quote(&native.to_string_lossy())),
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = name;
        text.to_owned()
    }
}

#[cfg(target_os = "macos")]
const FLOCK: &str = r#"#!/usr/bin/python3
import errno, fcntl, math, sys, time
try:
    args=sys.argv[1:]
    if len(args)!=3 or args[0]!='-w': raise ValueError('expected -w timeout fd')
    seconds=float(args[1]); fd=int(args[2])
    if not math.isfinite(seconds) or seconds<0 or fd<0: raise ValueError('invalid timeout or fd')
    deadline=time.monotonic()+seconds
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX|fcntl.LOCK_NB)
            break
        except OSError as error:
            if error.errno not in (errno.EACCES,errno.EAGAIN): raise
            if time.monotonic()>=deadline: sys.exit(1)
            time.sleep(min(0.01,max(0,deadline-time.monotonic())))
except (OSError,ValueError) as error:
    print('fixture flock: '+str(error),file=sys.stderr)
    sys.exit(1)
"#;
#[cfg(target_os = "macos")]
const STAT: &str = r#"#!/usr/bin/python3
import os, stat, sys
try:
    args=sys.argv[1:]
    if len(args)<3 or args[0]!='-c': raise ValueError('expected -c format [--] path')
    format=args[1]; paths=args[2:]
    if paths and paths[0]=='--': paths=paths[1:]
    if len(paths)!=1 or format not in ('%u:%h','%u','%h','%a'): raise ValueError('unsupported stat request')
    info=os.lstat(paths[0])
    values={'%u:%h':str(info.st_uid)+':'+str(info.st_nlink),'%u':str(info.st_uid),'%h':str(info.st_nlink),'%a':oct(stat.S_IMODE(info.st_mode))[2:]}
    print(values[format])
except (OSError,ValueError) as error:
    print('fixture stat: '+str(error),file=sys.stderr)
    sys.exit(1)
"#;

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::process::{Command, Stdio};
    fn run(home: &std::path::Path, script: &str) -> std::process::Output {
        Command::new("sh")
            .args(["-c", script])
            .env("HOME", home)
            .output()
            .unwrap()
    }
    fn setup(home: &std::path::Path) {
        let output = run(home, &bootstrap());
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    #[test]
    fn fixture_flock_is_mutually_exclusive_and_rejects_invalid_descriptors() {
        let root = tempfile::tempdir().unwrap();
        setup(root.path());
        let lock = std::fs::File::create(root.path().join("lock")).unwrap();
        lock.lock().unwrap();
        let blocked = run(
            root.path(),
            "exec 9>\"$HOME/lock\"; \"$HOME/.local/bin/flock\" -w 0 9",
        );
        assert!(!blocked.status.success());
        lock.unlock().unwrap();
        let mut child=Command::new("sh").args(["-c","exec 9>\"$HOME/lock\"; \"$HOME/.local/bin/flock\" -w 1 9 || exit; printf 'locked\\n'; read release"])
            .env("HOME",root.path()).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        assert_eq!(line, "locked\n");
        assert!(matches!(
            lock.try_lock(),
            Err(std::fs::TryLockError::WouldBlock)
        ));
        child.stdin.take().unwrap().write_all(b"release\n").unwrap();
        assert!(child.wait().unwrap().success());
        lock.try_lock().unwrap();
        lock.unlock().unwrap();
        let invalid = run(root.path(), "\"$HOME/.local/bin/flock\" -w 0 999");
        assert!(!invalid.status.success());
        assert!(!invalid.stderr.is_empty());
    }
    #[test]
    fn fixture_stat_reports_real_owner_links_modes_and_missing_file_failures() {
        let root = tempfile::tempdir().unwrap();
        setup(root.path());
        let file = root.path().join("ordinary");
        std::fs::write(&file, "data").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::hard_link(&file, root.path().join("hardlink")).unwrap();
        let metadata = std::fs::symlink_metadata(&file).unwrap();
        let owner = run(
            root.path(),
            "\"$HOME/.local/bin/stat\" -c '%u:%h' -- \"$HOME/ordinary\"",
        );
        assert!(owner.status.success());
        assert_eq!(
            String::from_utf8(owner.stdout).unwrap().trim(),
            format!("{}:2", metadata.uid())
        );
        let mode = run(
            root.path(),
            "\"$HOME/.local/bin/stat\" -c '%a' \"$HOME/ordinary\"",
        );
        assert!(mode.status.success());
        assert_eq!(String::from_utf8(mode.stdout).unwrap().trim(), "600");
        std::os::unix::fs::symlink(&file, root.path().join("link")).unwrap();
        let link = run(
            root.path(),
            "\"$HOME/.local/bin/stat\" -c '%h' \"$HOME/link\"",
        );
        assert!(link.status.success());
        assert_eq!(String::from_utf8(link.stdout).unwrap().trim(), "1");
        let missing = run(
            root.path(),
            "\"$HOME/.local/bin/stat\" -c '%a' \"$HOME/missing\"",
        );
        assert!(!missing.status.success());
        assert!(!missing.stderr.is_empty());
    }
}
