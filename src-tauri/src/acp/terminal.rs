//! The ACP terminal capability: commands an agent runs through the client.
//!
//! A command never goes through a shell: the program is resolved on the
//! planned PATH and started directly, with the agent's own environment (the
//! same isolation its launch received, its broker session included) plus the
//! variables the agent passed. A Windows batch file is the one exception and
//! runs through the command interpreter exactly like an ACP entry does.
//!
//! Every command is a process tree the host can end: on Windows the child is
//! created suspended, placed in a kill-on-close job object and only then
//! resumed; on Unix it leads its own process group. Killing, releasing or
//! closing the session ends the whole tree. Standard output and standard error
//! are merged into one bounded buffer that drops its oldest text once it
//! exceeds the agent's byte limit, always on a character boundary.

use std::collections::VecDeque;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::mpsc::channel;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use super::access::AccessKind;
use super::{guard, AcpUpdate, Session};

/// Live terminals one session may hold at a time.
pub const MAX_TERMINALS: usize = 16;
/// Output kept when the agent names no limit.
pub const DEFAULT_OUTPUT_BYTES: usize = 1024 * 1024;
/// The host's own ceiling on any terminal's output.
pub const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
/// Released terminals whose output stays visible in the conversation.
const MAX_RELEASED: usize = 32;
/// Retained characters of a command line or working directory.
const MAX_LABEL_CHARS: usize = 2_000;
/// How long the exit report waits for the output pipes to drain after the
/// process itself exited (a descendant may still hold them).
const DRAIN_WAIT: Duration = Duration::from_secs(2);

/// How a terminal's command ended.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpTerminalExit {
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
}

/// One terminal as the conversation shows it. The output is the bounded tail
/// the agent can also read.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpTerminal {
    pub terminal_id: String,
    /// The command line, for display.
    pub command: String,
    pub cwd: String,
    pub output: String,
    /// Older output was dropped to stay within the byte limit.
    pub truncated: bool,
    /// None while the command runs.
    pub exit_status: Option<AcpTerminalExit>,
    /// The agent released the terminal (or the session ended); its id no
    /// longer answers terminal requests, but its output stays visible.
    pub released: bool,
    pub subagent: Option<String>,
}

/// The handle that ends a terminal's process tree.
struct Tree {
    #[cfg(windows)]
    job: std::sync::Mutex<Option<crate::session_host::process_tree::Job>>,
    #[cfg(unix)]
    pid: u32,
}

impl Tree {
    /// End every process of the tree. Returns once the tree is gone (Windows
    /// waits for the job to drain) or the signal was delivered (Unix).
    fn kill(&self) {
        #[cfg(windows)]
        if let Some(job) = guard(&self.job).as_ref() {
            let _ = job.terminate_and_wait();
        }
        #[cfg(unix)]
        let _ = crate::background_process::kill_process_group(self.pid);
    }

    /// End the tree for good. The job handle itself closes when the last
    /// reference goes, and kill-on-close ends anything that started since.
    fn close(&self) {
        self.kill();
    }

    #[cfg(test)]
    fn alive(&self) -> bool {
        #[cfg(windows)]
        {
            guard(&self.job).as_ref().and_then(|job| job.active_processes()).unwrap_or(0) > 0
        }
        #[cfg(unix)]
        {
            crate::background_process::command("/bin/kill")
                .args(["-0", "--", &format!("-{}", self.pid)])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|status| status.success())
        }
    }
}

struct Entry {
    state: AcpTerminal,
    limit: usize,
    tree: Option<Arc<Tree>>,
}

/// Every terminal of one session.
#[derive(Default)]
pub(crate) struct Terminals {
    entries: VecDeque<Entry>,
    next: u64,
}

impl Terminals {
    pub fn states(&self) -> Vec<AcpTerminal> {
        self.entries.iter().map(|entry| entry.state.clone()).collect()
    }

    fn get_mut(&mut self, id: &str) -> Option<&mut Entry> {
        self.entries.iter_mut().find(|entry| entry.state.terminal_id == id)
    }

    fn live(&self) -> usize {
        self.entries.iter().filter(|entry| !entry.state.released).count()
    }

    /// Drop the oldest released terminals past the retention bound.
    fn prune(&mut self) {
        while self.entries.iter().filter(|entry| entry.state.released).count() > MAX_RELEASED {
            let Some(index) = self.entries.iter().position(|entry| entry.state.released) else { break };
            self.entries.remove(index);
        }
    }
}

