//! Shared ACP host behaviour, exercised with an in-memory agent.
//!
//! Every case runs offline: the "agent" is a scripted thread that writes
//! protocol frames into the session's reader, so framing, ordering, permission
//! and cancellation races are all reproducible without a real CLI, a model or a
//! paid inference call.
use super::*;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

/// Every event the host emitted while the tests ran. Sessions have unique ids,
/// so a test reads only its own.
static EVENTS: LazyLock<Mutex<Vec<AcpEvent>>> = LazyLock::new(|| Mutex::new(Vec::new()));

pub(super) fn record(event: &AcpEvent) {
    guard(&EVENTS).push(event.clone());
}

/// The events one session emitted, in emission order.
pub(super) fn events_of(id: &str) -> Vec<AcpEvent> {
    guard(&EVENTS).iter().filter(|event| event.session_id == id).cloned().collect()
}

/// The messages of a snapshot, in timeline order.
pub(super) fn messages(snapshot: &AcpSessionSnapshot) -> Vec<AcpMessage> {
    snapshot
        .timeline
        .iter()
        .filter_map(|item| match item {
            AcpTimelineItem::Message(message) => Some(message.clone()),
            _ => None,
        })
        .collect()
}

/// The tool calls of a snapshot, in timeline order.
pub(super) fn tools(snapshot: &AcpSessionSnapshot) -> Vec<AcpToolCall> {
    snapshot
        .timeline
        .iter()
        .filter_map(|item| match item {
            AcpTimelineItem::Tool(call) => Some(call.clone()),
            _ => None,
        })
        .collect()
}

/// A reader fed by a channel: the scripted agent writes into it.
pub(super) struct ChannelReader {
    pub(super) receiver: Receiver<Vec<u8>>,
    pub(super) pending: Vec<u8>,
}

impl Read for ChannelReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if self.pending.is_empty() {
            match self.receiver.recv() {
                Ok(chunk) => self.pending = chunk,
                // The scripted agent dropped its writer: the connection ended.
                Err(_) => return Ok(0),
            }
        }
        let take = buffer.len().min(self.pending.len());
        buffer[..take].copy_from_slice(&self.pending[..take]);
        self.pending.drain(..take);
        Ok(take)
    }
}

struct ChannelWriter {
    sender: Sender<Vec<u8>>,
}

impl Write for ChannelWriter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let _ = self.sender.send(buffer.to_vec());
        Ok(buffer.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// The scripted agent. It reads the host's frames from its inbox and answers
/// through its outbox.
pub(super) struct Agent {
    pub(super) inbox: Receiver<Vec<u8>>,
    pub(super) outbox: Sender<Vec<u8>>,
    pub(super) buffer: Vec<u8>,
}

impl Agent {
    pub(super) fn next_line(&mut self) -> Value {
        loop {
            if let Some(position) = self.buffer.iter().position(|byte| *byte == b'\n') {
                let line: Vec<u8> = self.buffer.drain(..=position).collect();
                let text = std::str::from_utf8(&line[..line.len() - 1]).unwrap();
                return serde_json::from_str(text).expect("agent received a JSON frame");
            }
            match self.inbox.recv_timeout(Duration::from_secs(10)) {
                Ok(chunk) => self.buffer.extend_from_slice(&chunk),
                Err(_) => panic!("agent waited for a frame that never arrived"),
            }
        }
    }

    pub(super) fn send(&self, value: Value) {
        let mut text = serde_json::to_vec(&value).unwrap();
        text.push(b'\n');
        let _ = self.outbox.send(text);
    }

    pub(super) fn send_raw(&self, bytes: &[u8]) {
        let _ = self.outbox.send(bytes.to_vec());
    }

    /// Answer the initialize request and the session/new request.
    pub(super) fn handshake(&mut self, load_session: bool) -> Value {
        let initialize = self.next_line();
        assert_eq!(initialize["method"], "initialize");
        let id = initialize["id"].clone();
        self.send(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "protocolVersion": 1,
                "agentCapabilities": { "loadSession": load_session },
                "authMethods": [],
            },
        }));
        let new = self.next_line();
        assert_eq!(new["method"], "session/new");
        assert!(new["params"]["cwd"].is_string(), "会话必须带真实工作目录");
        let id = new["id"].clone();
        self.send(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": { "sessionId": "session-1" },
        }));
        initialize
    }

    /// Stay connected until the host closes the session. A real agent keeps
    /// running after a turn; the scripted one must too, or the session would
    /// report a disconnect the test never asked for.
    pub(super) fn stay_connected(&mut self) {
        while self.inbox.recv().is_ok() {}
    }

    pub(super) fn chunk(&self, session: &str, message: &str, text: &str) {
        self.send(json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": session,
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "messageId": message,
                    "content": { "type": "text", "text": text },
                },
            },
        }));
    }
}

