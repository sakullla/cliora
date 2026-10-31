//! Remote request ownership, one total deadline, and bounded fair admission.
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Arc, Condvar, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use super::{RemoteError, RemoteTarget};

pub const HOST_LIMIT: usize = 2;
pub const GLOBAL_LIMIT: usize = 8;
const QUEUE_LIMIT: usize = 128;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Kind { Read, Write }

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Priority { Interactive, #[default] Background }

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub request_id: String,
    pub cancel_token: String,
    pub target_id: String,
    pub target_revision: Option<i64>,
    pub kind: Kind,
    #[serde(default)]
    pub priority: Priority,
    pub deadline_unix_ms: u64,
    #[serde(default)]
    pub refresh: bool,
    #[serde(default)]
    pub expected_files: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub code: String,
    pub stage: String,
    pub reason: String,
    pub message: String,
    pub action: String,
    pub request_id: Option<String>,
    pub target_id: Option<String>,
    pub target_revision: Option<i64>,
    pub outcome: String,
    pub retryable: bool,
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt: Option<super::transactions::Receipt>,
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Existing adapter ports return String. Preserve this envelope across
        // those ports instead of flattening the stage at the IPC boundary.
        write!(f, "cliora:remote:{}", serde_json::to_string(self).unwrap_or_default())
    }
}

pub struct Context {
    request: Option<Request>,
    files: Mutex<BTreeMap<String, String>>,
    pub kind: Kind,
    priority: Priority,
    refresh_reads: bool,
    parent: Option<Arc<Context>>,
    deadline: Instant,
    cancelled: AtomicBool,
    dispatched: AtomicBool,
    accepted: AtomicBool,
    identity: Mutex<Option<String>>,
    target_id: Mutex<Option<String>>,
    destination: Mutex<Option<String>>,
    phase: Mutex<&'static str>,
    observations: Mutex<Vec<(u64, Weak<Context>)>>,
    parent_observation: Mutex<Option<u64>>,
}

thread_local! { static CURRENT: RefCell<Option<Arc<Context>>> = const { RefCell::new(None) }; }

pub fn current() -> Option<Arc<Context>> { CURRENT.with(|slot| slot.borrow().clone()) }

pub fn scoped<T>(context: Arc<Context>, operation: impl FnOnce() -> T) -> T {
    struct Restore(Option<Arc<Context>>);
    impl Drop for Restore { fn drop(&mut self) { CURRENT.with(|slot| *slot.borrow_mut() = self.0.take()); } }
    let _restore = Restore(CURRENT.with(|slot| slot.replace(Some(context))));
    operation()
}

impl Context {
    pub fn local(kind: Kind, timeout: Duration) -> Arc<Self> {
        Arc::new(Self { files: Mutex::new(BTreeMap::new()), request: None, kind, priority: Priority::Interactive, refresh_reads: false, parent: None,
            deadline: Instant::now() + timeout, cancelled: AtomicBool::new(false),
            dispatched: AtomicBool::new(false), accepted: AtomicBool::new(false), identity: Mutex::new(None), target_id: Mutex::new(None), destination: Mutex::new(None), phase: Mutex::new("worker_queue"), observations: Mutex::new(Vec::new()), parent_observation: Mutex::new(None) })
    }

    pub fn check(&self) -> Result<(), RemoteError> {
        if let Some(parent) = &self.parent {
            if let Err(error) = parent.check() {
                let reason = match &error { RemoteError::Operation(failure) => failure.reason.as_str(), _ => "cancelled" };
                return Err(self.failure(reason, "远程操作已取消或超时"));
            }
        }
        if self.cancelled.load(Ordering::Acquire) { return Err(self.failure("cancelled", "远程操作已取消")); }
        if Instant::now() >= self.deadline { return Err(self.failure("timeout", "远程连接超时（包含排队和重试）")); }
        Ok(())
    }

    pub fn accept_persistent_launch(&self) { self.accepted.store(true, Ordering::Release); }
    pub fn accepted_persistent_launch(&self) -> bool { self.accepted.load(Ordering::Acquire) }

