use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, LazyLock, Mutex, OnceLock, mpsc};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::adapters::LaunchMode;
use crate::launch::{LaunchPlan, LaunchResult, TerminalId};

const REPLAY_LIMIT: usize = 256 * 1024;
/// PTY reads arrive as thousands of small chunks; one IPC event per read floods the
/// bridge with JSON and base64. Aggregate bursts for a few milliseconds instead.
const OUTPUT_FLUSH_WINDOW: Duration = Duration::from_millis(8);
const OUTPUT_FLUSH_BYTES: usize = 64 * 1024;
const OUTPUT_EVENT: &str = "cliora:session-output";
const EXIT_EVENT: &str = "cliora:session-exit";

static APP: OnceLock<AppHandle> = OnceLock::new();
static SESSIONS: LazyLock<Mutex<HashMap<String, Arc<Session>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// `TerminateProcess` only reaches the direct child, but npm shims run `cmd.exe` →
/// `node.exe` and CLIs spawn MCP servers of their own. Ending a session must tear
/// down the whole tree, so the child is assigned to a kill-on-close job object.
#[cfg(windows)]
mod process_tree {
    use std::os::raw::c_void;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        SetInformationJobObject,
    };

    pub struct Job(HANDLE);

    // Ownership is exclusive; a job handle may be closed from any thread.
    unsafe impl Send for Job {}

    impl Job {
        pub fn assign(child: HANDLE) -> Option<Job> {
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return None;
                }
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let configured = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                let assigned = AssignProcessToJobObject(job, child);
                if configured == 0 || assigned == 0 {
                    CloseHandle(job);
                    return None;
                }
                Some(Job(job))
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub id: String,
    pub tool_id: String,
    pub project_id: Option<String>,
    pub directory: String,
    pub mode: LaunchMode,
    pub running: bool,
    pub exit_code: Option<i32>,
    pub started_at: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionBytes {
    session_id: String,
    data_base64: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionExit {
    session_id: String,
    exit_code: Option<i32>,
}

struct Session {
    id: String,
    sequence: u64,
    started_at: u64,
    tool_id: String,
    project_id: Option<String>,
    directory: String,
    mode: LaunchMode,
    running: AtomicBool,
    exit_code: Mutex<Option<i32>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    replay: Mutex<VecDeque<u8>>,
    #[cfg(windows)]
    job: Mutex<Option<process_tree::Job>>,
}

pub fn install(app: AppHandle) {
    let _ = APP.set(app);
}

pub fn start(plan: LaunchPlan, credential: Option<&(String, String)>) -> Result<LaunchResult, String> {
    if !plan.executable.is_file() {
        return Err("CLI 可执行文件不存在，请在工具页重新检测".into());
    }
    if !plan.directory.is_dir() {
        return Err("工作目录不存在".into());
    }
    let size = PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 };
    let pair = native_pty_system().openpty(size).map_err(|error| format!("无法创建会话终端：{error}"))?;
    // Canonical Windows paths carry the `\\?\` prefix. cmd.exe (npm `.cmd` shims) rejects
    // such a working directory and silently falls back to C:\Windows.
    let directory = crate::launch::terminal_path(&plan.directory)?;
    let (program, args) = hosted_command(&plan)?;
    let mut command = CommandBuilder::new(program);
    command.cwd(&directory);
    command.args(args);
    apply_environment(&mut command, &plan, credential);
    let mut child = pair.slave.spawn_command(command).map_err(|error| format!("无法在工作台启动 CLI：{error}"))?;
    let reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(error) => {
            let _ = child.kill();
            return Err(format!("无法读取会话输出：{error}"));
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(error) => {
            let _ = child.kill();
            return Err(format!("无法写入会话：{error}"));
        }
    };
    let started_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    #[cfg(windows)]
    let job = child.as_raw_handle().and_then(process_tree::Job::assign);
    let session = Arc::new(Session {
        id: uuid::Uuid::new_v4().to_string(),
        sequence: NEXT_SEQUENCE.fetch_add(1, Ordering::SeqCst),
        started_at,
        tool_id: plan.tool_id.clone(),
        project_id: plan.project_id.clone(),
        directory,
        mode: plan.mode,
        running: AtomicBool::new(true),
        exit_code: Mutex::new(None),
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
        replay: Mutex::new(VecDeque::new()),
        #[cfg(windows)]
        job: Mutex::new(job),
    });
    let id = session.id.clone();
    if let Err(error) = attach_reader(Arc::clone(&session), reader) {
        end_child(&session);
        return Err(error);
    }
    sessions().insert(id.clone(), session);
    Ok(LaunchResult {
        tool_id: plan.tool_id,
        project_id: plan.project_id,
        mode: plan.mode,
        terminal: TerminalId::Workbench,
        status: "session_started",
        session_id: Some(id),
    })
}

fn hosted_command(plan: &LaunchPlan) -> Result<(std::path::PathBuf, Vec<String>), String> {
    let executable = crate::launch::terminal_path(&plan.executable)?;
    let script = plan.executable.extension().and_then(|ext| ext.to_str()).is_some_and(|ext| ext.eq_ignore_ascii_case("ps1"));
    #[cfg(windows)]
    if script {
        let mut args = vec!["-NoProfile".into(), "-ExecutionPolicy".into(), "Bypass".into(), "-File".into(), executable];
        args.extend(plan.cli_args.iter().cloned());
        return Ok((std::path::PathBuf::from("powershell.exe"), args));
    }
    #[cfg(not(windows))]
    let _ = script;
    Ok((std::path::PathBuf::from(executable), plan.cli_args.clone()))
}

fn attach_reader(session: Arc<Session>, reader: Box<dyn Read + Send>) -> Result<(), String> {
    #[cfg(test)]
    if REJECT_READER_THREAD.load(Ordering::SeqCst) {
        return Err("无法接收会话输出：测试拒绝创建读取线程".into());
    }
    let name = format!("cliora-session-{}", session.id);
    thread::Builder::new()
        .name(name)
        .spawn(move || read_output(session, reader))
        .map_err(|error| format!("无法接收会话输出：{error}"))?;
    Ok(())
}

pub fn list() -> Vec<SessionSnapshot> {
    let mut items: Vec<_> = sessions().values().cloned().collect();
    items.sort_by_key(|session| session.sequence);
    items.into_iter().map(|session| session.snapshot()).collect()
}

pub fn replay(id: &str) -> Result<String, String> {
    let session = lookup(id)?;
    let bytes: Vec<u8> = session.replay.lock().map_err(|_| "会话状态不可用")?.iter().copied().collect();
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

pub fn write(id: &str, data_base64: &str) -> Result<(), String> {
    let bytes = decode_input(data_base64)?;
    let session = lookup(id)?;
    if !session.running.load(Ordering::SeqCst) {
        return Err("会话已经结束".into());
    }
    let mut writer = session.writer.lock().map_err(|_| "会话状态不可用")?;
    writer.write_all(&bytes).map_err(|error| format!("无法写入会话：{error}"))?;
    writer.flush().map_err(|error| format!("无法写入会话：{error}"))?;
    Ok(())
}

pub fn resize(id: &str, cols: u16, rows: u16) -> Result<(), String> {
    if !(1..=500).contains(&cols) || !(1..=500).contains(&rows) {
        return Err("会话尺寸无效".into());
    }
    let session = lookup(id)?;
    if !session.running.load(Ordering::SeqCst) {
        return Err("会话已经结束".into());
    }
    let master = session.master.lock().map_err(|_| "会话状态不可用")?;
    master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|error| format!("无法调整会话尺寸：{error}"))
}

pub fn close(id: &str) -> Result<(), String> {
    let session = sessions().remove(id).ok_or("会话不存在")?;
    end_child(&session);
    Ok(())
}

pub fn shutdown() {
    let taken: Vec<_> = sessions().drain().map(|(_, session)| session).collect();
    for session in taken {
        end_child(&session);
    }
}

fn sessions() -> std::sync::MutexGuard<'static, HashMap<String, Arc<Session>>> {
    SESSIONS.lock().unwrap_or_else(|error| error.into_inner())
}

