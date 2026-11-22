//! Fixed execution entries for controlled secret use.
//!
//! A registration stores one executable, an argument vector, an optional working
//! directory, the channel that carries the value (one named environment variable
//! or stdin) and a digest of the definition's content: the absolute executable and
//! every argument that names a script file. Nothing here accepts a shell
//! command line or performs substitution: the process is started with `Command`
//! directly, so the value never reaches argv, a persistent script or the global
//! environment.
use crate::database::Database;
use crate::prompts::timestamp;
use crate::secrets::audit;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// A registered script may take a moment; the budget bounds a hung child so the
/// calling CLI fails instead of waiting forever.
pub const RUN_TIMEOUT: Duration = Duration::from_secs(30);
/// Each stream is bounded before it is handed back to the caller.
pub const MAX_STREAM_BYTES: usize = 64 * 1024;
/// Script content is part of the definition, so a large file is refused rather
/// than silently excluded from the digest.
const MAX_SCRIPT_BYTES: u64 = 4 * 1024 * 1024;
/// An absolute executable is hashed by content, and a compiled binary is part of
/// the execution definition like any script. Its budget is larger than the
/// argument-script budget so ordinary binaries are hashed instead of refused;
/// anything bigger is refused rather than silently excluded from the digest.
pub(crate) const MAX_EXECUTABLE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_EXECUTABLE: usize = 1024;
const MAX_ARG: usize = 4096;
const MAX_ARGS: usize = 64;
const MAX_LABEL: usize = 80;
const MAX_DESCRIPTION: usize = 400;
const REDACTED: &str = "[redacted]";

/// How the value reaches the child. Both channels keep it out of argv.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Channel {
    Env,
    Stdin,
}

impl Channel {
    fn as_str(self) -> &'static str {
        match self {
            Self::Env => "env",
            Self::Stdin => "stdin",
        }
    }

    fn parse(text: &str) -> Result<Self, String> {
        match text {
            "env" => Ok(Self::Env),
            "stdin" => Ok(Self::Stdin),
            _ => Err("秘密传递通道无效".into()),
        }
    }
}

/// A stored execution entry. It contains no value: only the definition and its
/// content digest cross this boundary.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretExecutor {
    pub id: String,
    pub label: String,
    pub description: String,
    pub executable: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub channel: Channel,
    pub env_name: Option<String>,
    pub digest: String,
    pub created_at: u64,
    pub updated_at: u64,
}

/// User input for a new entry. Editing an existing entry would silently widen a
/// grant, so the contract is create-or-delete only.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewExecutor {
    pub label: String,
    #[serde(default)]
    pub description: String,
    pub executable: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub channel: Channel,
    pub env_name: Option<String>,
}

/// A failure the caller may audit. The message is diagnostic text and never
/// contains the value.
#[derive(Clone, Debug)]
pub struct RunFailure {
    pub code: &'static str,
    pub message: String,
}

impl RunFailure {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub elapsed_ms: u64,
}

fn sql(error: rusqlite::Error) -> String {
    error.to_string()
}

fn text_field(name: &str, value: &str, max: usize, allow_empty: bool) -> Result<String, String> {
    let value = value.trim();
    if (!allow_empty && value.is_empty()) || value.chars().count() > max || value.chars().any(char::is_control) {
        return Err(format!("执行入口的{name}无效"));
    }
    Ok(value.to_owned())
}

fn validate_arg(arg: &str) -> Result<(), String> {
    if arg.len() > MAX_ARG || arg.contains('\0') || arg.contains('\n') || arg.contains('\r') {
        return Err("执行入口参数包含不允许的字符".into());
    }
    Ok(())
}

fn validate_executable(executable: &str) -> Result<(), String> {
    let path = Path::new(executable);
    if executable.len() > MAX_EXECUTABLE
        || executable.contains('\0')
        || executable.chars().any(char::is_control)
        || (!path.is_absolute() && executable.contains(char::is_whitespace))
    {
        return Err("执行入口程序无效".into());
    }
    if !path.is_absolute() && executable.contains(['/', '\\']) {
        return Err("执行入口程序需为绝对路径，或不含目录的命令名".into());
    }
    Ok(())
}

fn validate_env_name(name: &str) -> Result<(), String> {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return Err("环境变量名不能为空".into());
    };
    if name.len() > 128
        || !(first.is_ascii_alphabetic() || first == '_')
        || !chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return Err("环境变量名只能包含字母、数字和下划线，且不能以数字开头".into());
    }
    Ok(())
}