    pub fn request_id(&self) -> Option<String> { self.request.as_ref().map(|r| r.request_id.clone()) }
    pub fn record_file(&self, path: &str, version: String) { self.files.lock().unwrap_or_else(|e| e.into_inner()).insert(path.into(), version); }
    pub fn file_versions(&self) -> BTreeMap<String, String> { self.files.lock().unwrap_or_else(|e| e.into_inner()).clone() }
    pub fn merge_files(&self, versions: BTreeMap<String, String>) { self.files.lock().unwrap_or_else(|e| e.into_inner()).extend(versions); }
    pub fn expected_files(&self) -> BTreeMap<String, String> { self.request.as_ref().map(|r| r.expected_files.clone()).unwrap_or_default() }
    pub fn refresh(&self) -> bool { self.refresh_reads }
    pub fn cancel(&self) { self.cancelled.store(true, Ordering::Release); }
    pub fn bound_target_id(&self) -> Option<String> { self.target_id.lock().unwrap_or_else(|e| e.into_inner()).clone() }
    pub fn read_child(self: &Arc<Self>, budget: Duration) -> Arc<Self> {
        let mut child = Self::local(Kind::Read, budget.min(self.remaining()));
        if let Some(context) = Arc::get_mut(&mut child) {
            context.priority = self.priority; context.refresh_reads = self.refresh(); context.parent = Some(self.clone());
        }
        let token = self.add_observation(&child);
        *child.parent_observation.lock().unwrap_or_else(|e| e.into_inner()) = Some(token);
        child
    }

    pub fn shared_read(&self) -> Arc<Self> {
        let mut context = Self::local(Kind::Read, Duration::from_secs(120));
        if let Some(shared) = Arc::get_mut(&mut context) { shared.priority = self.priority; shared.refresh_reads = self.refresh(); }
        context
    }

    fn add_observation(&self, execution: &Arc<Context>) -> u64 {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let token = NEXT.fetch_add(1, Ordering::Relaxed);
        self.observations.lock().unwrap_or_else(|e| e.into_inner()).push((token, Arc::downgrade(execution)));
        token
    }

    pub fn observe(self: &Arc<Self>, execution: &Arc<Context>) -> PhaseObservation {
        PhaseObservation { owner: self.clone(), execution: execution.clone(), token: self.add_observation(execution) }
    }

    fn finish_observation(&self, token: u64, phase: &'static str) {
        self.set_phase(phase);
        self.observations.lock().unwrap_or_else(|e| e.into_inner()).retain(|(id, _)| *id != token);
    }

