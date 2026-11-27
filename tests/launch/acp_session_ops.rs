//! Session operations an ACP conversation offers beyond a turn: login
//! (`authenticate`), structured questions (`elicitation/create`), prompts with
//! attachments, the project file list for `@` references, the agent's own
//! session history (list, resume, load, delete) and the restore record fixes.
//! The agent is the same in-memory script as `acp.rs`; files are real, in
//! temporary directories, so nothing here starts a CLI or calls a model.
use super::tests::{events_of, messages, pair, snapshot_of, spec, temp_dir, wait_for, Agent};
use super::*;
use base64::Engine;
use std::path::Path;
use std::sync::mpsc::channel;
use std::time::Duration;

fn reply(agent: &Agent, frame: &Value, result: Value) {
    agent.send(json!({ "jsonrpc": "2.0", "id": frame["id"], "result": result }));
}

fn refuse(agent: &Agent, frame: &Value, code: i64, message: &str) {
    agent.send(json!({ "jsonrpc": "2.0", "id": frame["id"], "error": { "code": code, "message": message } }));
}

/// Answer initialize with the given result.
fn initialize(agent: &mut Agent, result: Value) -> Value {
    let frame = agent.next_line();
    assert_eq!(frame["method"], "initialize");
    reply(agent, &frame, result);
    frame
}

/// Answer the next session/new with a session id.
fn create(agent: &mut Agent, native: &str) -> Value {
    let frame = agent.next_line();
    assert_eq!(frame["method"], "session/new", "{frame}");
    reply(agent, &frame, json!({ "sessionId": native }));
    frame
}

/// Every frame the host still writes until it closes the connection.
fn drain(agent: &mut Agent) -> Vec<Value> {
    while let Ok(chunk) = agent.inbox.recv() {
        agent.buffer.extend_from_slice(&chunk);
    }
    let text = String::from_utf8(std::mem::take(&mut agent.buffer)).unwrap();
    text.lines().filter(|line| !line.trim().is_empty()).map(|line| serde_json::from_str(line).unwrap()).collect()
}

fn forms(snapshot: &AcpSessionSnapshot) -> Vec<AcpElicitation> {
    snapshot
        .timeline
        .iter()
        .filter_map(|item| match item {
            AcpTimelineItem::Elicitation(form) => Some(form.clone()),
            _ => None,
        })
        .collect()
}

fn notices(snapshot: &AcpSessionSnapshot) -> Vec<&'static str> {
    snapshot
        .timeline
        .iter()
        .filter_map(|item| match item {
            AcpTimelineItem::Notice(notice) => Some(notice.code),
            _ => None,
        })
        .collect()
}

/// The request id of the `index`-th form (1-based) once it is pending.
fn open_form(id: &str, index: usize) -> String {
    wait_for(
        || {
            let current = snapshot_of(id);
            forms(&current)
                .get(index - 1)
                .and_then(|form| form.request_id.clone())
                .filter(|request| current.pending.contains(request))
        },
        "结构化提问表单",
    )
}

// ---------------------------------------------------------------- login

#[test]
fn a_login_is_required_then_a_failed_login_keeps_the_reason_and_a_retry_opens_the_session() {
    let directory = temp_dir();
    let (io, mut agent) = pair();
    let (prompt_tx, prompt_rx) = channel();
    let worker = std::thread::spawn(move || {
        initialize(
            &mut agent,
            json!({
                "protocolVersion": 1,
                "agentCapabilities": {},
                "authMethods": [
                    { "id": "login", "name": "浏览器登录", "description": "在浏览器中完成登录" },
                    { "id": "tty", "name": "终端登录", "type": "terminal", "args": ["--login"] },
                ],
            }),
        );
        let new = agent.next_line();
        assert_eq!(new["method"], "session/new");
        refuse(&agent, &new, -32000, "Authentication required");
        // The first login is refused by the agent.
        let login = agent.next_line();
        assert_eq!(login["method"], "authenticate");
        assert_eq!(login["params"], json!({ "methodId": "login" }));
        refuse(&agent, &login, -32603, "login was cancelled");
        // The retry succeeds and the session is created right after it.
        let login = agent.next_line();
        assert_eq!(login["method"], "authenticate");
        reply(&agent, &login, json!({}));
        create(&mut agent, "session-1");
        // The launch's first prompt waited for the login and is sent once.
        let prompt = agent.next_line();
        assert_eq!(prompt["method"], "session/prompt");
        let _ = prompt_tx.send(prompt.clone());
        reply(&agent, &prompt, json!({ "stopReason": "end_turn" }));
        let rest = drain(&mut agent);
        assert!(rest.iter().all(|frame| frame["method"] != "session/prompt"), "首条提示只发送一次");
    });
    let mut start = spec(directory.path());
    start.initial_prompt = Some("登录后开工".into());
    let snapshot = open(start, io).expect("需要登录不是启动失败");
    assert_eq!(snapshot.state, "auth_required");
    assert!(snapshot.native_session_id.is_none());
    let methods: Vec<&str> = snapshot.agent.auth_methods.iter().map(|method| method.id.as_str()).collect();
    assert_eq!(methods, ["login", "tty"], "快照列出各认证方式");
    assert_eq!(snapshot.agent.auth_methods[1].kind, "terminal");
    assert!(snapshot.auth_error.as_deref().unwrap().contains("Authentication required"));
    assert!(notices(&snapshot).contains(&"auth_required"));
    // Nothing can be sent before the login.
    assert!(prompt(&snapshot.id, "现在可以吗").is_err());
    // A terminal method is not answered through the protocol, and an unknown
    // method is refused without a request.
    assert!(authenticate(&snapshot.id, "tty").unwrap_err().contains("终端"));
    assert!(authenticate(&snapshot.id, "unknown").is_err());

    let failed = authenticate(&snapshot.id, "login").unwrap_err();
    assert!(failed.contains("login was cancelled"), "{failed}");
    let waiting = snapshot_of(&snapshot.id);
    assert_eq!(waiting.state, "auth_required", "登录失败后仍等待登录，可重试");
    assert!(waiting.auth_error.as_deref().unwrap().contains("login was cancelled"));

    authenticate(&snapshot.id, "login").unwrap();
    let prompt_frame = prompt_rx.recv_timeout(Duration::from_secs(8)).unwrap();
    assert_eq!(prompt_frame["params"]["sessionId"], "session-1");
    assert_eq!(prompt_frame["params"]["prompt"][0]["text"], "登录后开工");
    wait_until_idle(&snapshot.id, Duration::from_secs(8)).unwrap();
    let ready = snapshot_of(&snapshot.id);
    assert_eq!(ready.state, "ready");
    assert!(ready.auth_error.is_none());
    assert_eq!(ready.native_session_id.as_deref(), Some("session-1"));
    assert!(notices(&ready).contains(&"authenticated"));
    // Logged in: a second login is not asked for.
    assert!(authenticate(&snapshot.id, "login").is_err());
    close(&snapshot.id).unwrap();
    worker.join().unwrap();
}

