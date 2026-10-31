use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, LazyLock, Mutex, OnceLock, mpsc};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use portable_pty::{Child, ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::adapters::LaunchMode;
use crate::launch::{LaunchPlan, LaunchResult, TerminalId};
use crate::terminal_replay::ReplayBuffer;

const REPLAY_LIMIT: usize = 256 * 1024;
/// PTY reads arrive as thousands of small chunks; one IPC event per read floods the
/// bridge with JSON and base64. Aggregate bursts for a few milliseconds instead.
const OUTPUT_FLUSH_WINDOW: Duration = Duration::from_millis(8);
const OUTPUT_FLUSH_BYTES: usize = 64 * 1024;
const OUTPUT_CHANNEL_CAPACITY: usize = 256;
const OUTPUT_EVENT: &str = "cliora:session-output";
const EXIT_EVENT: &str = "cliora:session-exit";
const STATE_EVENT: &str = "cliora:session-state";
const CONNECTING: u8 = 0;
const CONNECTED: u8 = 1;
const DISCONNECTED: u8 = 2;
const REMOTE_ENDED: u8 = 3;
const UNKNOWN: u8 = 4;

static APP: OnceLock<AppHandle> = OnceLock::new();
static SESSIONS: LazyLock<Mutex<HashMap<String, Arc<Session>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// `TerminateProcess` only reaches the direct child, but npm shims run `cmd.exe` →
/// `node.exe` and CLIs spawn MCP servers of their own. Ending a session must tear
/// down the whole tree, so the child is assigned to a kill-on-close job object.
#[cfg(windows)]
pub(crate) mod process_tree {
    use std::os::raw::c_void;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        SetInformationJobObject, TerminateJobObject, QueryInformationJobObject, JobObjectBasicAccountingInformation, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    };

    mod thread_snapshot {
        use super::*;
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows_sys::Win32::{Foundation::ERROR_NO_MORE_ITEMS, System::{
            Diagnostics::ProcessSnapshotting::*,
            Threading::{GetCurrentProcess, GetProcessIdOfThread, OpenThread, THREAD_QUERY_LIMITED_INFORMATION, THREAD_SUSPEND_RESUME},
        }};

        #[derive(Clone, Copy)]
        pub(super) struct Api {
            pub capture: unsafe extern "system" fn(HANDLE, PSS_CAPTURE_FLAGS, u32, *mut HPSS) -> u32,
            pub marker: unsafe extern "system" fn(*const PSS_ALLOCATOR, *mut HPSSWALK) -> u32,
            pub walk: unsafe extern "system" fn(HPSS, PSS_WALK_INFORMATION_CLASS, HPSSWALK, *mut c_void, u32) -> u32,
            pub free_marker: unsafe extern "system" fn(HPSSWALK) -> u32,
            pub free_snapshot: unsafe extern "system" fn(HANDLE, HPSS) -> u32,
        }

        pub(super) const API: Api = Api { capture: PssCaptureSnapshot, marker: PssWalkMarkerCreate, walk: PssWalkSnapshot, free_marker: PssWalkMarkerFree, free_snapshot: PssFreeSnapshot };

        struct Lookup<'a> { api: &'a Api, snapshot: HPSS, marker: HPSSWALK }
        impl Lookup<'_> {
            fn release(&mut self) -> bool {
                // Local capture descriptors belong to this process, not the child.
                // Disarm before freeing: a reported error must not cause a second
                // free of a descriptor with uncertain lifetime.
                let marker = std::mem::replace(&mut self.marker, std::ptr::null_mut());
                let snapshot = std::mem::replace(&mut self.snapshot, std::ptr::null_mut());
                let marker_ok = marker.is_null() || unsafe { (self.api.free_marker)(marker) == 0 };
                let snapshot_ok = snapshot.is_null() || unsafe { (self.api.free_snapshot)(GetCurrentProcess(), snapshot) == 0 };
                marker_ok && snapshot_ok
            }

            fn finish(mut self, result: Result<OwnedHandle, &'static str>) -> Result<OwnedHandle, &'static str> {
                if !self.release() {
                    return Err("无法确认挂起线程核查资源已释放，远程进程未恢复");
                }
                result
            }
        }
        impl Drop for Lookup<'_> { fn drop(&mut self) { let _ = self.release(); } }

        pub(super) fn primary_thread(child: HANDLE, pid: u32, api: &Api) -> Result<OwnedHandle, &'static str> {
            let mut lookup = Lookup { api, snapshot: std::ptr::null_mut(), marker: std::ptr::null_mut() };
            let result = (|| unsafe {
                let mut snapshot = std::ptr::null_mut();
                // IDs only; never clone memory, capture handles or thread contexts.
                if (api.capture)(child, PSS_CAPTURE_THREADS, 0, &mut snapshot) != 0 {
                    return Err("无法捕获远程挂起进程的线程快照");
                }
                lookup.snapshot = snapshot;
                let mut marker = std::ptr::null_mut();
                if (api.marker)(std::ptr::null(), &mut marker) != 0 {
                    return Err("无法建立远程挂起线程的核查游标");
                }
                lookup.marker = marker;
                let mut found = None;
                loop {
                    let mut entry: PSS_THREAD_ENTRY = std::mem::zeroed();
                    let code = (api.walk)(snapshot, PSS_WALK_THREADS, marker, &mut entry as *mut _ as *mut c_void, std::mem::size_of_val(&entry) as u32);
                    if code == ERROR_NO_MORE_ITEMS { break; }
                    if code != 0 { return Err("无法完整核查远程挂起进程的线程"); }
                    if entry.ProcessId != pid { return Err("远程挂起线程快照不属于本次请求"); }
                    if found.replace(entry.ThreadId).is_some() { return Err("远程挂起进程的主线程身份不唯一"); }
                }
                let id = found.ok_or("无法核查远程进程的挂起主线程")?;
                let raw = OpenThread(THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION, 0, id);
                if raw.is_null() { return Err("无法访问远程进程的挂起主线程"); }
                let thread = OwnedHandle::from_raw_handle(raw);
                if GetProcessIdOfThread(thread.as_raw_handle()) != pid { return Err("远程挂起主线程不属于本次请求"); }
                Ok(thread)
            })();
            // Free failures are observable before ResumeThread, while the Job
            // still owns a suspended process. Drop is only an unwind fallback.
            lookup.finish(result)
        }
    }

    pub struct Job(HANDLE);

    // Ownership is exclusive; a job handle may be closed from any thread.
    unsafe impl Send for Job {}

    impl Job {
        /// Job termination is asynchronous. Drain its active process count
        /// before remote pipe readers are joined and the operation completes.
        pub fn terminate_and_wait(&self) -> bool {
            use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
            use windows_sys::Win32::{
                Foundation::WAIT_OBJECT_0,
                System::{JobObjects::{JobObjectBasicProcessIdList, JOBOBJECT_BASIC_PROCESS_ID_LIST},
                    Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE}},
            };
            unsafe {
                // ActiveProcesses may reach zero before a process handle is
                // signalled. Capture actual member handles before termination;
                // accounting alone did not close that final teardown window.
                let mut buffer = vec![0usize; 1026];
                let listed = QueryInformationJobObject(self.0, JobObjectBasicProcessIdList,
                    buffer.as_mut_ptr() as *mut c_void, (buffer.len() * std::mem::size_of::<usize>()) as u32,
                    std::ptr::null_mut()) != 0;
                let mut processes: Vec<OwnedHandle> = Vec::new();
                if listed {
                    let list = &*(buffer.as_ptr() as *const JOBOBJECT_BASIC_PROCESS_ID_LIST);
                    let ids = std::slice::from_raw_parts(list.ProcessIdList.as_ptr(), (list.NumberOfProcessIdsInList as usize).min(1024));
                    for pid in ids {
                        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, *pid as u32);
                        if !handle.is_null() { processes.push(OwnedHandle::from_raw_handle(handle)); }
                    }
                }
                if TerminateJobObject(self.0, 1) == 0 { return false; }
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
                for process in &processes {
                    let remaining = deadline.saturating_duration_since(std::time::Instant::now()).as_millis() as u32;
                    if WaitForSingleObject(process.as_raw_handle(), remaining) != WAIT_OBJECT_0 { return false; }
                }
                loop {
                    let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
                    if QueryInformationJobObject(self.0, JobObjectBasicAccountingInformation,
                        &mut accounting as *mut _ as *mut c_void,
                        std::mem::size_of_val(&accounting) as u32, std::ptr::null_mut()) == 0 { return false; }
                    if accounting.ActiveProcesses == 0 { return listed; }
                    if std::time::Instant::now() >= deadline { return false; }
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
            }
        }

        /// Command creates this process suspended, so no askpass/helper child
        /// can escape between process creation and job assignment.
        pub fn resume_child(child: &mut std::process::Child) -> Result<Job, &'static str> {
            Self::resume_child_with(child, None, Self::assign, |thread| unsafe {
                windows_sys::Win32::System::Threading::ResumeThread(thread)
            })
        }

        fn resume_child_with(child: &mut std::process::Child, expected_pid: Option<u32>, assign: impl FnOnce(HANDLE) -> Option<Job>, resume: impl FnOnce(HANDLE) -> u32) -> Result<Job, &'static str> {
            use std::os::windows::io::AsRawHandle;
            let result = Self::assign_suspended_with(child.as_raw_handle(), expected_pid.unwrap_or_else(|| child.id()), assign, resume);
            if result.is_err() { let _ = child.kill(); let _ = child.wait(); }
            result
        }

        fn assign_suspended_with(child: HANDLE, pid: u32, assign: impl FnOnce(HANDLE) -> Option<Job>, resume: impl FnOnce(HANDLE) -> u32) -> Result<Job, &'static str> {
            Self::assign_suspended_snapshot_with(child, pid, assign, resume, &thread_snapshot::API)
        }

        fn assign_suspended_snapshot_with(child: HANDLE, pid: u32, assign: impl FnOnce(HANDLE) -> Option<Job>, resume: impl FnOnce(HANDLE) -> u32, api: &thread_snapshot::Api) -> Result<Job, &'static str> {
            use std::os::windows::io::AsRawHandle;
            let job = assign(child).ok_or("无法建立远程进程清理边界")?;
            let result = thread_snapshot::primary_thread(child, pid, api).and_then(|thread| {
                if resume(thread.as_raw_handle()) != 1 { return Err("无法安全恢复远程进程的挂起主线程"); }
                Ok(())
            });
            if let Err(error) = result {
                if !job.terminate_and_wait() { return Err("挂起进程启动失败，无法确认清理完成"); }
                return Err(error);
            }
            Ok(job)
        }

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

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::os::windows::{process::CommandExt, io::AsRawHandle};
        use windows_sys::Win32::{Foundation::{ERROR_NO_MORE_ITEMS, HANDLE}, System::{
            Diagnostics::ProcessSnapshotting::*, Threading::{GetCurrentProcess, GetCurrentThreadId, ResumeThread},
        }};

        #[derive(Default)]
        struct SnapshotProbe {
            fault: &'static str,
            captures: usize,
            markers: usize,
            snapshot_frees: usize,
            marker_frees: usize,
            actual_free_errors: usize,
            invalid_parameters: bool,
            walk_calls: usize,
            first: Option<PSS_THREAD_ENTRY>,
            resumes: usize,
        }
        thread_local! { static SNAPSHOT_PROBE: std::cell::RefCell<SnapshotProbe> = std::cell::RefCell::new(SnapshotProbe::default()); }

        unsafe extern "system" fn capture_probe(process: HANDLE, flags: PSS_CAPTURE_FLAGS, context: u32, snapshot: *mut HPSS) -> u32 {
            let fault = SNAPSHOT_PROBE.with(|s| {
                let mut s = s.borrow_mut();
                s.invalid_parameters |= flags != PSS_CAPTURE_THREADS || context != 0;
                s.fault
            });
            let code = PssCaptureSnapshot(if fault == "capture" { std::ptr::null_mut() } else { process }, flags, context, snapshot);
            if code == 0 { SNAPSHOT_PROBE.with(|s| s.borrow_mut().captures += 1); }
            code
        }

        unsafe extern "system" fn failed_marker_allocate(_: *mut c_void, _: u32) -> *mut c_void { std::ptr::null_mut() }
        unsafe extern "system" fn failed_marker_free(_: *mut c_void, _: *mut c_void) {}

        unsafe extern "system" fn marker_probe(allocator: *const PSS_ALLOCATOR, marker: *mut HPSSWALK) -> u32 {
            let failed = PSS_ALLOCATOR { Context: std::ptr::null_mut(), AllocRoutine: failed_marker_allocate as *const () as isize, FreeRoutine: failed_marker_free as *const () as isize };
            let fault = SNAPSHOT_PROBE.with(|s| s.borrow().fault);
            let code = PssWalkMarkerCreate(if fault == "marker" { &failed } else { allocator }, marker);
            if code == 0 { SNAPSHOT_PROBE.with(|s| s.borrow_mut().markers += 1); }
            code
        }

        unsafe extern "system" fn walk_probe(snapshot: HPSS, class: PSS_WALK_INFORMATION_CLASS, marker: HPSSWALK, buffer: *mut c_void, size: u32) -> u32 {
            let (fault, call, first) = SNAPSHOT_PROBE.with(|s| {
                let mut s = s.borrow_mut();
                s.walk_calls += 1;
                (s.fault, s.walk_calls, s.first)
            });
            if fault == "zero" { return ERROR_NO_MORE_ITEMS; }
            if fault == "many" && call == 2 {
                if let Some(first) = first { *(buffer as *mut PSS_THREAD_ENTRY) = first; return 0; }
            }
            let code = PssWalkSnapshot(snapshot, class, marker, buffer, if fault == "walk" { 0 } else { size });
            if code == 0 {
                let entry = &mut *(buffer as *mut PSS_THREAD_ENTRY);
                if fault == "pid" { entry.ProcessId = u32::MAX; }
                if fault == "open" { entry.ThreadId = u32::MAX; }
                if fault == "owner" { entry.ThreadId = GetCurrentThreadId(); }
                SNAPSHOT_PROBE.with(|s| s.borrow_mut().first = Some(*entry));
            }
            code
        }

        unsafe extern "system" fn free_marker_probe(marker: HPSSWALK) -> u32 {
            let code = PssWalkMarkerFree(marker);
            SNAPSHOT_PROBE.with(|s| {
                let mut s = s.borrow_mut();
                s.marker_frees += 1;
                if code != 0 { s.actual_free_errors += 1; }
                if s.fault == "free_marker" { 5 } else { code }
            })
        }

        unsafe extern "system" fn free_snapshot_probe(process: HANDLE, snapshot: HPSS) -> u32 {
            let code = PssFreeSnapshot(process, snapshot);
            SNAPSHOT_PROBE.with(|s| {
                let mut s = s.borrow_mut();
                s.snapshot_frees += 1;
                s.invalid_parameters |= process != GetCurrentProcess();
                if code != 0 { s.actual_free_errors += 1; }
                if s.fault == "free_snapshot" { 5 } else { code }
            })
        }

        #[test]
        fn suspended_fixture_child() {
            if let Some(marker) = std::env::var_os("CLIORA_SUSPENDED_CHILD_MARKER") {
                std::fs::write(marker, b"executed").unwrap();
                std::thread::sleep(std::time::Duration::from_secs(10));
            }
        }

        #[test]
        fn failed_assignment_thread_lookup_and_resume_reclaim_suspended_children() {
            let directory = tempfile::tempdir().unwrap();
            for failure in ["assignment", "lookup", "resume", "suspend_count"] {
                let marker = directory.path().join(failure);
                let mut child = std::process::Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", "session_host::process_tree::tests::suspended_fixture_child"])
                    .env("CLIORA_SUSPENDED_CHILD_MARKER", &marker)
                    .creation_flags(0x0800_0004).spawn().unwrap();
                let expected = if failure == "lookup" { Some(u32::MAX) } else { None };
                let result = Job::resume_child_with(&mut child, expected,
                    |handle| if failure == "assignment" { None } else { Job::assign(handle) },
                    |_| if failure == "suspend_count" { 2 } else { u32::MAX });
                assert!(result.is_err(), "{failure}");
                assert!(child.try_wait().unwrap().is_some(), "{failure} left a suspended process");
                assert!(!marker.exists(), "{failure} executed before the containment boundary");
            }
        }

        #[test]
        fn process_snapshot_failures_release_descriptors_before_refusing_resume() {
            let directory = tempfile::tempdir().unwrap();
            let api = thread_snapshot::Api { capture: capture_probe, marker: marker_probe, walk: walk_probe, free_marker: free_marker_probe, free_snapshot: free_snapshot_probe };
            for fault in ["capture", "marker", "walk", "zero", "many", "pid", "open", "owner", "free_marker", "free_snapshot"] {
                SNAPSHOT_PROBE.with(|s| *s.borrow_mut() = SnapshotProbe { fault, ..Default::default() });
                let marker = directory.path().join(fault);
                let mut child = std::process::Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", "session_host::process_tree::tests::suspended_fixture_child"])
                    .env("CLIORA_SUSPENDED_CHILD_MARKER", &marker)
                    .creation_flags(0x0800_0004).spawn().unwrap();
                let result = Job::assign_suspended_snapshot_with(child.as_raw_handle(), child.id(), Job::assign,
                    |_| { SNAPSHOT_PROBE.with(|s| s.borrow_mut().resumes += 1); u32::MAX }, &api);
                assert!(result.is_err(), "{fault}");
                if fault.starts_with("free_") { assert!(result.err().unwrap().contains("资源已释放"), "{fault}"); }
                assert!(child.try_wait().unwrap().is_some(), "{fault} left the child suspended");
                assert!(!marker.exists(), "{fault} executed before validation/descriptor cleanup");
                SNAPSHOT_PROBE.with(|s| {
                    let s = s.borrow();
                    assert_eq!(s.resumes, 0, "{fault}");
                    assert_eq!(s.captures, s.snapshot_frees, "{fault}");
                    assert_eq!(s.markers, s.marker_frees, "{fault}");
                    assert_eq!(s.actual_free_errors, 0, "{fault}");
                    assert!(!s.invalid_parameters, "{fault}");
                });
            }
        }

        #[test]
        fn process_snapshot_releases_resources_then_resumes_the_owned_thread_once() {
            let directory = tempfile::tempdir().unwrap();
            let marker = directory.path().join("validated");
            SNAPSHOT_PROBE.with(|s| *s.borrow_mut() = SnapshotProbe::default());
            let api = thread_snapshot::Api { capture: capture_probe, marker: marker_probe, walk: walk_probe, free_marker: free_marker_probe, free_snapshot: free_snapshot_probe };
            let mut child = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "session_host::process_tree::tests::suspended_fixture_child"])
                .env("CLIORA_SUSPENDED_CHILD_MARKER", &marker)
                .creation_flags(0x0800_0004).spawn().unwrap();
            let job = Job::assign_suspended_snapshot_with(child.as_raw_handle(), child.id(), Job::assign, |thread| {
                SNAPSHOT_PROBE.with(|s| {
                    let mut s = s.borrow_mut();
                    assert_eq!((s.captures, s.markers, s.snapshot_frees, s.marker_frees), (1, 1, 1, 1));
                    assert_eq!(s.actual_free_errors, 0);
                    assert!(!s.invalid_parameters);
                    s.resumes += 1;
                });
                unsafe { ResumeThread(thread) }
            }, &api).unwrap();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while !marker.exists() && std::time::Instant::now() < deadline { std::thread::sleep(std::time::Duration::from_millis(10)); }
            let executed = marker.exists();
            assert!(job.terminate_and_wait());
            assert!(child.try_wait().unwrap().is_some());
            assert!(executed);
            SNAPSHOT_PROBE.with(|s| assert_eq!(s.borrow().resumes, 1));
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
    pub connection_state: &'static str,
    pub exit_reason: &'static str,
    pub reattachable: bool,
    pub remote_session_id: Option<String>,
    pub remote_end_result: Option<RemoteEndResult>,
    pub state_revision: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEndResult {
    pub outcome: &'static str,
    pub stage: String,
    pub exit_code: Option<i32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionBytes {
    session_id: String,
    data_base64: String,
    /// Stream offset of the first byte, so a view can skip what its replay already held.
    offset: u64,
}

/// Recent output for a view that mounts after the session started.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaySnapshot {
    /// Mode prelude plus the retained output.
    pub data_base64: String,
    /// Stream offset just past the newest byte in `data_base64`.
    pub end_offset: u64,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionExit {
    session_id: String,
    exit_code: Option<i32>,
    state_revision: u64,
}

struct Session {
    id: String,
    sequence: u64,
    started_at: u64,
    tool_id: String,
    project_id: Option<String>,
    directory: Mutex<String>,
    mode: LaunchMode,
    running: AtomicBool,
    exit_code: Mutex<Option<i32>>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    grid: Mutex<PtySize>,
    transport_generation: AtomicU64,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    replay: Mutex<ReplayBuffer>,
    remote: bool,
    executable: std::path::PathBuf,
    remote_session_id: Option<String>,
    remote_end_args: Option<Vec<String>>,
    environment: Vec<(String, String)>,
    connection: AtomicU8,
    state_revision: AtomicU64,
    remote_end_result: Mutex<Option<RemoteEndResult>>,
    operation: Mutex<()>,
    #[cfg(windows)]
    job: Mutex<Option<process_tree::Job>>,
}

pub fn install(app: AppHandle) {
    let _ = APP.set(app);
}

pub fn start(plan: LaunchPlan, credential: Option<&(String, String)>) -> Result<LaunchResult, String> {
    let remote = plan.project_id.as_deref().is_some_and(|id| id.starts_with("remote:"));
    if !remote && !plan.executable.is_file() {
        return Err("CLI 可执行文件不存在，请在工具页重新检测".into());
    }
    if !remote && !plan.directory.is_dir() {
        return Err("工作目录不存在".into());
    }
    let size = PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 };
    let pair = native_pty_system().openpty(size).map_err(|error| format!("无法创建会话终端：{error}"))?;
    // Canonical Windows paths carry the `\\?\` prefix. cmd.exe (npm `.cmd` shims) rejects
    // such a working directory and silently falls back to C:\Windows.
    let directory = crate::launch::terminal_path(&plan.directory)?;
    let (program, args) = hosted_command(&plan)?;
    let mut command = CommandBuilder::new(&program);
    if !remote {
        command.cwd(&directory);
    }
    command.args(args);
    // Windows OpenSSH sends TERM=dumb when Cliora itself has no TERM
    // environment variable. That makes interactive remote CLIs such as
    // Codex prompt for a fallback or exit before the workbench can attach.
    // The PTY is a real xterm-compatible terminal, so advertise it explicitly.
    if remote {
        command.env("TERM", "xterm-256color");
    }
    apply_environment(&mut command, &plan, credential);
    let context = if remote { crate::remote::operations::current() } else { None };
    let slot = context.as_ref().map(|context| crate::remote::operations::acquire_bound(context)).transpose().map_err(|error| error.to_string())?;
    if let Some(context) = &context { context.check().map_err(|error| error.to_string())?; }
    let mut child = pair.slave.spawn_command(command).map_err(|error| format!("无法在工作台启动 CLI：{error}"))?;
    if let Some(context) = &context { context.dispatched(); }
    // A persistent PTY is not a short remote read; only admission/spawn uses
    // the ordinary scheduler slot, never its long-lived connection.
    drop(slot);
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
        directory: Mutex::new(directory),
        mode: plan.mode,
        running: AtomicBool::new(true),
        exit_code: Mutex::new(None),
        master: Mutex::new(Some(pair.master)),
        writer: Mutex::new(Some(writer)),
        grid: Mutex::new(size),
        transport_generation: AtomicU64::new(0),
        killer: Mutex::new(child.clone_killer()),
        child: Mutex::new(child),
        replay: Mutex::new(ReplayBuffer::new(REPLAY_LIMIT)),
        remote,
        executable: program,
        remote_session_id: plan.remote_session_id.clone(),
        remote_end_args: plan.remote_end_args.clone(),
        environment: plan.environment.clone(),
        connection: AtomicU8::new(if remote { CONNECTING } else { CONNECTED }),
        state_revision: AtomicU64::new(0),
        remote_end_result: Mutex::new(None),
        operation: Mutex::new(()),
        #[cfg(windows)]
        job: Mutex::new(job),
    });
    let id = session.id.clone();
    sessions().insert(id.clone(), Arc::clone(&session));
    if let Err(error) = attach_reader(Arc::clone(&session), reader) {
        sessions().remove(&id);
        end_child(&session);
        return Err(error);
    }
    Ok(LaunchResult {
        tool_id: plan.tool_id,
        project_id: plan.project_id,
        mode: plan.mode,
        terminal: TerminalId::Workbench,
        status: "session_started",
        session_id: Some(id),
        remote_session_id: plan.remote_session_id,
        warnings: Vec::new(),
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
    let generation = session.transport_generation.load(Ordering::SeqCst);
    let name = format!("cliora-session-{}", session.id);
    let reading = Arc::clone(&session);
    thread::Builder::new()
        .name(name)
        .spawn(move || read_output(reading, reader, generation))
        .map_err(|error| format!("无法接收会话输出：{error}"))?;
    // ConPTY keeps its output pipe open until the master closes, even after
    // SSH exits. Local launch shims may transfer execution to descendants, so
    // their lifetime remains tied to PTY EOF instead of the direct shim child.
    if session.remote {
        thread::Builder::new()
            .name(format!("cliora-session-exit-{}", session.id))
            .spawn(move || watch_child(session, generation))
            .map_err(|error| format!("无法监视会话进程：{error}"))?;
    }
    Ok(())
}

fn watch_child(session: Arc<Session>, generation: u64) {
    {
        let Ok(mut child) = session.child.lock() else { return };
        if session.transport_generation.load(Ordering::SeqCst) != generation { return; }
        if child.wait().is_err() { let _ = child.kill(); }
    }
    let Ok(_operation) = session.operation.lock() else { return };
    if session.transport_generation.load(Ordering::SeqCst) == generation {
        #[cfg(windows)]
        if let Ok(mut job) = session.job.lock() { *job = None; }
        close_pty(&session);
    }
}

fn close_pty(session: &Session) {
    if let Ok(mut writer) = session.writer.lock() { *writer = None; }
    let master = session.master.lock().ok().and_then(|mut master| master.take());
    // Drop without holding a Session lock: ClosePseudoConsole drains its final
    // output while the reader continues forwarding it in stream order.
    drop(master);
}

pub fn list() -> Vec<SessionSnapshot> {
    let mut items: Vec<_> = sessions().values().cloned().collect();
    items.sort_by_key(|session| session.sequence);
    items.into_iter().map(|session| session.snapshot()).collect()
}

pub fn replay(id: &str) -> Result<String, String> {
    Ok(replay_snapshot(id)?.data_base64)
}

/// Working directory of a local session. Remote sessions run elsewhere, so they have none here.
pub fn local_directory(id: &str) -> Result<Option<std::path::PathBuf>, String> {
    let session = lookup(id)?;
    let directory = session.directory.lock().map_err(|_| "会话状态不可用")?.clone();
    if session.remote || directory.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(std::path::PathBuf::from(directory)))
}

