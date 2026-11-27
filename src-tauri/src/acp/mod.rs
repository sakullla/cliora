//! Shared ACP (Agent Client Protocol) conversation host.
//!
//! A local ACP agent is an ordinary child process that speaks JSON-RPC over
//! its standard input and output. This module owns everything that is the same
//! for every CLI: frame boundaries, request correlation, turn lifecycle, the
//! ordered timeline (messages, tool calls, notices, turn ends, subagents),
//! session settings, permission requests, cancellation, exit cleanup and the
//! retained snapshot a re-mounted view reads. Adapters only declare the
//! program, its arguments and the environment policy; nothing here knows a
//! product id.
//!
//! Boundaries this module keeps:
//!
//! - Standard output carries the protocol; standard error only produces a
//!   bounded, redacted diagnostic. Neither is forwarded to a terminal.
//! - Client capabilities are published only when the client can honour them
//!   (see `capabilities::client_capabilities`). A request for a capability the
//!   host did not advertise is answered with "method not found".
//! - File and terminal requests are served inside the session directory; a
//!   path or working directory outside it needs the user's approval, a session
//!   grant or YOLO (`access`). Cliora's own data is refused under any grant
//!   (`crate::safe_fs`). Terminal commands run without a shell as process
//!   trees the host ends on kill, release and session close (`terminal`).
//! - A permission request is bound to the live connection, the session (or a
//!   registered child session) and the turn that asked for it, and is answered
//!   at most once.
//! - A user-raised card with no turn (an outside image the user dropped)
//!   never holds `waiting_permission`, is withdrawn by Stop or session end,
//!   and accepts only allow once or deny.
//! - A prompt turn has no fixed deadline: it ends with the agent's own answer,
//!   the agent's exit or the user's stop. Every other request keeps the
//!   configured timeout. Only the agent's exit (or a closed connection) ends a
//!   turn as `disconnected`; a JSON-RPC error the agent answers the prompt with
//!   ends it as `failed`, with the agent's (redacted) reason as a notice, and
//!   the session stays usable.
//! - An agent that answers session/new with auth_required leaves the session
//!   waiting for a login (`auth_required`) instead of failing it; a login
//!   through `authenticate` then creates (or resumes) the session. A prompt
//!   answered with auth_required waits for a login the same way; that login
//!   keeps the protocol session it interrupted. Cliora never reads or stores
//!   the credentials.
//! - An elicitation form (`elicitation`) is bound like an authorization card:
//!   answered at most once, withdrawn with a cancel on stop, turn end or
//!   session end.
//! - A prompt's attachments (`prompt`) follow the agent's prompt capabilities;
//!   a file outside the directory needs the same approval as an agent's read.
//!   The project file list (`files`) and the native session history
//!   (`history`) never leave the session directory or the declared
//!   capabilities.
//! - A prompt body may hold a cliora-secret reference. The host never resolves
//!   it: the agent reaches the secret broker through the local session token,
//!   exactly like the terminal launch. No protocol body is logged here, and
//!   only the agent's own redacted standard error is retained.

pub mod access;
pub mod capabilities;
pub mod client_fs;
pub mod elicitation;
pub mod files;
pub mod history;
pub mod prompt;
pub mod terminal;
pub mod timeline;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Condvar, LazyLock, Mutex, MutexGuard, OnceLock};
use std::time::Duration;
#[cfg(test)]
use std::time::Instant;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::adapters::{AcpCommand, LaunchMode};
use crate::launch::LaunchPlan;

pub use capabilities::{
    AcpAgentDescriptor, AcpAuthMethod, AcpAvailableCommand, AcpConfigChoice, AcpConfigOption, AcpCost,
    AcpImplementation, AcpMode, AcpModel, AcpModels, AcpModes, AcpPlanEntry, AcpPromptCapabilities,
    AcpSessionCapabilities, AcpSessionConfig, AcpSessionInfo, AcpUsage, LEGACY_MODEL_CONFIG_ID,
};
pub use access::{AccessAnswer, AccessKind};
pub use files::AcpFileList;
pub use history::{AcpNativeSession, AcpNativeSessionPage};
pub use prompt::{AcpAttachment, AcpImageFile};
pub use terminal::{AcpTerminal, AcpTerminalExit};
pub use timeline::{
    AcpAccess, AcpAttachmentLabel, AcpElicitation, AcpFileDiff, AcpMessage, AcpNotice, AcpPermissionOption,
    AcpPermissionRequest, AcpSubagent, AcpTimelineItem, AcpToolCall, AcpToolContent, AcpToolLocation, AcpTurnEnd,
};
use timeline::Timeline;

/// One conversation event, scoped to its session so two panels never mix.
pub const EVENT: &str = "cliora:acp-event";
/// A single protocol line longer than this is a broken session, not something
/// to buffer without bound.
const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
/// Retained standard-error lines.
const MAX_DIAGNOSTICS: usize = 40;
/// Retained text per diagnostic line.
const MAX_DIAGNOSTIC_CHARS: usize = 500;
/// The kind recorded for a permission option the agent sent without one. It
/// matches no allow or reject kind, so nothing approves it automatically.
pub const UNKNOWN_PERMISSION_KIND: &str = "unknown";
/// The protocol's "authentication required" error code.
pub const AUTH_REQUIRED_CODE: i64 = -32000;
/// An `authenticate` request may wait for the user to finish a login the agent
/// opened (a browser, a device code), so it waits at least this long.
const AUTH_TIMEOUT_FLOOR: Duration = Duration::from_secs(300);

/// A failed protocol request: the agent's error code when it sent one (none
/// for a timeout or an exit) and a redacted message.
#[derive(Clone, Debug)]
pub(crate) struct RpcError {
    pub code: Option<i64>,
    pub message: String,
    /// The agent itself answered with a JSON-RPC error; false for a timeout,
    /// a write failure or an exit, which the host reports on its own.
    pub reply: bool,
}

impl RpcError {
    fn local(message: impl Into<String>) -> Self {
        Self { code: None, message: message.into(), reply: false }
    }
}

/// A reentrant lock that orders one session's publications (see
/// `Session::order`). Reentrant because a change may notice, settle and
/// publish while it already holds the order.
#[derive(Default)]
struct Order {
    owner: Mutex<(Option<std::thread::ThreadId>, usize)>,
    free: Condvar,
}

struct OrderGuard<'a>(&'a Order);

impl Order {
    fn lock(&self) -> OrderGuard<'_> {
        let me = std::thread::current().id();
        let mut owner = guard(&self.owner);
        loop {
            match owner.0 {
                None => {
                    *owner = (Some(me), 1);
                    break;
                }
                Some(holder) if holder == me => {
                    owner.1 += 1;
                    break;
                }
                Some(_) => owner = self.free.wait(owner).unwrap_or_else(|error| error.into_inner()),
            }
        }
        OrderGuard(self)
    }
}

impl Drop for OrderGuard<'_> {
    fn drop(&mut self) {
        let mut owner = guard(&self.0.owner);
        owner.1 = owner.1.saturating_sub(1);
        if owner.1 == 0 {
            owner.0 = None;
            self.0.free.notify_one();
        }
    }
}

/// Why establishing the protocol session did not finish.
enum SetupError {
    /// The agent wants the user to log in first; the session waits for that.
    AuthRequired(String),
    Failed(String),
}

static APP: OnceLock<AppHandle> = OnceLock::new();
static SESSIONS: LazyLock<Mutex<HashMap<String, Arc<Session>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Where an ACP conversation starts.
#[derive(Clone, Debug)]
pub struct AcpStart {
    pub tool_id: String,
    pub project_id: Option<String>,
    pub directory: PathBuf,
    pub mode: LaunchMode,
    /// Program, arguments and environment resolved by the adapter.
    pub command: AcpCommand,
    /// Extra variables the plan already holds (remote wiring, account context).
    pub environment: Vec<(String, String)>,
    pub remove_environment: Vec<String>,
    /// The stored connection key, handed over at spawn time only.
    pub credential: Option<(String, String)>,
    /// Session markers a nested terminal session must not inherit.
    pub session_markers: &'static [&'static str],
    /// First turn submitted once the session exists.
    pub initial_prompt: Option<String>,
    /// Native session to load instead of creating one. Honoured only when the
    /// agent negotiates loadSession; otherwise a new session is created and the
    /// snapshot reports why.
    pub resume_native_id: Option<String>,
    /// How long one protocol request may wait for its response. A prompt turn
    /// is not a request with a deadline and never uses this.
    pub timeout: Duration,
    /// A session mode to switch to once the session exists: the entry's
    /// declared YOLO mode, for a YOLO launch only.
    pub yolo_mode: Option<String>,
}

impl AcpStart {
    /// Build the start specification from a planned launch. The planner already
    /// validated the entry, the installation and the working directory.
    pub fn from_plan(plan: &LaunchPlan, credential: Option<(String, String)>) -> Result<Self, String> {
        let command = plan.acp.clone().ok_or("此启动不是 ACP 对话，未解析到 ACP 入口")?;
        let mut remove_environment = command.remove_environment.clone();
        if let Some((_, context)) = &plan.account_context {
            for key in &context.remove_environment {
                if !remove_environment.contains(key) {
                    remove_environment.push(key.clone());
                }
            }
        }
        let mut environment = command.environment.clone();
        environment.extend(plan.environment.iter().cloned());
        if let Some((_, context)) = &plan.account_context {
            environment.extend(
                context
                    .environment
                    .iter()
                    .map(|(name, value)| (name.clone(), value.clone())),
            );
        }
        let yolo_mode = if plan.mode == LaunchMode::Yolo { command.yolo_mode.clone() } else { None };
        Ok(Self {
            tool_id: plan.tool_id.clone(),
            project_id: plan.project_id.clone(),
            directory: plan.directory.clone(),
            mode: plan.mode,
            yolo_mode,
            command,
            environment,
            remove_environment,
            credential,
            session_markers: plan.session_markers,
            initial_prompt: plan
                .initial_prompt
                .as_deref()
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(ToOwned::to_owned),
            resume_native_id: plan.resume_native_id.clone(),
            timeout: Duration::from_secs(120),
        })
    }
}