#[test]
fn any_session_error_counts_as_a_login_only_when_the_agent_declares_methods() {
    // Declared methods: an ordinary error from session/new means "log in".
    let directory = temp_dir();
    let (io, mut agent) = pair();
    let worker = std::thread::spawn(move || {
        initialize(
            &mut agent,
            json!({ "protocolVersion": 1, "authMethods": [{ "id": "login", "name": "登录" }] }),
        );
        let new = agent.next_line();
        refuse(&agent, &new, -32603, "not logged in");
        agent.stay_connected();
    });
    let snapshot = open(spec(directory.path()), io).unwrap();
    assert_eq!(snapshot.state, "auth_required");
    assert!(list_ids().contains(&snapshot.id));
    close(&snapshot.id).unwrap();
    worker.join().unwrap();

    // No methods: the same error is a failed start.
    let directory = temp_dir();
    let (io, mut agent) = pair();
    let worker = std::thread::spawn(move || {
        initialize(&mut agent, json!({ "protocolVersion": 1, "authMethods": [] }));
        let new = agent.next_line();
        refuse(&agent, &new, -32603, "not logged in");
        drain(&mut agent);
    });
    let failure = open(spec(directory.path()), io).unwrap_err();
    assert!(failure.contains("not logged in"), "{failure}");
    worker.join().unwrap();
}

// ---------------------------------------------------------------- elicitation

#[test]
fn an_elicitation_form_is_answered_once_validated_and_withdrawn_on_stop_turn_end_and_close() {
    let directory = temp_dir();
    let (io, mut agent) = pair();
    let (init_tx, init_rx) = channel();
    let schema = json!({
        "type": "object",
        "properties": {
            "name": { "type": "string", "minLength": 1 },
            "count": { "type": "integer", "minimum": 1 },
            "color": { "type": "string", "enum": ["red", "blue"] },
            "tags": { "type": "array", "items": { "enum": ["a", "b"] } },
            "ok": { "type": "boolean" },
        },
        "required": ["name"],
    });
    let agent_schema = schema.clone();
    let worker = std::thread::spawn(move || {
        let initialize = agent.handshake(false);
        let _ = init_tx.send(initialize);
        let ask = |agent: &Agent, id: u64, mode: &str| {
            let mut params = json!({ "sessionId": "session-1", "message": "怎么称呼你？", "requestedSchema": agent_schema });
            // An empty mode stands for a request that omits it: that is a form.
            if !mode.is_empty() {
                params["mode"] = json!(mode);
            }
            agent.send(json!({ "jsonrpc": "2.0", "id": id, "method": "elicitation/create", "params": params }));
        };
        let prompt = agent.next_line();
        // Accepted, with the submitted content.
        ask(&agent, 50, "form");
        let answer = agent.next_line();
        assert_eq!(answer["id"], 50);
        assert_eq!(
            answer["result"],
            json!({ "action": "accept", "content": { "name": "小明", "count": 3, "color": "red", "tags": ["a"], "ok": true } })
        );
        ask(&agent, 51, "form");
        let answer = agent.next_line();
        assert_eq!(answer, json!({ "jsonrpc": "2.0", "id": 51, "result": { "action": "decline" } }));
        // No mode at all is still a form.
        ask(&agent, 52, "");
        let answer = agent.next_line();
        assert_eq!(answer["result"], json!({ "action": "cancel" }));
        // A mode the client did not advertise is invalid params.
        ask(&agent, 53, "url");
        let answer = agent.next_line();
        assert_eq!(answer["id"], 53);
        assert_eq!(answer["error"]["code"], -32602);
        // A stop withdraws the open form before the cancel notification.
        ask(&agent, 54, "form");
        let answer = agent.next_line();
        assert_eq!(answer, json!({ "jsonrpc": "2.0", "id": 54, "result": { "action": "cancel" } }));
        let cancel = agent.next_line();
        assert_eq!(cancel["method"], "session/cancel");
        reply(&agent, &prompt, json!({ "stopReason": "cancelled" }));
        // The end of the turn that asked withdraws its form.
        let prompt = agent.next_line();
        ask(&agent, 55, "form");
        reply(&agent, &prompt, json!({ "stopReason": "end_turn" }));
        let answer = agent.next_line();
        assert_eq!(answer, json!({ "jsonrpc": "2.0", "id": 55, "result": { "action": "cancel" } }));
        // A form asked between turns stays until the session ends.
        ask(&agent, 56, "form");
        let rest = drain(&mut agent);
        assert!(
            rest.iter().any(|frame| frame["id"] == 56 && frame["result"] == json!({ "action": "cancel" })),
            "会话结束时未回答的表单收到取消：{rest:?}"
        );
    });
    let snapshot = open(spec(directory.path()), io).unwrap();
    let declared = init_rx.recv_timeout(Duration::from_secs(8)).unwrap();
    assert_eq!(declared["params"]["clientCapabilities"]["elicitation"], json!({ "form": {} }), "只声明表单形式");
    let id = snapshot.id.clone();
    prompt(&id, "需要问你点事").unwrap();

    let first = open_form(&id, 1);
    wait_for(|| (snapshot_of(&id).state == "waiting_permission").then_some(()), "等待表单的状态");
    let current = snapshot_of(&id);
    let form = &forms(&current)[0];
    assert_eq!((form.decision, form.message.as_str()), ("pending", "怎么称呼你？"));
    assert_eq!(form.requested_schema, schema);
    assert!(!form.turn_id.is_empty());
    // Content that does not fit the schema is refused and the form stays open.
    for (content, reason) in [
        (json!({}), "name"),
        (json!({ "name": "" }), "太短"),
        (json!({ "name": "小明", "count": 1.5 }), "整数"),
        (json!({ "name": "小明", "count": "3" }), "数字"),
        (json!({ "name": "小明", "color": "green" }), "可选项"),
        (json!({ "name": "小明", "tags": ["c"] }), "可选项"),
        (json!({ "name": "小明", "extra": 1 }), "extra"),
        (json!("小明"), "对象"),
    ] {
        let error = respond_elicitation(&id, &first, "accept", Some(&content)).unwrap_err();
        assert!(error.contains(reason), "{content}: {error}");
    }
    assert!(respond_elicitation(&id, &first, "maybe", None).is_err());
    assert!(snapshot_of(&id).pending.contains(&first), "校验失败不提交，表单保留");
    let content = json!({ "name": "小明", "count": 3, "color": "red", "tags": ["a"], "ok": true });
    respond_elicitation(&id, &first, "accept", Some(&content)).unwrap();
    assert!(respond_elicitation(&id, &first, "accept", Some(&content)).is_err(), "只回答一次");
    assert_eq!(forms(&snapshot_of(&id))[0].decision, "accepted");

    let second = open_form(&id, 2);
    respond_elicitation(&id, &second, "decline", None).unwrap();
    let third = open_form(&id, 3);
    respond_elicitation(&id, &third, "cancel", None).unwrap();
    let fourth = open_form(&id, 4);
    assert_eq!(forms(&snapshot_of(&id)).len(), 4, "未声明的 url 形式不生成表单");
    cancel(&id).unwrap();
    assert!(respond_elicitation(&id, &fourth, "decline", None).is_err(), "停止后迟到的回应被拒收");
    let decisions: Vec<&str> = forms(&snapshot_of(&id)).iter().map(|form| form.decision).collect();
    assert_eq!(decisions, ["accepted", "declined", "cancelled", "withdrawn"]);
    wait_until_idle(&id, Duration::from_secs(8)).unwrap();

    prompt(&id, "再问一次").unwrap();
    let withdrawn = wait_for(
        || forms(&snapshot_of(&id)).get(4).filter(|form| form.decision == "withdrawn").cloned(),
        "轮次结束撤回表单",
    );
    assert!(respond_elicitation(&id, &withdrawn.id, "cancel", None).is_err(), "轮次结束后迟到的回应被拒收");
    wait_until_idle(&id, Duration::from_secs(8)).unwrap();
    let between = open_form(&id, 6);
    assert!(forms(&snapshot_of(&id))[5].turn_id.is_empty(), "轮次之间的表单不属于任何轮次");
    wait_for(|| (snapshot_of(&id).state == "waiting_permission").then_some(()), "轮次之间的表单等待用户");
    close(&id).unwrap();
    assert!(respond_elicitation(&id, &between, "cancel", None).is_err());
    worker.join().unwrap();
}

