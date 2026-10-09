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

fn script(adapter: &dyn CliAdapter, action: &str, source: &str) -> Result<String, String> {
    if !matches!(source, "npm_shim" | "native" | "unknown") { return Err("未知安装来源".into()); }
    match action {
        "install" => match source {
            "npm_shim" => adapter.npm_install_command(),
            "native" => adapter.native_install_command(),
            _ => adapter.install_command(),
        },
        "install_native" => adapter.native_install_command(),
        "upgrade" => adapter.upgrade_command(source),
        "uninstall_npm" => adapter.npm_uninstall_command(),
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
            .arg(format!("$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; & {{ {script} }}; if ($null -ne $LASTEXITCODE) {{ exit $LASTEXITCODE }}"));
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


fn append(log: &mut String, bytes: &[u8]) {
    log.push_str(&String::from_utf8_lossy(bytes));
    if log.len() > LOG_BYTES {
        let mut start = log.len() - LOG_BYTES;
        while !log.is_char_boundary(start) { start += 1; }
        log.drain(..start);
    }
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
            loop {
                match stream.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => if sender.send(buffer[..count].to_vec()).is_err() { break; },
                }
            }
        });
    }
    drop(sender);
    let start = Instant::now();
    let mut notified = Instant::now();
    let mut log = String::new();
    loop {
        if cancelled.load(Ordering::Relaxed) || start.elapsed() >= timeout {
            crate::background_process::terminate(&mut child);
            progress(&log);
            return Err(if cancelled.load(Ordering::Relaxed) { "安装已取消；可能已有部分变更，请重新检查后重试" } else { "安装超时并已停止；请检查网络或文件占用后重试" }.into());
        }
        for _ in 0..32 {
            match receiver.try_recv() { Ok(bytes) => append(&mut log, &bytes), Err(_) => break }
        }
        if notified.elapsed() >= Duration::from_millis(150) {
            progress(&log); notified = Instant::now();
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                let deadline = Instant::now() + Duration::from_secs(2);
                loop {
                    match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                        Ok(bytes) => append(&mut log, &bytes),
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

pub fn maintain(registry: &Registry, tool: &str, action: &str, source: &str, home: &Path, progress: impl Fn(MaintenanceProgress)) -> Result<MaintenanceResult, String> {
    let source = if source == "claude_native" { "native" } else { source };
    let adapter = registry.get(tool).ok_or("此 CLI 适配器未注册")?;
    let script = script(adapter, action, source)?;
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
    let installation = adapter::verify_installation(registry, tool, home, script.starts_with("npm "), &|| cancelled.load(Ordering::Relaxed))?;
    Ok(MaintenanceResult { output, version: installation.version.clone() })
}

#[cfg(test)]
mod tests {
    use super::*;
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
        assert!(started.elapsed() < Duration::from_secs(10));
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
        assert!(started.elapsed() < Duration::from_secs(5));
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