/// Accept a shell-reported current directory for local sessions. The path is
/// canonicalized before it becomes visible to the workbench, so OSC directory
/// metadata cannot make the UI display a missing or malformed location.
pub fn set_directory(id: &str, directory: &str) -> Result<String, String> {
    let session = lookup(id)?;
    if session.remote {
        return Err("远程会话的目录由远端终端管理".into());
    }
    let path = std::path::Path::new(directory);
    let canonical = path.canonicalize().map_err(|_| "终端报告的工作目录不存在或无法访问".to_owned())?;
    if !canonical.is_dir() {
        return Err("终端报告的路径不是目录".into());
    }
    let value = crate::launch::terminal_path(&canonical)?;
    *session.directory.lock().map_err(|_| "会话状态不可用")? = value.clone();
    Ok(value)
}

pub fn replay_snapshot(id: &str) -> Result<ReplaySnapshot, String> {
    let session = lookup(id)?;
    let size = *session.grid.lock().map_err(|_| "会话状态不可用")?;
    let (bytes, end_offset) = session.replay.lock().map_err(|_| "会话状态不可用")?.snapshot();
    Ok(ReplaySnapshot { data_base64: base64::engine::general_purpose::STANDARD.encode(bytes), end_offset, cols: size.cols, rows: size.rows })
}

