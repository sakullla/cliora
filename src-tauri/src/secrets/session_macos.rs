//! Associate a local IPC peer with a still-running workbench child, even when
//! the CLI clears its environment before executing the secret helper.
use std::collections::HashMap;
use std::mem::{size_of, MaybeUninit};
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub(super) struct Process {
    pid: u32,
    started: (u64, u64),
}

impl Process {
    fn snapshot(pid: u32) -> Option<(Self, u32)> {
        if pid <= 1 {
            return None;
        }
        let mut info = MaybeUninit::<libc::proc_bsdinfo>::uninit();
        let size = size_of::<libc::proc_bsdinfo>() as libc::c_int;
        // proc_pidinfo initializes this SDK structure on a full-size return.
        let count = unsafe {
            libc::proc_pidinfo(
                pid.try_into().ok()?,
                libc::PROC_PIDTBSDINFO,
                0,
                info.as_mut_ptr().cast(),
                size,
            )
        };
        if count != size {
            return None;
        }
        let info = unsafe { info.assume_init() };
        if info.pbi_pid != pid || info.pbi_status == libc::SZOMB || info.pbi_start_tvsec == 0 {
            return None;
        }
        let process = Self {
            pid,
            started: (info.pbi_start_tvsec, info.pbi_start_tvusec),
        };
        Some((process, info.pbi_ppid))
    }

    pub(super) fn from_pid(pid: u32) -> Option<Self> {
        Self::snapshot(pid).map(|(process, _)| process)
    }

    pub(super) fn live(self) -> bool {
        Self::from_pid(self.pid) == Some(self)
    }
}

// SDK audit_token_t is eight opaque unsigned integers. libbsm extracts its PID.
#[repr(C)]
#[derive(Clone, Copy)]
struct AuditToken([u32; 8]);

#[link(name = "bsm")]
unsafe extern "C" {
    fn audit_token_to_pid(token: AuditToken) -> libc::pid_t;
}

impl AuditToken {
    fn peer(stream: &UnixStream) -> Option<Self> {
        let mut token = Self([0; 8]);
        let mut len = size_of::<Self>() as libc::socklen_t;
        let status = unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_LOCAL,
                libc::LOCAL_PEERTOKEN,
                (&mut token as *mut Self).cast(),
                &mut len,
            )
        };
        (status == 0 && len as usize == size_of::<Self>()).then_some(token)
    }

    fn live(&mut self) -> bool {
        // macOS 11+ also checks the audit token's PID version. Resolve this
        // optional API at runtime so older Intel builds retain single-use reads.
        type Probe = unsafe extern "C" fn(*mut AuditToken, *mut libc::c_void, u32) -> libc::c_int;
        let symbol =
            unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"proc_pidpath_audittoken".as_ptr()) };
        if symbol.is_null() {
            return false;
        }
        let probe = unsafe { std::mem::transmute::<*mut libc::c_void, Probe>(symbol) };
        let mut unused_path = [0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        unsafe {
            probe(
                self,
                unused_path.as_mut_ptr().cast(),
                unused_path.len() as u32,
            ) > 0
        }
    }
}

pub(super) fn workbench_peer(
    stream: &UnixStream,
    roots: &HashMap<Process, String>,
) -> Option<String> {
    let mut token = AuditToken::peer(stream)?;
    let pid = unsafe { audit_token_to_pid(token) }.try_into().ok()?;
    let mut child = Process::snapshot(pid)?;
    for _ in 0..128 {
        if let Some(session) = roots.get(&child.0) {
            // Reject a socket retained after its original connecting process
            // exited or exec'ed. The broker rechecks root liveness at approval.
            return token.live().then(|| session.clone());
        }
        let parent = Process::snapshot(child.1)?;
        // Re-check the edge after looking up the parent. A dying or reparented
        // child cannot attach us to an unrelated process that recycled its PID.
        if Process::snapshot(child.0.pid) != Some(child) {
            return None;
        }
        child = parent;
    }
    None
}