/// Full state of one conversation, for a view that mounts later.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpSessionSnapshot {
    pub id: String,
    pub tool_id: String,
    pub project_id: Option<String>,
    pub directory: String,
    pub mode: LaunchMode,
    /// Always acp: a snapshot only exists for a conversation session.
    pub interaction: &'static str,
    /// One of starting, auth_required, ready, running, stopping,
    /// waiting_permission, closed or failed. "stopping" is a turn the user
    /// stopped that has not reported its own result yet; "auth_required" waits
    /// for the user to log in with one of `agent.authMethods`.
    pub state: &'static str,
    pub native_session_id: Option<String>,
    /// One of none, unsupported, loaded (replayed through session/load),
    /// resumed (session/resume, no replay) or failed.
    pub resume: &'static str,
    /// Why the session still needs a login: the agent's own answer, or the
    /// reason the last authentication failed. None once logged in.
    pub auth_error: Option<String>,
    /// Everything the conversation produced, in arrival order.
    pub timeline: Vec<AcpTimelineItem>,
    /// Request ids still waiting for the user's answer: authorization cards,
    /// out-of-directory approval cards and elicitation forms.
    pub pending: Vec<String>,
    /// Access categories (read, write, execute) the user allowed for the rest
    /// of this session. YOLO is the session's mode, not a grant.
    pub grants: Vec<&'static str>,
    /// Terminals the agent created, with their bounded output.
    pub terminals: Vec<AcpTerminal>,
    /// The agent's current plan; empty when it has none.
    pub plan: Vec<AcpPlanEntry>,
    /// The slash commands the agent currently offers.
    pub commands: Vec<AcpAvailableCommand>,
    /// Modes, configuration options and the legacy model list.
    pub config: AcpSessionConfig,
    /// Title and usage, as far as the agent reported them.
    pub info: AcpSessionInfo,
    /// What the agent declared during initialize.
    pub agent: AcpAgentDescriptor,
    pub diagnostics: Vec<String>,
    /// The reason the last turn ended: one of end_turn, limit, refusal,
    /// cancelled, disconnected, failed or unknown. An empty string means no turn
    /// has ended yet; "unknown" means the agent ended the turn without a reason
    /// this host recognizes.
    pub last_turn_reason: &'static str,
    pub seq: u64,
}

/// One ordered event. A chunk carries only the text the agent just appended;
/// the snapshot holds the accumulated message.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpEvent {
    pub session_id: String,
    pub seq: u64,
    #[serde(flatten)]
    pub update: AcpUpdate,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AcpUpdate {
    /// The whole conversation; it replaces whatever the view held.
    Snapshot { snapshot: Box<AcpSessionSnapshot> },
    /// Text appended to one message. A message id the view does not hold yet
    /// starts a new message at the end of the timeline.
    Chunk { message_id: String, role: &'static str, text: String, truncated: bool, turn_id: String, subagent: Option<String> },
    /// The whole current state of one tool call, merged in place.
    Tool { call: AcpToolCall },
    /// Any other timeline item (notice, turn end, subagent, session message),
    /// inserted or replaced in place.
    Item { item: AcpTimelineItem },
    /// The whole plan; an empty list clears it.
    Plan { entries: Vec<AcpPlanEntry> },
    /// The whole command list.
    Commands { commands: Vec<AcpAvailableCommand> },
    /// The whole session configuration.
    Config { config: AcpSessionConfig },
    /// Title and usage.
    Info { info: AcpSessionInfo },
    /// The request ids still waiting for an answer.
    Pending { pending: Vec<String> },
    /// A terminal the agent created; it replaces the view's copy.
    Terminal { terminal: AcpTerminal },
    /// Output appended to a terminal: drop `dropped` UTF-16 code units from the head of (held output + text); exit and release are reported here too.
    TerminalOutput { terminal_id: String, text: String, dropped: usize, truncated: bool, exit_status: Option<AcpTerminalExit>, released: bool },
}

/// The streams a session talks to. A subprocess supplies its pipes; a test
/// supplies an in-memory pair, so the protocol is exercised without an
/// external agent, a model or a paid inference call.
pub(crate) struct AcpIo {
    pub reader: Box<dyn Read + Send>,
    pub writer: Box<dyn Write + Send>,
    /// The agent's standard error: diagnostics only, never conversation.
    pub diagnostics: Option<Box<dyn Read + Send>>,
    /// Stops the agent. A test pair simply drops its stream.
    #[allow(clippy::type_complexity)]
    pub shutdown: Option<Box<dyn FnMut() + Send>>,
}

fn guard<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

fn sessions() -> MutexGuard<'static, HashMap<String, Arc<Session>>> {
    guard(&SESSIONS)
}

/// A diagnostic line never carries a secret reference or a token-shaped run.
pub fn redact(line: &str) -> String {
    let mut text = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(start) = rest.find("{{cliora-secret:") {
        text.push_str(&rest[..start]);
        match rest[start..].find("}}") {
            Some(end) => {
                text.push_str("{{cliora-secret:<已隐藏>}}");
                rest = &rest[start + end + 2..];
            }
            None => {
                text.push_str("{{cliora-secret:<已隐藏>");
                rest = "";
            }
        }
    }
    text.push_str(rest);
    // A long unbroken run of token characters is treated as a credential.
    let mut masked = String::with_capacity(text.len());
    let mut run = String::new();
    fn flush(run: &mut String, masked: &mut String) {
        if run.len() >= 32 {
            masked.push_str("<已隐藏>");
        } else {
            masked.push_str(run);
        }
        run.clear();
    }
    for character in text.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '+' | '/' | '=' | '.') {
            run.push(character);
        } else {
            flush(&mut run, &mut masked);
            masked.push(character);
        }
    }
    flush(&mut run, &mut masked);
    if masked.chars().count() > MAX_DIAGNOSTIC_CHARS {
        let kept: String = masked.chars().take(MAX_DIAGNOSTIC_CHARS).collect();
        return format!("{kept}…（已截断）");
    }
    masked
}

/// An open authorization request: the protocol id to answer and the tool call
/// whose card shows it.
struct PendingPermission {
    id: Value,
    request_id: String,
    item_id: String,
    turn_id: String,
    options: Vec<AcpPermissionOption>,
}

struct Turn {
    id: String,
    cancel_requested: bool,
    /// How far the prompt got. Changed only under the turn lock, so a stop
    /// and the turn's own thread agree on who tells the agent to cancel.
    phase: TurnPhase,
}

/// Where a turn's prompt stands.
#[derive(Clone, Copy, PartialEq, Eq)]
enum TurnPhase {
    /// The attachments are being resolved (maybe waiting for an approval):
    /// nothing reached the agent, and a stop simply ends the turn.
    Preparing,
    /// Committed to send: the prompt is being written. A stop now is sent by
    /// the turn's own thread right after the prompt, never before it.
    Sending,
    /// The prompt is on the wire: a stop sends session/cancel itself.
    Sent,
}

/// Which session an incoming frame speaks for.
enum Scope {
    /// The conversation itself.
    Root,
    /// A registered child session.
    Child(String),
    /// Some other session: not ours to show.
    Foreign,
}

pub(crate) struct Session {
    id: String,
    tool_id: String,
    project_id: Option<String>,
    directory: PathBuf,
    mode: LaunchMode,
    state: Mutex<&'static str>,
    native_session_id: Mutex<Option<String>>,
    resume: Mutex<&'static str>,
    timeline: Mutex<Timeline>,
    permissions: Mutex<Vec<PendingPermission>>,
    plan: Mutex<Vec<AcpPlanEntry>>,
    commands: Mutex<Vec<AcpAvailableCommand>>,
    config: Mutex<AcpSessionConfig>,
    info: Mutex<AcpSessionInfo>,
    agent: Mutex<AcpAgentDescriptor>,
    /// Registered child sessions and the session that owns each (None: the
    /// conversation itself).
    children: Mutex<HashMap<String, Option<String>>>,
    diagnostics: Mutex<Vec<String>>,
    last_turn_reason: Mutex<&'static str>,
    seq: AtomicU64,
    /// Orders state changes, their seq and their events (see `order`).
    order: Order,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    #[allow(clippy::type_complexity)]
    shutdown: Mutex<Option<Box<dyn FnMut() + Send>>>,
    requests: Mutex<HashMap<u64, Sender<Result<Value, RpcError>>>>,
    next_request: AtomicU64,
    /// Why the session still needs a login (see the snapshot field).
    auth_error: Mutex<Option<String>>,
    /// The native session the launch asked to continue; kept so a login can
    /// retry it.
    resume_target: Option<String>,
    /// The launch's first prompt until it has been submitted (or dropped
    /// because the requested resume did not happen).
    initial_prompt: Mutex<Option<String>>,
    /// A session mode to switch to once the session exists (YOLO entries).
    yolo_mode: Option<String>,
    /// A session/load is replaying history: chunks without a message id are
    /// distinct history messages, not increments of the latest one.
    replaying: AtomicBool,
    /// Elicitation forms still waiting for an answer.
    elicitations: Mutex<Vec<elicitation::PendingElicitation>>,
    /// The project files offered to `@` references, briefly cached.
    files: Mutex<Option<files::FileIndex>>,
    turn: Mutex<Option<Turn>>,
    timeout: Duration,
    /// The local secret-broker approval scope. Keeping this guard alive is what
    /// makes a secret reference usable for exactly this session.
    secret_session: Mutex<Option<crate::secrets::session::LocalSession>>,
    /// A YOLO launch: out-of-directory access and the agent's authorization
    /// requests are approved by the host.
    yolo: bool,
    /// Categories allowed for the rest of this session.
    grants: Mutex<access::Grants>,
    /// Out-of-directory approval cards still waiting for an answer.
    accesses: Mutex<Vec<access::PendingAccess>>,
    terminals: Mutex<terminal::Terminals>,
    /// Signalled when a terminal exits or is released.
    terminal_changed: Condvar,
    /// The environment a terminal command receives: the agent's own.
    terminal_environment: ChildEnvironment,
}

impl Session {
    fn new(
        id: String,
        spec: &AcpStart,
        writer: Box<dyn Write + Send>,
        shutdown: Option<Box<dyn FnMut() + Send>>,
        secret_session: Option<crate::secrets::session::LocalSession>,
    ) -> Self {
        Self {
            id,
            tool_id: spec.tool_id.clone(),
            project_id: spec.project_id.clone(),
            directory: spec.directory.clone(),
            mode: spec.mode,
            state: Mutex::new("starting"),
            native_session_id: Mutex::new(None),
            resume: Mutex::new("none"),
            timeline: Mutex::new(Timeline::default()),
            permissions: Mutex::new(Vec::new()),
            plan: Mutex::new(Vec::new()),
            commands: Mutex::new(Vec::new()),
            config: Mutex::new(AcpSessionConfig::default()),
            info: Mutex::new(AcpSessionInfo::default()),
            agent: Mutex::new(AcpAgentDescriptor::default()),
            children: Mutex::new(HashMap::new()),
            diagnostics: Mutex::new(Vec::new()),
            last_turn_reason: Mutex::new(""),
            seq: AtomicU64::new(0),
            order: Order::default(),
            writer: Mutex::new(Some(writer)),
            shutdown: Mutex::new(shutdown),
            requests: Mutex::new(HashMap::new()),
            next_request: AtomicU64::new(0),
            auth_error: Mutex::new(None),
            resume_target: spec.resume_native_id.clone(),
            initial_prompt: Mutex::new(spec.initial_prompt.clone()),
            yolo_mode: spec.yolo_mode.clone(),
            replaying: AtomicBool::new(false),
            elicitations: Mutex::new(Vec::new()),
            files: Mutex::new(None),
            turn: Mutex::new(None),
            timeout: spec.timeout,
            secret_session: Mutex::new(secret_session),
            yolo: spec.mode == LaunchMode::Yolo,
            grants: Mutex::new(access::Grants::default()),
            accesses: Mutex::new(Vec::new()),
            terminals: Mutex::new(terminal::Terminals::default()),
            terminal_changed: Condvar::new(),
            terminal_environment: child_environment(spec),
        }
    }