#[test]
fn the_form_content_check_follows_the_schema() {
    let schema = json!({
        "type": "object",
        "properties": {
            "email": { "type": "string", "maxLength": 5 },
            "level": { "type": "string", "oneOf": [{ "const": "low", "title": "低" }, { "const": "high", "title": "高" }] },
            "ratio": { "type": "number", "minimum": 0, "maximum": 1 },
            "picks": { "type": "array", "items": { "anyOf": [{ "const": "x" }, { "const": "y" }] }, "maxItems": 1 },
        },
    });
    assert!(elicitation::check_content(&schema, None).is_ok(), "没有必填字段时可以不带内容");
    assert!(elicitation::check_content(&schema, Some(&json!({ "level": "high", "ratio": 0.5, "picks": ["y"] }))).is_ok());
    assert!(elicitation::check_content(&schema, Some(&json!({ "email": "123456" }))).is_err());
    assert!(elicitation::check_content(&schema, Some(&json!({ "level": "mid" }))).is_err());
    assert!(elicitation::check_content(&schema, Some(&json!({ "ratio": 2 }))).is_err());
    assert!(elicitation::check_content(&schema, Some(&json!({ "picks": ["x", "y"] }))).is_err());
    assert!(elicitation::check_content(&schema, Some(&json!({ "picks": "x" }))).is_err());
}

// ---------------------------------------------------------------- attachments