pub(super) fn pair() -> (AcpIo, Agent) {
    let (host_writer, agent_inbox) = channel();
    let (agent_outbox, host_reader) = channel();
    let io = AcpIo {
        reader: Box::new(ChannelReader { receiver: host_reader, pending: Vec::new() }),
        writer: Box::new(ChannelWriter { sender: host_writer }),
        diagnostics: None,
        shutdown: None,
    };
    (io, Agent { inbox: agent_inbox, outbox: agent_outbox, buffer: Vec::new() })
}

pub(super) fn spec(directory: &Path) -> AcpStart {
    AcpStart {
        tool_id: "fixture-agent".into(),
        project_id: None,
        directory: directory.to_path_buf(),
        mode: LaunchMode::Normal,
        command: AcpCommand {
            program: PathBuf::from("acp-fixture"),
            args: vec!["serve".into()],
            environment: vec![("FIXTURE_MODE".into(), "acp".into())],
            remove_environment: vec!["FIXTURE_LEAK".into()],
            origin: "bridge",
        },
        environment: Vec::new(),
        remove_environment: Vec::new(),
        credential: None,
        session_markers: &["CLIORA_TEST_SESSION"],
        initial_prompt: None,
        resume_native_id: None,
        timeout: Duration::from_secs(5),
    }
}

pub(super) fn temp_dir() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

pub(super) fn snapshot_of(id: &str) -> AcpSessionSnapshot {
    snapshot(id).unwrap()
}

pub(super) fn wait_for<T>(mut probe: impl FnMut() -> Option<T>, what: &str) -> T {
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        if let Some(value) = probe() {
            return value;
        }
        assert!(Instant::now() < deadline, "等待{what}超时");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn frames_split_across_writes_are_reassembled_and_coalesced() {
    let directory = temp_dir();
    let (io, mut agent) = pair();
    let worker = std::thread::spawn(move || {
        let initialize = agent.next_line();
        assert_eq!(initialize["method"], "initialize");
        // Three writes, one frame: a frame boundary must not depend on one read
        // per message.
        let reply = json!({
            "jsonrpc": "2.0",
            "id": initialize["id"],
            "result": { "protocolVersion": 1, "agentCapabilities": { "loadSession": false } },
        });
        let text = serde_json::to_string(&reply).unwrap();
        let (head, rest) = text.split_at(7);
        agent.send_raw(head.as_bytes());
        let middle = rest.len() / 2;
        agent.send_raw(&rest.as_bytes()[..middle]);
        agent.send_raw(format!("{}\n", &rest[middle..]).as_bytes());

        let new = agent.next_line();
        // Two messages in one write: a coalesced read still yields both.
        let session = json!({
            "jsonrpc": "2.0",
            "id": new["id"],
            "result": { "sessionId": "session-1" },
        });
        let notice = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "session-1",
                "update": { "sessionUpdate": "agent_message_chunk", "messageId": "greeting",
                    "content": { "type": "text", "text": "你好" } },
            },
        });
        agent.send_raw(
            format!(
                "{}\n{}\n",
                serde_json::to_string(&session).unwrap(),
                serde_json::to_string(&notice).unwrap()
            )
            .as_bytes(),
        );
    });

    let snapshot = match open(spec(directory.path()), io) {
        Ok(snapshot) => snapshot,
        Err(error) => panic!("拆包后的握手仍应成功: {error} / {:?}", list()),
    };
    assert_eq!(snapshot.native_session_id.as_deref(), Some("session-1"));
    assert_eq!(snapshot.state, "ready");
    let merged = wait_for(
        || {
            let current = snapshot_of(&snapshot.id);
            messages(&current)
                .iter()
                .any(|message| message.text == "你好")
                .then_some(current)
        },
        "合并写入后的消息",
    );
    assert_eq!(messages(&merged)[0].role, "agent");
    close(&snapshot.id).unwrap();
    worker.join().unwrap();
}

#[test]
fn interleaved_updates_merge_by_call_and_message_id() {
    let directory = temp_dir();
    let (io, mut agent) = pair();
    let worker = std::thread::spawn(move || {
        agent.handshake(false);
        let prompt = agent.next_line();
        assert_eq!(prompt["method"], "session/prompt");
        // Two messages and two tool updates interleaved in one burst.
        agent.chunk("session-1", "a", "第一段");
        agent.chunk("session-1", "b", "另一段");
        agent.send(json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "session-1",
                "update": { "sessionUpdate": "tool_call", "toolCallId": "call-1", "title": "读取文件",
                    "status": "pending", "kind": "read" },
            },
        }));
        agent.chunk("session-1", "a", "接续");
        agent.send(json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "session-1",
                "update": { "sessionUpdate": "tool_call_update", "toolCallId": "call-1",
                    "status": "completed",
                    "content": [{ "type": "content", "content": { "type": "text", "text": "文件内容" } }] },
            },
        }));
        agent.send(json!({
            "jsonrpc": "2.0",
            "id": prompt["id"],
            "result": { "stopReason": "end_turn" },
        }));
        agent.stay_connected();
    });

    let snapshot = open(spec(directory.path()), io).unwrap();
    prompt(&snapshot.id, "请读取文件").unwrap();
    wait_until_idle(&snapshot.id, Duration::from_secs(8)).unwrap();
    let current = snapshot_of(&snapshot.id);
    let listed = messages(&current);
    let merged = listed.iter().find(|message| message.id == "a").unwrap();
    assert_eq!(merged.text, "第一段接续", "同一消息的增量必须按编号合并");
    assert_eq!(listed.iter().find(|message| message.id == "b").unwrap().text, "另一段");
    let listed_tools = tools(&current);
    let calls: Vec<_> = listed_tools.iter().filter(|call| call.call_id == "call-1").collect();
    assert_eq!(calls.len(), 1, "工具更新必须按调用编号归并，而不是追加两次");
    assert_eq!(calls[0].status, "completed");
    assert_eq!(calls[0].tool_kind, "read", "未在更新中出现的字段保持原值");
    assert_eq!(
        calls[0].content,
        vec![AcpToolContent::Text { text: "文件内容".into(), truncated: false }]
    );
    assert_eq!(current.last_turn_reason, "end_turn");
    assert_eq!(current.state, "ready");
    close(&snapshot.id).unwrap();
    worker.join().unwrap();
}

