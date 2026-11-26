//! Shared ACP (Agent Client Protocol) conversation host.
//!
//! A local ACP agent is an ordinary child process that speaks JSON-RPC over
//! its standard input and output. This module owns everything that is the same
//! for every CLI: frame boundaries, request correlation, turn lifecycle, tool
//! updates, permission requests, cancellation, exit cleanup and the retained
//! snapshot a re-mounted view reads. Adapters only declare the program, its
//! arguments and the environment policy; nothing here knows a product id.
//!
//! Boundaries this module keeps:
//!
//! - Standard output carries the protocol; standard error only produces a
//!   bounded, redacted diagnostic. Neither is forwarded to a terminal.
//! - Client capabilities are published only when the client can honour them.
//!   The host serves no file-system and no terminal request, so it advertises
//!   neither and answers such a request with "method not found" instead of
//!   pretending to serve it.
//! - A permission request is bound to the live connection, the session and the
//!   turn that asked for it, and is answered at most once.
//! - A prompt body may hold a cliora-secret reference. The host never resolves
//!   it: the agent reaches the secret broker through the local session token,
//!   exactly like the terminal launch. No protocol body is logged here, and
//!   only the agent's own redacted standard error is retained.

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

/// One conversation event, scoped to its session so two panels never mix.
pub const EVENT: &str = "cliora:acp-event";
/// JSON-RPC protocol revision this host speaks.
const PROTOCOL_VERSION: u64 = 1;
/// A single protocol line longer than this is a broken session, not something
/// to buffer without bound.
const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
/// Retained text per message. Longer output is truncated once and reported.
const MAX_MESSAGE_CHARS: usize = 200_000;
/// Retained standard-error lines.
const MAX_DIAGNOSTICS: usize = 40;
/// Retained text per diagnostic line.
const MAX_DIAGNOSTIC_CHARS: usize = 500;
/// Cap for one tool detail summary.
const MAX_TOOL_DETAIL_CHARS: usize = 4_000;

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
    /// How long one protocol request may wait for its response.
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

/// One retained conversation message.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpMessage {
    pub id: String,
    /// One of user, agent or thought.
    pub role: &'static str,
    pub text: String,
    /// Output past the retained budget was dropped, not silently shortened.
    pub truncated: bool,
}

/// One tool call, merged by its call id.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpToolCall {
    pub call_id: String,
    pub title: String,
    /// One of pending, in_progress, completed or failed.
    pub status: &'static str,
    pub detail: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPermissionOption {
    pub option_id: String,
    pub name: String,
    /// The protocol's option kind, kept as the agent sent it.
    pub kind: String,
}

