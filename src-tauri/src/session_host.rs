use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use base64::Engine;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::adapters::LaunchMode;
use crate::launch::{LaunchPlan, LaunchResult, TerminalId};

const REPLAY_LIMIT: usize = 256 * 1024;
const OUTPUT_EVENT: &str = "cliora:session-output";
const EXIT_EVENT: &str = "cliora:session-exit";

static APP: OnceLock<AppHandle> = OnceLock::new();
static SESSIONS: LazyLock<Mutex<HashMap<String, Arc<Session>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

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
    let (program, args) = hosted_command(&plan);
    let mut command = CommandBuilder::new(program);
    command.cwd(&plan.directory);
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
    let session = Arc::new(Session {
        id: uuid::Uuid::new_v4().to_string(),
        tool_id: plan.tool_id.clone(),
        project_id: plan.project_id.clone(),
        directory: plan.directory.display().to_string(),
        mode: plan.mode,
        running: AtomicBool::new(true),
        exit_code: Mutex::new(None),
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
        replay: Mutex::new(VecDeque::new()),
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

fn hosted_command(plan: &LaunchPlan) -> (std::path::PathBuf, Vec<String>) {
    let script = plan.executable.extension().and_then(|ext| ext.to_str()).is_some_and(|ext| ext.eq_ignore_ascii_case("ps1"));
    #[cfg(windows)]
    if script {
        let mut args = vec!["-NoProfile".into(), "-ExecutionPolicy".into(), "Bypass".into(), "-File".into(), plan.executable.display().to_string()];
        args.extend(plan.cli_args.iter().cloned());
        return (std::path::PathBuf::from("powershell.exe"), args);
    }
    #[cfg(not(windows))]
    let _ = script;
    (plan.executable.clone(), plan.cli_args.clone())
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
    sessions().values().map(|session| session.snapshot()).collect()
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
    session.running.store(false, Ordering::SeqCst);
}

fn read_output(session: Arc<Session>, mut reader: Box<dyn Read + Send>) {
    let mut buffer = [0_u8; 8192];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
            Ok(size) => {
                remember(&session, &buffer[..size]);
                emit_output(&session.id, &buffer[..size]);
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

fn remember(session: &Session, bytes: &[u8]) {
    let Ok(mut replay) = session.replay.lock() else {
        return;
    };
    replay.extend(bytes);
    let overflow = replay.len().saturating_sub(REPLAY_LIMIT);
    if overflow > 0 {
        replay.drain(..overflow);
    }
}

fn emit_output(id: &str, bytes: &[u8]) {
    emit(OUTPUT_EVENT, SessionBytes {
        session_id: id.to_owned(),
        data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
    });
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
    if std::env::var("TERM").as_deref() == Ok("dumb") {
        command.env_remove("TERM");
    }
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
        }
    }
}

#[cfg(test)]
pub(crate) fn wait_for_replay(id: &str, marker: &str) -> Result<(), String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
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
        thread::sleep(Duration::from_millis(50));
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
        return Ok((program, vec!["/d".into(), "/q".into(), "/k".into()]));
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