#[test]
fn permission_is_bound_to_the_turn_and_answered_at_most_once() {
    let directory = temp_dir();
    let (io, mut agent) = pair();
    let (answer_tx, answer_rx) = channel();
    let worker = std::thread::spawn(move || {
        agent.handshake(false);
        let prompt = agent.next_line();
        agent.send(json!({
            "jsonrpc": "2.0",
            "id": 900,
            "method": "session/request_permission",
            "params": {
                "sessionId": "session-1",
                "toolCall": { "toolCallId": "call-1", "title": "写入文件" },
                "options": [
                    { "optionId": "allow", "name": "允许一次", "kind": "allow_once" },
                    { "optionId": "reject", "name": "拒绝", "kind": "reject_once" },
                ],
            },
        }));
        // Exactly one answer must arrive for that request.
        let answer = agent.next_line();
        let _ = answer_tx.send(answer.clone());
        agent.send(json!({
            "jsonrpc": "2.0",
            "id": prompt["id"],
            "result": { "stopReason": "end_turn" },
        }));
        agent.stay_connected();
    });

    let snapshot = open(spec(directory.path()), io).unwrap();
    prompt(&snapshot.id, "请写文件").unwrap();
    let card = wait_for(|| snapshot_of(&snapshot.id).pending.into_iter().next(), "授权卡");
    assert_eq!(card, "900");
    // The card sits on the tool call it asks about, not in a separate list.
    let asked = tools(&snapshot_of(&snapshot.id));
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0].call_id, "call-1");
    assert_eq!(asked[0].title, "写入文件");
    assert_eq!(asked[0].permission.as_ref().map(|request| request.request_id.as_str()), Some("900"));
    assert_eq!(snapshot_of(&snapshot.id).state, "waiting_permission");
    // An option outside the card is not an answer and keeps the card alive.
    assert!(respond_permission(&snapshot.id, "900", Some("unknown")).is_err());
    assert_eq!(snapshot_of(&snapshot.id).pending.len(), 1);
    respond_permission(&snapshot.id, "900", Some("allow")).unwrap();
    let answer = answer_rx.recv_timeout(Duration::from_secs(8)).unwrap();
    assert_eq!(answer["id"], 900);
    assert_eq!(answer["result"]["outcome"]["outcome"], "selected");
    assert_eq!(answer["result"]["outcome"]["optionId"], "allow");
    // A second answer is refused instead of replying twice on the wire.
    assert!(respond_permission(&snapshot.id, "900", Some("allow")).is_err());
    assert!(snapshot_of(&snapshot.id).pending.is_empty());
    assert!(tools(&snapshot_of(&snapshot.id))[0].permission.is_none(), "回答后工具项上的授权卡必须撤下");
    close(&snapshot.id).unwrap();
    worker.join().unwrap();
}

#[test]
fn cancel_targets_only_the_current_turn() {
    let directory = temp_dir();
    let (io, mut agent) = pair();
    let worker = std::thread::spawn(move || {
        agent.handshake(false);
        let first = agent.next_line();
        assert_eq!(first["method"], "session/prompt");
        let stop = agent.next_line();
        assert_eq!(stop["method"], "session/cancel", "停止必须作为通知发给当前会话");
        assert_eq!(stop["params"]["sessionId"], "session-1");
        agent.send(json!({
            "jsonrpc": "2.0",
            "id": first["id"],
            "result": { "stopReason": "cancelled" },
        }));
        // A second turn is still accepted after the stop.
        let second = agent.next_line();
        assert_eq!(second["method"], "session/prompt");
        agent.send(json!({
            "jsonrpc": "2.0",
            "id": second["id"],
            "result": { "stopReason": "end_turn" },
        }));
    });

    let snapshot = open(spec(directory.path()), io).unwrap();
    prompt(&snapshot.id, "第一轮").unwrap();
    wait_for(|| (snapshot_of(&snapshot.id).state == "running").then_some(()), "轮次开始");
    cancel(&snapshot.id).unwrap();
    wait_until_idle(&snapshot.id, Duration::from_secs(8)).unwrap();
    assert_eq!(snapshot_of(&snapshot.id).last_turn_reason, "cancelled");
    prompt(&snapshot.id, "第二轮").unwrap();
    wait_until_idle(&snapshot.id, Duration::from_secs(8)).unwrap();
    assert_eq!(snapshot_of(&snapshot.id).last_turn_reason, "end_turn");
    // A stop with no running turn is refused rather than sent.
    assert!(cancel(&snapshot.id).is_err());
    worker.join().unwrap();
    close(&snapshot.id).unwrap();
}