fn lookup(id: &str) -> Result<Arc<Session>, String> {
    sessions().get(id).cloned().ok_or_else(|| "会话不存在".into())
}

fn end_child(session: &Session) {
    if let Ok(mut child) = session.child.lock() {
        let _ = child.kill();
    }
    // Closing the job handle terminates whatever the process tree still runs.
    #[cfg(windows)]
    if let Ok(mut job) = session.job.lock() {
        *job = None;
    }
    session.running.store(false, Ordering::SeqCst);
}

static OUTPUT_CHANNEL: LazyLock<Sender<(String, Vec<u8>)>> = LazyLock::new(|| {
    let (sender, receiver) = mpsc::channel();
    let _ = thread::Builder::new()
        .name("cliora-session-output".into())
        .spawn(move || coalesce_output(receiver));
    sender
});

fn forward_output(id: &str, bytes: &[u8]) {
    let _ = OUTPUT_CHANNEL.send((id.to_owned(), bytes.to_vec()));
}

fn coalesce_output(receiver: Receiver<(String, Vec<u8>)>) {
    let mut pending: HashMap<String, Vec<u8>> = HashMap::new();
    while let Some((id, bytes)) = receiver.recv().ok() {
        pending.entry(id).or_default().extend_from_slice(&bytes);
        while pending.values().map(Vec::len).sum::<usize>() < OUTPUT_FLUSH_BYTES {
            match receiver.recv_timeout(OUTPUT_FLUSH_WINDOW) {
                Ok((id, bytes)) => { pending.entry(id).or_default().extend_from_slice(&bytes); }
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        for (id, bytes) in pending.drain() {
            flush_output(&id, &bytes);
        }
    }
}

fn flush_output(id: &str, bytes: &[u8]) {
    let Ok(session) = lookup(id) else { return };
    {
        let Ok(mut replay) = session.replay.lock() else { return };
        replay.extend(bytes);
        let overflow = replay.len().saturating_sub(REPLAY_LIMIT);
        if overflow > 0 {
            replay.drain(..overflow);
        }
    }
    emit(OUTPUT_EVENT, SessionBytes {
        session_id: id.to_owned(),
        data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
    });
}

fn read_output(session: Arc<Session>, mut reader: Box<dyn Read + Send>) {
    let mut buffer = [0_u8; 8192];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
            Ok(size) => {
                forward_output(&session.id, &buffer[..size]);
            }
        }
    }
    let code = session.child.lock().ok().and_then(|mut child| child.wait().ok()).map(|status| status.exit_code() as i32);
    session.running.store(false, Ordering::SeqCst);
    if let Ok(mut exit_code) = session.exit_code.lock() {
        *exit_code = code;
    }
    emit_exit(&session.id, code);
}