pub fn write(id: &str, data_base64: &str) -> Result<(), String> {
    let bytes = decode_input(data_base64)?;
    let session = lookup(id)?;
    if !session.running.load(Ordering::SeqCst) {
        return Err("会话已经结束".into());
    }
    let mut writer = session.writer.lock().map_err(|_| "会话状态不可用")?;
    let writer = writer.as_mut().ok_or("会话连接已关闭")?;
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
    let master = master.as_ref().ok_or("会话连接已关闭")?;
    // A resize to the grid the PTY already has is not a no-op for the CLI: ConPTY and
    // SIGWINCH both make full-screen CLIs redraw their live region, and switching back to
    // a session re-sends its unchanged grid. Inline TUIs (Kiro, Ink-based CLIs) then
    // repaint below the previous frame and the status lines appear twice.
    if master.get_size().is_ok_and(|size| size.cols == cols && size.rows == rows) {
        return Ok(());
    }
    master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|error| format!("无法调整会话尺寸：{error}"))?;
    *session.grid.lock().map_err(|_| "会话状态不可用")? = PtySize { rows, cols, pixel_width: 0, pixel_height: 0 };
    Ok(())
}

pub fn close(id: &str) -> Result<(), String> {
    close_with_cleanup(id, || Ok(()))
}

