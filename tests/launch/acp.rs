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
use std::time::Duration;

/// A reader fed by a channel: the scripted agent writes into it.
struct ChannelReader {
    receiver: Receiver<Vec<u8>>,
    pending: Vec<u8>,
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
struct Agent {
    inbox: Receiver<Vec<u8>>,
    outbox: Sender<Vec<u8>>,
    buffer: Vec<u8>,
}

impl Agent {
    fn next_line(&mut self) -> Value {
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

    fn send(&self, value: Value) {
        let mut text = serde_json::to_vec(&value).unwrap();
        text.push(b'\n');
        let _ = self.outbox.send(text);
    }

    fn send_raw(&self, bytes: &[u8]) {
        let _ = self.outbox.send(bytes.to_vec());
    }

    /// Answer the initialize request and the session/new request.
    fn handshake(&mut self, load_session: bool) -> Value {
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
    fn stay_connected(&mut self) {
        while self.inbox.recv().is_ok() {}
    }

    fn chunk(&self, session: &str, message: &str, text: &str) {
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

fn pair() -> (AcpIo, Agent) {
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

fn spec(directory: &Path) -> AcpStart {
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

fn temp_dir() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

fn snapshot_of(id: &str) -> AcpSessionSnapshot {
    snapshot(id).unwrap()
}

fn wait_for<T>(mut probe: impl FnMut() -> Option<T>, what: &str) -> T {
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
            current
                .messages
                .iter()
                .any(|message| message.text == "你好")
                .then_some(current)
        },
        "合并写入后的消息",
    );
    assert_eq!(merged.messages[0].role, "agent");
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
    let merged = current.messages.iter().find(|message| message.id == "a").unwrap();
    assert_eq!(merged.text, "第一段接续", "同一消息的增量必须按编号合并");
    assert_eq!(
        current.messages.iter().find(|message| message.id == "b").unwrap().text,
        "另一段"
    );
    let calls: Vec<_> = current.tools.iter().filter(|call| call.call_id == "call-1").collect();
    assert_eq!(calls.len(), 1, "工具更新必须按调用编号归并，而不是追加两次");
    assert_eq!(calls[0].status, "completed");
    assert!(calls[0].detail.contains("文件内容"));
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
    let card = wait_for(
        || snapshot_of(&snapshot.id).permissions.into_iter().next(),
        "授权卡",
    );
    assert_eq!(card.request_id, "900");
    assert_eq!(snapshot_of(&snapshot.id).state, "waiting_permission");
    // An option outside the card is not an answer and keeps the card alive.
    assert!(respond_permission(&snapshot.id, "900", Some("unknown")).is_err());
    assert_eq!(snapshot_of(&snapshot.id).permissions.len(), 1);
    respond_permission(&snapshot.id, "900", Some("allow")).unwrap();
    let answer = answer_rx.recv_timeout(Duration::from_secs(8)).unwrap();
    assert_eq!(answer["id"], 900);
    assert_eq!(answer["result"]["outcome"]["outcome"], "selected");
    assert_eq!(answer["result"]["outcome"]["optionId"], "allow");
    // A second answer is refused instead of replying twice on the wire.
    assert!(respond_permission(&snapshot.id, "900", Some("allow")).is_err());
    assert!(snapshot_of(&snapshot.id).permissions.is_empty());
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
    wait_for(|| (snapshot_of(&snapshot.id).permissions.len() == 1).then_some(()), "授权卡");
    let dead = wait_for(
        || (snapshot_of(&snapshot.id).state == "closed").then_some(snapshot_of(&snapshot.id)),
        "断线后的终态",
    );
    assert_eq!(dead.last_turn_reason, "disconnected");
    assert!(dead.permissions.is_empty(), "断线后授权卡必须失效");
    assert!(dead.messages.iter().any(|message| message.text == "已经收到的内容"));
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
        current.messages.iter().filter(|message| message.role == "user").count(),
        1
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
}