fn script_files(args: &[String], cwd: Option<&str>) -> Result<Vec<PathBuf>, String> {
    let base = cwd.map(PathBuf::from);
    let mut files = Vec::new();
    for candidate in args {
        let path = match (&base, Path::new(candidate).is_absolute()) {
            (Some(dir), false) => dir.join(candidate),
            _ => PathBuf::from(candidate),
        };
        // Only arguments that name an existing regular file are content-checked;
        // flags and literal values stay part of the definition string.
        if let Ok(metadata) = std::fs::metadata(&path) {
            if metadata.is_file() {
                if metadata.len() > MAX_SCRIPT_BYTES {
                    return Err("执行入口脚本超过 4 MiB，未登记".into());
                }
                files.push(path);
            }
        }
    }
    Ok(files)
}

/// The executable file whose content belongs to the definition. An absolute path
/// that names a regular file is hashed by content, because replacing that file
/// replaces the code the value reaches. A bare command name is resolved through
/// `PATH` at run time, so it stays part of the definition string only.
fn executable_file(executable: &str) -> Result<Option<PathBuf>, String> {
    let path = Path::new(executable);
    if !path.is_absolute() {
        return Ok(None);
    }
    let metadata = std::fs::metadata(path).map_err(|_| "无法读取执行入口程序内容".to_string())?;
    if !metadata.is_file() {
        return Err("执行入口程序不是常规文件，无法读取内容".into());
    }
    if metadata.len() > MAX_EXECUTABLE_BYTES {
        return Err("执行入口程序超过 64 MiB，未登记".into());
    }
    Ok(Some(path.to_path_buf()))
}

fn hash_file(hasher: &mut Sha256, path: &Path, limit: u64, message: &str) -> Result<(), String> {
    let file = std::fs::File::open(path).map_err(|_| message.to_owned())?;
    let metadata = file.metadata().map_err(|_| message.to_owned())?;
    let size = metadata.len();
    if !metadata.is_file() || size > limit {
        return Err(message.to_owned());
    }
    hasher.update(size.to_le_bytes());
    let mut reader = file.take(size + 1);
    let mut buffer = [0; 32 * 1024];
    let mut total = 0;
    loop {
        let count = reader.read(&mut buffer).map_err(|_| message.to_owned())?;
        if count == 0 {
            break;
        }
        total += count as u64;
        hasher.update(&buffer[..count]);
    }
    if total != size {
        return Err(message.to_owned());
    }
    Ok(())
}

/// Digest of the whole definition: the executable string, the argument vector,
/// the working directory, the content of an absolute executable and the content
/// of every argument that points at a script file. Recomputing it before a run is
/// what makes an edited script invalidate the grant. A bare command name stays a
/// string-only part of the definition because its file is chosen by `PATH`.
fn digest_of(executable: &str, args: &[String], cwd: Option<&str>) -> Result<String, String> {
    let mut hasher = Sha256::new();
    hasher.update(b"cliora-secret-executor-v1\0");
    hasher.update(executable.as_bytes());
    hasher.update([0]);
    for arg in args {
        hasher.update(arg.as_bytes());
        hasher.update([0]);
    }
    hasher.update(cwd.unwrap_or_default().as_bytes());
    hasher.update([0]);
    for file in script_files(args, cwd)? {
        hasher.update(b"script\0");
        hasher.update(file.as_os_str().to_string_lossy().as_bytes());
        hasher.update([0]);
        hash_file(&mut hasher, &file, MAX_SCRIPT_BYTES, "无法读取执行入口脚本内容")?;
    }
    // The executable's own content is hashed last, under its own domain marker and
    // length, so it can never be confused with an argument script.
    if let Some(file) = executable_file(executable)? {
        hasher.update(b"executable\0");
        hasher.update(file.as_os_str().to_string_lossy().as_bytes());
        hasher.update([0]);
        hash_file(&mut hasher, &file, MAX_EXECUTABLE_BYTES, "无法读取执行入口程序内容")?;
    }
    Ok(hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect())
}

fn row_from(row: &rusqlite::Row<'_>) -> rusqlite::Result<SecretExecutor> {
    let args_json: String = row.get(4)?;
    let channel: String = row.get(6)?;
    Ok(SecretExecutor {
        id: row.get(0)?,
        label: row.get(1)?,
        description: row.get(2)?,
        executable: row.get(3)?,
        args: serde_json::from_str(&args_json).unwrap_or_default(),
        cwd: row.get(5)?,
        channel: Channel::parse(&channel).unwrap_or(Channel::Stdin),
        env_name: row.get(7)?,
        digest: row.get(8)?,
        created_at: row.get::<_, i64>(9)?.max(0) as u64,
        updated_at: row.get::<_, i64>(10)?.max(0) as u64,
    })
}

