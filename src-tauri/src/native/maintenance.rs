//! Installation runs in a bounded background process, separate from CLI launch.
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use crate::adapters::{CliAdapter, Registry};
use super::adapter;

const LOG_BYTES: usize = 64 * 1024;
static ACTIVE: Mutex<Option<(String, Arc<AtomicBool>)>> = Mutex::new(None);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceProgress { pub tool_id: String, pub output: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceResult { pub output: String, pub version: Option<String> }

struct ActiveGuard;
impl Drop for ActiveGuard {
    fn drop(&mut self) { *ACTIVE.lock().unwrap_or_else(|e| e.into_inner()) = None; }
}

pub fn cancel(tool: &str) {
    if let Some((id, flag)) = ACTIVE.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        if id == tool { flag.store(true, Ordering::Relaxed); }
    }
}

fn script(adapter: &dyn CliAdapter, action: &str, source: &str, version: Option<&str>) -> Result<String, String> {
    if !matches!(source, "npm_shim" | "native" | "unknown") { return Err("未知安装来源".into()); }
    match action {
        "install" => match source {
            "npm_shim" => adapter.npm_install_command(),
            "native" => adapter.native_install_command(),
            _ => adapter.install_command(),
        },
        "install_native" => adapter.native_install_command(),
        // Regular updates and uninstalls follow the identified install line;
        // the explicit major upgrade only runs the adapter-declared command.
        "upgrade" => adapter.upgrade_command_for_version(source, version),
        "upgrade_major" => adapter.major_upgrade(source, version).and_then(|action| action.command),
        "uninstall_npm" => adapter.npm_uninstall_command_for_version(version),
        _ => None,
    }.ok_or_else(|| "没有可直接执行的命令".into())
}

fn shell(script: &str, home: &Path) -> Command {
    #[cfg(windows)]
    let mut command = {
        let mut command = crate::background_process::command("powershell.exe");
        // Only registry-owned scripts enter this function. Prefer npm.cmd over
        // npm.ps1 so a user's execution policy cannot silently block npm.
        let script = if let Some(args) = script.strip_prefix("npm ") { format!("npm.cmd {args}") } else { script.to_owned() };
        command.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"])
            .arg(format!("[Console]::OutputEncoding = $OutputEncoding = [System.Text.UTF8Encoding]::new($false); $ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; & {{ {script} }}; if ($null -ne $LASTEXITCODE) {{ exit $LASTEXITCODE }}"));
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = crate::background_process::command("/bin/bash");
        command.args(["-o", "pipefail", "-c", script]);
        command
    };
    command.current_dir(home);
    command
}


enum ConsoleAction {
    Ignore,
    Back(usize),
    Column(usize),
    EraseLine(usize),
    EraseDisplay(usize),
}

fn line_start(chars: &[char], cursor: usize) -> usize {
    let cursor = cursor.min(chars.len());
    chars[..cursor]
        .iter()
        .rposition(|ch| *ch == '\n')
        .map(|index| index + 1)
        .unwrap_or(0)
}

fn line_end(chars: &[char], cursor: usize) -> usize {
    let cursor = cursor.min(chars.len());
    chars[cursor..]
        .iter()
        .position(|ch| *ch == '\n')
        .map(|offset| cursor + offset)
        .unwrap_or(chars.len())
}

fn put_char(chars: &mut Vec<char>, cursor: &mut usize, ch: char) {
    if *cursor > chars.len() {
        *cursor = chars.len();
    }
    if *cursor == chars.len() || chars[*cursor] == '\n' {
        chars.insert(*cursor, ch);
    } else {
        chars[*cursor] = ch;
    }
    *cursor += 1;
}