pub fn close_with_cleanup(id: &str, cleanup: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    let session = lookup(id)?;
    let _operation = session.operation.lock().map_err(|_| "会话状态不可用")?;
    if session.remote {
        let args = session.remote_end_args.as_ref().ok_or("远程会话缺少结束上下文，保留记录以便核查")?;
        let result = crate::remote::run_session_control(&session.executable, args, &session.environment);
        let (end_result, error) = remote_end_outcome(result, session.remote_session_id.as_deref().unwrap_or_default());
        let confirmed = end_result.outcome == "confirmed_absent";
        *session.remote_end_result.lock().map_err(|_| "会话状态不可用")? = Some(end_result);
        if !confirmed {
            session.connection.store(UNKNOWN, Ordering::SeqCst);
            session.notify_state();
            return Err(error.unwrap_or_else(|| "远程结束结果未知，记录已保留，请重试结束以核查".into()));
        }
        session.connection.store(REMOTE_ENDED, Ordering::SeqCst);
    }
    // Keep the attachment addressable if persistent cleanup fails. A retry can
    // verify absence again and finish storage cleanup without losing recovery.
    cleanup()?;
    end_child(&session);
    sessions().remove(id);
    Ok(())
}

fn remote_end_outcome(result: Result<std::process::Output, crate::remote::RemoteError>, remote_id: &str) -> (RemoteEndResult, Option<String>) {
    match result {
        Ok(output) => {
            let code = output.status.code();
            let confirmed = output.status.success() && String::from_utf8_lossy(&output.stdout).lines()
                .any(|line| line == format!("CLIORA_REMOTE_ABSENT:{remote_id}"));
            if confirmed {
                (RemoteEndResult { outcome: "confirmed_absent", stage: "verify_absence".into(), exit_code: code }, None)
            } else {
                let outcome = if matches!(code, Some(47)) { "failed" } else { "unknown" };
                let message = format!("未确认远程会话已结束（退出码 {}），记录已保留；请核查目标状态", code.map_or_else(|| "未知".into(), |code| code.to_string()));
                let context = crate::remote::operations::current().unwrap_or_else(|| crate::remote::operations::Context::local(crate::remote::operations::Kind::Write, Duration::from_secs(1)));
                let crate::remote::RemoteError::Operation(mut failure) = context.failure_with_exit("verify_absence", &message, code) else { unreachable!() };
                failure.outcome = outcome.into();
                if outcome == "unknown" {
                    failure.code = "remote_unknown".into();
                    failure.action = "远端可能已执行；请核查目标状态，不要直接重复提交。".into();
                }
                (RemoteEndResult { outcome, stage: "verify_absence".into(), exit_code: code }, Some(failure.to_string()))
            }
        }
        Err(error) => {
            use crate::remote::{operations::{Context, Kind}, RemoteError};
            let mut failure = match error {
                RemoteError::Operation(failure) => failure,
                RemoteError::Transport { stage, detail } => {
                    let context = Context::local(Kind::Write, Duration::from_secs(1));
                    context.dispatched();
                    let RemoteError::Operation(mut failure) = context.failure(stage, &detail) else { unreachable!() };
                    failure.stage = stage.into();
                    failure
                }
                other => {
                    let context = Context::local(Kind::Write, Duration::from_secs(1));
                    let RemoteError::Operation(failure) = context.failure("remote_control", &other.to_string()) else { unreachable!() };
                    failure
                }
            };
            failure.message.push_str("；结束未获确认，记录已保留，请核查目标状态");
            let outcome = if failure.outcome == "unknown" { "unknown" } else { "failed" };
            (RemoteEndResult { outcome, stage: failure.stage.clone(), exit_code: failure.exit_code }, Some(failure.to_string()))
        }
    }
}