const COLUMNS: &str = "id,label,description,executable,args_json,cwd,channel,env_name,digest,created_at,updated_at";

/// Probe the same inherited PATH used by a bare executor without starting the program.
pub fn preset_available(name: &str) -> bool {
    let Some(paths) = std::env::var_os("PATH") else { return false };
    let filename = format!("{name}{}", std::env::consts::EXE_SUFFIX);
    std::env::split_paths(&paths).filter(|dir| dir.is_absolute()).any(|dir| {
        let Ok(meta) = dir.join(&filename).metadata() else { return false };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            meta.is_file() && meta.permissions().mode() & 0o111 != 0
        }
        #[cfg(not(unix))]
        { meta.is_file() }
    })
}

/// Registers a fixpoint of the execution definition. A duplicate label is
/// refused instead of replacing an entry that existing grants point at.
pub fn register(db: &Database, input: NewExecutor) -> Result<SecretExecutor, String> {
    let label = text_field("别名", &input.label, MAX_LABEL, false)?;
    let description = text_field("说明", &input.description, MAX_DESCRIPTION, true)?;
    let executable = input.executable.trim().to_owned();
    validate_executable(&executable)?;
    if input.args.len() > MAX_ARGS {
        return Err("执行入口参数过多".into());
    }
    for arg in &input.args {
        validate_arg(arg)?;
    }
    let cwd = match input.cwd.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        Some(dir) if Path::new(dir).is_absolute() => Some(dir.to_owned()),
        Some(_) => return Err("执行入口工作目录需为绝对路径".into()),
        None => None,
    };
    let env_name = match (input.channel, input.env_name.as_deref().map(str::trim)) {
        (Channel::Env, Some(name)) if !name.is_empty() => {
            validate_env_name(name)?;
            Some(name.to_owned())
        }
        (Channel::Env, _) => return Err("通过环境变量传递时必须填写变量名".into()),
        (Channel::Stdin, Some(name)) if !name.is_empty() => {
            return Err("通过标准输入传递时不能指定环境变量名".into())
        }
        (Channel::Stdin, _) => None,
    };
    let digest = digest_of(&executable, &input.args, cwd.as_deref())?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = timestamp() as i64;
    let args_json = serde_json::to_string(&input.args).map_err(|_| "执行入口参数无法保存".to_string())?;
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO secret_executors(id,label,description,executable,args_json,cwd,channel,env_name,digest,created_at,updated_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10)",
            params![id, label, description, executable, args_json, cwd, input.channel.as_str(), env_name, digest, now],
        )
        .map_err(|error| {
            if error.to_string().contains("UNIQUE constraint failed: secret_executors.label") {
                "已存在同名执行入口".to_string()
            } else {
                error.to_string()
            }
        })
    })?;
    load(db, &id)
}

pub fn list(db: &Database) -> Result<Vec<SecretExecutor>, String> {
    db.with_read_connection(|conn| {
        let mut statement = conn
            .prepare(&format!("SELECT {COLUMNS} FROM secret_executors ORDER BY label COLLATE NOCASE, id"))
            .map_err(sql)?;
        let rows = statement.query_map([], row_from).map_err(sql)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(sql)
    })
}

/// Removing an entry also removes every grant that used it, so a later entry
/// with the same label never inherits the old authorization.
pub fn remove(db: &Database, id: &str) -> Result<(), String> {
    let changed = db.with_connection(|conn| {
        conn.execute("DELETE FROM secret_executors WHERE id=?1", [id])
            .map_err(sql)
    })?;
    if changed != 1 {
        return Err("执行入口已不存在".into());
    }
    Ok(())
}

pub(crate) fn load(db: &Database, id: &str) -> Result<SecretExecutor, String> {
    db.with_read_connection(|conn| {
        conn.query_row(&format!("SELECT {COLUMNS} FROM secret_executors WHERE id=?1"), [id], row_from)
            .optional()
            .map_err(sql)
    })?
    .ok_or_else(|| "执行入口已不存在".to_string())
}

