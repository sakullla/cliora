//! Per-user local IPC between a helper process and the running secret broker.
//!
//! The address is a per-user rendezvous: a domain socket inside the 0700
//! application directory on Unix, a named pipe whose DACL only grants the current
//! user and the system account on Windows. No TCP port is opened and no HTTP is
//! spoken. A connection carries one newline-delimited JSON request and one
//! response; the request names the installation, so an unknown or revoked
//! installation never reaches a value.
//!
//! This is a per-user permission boundary, not a sandbox against every process of
//! the same user (R9).
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use std::{thread, time::Instant};

pub const PROTOCOL_VERSION: u32 = 1;
pub const CODE_PROTOCOL: &str = "protocol_invalid";
pub const CODE_BUSY: &str = "proxy_busy";
pub const CODE_OFFLINE: &str = "proxy_offline";
pub const CODE_SESSION_ENDED: &str = "session_ended";
const MAX_MCP_SESSIONS: usize = 64;
const MAX_REQUEST_BYTES: usize = 16 * 1024;
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_CONNECTIONS: usize = 8;
const ACCEPT_POLL: Duration = Duration::from_millis(50);
/// How long a shutdown waits for the accept loop before it stops waiting.
const STOP_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    List,
    Use,
    Read,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub version: u32,
    pub installation: String,
    pub operation: Operation,
    #[serde(default)]
    pub secret_id: Option<String>,
    #[serde(default)]
    pub executor_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
}

/// One response. `data` is the only field that can hold a result; failures carry a
/// code and short diagnostic text.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub ok: bool,
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl Response {
    pub fn success(code: &'static str, data: serde_json::Value) -> Self {
        Self { ok: true, code: code.into(), message: String::new(), data: Some(data) }
    }

    pub fn failure(code: &str, message: impl Into<String>) -> Self {
        Self { ok: false, code: code.into(), message: message.into(), data: None }
    }
}

/// The broker side of one request. `cancel` is set when the caller disconnected
/// before the answer, so a controlled use stops instead of finishing unnoticed.
pub trait Handler: Send + Sync {
    fn handle(&self, request: Request, cancel: &AtomicBool) -> Response;
}

/// Reads up to one complete newline-delimited message.
fn read_frame(reader: &mut impl Read, max: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => return Err("连接已关闭".into()),
            Ok(read) => {
                bytes.extend_from_slice(&chunk[..read]);
                if let Some(end) = bytes.iter().position(|byte| *byte == b'\n') {
                    if end > max { return Err("消息超过上限".into()); }
                    bytes.truncate(end);
                    return Ok(bytes);
                }
                if bytes.len() > max {
                    return Err("消息超过上限".into());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Err("无法读取消息".into()),
        }
    }
}

pub(super) fn fits_response(response: &Response) -> bool {
    serde_json::to_vec(response).is_ok_and(|bytes| bytes.len() <= MAX_RESPONSE_BYTES)
}

