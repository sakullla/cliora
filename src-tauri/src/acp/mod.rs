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
//! - A permission request is bound to the live connection, the session (or a
//!   registered child session) and the turn that asked for it, and is answered
//!   at most once.
//! - A prompt turn has no fixed deadline: it ends with the agent's own answer,
//!   the agent's exit or the user's stop. Every other request keeps the
//!   configured timeout.
//! - A prompt body may hold a cliora-secret reference. The host never resolves
//!   it: the agent reaches the secret broker through the local session token,
//!   exactly like the terminal launch. No protocol body is logged here, and
//!   only the agent's own redacted standard error is retained.

pub mod capabilities;
pub mod timeline;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, OnceLock};
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
pub use timeline::{
    AcpMessage, AcpNotice, AcpPermissionOption, AcpPermissionRequest, AcpSubagent, AcpTimelineItem,
    AcpToolCall, AcpToolContent, AcpToolLocation, AcpTurnEnd,
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
        Ok(Self {
            tool_id: plan.tool_id.clone(),
            project_id: plan.project_id.clone(),
            directory: plan.directory.clone(),
            mode: plan.mode,
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
    /// One of starting, ready, running, stopping, waiting_permission, closed or
    /// failed. "stopping" is a turn the user stopped that has not reported its
    /// own result yet.
    pub state: &'static str,
    pub native_session_id: Option<String>,
    /// One of none, unsupported, loaded or failed.
    pub resume: &'static str,
    /// Everything the conversation produced, in arrival order.
    pub timeline: Vec<AcpTimelineItem>,
    /// Request ids still waiting for the user's answer.
    pub pending: Vec<String>,
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
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    #[allow(clippy::type_complexity)]
    shutdown: Mutex<Option<Box<dyn FnMut() + Send>>>,
    requests: Mutex<HashMap<u64, Sender<Result<Value, String>>>>,
    next_request: AtomicU64,
    turn: Mutex<Option<Turn>>,
    timeout: Duration,
    /// The local secret-broker approval scope. Keeping this guard alive is what
    /// makes a secret reference usable for exactly this session.
    secret_session: Mutex<Option<crate::secrets::session::LocalSession>>,
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
            writer: Mutex::new(Some(writer)),
            shutdown: Mutex::new(shutdown),
            requests: Mutex::new(HashMap::new()),
            next_request: AtomicU64::new(0),
            turn: Mutex::new(None),
            timeout: spec.timeout,
            secret_session: Mutex::new(secret_session),
        }
    }

    fn publish(&self) {
        self.emit_update(AcpUpdate::Snapshot { snapshot: Box::new(self.snapshot()) });
    }

    fn next_seq(&self) -> u64 {
        self.seq.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn emit_update(&self, update: AcpUpdate) {
        emit(AcpEvent { session_id: self.id.clone(), seq: self.next_seq(), update });
    }

    fn pending_ids(&self) -> Vec<String> {
        guard(&self.permissions).iter().map(|pending| pending.request_id.clone()).collect()
    }

    fn emit_pending(&self) {
        self.emit_update(AcpUpdate::Pending { pending: self.pending_ids() });
    }

    fn snapshot(&self) -> AcpSessionSnapshot {
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
            timeline: guard(&self.timeline).items().to_vec(),
            pending: self.pending_ids(),
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

    /// The state a live session returns to: a pending card keeps it waiting,
    /// an active turn keeps it running.
    fn settle_state(&self) {
        // A closed or failed session never comes back: a late turn result only
        // records its reason.
        if matches!(*guard(&self.state), "closed" | "failed") {
            return;
        }
        let previous = *guard(&self.state);
        let waiting = !guard(&self.permissions).is_empty();
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
    ) -> Result<(u64, std::sync::mpsc::Receiver<Result<Value, String>>), String> {
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
        let (id, receiver) = self.send_request(method, params)?;
        match receiver.recv_timeout(self.timeout) {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => Err(error),
            Err(_) => {
                guard(&self.requests).remove(&id);
                Err(format!("等待 agent 回应 {method} 超时，请确认该 CLI 支持 ACP"))
            }
        }
    }

    fn resolve_response(&self, id: u64, result: Result<Value, String>) {
        if let Some(sender) = guard(&self.requests).remove(&id) {
            let _ = sender.send(result);
        }
    }

    fn handle_line(&self, line: &[u8]) {
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
                    self.resolve_response(number, Err(redact(message)));
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

    fn handle_request(&self, method: &str, id: Value, params: Value) {
        match method {
            "session/request_permission" => self.open_permission(id, params),
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
                            kind: item.get("kind").and_then(Value::as_str).unwrap_or("allow_once").to_owned(),
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
        // A child keeps working after its parent's turn ended, so its request
        // stands on its own; the conversation's own request needs a live turn.
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
        self.settle_state();
    }

    /// Answer a request the user no longer can, and take its card off the
    /// tool call. The caller publishes the new pending set.
    fn withdraw(&self, pending: PendingPermission) {
        let _ = self.answer_permission(&pending.id, json!({ "outcome": "cancelled" }));
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
        let message_id = update.get("messageId").and_then(Value::as_str);
        let outcome = guard(&self.timeline).append_chunk(role, message_id, subagent, &turn_id, &text);
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
    fn begin_turn(self: &Arc<Self>, text: &str) -> Result<(), String> {
        if guard(&self.turn).is_some() {
            return Err("当前轮次尚未结束，请先停止或等待结果".into());
        }
        let turn_id = format!("turn-{}", self.next_seq());
        *guard(&self.turn) = Some(Turn { id: turn_id.clone(), cancel_requested: false });
        let prompt_text = text.to_owned();
        {
            let (text, truncated) = timeline::cap(&prompt_text, timeline::MAX_MESSAGE_CHARS);
            guard(&self.timeline).upsert(AcpTimelineItem::Message(AcpMessage {
                id: format!("{turn_id}-user"),
                role: "user",
                text,
                truncated,
                turn_id: turn_id.clone(),
                subagent: None,
            }));
        }
        self.settle_state();
        let native = guard(&self.native_session_id).clone().unwrap_or_default();
        let params = json!({
            "sessionId": native,
            "prompt": [{ "type": "text", "text": prompt_text }],
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
        let session = Arc::clone(self);
        std::thread::spawn(move || {
            // No deadline: a long turn is still a turn. The sender is dropped
            // or answered with an error when the agent exits.
            let reason = match receiver.recv() {
                Ok(Ok(result)) => stop_reason(result.get("stopReason").and_then(Value::as_str)),
                Ok(Err(error)) => {
                    session.notice("error", "", error);
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
        let withdrew = !dropped.is_empty();
        for pending in dropped {
            self.withdraw(pending);
        }
        if withdrew {
            self.emit_pending();
        }
        let item = AcpTimelineItem::Turn(AcpTurnEnd {
            id: format!("{turn_id}-end"),
            turn_id: turn_id.to_owned(),
            reason,
        });
        guard(&self.timeline).upsert(item.clone());
        self.emit_update(AcpUpdate::Item { item });
        self.settle_state();
    }

    fn cancel_turn(&self) -> Result<(), String> {
        let native = guard(&self.native_session_id).clone().unwrap_or_default();
        {
            let mut turn = guard(&self.turn);
            let Some(turn) = turn.as_mut() else {
                return Err("当前没有进行中的轮次".into());
            };
            turn.cancel_requested = true;
        }
        // A card from this turn cannot be answered any more: the user withdrew
        // the whole turn, so the cards leave the panel now rather than waiting
        // for the agent's own result. Whoever clicks a retired card is refused,
        // because it is no longer in the pending list.
        let withdrawn: Vec<PendingPermission> = std::mem::take(&mut *guard(&self.permissions));
        let withdrew = !withdrawn.is_empty();
        for pending in withdrawn {
            self.withdraw(pending);
        }
        if withdrew {
            self.emit_pending();
        }
        self.write_value(&json!({
            "jsonrpc": "2.0",
            "method": "session/cancel",
            "params": { "sessionId": native },
        }))?;
        // The turn stays open until the agent reports its own result: a stop
        // request is not a stop confirmation, so the session shows stopping.
        *guard(&self.state) = "stopping";
        self.publish();
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
        let call = guard(&self.timeline).set_permission(&pending.item_id, None);
        if let Some(call) = call {
            self.emit_update(AcpUpdate::Tool { call });
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
        guard(&self.writer).take();
        if let Some(mut shutdown) = guard(&self.shutdown).take() {
            shutdown();
        }
        guard(&self.secret_session).take();
        *guard(&self.turn) = None;
        let dropped: Vec<PendingPermission> = std::mem::take(&mut *guard(&self.permissions));
        {
            let mut timeline = guard(&self.timeline);
            for pending in &dropped {
                timeline.set_permission(&pending.item_id, None);
            }
        }
        let waiting: Vec<u64> = guard(&self.requests).keys().copied().collect();
        for id in waiting {
            self.resolve_response(id, Err("agent 已退出".into()));
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
        "failed" => "会话初始化失败",
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

pub fn prompt(id: &str, text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("提示词为空".into());
    }
    lookup(id)?.begin_turn(text)
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
        let load_supported = agent.load_session;
        *guard(&session.agent) = agent;
        let cwd = crate::launch::terminal_path(&spec.directory)?;
        let mut resumed = false;
        if let Some(native) = spec.resume_native_id.as_deref() {
            if load_supported {
                match session.request(
                    "session/load",
                    json!({ "sessionId": native, "cwd": cwd, "mcpServers": [] }),
                ) {
                    Ok(result) => {
                        capabilities::apply_session_setup(&mut guard(&session.config), &result);
                        *guard(&session.native_session_id) = Some(native.to_owned());
                        *guard(&session.resume) = "loaded";
                        resumed = true;
                    }
                    Err(error) => {
                        *guard(&session.resume) = "failed";
                        session.diagnostic(&format!("恢复原会话失败：{error}"));
                        session.notice(
                            "warning",
                            "resume_failed",
                            "无法恢复原会话，已新建一段会话；首条提示不会自动重发",
                        );
                    }
                }
            } else {
                *guard(&session.resume) = "unsupported";
                session.notice("info", "resume_unsupported", "该 agent 不支持恢复原会话，已新建一段会话");
            }
        }
        if !resumed {
            let result = session.request("session/new", json!({ "cwd": cwd, "mcpServers": [] }))?;
            let native = result
                .get("sessionId")
                .and_then(Value::as_str)
                .ok_or("agent 未返回会话编号，无法继续对话")?
                .to_owned();
            capabilities::apply_session_setup(&mut guard(&session.config), &result);
            *guard(&session.native_session_id) = Some(native);
        }
        Ok(())
    })();

    if let Err(error) = handshake {
        session.fail(&error);
        abandon(&session);
        return Err(error);
    }
    *guard(&session.state) = "ready";
    session.publish();
    if let Some(prompt) = spec.initial_prompt.clone() {
        if let Err(error) = session.begin_turn(&prompt) {
            session.fail(&error);
            abandon(&session);
            return Err(error);
        }
    }
    Ok(session.snapshot())
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
    let mut command = if crate::adapters::acp_needs_command_interpreter(program) {
        // A batch entry cannot be a process image; the command interpreter runs
        // it instead, and arguments stay literal through raw_arg.
        let line = format!(
            "\"{}\" {}",
            program.display(),
            spec.command
                .args
                .iter()
                .map(|arg| format!("\"{}\"", arg.replace('"', "\"\"")))
                .collect::<Vec<_>>()
                .join(" ")
        );
        let mut interpreter = crate::background_process::command(interpreter_program());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            interpreter.raw_arg(format!("/D /V:OFF /S /C \"{line}\""));
        }
        #[cfg(not(windows))]
        interpreter.arg(line);
        interpreter
    } else {
        let mut command = crate::background_process::command(program);
        command.args(&spec.command.args);
        command
    };
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

/// Wait until the session has no active turn. Tests use it so an assertion
/// never reads a half-finished turn.
#[cfg(test)]
pub(crate) fn wait_until_idle(id: &str, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        let session = lookup(id)?;
        if guard(&session.turn).is_none() {
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