/// Append text to a bounded output. Returns the UTF-16 code units dropped from
/// the head of (previous output + text), which is exactly what a view holding
/// the previous output must drop after appending the same text.
fn append_bounded(output: &mut String, text: &str, limit: usize) -> usize {
    output.push_str(text);
    if output.len() <= limit {
        return 0;
    }
    let mut cut = output.len() - limit;
    while !output.is_char_boundary(cut) {
        cut += 1;
    }
    let dropped = output[..cut].encode_utf16().count();
    output.drain(..cut);
    dropped
}

/// Decode a byte stream incrementally: an incomplete trailing sequence waits
/// for the next read, invalid bytes become U+FFFD.
struct Utf8Stream {
    carry: Vec<u8>,
}

impl Utf8Stream {
    fn push(&mut self, bytes: &[u8]) -> String {
        self.carry.extend_from_slice(bytes);
        let mut text = String::new();
        loop {
            match std::str::from_utf8(&self.carry) {
                Ok(valid) => {
                    text.push_str(valid);
                    self.carry.clear();
                    return text;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    text.push_str(std::str::from_utf8(&self.carry[..valid]).unwrap_or_default());
                    match error.error_len() {
                        Some(length) => {
                            text.push('\u{FFFD}');
                            self.carry.drain(..valid + length);
                        }
                        None => {
                            self.carry.drain(..valid);
                            return text;
                        }
                    }
                }
            }
        }
    }

    fn finish(&mut self) -> String {
        let rest = String::from_utf8_lossy(&self.carry).into_owned();
        self.carry.clear();
        rest
    }
}

fn label(text: &str) -> String {
    super::timeline::cap(text, MAX_LABEL_CHARS).0
}