fn write_frame(writer: &mut impl Write, response: &Response) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(response).map_err(|_| "无法整理代理结果".to_string())?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        bytes = serde_json::to_vec(&Response::failure(CODE_PROTOCOL, "代理结果超过上限"))
            .map_err(|_| "无法整理代理结果".to_string())?;
    }
    bytes.push(b'\n');
    writer.write_all(&bytes).and_then(|_| writer.flush()).map_err(|_| "无法写入代理结果".to_string())
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LeaseRequest {
    version: u32,
    open_mcp_session: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Frame {
    Call(Request),
    Lease(LeaseRequest),
}

/// A request checks the control connection itself, even if the thread watching
/// for its EOF has not run yet. No socket operation here may block.
pub(super) struct McpPeer {
    stream: platform::Stream,
    stopped: Arc<AtomicBool>,
}

impl McpPeer {
    pub(super) fn live(&mut self) -> bool {
        !self.stopped.load(Ordering::SeqCst) && !self.stream.closed_now()
    }
}

struct Slot(Arc<AtomicUsize>);

impl Slot {
    fn acquire(count: &Arc<AtomicUsize>, limit: usize) -> Option<Self> {
        let slot = Self(count.clone());
        (count.fetch_add(1, Ordering::SeqCst) < limit).then_some(slot)
    }
}

impl Drop for Slot {
    fn drop(&mut self) { self.0.fetch_sub(1, Ordering::SeqCst); }
}

fn handle_connection(handler: Arc<dyn Handler>, mut stream: platform::Stream, request_slot: Slot, leases: Arc<AtomicUsize>, broker_stopped: Arc<AtomicBool>) {
    let frame = match read_frame(&mut stream, MAX_REQUEST_BYTES)
        .and_then(|bytes| serde_json::from_slice::<Frame>(&bytes).map_err(|_| "请求格式无效".to_string()))
    {
        Ok(request) => request,
        Err(message) => {
            let _ = write_frame(&mut stream, &Response::failure(CODE_PROTOCOL, message));
            return;
        }
    };
    let request = match frame {
        Frame::Call(request) => request,
        Frame::Lease(lease) => {
            if lease.version != PROTOCOL_VERSION || uuid::Uuid::parse_str(&lease.open_mcp_session).is_err() {
                let _ = write_frame(&mut stream, &Response::failure(CODE_PROTOCOL, "会话请求无效"));
                return;
            }
            let Some(_lease_slot) = Slot::acquire(&leases, MAX_MCP_SESSIONS) else {
                let _ = write_frame(&mut stream, &Response::failure(CODE_BUSY, "MCP 会话过多"));
                return;
            };
            drop(request_slot);
            let Some(peer) = stream.try_clone_stream() else { return };
            let session = super::session::LocalSession::mcp(&lease.open_mcp_session,
                McpPeer { stream: peer, stopped: broker_stopped.clone() });
            let response = Response::success("ok", serde_json::json!({ "token": session.token() }));
            if write_frame(&mut stream, &response).is_ok() {
                while !broker_stopped.load(Ordering::SeqCst) && !stream.closed_now() {
                    thread::sleep(ACCEPT_POLL);
                }
            }
            return;
        }
    };
    if request.version != PROTOCOL_VERSION {
        let _ = write_frame(&mut stream, &Response::failure(CODE_PROTOCOL, "协议版本不受支持"));
        return;
    }
    if request.operation != Operation::Read && (request.secret_ids.is_some() || request.session.is_some()) {
        let _ = write_frame(&mut stream, &Response::failure(CODE_PROTOCOL, "该操作不接受批量或会话参数"));
        return;
    }
    #[cfg(target_os = "macos")]
    let request = {
        let mut request = request;
        // A CLI can strip environment variables from its tool subprocesses. Only
        // supplement an absent session; an expired/invalid token must stay invalid.
        if request.operation == Operation::Read && request.session.is_none() {
            request.session = stream.workbench_session();
        }
        request
    };
    let cancel = Arc::new(AtomicBool::new(false));
    let stopped = Arc::new(AtomicBool::new(false));
    // The caller stays connected while it waits; an early close cancels the run.
    let monitor = stream.try_clone_stream().map(|mut peer| {
        let cancel = cancel.clone();
        let stopped = stopped.clone();
        thread::spawn(move || {
            // A refused timeout is not a reason to stop watching: the peer is
            // already gone in that case, so the read below returns end-of-stream.
            let _ = peer.set_read_timeout(Some(ACCEPT_POLL));
            while !stopped.load(Ordering::SeqCst) {
                if peer.disconnected() {
                    cancel.store(true, Ordering::SeqCst);
                    return;
                }
            }
        })
    });
    let response = handler.handle(request, &cancel);
    stopped.store(true, Ordering::SeqCst);
    let _ = write_frame(&mut stream, &response);
    if let Some(monitor) = monitor {
        // A monitor still waiting on a caller that never closed must not hold this
        // connection: the thread ends when that caller goes away.
        let deadline = Instant::now() + STOP_TIMEOUT;
        while !monitor.is_finished() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
    }
}

/// A running broker endpoint. Dropping it stops accepting new work.
pub struct Broker {
    address: platform::Address,
    stopped: Arc<AtomicBool>,
    listener: Option<thread::JoinHandle<()>>,
}

impl Drop for Broker {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        // Wake the Windows listener blocked inside ConnectNamedPipe.
        #[cfg(windows)]
        drop(platform::Stream::connect(&self.address));
        if let Some(listener) = self.listener.take() {
            // The accept loop wakes within one poll interval; a stuck platform
            // wait must not hang application shutdown.
            let deadline = Instant::now() + STOP_TIMEOUT;
            while !listener.is_finished() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(10));
            }
        }
        platform::remove(&self.address);
    }
}