fn escape_action(chars: &[char]) -> Option<(usize, ConsoleAction)> {
    if chars.first() != Some(&'\u{1b}') {
        return None;
    }
    let second = *chars.get(1)?;
    match second {
        '[' => {
            let mut len = 2;
            while len < chars.len() {
                let ch = chars[len];
                len += 1;
                if ('\u{40}'..='\u{7e}').contains(&ch) {
                    return Some((len, csi_action(&chars[2..len])));
                }
            }
            None
        }
        ']' => {
            let mut len = 2;
            while len < chars.len() {
                if chars[len] == '\u{7}' {
                    return Some((len + 1, ConsoleAction::Ignore));
                }
                if chars[len] == '\u{1b}' && chars.get(len + 1) == Some(&'\\') {
                    return Some((len + 2, ConsoleAction::Ignore));
                }
                len += 1;
            }
            None
        }
        _ => Some((2, ConsoleAction::Ignore)),
    }
}

fn csi_action(body: &[char]) -> ConsoleAction {
    let Some((&command, params)) = body.split_last() else {
        return ConsoleAction::Ignore;
    };
    let text: String = params.iter().filter(|ch| ch.is_ascii_digit()).collect();
    let number = |default: usize| text.parse::<usize>().unwrap_or(default);
    match command {
        'D' => ConsoleAction::Back(number(1).max(1)),
        'G' => ConsoleAction::Column(number(1).max(1)),
        'K' => ConsoleAction::EraseLine(number(0)),
        'J' => ConsoleAction::EraseDisplay(number(0)),
        _ => ConsoleAction::Ignore,
    }
}

fn apply_action(chars: &mut Vec<char>, cursor: &mut usize, action: ConsoleAction) {
    if *cursor > chars.len() {
        *cursor = chars.len();
    }
    match action {
        ConsoleAction::Ignore => {}
        ConsoleAction::Back(count) => {
            let start = line_start(chars, *cursor);
            *cursor = cursor.saturating_sub(count).max(start);
        }
        ConsoleAction::Column(column) => {
            let start = line_start(chars, *cursor);
            let end = line_end(chars, start);
            *cursor = (start + column.saturating_sub(1)).min(end);
        }
        ConsoleAction::EraseLine(mode) => {
            let start = line_start(chars, *cursor);
            let end = line_end(chars, *cursor);
            match mode {
                1 => {
                    chars.drain(start..*cursor);
                    *cursor = start;
                }
                2 => {
                    chars.drain(start..end);
                    *cursor = start;
                }
                _ => {
                    chars.drain(*cursor..end);
                }
            }
        }
        ConsoleAction::EraseDisplay(2) => {
            chars.clear();
            *cursor = 0;
        }
        ConsoleAction::EraseDisplay(1) => {
            chars.drain(0..*cursor);
            *cursor = 0;
        }
        ConsoleAction::EraseDisplay(_) => {
            chars.drain(*cursor..);
        }
    }
}

fn trim_log(log: &mut String, cursor: &mut usize) {
    if log.len() <= LOG_BYTES {
        return;
    }
    let mut start = log.len() - LOG_BYTES;
    while !log.is_char_boundary(start) {
        start += 1;
    }
    let removed = log[..start].chars().count();
    log.drain(..start);
    *cursor = cursor.saturating_sub(removed);
}

/// Installers rewrite one line with ANSI color and cursor controls. The log
/// view is plain text, so those sequences are applied instead of shown.
fn push_console(log: &mut String, cursor: &mut usize, pending: &mut String, bytes: &[u8]) {
    pending.push_str(&String::from_utf8_lossy(bytes));
    let input = std::mem::take(pending);
    let mut chars: Vec<char> = log.chars().collect();
    if *cursor > chars.len() {
        *cursor = chars.len();
    }
    let stream: Vec<char> = input.chars().collect();
    let mut index = 0;
    while index < stream.len() {
        if stream[index] == '\u{1b}' {
            match escape_action(&stream[index..]) {
                Some((len, action)) => {
                    apply_action(&mut chars, cursor, action);
                    index += len;
                }
                None => {
                    *pending = stream[index..].iter().collect();
                    break;
                }
            }
            continue;
        }
        let ch = stream[index];
        index += 1;
        match ch {
            '\n' => put_char(&mut chars, cursor, '\n'),
            '\r' => {
                if index < stream.len() && stream[index] == '\n' {
                    index += 1;
                    *cursor = line_end(&chars, *cursor);
                    put_char(&mut chars, cursor, '\n');
                } else {
                    *cursor = line_start(&chars, *cursor);
                }
            }
            '\u{8}' => {
                let start = line_start(&chars, *cursor);
                if *cursor > start {
                    *cursor -= 1;
                }
            }
            other if other.is_control() && other != '\t' => {}
            other => put_char(&mut chars, cursor, other),
        }
    }
    *log = chars.into_iter().collect();
    trim_log(log, cursor);
}