fn emit_exit(id: &str, exit_code: Option<i32>) {
    emit(EXIT_EVENT, SessionExit { session_id: id.to_owned(), exit_code });
}

fn emit<T: Serialize + Clone>(event: &str, payload: T) {
    if let Some(app) = APP.get() {
        let _ = app.emit(event, payload);
    }
}

fn decode_input(data_base64: &str) -> Result<Vec<u8>, String> {
    if data_base64.len() > 1_400_000 {
        return Err("输入过长".into());
    }
    base64::engine::general_purpose::STANDARD.decode(data_base64).map_err(|_| "输入格式无法识别".into())
}

fn apply_environment(command: &mut CommandBuilder, plan: &LaunchPlan, credential: Option<&(String, String)>) {
    if let Some(path) = crate::process_environment::path() {
        command.env("PATH", path);
    }
    command.env_remove("NO_COLOR");
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "Cliora");
    if matches!(std::env::var("FORCE_COLOR").as_deref(), Ok("0") | Ok("false")) {
        command.env_remove("FORCE_COLOR");
    }
    for name in plan.session_markers {
        command.env_remove(*name);
    }
    if let Some((_, context)) = &plan.account_context {
        for key in &context.remove_environment {
            command.env_remove(key);
        }
        for (key, value) in &context.environment {
            command.env(key, value);
        }
    }
    if let Some((name, value)) = credential {
        command.env(name, value);
    }
}

impl Session {
    fn snapshot(&self) -> SessionSnapshot {
        SessionSnapshot {
            id: self.id.clone(),
            tool_id: self.tool_id.clone(),
            project_id: self.project_id.clone(),
            directory: self.directory.clone(),
            mode: self.mode,
            running: self.running.load(Ordering::SeqCst),
            exit_code: self.exit_code.lock().ok().and_then(|code| *code),
            started_at: self.started_at,
        }
    }
}