    fn effective_phase(&self) -> &'static str {
        let observations: Vec<_> = self.observations.lock().unwrap_or_else(|e| e.into_inner()).iter()
            .filter_map(|(_, observed)| observed.upgrade()).collect();
        // An aggregate may have independent sources in several phases. Report
        // real active process work before queued work, never a fabricated stage.
        observations.iter().map(|context| context.effective_phase()).max_by_key(|phase| match *phase {
            "process_wait" => 4, "dispatch" => 3, "retry_wait" => 2, "queue" => 1, _ => 0,
        }).unwrap_or_else(|| *self.phase.lock().unwrap_or_else(|e| e.into_inner()))
    }

    fn request_identity(&self) -> Option<&Request> {
        self.request.as_ref().or_else(|| self.parent.as_ref().and_then(|parent| parent.request_identity()))
    }

    pub fn subscriber_error(&self, error: RemoteError) -> RemoteError {
        let mut failure = match error {
            RemoteError::Operation(failure) => failure,
            RemoteError::Storage(ref message) => match message.strip_prefix("cliora:remote:").and_then(|json| serde_json::from_str::<Failure>(json).ok()) {
                Some(failure) => failure, None => return error,
            },
            _ => return error,
        };
        let request = self.request_identity();
        failure.request_id = request.map(|request| request.request_id.clone());
        failure.target_id = request.map(|request| request.target_id.clone());
        failure.target_revision = request.and_then(|request| request.target_revision);
        RemoteError::Operation(failure)
    }

    pub fn remaining(&self) -> Duration { self.deadline.saturating_duration_since(Instant::now()) }
    pub fn dispatched(&self) { self.dispatched.store(true, Ordering::Release); self.set_phase("process_wait"); }
    pub fn set_phase(&self, phase: &'static str) { *self.phase.lock().unwrap_or_else(|e| e.into_inner()) = phase; }

    pub fn bind(&self, target: &RemoteTarget) -> Result<(), RemoteError> {
        if let Some(request) = &self.request {
            if request.target_id != target.id || request.target_revision.is_some_and(|revision| revision != target.updated_at) {
                return Err(self.failure("identity", "远程主机配置已变化，请刷新后重试"));
            }
        }
        let identity = target_identity(target);
        let mut bound = self.identity.lock().unwrap_or_else(|e| e.into_inner());
        if bound.as_ref().is_some_and(|previous| previous != &identity) {
            return Err(self.failure("identity", "远程请求不能跨主机身份执行"));
        }
        if bound.is_none() && self.kind == Kind::Write { super::read_cache::invalidate(&target.id); }
        *bound = Some(identity);
        *self.target_id.lock().unwrap_or_else(|e| e.into_inner()) = Some(target.id.clone());
        *self.destination.lock().unwrap_or_else(|e| e.into_inner()) = Some(format!("{}@{}:{}", target.user, target.host, target.port));
        self.check()
    }

    pub fn failure(&self, stage: &str, message: &str) -> RemoteError {
        let uncertain = self.kind == Kind::Write && self.dispatched.load(Ordering::Acquire)
            && matches!(stage, "connect" | "timeout" | "cancelled" | "unknown" | "cleanup");
        let action = match stage {
            _ if uncertain => "远端可能已执行；请核查目标状态，不要直接重复提交。",
            "authentication" => "检查所选主机的凭据或密钥后重试。",
            "host_key" => "通过可信渠道核实主机指纹，再更新 known_hosts。",
            "permission" => "检查远端目标目录和文件权限。",
            "directory_missing" => "检查父目录路径；请先创建已有目录下的直接子目录。",
            "directory_type" => "选择一个目录，不能使用普通文件作为父目录。",
            "directory_access" => "无法确认目录状态；检查路径、祖先目录权限及远端文件系统后再操作。",
            "dependency" => "检查远端所需命令和会话依赖。",
            "cancelled" => "需要时重新发起读取。",
            "identity" => "刷新主机配置并重新发起操作。",
            _ => "检查网络与远端状态后重试。",
        };
        RemoteError::Operation(Failure {
            code: if uncertain { "remote_unknown".into() } else { format!("remote_{stage}") },
            stage: if matches!(stage, "cancelled" | "timeout") { self.effective_phase().into() } else { stage.into() },
            reason: stage.into(), message: message.chars().take(500).collect(), action: action.into(),
            request_id: self.request_identity().map(|r| r.request_id.clone()),
            target_id: self.request_identity().map(|r| r.target_id.clone()),
            target_revision: self.request_identity().and_then(|r| r.target_revision),
            outcome: if uncertain { "unknown" } else { "failed" }.into(),
            receipt: None,
            exit_code: None,
            retryable: !uncertain && self.kind == Kind::Read && stage == "connect",
        })
    }

    pub fn failure_with_exit(&self, stage: &str, message: &str, exit_code: Option<i32>) -> RemoteError {
        let RemoteError::Operation(mut failure) = self.failure(stage, message) else { unreachable!() };
        failure.exit_code = exit_code;
        RemoteError::Operation(failure)
    }

    pub fn pause(&self, duration: Duration) -> Result<(), RemoteError> {
        self.set_phase("retry_wait");
        let end = Instant::now() + duration;
        while Instant::now() < end {
            self.check()?;
            std::thread::sleep(Duration::from_millis(10).min(end.saturating_duration_since(Instant::now())).min(self.remaining()));
        }
        self.check()
    }
}