#[test]
fn a_disconnect_keeps_content_and_drops_the_authorization_card() {
    let directory = temp_dir();
    let (io, mut agent) = pair();
    let worker = std::thread::spawn(move || {
        agent.handshake(false);
        agent.next_line(); // the prompt
        agent.chunk("session-1", "kept", "已经收到的内容");
        agent.send(json!({
            "jsonrpc": "2.0",
            "id": 901,
            "method": "session/request_permission",
            "params": {
                "sessionId": "session-1",
                "toolCall": { "toolCallId": "call-9", "title": "执行命令" },
                "options": [{ "optionId": "allow", "name": "允许", "kind": "allow_once" }],
            },
        }));
        // Wait for the card to be observed, then die without answering.
        std::thread::sleep(Duration::from_millis(150));
        drop(agent);
    });

    let snapshot = open(spec(directory.path()), io).unwrap();
    prompt(&snapshot.id, "请执行").unwrap();
    wait_for(|| (snapshot_of(&snapshot.id).pending.len() == 1).then_some(()), "授权卡");
    let dead = wait_for(
        || (snapshot_of(&snapshot.id).state == "closed").then_some(snapshot_of(&snapshot.id)),
        "断线后的终态",
    );
    assert_eq!(dead.last_turn_reason, "disconnected");
    assert!(dead.pending.is_empty(), "断线后授权卡必须失效");
    assert!(tools(&dead).iter().all(|call| call.permission.is_none()), "断线后工具项上不得留下授权卡");
    assert!(messages(&dead).iter().any(|message| message.text == "已经收到的内容"));
    // The session refuses new input instead of writing into a closed pipe.
    assert!(prompt(&snapshot.id, "还能继续吗").is_err());
    worker.join().unwrap();
    let _ = close(&snapshot.id);
}

#[test]
fn resume_requires_negotiated_load_and_falls_back_to_a_new_session() {
    // Negotiated and loaded: no session/new is sent.
    let directory = temp_dir();
    let (io, mut agent) = pair();
    let worker = std::thread::spawn(move || {
        let initialize = agent.next_line();
        agent.send(json!({
            "jsonrpc": "2.0",
            "id": initialize["id"],
            "result": { "protocolVersion": 1, "agentCapabilities": { "loadSession": true } },
        }));
        let load = agent.next_line();
        assert_eq!(load["method"], "session/load");
        assert_eq!(load["params"]["sessionId"], "previous-1");
        agent.send(json!({ "jsonrpc": "2.0", "id": load["id"], "result": {} }));
    });
    let mut start = spec(directory.path());
    start.resume_native_id = Some("previous-1".into());
    let snapshot = open(start, io).unwrap();
    assert_eq!(snapshot.resume, "loaded");
    assert_eq!(snapshot.native_session_id.as_deref(), Some("previous-1"));
    close(&snapshot.id).unwrap();
    worker.join().unwrap();

    // Not negotiated: a new session is created and the reason is recorded.
    let directory = temp_dir();
    let (io, mut agent) = pair();
    let worker = std::thread::spawn(move || {
        agent.handshake(false);
    });
    let mut start = spec(directory.path());
    start.resume_native_id = Some("previous-2".into());
    let snapshot = open(start, io).unwrap();
    assert_eq!(snapshot.resume, "unsupported");
    assert_eq!(snapshot.native_session_id.as_deref(), Some("session-1"));
    close(&snapshot.id).unwrap();
    worker.join().unwrap();

    // Negotiated but the load fails: a new session, and the failure is kept.
    let directory = temp_dir();
    let (io, mut agent) = pair();
    let worker = std::thread::spawn(move || {
        let initialize = agent.next_line();
        agent.send(json!({
            "jsonrpc": "2.0",
            "id": initialize["id"],
            "result": { "protocolVersion": 1, "agentCapabilities": { "loadSession": true } },
        }));
        let load = agent.next_line();
        agent.send(json!({
            "jsonrpc": "2.0",
            "id": load["id"],
            "error": { "code": -32602, "message": "unknown session" },
        }));
        let new = agent.next_line();
        assert_eq!(new["method"], "session/new");
        agent.send(json!({ "jsonrpc": "2.0", "id": new["id"], "result": { "sessionId": "fresh-1" } }));
    });
    let mut start = spec(directory.path());
    start.resume_native_id = Some("previous-3".into());
    let snapshot = open(start, io).unwrap();
    assert_eq!(snapshot.resume, "failed");
    assert_eq!(snapshot.native_session_id.as_deref(), Some("fresh-1"));
    assert!(snapshot.diagnostics.iter().any(|line| line.contains("恢复原会话失败")));
    close(&snapshot.id).unwrap();
    worker.join().unwrap();
}