    /// Hold the session's publication order. A change that the view learns
    /// through a delta holds it from the change to the emit, and a snapshot
    /// holds it while it is read and emitted. So a snapshot contains exactly
    /// the changes whose events carry a lower seq, and events leave in seq
    /// order. Reentrant on one thread; never taken while a state lock is held,
    /// and never held across a wait for the agent or the user.
    fn order(&self) -> OrderGuard<'_> {
        self.order.lock()
    }

    /// Emit the whole conversation. The snapshot carries the seq of its own
    /// event, read under the publication order.
    fn publish(&self) {
        let _order = self.order();
        let mut snapshot = self.snapshot();
        let seq = self.next_seq();
        snapshot.seq = seq;
        emit(AcpEvent { session_id: self.id.clone(), seq, update: AcpUpdate::Snapshot { snapshot: Box::new(snapshot) } });
    }

    fn next_seq(&self) -> u64 {
        self.seq.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Emit one delta. The caller that changed state for it holds `order()`
    /// across the change and this call.
    fn emit_update(&self, update: AcpUpdate) {
        let _order = self.order();
        emit(AcpEvent { session_id: self.id.clone(), seq: self.next_seq(), update });
    }

    fn pending_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> =
            guard(&self.permissions).iter().map(|pending| pending.request_id.clone()).collect();
        ids.extend(self.access_pending_ids());
        ids.extend(self.elicitation_pending_ids());
        ids
    }

    fn emit_pending(&self) {
        let _order = self.order();
        self.emit_update(AcpUpdate::Pending { pending: self.pending_ids() });
    }

    /// The whole state, read under the publication order: every change whose
    /// event has been numbered is in it, none whose event has not.
    fn snapshot(&self) -> AcpSessionSnapshot {
        let _order = self.order();
        AcpSessionSnapshot {
            id: self.id.clone(),
            tool_id: self.tool_id.clone(),
            project_id: self.project_id.clone(),
            directory: self.directory.display().to_string(),
            mode: self.mode,
            interaction: "acp",
            state: *guard(&self.state),
            native_session_id: guard(&self.native_session_id).clone(),
            resume: *guard(&self.resume),
            auth_error: guard(&self.auth_error).clone(),
            timeline: guard(&self.timeline).items().to_vec(),
            pending: self.pending_ids(),
            grants: guard(&self.grants).list(),
            terminals: guard(&self.terminals).states(),
            plan: guard(&self.plan).clone(),
            commands: guard(&self.commands).clone(),
            config: guard(&self.config).clone(),
            info: guard(&self.info).clone(),
            agent: guard(&self.agent).clone(),
            diagnostics: guard(&self.diagnostics).clone(),
            last_turn_reason: *guard(&self.last_turn_reason),
            seq: self.seq.load(Ordering::SeqCst),
        }
    }

    fn current_turn_id(&self) -> String {
        guard(&self.turn).as_ref().map(|turn| turn.id.clone()).unwrap_or_default()
    }

    /// The state a live session returns to: only a pending card bound to a
    /// turn (the agent's permission, access or form request) keeps it
    /// `waiting_permission`; a user-raised card without a turn never does. An
    /// active turn keeps it running, otherwise it is ready.
    fn settle_state(&self) {
        // Read and decide under the publication order: a stop that marks the
        // session stopping does so under the same order, so whichever runs
        // last sees the other's change (the turn gone, or stopping set).
        let _order = self.order();
        // A closed or failed session never comes back: a late turn result only
        // records its reason.
        if matches!(*guard(&self.state), "closed" | "failed") {
            return;
        }
        // A session that is still being set up (or waits for a login) keeps
        // that state: a form answered meanwhile must not make it look ready.
        if matches!(*guard(&self.state), "starting" | "auth_required") {
            self.publish();
            return;
        }
        let previous = *guard(&self.state);
        // The user's own card (a dropped image) waits in the pending list but
        // never masks the turn: a running turn stays running (and stoppable),
        // an idle session stays ready.
        let waiting = !guard(&self.permissions).is_empty()
            || self.agent_access_waiting()
            || !guard(&self.elicitations).is_empty();
        let running = guard(&self.turn).is_some();
        *guard(&self.state) = if waiting {
            "waiting_permission"
        } else if running {
            // A stop was requested but the agent has not reported its own
            // result yet: the turn is still open, so the session stays stopping
            // instead of looking running again.
            if previous == "stopping" {
                "stopping"
            } else {
                "running"
            }
        } else {
            "ready"
        };
        self.publish();
    }

    fn diagnostic(&self, line: &str) {
        let line = redact(line.trim_end_matches('\r'));
        if line.trim().is_empty() {
            return;
        }
        let mut diagnostics = guard(&self.diagnostics);
        diagnostics.push(line);
        let overflow = diagnostics.len().saturating_sub(MAX_DIAGNOSTICS);
        if overflow > 0 {
            diagnostics.drain(..overflow);
        }
    }

    /// A host notice enters the timeline, so a view that mounts later still
    /// reads it in its place.
    fn notice(&self, level: &'static str, code: &'static str, text: impl Into<String>) {
        let turn_id = self.current_turn_id();
        let _order = self.order();
        let item = {
            let mut timeline = guard(&self.timeline);
            let id = timeline.auto_id("notice");
            let item = AcpTimelineItem::Notice(AcpNotice { id, level, code, text: text.into(), turn_id });
            timeline.upsert(item.clone());
            item
        };
        self.emit_update(AcpUpdate::Item { item });
    }

    /// Drop the oldest finished history once the timeline is over budget, and
    /// republish the whole conversation so every view drops the same items.
    fn trim_timeline(&self) {
        let turn = guard(&self.turn).as_ref().map(|turn| turn.id.clone());
        let trimmed = guard(&self.timeline).trim(turn.as_deref());
        if trimmed {
            self.publish();
        }
    }

    fn write_value(&self, value: &Value) -> Result<(), String> {
        let mut frame = serde_json::to_vec(value).map_err(|error| format!("无法编码协议帧：{error}"))?;
        frame.push(b'\n');
        let mut writer = guard(&self.writer);
        let Some(writer) = writer.as_mut() else {
            return Err("会话已结束，无法继续对话".into());
        };
        writer
            .write_all(&frame)
            .and_then(|()| writer.flush())
            .map_err(|error| format!("无法写入 ACP 协议：{error}"))
    }

    /// Register and write one request. The frame is on the wire when this
    /// returns, so a later notification (a stop, a second turn) can never be
    /// observed before the request it belongs to.
    fn send_request(
        &self,
        method: &str,
        params: Value,
    ) -> Result<(u64, std::sync::mpsc::Receiver<Result<Value, RpcError>>), String> {
        let id = self.next_request.fetch_add(1, Ordering::SeqCst) + 1;
        let (sender, receiver) = std::sync::mpsc::channel();
        guard(&self.requests).insert(id, sender);
        let frame = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if let Err(error) = self.write_value(&frame) {
            guard(&self.requests).remove(&id);
            return Err(error);
        }
        Ok((id, receiver))
    }

    /// One request with the configured deadline. A prompt turn does not use
    /// this: it has no deadline of its own.
    fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.request_raw(method, params, self.timeout).map_err(|error| error.message)
    }

    /// One request with an explicit deadline, keeping the agent's error code.
    fn request_raw(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, RpcError> {
        let (id, receiver) = self.send_request(method, params).map_err(RpcError::local)?;
        match receiver.recv_timeout(timeout) {
            Ok(result) => result,
            Err(_) => {
                guard(&self.requests).remove(&id);
                Err(RpcError::local(format!("等待 agent 回应 {method} 超时，请确认该 CLI 支持 ACP")))
            }
        }
    }

    fn resolve_response(&self, id: u64, result: Result<Value, RpcError>) {
        if let Some(sender) = guard(&self.requests).remove(&id) {
            let _ = sender.send(result);
        }
    }

    fn handle_line(self: &Arc<Self>, line: &[u8]) {
        let text = match std::str::from_utf8(line) {
            Ok(text) => text.trim(),
            Err(_) => {
                self.diagnostic("协议行不是有效 UTF-8，已忽略");
                return;
            }
        };
        if text.is_empty() {
            return;
        }
        let value: Value = match serde_json::from_str(text) {
            Ok(value) => value,
            Err(_) => {
                self.diagnostic("协议行不是 JSON，已忽略");
                return;
            }
        };
        if let Some(id) = value.get("id") {
            if value.get("method").is_none() {
                let Some(number) = id.as_u64() else { return };
                if let Some(error) = value.get("error") {
                    let message = error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("agent 拒绝了该请求");
                    let code = error.get("code").and_then(Value::as_i64);
                    self.resolve_response(number, Err(RpcError { code, message: redact(message), reply: true }));
                } else {
                    self.resolve_response(number, Ok(value.get("result").cloned().unwrap_or(Value::Null)));
                }
                return;
            }
            let method = value.get("method").and_then(Value::as_str).unwrap_or_default().to_owned();
            self.handle_request(&method, id.clone(), value.get("params").cloned().unwrap_or(Value::Null));
            return;
        }
        let method = value.get("method").and_then(Value::as_str).unwrap_or_default().to_owned();
        self.handle_notification(&method, value.get("params").cloned().unwrap_or(Value::Null));
    }

    /// The session a frame names: the conversation, a registered child, or a
    /// session this connection never showed. Before the conversation's own id
    /// is known every frame is the conversation's.
    fn scope_of(&self, params: &Value) -> Scope {
        let Some(sent) = params.get("sessionId").and_then(Value::as_str) else {
            return Scope::Root;
        };
        let native = guard(&self.native_session_id).clone();
        if native.as_deref() == Some(sent) {
            return Scope::Root;
        }
        if guard(&self.children).contains_key(sent) {
            return Scope::Child(sent.to_owned());
        }
        if native.is_none() {
            Scope::Root
        } else {
            Scope::Foreign
        }
    }

    fn handle_request(self: &Arc<Self>, method: &str, id: Value, params: Value) {
        match method {
            "session/request_permission" => self.open_permission(id, params),
            "elicitation/create" => self.open_elicitation(id, params),
            "fs/read_text_file" | "fs/write_text_file" | "terminal/create" | "terminal/output"
            | "terminal/wait_for_exit" | "terminal/kill" | "terminal/release" => self.serve_client(method, id, params),
            // Only advertised capabilities are served; anything else is refused
            // explicitly instead of left hanging.
            _ => {
                let _ = self.write_value(&json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32601, "message": "客户端未提供该能力" },
                }));
                self.diagnostic(&format!("agent 请求了未声明的客户端能力：{method}"));
            }
        }
    }

    /// Serve one file-system or terminal request on its own worker: an
    /// approval card or a wait for exit must never stall the protocol reader.
    /// Each request is answered exactly once, with its result or an error.
    fn serve_client(self: &Arc<Self>, method: &str, id: Value, params: Value) {
        let subagent = match self.scope_of(&params) {
            Scope::Root => None,
            Scope::Child(child) => Some(child),
            Scope::Foreign => {
                self.answer_error(&id, -32602, "该请求不属于本会话");
                self.diagnostic(&format!("收到其他会话的客户端请求：{method}"));
                return;
            }
        };
        let session = Arc::clone(self);
        let method = method.to_owned();
        std::thread::spawn(move || {
            let child = subagent.as_deref();
            let result = match method.as_str() {
                "fs/read_text_file" => session.read_text_file(child, &params),
                "fs/write_text_file" => session.write_text_file(child, &params),
                "terminal/create" => session.create_terminal(child, &params),
                "terminal/output" => session.terminal_output(&params),
                "terminal/wait_for_exit" => session.wait_for_exit(&params),
                "terminal/kill" => params
                    .get("terminalId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "缺少参数 terminalId".to_string())
                    .and_then(|terminal| session.kill_terminal(terminal))
                    .map(|()| json!({})),
                "terminal/release" => params
                    .get("terminalId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "缺少参数 terminalId".to_string())
                    .and_then(|terminal| session.release_terminal(terminal))
                    .map(|()| json!({})),
                _ => Err("客户端未提供该能力".to_string()),
            };
            match result {
                Ok(value) => session.answer_result(&id, value),
                Err(error) => session.answer_error(&id, -32603, &error),
            }
        });
    }

    fn answer_permission(&self, id: &Value, outcome: Value) -> Result<(), String> {
        self.write_value(&json!({ "jsonrpc": "2.0", "id": id, "result": { "outcome": outcome } }))
    }

    fn open_permission(&self, id: Value, params: Value) {
        let cancelled_outcome = json!({ "outcome": "cancelled" });
        let subagent = match self.scope_of(&params) {
            Scope::Root => None,
            Scope::Child(child) => Some(child),
            Scope::Foreign => {
                let _ = self.answer_permission(&id, cancelled_outcome);
                self.diagnostic("收到其他会话的授权请求，已取消");
                return;
            }
        };
        let request_id = id.to_string();
        let (turn_id, cancelled) = {
            let turn = guard(&self.turn);
            (
                turn.as_ref().map(|turn| turn.id.clone()).unwrap_or_default(),
                turn.as_ref().is_some_and(|turn| turn.cancel_requested),
            )
        };
        let options: Vec<AcpPermissionOption> = params
            .get("options")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        Some(AcpPermissionOption {
                            option_id: item.get("optionId").and_then(Value::as_str)?.to_owned(),
                            name: item.get("name").and_then(Value::as_str).unwrap_or("选项").to_owned(),
                            // ACP requires a kind on every option. A missing one is
                            // never guessed as an allow kind: anything that picks
                            // options by kind (YOLO) must not approve it.
                            kind: item
                                .get("kind")
                                .and_then(Value::as_str)
                                .unwrap_or(UNKNOWN_PERMISSION_KIND)
                                .to_owned(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        // A card asked for by a turn the user already stopped is withdrawn as
        // soon as it arrives: it must never appear under a stopped turn.
        if cancelled {
            let _ = self.answer_permission(&id, cancelled_outcome);
            self.notice("warning", "permission_cancelled", "本轮已停止，新的授权请求已取消");
            return;
        }
        // The conversation's own request needs a live turn. A child's request
        // is accepted without one, because a child keeps working after its
        // parent's turn ended; such a request carries no turn and stays open
        // until it is answered, the user stops a turn, or the session ends. A child's request that arrives
        // during a parent turn carries that turn's id, so it is withdrawn with
        // the turn's other cards when that turn ends (see finish_turn).
        if options.is_empty() || (turn_id.is_empty() && subagent.is_none()) {
            let _ = self.answer_permission(&id, cancelled_outcome);
            self.notice("warning", "permission_orphaned", "该授权请求不对应进行中的轮次，已取消");
            return;
        }
        let mut tool = params.get("toolCall").cloned().unwrap_or_else(|| json!({}));
        if !tool.is_object() {
            tool = json!({});
        }
        if tool.get("toolCallId").and_then(Value::as_str).is_none() {
            tool["toolCallId"] = Value::String(format!("permission-{request_id}"));
        }
        // YOLO picks an allow-once option at once and records the decision.
        // A request without one (only allow-always, only rejections) still
        // reaches the user: an "always" rule could outlive this session.
        if self.yolo {
            if let Some(option) = Self::yolo_option(&options).cloned() {
                let call = {
                    let _order = self.order();
                    let call = guard(&self.timeline).upsert_tool(subagent.as_deref(), &turn_id, &tool, "工具调用");
                    if let Some(call) = &call {
                        self.emit_update(AcpUpdate::Tool { call: call.clone() });
                    }
                    call
                };
                let _ = self.answer_permission(&id, json!({ "outcome": "selected", "optionId": option.option_id }));
                let title = call.map(|call| call.title).unwrap_or_else(|| "工具调用".to_owned());
                self.notice("info", "yolo_allowed", format!("已自动允许：{title}（{}）", option.name));
                return;
            }
        }
        let order = self.order();
        let call = {
            let mut timeline = guard(&self.timeline);
            timeline
                .upsert_tool(subagent.as_deref(), &turn_id, &tool, "工具调用需要授权")
                .and_then(|call| {
                    timeline.set_permission(
                        &call.id,
                        Some(AcpPermissionRequest {
                            request_id: request_id.clone(),
                            turn_id: turn_id.clone(),
                            options: options.clone(),
                        }),
                    )
                })
        };
        let Some(call) = call else {
            drop(order);
            let _ = self.answer_permission(&id, cancelled_outcome);
            self.diagnostic("授权请求缺少工具调用，已取消");
            return;
        };
        guard(&self.permissions).push(PendingPermission {
            id,
            request_id,
            item_id: call.id.clone(),
            turn_id,
            options,
        });
        self.emit_update(AcpUpdate::Tool { call });
        self.emit_pending();
        drop(order);
        self.settle_state();
    }

    /// Answer a request the user no longer can, and take its card off the
    /// tool call. The caller publishes the new pending set.
    fn withdraw(&self, pending: PendingPermission) {
        let _ = self.answer_permission(&pending.id, json!({ "outcome": "cancelled" }));
        let _order = self.order();
        let call = guard(&self.timeline).set_permission(&pending.item_id, None);
        if let Some(call) = call {
            self.emit_update(AcpUpdate::Tool { call });
        }
    }

    fn handle_notification(&self, method: &str, params: Value) {
        match method {
            "session/update" => self.apply_update(params),
            _ => self.diagnostic(&format!("未处理的通知：{method}")),
        }
    }

    fn apply_update(&self, params: Value) {
        let subagent = match self.scope_of(&params) {
            Scope::Root => None,
            Scope::Child(child) => Some(child),
            Scope::Foreign => {
                self.diagnostic("收到其他会话的更新，已忽略");
                return;
            }
        };
        let update = params.get("update").cloned().unwrap_or(Value::Null);
        let kind = update.get("sessionUpdate").and_then(Value::as_str).unwrap_or_default();
        let child = subagent.as_deref();
        // Every session update changes state and emits its delta under the
        // publication order, so a snapshot read meanwhile never holds a change
        // whose event comes after it. Nothing here waits for anyone.
        let _order = self.order();
        match kind {
            "agent_message_chunk" => self.append_chunk("agent", &update, child),
            "agent_thought_chunk" => self.append_chunk("thought", &update, child),
            "user_message_chunk" => self.append_chunk("user", &update, child),
            "session_message_chunk" => self.append_chunk("session", &update, child),
            "session_message" => self.session_message(&update, child),
            "tool_call" | "tool_call_update" => self.upsert_tool(&update, child),
            "subagent_update" => self.register_subagent(&update, child),
            // A child's own plan, commands, settings, title and usage describe
            // the child, not this conversation; its commands must never be
            // offered as input.
            "plan" | "available_commands_update" | "current_mode_update" | "config_option_update"
            | "session_info_update" | "usage_update"
                if child.is_some() => {}
            "plan" => {
                let entries = capabilities::parse_plan(&update);
                *guard(&self.plan) = entries.clone();
                self.emit_update(AcpUpdate::Plan { entries });
            }
            "available_commands_update" => {
                let commands = capabilities::parse_commands(&update);
                *guard(&self.commands) = commands.clone();
                self.emit_update(AcpUpdate::Commands { commands });
            }
            "current_mode_update" => {
                let Some(current) = update.get("currentModeId").and_then(Value::as_str) else {
                    self.diagnostic("模式更新缺少模式编号，已忽略");
                    return;
                };
                let config = {
                    let mut config = guard(&self.config);
                    match config.modes.as_mut() {
                        Some(modes) => modes.current_mode_id = current.to_owned(),
                        None => {
                            config.modes = Some(AcpModes {
                                current_mode_id: current.to_owned(),
                                available_modes: Vec::new(),
                            })
                        }
                    }
                    config.clone()
                };
                self.emit_update(AcpUpdate::Config { config });
            }
            "config_option_update" => {
                let config = {
                    let mut config = guard(&self.config);
                    config.options =
                        capabilities::parse_config_options(update.get("configOptions").unwrap_or(&Value::Null));
                    config.clone()
                };
                self.emit_update(AcpUpdate::Config { config });
            }
            "session_info_update" => {
                let info = {
                    let mut info = guard(&self.info);
                    capabilities::apply_session_info(&mut info, &update);
                    info.clone()
                };
                self.emit_update(AcpUpdate::Info { info });
            }
            "usage_update" => {
                let Some(usage) = capabilities::parse_usage(&update) else {
                    self.diagnostic("用量更新缺少字段，已忽略");
                    return;
                };
                let info = {
                    let mut info = guard(&self.info);
                    info.usage = Some(usage);
                    info.clone()
                };
                self.emit_update(AcpUpdate::Info { info });
            }
            other => self.diagnostic(&format!("未处理的会话更新：{other}")),
        }
    }

    fn append_chunk(&self, role: &'static str, update: &Value, subagent: Option<&str>) {
        let Some(text) = update.get("content").and_then(timeline::block_text) else { return };
        if text.is_empty() {
            return;
        }
        let turn_id = self.current_turn_id();
        let outcome = {
            let mut timeline = guard(&self.timeline);
            // History replayed by session/load arrives without turns. A replayed
            // block without a message id is one history message: it gets an id
            // of its own (role and replay order) instead of continuing the
            // previous block, so two messages never fold into one.
            let replayed = match update.get("messageId").and_then(Value::as_str) {
                Some(_) => None,
                None if self.replaying.load(Ordering::SeqCst) => Some(timeline.auto_id(&format!("replay-{role}"))),
                None => None,
            };
            let message_id = update.get("messageId").and_then(Value::as_str).or(replayed.as_deref());
            timeline.append_chunk(role, message_id, subagent, &turn_id, &text)
        };
        if outcome.text.is_empty() {
            return;
        }
        self.emit_update(AcpUpdate::Chunk {
            message_id: outcome.id,
            role: outcome.role,
            text: outcome.text,
            truncated: outcome.truncated,
            turn_id: outcome.turn_id,
            subagent: outcome.subagent,
        });
        self.trim_timeline();
    }

    /// A message another session sent, as it appears in this transcript. Its
    /// content replaces whatever the message held.
    fn session_message(&self, update: &Value, subagent: Option<&str>) {
        let Some(message_id) = update.get("messageId").and_then(Value::as_str) else {
            self.diagnostic("会话消息缺少消息编号，已忽略");
            return;
        };
        let Some(content) = update.get("content") else { return };
        let text = content
            .as_array()
            .map(|blocks| blocks.iter().filter_map(timeline::block_text).collect::<Vec<_>>().join("\n"))
            .unwrap_or_default();
        let turn_id = self.current_turn_id();
        let item = guard(&self.timeline).set_message("session", message_id, subagent, &turn_id, &text);
        self.emit_update(AcpUpdate::Item { item });
        self.trim_timeline();
    }

    fn upsert_tool(&self, update: &Value, subagent: Option<&str>) {
        let turn_id = self.current_turn_id();
        let call = guard(&self.timeline).upsert_tool(subagent, &turn_id, update, "工具调用");
        let Some(call) = call else {
            self.diagnostic("工具更新缺少调用编号，已忽略");
            return;
        };
        self.emit_update(AcpUpdate::Tool { call });
        self.trim_timeline();
    }

    /// Register or patch a child session. The first announcement fixes the
    /// child's owner; a later update cannot move it, and the conversation can
    /// never become its own child.
    fn register_subagent(&self, update: &Value, owner: Option<&str>) {
        let Some(child) = update.get("sessionId").and_then(Value::as_str) else {
            self.diagnostic("子会话更新缺少会话编号，已忽略");
            return;
        };
        let native = guard(&self.native_session_id).clone();
        if native.as_deref() == Some(child) || owner == Some(child) {
            self.diagnostic("子会话更新指向会话自身，已忽略");
            return;
        }
        let parent = {
            let mut children = guard(&self.children);
            children
                .entry(child.to_owned())
                .or_insert_with(|| owner.map(ToOwned::to_owned))
                .clone()
        };
        let turn_id = self.current_turn_id();
        let item = {
            let mut timeline = guard(&self.timeline);
            let id = timeline::subagent_item_id(child);
            let mut entry = match timeline.get(&id) {
                Some(AcpTimelineItem::Subagent(existing)) => existing.clone(),
                _ => AcpSubagent {
                    id,
                    session_id: child.to_owned(),
                    parent,
                    title: None,
                    description: None,
                    state: None,
                    stop_reason: None,
                    summary: String::new(),
                    turn_id,
                },
            };
            let text = |value: &Value| value.as_str().map(|text| timeline::cap(text, 1_000).0);
            if let Some(title) = update.get("title") {
                entry.title = text(title);
            }
            if let Some(description) = update.get("description") {
                entry.description = text(description);
            }
            if let Some(state) = update.get("state") {
                entry.state = state.get("state").and_then(Value::as_str).map(|value| timeline::cap(value, 100).0);
                entry.stop_reason =
                    state.get("stopReason").and_then(Value::as_str).map(|value| timeline::cap(value, 100).0);
            }
            entry.summary = timeline.subagent_summary(child);
            let item = AcpTimelineItem::Subagent(entry);
            timeline.upsert(item.clone());
            item
        };
        self.emit_update(AcpUpdate::Item { item });
    }

    /// Start one turn. Only one turn may run at a time; a failure to send is
    /// reported to the caller instead of becoming a silent gap. The turn has no
    /// deadline: it ends with the agent's answer, its exit or the user's stop.
    fn begin_turn(self: &Arc<Self>, text: &str, attachments: &[AcpAttachment]) -> Result<(), String> {
        if matches!(*guard(&self.state), "starting" | "auth_required") {
            return Err("会话尚未建立，请先完成登录或等待连接".into());
        }
        // Images are checked before a turn exists: a refused attachment never
        // opens a turn the agent will not see.
        self.check_attachments(attachments)?;
        let turn_id = {
            let mut turn = guard(&self.turn);
            if turn.is_some() {
                return Err("当前轮次尚未结束，请先停止或等待结果".into());
            }
            let turn_id = format!("turn-{}", self.next_seq());
            *turn = Some(Turn { id: turn_id.clone(), cancel_requested: false, phase: TurnPhase::Preparing });
            turn_id
        };
        // The user's message enters the timeline first, so an approval card
        // its attachment raises stands after the message that caused it. The
        // labels are provisional until the files are resolved.
        let message_id = format!("{turn_id}-user");
        let (capped, truncated) = timeline::cap(text, timeline::MAX_MESSAGE_CHARS);
        let user_message = |labels: Vec<AcpAttachmentLabel>| {
            AcpTimelineItem::Message(AcpMessage {
                id: message_id.clone(),
                role: "user",
                text: capped.clone(),
                truncated,
                turn_id: turn_id.clone(),
                subagent: None,
                attachments: labels,
            })
        };
        let provisional: Vec<AcpAttachmentLabel> = attachments
            .iter()
            .map(|attachment| match attachment {
                AcpAttachment::Image { mime_type, .. } => {
                    AcpAttachmentLabel { kind: "image", name: mime_type.clone(), delivery: None }
                }
                AcpAttachment::File { path } => {
                    AcpAttachmentLabel { kind: "file", name: path.replace('\\', "/"), delivery: None }
                }
            })
            .collect();
        guard(&self.timeline).upsert(user_message(provisional));
        self.settle_state();
        // A file outside the directory asks for approval under this turn, so
        // the turn exists before the files are resolved. Any refusal ends the
        // turn before anything reached the agent.
        let built = self.prompt_blocks(text, attachments).and_then(|built| {
            // A stop that arrived while an attachment waited for approval
            // ends the turn here: the prompt was never sent. Otherwise the
            // turn commits to sending, under the same lock a stop checks.
            let mut turn = guard(&self.turn);
            match turn.as_mut() {
                Some(turn) if turn.id == turn_id && !turn.cancel_requested => {
                    turn.phase = TurnPhase::Sending;
                    Ok(built)
                }
                _ => Err("本轮已停止，提示词没有发送".to_string()),
            }
        });
        let (blocks, labels) = match built {
            Ok(built) => built,
            Err(error) => {
                {
                    let mut turn = guard(&self.turn);
                    if turn.as_ref().is_some_and(|turn| turn.id == turn_id) {
                        *turn = None;
                    }
                }
                // Nothing reached the agent: the message leaves the timeline.
                guard(&self.timeline).remove(&message_id);
                self.settle_state();
                return Err(error);
            }
        };
        guard(&self.timeline).upsert(user_message(labels));
        self.settle_state();
        let native = guard(&self.native_session_id).clone().unwrap_or_default();
        let params = json!({
            "sessionId": native,
            "prompt": blocks,
        });
        // The prompt must be written before this returns: a stop or a second
        // turn issued right after must never overtake it on the wire.
        let (_, receiver) = match self.send_request("session/prompt", params) {
            Ok(pair) => pair,
            Err(error) => {
                *guard(&self.turn) = None;
                self.settle_state();
                return Err(error);
            }
        };
        // A stop that arrived while the prompt was being written left the
        // cancel to this thread, so it follows the prompt on the wire.
        let stop_requested = {
            let mut turn = guard(&self.turn);
            match turn.as_mut() {
                Some(turn) if turn.id == turn_id => {
                    turn.phase = TurnPhase::Sent;
                    turn.cancel_requested
                }
                _ => false,
            }
        };
        if stop_requested {
            let _ = self.write_value(&json!({
                "jsonrpc": "2.0",
                "method": "session/cancel",
                "params": { "sessionId": native },
            }));
        }
        let session = Arc::clone(self);
        std::thread::spawn(move || {
            // No deadline: a long turn is still a turn. The sender is dropped
            // or answered with a local error when the agent exits; only that
            // is a lost connection. The agent's own error reply ends the turn
            // as failed and the session stays usable; an auth_required reply
            // waits for a login instead, keeping the protocol session.
            let reason = match receiver.recv() {
                Ok(Ok(result)) => stop_reason(result.get("stopReason").and_then(Value::as_str)),
                Ok(Err(error)) if error.reply && session.needs_login(&error, false) => {
                    // Waiting for the login first: the turn's end then
                    // settles into auth_required, never briefly into ready.
                    session.require_auth(redact(&error.message));
                    "failed"
                }
                Ok(Err(error)) if error.reply => {
                    session.notice("error", "prompt_failed", format!("agent 未能完成本轮：{}", redact(&error.message)));
                    "failed"
                }
                Ok(Err(error)) => {
                    session.notice("error", "", error.message);
                    "disconnected"
                }
                Err(_) => "disconnected",
            };
            session.finish_turn(&turn_id, reason);
        });
        Ok(())
    }

    fn finish_turn(&self, turn_id: &str, reason: &'static str) {
        *guard(&self.last_turn_reason) = reason;
        {
            let mut turn = guard(&self.turn);
            if turn.as_ref().is_some_and(|turn| turn.id == turn_id) {
                *turn = None;
            }
        }
        // A card of a finished turn can no longer be answered: the turn it
        // belonged to is over, so it leaves the panel and the agent is told.
        let dropped: Vec<PendingPermission> = {
            let mut permissions = guard(&self.permissions);
            let (dropped, kept) = std::mem::take(&mut *permissions)
                .into_iter()
                .partition(|pending| pending.turn_id == turn_id);
            *permissions = kept;
            dropped
        };
        let mut withdrew = !dropped.is_empty();
        for pending in dropped {
            self.withdraw(pending);
        }
        withdrew |= self.withdraw_accesses(|pending| pending.turn_id == turn_id);
        withdrew |= self.withdraw_elicitations(|pending| pending.turn_id == turn_id);
        if withdrew {
            self.emit_pending();
        }
        let item = AcpTimelineItem::Turn(AcpTurnEnd {
            id: format!("{turn_id}-end"),
            turn_id: turn_id.to_owned(),
            reason,
        });
        {
            let _order = self.order();
            guard(&self.timeline).upsert(item.clone());
            self.emit_update(AcpUpdate::Item { item });
        }
        self.settle_state();
    }

    fn cancel_turn(&self) -> Result<(), String> {
        let native = guard(&self.native_session_id).clone().unwrap_or_default();
        let (turn_id, phase) = {
            let mut turn = guard(&self.turn);
            let Some(turn) = turn.as_mut() else {
                return Err("当前没有进行中的轮次".into());
            };
            turn.cancel_requested = true;
            (turn.id.clone(), turn.phase)
        };
        // A card from this turn cannot be answered any more: the user withdrew
        // the whole turn, so the cards leave the panel now rather than waiting
        // for the agent's own result. Whoever clicks a retired card is refused,
        // because it is no longer in the pending list.
        let withdrawn: Vec<PendingPermission> = std::mem::take(&mut *guard(&self.permissions));
        let mut withdrew = !withdrawn.is_empty();
        for pending in withdrawn {
            self.withdraw(pending);
        }
        withdrew |= self.withdraw_accesses(|_| true);
        withdrew |= self.withdraw_elicitations(|_| true);
        if withdrew {
            self.emit_pending();
        }
        // Only a prompt on the wire is cancelled through the protocol. One
        // still being prepared never reaches the agent (its thread ends the
        // turn), and one being written is cancelled by its own thread right
        // after it.
        if phase == TurnPhase::Sent {
            self.write_value(&json!({
                "jsonrpc": "2.0",
                "method": "session/cancel",
                "params": { "sessionId": native },
            }))?;
        }
        // The turn stays open until the agent reports its own result: a stop
        // request is not a stop confirmation, so the session shows stopping.
        // That holds only while this same turn is still open: a turn that
        // already ended (or never sent its prompt and ended above) has
        // settled, and stopping would never be cleared.
        {
            let _order = self.order();
            let open = guard(&self.turn).as_ref().is_some_and(|turn| turn.id == turn_id);
            if open && !matches!(*guard(&self.state), "closed" | "failed") {
                *guard(&self.state) = "stopping";
            }
            self.publish();
        }
        Ok(())
    }

    fn respond(&self, request_id: &str, option_id: Option<&str>) -> Result<(), String> {
        let pending = {
            let mut permissions = guard(&self.permissions);
            let index = permissions
                .iter()
                .position(|item| item.request_id == request_id)
                .ok_or("该授权请求已失效或已回答")?;
            if let Some(option) = option_id {
                // An option outside the card is not an answer: keep the card.
                if !permissions[index].options.iter().any(|item| item.option_id == option) {
                    return Err("该选项不属于此授权请求".into());
                }
            }
            permissions.remove(index)
        };
        let outcome = match option_id {
            Some(option) => json!({ "outcome": "selected", "optionId": option }),
            None => json!({ "outcome": "cancelled" }),
        };
        let written = self.answer_permission(&pending.id, outcome);
        {
            let _order = self.order();
            let call = guard(&self.timeline).set_permission(&pending.item_id, None);
            if let Some(call) = call {
                self.emit_update(AcpUpdate::Tool { call });
            }
        }
        self.emit_pending();
        self.settle_state();
        written
    }

    /// Switch the session mode. The mode must be one the agent declared. A
    /// refused switch keeps the previous mode, and the unchanged snapshot is
    /// published so a view that already showed the new value returns to it.
    fn set_mode(&self, mode_id: &str) -> Result<(), String> {
        let declared = guard(&self.config)
            .modes
            .as_ref()
            .map(|modes| modes.available_modes.iter().any(|mode| mode.id == mode_id));
        match declared {
            None => return Err("该 agent 没有声明会话模式".into()),
            Some(false) => return Err("该模式不在 agent 声明的模式中".into()),
            Some(true) => {}
        }
        let native = guard(&self.native_session_id).clone().unwrap_or_default();
        if let Err(error) = self.request("session/set_mode", json!({ "sessionId": native, "modeId": mode_id })) {
            self.publish();
            return Err(format!("切换模式失败：{error}"));
        }
        let _order = self.order();
        let config = {
            let mut config = guard(&self.config);
            if let Some(modes) = config.modes.as_mut() {
                modes.current_mode_id = mode_id.to_owned();
            }
            config.clone()
        };
        self.emit_update(AcpUpdate::Config { config });
        Ok(())
    }

    /// Set one configuration option (or the legacy model). The value must fit
    /// the option the agent declared. A refused change keeps the previous
    /// value and republishes it.
    fn set_config(&self, config_id: &str, value: &Value) -> Result<(), String> {
        let native = guard(&self.native_session_id).clone().unwrap_or_default();
        let (method, params) = {
            let config = guard(&self.config);
            if let Some(option) = config.options.iter().find(|option| option.id == config_id) {
                match option.kind {
                    "boolean" => {
                        let Some(flag) = value.as_bool() else {
                            return Err("该配置项只接受开或关".into());
                        };
                        (
                            "session/set_config_option",
                            json!({ "sessionId": native, "configId": config_id, "type": "boolean", "value": flag }),
                        )
                    }
                    _ => {
                        let Some(choice) = value.as_str() else {
                            return Err("该配置项需要选择一个取值".into());
                        };
                        if !option.options.iter().any(|item| item.value == choice) {
                            return Err("该取值不在 agent 声明的选项中".into());
                        }
                        (
                            "session/set_config_option",
                            json!({ "sessionId": native, "configId": config_id, "value": choice }),
                        )
                    }
                }
            } else if config_id == LEGACY_MODEL_CONFIG_ID && config.models.is_some() {
                let Some(model) = value.as_str() else {
                    return Err("模型需要选择一个取值".into());
                };
                let known = config
                    .models
                    .as_ref()
                    .is_some_and(|models| models.available_models.iter().any(|item| item.model_id == model));
                if !known {
                    return Err("该模型不在 agent 声明的模型中".into());
                }
                ("session/set_model", json!({ "sessionId": native, "modelId": model }))
            } else {
                return Err("该 agent 没有声明这个配置项".into());
            }
        };
        let result = match self.request(method, params) {
            Ok(result) => result,
            Err(error) => {
                self.publish();
                return Err(format!("修改配置失败：{error}"));
            }
        };
        let _order = self.order();
        let config = {
            let mut config = guard(&self.config);
            if method == "session/set_model" {
                if let (Some(models), Some(model)) = (config.models.as_mut(), value.as_str()) {
                    models.current_model_id = model.to_owned();
                }
            } else if let Some(options) = result.get("configOptions").filter(|value| value.is_array()) {
                // The answer carries the full set: other options may have moved too.
                config.options = capabilities::parse_config_options(options);
            } else if let Some(option) = config.options.iter_mut().find(|option| option.id == config_id) {
                option.current_value = value.clone();
            }
            config.clone()
        };
        self.emit_update(AcpUpdate::Config { config });
        Ok(())
    }

    /// Final cleanup. Content stays for the view; the connection, its waiting
    /// requests and its authorization cards do not.
    fn exited(&self, exit_code: Option<i32>) {
        // An open form is answered with a cancel while the connection may
        // still carry it; after this nothing can answer it.
        self.withdraw_elicitations(|_| true);
        guard(&self.writer).take();
        if let Some(mut shutdown) = guard(&self.shutdown).take() {
            shutdown();
        }
        guard(&self.secret_session).take();
        *guard(&self.turn) = None;
        // Approval cards are refused and every command the agent started ends
        // with the session: nothing it ran outlives the conversation.
        self.withdraw_accesses(|_| true);
        self.close_terminals();
        let dropped: Vec<PendingPermission> = std::mem::take(&mut *guard(&self.permissions));
        {
            let mut timeline = guard(&self.timeline);
            for pending in &dropped {
                timeline.set_permission(&pending.item_id, None);
            }
        }
        let waiting: Vec<u64> = guard(&self.requests).keys().copied().collect();
        for id in waiting {
            self.resolve_response(id, Err(RpcError::local("agent 已退出")));
        }
        if *guard(&self.state) != "failed" {
            *guard(&self.state) = "closed";
        }
        if (*guard(&self.last_turn_reason)).is_empty() {
            *guard(&self.last_turn_reason) = "disconnected";
        }
        self.diagnostic(&format!(
            "agent 已退出{}",
            exit_code.map(|code| format!("（退出码 {code}）")).unwrap_or_default()
        ));
        self.publish();
    }

    fn fail(&self, message: &str) {
        *guard(&self.state) = "failed";
        *guard(&self.last_turn_reason) = "failed";
        self.diagnostic(message);
        self.notice("error", "", message.to_owned());
        self.publish();
    }
}

/// The turn outcome, as a closed set. A missing or unrecognized reason is its
/// own outcome: the turn did end, but claiming it ended normally would tell the
/// user the agent finished the work when it may have stopped for a reason this
/// host does not know.
fn stop_reason(reason: Option<&str>) -> &'static str {
    match reason {
        Some("end_turn") => "end_turn",
        Some("max_tokens") | Some("max_turn_requests") => "limit",
        Some("refusal") => "refusal",
        Some("cancelled") => "cancelled",
        _ => "unknown",
    }
}

/// What a turn's ending means for the user, in the closed set the UI shows.
pub fn turn_reason_text(reason: &str) -> &'static str {
    match reason {
        "end_turn" => "本轮结束，可以继续输入",
        "limit" => "本轮达到该 agent 的回合或输出上限，可再次发送",
        "refusal" => "agent 拒绝了本轮请求",
        "cancelled" => "本轮已停止",
        "disconnected" => "与 agent 的连接已断开，可新建会话重试",
        "failed" => "agent 返回了错误，本轮未完成，可修改后再次发送",
        "unknown" => "agent 报告了未知的结束原因，本轮已结束，可再次发送",
        _ => "本轮已结束",
    }
}

fn emit(event: AcpEvent) {
    #[cfg(test)]
    tests::record(&event);
    if let Some(app) = APP.get() {
        let _ = app.emit(EVENT, event);
    }
}

pub fn install(app: AppHandle) {
    use tauri::Manager;
    // Cliora's own data (database, credentials, sessions) is never served to
    // an agent, whatever it was granted.
    let paths = app.path();
    for directory in [paths.app_data_dir(), paths.app_local_data_dir(), paths.app_config_dir()]
        .into_iter()
        .flatten()
    {
        crate::safe_fs::protect(&directory);
    }
    let _ = APP.set(app);
}

pub fn list() -> Vec<AcpSessionSnapshot> {
    let mut snapshots: Vec<_> = sessions().values().map(|session| session.snapshot()).collect();
    snapshots.sort_by(|left, right| left.id.cmp(&right.id));
    snapshots
}

pub fn snapshot(id: &str) -> Result<AcpSessionSnapshot, String> {
    Ok(lookup(id)?.snapshot())
}

pub fn native_session_id(id: &str) -> Option<String> {
    sessions().get(id).and_then(|session| guard(&session.native_session_id).clone())
}

/// The ids of every conversation the host still holds, live or ended.
pub fn list_ids() -> Vec<String> {
    let mut ids: Vec<String> = sessions().keys().cloned().collect();
    ids.sort();
    ids
}

/// Submit one turn of plain text.
pub fn prompt(id: &str, text: &str) -> Result<(), String> {
    prompt_with(id, text, &[])
}

/// Submit one turn: the text and its attachments. An image needs the agent's
/// image capability; a file inside the session directory is embedded or
/// linked, one outside it needs the user's approval first.
pub fn prompt_with(id: &str, text: &str, attachments: &[AcpAttachment]) -> Result<(), String> {
    if text.trim().is_empty() && attachments.is_empty() {
        return Err("提示词为空".into());
    }
    lookup(id)?.begin_turn(text, attachments)
}

/// Log in with one of the methods the agent declared, then create (or
/// resume) the protocol session. A failure keeps the session waiting for a
/// login and records why, so the user can retry.
pub fn authenticate(id: &str, method_id: &str) -> Result<(), String> {
    lookup(id)?.authenticate(method_id)
}

/// Answer an open elicitation form once: accept (with content), decline or
/// cancel. A late or repeated answer is refused.
pub fn respond_elicitation(id: &str, request_id: &str, action: &str, content: Option<&Value>) -> Result<(), String> {
    lookup(id)?.respond_elicitation(request_id, action, content)
}

/// Files inside the session directory, as relative paths, for `@` references.
pub fn list_files(id: &str, query: &str, limit: usize) -> Result<AcpFileList, String> {
    lookup(id)?.list_files(query, limit)
}

/// Read an image file the user dropped on the composer, for its preview and an
/// image block. Inside the session directory it is read directly; outside, the
/// access rules apply with a card of the user's own (see `access`). Refused
/// with the reason when the agent did not declare images, the format or header
/// is wrong, or the file is over the limit.
pub fn read_image(id: &str, path: &str) -> Result<AcpImageFile, String> {
    lookup(id)?.read_image(path)
}

/// One page of the agent's own session history for this directory.
pub fn native_sessions(id: &str, cursor: Option<&str>) -> Result<AcpNativeSessionPage, String> {
    lookup(id)?.native_sessions(cursor)
}

/// Remove one native session from the agent's history.
pub fn delete_native_session(id: &str, native_id: &str) -> Result<(), String> {
    lookup(id)?.delete_native_session(native_id)
}

pub fn cancel(id: &str) -> Result<(), String> {
    lookup(id)?.cancel_turn()
}

/// Answer a pending authorization request. The option must belong to the card;
/// no option withdraws the request. The card is consumed, so a repeated answer
/// is an error rather than a second protocol reply.
pub fn respond_permission(id: &str, request_id: &str, option_id: Option<&str>) -> Result<(), String> {
    lookup(id)?.respond(request_id, option_id)
}

/// Answer an out-of-directory approval card: once, for the rest of the
/// session (that category), or deny. The card is consumed; a late or repeated
/// answer is an error.
pub fn respond_access(id: &str, access_id: &str, decision: &str) -> Result<(), String> {
    let answer = AccessAnswer::parse(decision).ok_or("未知的审批答复")?;
    lookup(id)?.respond_access(access_id, answer)
}

/// Revoke session grants; the next access of each category asks again.
pub fn revoke_grants(id: &str, kinds: &[String]) -> Result<(), String> {
    let kinds: Vec<AccessKind> = kinds
        .iter()
        .map(|kind| AccessKind::parse(kind).ok_or_else(|| format!("未知的授权类别：{kind}")))
        .collect::<Result<_, _>>()?;
    lookup(id)?.revoke_grants(&kinds);
    Ok(())
}

/// End a terminal's process tree at the user's request. The terminal stays
/// readable; the agent sees the exit like any other.
pub fn kill_terminal(id: &str, terminal_id: &str) -> Result<(), String> {
    lookup(id)?.kill_terminal(terminal_id)
}

/// Switch the session mode to one the agent declared.
pub fn set_mode(id: &str, mode_id: &str) -> Result<(), String> {
    lookup(id)?.set_mode(mode_id)
}

/// Set one declared configuration option (or the legacy model selector under
/// `LEGACY_MODEL_CONFIG_ID`). A select takes a string value, a boolean a bool.
pub fn set_config(id: &str, config_id: &str, value: &Value) -> Result<(), String> {
    lookup(id)?.set_config(config_id, value)
}

pub fn close(id: &str) -> Result<(), String> {
    let session = {
        let mut map = sessions();
        map.remove(id).ok_or("ACP 会话不存在或已结束")?
    };
    session.exited(None);
    Ok(())
}

pub fn shutdown() {
    let all: Vec<Arc<Session>> = sessions().drain().map(|(_, session)| session).collect();
    for session in all {
        session.exited(None);
    }
}

fn lookup(id: &str) -> Result<Arc<Session>, String> {
    sessions().get(id).cloned().ok_or_else(|| "ACP 会话不存在或已结束".to_string())
}

/// Start a real conversation: spawn the agent, then run the shared handshake.
pub fn start(spec: AcpStart, credential: Option<(String, String)>) -> Result<AcpSessionSnapshot, String> {
    let mut spec = spec;
    spec.credential = credential;
    let (io, secret_session) = spawn_io(&spec)?;
    open_with(spec, io, Some(secret_session))
}

/// Start from an already connected stream pair: the tests use this, and the
/// process start uses it once the child owns the pipes and its broker session.
#[cfg(test)]
pub(crate) fn open(spec: AcpStart, io: AcpIo) -> Result<AcpSessionSnapshot, String> {
    open_with(spec, io, None)
}

/// The one start path. A session that cannot finish its handshake — or whose
/// first turn cannot be submitted — is failed and then removed: a launcher that
/// shows an error must not leave a registered session or a live agent behind.
fn open_with(
    spec: AcpStart,
    io: AcpIo,
    secret_session: Option<crate::secrets::session::LocalSession>,
) -> Result<AcpSessionSnapshot, String> {
    if !spec.directory.is_dir() {
        return Err("工作目录不存在，无法在选定的目录创建 ACP 会话".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let AcpIo { reader, writer, diagnostics, shutdown } = io;
    let session = Arc::new(Session::new(id.clone(), &spec, writer, shutdown, secret_session));
    sessions().insert(id.clone(), Arc::clone(&session));

    let reader_session = Arc::clone(&session);
    std::thread::spawn(move || read_frames(reader_session, reader));
    if let Some(diagnostics) = diagnostics {
        let diagnostic_session = Arc::clone(&session);
        std::thread::spawn(move || read_diagnostics(diagnostic_session, diagnostics));
    }

    let handshake = (|| -> Result<(), String> {
        let result = session.request(
            "initialize",
            json!({
                "protocolVersion": capabilities::PROTOCOL_VERSION,
                "clientInfo": capabilities::client_info(),
                "clientCapabilities": capabilities::client_capabilities(),
            }),
        )?;
        capabilities::check_protocol(&result)?;
        let agent = capabilities::agent_descriptor(&result);
        if !agent.auth_methods.is_empty() {
            let names: Vec<&str> = agent.auth_methods.iter().map(|method| method.id.as_str()).collect();
            session.diagnostic(&format!("该 agent 声明了认证方式：{}", names.join(", ")));
        }
        *guard(&session.agent) = agent;
        Ok(())
    })();
    if let Err(error) = handshake {
        session.fail(&error);
        abandon(&session);
        return Err(error);
    }
    match session.establish() {
        Ok(resumed) => {
            if let Err(error) = session.become_ready(resumed) {
                session.fail(&error);
                abandon(&session);
                return Err(error);
            }
        }
        // The agent wants a login first. That is not a failed start: the
        // session stays, lists the agent's methods and waits for the user.
        Err(SetupError::AuthRequired(reason)) => session.require_auth(reason),
        Err(SetupError::Failed(error)) => {
            session.fail(&error);
            abandon(&session);
            return Err(error);
        }
    }
    Ok(session.snapshot())
}

impl Session {
    /// Whether a failed session request means "log in first": the protocol's
    /// auth_required code, or — for session/new only — any error the agent
    /// returned while it declares login methods.
    fn needs_login(&self, error: &RpcError, any_error_counts: bool) -> bool {
        error.code == Some(AUTH_REQUIRED_CODE)
            || (any_error_counts && error.code.is_some() && !guard(&self.agent).auth_methods.is_empty())
    }

    /// Create the protocol session, or continue the one the launch named.
    /// `session/resume` (no replay) is preferred when the agent declares it,
    /// then `session/load` (history replay). A resume that cannot happen falls
    /// back to a new session and says so. Returns whether the requested
    /// session was continued.
    fn establish(&self) -> Result<bool, SetupError> {
        let cwd = crate::launch::terminal_path(&self.directory).map_err(SetupError::Failed)?;
        let agent = guard(&self.agent).clone();
        if let Some(native) = self.resume_target.as_deref() {
            let method = if agent.session_capabilities.resume {
                Some(("session/resume", "resumed"))
            } else if agent.load_session {
                Some(("session/load", "loaded"))
            } else {
                None
            };
            match method {
                Some((method, outcome)) => {
                    // The replay that answers a load names this session: the
                    // id is known before the first replayed update arrives, so
                    // another session's frames are still told apart.
                    *guard(&self.native_session_id) = Some(native.to_owned());
                    self.replaying.store(method == "session/load", Ordering::SeqCst);
                    let result = self.request_raw(
                        method,
                        json!({ "sessionId": native, "cwd": cwd, "mcpServers": [] }),
                        self.timeout,
                    );
                    self.replaying.store(false, Ordering::SeqCst);
                    match result {
                        Ok(result) => {
                            capabilities::apply_session_setup(&mut guard(&self.config), &result);
                            *guard(&self.resume) = outcome;
                            return Ok(true);
                        }
                        Err(error) => {
                            *guard(&self.native_session_id) = None;
                            if self.needs_login(&error, false) {
                                return Err(SetupError::AuthRequired(error.message));
                            }
                            *guard(&self.resume) = "failed";
                            self.diagnostic(&format!("恢复原会话失败：{}", error.message));
                            self.notice(
                                "warning",
                                "resume_failed",
                                "无法恢复原会话，已新建一段会话；首条提示不会自动重发",
                            );
                        }
                    }
                }
                None => {
                    *guard(&self.resume) = "unsupported";
                    self.notice("info", "resume_unsupported", "该 agent 不支持恢复原会话，已新建一段会话");
                }
            }
        }
        let result = match self.request_raw("session/new", json!({ "cwd": cwd, "mcpServers": [] }), self.timeout) {
            Ok(result) => result,
            Err(error) if self.needs_login(&error, true) => return Err(SetupError::AuthRequired(error.message)),
            Err(error) => return Err(SetupError::Failed(error.message)),
        };
        let native = result
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| SetupError::Failed("agent 未返回会话编号，无法继续对话".into()))?
            .to_owned();
        capabilities::apply_session_setup(&mut guard(&self.config), &result);
        *guard(&self.native_session_id) = Some(native);
        Ok(false)
    }

    /// The session exists: it accepts prompts. A declared YOLO mode is
    /// switched to, then the launch's first prompt is submitted — unless the
    /// launch asked to continue a session that did not come back, in which
    /// case the prompt is dropped rather than sent into a different one.
    fn become_ready(self: &Arc<Self>, resumed: bool) -> Result<(), String> {
        *guard(&self.auth_error) = None;
        {
            // An agent that exited while the session was being established
            // stays closed: it never looks ready, and nothing is sent to it.
            let _order = self.order();
            let mut state = guard(&self.state);
            if matches!(*state, "closed" | "failed") {
                return Ok(());
            }
            *state = "ready";
        }
        self.publish();
        // A YOLO entry that declares a mode switches to it before the first
        // turn. A refusal is reported, and the host still approves on the
        // client side.
        if let Some(mode) = self.yolo_mode.as_deref() {
            if let Err(error) = self.set_mode(mode) {
                self.notice("warning", "yolo_mode_failed", format!("未能切换到 YOLO 模式：{error}"));
            }
        }
        let Some(prompt) = guard(&self.initial_prompt).take() else { return Ok(()) };
        if self.resume_target.is_some() && !resumed {
            self.notice("info", "prompt_not_sent", "原会话没有恢复，首条提示没有发送");
            return Ok(());
        }
        self.begin_turn(&prompt, &[])
    }

    /// Wait for a login. The snapshot lists the agent's methods; the reason is
    /// kept for the view.
    fn require_auth(&self, reason: String) {
        if matches!(*guard(&self.state), "closed" | "failed") {
            return;
        }
        self.diagnostic(&format!("agent 要求先登录：{reason}"));
        *guard(&self.auth_error) = Some(reason);
        *guard(&self.state) = "auth_required";
        self.notice("warning", "auth_required", "该 agent 需要先登录，请选择一种登录方式");
        self.publish();
    }

    /// Log in through the agent with a declared method, then establish the
    /// session the launch wanted. Only an `agent` method is answered through
    /// the protocol; a terminal method runs in a terminal instead.
    fn authenticate(self: &Arc<Self>, method_id: &str) -> Result<(), String> {
        let method = guard(&self.agent)
            .auth_methods
            .iter()
            .find(|method| method.id == method_id)
            .cloned()
            .ok_or("该登录方式不在 agent 声明的方式中")?;
        if method.kind != "agent" {
            return Err("该登录方式需要在终端中完成，请使用「用终端登录」".into());
        }
        {
            let mut state = guard(&self.state);
            if *state != "auth_required" {
                return Err("该会话当前不需要登录".into());
            }
            *state = "starting";
        }
        self.publish();
        let timeout = self.timeout.max(AUTH_TIMEOUT_FLOOR);
        if let Err(error) = self.request_raw("authenticate", json!({ "methodId": method_id }), timeout) {
            return Err(self.auth_failed(format!("登录失败：{}", error.message)));
        }
        // A turn asked for the login: the protocol session already exists and
        // keeps its conversation, so it is not created again.
        if guard(&self.native_session_id).is_some() {
            *guard(&self.auth_error) = None;
            {
                let _order = self.order();
                let mut state = guard(&self.state);
                if matches!(*state, "closed" | "failed") {
                    return Err("登录后 agent 已退出，会话已结束".into());
                }
                *state = "ready";
            }
            self.notice("info", "authenticated", format!("已通过「{}」登录", method.name));
            self.settle_state();
            return Ok(());
        }
        match self.establish() {
            Ok(resumed) => {
                self.notice("info", "authenticated", format!("已通过「{}」登录", method.name));
                self.become_ready(resumed)?;
                if matches!(*guard(&self.state), "closed" | "failed") {
                    return Err("登录后 agent 已退出，会话已结束".into());
                }
                Ok(())
            }
            Err(SetupError::AuthRequired(reason)) => Err(self.auth_failed(format!("登录后 agent 仍要求登录：{reason}"))),
            Err(SetupError::Failed(reason)) => Err(self.auth_failed(format!("登录后仍无法建立会话：{reason}"))),
        }
    }

    /// A login that did not work: the session keeps waiting for one, and the
    /// reason is kept for the view. Returns the reason for the caller.
    fn auth_failed(&self, reason: String) -> String {
        {
            let mut state = guard(&self.state);
            if !matches!(*state, "closed" | "failed") {
                *state = "auth_required";
            }
        }
        *guard(&self.auth_error) = Some(reason.clone());
        self.diagnostic(&reason);
        self.publish();
        reason
    }
}

/// Give up on a session that never became usable: drop it from the registry,
/// close its streams and terminate the agent. The failure stays on the snapshot
/// the caller already received through its events, but nothing stays reachable
/// by id, so a retry starts from a clean state instead of colliding with a
/// half-started session.
fn abandon(session: &Arc<Session>) {
    sessions().remove(&session.id);
    session.exited(None);
}

fn read_frames(session: Arc<Session>, mut reader: Box<dyn Read + Send>) {
    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8 * 1024];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                buffer.extend_from_slice(&chunk[..read]);
                while let Some(position) = buffer.iter().position(|byte| *byte == b'\n') {
                    let line: Vec<u8> = buffer.drain(..=position).collect();
                    session.handle_line(&line[..line.len().saturating_sub(1)]);
                }
                if buffer.len() > MAX_FRAME_BYTES {
                    session.fail("协议帧超过大小上限，已断开");
                    return;
                }
            }
            Err(error) => {
                session.diagnostic(&format!("读取协议输出失败：{error}"));
                break;
            }
        }
    }
    if *guard(&session.state) != "failed" {
        session.exited(None);
    }
}