/// A display form of a command line: each part quoted when it needs to be.
fn command_line(command: &str, args: &[String]) -> String {
    std::iter::once(command)
        .chain(args.iter().map(String::as_str))
        .map(|part| {
            if part.is_empty() || part.chars().any(|c| c.is_whitespace() || c == '"') {
                format!("\"{}\"", part.replace('"', "\\\""))
            } else {
                part.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Resolve the program a terminal runs: an absolute path as given, a relative
/// path against the working directory, a bare name on the planned PATH.
fn resolve_program(command: &str, cwd: &Path) -> Result<PathBuf, String> {
    if command.trim().is_empty() || command.chars().any(char::is_control) {
        return Err("命令为空或包含无效字符".into());
    }
    let path = Path::new(command);
    let candidates: Vec<PathBuf> = if path.is_absolute() {
        vec![path.to_path_buf()]
    } else if path.components().count() > 1 {
        vec![cwd.join(path)]
    } else {
        crate::process_environment::directories().into_iter().map(|directory| directory.join(command)).collect()
    };
    for candidate in candidates {
        #[cfg(windows)]
        {
            let has_extension = candidate.extension().is_some_and(|extension| {
                crate::process_environment::windows_spawn_suffixes()
                    .iter()
                    .any(|suffix| suffix.trim_start_matches('.').eq_ignore_ascii_case(&extension.to_string_lossy()))
            });
            if has_extension && candidate.is_file() {
                return Ok(candidate);
            }
            for suffix in crate::process_environment::windows_spawn_suffixes() {
                let mut name = candidate.clone().into_os_string();
                name.push(suffix);
                let with_suffix = PathBuf::from(name);
                if with_suffix.is_file() {
                    return Ok(with_suffix);
                }
            }
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if candidate.metadata().is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0) {
                return Ok(candidate);
            }
        }
    }
    Err(format!("找不到要运行的程序：{command}（不经过 shell，请给出程序名或完整路径）"))
}

/// The process a terminal (or an ACP entry) starts. A Windows batch file runs
/// through the command interpreter with its arguments kept literal; anything
/// else is the program itself.
pub(crate) fn program_command(program: &Path, args: &[String]) -> std::process::Command {
    if crate::adapters::acp_needs_command_interpreter(program) {
        let line = format!(
            "\"{}\" {}",
            program.display(),
            args.iter()
                .map(|arg| format!("\"{}\"", arg.replace('"', "\"\"")))
                .collect::<Vec<_>>()
                .join(" ")
        );
        let mut interpreter = crate::background_process::command(super::interpreter_program());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            interpreter.raw_arg(format!("/D /V:OFF /S /C \"{line}\""));
        }
        #[cfg(not(windows))]
        interpreter.arg(line);
        interpreter
    } else {
        let mut command = crate::background_process::command(program);
        command.args(args);
        command
    }
}

/// Start a command as its own process tree.
fn spawn_tree(
    program: &Path,
    args: &[String],
    cwd: &Path,
    environment: &super::ChildEnvironment,
    token: Option<&str>,
    extra: &[(String, String)],
) -> Result<(Child, Tree), String> {
    let mut command = program_command(program, args);
    command
        .current_dir(crate::launch::terminal_path(cwd)?)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for name in &environment.remove {
        command.env_remove(name);
    }
    for (name, value) in &environment.set {
        command.env(name, value);
    }
    for (name, value) in extra {
        command.env(name, value);
    }
    // The broker session is the agent's own; whatever the agent passed for the
    // name, the command runs under the session that owns this conversation.
    match token {
        Some(token) => {
            command.env(crate::secrets::session::ENV, token);
        }
        None => {
            command.env_remove(crate::secrets::session::ENV);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW | CREATE_SUSPENDED: nothing runs before the job
        // owns the process.
        command.creation_flags(0x0800_0000 | 0x0000_0004);
        let mut child = command.spawn().map_err(|error| format!("无法启动命令：{error}"))?;
        let job = crate::session_host::process_tree::Job::resume_child(&mut child)
            .map_err(|error| format!("无法建立命令的进程边界：{error}"))?;
        Ok((child, Tree { job: std::sync::Mutex::new(Some(job)) }))
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
        let child = command.spawn().map_err(|error| format!("无法启动命令：{error}"))?;
        let pid = child.id();
        Ok((child, Tree { pid }))
    }
}

#[cfg(unix)]
fn signal_name(status: &std::process::ExitStatus) -> Option<String> {
    use std::os::unix::process::ExitStatusExt;
    status.signal().map(|signal| match signal {
        1 => "SIGHUP".to_owned(),
        2 => "SIGINT".to_owned(),
        9 => "SIGKILL".to_owned(),
        15 => "SIGTERM".to_owned(),
        other => format!("SIG{other}"),
    })
}

fn exit_of(status: &std::process::ExitStatus) -> AcpTerminalExit {
    AcpTerminalExit {
        exit_code: status.code(),
        #[cfg(unix)]
        signal: signal_name(status),
        #[cfg(not(unix))]
        signal: None,
    }
}

fn param_str<'a>(params: &'a Value, name: &str) -> Result<&'a str, String> {
    params.get(name).and_then(Value::as_str).ok_or_else(|| format!("缺少参数 {name}"))
}

impl Session {
    /// terminal/create. Runs on a worker thread: an out-of-directory working
    /// directory may wait for the user's approval.
    pub(super) fn create_terminal(self: &Arc<Self>, subagent: Option<&str>, params: &Value) -> Result<Value, String> {
        let command = param_str(params, "command")?.to_owned();
        let args: Vec<String> = match params.get("args") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(items)) => items
                .iter()
                .map(|item| item.as_str().map(ToOwned::to_owned).ok_or("args 只能包含字符串"))
                .collect::<Result<_, _>>()?,
            Some(_) => return Err("args 必须是字符串数组".into()),
        };
        let mut extra: Vec<(String, String)> = Vec::new();
        for item in params.get("env").and_then(Value::as_array).into_iter().flatten() {
            let name = item.get("name").and_then(Value::as_str).ok_or("env 项缺少 name")?;
            let value = item.get("value").and_then(Value::as_str).unwrap_or_default();
            if name.is_empty() || name.contains('=') || name.contains('\0') || value.contains('\0') {
                return Err("env 名称或取值无效".into());
            }
            extra.push((name.to_owned(), value.to_owned()));
        }
        let limit = params
            .get("outputByteLimit")
            .and_then(Value::as_u64)
            .map(|limit| (limit as usize).min(MAX_OUTPUT_BYTES))
            .unwrap_or(DEFAULT_OUTPUT_BYTES);
        let line = command_line(&command, &args);
        let cwd = match params.get("cwd").and_then(Value::as_str).filter(|cwd| !cwd.is_empty()) {
            None => crate::safe_fs::canonical_root(&self.directory)?,
            Some(requested) => {
                let resolved = crate::safe_fs::resolve_within(&self.directory, Path::new(requested))?;
                let target = resolved.path().to_path_buf();
                if !resolved.inside() {
                    self.authorize_outside(
                        AccessKind::Execute,
                        subagent,
                        &crate::safe_fs::display(&target),
                        Some(label(&line)),
                    )?;
                    let again = crate::safe_fs::resolve_within(&self.directory, Path::new(requested))?;
                    if again.path() != target {
                        return Err("审批期间工作目录指向发生变化，已拒绝".into());
                    }
                }
                target
            }
        };
        if !cwd.is_dir() {
            return Err("工作目录不存在或不是目录".into());
        }
        // Count before the start: a refused start leaves nothing behind.
        if guard(&self.terminals).live() >= MAX_TERMINALS {
            return Err(format!("每个会话最多同时保留 {MAX_TERMINALS} 个终端，请先释放不再需要的终端"));
        }
        if guard(&self.writer).is_none() {
            return Err("会话已结束".into());
        }
        let program = resolve_program(&command, &cwd)?;
        let token = guard(&self.secret_session).as_ref().map(|session| session.token().to_owned());
        let (mut child, tree) = spawn_tree(&program, &args, &cwd, &self.terminal_environment, token.as_deref(), &extra)?;
        let tree = Arc::new(tree);
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let state = {
            let mut terminals = guard(&self.terminals);
            // The session may have ended while the command started.
            if guard(&self.writer).is_none() || terminals.live() >= MAX_TERMINALS {
                drop(terminals);
                tree.close();
                let _ = child.wait();
                return Err("会话已结束或终端数已满，命令未保留".into());
            }
            terminals.next += 1;
            let state = AcpTerminal {
                terminal_id: format!("term-{}", terminals.next),
                command: label(&line),
                cwd: label(&crate::safe_fs::display(&cwd)),
                output: String::new(),
                truncated: false,
                exit_status: None,
                released: false,
                subagent: subagent.map(ToOwned::to_owned),
            };
            terminals.entries.push_back(Entry { state: state.clone(), limit, tree: Some(Arc::clone(&tree)) });
            terminals.prune();
            // Emitted under the lock: output of this terminal can only follow it.
            self.emit_update(AcpUpdate::Terminal { terminal: state.clone() });
            state
        };
        let id = state.terminal_id.clone();
        let (done_tx, done_rx) = channel::<()>();
        for stream in [stdout.map(|s| Box::new(s) as Box<dyn Read + Send>), stderr.map(|s| Box::new(s) as Box<dyn Read + Send>)]
            .into_iter()
            .flatten()
        {
            let session = Arc::clone(self);
            let id = id.clone();
            let done = done_tx.clone();
            std::thread::spawn(move || {
                session.pump_output(&id, stream);
                let _ = done.send(());
            });
        }
        drop(done_tx);
        let session = Arc::clone(self);
        std::thread::spawn(move || {
            let status = child.wait();
            // Let the pipes drain so the exit report follows the last output;
            // a descendant that keeps them open does not hold the report back.
            let deadline = std::time::Instant::now() + DRAIN_WAIT;
            loop {
                let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                match done_rx.recv_timeout(remaining) {
                    Ok(()) => continue,
                    Err(_) => break,
                }
            }
            let exit = match status {
                Ok(status) => exit_of(&status),
                Err(_) => AcpTerminalExit { exit_code: None, signal: None },
            };
            session.terminal_exited(&id, exit);
        });
        Ok(json!({ "terminalId": state.terminal_id }))
    }

    fn pump_output(&self, id: &str, mut stream: Box<dyn Read + Send>) {
        let mut decoder = Utf8Stream { carry: Vec::new() };
        let mut buffer = [0u8; 8 * 1024];
        loop {
            match stream.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    let text = decoder.push(&buffer[..read]);
                    self.append_output(id, &text);
                }
            }
        }
        let rest = decoder.finish();
        self.append_output(id, &rest);
    }

    fn append_output(&self, id: &str, text: &str) {
        if text.is_empty() {
            return;
        }
        let mut terminals = guard(&self.terminals);
        let Some(entry) = terminals.get_mut(id) else { return };
        let limit = entry.limit;
        let dropped = append_bounded(&mut entry.state.output, text, limit);
        if dropped > 0 {
            entry.state.truncated = true;
        }
        let update = AcpUpdate::TerminalOutput {
            terminal_id: id.to_owned(),
            text: text.to_owned(),
            dropped,
            truncated: entry.state.truncated,
            exit_status: entry.state.exit_status.clone(),
            released: entry.state.released,
        };
        // Emitted under the lock, so two streams' events keep the order in
        // which their text entered the buffer.
        self.emit_update(update);
    }

    fn terminal_exited(&self, id: &str, exit: AcpTerminalExit) {
        {
            let mut terminals = guard(&self.terminals);
            let Some(entry) = terminals.get_mut(id) else { return };
            if entry.state.exit_status.is_none() {
                entry.state.exit_status = Some(exit);
            }
            let update = AcpUpdate::TerminalOutput {
                terminal_id: id.to_owned(),
                text: String::new(),
                dropped: 0,
                truncated: entry.state.truncated,
                exit_status: entry.state.exit_status.clone(),
                released: entry.state.released,
            };
            self.emit_update(update);
        }
        self.terminal_changed.notify_all();
    }

    fn live_entry<T>(&self, id: &str, read: impl FnOnce(&mut Entry) -> T) -> Result<T, String> {
        let mut terminals = guard(&self.terminals);
        let entry = terminals.get_mut(id).ok_or("终端不存在")?;
        if entry.state.released {
            return Err("终端已释放".into());
        }
        Ok(read(entry))
    }

    /// terminal/output: the retained output and, once known, the exit status.
    pub(super) fn terminal_output(&self, params: &Value) -> Result<Value, String> {
        let id = param_str(params, "terminalId")?;
        self.live_entry(id, |entry| {
            json!({
                "output": entry.state.output,
                "truncated": entry.state.truncated,
                "exitStatus": entry.state.exit_status.as_ref().map(|exit| json!({ "exitCode": exit.exit_code, "signal": exit.signal })),
            })
        })
    }

    /// terminal/wait_for_exit: blocks this worker until the command exits, the
    /// terminal is released or the session ends.
    pub(super) fn wait_for_exit(&self, params: &Value) -> Result<Value, String> {
        let id = param_str(params, "terminalId")?;
        let mut terminals = guard(&self.terminals);
        loop {
            let entry = terminals.get_mut(id).ok_or("终端不存在")?;
            if let Some(exit) = &entry.state.exit_status {
                return Ok(json!({ "exitCode": exit.exit_code, "signal": exit.signal }));
            }
            if entry.state.released {
                return Err("终端已释放".into());
            }
            terminals = self
                .terminal_changed
                .wait_timeout(terminals, Duration::from_millis(500))
                .map(|(guard, _)| guard)
                .unwrap_or_else(|error| error.into_inner().0);
        }
    }

    /// End a terminal's process tree; the terminal stays valid for output.
    pub(super) fn kill_terminal(&self, id: &str) -> Result<(), String> {
        let tree = self.live_entry(id, |entry| entry.tree.clone())?;
        if let Some(tree) = tree {
            tree.kill();
        }
        Ok(())
    }

    /// terminal/release: end the command and free the id. Its output stays
    /// for the conversation.
    pub(super) fn release_terminal(&self, id: &str) -> Result<(), String> {
        let tree = self.live_entry(id, |entry| {
            entry.state.released = true;
            entry.tree.take()
        })?;
        if let Some(tree) = tree {
            tree.close();
        }
        {
            let mut terminals = guard(&self.terminals);
            if let Some(entry) = terminals.get_mut(id) {
                let update = AcpUpdate::TerminalOutput {
                    terminal_id: id.to_owned(),
                    text: String::new(),
                    dropped: 0,
                    truncated: entry.state.truncated,
                    exit_status: entry.state.exit_status.clone(),
                    released: true,
                };
                self.emit_update(update);
            }
            terminals.prune();
        }
        self.terminal_changed.notify_all();
        Ok(())
    }

    /// End every terminal: the session is closing.
    pub(super) fn close_terminals(&self) {
        let trees: Vec<Arc<Tree>> = {
            let mut terminals = guard(&self.terminals);
            terminals
                .entries
                .iter_mut()
                .filter_map(|entry| {
                    entry.state.released = true;
                    entry.tree.take()
                })
                .collect()
        };
        for tree in trees {
            tree.close();
        }
        self.terminal_changed.notify_all();
    }

    /// Whether any process of a terminal's tree is still running. Tests use it
    /// to prove that ending a terminal or a session leaves nothing behind.
    #[cfg(test)]
    fn terminal_tree(&self, id: &str) -> Option<Arc<Tree>> {
        guard(&self.terminals).get_mut(id).and_then(|entry| entry.tree.clone())
    }
}

/// A handle to a terminal's process tree that outlives its release, for tests.
#[cfg(test)]
pub(crate) struct TreeProbe(Arc<Tree>);

#[cfg(test)]
impl TreeProbe {
    pub fn of(session: &Session, id: &str) -> Option<Self> {
        session.terminal_tree(id).map(Self)
    }

    pub fn alive(&self) -> bool {
        self.0.alive()
    }
}

#[cfg(test)]
pub(crate) fn bounded_for_tests(output: &mut String, text: &str, limit: usize) -> usize {
    append_bounded(output, text, limit)
}