/// Return the persistent remote session name before the local transport is
/// removed. Commands use it to remove the durable index entry as well.
pub fn remote_session_id(id: &str) -> Option<String> {
    sessions().get(id).and_then(|session| session.remote_session_id.clone())
}

/// Reattach a disconnected SSH transport to the persistent tmux/screen session.
/// The remote process is never recreated; only the local PTY attachment changes.
pub fn reattach(id: &str, requested_size: Option<(u16, u16)>) -> Result<(), String> {
    let session = lookup(id)?;
    let _operation = session.operation.lock().map_err(|_| "会话状态不可用")?;
    if !session.remote {
        return Err("仅远程会话支持重新附着".into());
    }
    if session.running.load(Ordering::SeqCst) {
        return Err("会话仍已连接".into());
    }
    let mut args = session.remote_end_args.clone().ok_or("远程会话缺少持久上下文")?;
    let _ = args.pop();
    if let Some(tty) = args.iter_mut().find(|arg| arg.as_str() == "-T") { *tty = "-tt".into(); }
    let remote_id = session.remote_session_id.clone().ok_or("远程会话缺少稳定 ID")?;
    args.push(crate::launch::remote_reattach_command(&remote_id));
    // ConPTY inherits the mounted terminal's cursor through DSR. Its response
    // may be outside 80x24 after a real session has grown; keep the same grid
    // so that the new console can accept that response before SSH starts.
    let size = if let Some((cols, rows)) = requested_size {
        if !(1..=500).contains(&cols) || !(1..=500).contains(&rows) { return Err("会话尺寸无效".into()); }
        PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }
    } else { *session.grid.lock().map_err(|_| "会话状态不可用")? };
    let pair = native_pty_system().openpty(size).map_err(|error| format!("无法创建重新附着终端：{error}"))?;
    let mut command = CommandBuilder::new(&session.executable);
    command.args(args);
    command.env("TERM", "xterm-256color");
    for (key, value) in &session.environment {
        command.env(key, value);
    }
    let mut child = pair.slave.spawn_command(command).map_err(|error| format!("无法重新附着远程会话：{error}"))?;
    let reader = pair.master.try_clone_reader().map_err(|error| { let _ = child.kill(); format!("无法读取重新附着输出：{error}") })?;
    let writer = pair.master.take_writer().map_err(|error| { let _ = child.kill(); format!("无法写入重新附着会话：{error}") })?;
    #[cfg(windows)]
    let job = child.as_raw_handle().and_then(process_tree::Job::assign);
    session.transport_generation.fetch_add(1, Ordering::SeqCst);
    *session.master.lock().map_err(|_| "会话状态不可用")? = Some(pair.master);
    *session.writer.lock().map_err(|_| "会话状态不可用")? = Some(writer);
    *session.grid.lock().map_err(|_| "会话状态不可用")? = size;
    *session.killer.lock().map_err(|_| "会话状态不可用")? = child.clone_killer();
    *session.child.lock().map_err(|_| "会话状态不可用")? = child;
    #[cfg(windows)]
    { *session.job.lock().map_err(|_| "会话状态不可用")? = job; }
    *session.exit_code.lock().map_err(|_| "会话状态不可用")? = None;
    session.connection.store(CONNECTING, Ordering::SeqCst);
    session.running.store(true, Ordering::SeqCst);
    // Publish the transport's input availability before its first query can
    // enter the output channel. Remote readiness still requires its signal.
    session.notify_state();
    if let Err(error) = attach_reader(Arc::clone(&session), reader) {
        end_child(&session);
        session.connection.store(DISCONNECTED, Ordering::SeqCst);
        session.notify_state();
        return Err(error);
    }
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
    if let Ok(mut killer) = session.killer.lock() {
        let _ = killer.kill();
    }
    // Closing the job handle terminates whatever the process tree still runs.
    #[cfg(windows)]
    if let Ok(mut job) = session.job.lock() {
        *job = None;
    }
    session.running.store(false, Ordering::SeqCst);
    close_pty(session);
}

