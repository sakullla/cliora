use std::ffi::OsStr;
use std::process::Command;

/// Background probes and file maintenance never create a console on Windows.
/// Interactive session terminals use the separate launch path.
pub(crate) fn command(program: impl AsRef<OsStr>) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut command = Command::new(program);
        crate::process_environment::apply(&mut command);
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        command
    }
    #[cfg(not(windows))]
    {
        let mut command = Command::new(program);
        crate::process_environment::apply(&mut command);
        command
    }
}

pub(crate) fn terminate(child: &mut std::process::Child) {
    #[cfg(windows)]
    if let Some(root) = std::env::var_os("SystemRoot") {
        let _ = command(std::path::PathBuf::from(root).join("System32/taskkill.exe"))
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status();
    }
    #[cfg(unix)]
    let _ = kill_process_group(child.id());
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(unix)]
pub(crate) fn kill_process_group(pid: u32) -> std::io::Result<std::process::ExitStatus> {
    use std::os::unix::process::CommandExt;
    if pid <= 1 || pid > i32::MAX as u32 {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid process group"));
    }
    // procps 3.x interprets an unseparated negative PID as group 0, killing
    // the caller's group. Keep the operand explicit and isolate the helper too.
    command("/bin/kill").process_group(0)
        .args(["-KILL", "--", &format!("-{pid}")])
        .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{io::{BufRead, BufReader, Read}, os::unix::process::CommandExt, process::Stdio, time::Duration};

    #[test]
    fn group_cleanup_stops_descendants_and_preserves_unrelated_processes() {
        let mut unrelated = command("/bin/sleep").arg("30").spawn().unwrap();
        let mut target = command("/bin/sh").process_group(0)
            .args(["-c", "sleep 30 & echo ready; wait"]).stdout(Stdio::piped()).spawn().unwrap();
        let output = target.stdout.take().unwrap();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(output);
            let mut line = String::new();
            let _ = ready_tx.send(reader.read_line(&mut line).map(|_| line));
            let _ = done_tx.send(reader.read_to_end(&mut Vec::new()));
        });
        let ready = ready_rx.recv_timeout(Duration::from_secs(2));
        let status = kill_process_group(target.id());
        let stopped = done_rx.recv_timeout(Duration::from_secs(2));
        let survivor = unrelated.try_wait().unwrap();
        let _ = unrelated.kill(); let _ = unrelated.wait();
        let _ = target.kill(); let _ = target.wait();
        assert_eq!(ready.unwrap().unwrap().trim(), "ready");
        assert!(status.unwrap().success());
        assert!(stopped.unwrap().is_ok(), "descendant still holds stdout open");
        assert!(survivor.is_none(), "unrelated process was stopped");
        assert!(kill_process_group(0).is_err());
        assert!(kill_process_group(1).is_err());
    }
}