fn png() -> String {
    base64::engine::general_purpose::STANDARD.encode([0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
}

fn image(mime: &str, data: String) -> AcpAttachment {
    AcpAttachment::Image { mime_type: mime.into(), data_base64: data }
}

fn file(path: impl Into<String>) -> AcpAttachment {
    AcpAttachment::File { path: path.into() }
}

#[test]
fn files_inside_are_embedded_or_linked_and_files_outside_need_approval() {
    let temp = temp_dir();
    let directory = temp.path().join("project");
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join("notes.md"), "# 标题\n正文\n").unwrap();
    std::fs::write(directory.join("big.log"), "a".repeat(600 * 1024)).unwrap();
    std::fs::write(directory.join("binary.bin"), [0xff, 0xfe, 0x00, 0x01]).unwrap();
    let outside = temp.path().join("outside.txt");
    std::fs::write(&outside, "目录外的内容").unwrap();
    let (io, mut agent) = pair();
    let (prompts_tx, prompts_rx) = channel();
    let worker = std::thread::spawn(move || {
        initialize(
            &mut agent,
            json!({ "protocolVersion": 1, "agentCapabilities": { "promptCapabilities": { "image": false, "embeddedContext": true } } }),
        );
        create(&mut agent, "session-1");
        for _ in 0..2 {
            let prompt = agent.next_line();
            assert_eq!(prompt["method"], "session/prompt");
            let _ = prompts_tx.send(prompt.clone());
            reply(&agent, &prompt, json!({ "stopReason": "end_turn" }));
        }
        drain(&mut agent)
    });
    let snapshot = open(spec(&std::fs::canonicalize(&directory).unwrap()), io).unwrap();
    let id = snapshot.id.clone();

    // No image capability: refused before a turn exists.
    let refused = prompt_with(&id, "看图", &[image("image/png", png())]).unwrap_err();
    assert!(refused.contains("图片"), "{refused}");
    assert!(messages(&snapshot_of(&id)).is_empty(), "被拒绝的提示不进入时间线");
    assert_eq!(snapshot_of(&id).state, "ready");

    let big = directory.join("big.log").display().to_string();
    prompt_with(&id, "看看这些", &[file("notes.md"), file(big), file("binary.bin")]).unwrap();
    let sent = prompts_rx.recv_timeout(Duration::from_secs(8)).unwrap();
    let blocks = sent["params"]["prompt"].as_array().unwrap().clone();
    assert_eq!(blocks.len(), 4, "{blocks:?}");
    assert_eq!(blocks[0], json!({ "type": "text", "text": "看看这些" }));
    assert_eq!(blocks[1]["type"], "resource", "小文本文件在 embeddedContext 下内嵌");
    assert_eq!(blocks[1]["resource"]["text"], "# 标题\n正文\n");
    assert_eq!(blocks[1]["resource"]["mimeType"], "text/markdown");
    assert!(blocks[1]["resource"]["uri"].as_str().unwrap().starts_with("file:///"));
    assert!(blocks[1]["resource"]["uri"].as_str().unwrap().ends_with("/project/notes.md"));
    assert_eq!(blocks[2]["type"], "resource_link", "超过 512 KiB 的文件只发送引用");
    assert_eq!(blocks[2]["name"], "big.log");
    assert_eq!(blocks[2]["size"], 600 * 1024);
    assert_eq!(blocks[3]["type"], "resource_link", "非文本文件只发送引用");
    wait_until_idle(&id, Duration::from_secs(8)).unwrap();
    let user = messages(&snapshot_of(&id)).into_iter().find(|message| message.role == "user").unwrap();
    assert_eq!(user.text, "看看这些");
    let labels: Vec<(&str, &str, Option<&str>)> =
        user.attachments.iter().map(|label| (label.kind, label.name.as_str(), label.delivery)).collect();
    assert_eq!(
        labels,
        [("file", "notes.md", Some("embedded")), ("file", "big.log", Some("link")), ("file", "binary.bin", Some("link"))]
    );
    let serialized = serde_json::to_string(&snapshot_of(&id)).unwrap();
    assert!(!serialized.contains("aaaaaaaaaaaaaaaa"), "附件内容不进入快照");

    // Outside the directory: the user approves once, then the prompt is sent.
    let outside_text = outside.display().to_string();
    let (done_tx, done_rx) = channel();
    let session = id.clone();
    let path = outside_text.clone();
    std::thread::spawn(move || {
        let _ = done_tx.send(prompt_with(&session, "", &[file(path)]));
    });
    let card = wait_for(|| snapshot_of(&id).pending.first().cloned(), "目录外附件的审批卡");
    respond_access(&id, &card, "once").unwrap();
    done_rx.recv_timeout(Duration::from_secs(8)).unwrap().unwrap();
    let sent = prompts_rx.recv_timeout(Duration::from_secs(8)).unwrap();
    let blocks = sent["params"]["prompt"].as_array().unwrap().clone();
    assert_eq!(blocks.len(), 1, "空文本不发送文本块");
    assert_eq!(blocks[0]["resource"]["text"], "目录外的内容");
    wait_until_idle(&id, Duration::from_secs(8)).unwrap();

    // Denied: nothing is sent and the turn never starts.
    let (done_tx, done_rx) = channel();
    let session = id.clone();
    std::thread::spawn(move || {
        let _ = done_tx.send(prompt_with(&session, "再看一次", &[file(outside_text)]));
    });
    let card = wait_for(|| snapshot_of(&id).pending.first().cloned(), "第二张审批卡");
    respond_access(&id, &card, "deny").unwrap();
    let denied = done_rx.recv_timeout(Duration::from_secs(8)).unwrap().unwrap_err();
    assert!(denied.contains("拒绝"), "{denied}");
    let after = snapshot_of(&id);
    assert_eq!(after.state, "ready");
    assert!(!messages(&after).iter().any(|message| message.text == "再看一次"));
    close(&id).unwrap();
    let rest = worker.join().unwrap();
    assert!(rest.iter().all(|frame| frame["method"] != "session/prompt"), "被拒绝的附件不发出提示");
}

#[test]
fn a_stop_while_an_attachment_waits_for_approval_ends_the_turn_and_sends_nothing() {
    let temp = temp_dir();
    let directory = temp.path().join("project");
    std::fs::create_dir_all(&directory).unwrap();
    let outside = temp.path().join("outside.txt");
    std::fs::write(&outside, "目录外的内容").unwrap();
    let (io, mut agent) = pair();
    let worker = std::thread::spawn(move || {
        agent.handshake(false);
        drain(&mut agent)
    });
    let id = open(spec(&std::fs::canonicalize(&directory).unwrap()), io).unwrap().id;
    let outside = outside.display().to_string();
    // Repeated: the stop and the turn's own thread race to settle the state.
    for round in 0..20 {
        let (done_tx, done_rx) = channel();
        let session = id.clone();
        let path = outside.clone();
        std::thread::spawn(move || {
            let _ = done_tx.send(prompt_with(&session, "看看外面", &[file(path)]));
        });
        let card = wait_for(|| snapshot_of(&id).pending.first().cloned(), "目录外附件的审批卡");
        if round == 0 {
            // The message that caused the card stands before it.
            let waiting = snapshot_of(&id);
            let message = waiting.timeline.iter().position(|item| matches!(item, AcpTimelineItem::Message(message) if message.role == "user")).unwrap();
            let access = waiting.timeline.iter().position(|item| matches!(item, AcpTimelineItem::Access(_))).unwrap();
            assert!(message < access, "用户消息在它引起的审批卡之前");
            let user = messages(&waiting).into_iter().find(|message| message.role == "user").unwrap();
            assert_eq!(user.attachments.len(), 1);
            assert_eq!(user.attachments[0].kind, "file");
        }
        cancel(&id).unwrap();
        let stopped = done_rx.recv_timeout(Duration::from_secs(8)).unwrap().unwrap_err();
        assert!(!stopped.is_empty());
        wait_until_idle(&id, Duration::from_secs(8)).expect("停止后不会停在 stopping");
        let after = snapshot_of(&id);
        assert_eq!(after.state, "ready", "round {round}");
        assert!(after.pending.is_empty());
        assert!(!messages(&after).iter().any(|message| message.text == "看看外面"), "没发出的提示不留在时间线");
        assert!(cancel(&id).is_err(), "轮次已结束，没有可停止的轮次");
        assert!(respond_access(&id, &card, "once").is_err(), "撤回的卡不再接受回应");
    }
    close(&id).unwrap();
    let frames = worker.join().unwrap();
    assert!(
        frames.iter().all(|frame| frame["method"] != "session/prompt" && frame["method"] != "session/cancel"),
        "提示没有发出时不发送 prompt 或 cancel：{frames:?}"
    );
}

#[test]
fn images_need_the_capability_and_stay_within_count_type_and_size() {
    let directory = temp_dir();
    std::fs::write(directory.path().join("notes.md"), "# 标题\n").unwrap();
    let (io, mut agent) = pair();
    let worker = std::thread::spawn(move || {
        initialize(
            &mut agent,
            json!({ "protocolVersion": 1, "agentCapabilities": { "promptCapabilities": { "image": true } } }),
        );
        create(&mut agent, "session-1");
        let prompt = agent.next_line();
        reply(&agent, &prompt, json!({ "stopReason": "end_turn" }));
        let rest = drain(&mut agent);
        (prompt, rest)
    });
    let snapshot = open(spec(directory.path()), io).unwrap();
    let id = snapshot.id.clone();
    let nine: Vec<AcpAttachment> = (0..9).map(|_| image("image/png", png())).collect();
    assert!(prompt_with(&id, "", &nine).unwrap_err().contains('8'));
    assert!(prompt_with(&id, "", &[image("image/bmp", png())]).is_err());
    let huge = base64::engine::general_purpose::STANDARD.encode(vec![0u8; 6 * 1024 * 1024]);
    assert!(prompt_with(&id, "", &[image("image/png", huge)]).unwrap_err().contains("MiB"));
    assert!(prompt_with(&id, "", &[image("image/png", "不是 base64".into())]).is_err());
    assert!(prompt_with(&id, "  ", &[]).is_err());

    prompt_with(&id, "看图", &[image("image/png", png()), file("notes.md")]).unwrap();
    wait_until_idle(&id, Duration::from_secs(8)).unwrap();
    let user = messages(&snapshot_of(&id)).into_iter().find(|message| message.role == "user").unwrap();
    assert_eq!(user.attachments[0].kind, "image");
    assert_eq!(user.attachments[0].name, "image/png");
    assert!(!serde_json::to_string(&snapshot_of(&id)).unwrap().contains(&png()), "图片数据不进入快照");
    close(&id).unwrap();
    let (prompt, rest) = worker.join().unwrap();
    let blocks = prompt["params"]["prompt"].as_array().unwrap();
    assert_eq!(blocks[1], json!({ "type": "image", "mimeType": "image/png", "data": png() }));
    assert_eq!(blocks[2]["type"], "resource_link", "没有 embeddedContext 时文件只发送引用");
    assert!(rest.iter().all(|frame| frame["method"] != "session/prompt"), "被拒绝的图片不发出提示");
}

// ---------------------------------------------------------------- files

#[cfg(windows)]
fn link_directory(link: &Path, target: &Path) {
    let status = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .stdout(std::process::Stdio::null())
        .status()
        .unwrap();
    assert!(status.success(), "无法创建联接点");
}

#[cfg(unix)]
fn link_directory(link: &Path, target: &Path) {
    std::os::unix::fs::symlink(target, link).unwrap();
}

/// A session over `directory` whose agent stays connected.
fn idle_session(directory: &Path) -> (String, std::thread::JoinHandle<()>) {
    let (io, mut agent) = pair();
    let worker = std::thread::spawn(move || {
        agent.handshake(false);
        agent.stay_connected();
    });
    (open(spec(directory), io).unwrap().id, worker)
}

#[test]
fn the_file_list_stays_inside_skips_heavy_directories_and_is_cached() {
    let temp = temp_dir();
    let root = temp.path().join("plain");
    for path in ["a.txt", "src/main.rs", "src/lib/util.rs", "node_modules/pkg/x.js", "target/out.bin", "dist/b.js"] {
        let full = root.join(path);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(full, "x").unwrap();
    }
    let outside = temp.path().join("secret-dir");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("secret.txt"), "k").unwrap();
    link_directory(&root.join("linked"), &outside);
    // The canonical form (a verbatim path on Windows) is what a planned launch
    // may hand over; relative entries must still resolve under it.
    let (id, worker) = idle_session(&std::fs::canonicalize(&root).unwrap());

    let listed = list_files(&id, "", 100).unwrap();
    assert_eq!(listed.source, "walk", "不在 git 工作树中时做有界遍历");
    assert!(!listed.truncated);
    let mut files = listed.files.clone();
    files.sort();
    assert_eq!(files, ["a.txt", "src/lib/util.rs", "src/main.rs"], "跳过重目录、链接与联接点");
    assert!(listed.files.iter().all(|path| !path.contains(':') && !path.starts_with('/') && !path.contains("..")));
    assert_eq!(list_files(&id, "main", 10).unwrap().files, ["src/main.rs"]);
    assert_eq!(list_files(&id, "util", 10).unwrap().files.first().map(String::as_str), Some("src/lib/util.rs"));
    assert_eq!(list_files(&id, "", 1).unwrap().files.len(), 1, "按 limit 截取");
    // Cached: a file created now shows up only after the cache expires.
    std::fs::write(root.join("later.txt"), "x").unwrap();
    assert!(!list_files(&id, "later", 10).unwrap().files.contains(&"later.txt".to_string()));
    close(&id).unwrap();
    worker.join().unwrap();
}

