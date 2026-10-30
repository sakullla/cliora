//! Bounded, secret-free read cache shared by UI and compatibility IPC callers.
//! Each waiter owns only its subscription; the final waiter cancels shared SSH.
use std::collections::HashMap;
use std::any::Any;
use std::sync::{atomic::{AtomicBool, AtomicUsize, Ordering}, Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};
use serde::Serialize;
type Value = Arc<dyn Any + Send + Sync>;
use super::{operations::{self, Context, Kind}, RemoteError, RemoteTarget};

const ENTRY_LIMIT: usize = 96;
const BYTE_LIMIT: usize = 48 * 1024 * 1024;
const TTL: Duration = Duration::from_secs(30);

struct Entry { target: String, at: Instant, value: Value, bytes: usize }
struct Flight {
    target: String,
    context: Arc<Context>,
    readers: AtomicUsize,
    invalidated: AtomicBool,
    result: Mutex<Option<Result<Value, RemoteError>>>,
    ready: Condvar,
}
#[derive(Default)]
struct State { entries: HashMap<String, Entry>, flights: HashMap<String, Arc<Flight>>, bytes: usize }
fn state() -> &'static Mutex<State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(State::default()))
}

pub fn invalidate(target_id: &str) {
    let mut cache = state().lock().unwrap_or_else(|e| e.into_inner());
    cache.entries.retain(|_, entry| entry.target != target_id);
    cache.bytes = cache.entries.values().map(|entry| entry.bytes).sum();
    cache.flights.retain(|_, flight| {
        if flight.target != target_id { return true; }
        flight.invalidated.store(true, Ordering::Release);
        flight.context.cancel();
        flight.ready.notify_all();
        false
    });
}

/// Retained success for an explicitly marked stale history source. Identity
/// and write invalidation remove these entries too; this never crosses hosts.
pub fn previous<T: Clone + Send + Sync + 'static>(target: &RemoteTarget, resource: &str) -> Option<T> {
    let key = format!("{}:{resource}", operations::target_identity(target));
    state().lock().unwrap_or_else(|e| e.into_inner()).entries.get(&key)
        .and_then(|entry| entry.value.downcast_ref::<T>()).cloned()
}