/// A pending authorization card. It is valid only while the request, its
/// session and the connection that asked for it are alive.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPermissionCard {
    pub request_id: String,
    pub turn_id: String,
    pub title: String,
    pub detail: String,
    pub options: Vec<AcpPermissionOption>,
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
    pub messages: Vec<AcpMessage>,
    pub tools: Vec<AcpToolCall>,
    pub permissions: Vec<AcpPermissionCard>,
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
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AcpUpdate {
    Snapshot { snapshot: AcpSessionSnapshot },
    Chunk { message_id: String, role: &'static str, text: String, truncated: bool },
    Tool { call: AcpToolCall },
    Permission { card: AcpPermissionCard },
    PermissionClosed { request_id: String, decision: &'static str },
    Notice { level: &'static str, text: String },
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

/// Trim retained text to the message budget, reporting whether it was cut.
fn cap_text(text: &str) -> (String, bool) {
    let mut count = 0usize;
    for (index, _) in text.char_indices() {
        count += 1;
        if count > MAX_MESSAGE_CHARS {
            return (format!("{}…（输出已截断）", &text[..index]), true);
        }
    }
    (text.to_owned(), false)
}

struct PendingPermission {
    id: Value,
    card: AcpPermissionCard,
}

struct Turn {
    id: String,
    cancel_requested: bool,
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
    messages: Mutex<Vec<AcpMessage>>,
    tools: Mutex<Vec<AcpToolCall>>,
    permissions: Mutex<Vec<PendingPermission>>,
    diagnostics: Mutex<Vec<String>>,
    last_turn_reason: Mutex<&'static str>,
    seq: AtomicU64,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    #[allow(clippy::type_complexity)]
    shutdown: Mutex<Option<Box<dyn FnMut() + Send>>>,
    pending: Mutex<HashMap<u64, Sender<Result<Value, String>>>>,
    next_request: AtomicU64,
    turn: Mutex<Option<Turn>>,
    timeout: Duration,
    /// The local secret-broker approval scope. Keeping this guard alive is what
    /// makes a secret reference usable for exactly this session.
    secret_session: Mutex<Option<crate::secrets::session::LocalSession>>,
}

impl Session {
    fn publish(&self) {
        self.emit_update(AcpUpdate::Snapshot { snapshot: self.snapshot() });
    }

    fn next_seq(&self) -> u64 {
        self.seq.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn emit_update(&self, update: AcpUpdate) {
        emit(AcpEvent { session_id: self.id.clone(), seq: self.next_seq(), update });
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
            messages: guard(&self.messages).clone(),
            tools: guard(&self.tools).clone(),
            permissions: guard(&self.permissions).iter().map(|pending| pending.card.clone()).collect(),
            diagnostics: guard(&self.diagnostics).clone(),
            last_turn_reason: *guard(&self.last_turn_reason),
            seq: self.seq.load(Ordering::SeqCst),
        }
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

    fn notice(&self, level: &'static str, text: impl Into<String>) {
        self.emit_update(AcpUpdate::Notice { level, text: text.into() });
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
        guard(&self.pending).insert(id, sender);
        let frame = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if let Err(error) = self.write_value(&frame) {
            guard(&self.pending).remove(&id);
            return Err(error);
        }
        Ok((id, receiver))
    }

    fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let (id, receiver) = self.send_request(method, params)?;
        match receiver.recv_timeout(self.timeout) {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => Err(error),
            Err(_) => {
                guard(&self.pending).remove(&id);
                Err(format!("等待 agent 回应 {method} 超时，请确认该 CLI 支持 ACP"))
            }
        }
    }

    fn resolve_response(&self, id: u64, result: Result<Value, String>) {
        if let Some(sender) = guard(&self.pending).remove(&id) {
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

    fn handle_request(&self, method: &str, id: Value, params: Value) {
        match method {
            "session/request_permission" => self.open_permission(id, params),
            // The host serves no file-system and no terminal request, and it
            // never advertised either capability.
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

    fn open_permission(&self, id: Value, params: Value) {
        let request_id = id.to_string();
        let turn_id = guard(&self.turn).as_ref().map(|turn| turn.id.clone()).unwrap_or_default();
        // A card asked for by a turn the user already stopped is withdrawn as
        // soon as it arrives: it must never appear under a stopped turn.
        let cancelled = guard(&self.turn).as_ref().is_some_and(|turn| turn.cancel_requested);
        let tool = params.get("toolCall").cloned().unwrap_or(Value::Null);
        let title = tool
            .get("title")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| "工具调用需要授权".to_owned());
        let detail = tool
            .get("kind")
            .and_then(Value::as_str)
            .map(|kind| format!("类型：{kind}"))
            .unwrap_or_default();
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
        if cancelled {
            let _ = self.write_value(&json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": { "outcome": { "outcome": "cancelled" } },
            }));
            self.notice("warning", "本轮已停止，新的授权请求已取消");
            return;
        }
        if turn_id.is_empty() || options.is_empty() {
            // Nothing to attach the card to: answer once so the agent is not
            // left waiting, and say so instead of showing a dead card.
            let _ = self.write_value(&json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": { "outcome": { "outcome": "cancelled" } },
            }));
            self.notice("warning", "该授权请求不对应进行中的轮次，已取消");
            return;
        }
        let card = AcpPermissionCard { request_id, turn_id, title, detail, options };
        guard(&self.permissions).push(PendingPermission { id, card: card.clone() });
        self.emit_update(AcpUpdate::Permission { card });
        self.settle_state();
    }

    fn handle_notification(&self, method: &str, params: Value) {
        match method {
            "session/update" => self.apply_update(params),
            _ => self.diagnostic(&format!("未处理的通知：{method}")),
        }
    }

    fn apply_update(&self, params: Value) {
        let native = guard(&self.native_session_id).clone();
        if let (Some(sent), Some(ours)) = (
            params.get("sessionId").and_then(Value::as_str),
            native.as_deref(),
        ) {
            if sent != ours {
                self.diagnostic("收到其他会话的更新，已忽略");
                return;
            }
        }
        let update = params.get("update").cloned().unwrap_or(Value::Null);
        match update.get("sessionUpdate").and_then(Value::as_str).unwrap_or_default() {
            "agent_message_chunk" => self.append_chunk("agent", update.get("messageId"), &update),
            "agent_thought_chunk" => self.append_chunk("thought", update.get("messageId"), &update),
            "user_message_chunk" => self.append_chunk("user", update.get("messageId"), &update),
            "tool_call" => self.upsert_tool(&update, true),
            "tool_call_update" => self.upsert_tool(&update, false),
            "plan" | "available_commands_update" | "current_mode_update" => {}
            other => self.diagnostic(&format!("未处理的会话更新：{other}")),
        }
    }

    fn append_chunk(&self, role: &'static str, message_id: Option<&Value>, update: &Value) {
        let text = update
            .get("content")
            .and_then(|content| content.get("text"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if text.is_empty() {
            return;
        }
        let turn_id = guard(&self.turn).as_ref().map(|turn| turn.id.clone()).unwrap_or_default();
        let id = message_id
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!("{role}-{turn_id}"));
        let truncated;
        {
            let mut messages = guard(&self.messages);
            match messages.iter_mut().find(|message| message.id == id) {
                Some(message) => {
                    if !message.truncated {
                        message.text.push_str(text);
                        let (capped, cut) = cap_text(&message.text);
                        message.text = capped;
                        message.truncated = cut;
                    }
                    truncated = message.truncated;
                }
                None => {
                    let (capped, cut) = cap_text(text);
                    messages.push(AcpMessage { id: id.clone(), role, text: capped, truncated: cut });
                    truncated = cut;
                }
            }
        }
        self.emit_update(AcpUpdate::Chunk { message_id: id, role, text: text.to_owned(), truncated });
    }

    fn upsert_tool(&self, update: &Value, created: bool) {
        let Some(call_id) = update.get("toolCallId").and_then(Value::as_str) else {
            self.diagnostic("工具更新缺少调用编号，已忽略");
            return;
        };
        let fallback = if created { "pending" } else { "in_progress" };
        let status = match update.get("status").and_then(Value::as_str).unwrap_or(fallback) {
            "completed" => "completed",
            "failed" => "failed",
            "pending" => "pending",
            _ => "in_progress",
        };
        let detail = tool_detail(update);
        let title = update.get("title").and_then(Value::as_str).map(ToOwned::to_owned);
        let call = {
            let mut tools = guard(&self.tools);
            match tools.iter_mut().find(|tool| tool.call_id == call_id) {
                Some(tool) => {
                    tool.status = status;
                    if let Some(title) = title {
                        tool.title = title;
                    }
                    if !detail.is_empty() {
                        tool.detail = detail;
                    }
                    tool.clone()
                }
                None => {
                    let tool = AcpToolCall {
                        call_id: call_id.to_owned(),
                        title: title.unwrap_or_else(|| "工具调用".to_owned()),
                        status,
                        detail,
                    };
                    tools.push(tool.clone());
                    tool
                }
            }
        };
        self.emit_update(AcpUpdate::Tool { call });
    }

    /// Start one turn. Only one turn may run at a time; a failure to send is
    /// reported to the caller instead of becoming a silent gap.
    fn begin_turn(self: &Arc<Self>, text: &str) -> Result<(), String> {
        if guard(&self.turn).is_some() {
            return Err("当前轮次尚未结束，请先停止或等待结果".into());
        }
        let id = format!("turn-{}", self.next_seq());
        *guard(&self.turn) = Some(Turn { id: id.clone(), cancel_requested: false });
        let prompt_text = text.to_owned();
        guard(&self.messages).push(AcpMessage {
            id: format!("{id}-user"),
            role: "user",
            text: cap_text(&prompt_text).0,
            truncated: false,
        });
        self.settle_state();
        let native = guard(&self.native_session_id).clone().unwrap_or_default();
        let params = json!({
            "sessionId": native,
            "prompt": [{ "type": "text", "text": prompt_text }],
        });
        // The prompt must be written before this returns: a stop or a second
        // turn issued right after must never overtake it on the wire.
        let (id, receiver) = match self.send_request("session/prompt", params) {
            Ok(pair) => pair,
            Err(error) => {
                *guard(&self.turn) = None;
                self.settle_state();
                return Err(error);
            }
        };
        let session = Arc::clone(self);
        std::thread::spawn(move || {
            let reason = match receiver.recv_timeout(session.timeout) {
                Ok(Ok(result)) => stop_reason(result.get("stopReason").and_then(Value::as_str)),
                Ok(Err(error)) => {
                    session.notice("error", error);
                    "disconnected"
                }
                Err(_) => {
                    guard(&session.pending).remove(&id);
                    session.notice("error", "等待 agent 回应 session/prompt 超时");
                    "disconnected"
                }
            };
            session.finish_turn(reason);
        });
        Ok(())
    }

    fn finish_turn(&self, reason: &'static str) {
        *guard(&self.last_turn_reason) = reason;
        let cancelled = guard(&self.turn).as_ref().is_some_and(|turn| turn.cancel_requested);
        *guard(&self.turn) = None;
        // A card from a cancelled turn can no longer be answered: the user
        // withdrew it together with the turn.
        let dropped: Vec<PendingPermission> = if cancelled {
            std::mem::take(&mut *guard(&self.permissions))
        } else {
            Vec::new()
        };
        for pending in dropped {
            let _ = self.write_value(&json!({
                "jsonrpc": "2.0",
                "id": pending.id,
                "result": { "outcome": { "outcome": "cancelled" } },
            }));
            self.emit_update(AcpUpdate::PermissionClosed {
                request_id: pending.card.request_id,
                decision: "cancelled",
            });
        }
        self.settle_state();
        self.emit_update(AcpUpdate::Notice {
            level: if reason == "end_turn" { "info" } else { "warning" },
            text: turn_reason_text(reason).to_owned(),
        });
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
        for pending in withdrawn {
            let _ = self.write_value(&json!({
                "jsonrpc": "2.0",
                "id": pending.id,
                "result": { "outcome": { "outcome": "cancelled" } },
            }));
            self.emit_update(AcpUpdate::PermissionClosed {
                request_id: pending.card.request_id,
                decision: "cancelled",
            });
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
                .position(|item| item.card.request_id == request_id)
                .ok_or("该授权请求已失效或已回答")?;
            permissions.remove(index)
        };
        let outcome = match option_id {
            Some(option) => {
                if !pending.card.options.iter().any(|item| item.option_id == option) {
                    // An option outside the card is not an answer: keep it.
                    guard(&self.permissions).push(pending);
                    return Err("该选项不属于此授权请求".into());
                }
                json!({ "outcome": { "outcome": "selected", "optionId": option } })
            }
            None => json!({ "outcome": { "outcome": "cancelled" } }),
        };
        self.write_value(&json!({ "jsonrpc": "2.0", "id": pending.id, "result": outcome }))?;
        let decision = if option_id.is_some() { "selected" } else { "cancelled" };
        self.emit_update(AcpUpdate::PermissionClosed {
            request_id: request_id.to_owned(),
            decision,
        });
        self.settle_state();
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
        guard(&self.permissions).clear();
        let waiting: Vec<u64> = guard(&self.pending).keys().copied().collect();
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
        self.notice("error", message.to_owned());
        self.publish();
    }
}

fn tool_detail(update: &Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(items) = update.get("content").and_then(Value::as_array) {
        for item in items {
            match item.get("type").and_then(Value::as_str) {
                Some("content") => {
                    if let Some(text) = item
                        .get("content")
                        .and_then(|content| content.get("text"))
                        .and_then(Value::as_str)
                    {
                        parts.push(text.to_owned());
                    }
                }
                Some("diff") => {
                    if let Some(path) = item.get("path").and_then(Value::as_str) {
                        parts.push(format!("文件：{path}"));
                    }
                }
                _ => {}
            }
        }
    }
    if let Some(input) = update.get("rawInput") {
        if !input.is_null() {
            parts.push(input.to_string());
        }
    }
    let (capped, _) = cap_text(&parts.join("\n"));
    capped.chars().take(MAX_TOOL_DETAIL_CHARS).collect()
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
    let session = Arc::new(Session {
        id: id.clone(),
        tool_id: spec.tool_id.clone(),
        project_id: spec.project_id.clone(),
        directory: spec.directory.clone(),
        mode: spec.mode,
        state: Mutex::new("starting"),
        native_session_id: Mutex::new(None),
        resume: Mutex::new("none"),
        messages: Mutex::new(Vec::new()),
        tools: Mutex::new(Vec::new()),
        permissions: Mutex::new(Vec::new()),
        diagnostics: Mutex::new(Vec::new()),
        last_turn_reason: Mutex::new(""),
        seq: AtomicU64::new(0),
        writer: Mutex::new(Some(writer)),
        shutdown: Mutex::new(shutdown),
        pending: Mutex::new(HashMap::new()),
        next_request: AtomicU64::new(0),
        turn: Mutex::new(None),
        timeout: spec.timeout,
        secret_session: Mutex::new(secret_session),
    });
    sessions().insert(id.clone(), Arc::clone(&session));

    let reader_session = Arc::clone(&session);
    std::thread::spawn(move || read_frames(reader_session, reader));
    if let Some(diagnostics) = diagnostics {
        let diagnostic_session = Arc::clone(&session);
        std::thread::spawn(move || read_diagnostics(diagnostic_session, diagnostics));
    }

    let handshake = (|| -> Result<(), String> {
        // Only capabilities this host can honour are published.
        let result = session.request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "clientCapabilities": {
                    "fs": { "readTextFile": false, "writeTextFile": false },
                    "terminal": false
                },
            }),
        )?;
        if let Some(methods) = result.get("authMethods").and_then(Value::as_array) {
            if !methods.is_empty() {
                let names: Vec<&str> = methods
                    .iter()
                    .filter_map(|method| method.get("id").and_then(Value::as_str))
                    .collect();
                session.diagnostic(&format!("该 agent 声明了认证方式：{}", names.join(", ")));
            }
        }
        let load_supported = result
            .get("agentCapabilities")
            .and_then(|capabilities| capabilities.get("loadSession"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let cwd = crate::launch::terminal_path(&spec.directory)?;
        let mut resumed = false;
        if let Some(native) = spec.resume_native_id.as_deref() {
            if load_supported {
                match session.request(
                    "session/load",
                    json!({ "sessionId": native, "cwd": cwd, "mcpServers": [] }),
                ) {
                    Ok(_) => {
                        *guard(&session.native_session_id) = Some(native.to_owned());
                        *guard(&session.resume) = "loaded";
                        resumed = true;
                    }
                    Err(error) => {
                        *guard(&session.resume) = "failed";
                        session.diagnostic(&format!("恢复原会话失败：{error}"));
                        session.notice("warning", "无法恢复原会话，已新建一段会话；首条提示不会自动重发");
                    }
                }
            } else {
                *guard(&session.resume) = "unsupported";
                session.notice("info", "该 agent 不支持恢复原会话，已新建一段会话");
            }
        }
        if !resumed {
            let result = session.request("session/new", json!({ "cwd": cwd, "mcpServers": [] }))?;
            let native = result
                .get("sessionId")
                .and_then(Value::as_str)
                .ok_or("agent 未返回会话编号，无法继续对话")?
                .to_owned();
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
#[path = "../../tests/launch/acp.rs"]
mod tests;