#[test]
fn a_git_worktree_is_listed_with_its_ignore_rules() {
    let Some(git) = crate::git_status::find_git() else { return };
    let temp = temp_dir();
    let root = temp.path().join("repo");
    std::fs::create_dir_all(root.join("src")).unwrap();
    let status = std::process::Command::new(git)
        .arg("-C")
        .arg(&root)
        .args(["init", "-q"])
        .env("GIT_CONFIG_GLOBAL", if cfg!(windows) { "NUL" } else { "/dev/null" })
        .env("GIT_CONFIG_SYSTEM", if cfg!(windows) { "NUL" } else { "/dev/null" })
        .status()
        .unwrap();
    assert!(status.success());
    std::fs::write(root.join(".gitignore"), "ignored.txt\n").unwrap();
    std::fs::write(root.join("ignored.txt"), "x").unwrap();
    std::fs::write(root.join("src/app.ts"), "x").unwrap();
    std::fs::create_dir_all(root.join("node_modules")).unwrap();
    let (id, worker) = idle_session(&root);
    let listed = list_files(&id, "", 100).unwrap();
    assert_eq!(listed.source, "git");
    let mut files = listed.files.clone();
    files.sort();
    assert_eq!(files, [".gitignore", "src/app.ts"], "git 工作树按忽略规则列出");
    close(&id).unwrap();
    worker.join().unwrap();
}