#[cfg(test)]
pub(crate) fn wait_for_replay(id: &str, marker: &str) -> Result<(), String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
    let mut answered = 0;
    while std::time::Instant::now() < deadline {
        if let Ok(encoded) = replay(id) {
            if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(encoded) {
                let text = String::from_utf8_lossy(&bytes);
                if text.contains(marker) {
                    return Ok(());
                }
                // A real terminal view answers cursor queries. The test host has no view yet.
                let queries = text.matches("[6n").count();
                while answered < queries && answered < 8 {
                    let _ = write(id, &base64::engine::general_purpose::STANDARD.encode("\u{1b}[1;1R".as_bytes()));
                    answered += 1;
                }
            }
        }
        thread::sleep(std::time::Duration::from_millis(50));
    }
    let seen = replay(id).ok().and_then(|encoded| base64::engine::general_purpose::STANDARD.decode(encoded).ok()).unwrap_or_default();
    Err(format!("会话没有返回预期输出：{}", String::from_utf8_lossy(&seen)))
}

#[cfg(test)]
pub(crate) fn shell_executable() -> Result<(std::path::PathBuf, Vec<String>), String> {
    #[cfg(windows)]
    {
        let program = std::env::var_os("ComSpec").map(std::path::PathBuf::from).unwrap_or_else(|| std::path::PathBuf::from(r"C:\Windows\System32\cmd.exe"));
        if !program.is_file() {
            return Err("找不到命令提示符".into());
        }
        Ok((program, vec!["/d".into(), "/q".into(), "/k".into()]))
    }
    #[cfg(not(windows))]
    {
        let program = std::path::PathBuf::from("/bin/sh");
        if !program.is_file() {
            return Err("找不到 shell".into());
        }
        Ok((program, vec!["-i".into()]))
    }
}

#[cfg(test)]
static REJECT_READER_THREAD: AtomicBool = AtomicBool::new(false);

#[cfg(test)]
pub(crate) fn reject_reader_thread(reject: bool) {
    REJECT_READER_THREAD.store(reject, Ordering::SeqCst);
}

#[cfg(test)]
pub(crate) fn lock_for_tests() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|error| error.into_inner())
}

#[cfg(all(test, windows))]
fn process_name_running(name: &str) -> bool {
    std::process::Command::new("tasklist")
        .args(["/FI", &format!("IMAGENAME eq {name}")])
        .output()
        .is_ok_and(|output| String::from_utf8_lossy(&output.stdout).to_lowercase().contains(&name.to_lowercase()))
}

#[cfg(all(test, windows))]
fn replay_text(id: &str) -> String {
    replay(id)
        .ok()
        .and_then(|encoded| base64::engine::general_purpose::STANDARD.decode(encoded).ok())
        .map(|bytes| String::from_utf8_lossy(&bytes).to_string())
        .unwrap_or_default()
}

/// `start /b` leaves a grandchild attached to the pty while the shim child exits;
/// ending the session must terminate that grandchild too (kill-on-close job object).
#[cfg(all(test, windows))]
#[test]
fn ending_a_session_terminates_the_process_tree() {
    let _guard = lock_for_tests();
    let (program, _) = shell_executable().expect("shell available");
    let plan = LaunchPlan {
        account_version: None,
        account_context: None,
        tool_id: "cliora-test".into(),
        project_id: None,
        mode: LaunchMode::Normal,
        executable: program,
        cli_args: vec![
            "/d".into(),
            "/q".into(),
            "/c".into(),
            "start /b ping -n 45 127.0.0.1".into(),
        ],
        directory: std::env::temp_dir(),
        terminal: TerminalId::Workbench,
        session_markers: &[],
        credential: None,
    };
    let result = start(plan, None).expect("session started");
    let id = result.session_id.expect("session id");
    // Parallel test suites load the machine heavily; process startup needs headroom.
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    let mut answered = 0;
    while !process_name_running("PING.EXE") {
        assert!(
            std::time::Instant::now() < deadline,
            "grandchild never started; replay: {:?}",
            replay_text(&id)
        );
        // A real terminal view answers cursor queries; the test host has none,
        // and cmd's startup stalls until the position report arrives.
        let queries = replay_text(&id).matches("[6n").count();
        while answered < queries && answered < 8 {
            let _ = write(&id, &base64::engine::general_purpose::STANDARD.encode("\u{1b}[1;1R".as_bytes()));
            answered += 1;
        }
        thread::sleep(Duration::from_millis(250));
    }
    close(&id).expect("session closed");
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while process_name_running("PING.EXE") {
        assert!(
            std::time::Instant::now() < deadline,
            "ending the session left the grandchild process alive"
        );
        thread::sleep(Duration::from_millis(250));
    }
}
