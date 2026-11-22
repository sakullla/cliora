//! Desktop decisions for one batch of secret references. The window receives
//! only aliases, source and available choices.
use serde::Serialize;
use std::collections::HashMap;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// A person may need a moment to read the risk notice; the request still expires
/// so an abandoned prompt cannot authorize a later read.
pub const APPROVAL_TIMEOUT: Duration = Duration::from_secs(120);

/// What the confirmation host displays. No field can carry a value.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prompt {
    pub approval_id: String,
    pub alias: String,
    pub aliases: Vec<String>,
    pub session_available: bool,
    /// Human-readable origin of the request, e.g. the CLI label and its scope.
    pub source: String,
    pub expires_in_seconds: u64,
}

/// The application confirmation host. `ask` returns once the request is on its
/// way; the answer arrives through `answer`.
pub trait Host: Send + Sync {
    fn ask(&self, prompt: &Prompt) -> Result<(), String>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Accepted,
    Session,
    Declined,
    Expired,
    /// No confirmation host could show the request (window gone, event failure).
    Unavailable,
}

struct Entry {
    sender: Sender<Verdict>,
    session_available: bool,
}

/// Pending reads. The registry is process-wide so the answer command can reach
/// the request a helper started on another thread.
#[derive(Default)]
pub struct Pending {
    entries: Mutex<HashMap<String, Entry>>,
}

fn pending() -> &'static Pending {
    static PENDING: OnceLock<Pending> = OnceLock::new();
    PENDING.get_or_init(Pending::default)
}

impl Pending {
    /// The id is the only handle the window receives. Because the broker creates
    /// it for one installation and a named batch, settling it can only answer that
    /// request: a different installation has no id to answer with.
    fn open(&self, session_available: bool) -> Result<(String, Receiver<Verdict>), String> {
        let id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = channel();
        let mut entries = self.entries.lock().map_err(|_| "确认请求暂时不可用".to_string())?;
        entries.insert(id.clone(), Entry { sender, session_available });
        Ok((id, receiver))
    }

    fn remove(&self, approval_id: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.remove(approval_id);
        }
    }

    fn settle(&self, approval_id: &str, accepted: bool, remember: bool) -> Result<(), String> {
        let mut entries = self.entries.lock().map_err(|_| "确认请求暂时不可用".to_string())?;
        let entry = entries
            .remove(approval_id)
            .ok_or_else(|| "确认请求已结束或已过期".to_string())?;
        entry
            .sender
            .send(match (accepted, remember, entry.session_available) {
                (true, true, true) => Verdict::Session,
                (true, false, _) => Verdict::Accepted,
                _ => Verdict::Declined,
            })
            .map_err(|_| "确认请求已过期".to_string())
    }
}

/// Answers a pending read. A second answer for the same id finds nothing, so a
/// repeated click or a replayed answer authorizes nothing.
pub fn answer(approval_id: &str, accepted: bool) -> Result<(), String> {
    answer_scoped(approval_id, accepted, false)
}

pub fn answer_scoped(approval_id: &str, accepted: bool, remember: bool) -> Result<(), String> {
    if uuid::Uuid::parse_str(approval_id).is_err() {
        return Err("确认请求标识无效".into());
    }
    pending().settle(approval_id, accepted, remember)
}

/// Asks the host and waits for the answer. The returned verdict is the only
/// thing the caller may act on.
pub fn request(host: &dyn Host, alias: &str, source: &str) -> Verdict {
    request_with_timeout(host, alias, source, APPROVAL_TIMEOUT)
}

pub fn request_with_timeout(host: &dyn Host, alias: &str, source: &str, timeout: Duration) -> Verdict {
    request_batch(host, vec![alias.to_owned()], source, false, timeout)
}

pub(super) fn request_batch(host: &dyn Host, aliases: Vec<String>, source: &str, session_available: bool, timeout: Duration) -> Verdict {
    let Ok((approval_id, receiver)) = pending().open(session_available) else {
        return Verdict::Unavailable;
    };
    let prompt = Prompt {
        approval_id: approval_id.clone(),
        alias: aliases.first().cloned().unwrap_or_default(),
        aliases,
        session_available,
        source: source.to_owned(),
        expires_in_seconds: timeout.as_secs(),
    };
    if host.ask(&prompt).is_err() {
        pending().remove(&approval_id);
        return Verdict::Unavailable;
    }
    match receiver.recv_timeout(timeout) {
        Ok(verdict) => verdict,
        Err(RecvTimeoutError::Timeout) => {
            pending().remove(&approval_id);
            Verdict::Expired
        }
        Err(RecvTimeoutError::Disconnected) => Verdict::Unavailable,
    }
}