// ---------------------------------------------------------------- history

#[test]
fn native_sessions_are_listed_page_by_page_and_deleted_only_when_declared() {
    // Not declared: both are refused with the reason, nothing is asked.
    let directory = temp_dir();
    let (id, worker) = idle_session(directory.path());
    assert!(native_sessions(&id, None).unwrap_err().contains("sessionCapabilities.list"));
    assert!(delete_native_session(&id, "old-1").unwrap_err().contains("sessionCapabilities.delete"));
    close(&id).unwrap();
    worker.join().unwrap();

    let directory = temp_dir();
    let (io, mut agent) = pair();
    let worker = std::thread::spawn(move || {
        initialize(
            &mut agent,
            json!({ "protocolVersion": 1, "agentCapabilities": { "sessionCapabilities": { "list": {}, "delete": {} } } }),
        );
        create(&mut agent, "session-1");
        let list = agent.next_line();
        assert_eq!(list["method"], "session/list");
        assert!(list["params"]["cwd"].is_string(), "按会话目录过滤");
        assert!(list["params"].get("cursor").is_none());
        reply(
            &agent,
            &list,
            json!({
                "sessions": [
                    { "sessionId": "session-1", "cwd": "/w", "title": "当前", "updatedAt": "2026-11-27T10:00:00Z" },
                    { "sessionId": "old-1", "cwd": "/w", "title": "修复登录" },
                    { "cwd": "/w", "title": "缺编号的条目被跳过" },
                ],
                "nextCursor": "page-2",
            }),
        );
        let list = agent.next_line();
        assert_eq!(list["params"]["cursor"], "page-2");
        reply(&agent, &list, json!({ "sessions": [{ "sessionId": "old-2", "cwd": "/w" }] }));
        let delete = agent.next_line();
        assert_eq!(delete["method"], "session/delete");
        assert_eq!(delete["params"], json!({ "sessionId": "old-1" }));
        reply(&agent, &delete, json!({}));
        let delete = agent.next_line();
        refuse(&agent, &delete, -32002, "session not found");
        let delete = agent.next_line();
        refuse(&agent, &delete, -32603, "disk is locked");
        drain(&mut agent)
    });
    let snapshot = open(spec(directory.path()), io).unwrap();
    let id = snapshot.id.clone();
    let first = native_sessions(&id, None).unwrap();
    assert_eq!(first.sessions.len(), 2);
    assert!(first.sessions[0].current, "当前会话被标出");
    assert_eq!(first.sessions[1].native_id, "old-1");
    assert_eq!(first.sessions[1].title.as_deref(), Some("修复登录"));
    assert_eq!(first.next_cursor.as_deref(), Some("page-2"));
    let second = native_sessions(&id, first.next_cursor.as_deref()).unwrap();
    assert_eq!(second.sessions[0].native_id, "old-2");
    assert!(second.next_cursor.is_none(), "没有 nextCursor 即为末页");

    assert!(delete_native_session(&id, "session-1").is_err(), "不能删除正在使用的会话");
    delete_native_session(&id, "old-1").unwrap();
    delete_native_session(&id, "gone").unwrap();
    assert!(delete_native_session(&id, "locked").unwrap_err().contains("disk is locked"));
    close(&id).unwrap();
    let rest = worker.join().unwrap();
    assert!(
        !rest.iter().any(|frame| frame["method"] == "session/delete"),
        "删除当前会话不发出请求"
    );
}

