//! Parent owns lifecycle; the child is the same executable before Tauri initialization.
use super::{
    runtime::{self, BoundSecret, HelperInput, RuntimeReport, MAX_IPC_BYTES, WALL_BUDGET},
    *,
};
use crate::{credentials::CredentialStore, database::Database};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

pub const HELPER_ARGUMENT: &str = "--cliora-internal-usage-v1";
const MAX_ACTIVE: usize = 4;
const MAX_ENTRIES: usize = 20;

pub fn helper_entry() -> bool {
    if std::env::args_os().nth(1).as_deref() != Some(std::ffi::OsStr::new(HELPER_ARGUMENT)) {
        return false;
    }
    let start = Instant::now();
    let mut bytes = Vec::new();
    let report = if std::io::stdin()
        .take((MAX_IPC_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() > MAX_IPC_BYTES
    {
        RuntimeReport::failure(ipc_error(), start)
    } else {
        match serde_json::from_slice::<HelperInput>(&bytes) {
            Ok(input) => std::thread::Builder::new()
                .name("usage-vm".into())
                .stack_size(4 * 1024 * 1024)
                .spawn(move || runtime::execute(input))
                .ok()
                .and_then(|thread| thread.join().ok())
                .unwrap_or_else(|| RuntimeReport::failure(ipc_error(), start)),
            Err(_) => RuntimeReport::failure(ipc_error(), start),
        }
    };
    if let Ok(bytes) = serde_json::to_vec(&report) {
        if bytes.len() <= MAX_IPC_BYTES {
            let _ = std::io::stdout().write_all(&bytes);
        }
    }
    true
}
fn ipc_error() -> UsageError {
    UsageError::new(
        UsageErrorCode::Parse,
        UsageStage::Ipc,
        "查询 helper 通信失败",
    )
}
fn cancelled() -> UsageError {
    UsageError::new(
        UsageErrorCode::Cancelled,
        UsageStage::Script,
        "查询已取消，结果已失效",
    )
}
fn timeout() -> UsageError {
    UsageError::new(UsageErrorCode::Timeout, UsageStage::Script, "查询墙钟超时")
}
fn capacity() -> UsageError {
    UsageError::new(
        UsageErrorCode::ResourceLimit,
        UsageStage::Launch,
        "查询队列已满",
    )
}
struct Entry {
    cancelled: Arc<AtomicBool>,
    created: Instant,
    started: bool,
}
#[derive(Default)]
struct Registry {
    entries: HashMap<String, Entry>,
    active: usize,
}
static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
fn registry() -> &'static Mutex<Registry> {
    REGISTRY.get_or_init(Mutex::default)
}

/// Reserve before invoking asynchronous work, allowing cancellation even before spawn.
pub fn create_test_execution() -> Result<String, UsageError> {
    let mut state = registry().lock().map_err(|_| capacity())?;
    state
        .entries
        .retain(|_, e| e.started || e.created.elapsed() < WALL_BUDGET);
    if state.entries.len() >= MAX_ENTRIES {
        return Err(capacity());
    }
    let id = uuid::Uuid::new_v4().to_string();
    state.entries.insert(
        id.clone(),
        Entry {
            cancelled: Arc::new(AtomicBool::new(false)),
            created: Instant::now(),
            started: false,
        },
    );
    Ok(id)
}
pub fn cancel_test_execution(id: &str) -> Result<(), UsageError> {
    let mut state = registry().lock().map_err(|_| capacity())?;
    if let Some(entry) = state.entries.get(id) {
        entry.cancelled.store(true, Ordering::SeqCst);
        if !entry.started { state.entries.remove(id); }
    }
    Ok(())
}
struct ExecutionGuard {
    id: String,
    active: bool,
}
impl Drop for ExecutionGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = registry().lock() {
            state.entries.remove(&self.id);
            if self.active {
                state.active -= 1;
            }
        }
    }
}
fn claim(id: &str) -> Result<(ExecutionGuard, Arc<AtomicBool>, Instant), UsageError> {
    let mut state = registry().lock().map_err(|_| capacity())?;
    let entry = state.entries.get_mut(id).ok_or_else(cancelled)?;
    if entry.started {
        return Err(UsageError::configuration("此测试执行已被消费"));
    }
    entry.started = true;
    Ok((
        ExecutionGuard {
            id: id.into(),
            active: false,
        },
        entry.cancelled.clone(),
        entry.created,
    ))
}
fn acquire(
    guard: &mut ExecutionGuard,
    cancel: &AtomicBool,
    start: Instant,
) -> Result<(), UsageError> {
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(cancelled());
        }
        if start.elapsed() >= WALL_BUDGET {
            return Err(timeout());
        }
        {
            let mut state = registry().lock().map_err(|_| capacity())?;
            if state.active < MAX_ACTIVE {
                state.active += 1;
                guard.active = true;
                return Ok(());
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

pub(super) fn resolve_draft(
    db: &Database,
    credentials: &dyn CredentialStore,
    draft: &UsageQueryDraft,
) -> Result<HelperInput, UsageError> {
    super::store::validate_draft(draft)?;
    let old = draft.id.as_ref().map(|id| get_query(db, id)).transpose()?;
    if old.as_ref().map(|q| q.version) != draft.expected_version {
        return Err(UsageError::new(
            UsageErrorCode::VersionConflict,
            UsageStage::Configuration,
            "测试草稿的保存版本已变更",
        ));
    }
    // Reject every invalid Keep before reading any secret, matching save's preflight.
    for credential in &draft.credentials {
        if matches!(credential.value, CredentialUpdate::Keep) {
            super::store::retained_binding(old.as_ref(), credential)?;
        }
    }
    let mut secrets = Vec::new();
    for credential in &draft.credentials {
        let value = match &credential.value {
            CredentialUpdate::Replace { secret } => secret.clone(),
            CredentialUpdate::Keep => {
                let binding = super::store::retained_binding(old.as_ref(), credential)?;
                credentials.get(&binding.secret_ref).map_err(|_| {
                    UsageError::new(
                        UsageErrorCode::Credential,
                        UsageStage::Credential,
                        "无法读取查询绑定凭据",
                    )
                })?
            }
        };
        if value.is_empty() || value.len() > 16_384 {
            return Err(UsageError::configuration("查询凭据格式无效"));
        }
        secrets.push(BoundSecret {
            name: credential.name.clone(),
            allowed_origins: credential.allowed_origins.clone(),
            value,
        });
    }
    Ok(HelperInput {
        config: draft.config.clone(),
        secrets,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftTestReport {
    pub execution: UsageExecution,
    #[serde(flatten)]
    pub runtime: RuntimeReport,
}
pub fn test_draft(
    db: &Database,
    credentials: &dyn CredentialStore,
    execution_id: String,
    draft_revision: u32,
    draft: UsageQueryDraft,
) -> Result<DraftTestReport, UsageError> {
    let (mut guard, cancel, start) = claim(&execution_id)?;
    let outcome = (|| {
        if cancel.load(Ordering::SeqCst) {
            return Err(cancelled());
        }
        let input = resolve_draft(db, credentials, &draft)?;
        acquire(&mut guard, &cancel, start)?;
        let executable = std::env::current_exe().map_err(|_| {
            UsageError::new(
                UsageErrorCode::Script,
                UsageStage::Launch,
                "无法定位同包 helper",
            )
        })?;
        run_child(&executable, input, &cancel, start)
    })();
    let mut report = outcome.unwrap_or_else(|e| RuntimeReport::failure(e, start));
    // Recheck at publication; a cancelled execution must never publish success.
    if cancel.load(Ordering::SeqCst) {
        report = RuntimeReport::failure(cancelled(), start);
    }
    report.elapsed_ms = start.elapsed().as_millis() as u64;
    Ok(DraftTestReport {
        execution: UsageExecution::Draft {
            execution_id,
            draft_revision,
        },
        runtime: report,
    })
}

struct ChildGuard(Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
pub(super) fn run_child(
    executable: &std::path::Path,
    input: HelperInput,
    cancel: &AtomicBool,
    start: Instant,
) -> Result<RuntimeReport, UsageError> {
    let bytes = serde_json::to_vec(&input).map_err(|_| ipc_error())?;
    if bytes.len() > MAX_IPC_BYTES {
        return Err(UsageError::configuration("查询 IPC 输入超过预算"));
    }
    let mut command = Command::new(executable);
    command
        .arg(HELPER_ARGUMENT)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        if let Some(root) = std::env::var_os("SystemRoot") {
            command.env("SystemRoot", root);
        }
    }
    let mut child = ChildGuard(command.spawn().map_err(|_| {
        UsageError::new(
            UsageErrorCode::Script,
            UsageStage::Launch,
            "查询 helper 启动失败",
        )
    })?);
    let mut stdin = child.0.stdin.take().ok_or_else(ipc_error)?;
    let stdout = child.0.stdout.take().ok_or_else(ipc_error)?;
    let writer = std::thread::spawn(move || stdin.write_all(&bytes));
    let (tx, rx) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let read = stdout
            .take((MAX_IPC_BYTES + 1) as u64)
            .read_to_end(&mut bytes);
        let _ = tx.send((read.is_ok(), bytes));
    });
    let result = (|| {
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err(cancelled());
            }
            if start.elapsed() >= WALL_BUDGET {
                return Err(timeout());
            }
            if let Ok((ok, bytes)) = rx.try_recv() {
                if !ok || bytes.len() > MAX_IPC_BYTES {
                    return Err(ipc_error());
                }
                // Reader EOF is not enough: reap the child before publishing.
                loop {
                    if cancel.load(Ordering::SeqCst) {
                        return Err(cancelled());
                    }
                    if start.elapsed() >= WALL_BUDGET {
                        return Err(timeout());
                    }
                    if let Some(status) = child.0.try_wait().map_err(|_| ipc_error())? {
                        if !status.success() {
                            return Err(ipc_error());
                        }
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
                let mut value: serde_json::Value =
                    serde_json::from_slice(&bytes).map_err(|_| ipc_error())?;
                runtime::redact_value(&mut value, &input.secrets);
                let report: RuntimeReport =
                    serde_json::from_value(value).map_err(|_| ipc_error())?;
                if let Some(result) = &report.result {
                    result.validate()?;
                }
                if report.result.is_some() == report.error.is_some() {
                    return Err(ipc_error());
                }
                return Ok(report);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    })();
    drop(child); // kill + wait also releases blocked pipe readers/writers
    let _ = writer.join();
    let _ = reader.join();
    result
}

#[cfg(test)]
#[path = "../../../tests/usage/helper.rs"]
mod tests;

#[cfg(test)]
pub(super) static REGISTRY_TEST_LOCK: Mutex<()> = Mutex::new(());