/// Starts the broker. A second instance in the same user session is refused: one
/// proxy owns the authorization and the audit trail.
pub fn serve(handler: Arc<dyn Handler>) -> Result<Broker, String> {
    let address = platform::address()?;
    if platform::live(&address) {
        return Err("本机秘密代理已在运行".into());
    }
    // A socket file left behind by a crashed process accepts no connection.
    platform::remove(&address);
    let listener = platform::Listener::bind(&address)?;
    if let Err(error) = platform::restrict(&address) {
        platform::remove(&address);
        return Err(error);
    }
    let _ = listener.set_blocking(false);
    let stopped = Arc::new(AtomicBool::new(false));
    let active = Arc::new(AtomicUsize::new(0));
    let leases = Arc::new(AtomicUsize::new(0));
    let loop_stop = stopped.clone();
    let thread = thread::spawn(move || {
        while !loop_stop.load(Ordering::SeqCst) {
            let Some(stream) = listener.accept() else {
                thread::sleep(ACCEPT_POLL);
                continue;
            };
            if loop_stop.load(Ordering::SeqCst) { break; }
            let Some(slot) = Slot::acquire(&active, MAX_CONNECTIONS) else {
                let mut stream = stream;
                let _ = write_frame(&mut stream, &Response::failure(CODE_BUSY, "秘密代理请求过多，请稍后重试"));
                continue;
            };
            let handler = handler.clone();
            let leases = leases.clone();
            let broker_stopped = loop_stop.clone();
            thread::spawn(move || handle_connection(handler, stream, slot, leases, broker_stopped));
        }
    });
    Ok(Broker { address, stopped, listener: Some(thread) })
}

/// Sends one request to the running broker. A missing or refused endpoint fails
/// closed with `proxy_offline`.
pub fn call(installation: &str, operation: Operation, secret_id: Option<&str>, executor_id: Option<&str>) -> Result<Response, String> {
    let request = Request {
        version: PROTOCOL_VERSION,
        installation: installation.to_owned(),
        operation,
        secret_id: secret_id.map(str::to_owned),
        executor_id: executor_id.map(str::to_owned),
        secret_ids: None,
        session: None,
    };
    exchange(&request).map(|(_, response)| response)
}

pub fn read(installation: &str, ids: &[String], batch: bool, session: Option<&str>) -> Result<Response, String> {
    if ids.is_empty() || (!batch && ids.len() != 1) {
        return Err("读取请求缺少有效秘密标识".into());
    }
    let request = Request {
        version: PROTOCOL_VERSION,
        installation: installation.to_owned(),
        operation: Operation::Read,
        secret_id: (!batch).then(|| ids[0].clone()),
        secret_ids: batch.then(|| ids.to_vec()),
        executor_id: None,
        session: session.map(str::to_owned),
    };
    exchange(&request).map(|(_, response)| response)
}

pub struct McpSession {
    token: String,
    _stream: platform::Stream,
}

impl McpSession {
    pub fn token(&self) -> &str { &self.token }
}

pub fn open_mcp_session(installation: &str) -> Result<McpSession, String> {
    let (stream, response) = exchange(&LeaseRequest { version: PROTOCOL_VERSION, open_mcp_session: installation.to_owned() })?;
    if !response.ok { return Err(response.message); }
    let token = response.data.as_ref().and_then(|data| data.get("token")).and_then(|token| token.as_str())
        .and_then(|token| uuid::Uuid::parse_str(token).ok()).ok_or("会话响应无效")?;
    Ok(McpSession { token: token.to_string(), _stream: stream })
}

fn exchange(request: &impl Serialize) -> Result<(platform::Stream, Response), String> {
    let address = platform::address()?;
    let mut stream = platform::Stream::connect(&address)
        .map_err(|_| "未找到正在运行的栖点秘密代理；请先打开栖点".to_string())?;
    let mut bytes = serde_json::to_vec(request).map_err(|_| "无法整理代理请求".to_string())?;
    if bytes.len() > MAX_REQUEST_BYTES { return Err("代理请求超过上限，请减少本次引用数".into()); }
    bytes.push(b'\n');
    stream
        .write_all(&bytes)
        .and_then(|_| stream.flush())
        .map_err(|_| "无法连接本机秘密代理".to_string())?;
    let response = read_frame(&mut stream, MAX_RESPONSE_BYTES)?;
    let response = serde_json::from_slice(&response).map_err(|_| "本机秘密代理返回了无法识别的结果".to_string())?;
    Ok((stream, response))
}