#[test]
fn a_resume_prefers_session_resume_and_a_failed_one_never_sends_the_first_prompt() {
    // session/resume is preferred over load, and the first prompt follows.
    let directory = temp_dir();
    let (io, mut agent) = pair();
    let worker = std::thread::spawn(move || {
        initialize(
            &mut agent,
            json!({ "protocolVersion": 1, "agentCapabilities": { "loadSession": true, "sessionCapabilities": { "resume": {} } } }),
        );
        let resume = agent.next_line();
        assert_eq!(resume["method"], "session/resume");
        assert_eq!(resume["params"]["sessionId"], "previous-1");
        assert_eq!(resume["params"]["mcpServers"], json!([]));
        reply(&agent, &resume, json!({ "modes": { "currentModeId": "ask", "availableModes": [{ "id": "ask", "name": "询问" }] } }));
        let prompt = agent.next_line();
        assert_eq!(prompt["params"]["sessionId"], "previous-1");
        reply(&agent, &prompt, json!({ "stopReason": "end_turn" }));
        agent.stay_connected();
    });
    let mut start = spec(directory.path());
    start.resume_native_id = Some("previous-1".into());
    start.initial_prompt = Some("继续".into());
    let snapshot = open(start, io).unwrap();
    assert_eq!(snapshot.resume, "resumed");
    assert_eq!(snapshot.native_session_id.as_deref(), Some("previous-1"));
    assert_eq!(snapshot.config.modes.as_ref().unwrap().current_mode_id, "ask");
    wait_until_idle(&snapshot.id, Duration::from_secs(8)).unwrap();
    close(&snapshot.id).unwrap();
    worker.join().unwrap();

    // The load fails: a new session, and the first prompt is not sent.
    let directory = temp_dir();
    let (io, mut agent) = pair();
    let worker = std::thread::spawn(move || {
        initialize(&mut agent, json!({ "protocolVersion": 1, "agentCapabilities": { "loadSession": true } }));
        let load = agent.next_line();
        assert_eq!(load["method"], "session/load");
        refuse(&agent, &load, -32002, "unknown session");
        create(&mut agent, "fresh-1");
        drain(&mut agent)
    });
    let mut start = spec(directory.path());
    start.resume_native_id = Some("previous-2".into());
    start.initial_prompt = Some("不要发到新会话".into());
    let snapshot = open(start, io).unwrap();
    assert_eq!(snapshot.resume, "failed");
    assert_eq!(snapshot.native_session_id.as_deref(), Some("fresh-1"));
    assert!(messages(&snapshot).is_empty());
    let codes = notices(&snapshot);
    assert!(codes.contains(&"resume_failed") && codes.contains(&"prompt_not_sent"), "{codes:?}");
    close(&snapshot.id).unwrap();
    let rest = worker.join().unwrap();
    assert!(rest.iter().all(|frame| frame["method"] != "session/prompt"), "恢复失败时不重发提示");
}