fn read_diagnostics(session: Arc<Session>, mut reader: Box<dyn Read + Send>) {
    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4 * 1024];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                buffer.extend_from_slice(&chunk[..read]);
                while let Some(position) = buffer.iter().position(|byte| *byte == b'\n') {
                    let line: Vec<u8> = buffer.drain(..=position).collect();
                    if let Ok(text) = std::str::from_utf8(&line[..line.len().saturating_sub(1)]) {
                        session.diagnostic(text);
                    }
                }
                if buffer.len() > MAX_FRAME_BYTES {
                    buffer.clear();
                }
            }
            Err(_) => break,
        }
    }
}

/// The environment a child agent receives: the adapter's removals and values,
/// the plan's, the selected account's and the stored connection key. The
/// caller's own environment is never copied wholesale, and a removed name is
/// never set again.
pub(crate) struct ChildEnvironment {
    pub set: Vec<(String, String)>,
    pub remove: Vec<String>,
}

pub(crate) fn child_environment(spec: &AcpStart) -> ChildEnvironment {
    // A session token belongs to the process that owns the broker session. The
    // child gets the token of its own session; whatever this process holds must
    // never be inherited, so the name is removed before that value is written.
    let mut remove: Vec<String> = vec!["NO_COLOR".to_owned(), crate::secrets::session::ENV.to_owned()];
    for name in spec.session_markers {
        remove.push((*name).to_owned());
    }
    for name in spec
        .remove_environment
        .iter()
        .chain(spec.command.remove_environment.iter())
    {
        if !remove.contains(name) {
            remove.push(name.clone());
        }
    }
    // The adapter's own policy, then the plan's additions, so a caller that
    // forwards only one of the two still isolates the child correctly.
    let declared = spec
        .command
        .environment
        .iter()
        .map(|(name, value)| (name.clone(), value.clone()))
        .chain(spec.environment.iter().cloned());
    let mut set: Vec<(String, String)> = Vec::new();
    for (name, value) in &declared.collect::<Vec<_>>() {
        if remove.iter().any(|key| key == name) {
            continue;
        }
        if let Some(existing) = set.iter_mut().find(|(existing, _)| existing == name) {
            existing.1 = value.clone();
        } else {
            set.push((name.clone(), value.clone()));
        }
    }
    if let Some((name, value)) = &spec.credential {
        if !remove.iter().any(|key| key == name) {
            set.retain(|(existing, _)| existing != name);
            set.push((name.clone(), value.clone()));
        }
    }
    ChildEnvironment { set, remove }
}