pub struct PhaseObservation { owner: Arc<Context>, execution: Arc<Context>, token: u64 }
impl Drop for PhaseObservation {
    fn drop(&mut self) { self.owner.finish_observation(self.token, self.execution.effective_phase()); }
}
impl Drop for Context {
    fn drop(&mut self) {
        if let (Some(parent), Some(token)) = (&self.parent, *self.parent_observation.lock().unwrap_or_else(|e| e.into_inner())) {
            parent.finish_observation(token, self.effective_phase());
        }
    }
}

/// Secret-free identity suitable for cache keys. Authentication saves advance
/// updated_at, including saves made within the same wall-clock second.
pub fn target_identity(target: &RemoteTarget) -> String {
    let mut identity = target.clone();
    identity.name.clear(); // Display labels never change the connection or recovery authority.
    format!("{:x}", Sha256::digest(serde_json::to_vec(&identity).unwrap_or_default()))
}

struct Registration { owner: String, token: String, context: Arc<Context> }
struct Registry { active: HashMap<String, Registration>, cancelled: HashMap<(String, String, String), Instant> }
fn registry() -> &'static Mutex<Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(Registry { active: HashMap::new(), cancelled: HashMap::new() }))
}

pub struct Lease { id: String, pub context: Arc<Context> }
impl Drop for Lease {
    fn drop(&mut self) { registry().lock().unwrap_or_else(|e| e.into_inner()).active.remove(&self.id); }
}

pub fn register(owner: &str, request: Request, kind: Kind) -> Result<Lease, RemoteError> {
    let invalid = || Context::local(kind, Duration::from_secs(40)).failure("identity", "无效或重复的远程请求身份");
    if uuid::Uuid::parse_str(&request.request_id).is_err() || uuid::Uuid::parse_str(&request.cancel_token).is_err()
        || request.kind != kind || request.target_id.len() > 256
        || request.expected_files.len() > 512 || request.expected_files.iter().any(|(path, hash)| !super::transactions::valid_path(path) || !super::transactions::valid_hash(hash)) { return Err(invalid()); }
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
    let remaining = request.deadline_unix_ms.saturating_sub(now).min(120_000);
    let mut registry = registry().lock().unwrap_or_else(|e| e.into_inner());
    registry.cancelled.retain(|_, at| at.elapsed() < Duration::from_secs(120));
    if registry.active.contains_key(&request.request_id) || registry.active.len() >= 1024 { return Err(invalid()); }
    let cancelled = registry.cancelled.remove(&(owner.into(), request.request_id.clone(), request.cancel_token.clone())).is_some();
    let context = Arc::new(Context { files: Mutex::new(BTreeMap::new()), priority: request.priority, refresh_reads: request.refresh, parent: None, kind, deadline: Instant::now() + Duration::from_millis(remaining),
        cancelled: AtomicBool::new(cancelled), dispatched: AtomicBool::new(false), accepted: AtomicBool::new(false), identity: Mutex::new(None), target_id: Mutex::new(None), destination: Mutex::new(None), phase: Mutex::new("worker_queue"), observations: Mutex::new(Vec::new()), parent_observation: Mutex::new(None), request: Some(request.clone()) });
    registry.active.insert(request.request_id.clone(), Registration { owner: owner.into(), token: request.cancel_token, context: context.clone() });
    Ok(Lease { id: request.request_id, context })
}

pub fn cancel(owner: &str, id: &str, token: &str) -> bool {
    let mut registry = registry().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(entry) = registry.active.get(id) {
        if entry.owner != owner || entry.token != token { return false; }
        entry.context.cancelled.store(true, Ordering::Release);
        gate().ready.notify_all();
        return true;
    }
    // Cancellation can overtake the operation IPC. Bounded tombstones prevent
    // that race from starting an already abandoned process.
    registry.cancelled.retain(|_, at| at.elapsed() < Duration::from_secs(120));
    if registry.cancelled.len() < 1024 && uuid::Uuid::parse_str(id).is_ok() && uuid::Uuid::parse_str(token).is_ok() {
        registry.cancelled.insert((owner.into(), id.into(), token.into()), Instant::now());
    }
    false
}