/// Which rendezvous the running build uses. The UI shows it so a user can tell a
/// disconnected CLI from a refused one.
pub fn transport() -> &'static str {
    platform::TRANSPORT
}

static START_STATUS: OnceLock<Result<(), String>> = OnceLock::new();

pub fn record_start(result: Result<(), String>) {
    let _ = START_STATUS.set(result);
}

pub fn start_status() -> Result<(), String> {
    START_STATUS.get_or_init(|| Err("秘密代理尚未启动".into())).clone()
}

/// Test-only: isolates the rendezvous from the user's application data, so tests
/// never publish or read the address a real application uses.
#[cfg(test)]
pub fn set_test_root(root: Option<platform::Address>) {
    platform::set_root(root);
}

/// Test-only: one broker endpoint per test, so tests cannot answer each other.
#[cfg(test)]
pub fn test_lock() -> std::sync::MutexGuard<'static, ()> {
    platform::ROOT_LOCK.lock().unwrap_or_else(|error| error.into_inner())
}

/// Test-only: the rendezvous the broker listens on, so a test can open its own
/// connection and control when the request bytes arrive.
#[cfg(test)]
pub fn test_address() -> Result<platform::Address, String> {
    platform::address()
}

/// Test-only: sends one raw frame and closes the connection without waiting for an
/// answer, which is how a caller that stops waiting looks to the broker.
#[cfg(test)]
pub fn send_and_drop(payload: &str) -> Result<(), String> {
    let address = platform::address()?;
    let mut stream = platform::Stream::connect(&address)?;
    let mut bytes = payload.as_bytes().to_vec();
    bytes.push(b'\n');
    stream
        .write_all(&bytes)
        .and_then(|_| stream.flush())
        .map_err(|_| "无法连接本机秘密代理".to_string())
}

#[cfg(unix)]
mod platform {
    use std::io::{self, Read, Write};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::PathBuf;
    use std::time::Duration;

    pub const TRANSPORT: &str = "unix_socket";

    pub type Address = PathBuf;

    /// Tests keep their sockets in an isolated directory so they never touch the
    /// user's application data. The lock serializes those tests.
    #[cfg(test)]
    static ROOT: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);
    #[cfg(test)]
    pub static ROOT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Test-only: isolates the rendezvous from the user's application data.
    #[cfg(test)]
    pub fn set_root(root: Option<Address>) {
        *ROOT.lock().unwrap() = root;
    }

    fn directory() -> Result<PathBuf, String> {
        #[cfg(test)]
        if let Some(root) = ROOT.lock().unwrap().clone() {
            return Ok(root);
        }
        let root = dirs::data_dir()
            .ok_or("无法定位本机数据目录")?
            .join("com.cliora.desktop")
            .join("secret-broker");
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&root).map_err(|_| "无法创建本机秘密代理目录".to_string())?;
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))
                .map_err(|_| "无法限制本机秘密代理目录权限".to_string())?;
        }
        Ok(root)
    }

    pub fn address() -> Result<PathBuf, String> {
        Ok(directory()?.join("broker.sock"))
    }

    pub struct Stream(UnixStream);

    impl Stream {
        #[cfg(target_os = "macos")]
        pub fn workbench_session(&self) -> Option<String> {
            crate::secrets::session::for_socket(&self.0)
        }

        pub fn connect(path: &PathBuf) -> Result<Self, String> {
            UnixStream::connect(path).map(Self).map_err(|_| "未找到正在运行的栖点秘密代理".to_string())
        }

        /// An independent handle lets the server watch for a caller that leaves
        /// while a run is still in progress.
        pub fn try_clone_stream(&self) -> Option<Self> {
            self.0.try_clone().ok().map(Self)
        }

        pub fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
            self.0.set_read_timeout(timeout)
        }

        pub fn disconnected(&mut self) -> bool {
            !matches!(self.read(&mut [0u8; 1]), Err(ref e) if matches!(e.kind(),
                io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut | io::ErrorKind::Interrupted))
        }

        pub fn closed_now(&mut self) -> bool {
            self.0.set_nonblocking(true).is_err() || self.disconnected()
        }
    }

    impl Read for Stream {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            self.0.read(buffer)
        }
    }

    impl Write for Stream {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.0.write(buffer)
        }
        fn flush(&mut self) -> io::Result<()> {
            self.0.flush()
        }
    }

    pub struct Listener(UnixListener);

    impl Listener {
        pub fn bind(path: &PathBuf) -> Result<Self, String> {
            UnixListener::bind(path).map(Self).map_err(|_| "无法建立本机秘密代理地址".to_string())
        }

        /// The listener polls (it stays non-blocking so a shutdown is honoured),
        /// but a connection must block: on macOS and the BSDs an accepted socket
        /// inherits `O_NONBLOCK`, and the request arrives only after the caller's
        /// `connect` returns, so a non-blocking first read reports `WouldBlock`
        /// before the bytes exist. A refused switch drops the socket, which
        /// closes it instead of leaking it.
        pub fn accept(&self) -> Option<Stream> {
            let (stream, _) = self.0.accept().ok()?;
            stream.set_nonblocking(false).ok()?;
            Some(Stream(stream))
        }

        pub fn set_blocking(&self, blocking: bool) -> Result<(), String> {
            self.0.set_nonblocking(!blocking).map_err(|_| "无法设置本机秘密代理地址状态".to_string())
        }
    }

    /// Socket files do not accept a mode at bind time, so the permission is set
    /// immediately afterwards.
    pub fn restrict(path: &PathBuf) -> Result<(), String> {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "无法限制本机秘密代理地址权限".to_string())
    }

    pub fn remove(path: &PathBuf) {
        let _ = std::fs::remove_file(path);
    }

    pub fn live(path: &PathBuf) -> bool {
        UnixStream::connect(path).is_ok()
    }
}