#[test]
fn the_first_prompt_is_sent_exactly_once() {
    let directory = temp_dir();
    let (io, mut agent) = pair();
    let worker = std::thread::spawn(move || {
        agent.handshake(false);
        let prompt = agent.next_line();
        assert_eq!(prompt["method"], "session/prompt");
        assert_eq!(prompt["params"]["prompt"][0]["text"], "开工");
        agent.send(json!({
            "jsonrpc": "2.0",
            "id": prompt["id"],
            "result": { "stopReason": "end_turn" },
        }));
        // Nothing else may arrive: a duplicate first turn would show twice.
        assert!(agent.inbox.recv_timeout(Duration::from_millis(300)).is_err());
    });
    let mut start = spec(directory.path());
    start.initial_prompt = Some("开工".into());
    let snapshot = open(start, io).unwrap();
    wait_until_idle(&snapshot.id, Duration::from_secs(8)).unwrap();
    let current = snapshot_of(&snapshot.id);
    assert_eq!(
        messages(&current).iter().filter(|message| message.role == "user").count(),
        1
    );
    close(&snapshot.id).unwrap();
    worker.join().unwrap();
}

#[test]
fn a_secret_reference_is_forwarded_verbatim_and_never_resolved_here() {
    let directory = temp_dir();
    let (io, mut agent) = pair();
    let reference = "{{cliora-secret:11111111-2222-4333-8444-555555555555}}".to_string();
    let sent = reference.clone();
    let worker = std::thread::spawn(move || {
        agent.handshake(false);
        let prompt = agent.next_line();
        // The body keeps only the reference: the value stays behind the broker
        // and is never inserted into the protocol by this host.
        assert_eq!(prompt["params"]["prompt"][0]["text"], sent.as_str());
        agent.send(json!({
            "jsonrpc": "2.0",
            "id": prompt["id"],
            "result": { "stopReason": "end_turn" },
        }));
        agent.stay_connected();
    });
    let snapshot = open(spec(directory.path()), io).unwrap();
    prompt(&snapshot.id, &reference).unwrap();
    wait_until_idle(&snapshot.id, Duration::from_secs(8)).unwrap();
    let current = snapshot_of(&snapshot.id);
    assert!(messages(&current).iter().any(|message| message.text == reference));
    assert!(
        current.diagnostics.iter().all(|line| !line.contains("11111111-2222-4333-8444-555555555555")),
        "{:?}",
        current.diagnostics
    );
    close(&snapshot.id).unwrap();
    worker.join().unwrap();
}

#[test]
fn a_missing_working_directory_is_refused_before_connecting() {
    let (io, _agent) = pair();
    let mut start = spec(Path::new("no-such-directory-anywhere"));
    start.directory = PathBuf::from("no-such-directory-anywhere");
    let error = open(start, io).expect_err("目录不存在时必须失败");
    assert!(error.contains("工作目录"), "{error}");
}

#[test]
fn diagnostics_are_bounded_and_redacted() {
    let directory = temp_dir();
    let (mut io, mut agent) = pair();
    let (writer, reader) = channel();
    io.diagnostics = Some(Box::new(ChannelReader { receiver: reader, pending: Vec::new() }));
    let worker = std::thread::spawn(move || {
        agent.handshake(false);
        let mut text = String::new();
        text.push_str("warning {{cliora-secret:11111111-2222-4333-8444-555555555555}} leaked\n");
        text.push_str(&format!("token {}\n", "a".repeat(64)));
        for index in 0..60 {
            text.push_str(&format!("line {index}\n"));
        }
        let _ = writer.send(text.into_bytes());
        std::thread::sleep(Duration::from_millis(200));
    });
    let snapshot = open(spec(directory.path()), io).unwrap();
    let diagnostics = wait_for(
        || {
            let current = snapshot_of(&snapshot.id);
            (current.diagnostics.len() >= MAX_DIAGNOSTICS).then_some(current.diagnostics)
        },
        "有界诊断",
    );
    assert!(diagnostics.len() <= MAX_DIAGNOSTICS, "诊断行数必须有上限");
    assert!(
        diagnostics.iter().all(|line| !line.contains("11111111-2222-4333-8444-555555555555")),
        "秘密引用不得出现在诊断里：{diagnostics:?}"
    );
    assert!(
        diagnostics.iter().all(|line| !line.contains(&"a".repeat(64))),
        "长串凭证样式文本必须脱敏：{diagnostics:?}"
    );
    close(&snapshot.id).unwrap();
    worker.join().unwrap();
}