fn append(log: &mut String, bytes: &[u8]) {
    let mut cursor = log.chars().count();
    let mut pending = String::new();
    push_console(log, &mut cursor, &mut pending, bytes);
}

// Decode each pipe separately before merging stdout/stderr. Reads can split a
// UTF-8 character; only an invalid sequence or an incomplete EOF is replaced.
fn decode_output(pending: &mut Vec<u8>, bytes: &[u8], eof: bool) -> String {
    pending.extend_from_slice(bytes);
    let mut output = String::new();
    let mut offset = 0;
    while offset < pending.len() {
        match std::str::from_utf8(&pending[offset..]) {
            Ok(text) => { output.push_str(text); offset = pending.len(); }
            Err(error) => {
                let valid = offset + error.valid_up_to();
                output.push_str(std::str::from_utf8(&pending[offset..valid]).unwrap());
                offset = valid;
                match error.error_len() {
                    Some(len) => { output.push('\u{fffd}'); offset += len; }
                    None if eof => { output.push('\u{fffd}'); offset = pending.len(); }
                    None => break,
                }
            }
        }
    }
    pending.drain(..offset);
    output
}

fn run(mut command: Command, cancelled: &AtomicBool, timeout: Duration, progress: &dyn Fn(&str)) -> Result<String, String> {
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)] { use std::os::unix::process::CommandExt; command.process_group(0); }
    let mut child = command.spawn().map_err(|e| format!("无法启动安装进程：{e}"))?;
    let (sender, receiver) = std::sync::mpsc::sync_channel::<Vec<u8>>(16);
    let streams: Vec<Box<dyn Read + Send>> = vec![Box::new(child.stdout.take().unwrap()), Box::new(child.stderr.take().unwrap())];
    for mut stream in streams {
        let sender = sender.clone();
        std::thread::spawn(move || {
            let mut buffer = [0; 4096];
            let mut pending = Vec::new();
            loop {
                match stream.read(&mut buffer) {
                    Ok(0) | Err(_) => {
                        let tail = decode_output(&mut pending, &[], true);
                        if !tail.is_empty() { let _ = sender.send(tail.into_bytes()); }
                        break;
                    }
                    Ok(count) => {
                        let text = decode_output(&mut pending, &buffer[..count], false);
                        if !text.is_empty() && sender.send(text.into_bytes()).is_err() { break; }
                    }
                }
            }
        });
    }
    drop(sender);
    let start = Instant::now();
    let mut notified = Instant::now();
    let mut log = String::new();
    let mut cursor = 0usize;
    let mut pending = String::new();
    loop {
        if cancelled.load(Ordering::Relaxed) || start.elapsed() >= timeout {
            crate::background_process::terminate(&mut child);
            progress(&log);
            return Err(if cancelled.load(Ordering::Relaxed) { "安装已取消；可能已有部分变更，请重新检查后重试" } else { "安装超时并已停止；请检查网络或文件占用后重试" }.into());
        }
        for _ in 0..32 {
            match receiver.try_recv() { Ok(bytes) => push_console(&mut log, &mut cursor, &mut pending, &bytes), Err(_) => break }
        }
        if notified.elapsed() >= Duration::from_millis(150) {
            progress(&log); notified = Instant::now();
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                let deadline = Instant::now() + Duration::from_secs(2);
                loop {
                    match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                        Ok(bytes) => push_console(&mut log, &mut cursor, &mut pending, &bytes),
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                        Err(_) => { crate::background_process::terminate(&mut child); progress(&log); return Err("安装输出未结束，请检查残留进程后重试".into()); }
                    }
                }
                progress(&log);
                return if status.success() { Ok(log) } else { Err(format!("安装进程失败（退出码 {}），请查看安装日志；修复网络、权限或文件占用后重试", status.code().unwrap_or(-1))) };
            }
            Err(error) => { crate::background_process::terminate(&mut child); progress(&log); return Err(format!("无法读取安装进程状态：{error}")); }
            Ok(None) => std::thread::sleep(Duration::from_millis(40)),
        }
    }
}