/// Killing and reaping on every exit path is what keeps a cancelled or timed
/// out run from leaving a child behind.
struct ChildGuard(Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn read_stream(mut stream: impl Read + Send + 'static) -> std::sync::mpsc::Receiver<(Vec<u8>, bool)> {
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut truncated = false;
        let mut buffer = [0u8; 8192];
        loop {
            match stream.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    let remaining = MAX_STREAM_BYTES.saturating_sub(bytes.len());
                    bytes.extend_from_slice(&buffer[..read.min(remaining)]);
                    if read > remaining {
                        truncated = true;
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = sender.send((bytes, truncated));
    });
    receiver
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).chars().take(MAX_STREAM_BYTES).collect()
}

/// Replaces every literal occurrence of the value before any text leaves the
/// broker. Text masking is a boundary, not a general leak defence (R9).
pub fn redact(text: &str, value: &str) -> String {
    if value.is_empty() || !text.contains(value) {
        return text.to_owned();
    }
    text.replace(value, REDACTED)
}

/// Runs one registered entry with the value on the chosen channel.
pub fn run(executor: &SecretExecutor, value: &str, cancel: &AtomicBool) -> Result<Outcome, RunFailure> {
    run_with_timeout(executor, value, cancel, RUN_TIMEOUT)
}

/// The budget is a parameter so a test can prove the timeout path without a
/// thirty second wait; production always uses `RUN_TIMEOUT`.
pub fn run_with_timeout(
    executor: &SecretExecutor,
    value: &str,
    cancel: &AtomicBool,
    budget: Duration,
) -> Result<Outcome, RunFailure> {
    let started = Instant::now();
    let digest = executor
        .current_digest()
        .map_err(|error| RunFailure::new(audit::code::SCRIPT_CHANGED, error))?;
    if digest != executor.digest {
        return Err(RunFailure::new(
            audit::code::SCRIPT_CHANGED,
            "执行入口脚本已变更，未执行；请重新登记执行入口",
        ));
    }
    let mut command = Command::new(&executor.executable);
    command.args(&executor.args);
    if let Some(dir) = &executor.cwd {
        command.current_dir(dir);
    }
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(if executor.channel == Channel::Stdin { Stdio::piped() } else { Stdio::null() });
    if executor.channel == Channel::Env {
        if let Some(name) = &executor.env_name {
            command.env(name, value);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = ChildGuard(command.spawn().map_err(|error| {
        RunFailure::new(audit::code::SPAWN_FAILED, format!("执行入口无法启动：{error}"))
    })?);
    if executor.channel == Channel::Stdin {
        if let Some(mut stdin) = child.0.stdin.take() {
            if stdin.write_all(value.as_bytes()).is_err() {
                return Err(RunFailure::new(audit::code::SPAWN_FAILED, "无法向执行入口写入秘密"));
            }
            // Closing stdin signals end-of-input; the value is never buffered.
        }
    }
    let stdout = child.0.stdout.take().map(read_stream);
    let stderr = child.0.stderr.take().map(read_stream);
    let collect = |receiver: Option<std::sync::mpsc::Receiver<(Vec<u8>, bool)>>| -> (String, bool) {
        match receiver.and_then(|receiver| receiver.recv_timeout(budget).ok()) {
            Some((bytes, truncated)) => (text(&bytes), truncated),
            None => (String::new(), false),
        }
    };
    let deadline = started + budget;
    let status = loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(RunFailure::new(audit::code::CANCELLED, "秘密使用已取消"));
        }
        if Instant::now() >= deadline {
            return Err(RunFailure::new(audit::code::TIMEOUT, "执行入口运行超时，已终止"));
        }
        match child.0.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => std::thread::sleep(Duration::from_millis(5)),
            Err(_) => return Err(RunFailure::new(audit::code::SPAWN_FAILED, "无法确认执行入口状态")),
        }
    };
    let (stdout, stdout_truncated) = collect(stdout);
    let (stderr, stderr_truncated) = collect(stderr);
    if stdout_truncated || stderr_truncated {
        return Err(RunFailure::new(audit::code::OUTPUT_LIMIT, "执行入口输出超过上限，已丢弃"));
    }
    Ok(Outcome {
        exit_code: status.code(),
        stdout: redact(&stdout, value),
        stderr: redact(&stderr, value),
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

impl SecretExecutor {
    /// Recomputes the digest from the current definition and files.
    pub fn current_digest(&self) -> Result<String, String> {
        digest_of(&self.executable, &self.args, self.cwd.as_deref())
    }
}