#[test]
fn a_load_replay_is_scoped_to_the_loaded_session_and_keeps_each_message() {
    let directory = temp_dir();
    let (io, mut agent) = pair();
    let worker = std::thread::spawn(move || {
        initialize(&mut agent, json!({ "protocolVersion": 1, "agentCapabilities": { "loadSession": true } }));
        let load = agent.next_line();
        assert_eq!(load["method"], "session/load");
        let replay = |session: &str, kind: &str, text: &str| {
            agent.send(json!({
                "jsonrpc": "2.0", "method": "session/update",
                "params": { "sessionId": session, "update": { "sessionUpdate": kind, "content": { "type": "text", "text": text } } },
            }));
        };
        // Two user messages in a row and a reply, none with a message id, and
        // one update of another session in between.
        replay("previous-1", "user_message_chunk", "问题一");
        replay("previous-1", "user_message_chunk", "问题二");
        replay("other-session", "agent_message_chunk", "外来内容");
        replay("previous-1", "agent_message_chunk", "回答");
        reply(&agent, &load, json!({}));
        // Live chunks without a message id still continue one message.
        let prompt = agent.next_line();
        agent.send(json!({
            "jsonrpc": "2.0", "method": "session/update",
            "params": { "sessionId": "previous-1", "update": { "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "甲" } } },
        }));
        agent.send(json!({
            "jsonrpc": "2.0", "method": "session/update",
            "params": { "sessionId": "previous-1", "update": { "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "乙" } } },
        }));
        reply(&agent, &prompt, json!({ "stopReason": "end_turn" }));
        agent.stay_connected();
    });
    let mut start = spec(directory.path());
    start.resume_native_id = Some("previous-1".into());
    let snapshot = open(start, io).unwrap();
    assert_eq!(snapshot.resume, "loaded");
    let replayed: Vec<(&str, String)> =
        messages(&snapshot).iter().map(|message| (message.role, message.text.clone())).collect();
    assert_eq!(
        replayed,
        [("user", "问题一".to_string()), ("user", "问题二".to_string()), ("agent", "回答".to_string())],
        "回放的每条消息各自成项，其他会话的更新不进入"
    );
    assert!(snapshot.diagnostics.iter().any(|line| line.contains("其他会话")));
    prompt(&snapshot.id, "接着说").unwrap();
    wait_until_idle(&snapshot.id, Duration::from_secs(8)).unwrap();
    let live: Vec<String> = messages(&snapshot_of(&snapshot.id))
        .iter()
        .filter(|message| message.role == "agent")
        .map(|message| message.text.clone())
        .collect();
    assert_eq!(live, ["回答", "甲乙"]);
    close(&snapshot.id).unwrap();
    worker.join().unwrap();
}

// ---------------------------------------------------------------- restore records

fn saved(id: &str, directory: &Path) -> crate::workbench_restore::SavedSession {
    crate::workbench_restore::SavedSession {
        id: id.into(),
        tool_id: "fixture-agent".into(),
        project_id: None,
        directory: directory.display().to_string(),
        mode: LaunchMode::Normal,
        interaction: crate::launch::InteractionMode::Acp,
        started_at: 1,
        stopped_at: None,
        native_id: Some("session-1".into()),
        account_id: None,
        context_id: None,
    }
}

#[test]
fn a_checkpoint_counts_open_conversations_and_closing_one_forgets_its_record() {
    use crate::workbench_restore as restore;
    let directory = temp_dir();
    let db = crate::database::Database::open(&directory.path().join("app.db")).unwrap();
    let (id, worker) = idle_session(directory.path());
    restore::save(&db, &saved(&id, directory.path())).unwrap();
    restore::save(&db, &saved("gone-conversation", directory.path())).unwrap();
    assert!(list_ids().contains(&id));

    restore::checkpoint(&db).unwrap();
    let records = restore::list(&db).unwrap();
    let live = records.iter().find(|record| record.id == id).unwrap();
    assert!(live.stopped_at.is_some(), "checkpoint 把打开的对话计入活跃");
    let gone = records.iter().find(|record| record.id == "gone-conversation").unwrap();
    assert!(gone.stopped_at.is_none());

    restore::close_conversation(&db, &id).unwrap();
    worker.join().unwrap();
    let remaining: Vec<String> = restore::list(&db).unwrap().into_iter().map(|record| record.id).collect();
    assert_eq!(remaining, ["gone-conversation"], "关闭的对话不再被恢复");
    // A conversation the host no longer holds still loses its record.
    assert!(restore::close_conversation(&db, "gone-conversation").is_err());
    assert!(restore::list(&db).unwrap().is_empty());
}

#[test]
fn a_conversation_that_logs_in_after_start_records_its_native_session_for_restore() {
    use crate::workbench_restore as restore;
    let directory = temp_dir();
    let db = crate::database::Database::open(&directory.path().join("app.db")).unwrap();
    let (io, mut agent) = pair();
    let worker = std::thread::spawn(move || {
        initialize(&mut agent, json!({ "protocolVersion": 1, "authMethods": [{ "id": "login", "name": "登录" }] }));
        let new = agent.next_line();
        refuse(&agent, &new, -32000, "Authentication required");
        let login = agent.next_line();
        assert_eq!(login["method"], "authenticate");
        reply(&agent, &login, json!({}));
        create(&mut agent, "session-after-login");
        agent.stay_connected();
    });
    let snapshot = open(spec(directory.path()), io).unwrap();
    assert_eq!(snapshot.state, "auth_required");
    // Saved the way a launch saves it: no native session yet.
    let mut record = saved(&snapshot.id, directory.path());
    record.native_id = snapshot.native_session_id.clone();
    assert!(record.native_id.is_none());
    restore::save(&db, &record).unwrap();

    restore::authenticate_conversation(&db, &snapshot.id, "login").unwrap();
    let records = restore::list(&db).unwrap();
    assert_eq!(records[0].native_id.as_deref(), Some("session-after-login"), "登录后恢复记录带上原生会话");

    // A checkpoint also brings a stale record up to date.
    let mut stale = records[0].clone();
    stale.native_id = None;
    restore::save(&db, &stale).unwrap();
    restore::checkpoint(&db).unwrap();
    let records = restore::list(&db).unwrap();
    assert_eq!(records[0].native_id.as_deref(), Some("session-after-login"));
    assert!(records[0].stopped_at.is_some());

    // A tab closed meanwhile is not written back.
    restore::close_conversation(&db, &snapshot.id).unwrap();
    restore::record_native_id(&db, &snapshot.id, "session-after-login").unwrap();
    assert!(restore::list(&db).unwrap().is_empty());
    worker.join().unwrap();
}

// ---------------------------------------------------------------- publication order

#[test]
fn a_snapshot_from_another_thread_never_drops_or_repeats_a_delta() {
    const CHUNKS: usize = 400;
    let directory = temp_dir();
    let (io, mut agent) = pair();
    let worker = std::thread::spawn(move || {
        agent.handshake(false);
        let prompt = agent.next_line();
        for _ in 0..CHUNKS {
            agent.chunk("session-1", "m", "x");
        }
        reply(&agent, &prompt, json!({ "stopReason": "end_turn" }));
        agent.stay_connected();
    });
    let snapshot = open(spec(directory.path()), io).unwrap();
    let id = snapshot.id.clone();
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    // Whole snapshots published from this side while the reader thread
    // streams deltas: the race a view sees when an IPC call republishes.
    let publisher = {
        let id = id.clone();
        let stop = std::sync::Arc::clone(&stop);
        std::thread::spawn(move || {
            while !stop.load(std::sync::atomic::Ordering::SeqCst) {
                revoke_grants(&id, &[]).unwrap();
            }
        })
    };
    prompt(&id, "go").unwrap();
    wait_until_idle(&id, Duration::from_secs(20)).unwrap();
    stop.store(true, std::sync::atomic::Ordering::SeqCst);
    publisher.join().unwrap();

    // Fold the events exactly as the view does.
    let events = events_of(&id);
    let mut last = 0;
    let mut folded: Option<(u64, String)> = None;
    let mut snapshots = 0;
    for event in &events {
        assert!(event.seq > last, "事件按 seq 递增的顺序发出：{} 之后是 {}", last, event.seq);
        last = event.seq;
        match &event.update {
            AcpUpdate::Snapshot { snapshot } => {
                assert_eq!(snapshot.seq, event.seq, "快照携带它自己的 seq");
                let text = messages(snapshot).iter().find(|message| message.id == "m").map(|message| message.text.clone());
                folded = Some((snapshot.seq, text.unwrap_or_default()));
                snapshots += 1;
            }
            AcpUpdate::Chunk { message_id, text, .. } if message_id == "m" => {
                if let Some((seq, held)) = folded.as_mut() {
                    if event.seq > *seq {
                        held.push_str(text);
                        *seq = event.seq;
                    }
                }
            }
            _ => {
                if let Some((seq, _)) = folded.as_mut() {
                    *seq = (*seq).max(event.seq);
                }
            }
        }
    }
    assert!(snapshots > 2, "发布线程确实与增量交错");
    let expected = "x".repeat(CHUNKS);
    assert_eq!(folded.unwrap().1, expected, "折叠结果既不丢也不重复");
    let host = messages(&snapshot_of(&id)).into_iter().find(|message| message.id == "m").unwrap();
    assert_eq!(host.text, expected);
    close(&id).unwrap();
    worker.join().unwrap();
}

#[test]
fn terminal_output_falls_back_to_the_console_code_page_first() {
    // The console output code page when there is a console.
    assert_eq!(terminal::pick_code_page(437, 850, 1252), Some(437));
    // No console (a desktop process): the OEM code page a new console starts with.
    assert_eq!(terminal::pick_code_page(0, 936, 1252), Some(936));
    // Neither: the ANSI code page.
    assert_eq!(terminal::pick_code_page(0, 0, 1252), Some(1252));
    // UTF-8 already: no fallback, invalid bytes stay replacement characters.
    assert_eq!(terminal::pick_code_page(65001, 936, 936), None);
    assert_eq!(terminal::pick_code_page(0, 65001, 936), None);
    assert_eq!(terminal::pick_code_page(0, 0, 0), None);
}