#[test]
fn a_frame_over_the_size_limit_fails_the_session_instead_of_growing() {
    let directory = temp_dir();
    let (io, mut agent) = pair();
    let worker = std::thread::spawn(move || {
        agent.handshake(false);
        // One line longer than the frame budget: the reader must refuse it
        // rather than buffer without bound.
        agent.send_raw(&vec![b'a'; MAX_FRAME_BYTES + 4096]);
        agent.stay_connected();
    });
    let snapshot = open(spec(directory.path()), io).unwrap();
    let failed = wait_for(
        || (snapshot_of(&snapshot.id).state == "failed").then_some(snapshot_of(&snapshot.id)),
        "帧超限后的失败状态",
    );
    assert!(
        failed.diagnostics.iter().any(|line| line.contains("超过大小上限")),
        "{:?}",
        failed.diagnostics
    );
    let _ = close(&snapshot.id);
    worker.join().unwrap();
}

#[test]
fn an_unknown_client_method_is_answered_with_method_not_found() {
    let directory = temp_dir();
    let (io, mut agent) = pair();
    let worker = std::thread::spawn(move || {
        agent.handshake(false);
        // This host does not advertise the file-system capability yet, so a
        // request for one has to be refused explicitly instead of hanging.
        agent.send(json!({
            "jsonrpc": "2.0",
            "id": 77,
            "method": "fs/read_text_file",
            "params": { "path": "/etc/hosts" },
        }));
        let reply = agent.next_line();
        assert_eq!(reply["id"], 77);
        assert_eq!(reply["error"]["code"], -32601, "未声明的客户端能力必须明确拒绝");
        agent.stay_connected();
    });
    let snapshot = open(spec(directory.path()), io).unwrap();
    wait_for(
        || {
            snapshot_of(&snapshot.id)
                .diagnostics
                .iter()
                .any(|line| line.contains("未声明的客户端能力"))
                .then_some(())
        },
        "拒绝未声明能力的记录",
    );
    close(&snapshot.id).unwrap();
    worker.join().unwrap();
}

#[test]
fn session_new_carries_the_selected_directory() {
    let directory = temp_dir();
    let expected = directory.path().canonicalize().unwrap();
    let (io, mut agent) = pair();
    let worker = std::thread::spawn(move || {
        let initialize = agent.next_line();
        agent.send(json!({
            "jsonrpc": "2.0",
            "id": initialize["id"],
            "result": { "protocolVersion": 1, "agentCapabilities": { "loadSession": false } },
        }));
        let new = agent.next_line();
        assert_eq!(new["method"], "session/new");
        let sent = PathBuf::from(new["params"]["cwd"].as_str().expect("会话必须带工作目录"));
        assert_eq!(
            sent.canonicalize().ok(),
            Some(expected),
            "session/new 必须使用选定的目录"
        );
        agent.send(json!({
            "jsonrpc": "2.0",
            "id": new["id"],
            "result": { "sessionId": "session-1" },
        }));
        agent.stay_connected();
    });
    let snapshot = open(spec(directory.path()), io).unwrap();
    assert_eq!(snapshot.native_session_id.as_deref(), Some("session-1"));
    close(&snapshot.id).unwrap();
    worker.join().unwrap();
}

#[test]
fn a_second_turn_is_refused_while_the_first_is_running() {
    let directory = temp_dir();
    let (io, mut agent) = pair();
    let worker = std::thread::spawn(move || {
        agent.handshake(false);
        let first = agent.next_line();
        assert_eq!(first["method"], "session/prompt");
        // The first turn stays open for a moment; nothing else may arrive.
        assert!(agent.inbox.recv_timeout(Duration::from_millis(200)).is_err(), "未完成的轮次不得接受第二轮");
        agent.send(json!({
            "jsonrpc": "2.0",
            "id": first["id"],
            "result": { "stopReason": "end_turn" },
        }));
        // Once the first turn ended, a second one is accepted.
        let second = agent.next_line();
        assert_eq!(second["method"], "session/prompt");
        agent.send(json!({
            "jsonrpc": "2.0",
            "id": second["id"],
            "result": { "stopReason": "end_turn" },
        }));
        agent.stay_connected();
    });
    let snapshot = open(spec(directory.path()), io).unwrap();
    prompt(&snapshot.id, "第一轮").unwrap();
    let refusal = prompt(&snapshot.id, "第二轮").unwrap_err();
    assert!(refusal.contains("尚未结束"), "{refusal}");
    wait_until_idle(&snapshot.id, Duration::from_secs(8)).unwrap();
    prompt(&snapshot.id, "第二轮").unwrap();
    wait_until_idle(&snapshot.id, Duration::from_secs(8)).unwrap();
    close(&snapshot.id).unwrap();
    worker.join().unwrap();
}

#[test]
fn an_unrecognized_stop_reason_is_reported_as_unknown() {
    let directory = temp_dir();
    let (io, mut agent) = pair();
    let worker = std::thread::spawn(move || {
        agent.handshake(false);
        let prompt = agent.next_line();
        // No stopReason at all: the turn ended for a reason this host cannot
        // name, so it must not claim a normal end.
        agent.send(json!({ "jsonrpc": "2.0", "id": prompt["id"], "result": {} }));
        let second = agent.next_line();
        assert_eq!(second["method"], "session/prompt");
        agent.send(json!({
            "jsonrpc": "2.0",
            "id": second["id"],
            "result": { "stopReason": "some_future_reason" },
        }));
        agent.stay_connected();
    });
    let snapshot = open(spec(directory.path()), io).unwrap();
    prompt(&snapshot.id, "第一轮").unwrap();
    wait_until_idle(&snapshot.id, Duration::from_secs(8)).unwrap();
    assert_eq!(snapshot_of(&snapshot.id).last_turn_reason, "unknown");
    assert!(turn_reason_text("unknown").contains("未知"));
    prompt(&snapshot.id, "第二轮").unwrap();
    wait_until_idle(&snapshot.id, Duration::from_secs(8)).unwrap();
    assert_eq!(snapshot_of(&snapshot.id).last_turn_reason, "unknown");
    close(&snapshot.id).unwrap();
    worker.join().unwrap();
}