static OUTPUT_CHANNEL: LazyLock<SyncSender<(String, Vec<u8>)>> = LazyLock::new(|| {
    // Backpressure keeps a CLI that produces output faster than the WebView can
    // consume it from growing an unbounded native queue.
    let (sender, receiver) = mpsc::sync_channel(OUTPUT_CHANNEL_CAPACITY);
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
    while let Ok((id, bytes)) = receiver.recv() {
        pending.entry(id).or_default().extend_from_slice(&bytes);
        let deadline = std::time::Instant::now() + OUTPUT_FLUSH_WINDOW;
        while pending.values().map(Vec::len).sum::<usize>() < OUTPUT_FLUSH_BYTES {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() { break; }
            match receiver.recv_timeout(remaining) {
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
    let offset = {
        let Ok(mut replay) = session.replay.lock() else { return };
        replay.push(bytes)
    };
    emit(OUTPUT_EVENT, SessionBytes {
        session_id: id.to_owned(),
        data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        offset,
    });
}

/// Strip only this attachment's bounded control sequences, including split reads.
/// Bytes that merely resemble a signal are forwarded unchanged and retain order.
struct RemoteControlParser {
    signals: Vec<(Vec<u8>, u8)>,
    pending: Vec<u8>,
}

impl RemoteControlParser {
    fn new(remote_id: Option<&str>) -> Self {
        let signals = remote_id.map(|id| [("ready", CONNECTED), ("ended", REMOTE_ENDED), ("disconnected", DISCONNECTED)]
            .into_iter().map(|(state, value)| (format!("\x1b]777;cliora;{id};{state}\x07").into_bytes(), value)).collect()).unwrap_or_default();
        Self { signals, pending: Vec::new() }
    }

    fn push(&mut self, bytes: &[u8]) -> (Vec<u8>, Vec<u8>) {
        self.pending.extend_from_slice(bytes);
        let mut output = Vec::with_capacity(self.pending.len());
        let mut states = Vec::new();
        let mut cursor = 0;
        while cursor < self.pending.len() {
            let rest = &self.pending[cursor..];
            if let Some((signal, state)) = self.signals.iter().find(|(signal, _)| rest.starts_with(signal)) {
                states.push(*state);
                cursor += signal.len();
            } else if self.signals.iter().any(|(signal, _)| signal.starts_with(rest)) {
                break;
            } else {
                output.push(self.pending[cursor]);
                cursor += 1;
            }
        }
        self.pending.drain(..cursor);
        (output, states)
    }
}

fn read_output(session: Arc<Session>, mut reader: Box<dyn Read + Send>, generation: u64) {
    let mut buffer = [0_u8; 32 * 1024];
    let mut control = RemoteControlParser::new(session.remote_session_id.as_deref());
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
            Ok(size) => {
                if session.transport_generation.load(Ordering::SeqCst) != generation { return; }
                let (output, states) = control.push(&buffer[..size]);
                for state in states {
                    session.connection.store(state, Ordering::SeqCst);
                    session.notify_state();
                }
                if !output.is_empty() { forward_output(&session.id, &output); }
            }
        }
    }
    if session.transport_generation.load(Ordering::SeqCst) != generation { return; }
    let code = session.child.lock().ok().and_then(|mut child| child.wait().ok()).map(|status| status.exit_code() as i32);
    if !control.pending.is_empty() { forward_output(&session.id, &control.pending); }
    if session.remote && session.connection.load(Ordering::SeqCst) != REMOTE_ENDED {
        let state = if code == Some(255) || session.connection.load(Ordering::SeqCst) == DISCONNECTED { DISCONNECTED } else { UNKNOWN };
        session.connection.store(state, Ordering::SeqCst);
    }
    session.running.store(false, Ordering::SeqCst);
    if let Ok(mut exit_code) = session.exit_code.lock() {
        *exit_code = code;
    }
    let revision = session.notify_state();
    emit_exit(&session.id, code, revision);
}

fn emit_exit(id: &str, exit_code: Option<i32>, state_revision: u64) {
    emit(EXIT_EVENT, SessionExit { session_id: id.to_owned(), exit_code, state_revision });
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
    for (key, value) in &plan.environment {
        command.env(key, value);
    }
    if let Some((name, value)) = credential {
        command.env(name, value);
    }
}

impl Session {
    fn notify_state(&self) -> u64 {
        let revision = self.state_revision.fetch_add(1, Ordering::SeqCst) + 1;
        emit(STATE_EVENT, self.snapshot());
        revision
    }

    fn snapshot(&self) -> SessionSnapshot {
        let running = self.running.load(Ordering::SeqCst);
        let connection = self.connection.load(Ordering::SeqCst);
        SessionSnapshot {
            id: self.id.clone(),
            tool_id: self.tool_id.clone(),
            project_id: self.project_id.clone(),
            directory: self.directory.lock().map(|value| value.clone()).unwrap_or_default(),
            mode: self.mode,
            running,
            exit_code: self.exit_code.lock().ok().and_then(|code| *code),
            started_at: self.started_at,
            connection_state: if !self.remote { if running { "connected" } else { "closed" } } else { match connection { CONNECTING => "connecting", CONNECTED => "connected", DISCONNECTED => "disconnected", REMOTE_ENDED => "remote_ended", _ => "unknown" } },
            exit_reason: if running { "running" } else if !self.remote { "process_exit" } else { match connection { DISCONNECTED => "connection_lost", REMOTE_ENDED => "remote_ended", _ => "unknown" } },
            reattachable: self.remote && !running && connection != REMOTE_ENDED,
            remote_session_id: self.remote_session_id.clone(),
            remote_end_result: self.remote_end_result.lock().ok().and_then(|result| result.clone()),
            state_revision: self.state_revision.load(Ordering::SeqCst),
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
pub(crate) fn detach_for_tests(id: &str) {
    if let Some(session) = sessions().remove(id) { end_child(&session); }
}

#[cfg(test)]
mod remote_state_tests {
    use super::*;

    #[test]
    fn control_signals_survive_every_read_boundary_and_never_enter_output() {
        let signal = b"\x1b]777;cliora;cliora-test;ready\x07";
        for split in 0..=signal.len() {
            let mut parser = RemoteControlParser::new(Some("cliora-test"));
            let mut output = parser.push(b"before\r\n").0;
            let (first, mut states) = parser.push(&signal[..split]);
            output.extend(first);
            let (second, next) = parser.push(&signal[split..]);
            output.extend(second);
            states.extend(next);
            output.extend(parser.push(b"after\r\n").0);
            assert_eq!(states, [CONNECTED], "split {split}");
            assert_eq!(output, b"before\r\nafter\r\n", "split {split}");
            assert!(parser.pending.is_empty());
        }
        let mut parser = RemoteControlParser::new(Some("cliora-test"));
        let other = b"\x1b]777;cliora;cliora-other;ready\x07\x1b[6n";
        assert_eq!(parser.push(other), (other.to_vec(), vec![]));
        assert_eq!(parser.push(b"\x1b]777;cliora;cliora-test;ended\x07").1, [REMOTE_ENDED]);
    }

    #[test]
    fn remote_end_requires_success_and_matching_absence_confirmation() {
        fn output(code: i32, stdout: &str) -> std::process::Output {
            #[cfg(windows)]
            let status = { use std::os::windows::process::ExitStatusExt; std::process::ExitStatus::from_raw(code as u32) };
            #[cfg(unix)]
            let status = { use std::os::unix::process::ExitStatusExt; std::process::ExitStatus::from_raw(code << 8) };
            std::process::Output { status, stdout: stdout.as_bytes().to_vec(), stderr: vec![] }
        }
        for (code, marker, expected) in [
            (0, "CLIORA_REMOTE_ABSENT:cliora-test\n", "confirmed_absent"),
            (0, "CLIORA_REMOTE_ABSENT:cliora-other\n", "unknown"),
            (0, "", "unknown"),
            (255, "CLIORA_REMOTE_ABSENT:cliora-test\n", "unknown"),
            (47, "", "failed"),
        ] {
            let (result, error) = remote_end_outcome(Ok(output(code, marker)), "cliora-test");
            assert_eq!(result.outcome, expected);
            assert_eq!(result.exit_code, Some(code));
            assert_eq!(error.is_none(), expected == "confirmed_absent");
        }
        let (result, error) = remote_end_outcome(Err(crate::remote::RemoteError::Transport { stage: "timeout", detail: "controlled".into() }), "cliora-test");
        assert_eq!(result.outcome, "unknown");
        assert_eq!(result.stage, "timeout");
        assert_eq!(result.exit_code, None);
        assert!(error.unwrap().contains("记录已保留"));
    }

    #[cfg(windows)]
    #[test]
    fn native_pty_ready_signal_changes_connecting_without_rendering_control_text() {
        let _guard = lock_for_tests();
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("controlled-ready.ps1");
        std::fs::write(&script, r#"
[Console]::WriteLine('WAITING_FOR_REMOTE')
$null = [Console]::ReadLine()
[Console]::Write([char]27 + ']777;cliora;cliora-controlled;ready' + [char]7)
[Console]::WriteLine('PAYLOAD_READY')
$null = [Console]::ReadLine()
[Console]::WriteLine('TAIL_BEFORE_EXIT')
exit 255
"#).unwrap();
        let plan = LaunchPlan {
            resume_native_id: None, account_version: None, account_context: None,
            tool_id: "controlled".into(), project_id: Some("remote:controlled".into()),
            mode: LaunchMode::Normal, executable: script, cli_args: vec![], directory: directory.path().into(),
            terminal: TerminalId::Workbench, session_markers: &[], credential: None,
            remote_session_id: Some("cliora-controlled".into()), remote_end_args: Some(vec!["-NoProfile".into(), "-Command".into(), "unused".into()]), environment: vec![],
        };
        let id = start(plan, None).unwrap().session_id.unwrap();
        struct Cleanup(String);
        impl Drop for Cleanup { fn drop(&mut self) { detach_for_tests(&self.0); } }
        let _cleanup = Cleanup(id.clone());
        wait_for_replay(&id, "WAITING_FOR_REMOTE").unwrap();
        assert_eq!(lookup(&id).unwrap().snapshot().connection_state, "connecting");
        write(&id, &base64::engine::general_purpose::STANDARD.encode(b"\r")).unwrap();
        wait_for_replay(&id, "PAYLOAD_READY").unwrap();
        assert_eq!(lookup(&id).unwrap().snapshot().connection_state, "connected");
        assert!(!replay_text(&id).contains("777;cliora"));
        let session = lookup(&id).unwrap();
        write(&id, &base64::engine::general_purpose::STANDARD.encode(b"\r")).unwrap();
        wait_for_replay(&id, "TAIL_BEFORE_EXIT").unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while session.running.load(Ordering::SeqCst) {
            assert!(std::time::Instant::now() < deadline);
            thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(session.snapshot().connection_state, "disconnected");
        assert_eq!(session.snapshot().exit_code, Some(255));
        reject_reader_thread(true);
        assert!(reattach(&id, Some((0, 30))).unwrap_err().contains("尺寸无效"));
        let result = reattach(&id, Some((104, 30)));
        reject_reader_thread(false);
        assert!(result.unwrap_err().contains("测试拒绝"));
        let snapshot = session.snapshot();
        assert!(!snapshot.running);
        assert!(snapshot.reattachable);
        assert_eq!(snapshot.connection_state, "disconnected");
        let replay = replay_snapshot(&id).unwrap();
        assert_eq!((replay.cols, replay.rows), (104, 30));
    }

    #[cfg(windows)]
    #[test]
    fn failed_end_preserves_attachment_and_cleanup_runs_only_after_confirmed_absence() {
        let _guard = lock_for_tests();
        let directory = tempfile::tempdir().unwrap();
        let control = directory.path().join("end-status.txt");
        std::fs::write(&control, "47").unwrap();
        let script = directory.path().join("controlled-session.ps1");
        std::fs::write(&script, "[Console]::WriteLine('CONTROLLED_RUNNING'); while ($null -ne [Console]::ReadLine()) {}").unwrap();
        let plan = LaunchPlan {
            resume_native_id: None, account_version: None, account_context: None,
            tool_id: "controlled".into(), project_id: Some("remote:controlled".into()),
            mode: LaunchMode::Normal, executable: script, cli_args: vec![], directory: directory.path().into(),
            terminal: TerminalId::Workbench, session_markers: &[], credential: None,
            remote_session_id: Some("cliora-controlled".into()),
            remote_end_args: Some(vec!["-NoProfile".into(), "-Command".into(), "$code=[int](Get-Content -LiteralPath $env:CLIORA_TEST_END_STATUS); if ($code -eq 0) { [Console]::WriteLine('CLIORA_REMOTE_ABSENT:cliora-controlled') }; exit $code".into()]),
            environment: vec![("CLIORA_TEST_END_STATUS".into(), control.display().to_string())],
        };
        let id = start(plan, None).unwrap().session_id.unwrap();
        struct Cleanup(String);
        impl Drop for Cleanup { fn drop(&mut self) { detach_for_tests(&self.0); } }
        let _cleanup = Cleanup(id.clone());
        wait_for_replay(&id, "CONTROLLED_RUNNING").unwrap();
        let called = AtomicBool::new(false);
        let result = close_with_cleanup(&id, || { called.store(true, Ordering::SeqCst); Ok(()) });
        assert!(result.unwrap_err().contains("47"));
        assert!(!called.load(Ordering::SeqCst));
        let snapshot = lookup(&id).unwrap().snapshot();
        assert!(snapshot.running);
        assert_eq!(snapshot.connection_state, "unknown");
        assert_eq!(snapshot.remote_end_result.unwrap().outcome, "failed");
        std::fs::write(&control, "255").unwrap();
        assert!(close(&id).unwrap_err().contains("255"));
        assert_eq!(lookup(&id).unwrap().snapshot().remote_end_result.unwrap().outcome, "unknown");
        std::fs::write(&control, "0").unwrap();
        assert_eq!(close_with_cleanup(&id, || Err("controlled storage failure".into())).unwrap_err(), "controlled storage failure");
        assert_eq!(lookup(&id).unwrap().snapshot().connection_state, "remote_ended");
        close_with_cleanup(&id, || { called.store(true, Ordering::SeqCst); Ok(()) }).unwrap();
        assert!(called.load(Ordering::SeqCst));
        assert!(lookup(&id).is_err());
    }
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
        resume_native_id: None,
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
        remote_session_id: None,
        remote_end_args: None,
        environment: Vec::new(),
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