#[cfg(windows)]
mod platform {
    use std::ffi::OsStr;
    use std::io::{self, Read, Write};
    use std::os::windows::ffi::OsStrExt;
    use std::sync::Mutex;
    use std::time::Duration;
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED, HANDLE, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, ReadFile, WriteFile, FILE_GENERIC_READ, FILE_GENERIC_WRITE, OPEN_EXISTING,
        PIPE_ACCESS_DUPLEX,
    };
    use windows_sys::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, WaitNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
        PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
    };

    pub const TRANSPORT: &str = "named_pipe";

    pub type Address = String;

    /// The test process never connects to an installed desktop application.
    #[cfg(test)]
    pub static ROOT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[cfg(test)]
    pub fn set_root(root: Option<Address>) { *ROOT.lock().unwrap() = root; }

    #[cfg(test)]
    static ROOT: Mutex<Option<Address>> = Mutex::new(None);

    fn wide(text: &str) -> Vec<u16> {
        OsStr::new(text).encode_wide().chain([0]).collect()
    }

    /// The pipe name is per user so two accounts on one machine never share a
    /// rendezvous; the DACL, not the name, is the boundary.
    pub fn address() -> Result<String, String> {
        use sha2::{Digest, Sha256};
        let sid = crate::windows_security::current_sid()?;
        let mut hasher = Sha256::new();
        hasher.update(sid.as_bytes());
        let hash: String = hasher.finalize().iter().take(8).map(|byte| format!("{byte:02x}")).collect();
        let name = format!(r"\\.\pipe\cliora-secret-broker-{hash}");
        #[cfg(test)]
        let name = ROOT.lock().unwrap().clone().unwrap_or_else(|| format!("{name}-test-{}", std::process::id()));
        Ok(name)
    }

    /// An owned pipe handle. A handle is an opaque kernel token rather than a
    /// pointer into Rust memory, so handing it to the thread that serves the
    /// connection transfers ownership without aliasing Rust data; a pending
    /// listener instance stays behind `Listener`'s mutex.
    ///
    /// `Copy` matches the raw handle it wraps: `accept` reads the pending value
    /// and hands it to one `Stream` after replacing the pending instance, so the
    /// bitwise copy never becomes a second owner.
    #[derive(Clone, Copy)]
    struct Handle(HANDLE);

    // SAFETY: a `Handle` owns exactly one kernel handle value and carries no
    // Rust data. A stream is used by one thread at a time and the pending
    // instance is behind a mutex, so moving a handle cannot double-close it or
    // race on Rust memory.
    unsafe impl Send for Handle {}

    pub struct Stream(Handle);

    impl Drop for Stream {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0 .0) };
        }
    }

    impl Stream {
        pub fn connect(name: &str) -> Result<Self, String> {
            let path = wide(name);
            for attempt in 0..2 {
                let handle = unsafe {
                    CreateFileW(
                        path.as_ptr(),
                        FILE_GENERIC_READ | FILE_GENERIC_WRITE,
                        0,
                        std::ptr::null(),
                        OPEN_EXISTING,
                        0,
                        std::ptr::null_mut(),
                    )
                };
                if handle != INVALID_HANDLE_VALUE {
                    return Ok(Self(Handle(handle)));
                }
                if unsafe { GetLastError() } == ERROR_PIPE_BUSY && attempt == 0 {
                    // Every instance was busy: a bounded wait avoids reporting the
                    // proxy offline while a request is already in flight.
                    unsafe { WaitNamedPipeW(path.as_ptr(), 5_000) };
                    continue;
                }
                return Err("未找到正在运行的栖点秘密代理".into());
            }
            Err("未找到正在运行的栖点秘密代理".into())
        }

        pub fn try_clone_stream(&self) -> Option<Self> {
            use windows_sys::Win32::Foundation::{DuplicateHandle, DUPLICATE_SAME_ACCESS};
            use windows_sys::Win32::System::Threading::GetCurrentProcess;
            let process = unsafe { GetCurrentProcess() };
            let mut handle = std::ptr::null_mut();
            let ok = unsafe { DuplicateHandle(process, self.0.0, process, &mut handle, 0, 0, DUPLICATE_SAME_ACCESS) };
            (ok != 0).then(|| Self(Handle(handle)))
        }

        pub fn closed_now(&mut self) -> bool {
            use windows_sys::Win32::System::Pipes::PeekNamedPipe;
            let mut available = 0;
            let ok = unsafe { PeekNamedPipe(self.0.0, std::ptr::null_mut(), 0, std::ptr::null_mut(), &mut available, std::ptr::null_mut()) };
            ok == 0 || available != 0
        }

        pub fn disconnected(&mut self) -> bool {
            if self.closed_now() { return true; }
            std::thread::sleep(super::ACCEPT_POLL);
            false
        }

        pub fn set_read_timeout(&self, _: Option<Duration>) -> io::Result<()> {
            Ok(())
        }
    }

    impl Read for Stream {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            let mut read = 0u32;
            let ok = unsafe {
                ReadFile(self.0 .0, buffer.as_mut_ptr(), buffer.len().min(u32::MAX as usize) as u32, &mut read, std::ptr::null_mut())
            };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(read as usize)
        }
    }

    impl Write for Stream {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            let mut written = 0u32;
            for chunk in buffer.chunks(32 * 1024) {
                let ok = unsafe { WriteFile(self.0 .0, chunk.as_ptr(), chunk.len() as u32, &mut written, std::ptr::null_mut()) };
                if ok == 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            Ok(buffer.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    /// One pipe instance is pending at a time: `accept` hands the connected
    /// instance to a connection and immediately publishes a fresh one.
    pub struct Listener {
        name: Vec<u16>,
        pending: Mutex<Handle>,
    }

    fn instance(name: &[u16]) -> Result<HANDLE, String> {
        let descriptor = crate::windows_security::pipe_security()?;
        let attributes = descriptor.attributes();
        let handle = unsafe {
            CreateNamedPipeW(
                name.as_ptr(),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                PIPE_UNLIMITED_INSTANCES,
                64 * 1024,
                64 * 1024,
                0,
                &attributes,
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err("无法建立本机秘密代理地址".into());
        }
        Ok(handle)
    }

    impl Listener {
        pub fn bind(name: &str) -> Result<Self, String> {
            let path = wide(name);
            let handle = instance(&path)?;
            Ok(Self { name: path, pending: Mutex::new(Handle(handle)) })
        }

        pub fn accept(&self) -> Option<Stream> {
            let handle = *self.pending.lock().ok()?;
            if unsafe { ConnectNamedPipe(handle.0, std::ptr::null_mut()) } == 0
                && unsafe { GetLastError() } != ERROR_PIPE_CONNECTED
            {
                return None;
            }
            // The next instance is published before the connected one is served,
            // so a second caller queues instead of finding a missing name.
            match instance(&self.name) {
                Ok(next) => {
                    if let Ok(mut pending) = self.pending.lock() {
                        *pending = Handle(next);
                    }
                }
                Err(_) => return None,
            }
            Some(Stream(handle))
        }

        /// A blocking pipe wait cannot be interrupted; the loop stops when the
        /// process exits.
        pub fn set_blocking(&self, _: bool) -> Result<(), String> {
            Ok(())
        }
    }

    pub fn restrict(_: &str) -> Result<(), String> {
        Ok(())
    }

    pub fn remove(_: &str) {}

    pub fn live(name: &str) -> bool {
        Stream::connect(name).is_ok()
    }
}