#[test]
fn stopping_withdraws_the_card_and_refuses_a_late_answer() {
    let directory = temp_dir();
    let (io, mut agent) = pair();
    let worker = std::thread::spawn(move || {
        agent.handshake(false);
        let prompt = agent.next_line();
        agent.send(json!({
            "jsonrpc": "2.0",
            "id": 902,
            "method": "session/request_permission",
            "params": {
                "sessionId": "session-1",
                "toolCall": { "toolCallId": "call-2", "title": "删除文件" },
                "options": [{ "optionId": "allow", "name": "允许", "kind": "allow_once" }],
            },
        }));
        // The stop must reach the agent, and the card must already be withdrawn.
        let withdrawn = agent.next_line();
        assert_eq!(withdrawn["id"], 902);
        assert_eq!(withdrawn["result"]["outcome"]["outcome"], "cancelled");
        let stop = agent.next_line();
        assert_eq!(stop["method"], "session/cancel");
        agent.send(json!({
            "jsonrpc": "2.0",
            "id": prompt["id"],
            "result": { "stopReason": "cancelled" },
        }));
        agent.stay_connected();
    });
    let snapshot = open(spec(directory.path()), io).unwrap();
    prompt(&snapshot.id, "请删除").unwrap();
    wait_for(|| (snapshot_of(&snapshot.id).pending.len() == 1).then_some(()), "授权卡");
    cancel(&snapshot.id).unwrap();
    let stopping = snapshot_of(&snapshot.id);
    assert!(stopping.pending.is_empty(), "停止后授权卡必须立即撤下");
    assert!(tools(&stopping).iter().all(|call| call.permission.is_none()));
    assert_eq!(stopping.state, "stopping", "取消后到终态前都显示停止中");
    // The retired card can no longer be answered.
    let refused = respond_permission(&snapshot.id, "902", Some("allow")).unwrap_err();
    assert!(refused.contains("失效"), "{refused}");
    wait_until_idle(&snapshot.id, Duration::from_secs(8)).unwrap();
    let ended = snapshot_of(&snapshot.id);
    assert_eq!(ended.last_turn_reason, "cancelled");
    assert_eq!(ended.state, "ready");
    close(&snapshot.id).unwrap();
    worker.join().unwrap();
}

/// A start that cannot finish leaves neither a session nor a running agent.
#[test]
fn a_failed_start_removes_the_session_and_terminates_the_agent() {
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    let directory = temp_dir();
    let stopped = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&stopped);
    let (mut io, mut agent) = pair();
    io.shutdown = Some(Box::new(move || flag.store(true, Ordering::SeqCst)));
    let worker = std::thread::spawn(move || {
        let initialize = agent.next_line();
        agent.send(json!({
            "jsonrpc": "2.0",
            "id": initialize["id"],
            "error": { "code": -32000, "message": "not authenticated" },
        }));
    });
    let error = open(spec(directory.path()), io).expect_err("初始化失败必须报错");
    assert!(error.contains("not authenticated"), "{error}");
    assert!(stopped.load(Ordering::SeqCst), "失败的启动必须终止子进程");
    let leaked = list()
        .into_iter()
        .filter(|session| session.directory == directory.path().display().to_string())
        .count();
    assert_eq!(leaked, 0, "失败的启动不得留下会话");
    worker.join().unwrap();
}

/// The same for a first turn that cannot be submitted: the handshake succeeded,
/// so only the turn write fails.
#[test]
fn a_first_turn_that_cannot_be_sent_removes_the_session() {
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    struct FailAfterWriter {
        remaining: usize,
        sender: Sender<Vec<u8>>,
    }
    impl Write for FailAfterWriter {
        fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
            if self.remaining == 0 {
                return Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "closed"));
            }
            self.remaining -= 1;
            let _ = self.sender.send(buffer.to_vec());
            Ok(buffer.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    let directory = temp_dir();
    let stopped = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&stopped);
    let (host_writer, agent_inbox) = channel();
    let (agent_outbox, host_reader) = channel();
    let io = AcpIo {
        reader: Box::new(ChannelReader { receiver: host_reader, pending: Vec::new() }),
        // initialize and session/new succeed; session/prompt cannot be written.
        writer: Box::new(FailAfterWriter { remaining: 2, sender: host_writer }),
        diagnostics: None,
        shutdown: Some(Box::new(move || flag.store(true, Ordering::SeqCst))),
    };
    let mut agent = Agent { inbox: agent_inbox, outbox: agent_outbox, buffer: Vec::new() };
    let worker = std::thread::spawn(move || {
        agent.handshake(false);
        // Stay connected so the failure comes from the prompt write itself and
        // not from an agent that already disconnected.
        agent.stay_connected();
    });
    let mut start = spec(directory.path());
    start.initial_prompt = Some("开工".into());
    let error = open(start, io).expect_err("首轮写入失败必须报错");
    assert!(error.contains("无法写入"), "{error}");
    assert!(stopped.load(Ordering::SeqCst), "失败的启动必须终止子进程");
    let leaked = list()
        .into_iter()
        .filter(|session| session.directory == directory.path().display().to_string())
        .count();
    assert_eq!(leaked, 0, "首轮失败的会话不得留在注册表里");
    worker.join().unwrap();
}