/// Spawn the agent and hand its pipes to the shared session. The environment is
/// the planned one: the adapter's removals, the selected account and the stored
/// connection key, never the caller's whole environment.
///
/// The child also receives the token of its own secret-broker session. The
/// guard is returned with the streams because dropping it revokes the session:
/// the conversation keeps it for as long as the agent runs, exactly like the
/// terminal launch, and a prompt body still only carries a reference.
fn spawn_io(spec: &AcpStart) -> Result<(AcpIo, crate::secrets::session::LocalSession), String> {
    let program = &spec.command.program;
    if !program.is_file() {
        return Err("ACP 入口程序不存在，请在工具页重新检测安装路径".into());
    }
    let cwd = crate::launch::terminal_path(&spec.directory)?;
    // A batch entry cannot be a process image; the command interpreter runs it
    // instead, and arguments stay literal through raw_arg. Terminal commands
    // share the same wrapping.
    let mut command = terminal::program_command(program, &spec.command.args);
    command
        .current_dir(&cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let environment = child_environment(spec);
    for name in &environment.remove {
        command.env_remove(name);
    }
    for (name, value) in &environment.set {
        command.env(name, value);
    }
    // An agent that starts children of its own must be killed as a tree, the
    // same way a workbench terminal is: give the child its own process group so
    // termination reaches its descendants too.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    // The broker session outlives this call: the token goes to the child, the
    // guard travels with the session so the grant ends when the agent does.
    let secret_session = crate::secrets::session::LocalSession::new();
    command.env(crate::secrets::session::ENV, secret_session.token());
    let mut child = command.spawn().map_err(|error| format!("无法启动 ACP 入口：{error}"))?;
    #[cfg(target_os = "macos")]
    secret_session.bind_root(child.id());
    // A pipe that cannot be taken would leave a running agent with no host, so
    // the child is terminated before the error travels up.
    let Some(stdin) = child.stdin.take() else {
        crate::background_process::terminate(&mut child);
        return Err("无法连接 ACP 进程的标准输入".into());
    };
    let Some(stdout) = child.stdout.take() else {
        crate::background_process::terminate(&mut child);
        return Err("无法连接 ACP 进程的标准输出".into());
    };
    let stderr = child.stderr.take();
    let shell = Arc::new(Mutex::new(child));
    let killer = Arc::clone(&shell);
    Ok((
        AcpIo {
            reader: Box::new(stdout),
            writer: Box::new(stdin),
            diagnostics: stderr.map(|stderr| Box::new(stderr) as Box<dyn Read + Send>),
            shutdown: Some(Box::new(move || {
                if let Ok(mut child) = killer.lock() {
                    crate::background_process::terminate(&mut child);
                }
            })),
        },
        secret_session,
    ))
}

#[cfg(windows)]
fn interpreter_program() -> PathBuf {
    std::env::var_os("COMSPEC")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("C:\\Windows\\System32\\cmd.exe"))
}

#[cfg(not(windows))]
fn interpreter_program() -> PathBuf {
    PathBuf::from("/bin/sh")
}

/// Wait until the session has no active turn and has settled its state after
/// the last one. Tests use it so an assertion never reads a half-finished
/// turn: the turn is cleared before its end is recorded and the state settles.
#[cfg(test)]
pub(crate) fn wait_until_idle(id: &str, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        let session = lookup(id)?;
        let settled = !matches!(*guard(&session.state), "running" | "stopping");
        if guard(&session.turn).is_none() && settled {
            return Ok(());
        }
        if Instant::now() > deadline {
            return Err("等待轮次结束超时".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(test)]
#[path = "../../../tests/launch/acp.rs"]
mod tests;

#[cfg(test)]
#[path = "../../../tests/launch/acp_timeline.rs"]
mod timeline_tests;

#[cfg(test)]
#[path = "../../../tests/launch/acp_client.rs"]
mod client_tests;

#[cfg(test)]
#[path = "../../../tests/launch/acp_session_ops.rs"]
mod session_ops_tests;

#[cfg(test)]
#[path = "../../../tests/launch/acp_live.rs"]
mod live_tests;
