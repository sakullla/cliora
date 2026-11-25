//! In-memory approval scopes owned by a live workbench process or MCP connection.
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use super::{broker::Kind, ipc::McpPeer};

#[cfg(target_os = "macos")]
#[path = "session_macos.rs"]
mod macos;

pub const ENV: &str = "CLIORA_SECRET_SESSION";

type Binding = (String, String);

struct Entry {
    installation: Option<String>,
    display: String,
    peer: Option<McpPeer>,
    #[cfg(target_os = "macos")]
    root: Option<macos::Process>,
    permissions: HashMap<Binding, Arc<AtomicBool>>,
}

impl Entry {
    fn live(&mut self) -> bool {
        #[cfg(target_os = "macos")]
        if self.root.is_some_and(|root| !root.live()) {
            return false;
        }
        self.peer.as_mut().is_none_or(McpPeer::live)
    }
}

#[cfg(target_os = "macos")]
pub(super) fn for_socket(stream: &std::os::unix::net::UnixStream) -> Option<String> {
    let roots: HashMap<_, _> = sessions().iter()
        .filter_map(|(token, entry)| Some((entry.root?, token.clone())))
        .collect();
    if roots.is_empty() { return None; }
    macos::workbench_peer(stream, &roots)
}

fn sessions() -> MutexGuard<'static, HashMap<String, Entry>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
    SESSIONS
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// Keeping this non-clonable guard alive owns the session. Only its opaque
/// capability goes to the local tool. The independently generated display ID
/// can safely appear in the approval dialog.
pub struct LocalSession {
    token: String,
}

impl LocalSession {
    pub fn new() -> Self {
        Self::create(None, None)
    }

    pub(super) fn mcp(installation: &str, peer: McpPeer) -> Self {
        Self::create(Some(installation.to_owned()), Some(peer))
    }

    fn create(installation: Option<String>, peer: Option<McpPeer>) -> Self {
        let token = uuid::Uuid::new_v4().to_string();
        let display = uuid::Uuid::new_v4().to_string()[..8].to_owned();
        sessions().insert(
            token.clone(),
            Entry {
                installation,
                display,
                peer,
                #[cfg(target_os = "macos")]
                root: None,
                permissions: HashMap::new(),
            },
        );
        Self { token }
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn bind_root(&self, pid: u32) {
        if let Some(entry) = sessions().get_mut(&self.token) {
            entry.root = macos::Process::from_pid(pid);
        }
    }

    pub fn token(&self) -> &str {
        &self.token
    }
}

impl Drop for LocalSession {
    fn drop(&mut self) {
        sessions().remove(&self.token);
    }
}

/// Entries are captured before displaying the prompt. Revoking a binding drops
/// the entry, so even an immediate re-grant cannot revive a pending decision.
pub(super) struct ReadScope {
    token: String,
    pub display: Option<String>,
    pub source: Kind,
    pub pending: Vec<usize>,
    entries: Vec<(Binding, Arc<AtomicBool>)>,
    _single: Option<LocalSession>,
}

impl ReadScope {
    pub fn open(
        token: Option<&str>,
        installation: &str,
        kind: Kind,
        ids: &[String],
    ) -> Option<Self> {
        let single = token.is_none().then(LocalSession::new);
        let key = token.or_else(|| single.as_ref().map(LocalSession::token))?;
        let mut sessions = sessions();
        let entry = sessions.get_mut(key)?;
        if !entry.live() {
            return None;
        }
        if let Some(owner) = &entry.installation {
            if owner != installation || kind != Kind::Mcp {
                return None;
            }
        }
        let display = token.map(|_| entry.display.clone());
        let mut pending = Vec::new();
        let mut entries = Vec::with_capacity(ids.len());
        for (index, id) in ids.iter().enumerate() {
            let pair = (installation.to_owned(), id.clone());
            let permission = entry.permissions.entry(pair.clone()).or_default().clone();
            if !permission.load(Ordering::Relaxed) {
                pending.push(index);
            }
            entries.push((pair, permission));
        }
        let source = if entry.peer.is_some() {
            Kind::Mcp
        } else {
            Kind::Cli
        };
        Some(Self {
            token: key.to_owned(),
            display,
            source,
            pending,
            entries,
            _single: single,
        })
    }

    pub fn finish(&self, remember: bool) -> bool {
        let mut sessions = sessions();
        let Some(entry) = sessions.get_mut(&self.token) else {
            return false;
        };
        if !entry.live() {
            return false;
        }
        if !self.entries.iter().all(|(pair, observed)| {
            entry
                .permissions
                .get(pair)
                .is_some_and(|current| Arc::ptr_eq(current, observed))
        }) {
            return false;
        }
        if remember && self.display.is_some() {
            for (_, permission) in &self.entries {
                permission.store(true, Ordering::Relaxed);
            }
        }
        true
    }
}

pub(super) fn invalidate(installation: Option<&str>, secret: Option<&str>) {
    for entry in sessions().values_mut() {
        entry.permissions.retain(|(owner, id), _| {
            !installation.is_none_or(|value| owner == value)
                || !secret.is_none_or(|value| id == value)
        });
    }
}