/// The agent receives the token of its own broker session and never the one
/// this process holds.
#[test]
fn the_child_receives_its_own_secret_session_token() {
    let directory = temp_dir();
    let output = directory.path().join("token.txt");
    #[cfg(windows)]
    let program = {
        let path = directory.path().join("dump-token.cmd");
        std::fs::write(
            &path,
            format!("@echo off\r\n> \"{}\" echo %CLIORA_SECRET_SESSION%\r\n", output.display()),
        )
        .unwrap();
        path
    };
    #[cfg(unix)]
    let program = {
        use std::os::unix::fs::PermissionsExt;
        let path = directory.path().join("dump-token.sh");
        std::fs::write(
            &path,
            format!("#!/bin/sh\nprintenv CLIORA_SECRET_SESSION > \"{}\"\n", output.display()),
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    };
    let mut start = spec(directory.path());
    start.command.program = program;
    start.command.args = Vec::new();
    // A stale token a caller could have forwarded: it must never reach the
    // child, because the host writes the real one after removing the name.
    start.environment = vec![(crate::secrets::session::ENV.to_owned(), "stale-parent-token".to_owned())];
    let (mut io, token_guard) = spawn_io(&start).unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    while !output.exists() {
        assert!(Instant::now() < deadline, "子进程没有写出环境");
        std::thread::sleep(Duration::from_millis(20));
    }
    let seen = std::fs::read_to_string(&output).unwrap();
    let seen = seen.trim().to_string();
    assert_ne!(seen, "stale-parent-token", "子进程不得继承旧令牌");
    assert_eq!(seen.len(), 36, "子进程必须拿到一个新会话令牌：{seen}");
    assert_eq!(seen, token_guard.token().to_owned(), "令牌必须属于该会话本身的 broker 会话");
    if let Some(mut stop) = io.shutdown.take() {
        stop();
    }
}

#[cfg(unix)]
#[test]
fn closing_a_conversation_terminates_the_agents_process_tree() {
    use std::os::unix::fs::PermissionsExt;

    let directory = temp_dir();
    let pid_file = directory.path().join("descendant.pid");
    let script = directory.path().join("agent-tree.sh");
    std::fs::write(
        &script,
        format!("#!/bin/sh\nsleep 30 &\necho $! > \"{}\"\nwait\n", pid_file.display()),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut start = spec(directory.path());
    start.command.program = script;
    start.command.args = Vec::new();
    let (mut io, _token) = spawn_io(&start).unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    while !pid_file.exists() {
        assert!(Instant::now() < deadline, "后代进程没有启动");
        std::thread::sleep(Duration::from_millis(20));
    }
    let pid: u32 = std::fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();
    if let Some(mut stop) = io.shutdown.take() {
        stop();
    }
    // The whole group must go: the agent is a group leader, so its own children
    // are stopped with it instead of surviving as orphans.
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let alive = std::process::Command::new("/bin/kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if !alive {
            break;
        }
        assert!(Instant::now() < deadline, "子进程树没有被终止");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn the_child_environment_keeps_the_planned_boundaries() {
    let mut start = spec(Path::new("."));
    start.credential = Some(("FIXTURE_KEY".into(), "value".into()));
    let environment = child_environment(&start);
    assert!(environment.set.contains(&("FIXTURE_MODE".to_string(), "acp".to_string())));
    assert!(environment.set.iter().any(|(name, _)| name == "FIXTURE_KEY"));
    // The adapter's own removals, the plan's removals and the session markers
    // a nested session must not inherit.
    assert!(environment.remove.contains(&"FIXTURE_LEAK".to_string()));
    assert!(environment.remove.contains(&"CLIORA_TEST_SESSION".to_string()));
    assert!(environment.remove.contains(&"NO_COLOR".to_string()));
    assert!(
        !environment.set.iter().any(|(name, _)| name == "FIXTURE_LEAK"),
        "被移除的变量不得又被设回"
    );
    // A token this process holds for its own broker session must never be
    // inherited: the child gets its own, written after this removal.
    let token_name = crate::secrets::session::ENV.to_string();
    assert!(environment.remove.contains(&token_name), "子进程不得继承父进程的令牌");
    assert!(!environment.set.iter().any(|(name, _)| name == &token_name));
}