pub fn read<T>(target: &RemoteTarget, resource: &str, refresh: bool,
    load: impl FnOnce() -> Result<T, RemoteError> + Send + 'static) -> Result<T, RemoteError>
where T: Serialize + Clone + Send + Sync + 'static {
    let caller = operations::current().unwrap_or_else(|| Context::local(Kind::Read, Duration::from_secs(40)));
    caller.bind(target)?;
    // Read-modify-write must inspect current remote contents and cannot share
    // a cancellable read with other subscribers.
    if caller.kind == Kind::Write { return load(); }
    caller.check()?;
    let key = format!("{}:{resource}", operations::target_identity(target));
    let mut cache = state().lock().unwrap_or_else(|e| e.into_inner());
    if !refresh && !caller.refresh() {
        if let Some(entry) = cache.entries.get(&key).filter(|entry| entry.at.elapsed() < TTL) {
            return entry.value.downcast_ref::<T>().cloned().ok_or_else(|| RemoteError::Storage("远程缓存类型无效".into()));
        }
    }
    let mut start = false;
    let flight = if let Some(flight) = cache.flights.get(&key) { flight.clone() } else {
        if cache.flights.len() >= 128 { return Err(caller.failure("queue", "远程读取队列已满")); }
        start = true;
        let flight = Arc::new(Flight { target: target.id.clone(), context: caller.shared_read(), readers: AtomicUsize::new(0), invalidated: AtomicBool::new(false), result: Mutex::new(None), ready: Condvar::new() });
        cache.flights.insert(key.clone(), flight.clone());
        flight
    };
    flight.readers.fetch_add(1, Ordering::AcqRel);
    drop(cache);
    if start {
        let worker = flight.clone();
        let worker_key = key.clone();
        let target = target.clone();
        std::thread::spawn(move || {
            let mut bytes = BYTE_LIMIT + 1;
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| operations::scoped(worker.context.clone(), || {
                worker.context.bind(&target)?;
                let value = load()?;
                worker.context.check()?;
                bytes = serde_json::to_vec(&value).map(|v| v.len()).unwrap_or(BYTE_LIMIT + 1);
                Ok(Arc::new(value) as Value)
            }))).unwrap_or_else(|_| Err(RemoteError::Storage("远程读取意外中断".into())));
            let mut cache = state().lock().unwrap_or_else(|e| e.into_inner());
            let current = cache.flights.get(&worker_key).is_some_and(|active| Arc::ptr_eq(active, &worker));
            if current && !worker.invalidated.load(Ordering::Acquire) && worker.readers.load(Ordering::Acquire) > 0 {
                if let Ok(value) = &result {
                    if bytes <= BYTE_LIMIT / 2 {
                        if let Some(old) = cache.entries.remove(&worker_key) { cache.bytes -= old.bytes; }
                        while !cache.entries.is_empty() && (cache.entries.len() >= ENTRY_LIMIT || cache.bytes + bytes > BYTE_LIMIT) {
                            let oldest = cache.entries.iter().min_by_key(|(_, entry)| entry.at).map(|(key, _)| key.clone()).unwrap();
                            if let Some(old) = cache.entries.remove(&oldest) { cache.bytes -= old.bytes; }
                        }
                        cache.entries.insert(worker_key.clone(), Entry { target: target.id, at: Instant::now(), value: value.clone(), bytes });
                        cache.bytes += bytes;
                    }
                }
            }
            // Keep the result visible before removing the flight so an
            // overlapping refresh cannot start duplicate work at completion.
            *worker.result.lock().unwrap_or_else(|e| e.into_inner()) = Some(result);
            if current { cache.flights.remove(&worker_key); }
            worker.ready.notify_all();
        });
    }
    struct Subscription(Arc<Flight>, String);
    impl Drop for Subscription {
        fn drop(&mut self) {
            if self.0.readers.fetch_sub(1, Ordering::AcqRel) == 1 {
                let mut cache = state().lock().unwrap_or_else(|e| e.into_inner());
                if cache.flights.get(&self.1).is_some_and(|f| Arc::ptr_eq(f, &self.0)) {
                    cache.flights.remove(&self.1);
                    self.0.context.cancel();
                }
            }
        }
    }
    let _subscription = Subscription(flight.clone(), key);
    let mut result = flight.result.lock().unwrap_or_else(|e| e.into_inner());
    loop {
        caller.check()?;
        if flight.invalidated.load(Ordering::Acquire) { return Err(caller.failure("identity", "远程读取期间目标或内容已变化，请刷新")); }
        if let Some(result) = result.as_ref() {
            return result.clone().and_then(|value| value.downcast_ref::<T>().cloned().ok_or_else(|| RemoteError::Storage("远程缓存类型无效".into())));
        }
        result = flight.ready.wait_timeout(result, Duration::from_millis(15)).unwrap_or_else(|e| e.into_inner()).0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn target() -> RemoteTarget {
        RemoteTarget { id: uuid::Uuid::new_v4().to_string(), name: "cache fixture".into(),
            host: "fixture.invalid".into(), port: 22, user: "fixture".into(), auth_method: "key".into(),
            identity_file: None, ssh_config: None, default_path: None, enabled: true, created_at: 1, updated_at: 1 }
    }

    #[test]
    fn compatibility_reads_are_warm_bounded_and_isolate_connection_scope_and_revision() {
        let target = target();
        let calls = Arc::new(AtomicUsize::new(0));
        let load = |target: &RemoteTarget, resource: &str| {
            let calls = calls.clone();
            read(target, resource, false, move || { calls.fetch_add(1, Ordering::SeqCst); Ok(vec!["nonempty".to_owned()]) }).unwrap()
        };
        assert_eq!(load(&target, "tool:global"), vec!["nonempty"]);
        assert_eq!(load(&target, "tool:global"), vec!["nonempty"]);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        load(&target, "tool:project:/one");
        load(&target, "tool:project:/two");
        let mut changed = target.clone(); changed.host = "other.invalid".into();
        load(&changed, "tool:global");
        changed.updated_at += 1;
        load(&changed, "tool:global");
        assert_eq!(calls.load(Ordering::SeqCst), 5);
        for index in 0..110 { load(&target, &format!("entry:{index}")); }
        let cache = state().lock().unwrap();
        assert!(cache.entries.len() <= ENTRY_LIMIT);
        assert!(cache.bytes <= BYTE_LIMIT);
    }

    #[test]
    fn invalidated_old_flight_cannot_publish_over_the_new_value() {
        let target = target();
        let (started, start) = mpsc::channel();
        let (finish, release) = mpsc::channel();
        let old_target = target.clone();
        let old = std::thread::spawn(move || read(&old_target, "same", false, move || {
            started.send(operations::current().unwrap()).unwrap(); release.recv().unwrap(); Ok(vec!["old"])
        }));
        let old_worker = start.recv_timeout(Duration::from_secs(2)).unwrap();
        invalidate(&target.id);
        assert!(old_worker.check().is_err());
        assert_eq!(read(&target, "same", false, || Ok(vec!["new".to_owned()])).unwrap(), vec!["new"]);
        finish.send(()).unwrap();
        assert!(old.join().unwrap().is_err());
        assert_eq!(read(&target, "same", false, || Ok(vec!["wrong".to_owned()])).unwrap(), vec!["new"]);
    }

    #[test]
    fn cancelling_one_waiter_keeps_shared_work_for_the_other_and_refreshes_merge() {
        let target = target();
        let (started, start) = mpsc::channel();
        let (finish, release) = mpsc::channel();
        let context = Context::local(Kind::Read, Duration::from_secs(3));
        let first_context = context.clone();
        let first_target = target.clone();
        let a = std::thread::spawn(move || operations::scoped(first_context, || read(&first_target, "shared", true, move || {
            started.send(()).unwrap(); release.recv().unwrap(); Ok(vec!["complete".to_owned()])
        })));
        start.recv_timeout(Duration::from_secs(2)).unwrap();
        let second_target = target.clone();
        let b = std::thread::spawn(move || read(&second_target, "shared", true, || -> Result<Vec<String>, RemoteError> { panic!("duplicate refresh") }));
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let joined = state().lock().unwrap().flights.values().any(|flight| flight.target == target.id && flight.readers.load(Ordering::Acquire) == 2);
            if joined { break; }
            assert!(Instant::now() < deadline);
            std::thread::yield_now();
        }
        context.cancel();
        assert!(a.join().unwrap().is_err());
        finish.send(()).unwrap();
        assert_eq!(b.join().unwrap().unwrap(), vec!["complete"]);
    }

    #[test]
    fn last_waiter_cancels_worker_and_a_slow_host_does_not_block_another() {
        let target = target();
        let fast = self::target();
        let caller = Context::local(Kind::Read, Duration::from_secs(3));
        let cancelling = caller.clone();
        let (started, start) = mpsc::channel();
        let (stopped, stop) = mpsc::channel();
        let slow = std::thread::spawn(move || operations::scoped(caller, || read(&target, "slow", false, move || {
            let context = operations::current().unwrap();
            started.send(()).unwrap();
            loop {
                if let Err(error) = context.check() { stopped.send(()).unwrap(); return Err::<Vec<String>, _>(error); }
                std::thread::sleep(Duration::from_millis(5));
            }
        })));
        start.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(read(&fast, "fast", false, || Ok(vec!["reachable"])).unwrap(), vec!["reachable"]);
        cancelling.cancel();
        assert!(slow.join().unwrap().is_err());
        stop.recv_timeout(Duration::from_secs(2)).unwrap();
    }
}