pub fn maintain(registry: &Registry, tool: &str, action: &str, source: &str, version: Option<&str>, home: &Path, progress: impl Fn(MaintenanceProgress)) -> Result<MaintenanceResult, String> {
    let source = if source == "claude_native" { "native" } else { source };
    let adapter = registry.get(tool).ok_or("此 CLI 适配器未注册")?;
    let script = script(adapter, action, source, version)?;
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut active = ACTIVE.lock().unwrap_or_else(|e| e.into_inner());
        if active.is_some() { return Err("已有安装或更新正在进行，请等待完成".into()); }
        *active = Some((tool.to_owned(), cancelled.clone()));
    }
    let _guard = ActiveGuard;
    let output = run(shell(&script, home), &cancelled, Duration::from_secs(15 * 60), &|output| {
        progress(MaintenanceProgress { tool_id: tool.to_owned(), output: output.to_owned() });
    });
    // Failures can also modify shims: never keep pre-install probe evidence.
    adapter::invalidate_probe_cache(tool);
    let output = output?;
    if action == "uninstall_npm" { return Ok(MaintenanceResult { output, version: None }); }
    let npm = script.starts_with("npm ");
    let verify = |npm: bool| adapter::verify_installation(registry, tool, home, npm, &|| cancelled.load(Ordering::Relaxed));
    // The official cross-major path may move the install between channels, so
    // it accepts whichever verified channel the upgraded CLI actually uses.
    let installation = if action == "upgrade_major" {
        verify(npm).or_else(|_| verify(!npm))?
    } else {
        verify(npm)?
    };
    Ok(MaintenanceResult { output, version: installation.version.clone() })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn utf8_output_survives_every_pipe_chunk_boundary() {
        let text = "安装失败（403）\r\n重试 🛠";
        for split in 0..=text.len() {
            let mut pending = Vec::new();
            let mut decoded = decode_output(&mut pending, &text.as_bytes()[..split], false);
            decoded.push_str(&decode_output(&mut pending, &text.as_bytes()[split..], true));
            assert_eq!(decoded, text);
            assert!(pending.is_empty());
        }
        let mut pending = Vec::new();
        assert_eq!(decode_output(&mut pending, &[0xff, 0xe4], false), "\u{fffd}");
        assert_eq!(decode_output(&mut pending, &[], true), "\u{fffd}");
    }

    #[cfg(windows)]
    #[test]
    fn powershell_install_errors_preserve_chinese_text() {
        let temp = tempfile::tempdir().unwrap();
        let output = std::sync::Mutex::new(String::new());
        let result = run(shell("throw '安装失败，访问被拒绝（403）'", temp.path()),
            &AtomicBool::new(false), Duration::from_secs(10), &|log| *output.lock().unwrap() = log.to_owned());
        assert!(result.is_err());
        let output = output.into_inner().unwrap();
        assert!(output.contains("安装失败，访问被拒绝（403）"), "{output}");
        assert!(!output.contains('\u{fffd}'), "{output}");
    }

    #[test]
    fn background_runner_drains_both_streams_and_preserves_failure() {
        let temp = tempfile::tempdir().unwrap();
        let ok = if cfg!(windows) { "Write-Output 'installed'; [Console]::Error.WriteLine('warning')" } else { "echo installed; echo warning >&2" };
        let log = run(shell(ok, temp.path()), &AtomicBool::new(false), Duration::from_secs(10), &|_| {}).unwrap();
        assert!(log.contains("installed") && log.contains("warning"));
        let failed = run(shell("exit 17", temp.path()), &AtomicBool::new(false), Duration::from_secs(10), &|_| {});
        assert!(failed.unwrap_err().contains("17"));
    }
    #[test]
    fn bounded_logs_and_timeout() {
        let mut log = "界".repeat(LOG_BYTES);
        append(&mut log, b"tail");
        assert!(log.len() <= LOG_BYTES && log.ends_with("tail"));
        let temp = tempfile::tempdir().unwrap();
        let script = if cfg!(windows) { "Start-Sleep -Seconds 30" } else { "sleep 30" };
        let started = Instant::now();
        assert!(run(shell(script, temp.path()), &AtomicBool::new(false), Duration::from_millis(150), &|_| {}).unwrap_err().contains("超时"));
        assert!(started.elapsed() < Duration::from_secs(20));
    }
    #[test]
    fn install_log_applies_ansi_redraws_instead_of_showing_them() {
        let sample = "\u{1b}[0m\u{1b}[34m•\u{1b}[39m Using method: npm\n\u{1b}[35m•\u{1b}[39m Installing OpenCode 2\u{1b}[999D\u{1b}[J\u{1b}[35m•\u{1b}[39m Installing OpenCode\n";
        let mut log = String::new();
        append(&mut log, sample.as_bytes());
        assert!(!log.contains('\u{1b}'));
        assert!(log.contains("Using method: npm"));
        assert!(log.contains("• Installing OpenCode\n"));
        assert!(!log.contains("Installing OpenCode 2"));
        let mut overwritten = String::new();
        append(&mut overwritten, "hello\rbye\u{1b}[K\n".as_bytes());
        assert_eq!(overwritten, "bye\n");
    }

    #[test]
    fn install_line_selection_controls_update_uninstall_and_major_upgrade_scripts() {
        let opencode = &crate::adapters::OPENCODE;
        let upgrade_v2 = script(opencode, "upgrade", "npm_shim", Some("2.0.29")).unwrap();
        assert!(upgrade_v2.contains("@opencode/cli@latest"), "{upgrade_v2}");
        let upgrade_v1 = script(opencode, "upgrade", "npm_shim", Some("1.19.0")).unwrap();
        assert!(upgrade_v1.contains("opencode-ai@latest"), "{upgrade_v1}");
        assert_eq!(
            script(opencode, "uninstall_npm", "npm_shim", Some("2.0.29")).unwrap(),
            "npm uninstall -g @opencode/cli"
        );
        assert_eq!(
            script(opencode, "upgrade_major", "npm_shim", Some("1.19.0")).unwrap(),
            "opencode upgrade --major"
        );
        // Unknown versions or sources never produce a line-specific command.
        assert!(script(opencode, "upgrade", "npm_shim", None).is_err());
        assert!(script(opencode, "uninstall_npm", "npm_shim", None).is_err());
        assert!(script(opencode, "upgrade_major", "unknown", Some("1.19.0")).is_err());
        assert!(script(opencode, "upgrade_major", "npm_shim", Some("1.18.34")).is_err());
        // A legacy single-line adapter keeps its exact command policy.
        let pi = &crate::adapters::PI;
        assert_eq!(
            script(pi, "upgrade", "npm_shim", None).unwrap(),
            pi.npm_install_command().unwrap()
        );
    }

    #[test]
    fn running_install_can_be_cancelled_and_retried() {
        let temp = tempfile::tempdir().unwrap();
        let cancelled = AtomicBool::new(false);
        let script = if cfg!(windows) { "Write-Output 'ready'; Start-Sleep -Seconds 30" } else { "echo ready; sleep 30" };
        let started = Instant::now();
        let result = run(shell(script, temp.path()), &cancelled, Duration::from_secs(10), &|output| {
            if output.contains("ready") { cancelled.store(true, Ordering::Relaxed); }
        });
        assert!(result.unwrap_err().contains("取消"));
        assert!(started.elapsed() < Duration::from_secs(15));
        cancelled.store(false, Ordering::Relaxed);
        assert!(run(shell("echo retried", temp.path()), &cancelled, Duration::from_secs(10), &|_| {}).unwrap().contains("retried"));
    }

    #[test]
    #[ignore = "isolated npm integration; installs only a synthetic local package into a temporary prefix"]
    fn npm_optional_dependencies_and_postinstall_survive_user_omit_settings() {
        use std::io::Write;
        let temp = tempfile::tempdir().unwrap();
        let package = temp.path().join("package");
        let optional = temp.path().join("optional");
        let prefix = temp.path().join("prefix");
        std::fs::create_dir_all(package.join("bin")).unwrap();
        std::fs::create_dir_all(&optional).unwrap();
        std::fs::create_dir_all(&prefix).unwrap();
        std::fs::write(optional.join("package.json"), r#"{"name":"cliora-fixture-native","version":"1.0.0"}"#).unwrap();
        std::fs::write(package.join("package.json"), serde_json::json!({
            "name": "cliora-install-fixture", "version": "1.0.0",
            "bin": {"cliora-fixture": "bin/cli.cjs"},
            "scripts": {"postinstall": "node setup.cjs"},
            "optionalDependencies": {"cliora-fixture-native": format!("file:{}", optional.display())}
        }).to_string()).unwrap();
        std::fs::write(package.join("bin/cli.cjs"), "#!/usr/bin/env node\nthrow new Error('postinstall did not run');\n").unwrap();
        std::fs::write(package.join("setup.cjs"), "require.resolve('cliora-fixture-native/package.json'); require('fs').writeFileSync('bin/cli.cjs', '#!/usr/bin/env node\\nconsole.log(\\\"fixture-ready\\\");\\n');").unwrap();
        let cancelled = AtomicBool::new(false);
        run(shell("npm pack --ignore-scripts --no-audit --no-fund", &package), &cancelled, Duration::from_secs(30), &|_| {}).unwrap();
        // Serve the fixture over loopback: npm's strict policy matches remote
        // tarballs by exact URL, without local-file resolution differences.
        let archive = std::fs::read(package.join("cliora-install-fixture-1.0.0.tgz")).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let target = format!("http://{}/fixture.tgz", listener.local_addr().unwrap());
        struct Server(Arc<AtomicBool>, Option<std::thread::JoinHandle<()>>);
        impl Drop for Server {
            fn drop(&mut self) { self.0.store(true, Ordering::Relaxed); let _ = self.1.take().unwrap().join(); }
        }
        let stopped = Arc::new(AtomicBool::new(false));
        let flag = stopped.clone();
        let _server = Server(stopped, Some(std::thread::spawn(move || {
            while !flag.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
                        let _ = stream.set_write_timeout(Some(Duration::from_secs(1)));
                        let _ = stream.read(&mut [0; 4096]);
                        let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", archive.len());
                        let _ = stream.write_all(&archive);
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(20)),
                }
            }
        })));
        // Exercise the actual adapter policy, changing only the package target.
        let quote = |path: &Path| format!("'{}'", path.display().to_string().replace('\'', if cfg!(windows) { "''" } else { "'\\''" }));
        let script = crate::adapters::CODEX.npm_install_command().unwrap().replace("@openai/codex@latest", &target).replace("--allow-scripts=@openai/codex", &format!("--allow-scripts={target}"));
        let mut command = shell(&format!("{script} --prefix {}", quote(&prefix)), temp.path());
        command.env("npm_config_ignore_scripts", "true").env("npm_config_omit", "optional").env("npm_config_strict_allow_scripts", "true");
        run(command, &cancelled, Duration::from_secs(60), &|log| eprintln!("{log}")).unwrap();
        let bin = prefix.join(if cfg!(windows) { "cliora-fixture.cmd" } else { "bin/cliora-fixture" });
        assert!(bin.is_file(), "npm did not link the installed command");
        let check = format!("{}{}", if cfg!(windows) { "& " } else { "" }, quote(&bin));
        let log = run(shell(&check, temp.path()), &cancelled, Duration::from_secs(10), &|_| {}).unwrap();
        assert!(log.contains("fixture-ready"), "{log}");
    }
}