struct Waiting { ticket: u64, destination: String, priority: Priority }
#[derive(Default)]
struct State { inflight: BTreeMap<String, usize>, background_inflight: BTreeMap<String, usize>, queue: VecDeque<Waiting>, next: u64, interactive_streak: usize, last_host: String }
pub struct Gate { state: Mutex<State>, ready: Condvar }
impl Default for Gate { fn default() -> Self { Self { state: Mutex::new(State::default()), ready: Condvar::new() } } }
fn gate() -> &'static Gate { static GATE: OnceLock<Gate> = OnceLock::new(); GATE.get_or_init(Gate::default) }

pub struct Slot<'a> { gate: &'a Gate, destination: String, background: bool }
impl Drop for Slot<'_> {
    fn drop(&mut self) {
        let mut state = self.gate.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(count) = state.inflight.get_mut(&self.destination) { *count -= 1; if *count == 0 { state.inflight.remove(&self.destination); } }
        if self.background {
            if let Some(count) = state.background_inflight.get_mut(&self.destination) {
                *count -= 1;
                if *count == 0 { state.background_inflight.remove(&self.destination); }
            }
        }
        self.gate.ready.notify_all();
    }
}

impl Gate {
    fn selected(state: &State) -> Option<u64> {
        if state.inflight.values().sum::<usize>() >= GLOBAL_LIMIT { return None; }
        let background_total = state.background_inflight.values().sum::<usize>();
        let eligible: Vec<_> = state.queue.iter().filter(|w| {
            state.inflight.get(&w.destination).copied().unwrap_or(0) < HOST_LIMIT
                // Background-only work cannot fill the final foreground slot.
                && (w.priority != Priority::Background || (background_total < GLOBAL_LIMIT - 1
                    && state.background_inflight.get(&w.destination).copied().unwrap_or(0) < HOST_LIMIT - 1))
        }).collect();
        let preferred = if state.interactive_streak >= 3 { Priority::Background } else { Priority::Interactive };
        let priority = if eligible.iter().any(|w| w.priority == preferred) { preferred } else if preferred == Priority::Interactive { Priority::Background } else { Priority::Interactive };
        // Rotate destinations while preserving FIFO order within each class.
        eligible.iter().find(|w| w.priority == priority && w.destination != state.last_host)
            .or_else(|| eligible.iter().find(|w| w.priority == priority)).map(|w| w.ticket)
    }

    pub fn acquire<'a>(&'a self, destination: &str, context: &Context) -> Result<Slot<'a>, RemoteError> {
        context.set_phase("queue");
        context.check()?;
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.queue.len() >= QUEUE_LIMIT || state.queue.iter().filter(|w| w.destination == destination).count() >= 32 {
            return Err(context.failure("queue", "远程操作队列已满，请稍后再试"));
        }
        state.next += 1;
        let ticket = state.next;
        state.queue.push_back(Waiting { ticket, destination: destination.into(), priority: context.priority });
        loop {
            if let Err(error) = context.check() {
                state.queue.retain(|w| w.ticket != ticket);
                self.ready.notify_all();
                return Err(error);
            }
            if Self::selected(&state) == Some(ticket) {
                state.queue.retain(|w| w.ticket != ticket);
                *state.inflight.entry(destination.into()).or_default() += 1;
                if context.priority == Priority::Background { *state.background_inflight.entry(destination.into()).or_default() += 1; }
                state.last_host = destination.into();
                state.interactive_streak = if context.priority == Priority::Interactive { state.interactive_streak + 1 } else { 0 };
                self.ready.notify_all();
                context.set_phase("dispatch");
                return Ok(Slot { gate: self, destination: destination.into(), background: context.priority == Priority::Background });
            }
            state = self.ready.wait_timeout(state, Duration::from_millis(20).min(context.remaining())).unwrap_or_else(|e| e.into_inner()).0;
        }
    }
}

pub fn acquire(target: &RemoteTarget, context: &Context) -> Result<Slot<'static>, RemoteError> {
    context.bind(target)?;
    gate().acquire(&format!("{}@{}:{}", target.user, target.host, target.port), context)
}

pub fn acquire_bound(context: &Context) -> Result<Option<Slot<'static>>, RemoteError> {
    let destination = context.destination.lock().unwrap_or_else(|e| e.into_inner()).clone();
    destination.map(|destination| gate().acquire(&destination, context)).transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(kind: Kind, timeout: u64) -> Request {
        Request {
            expected_files: BTreeMap::new(),
            request_id: uuid::Uuid::new_v4().to_string(), cancel_token: uuid::Uuid::new_v4().to_string(),
            target_id: "fixture".into(), target_revision: Some(7), kind, priority: Priority::Interactive, refresh: false,
            deadline_unix_ms: SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64 + timeout,
        }
    }

    #[test]
    fn early_cancel_and_ownership_are_enforced() {
        let request = request(Kind::Read, 1000);
        assert!(!cancel("owner", &request.request_id, &request.cancel_token));
        let lease = register("owner", request.clone(), Kind::Read).unwrap();
        assert!(matches!(lease.context.check(), Err(RemoteError::Operation(failure)) if failure.reason == "cancelled"));
        drop(lease);
        let request = request_for_owner();
        let lease = register("owner", request.clone(), Kind::Read).unwrap();
        assert!(!cancel("other", &request.request_id, &request.cancel_token));
        assert!(!cancel("owner", &request.request_id, &uuid::Uuid::new_v4().to_string()));
        assert!(lease.context.check().is_ok());
        assert!(register("owner", request.clone(), Kind::Read).is_err());
        assert!(cancel("owner", &request.request_id, &request.cancel_token));
        assert!(lease.context.check().is_err());
    }

    fn request_for_owner() -> Request { request(Kind::Read, 1000) }

    #[test]
    fn ipc_cannot_classify_a_write_as_a_read() {
        assert!(register("owner", request(Kind::Read, 1000), Kind::Write).is_err());
    }

    #[test]
    fn request_revision_and_target_are_validated_before_admission() {
        let target = RemoteTarget {
            id: "fixture".into(), name: "fixture".into(), host: "fixture.invalid".into(), port: 22,
            user: "fixture".into(), auth_method: "key".into(), identity_file: None, ssh_config: None,
            default_path: None, enabled: true, created_at: 1, updated_at: 7,
        };
        let lease = register("owner", request(Kind::Read, 1000), Kind::Read).unwrap();
        lease.context.bind(&target).unwrap();
        let mut changed = target.clone();
        changed.host = "different.invalid".into();
        assert!(lease.context.bind(&changed).is_err());
        changed = target.clone();
        changed.updated_at += 1;
        assert!(lease.context.bind(&changed).is_err());
        changed = target;
        changed.id = "other".into();
        assert!(lease.context.bind(&changed).is_err());
    }

    #[test]
    fn queued_cancellation_releases_admission_without_dispatching() {
        let gate = Arc::new(Gate::default());
        let context = Context::local(Kind::Read, Duration::from_secs(2));
        let first = gate.acquire("slow", &context).unwrap();
        let second = gate.acquire("slow", &context).unwrap();
        let request = request(Kind::Read, 2000);
        let lease = register("owner", request.clone(), Kind::Read).unwrap();
        let waiting = lease.context.clone();
        let waiting_gate = gate.clone();
        let thread = std::thread::spawn(move || {
            waiting_gate.acquire("slow", &waiting).err().unwrap()
        });
        let start = Instant::now();
        while gate.state.lock().unwrap().queue.is_empty() && start.elapsed() < Duration::from_secs(1) { std::thread::yield_now(); }
        assert!(!gate.state.lock().unwrap().queue.is_empty());
        assert!(cancel("owner", &request.request_id, &request.cancel_token));
        let RemoteError::Operation(failure) = thread.join().unwrap() else { panic!("missing failure") };
        assert_eq!(failure.stage, "queue");
        assert_eq!(failure.reason, "cancelled");
        assert_eq!(failure.outcome, "failed");
        assert!(gate.state.lock().unwrap().queue.is_empty());
        drop((first, second));
    }

    #[test]
    fn a_total_deadline_is_not_renewed_and_queued_work_is_released() {
        let gate = Gate::default();
        let context = Context::local(Kind::Read, Duration::from_secs(1));
        let first = gate.acquire("slow", &context).unwrap();
        let second = gate.acquire("slow", &context).unwrap();
        let waiting = Context::local(Kind::Read, Duration::from_millis(45));
        let at = Instant::now();
        assert!(gate.acquire("slow", &waiting).is_err());
        assert!(at.elapsed() < Duration::from_millis(250));
        assert!(gate.state.lock().unwrap().queue.is_empty());
        // One saturated destination does not consume another host's budget.
        let other = gate.acquire("healthy", &context).unwrap();
        drop((first, second, other));
        assert!(gate.state.lock().unwrap().inflight.is_empty());
    }

    #[test]
    fn global_bound_priority_and_background_fairness_are_explicit() {
        let mut state = State::default();
        state.queue.push_back(Waiting { ticket: 1, destination: "a".into(), priority: Priority::Background });
        state.queue.push_back(Waiting { ticket: 2, destination: "a".into(), priority: Priority::Interactive });
        state.queue.push_back(Waiting { ticket: 3, destination: "b".into(), priority: Priority::Interactive });
        assert_eq!(Gate::selected(&state), Some(2));
        state.last_host = "a".into();
        assert_eq!(Gate::selected(&state), Some(3));
        state.interactive_streak = 3;
        assert_eq!(Gate::selected(&state), Some(1));
        for index in 0..GLOBAL_LIMIT { state.inflight.insert(format!("host-{index}"), 1); }
        assert_eq!(Gate::selected(&state), None);
    }

    #[test]
    fn background_work_preserves_foreground_capacity_per_host_and_globally() {
        let mut state = State::default();
        state.inflight.insert("a".into(), 1);
        state.background_inflight.insert("a".into(), 1);
        state.queue.push_back(Waiting { ticket: 1, destination: "a".into(), priority: Priority::Background });
        assert_eq!(Gate::selected(&state), None);
        state.queue.push_back(Waiting { ticket: 2, destination: "a".into(), priority: Priority::Interactive });
        assert_eq!(Gate::selected(&state), Some(2));
        state.queue.clear();
        state.inflight.clear();
        state.background_inflight.clear();
        for index in 0..GLOBAL_LIMIT - 1 {
            state.inflight.insert(format!("host-{index}"), 1);
            state.background_inflight.insert(format!("host-{index}"), 1);
        }
        state.queue.push_back(Waiting { ticket: 3, destination: "another".into(), priority: Priority::Background });
        assert_eq!(Gate::selected(&state), None);
        state.queue.push_back(Waiting { ticket: 4, destination: "another".into(), priority: Priority::Interactive });
        assert_eq!(Gate::selected(&state), Some(4));
    }

    #[test]
    fn cancellation_after_dispatch_is_unknown_only_for_writes() {
        for kind in [Kind::Read, Kind::Write] {
            let context = Context::local(kind, Duration::from_secs(1));
            context.dispatched();
            let RemoteError::Operation(failure) = context.failure("cancelled", "cancelled") else { unreachable!() };
            assert_eq!(failure.outcome, if kind == Kind::Write { "unknown" } else { "failed" });
            let RemoteError::Operation(failure) = context.failure("authentication", "denied") else { unreachable!() };
            assert_eq!(failure.outcome, "failed");
        }
    }
}
