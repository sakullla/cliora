//! The client capabilities an agent calls back into: file reads and writes,
//! terminals, out-of-directory approval, session grants and YOLO. The agent is
//! the same in-memory script as `acp.rs`; files and commands are real, in
//! temporary directories, so nothing here starts a CLI or calls a model.
use super::tests::{events_of, pair, snapshot_of, spec, temp_dir, tools, wait_for, Agent};
use super::terminal::TreeProbe;
use super::*;
use std::path::Path;
use std::sync::mpsc::channel;
use std::time::Duration;

/// Send one client request and read its answer.
fn call(agent: &mut Agent, id: u64, method: &str, params: Value) -> Value {
    agent.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
    let reply = agent.next_line();
    assert_eq!(reply["id"], id, "{reply}");
    reply
}

fn path_text(path: &Path) -> String {
    path.display().to_string()
}

fn accesses(snapshot: &AcpSessionSnapshot) -> Vec<AcpAccess> {
    snapshot
        .timeline
        .iter()
        .filter_map(|item| match item {
            AcpTimelineItem::Access(access) => Some(access.clone()),
            _ => None,
        })
        .collect()
}

/// The first open approval card: its request id.
fn open_card(id: &str) -> String {
    wait_for(
        || {
            let current = snapshot_of(id);
            accesses(&current)
                .into_iter()
                .find(|access| access.decision == "pending")
                .and_then(|access| access.request_id)
                .filter(|request| current.pending.contains(request))
        },
        "目录外访问的审批卡",
    )
}

fn no_card(id: &str) {
    wait_for(|| snapshot_of(id).pending.is_empty().then_some(()), "审批卡撤下");
}

fn finish_prompt(agent: &Agent, prompt: &Value) {
    agent.send(json!({ "jsonrpc": "2.0", "id": prompt["id"], "result": { "stopReason": "end_turn" } }));
}

#[test]
fn initialize_declares_the_file_and_terminal_capabilities() {
    let directory = temp_dir();
    let (io, mut agent) = pair();
    let (frames_tx, frames_rx) = channel();
    let worker = std::thread::spawn(move || {
        let initialize = agent.handshake(false);
        let _ = frames_tx.send(initialize);
        agent.stay_connected();
    });
    let snapshot = open(spec(directory.path()), io).unwrap();
    let initialize = frames_rx.recv_timeout(Duration::from_secs(8)).unwrap();
    let declared = &initialize["params"]["clientCapabilities"];
    assert_eq!(declared["fs"]["readTextFile"], true);
    assert_eq!(declared["fs"]["writeTextFile"], true);
    assert_eq!(declared["terminal"], true);
    close(&snapshot.id).unwrap();
    worker.join().unwrap();
}

#[test]
fn inside_the_directory_reads_are_served_and_writes_are_recorded_with_a_diff() {
    let directory = temp_dir();
    let file = directory.path().join("notes.txt");
    std::fs::write(&file, "one\ntwo\nthree\n").unwrap();
    let file_text = path_text(&file);
    let (io, mut agent) = pair();
    let worker = std::thread::spawn(move || {
        agent.handshake(false);
        let read = call(&mut agent, 10, "fs/read_text_file", json!({ "sessionId": "session-1", "path": file_text, "line": 2, "limit": 1 }));
        assert_eq!(read["result"]["content"], "two\n", "{read}");
        let write = call(&mut agent, 11, "fs/write_text_file", json!({ "sessionId": "session-1", "path": file_text, "content": "one\nTWO\nthree\n" }));
        assert_eq!(write["result"], json!({}), "{write}");
        // A missing parameter is an error, never a silent success.
        let broken = call(&mut agent, 12, "fs/write_text_file", json!({ "sessionId": "session-1", "path": file_text }));
        assert!(broken["error"]["message"].as_str().unwrap().contains("content"), "{broken}");
        // A relative path is refused.
        let relative = call(&mut agent, 13, "fs/read_text_file", json!({ "sessionId": "session-1", "path": "notes.txt" }));
        assert!(relative.get("error").is_some(), "{relative}");
        agent.stay_connected();
    });
    let snapshot = open(spec(directory.path()), io).unwrap();
    let written = wait_for(
        || {
            accesses(&snapshot_of(&snapshot.id))
                .into_iter()
                .find(|access| access.diff.is_some())
        },
        "写入记录",
    );
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "one\nTWO\nthree\n");
    assert_eq!(written.access_kind, "write");
    assert_eq!(written.decision, "inside");
    let diff = written.diff.unwrap();
    assert_eq!(diff.old_text.as_deref(), Some("one\ntwo\nthree\n"));
    assert_eq!(diff.new_text, "one\nTWO\nthree\n");
    assert!(!diff.truncated && !diff.previous_omitted);
    assert!(diff.path.ends_with("notes.txt"));
    // The read inside the directory stays quiet; only the write is recorded.
    assert_eq!(accesses(&snapshot_of(&snapshot.id)).len(), 1);
    assert!(snapshot_of(&snapshot.id).pending.is_empty());
    close(&snapshot.id).unwrap();
    worker.join().unwrap();
}

#[test]
fn outside_access_asks_once_per_card_and_session_grants_apply_per_category() {
    let workspace = temp_dir();
    let directory = workspace.path().join("project");
    std::fs::create_dir_all(&directory).unwrap();
    let outside = workspace.path().join("outside.txt");
    std::fs::write(&outside, "secret-free text").unwrap();
    let outside_text = path_text(&outside);
    let (io, mut agent) = pair();
    let (step_tx, step_rx) = channel::<&'static str>();
    let (go_tx, go_rx) = channel::<()>();
    let worker = std::thread::spawn(move || {
        agent.handshake(false);
        let prompt = agent.next_line();
        let read = json!({ "sessionId": "session-1", "path": outside_text });
        // 1. allow once: served, but only this once.
        let once = call(&mut agent, 20, "fs/read_text_file", read.clone());
        assert_eq!(once["result"]["content"], "secret-free text", "{once}");
        step_tx.send("once").unwrap();
        go_rx.recv().unwrap();
        // 2. the next read asks again; deny makes it an error.
        let denied = call(&mut agent, 21, "fs/read_text_file", read.clone());
        assert!(denied["error"]["message"].as_str().unwrap().contains("拒绝"), "{denied}");
        step_tx.send("denied").unwrap();
        go_rx.recv().unwrap();
        // 3. allow for the session: this and later reads are served.
        assert!(call(&mut agent, 22, "fs/read_text_file", read.clone()).get("result").is_some());
        step_tx.send("granted").unwrap();
        go_rx.recv().unwrap();
        let auto = call(&mut agent, 23, "fs/read_text_file", read.clone());
        assert!(auto.get("result").is_some(), "{auto}");
        // 4. a write is its own category and still asks.
        let write = call(&mut agent, 24, "fs/write_text_file", json!({ "sessionId": "session-1", "path": outside_text, "content": "x" }));
        assert!(write.get("error").is_some(), "{write}");
        step_tx.send("write-denied").unwrap();
        go_rx.recv().unwrap();
        // 5. after the grant is revoked, a read asks again; the turn then ends,
        //    which withdraws the card and refuses the request.
        agent.send(json!({ "jsonrpc": "2.0", "id": 25, "method": "fs/read_text_file", "params": read }));
        step_tx.send("asked-again").unwrap();
        go_rx.recv().unwrap();
        finish_prompt(&agent, &prompt);
        let withdrawn = agent.next_line();
        assert_eq!(withdrawn["id"], 25);
        assert!(withdrawn["error"]["message"].as_str().unwrap().contains("撤回"), "{withdrawn}");
        step_tx.send("withdrawn").unwrap();
        agent.stay_connected();
    });
    let snapshot = open(spec(&directory), io).unwrap();
    let id = snapshot.id.clone();
    prompt(&id, "读一下目录外的文件").unwrap();
    let step = |expected: &str| assert_eq!(step_rx.recv_timeout(Duration::from_secs(10)).unwrap(), expected);

    let card = open_card(&id);
    let current = snapshot_of(&id);
    assert_eq!(current.state, "waiting_permission");
    let pending = accesses(&current).into_iter().find(|access| access.decision == "pending").unwrap();
    assert_eq!(pending.access_kind, "read");
    assert!(pending.path.ends_with("outside.txt"), "{}", pending.path);
    respond_access(&id, &card, "once").unwrap();
    step("once");
    // A repeated answer for the consumed card is refused.
    assert!(respond_access(&id, &card, "once").is_err());
    assert!(snapshot_of(&id).grants.is_empty(), "允许一次不产生本会话授权");
    go_tx.send(()).unwrap();

    let card = open_card(&id);
    respond_access(&id, &card, "deny").unwrap();
    step("denied");
    go_tx.send(()).unwrap();

    let card = open_card(&id);
    assert!(respond_access(&id, &card, "sometimes").is_err(), "未知答复不消耗审批卡");
    respond_access(&id, &card, "session").unwrap();
    step("granted");
    assert_eq!(snapshot_of(&id).grants, vec!["read"]);
    go_tx.send(()).unwrap();

    // The granted read needs no card; the write asks for its own category.
    let card = open_card(&id);
    let current = snapshot_of(&id);
    let decisions: Vec<&str> = accesses(&current).iter().map(|access| access.decision).collect();
    assert_eq!(decisions, ["allowed_once", "denied", "allowed_session", "granted", "pending"]);
    assert_eq!(accesses(&current).last().unwrap().access_kind, "write");
    respond_access(&id, &card, "deny").unwrap();
    step("write-denied");
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "secret-free text", "被拒绝的写入不能落盘");

    revoke_grants(&id, &["read".to_string()]).unwrap();
    assert!(snapshot_of(&id).grants.is_empty());
    assert!(revoke_grants(&id, &["everything".to_string()]).is_err());
    go_tx.send(()).unwrap();
    step("asked-again");
    let late = open_card(&id);
    go_tx.send(()).unwrap();
    step("withdrawn");
    no_card(&id);
    // The answer arrives after the turn ended: it is refused.
    assert!(respond_access(&id, &late, "once").is_err());
    let last = accesses(&snapshot_of(&id)).pop().unwrap();
    assert_eq!(last.decision, "withdrawn");
    assert!(last.request_id.is_none());
    close(&id).unwrap();
    worker.join().unwrap();
}

#[test]
fn stopping_withdraws_an_open_approval_card_and_refuses_the_request() {
    let workspace = temp_dir();
    let directory = workspace.path().join("project");
    std::fs::create_dir_all(&directory).unwrap();
    let outside = workspace.path().join("other.txt");
    std::fs::write(&outside, "x").unwrap();
    let outside_text = path_text(&outside);
    let (io, mut agent) = pair();
    let (done_tx, done_rx) = channel();
    let worker = std::thread::spawn(move || {
        agent.handshake(false);
        let prompt = agent.next_line();
        agent.send(json!({ "jsonrpc": "2.0", "id": 30, "method": "fs/read_text_file", "params": { "sessionId": "session-1", "path": outside_text } }));
        // The refusal and the cancel notification may arrive in either order.
        let mut frames = [agent.next_line(), agent.next_line()];
        frames.sort_by_key(|frame| frame.get("method").is_some());
        assert_eq!(frames[0]["id"], 30);
        assert!(frames[0].get("error").is_some(), "{}", frames[0]);
        assert_eq!(frames[1]["method"], "session/cancel");
        agent.send(json!({ "jsonrpc": "2.0", "id": prompt["id"], "result": { "stopReason": "cancelled" } }));
        let _ = done_tx.send(());
        agent.stay_connected();
    });
    let snapshot = open(spec(&directory), io).unwrap();
    prompt(&snapshot.id, "读文件").unwrap();
    let card = open_card(&snapshot.id);
    cancel(&snapshot.id).unwrap();
    done_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    no_card(&snapshot.id);
    assert!(respond_access(&snapshot.id, &card, "once").is_err(), "停止后迟到的回应必须拒收");
    close(&snapshot.id).unwrap();
    worker.join().unwrap();
}

#[test]
fn closing_the_session_withdraws_an_open_card() {
    let workspace = temp_dir();
    let directory = workspace.path().join("project");
    std::fs::create_dir_all(&directory).unwrap();
    let outside_text = path_text(&workspace.path().join("x.txt"));
    let (io, mut agent) = pair();
    let worker = std::thread::spawn(move || {
        agent.handshake(false);
        let _prompt = agent.next_line();
        agent.send(json!({ "jsonrpc": "2.0", "id": 31, "method": "fs/write_text_file", "params": { "sessionId": "session-1", "path": outside_text, "content": "x" } }));
        agent.stay_connected();
    });
    let snapshot = open(spec(&directory), io).unwrap();
    prompt(&snapshot.id, "写文件").unwrap();
    let card = open_card(&snapshot.id);
    let session = lookup(&snapshot.id).unwrap();
    close(&snapshot.id).unwrap();
    // The worker records the withdrawal once its wait ends.
    wait_for(
        || {
            let current = session.snapshot();
            accesses(&current).iter().any(|access| access.decision == "withdrawn").then_some(())
        },
        "关闭后撤回审批卡",
    );
    assert!(session.snapshot().pending.is_empty());
    assert!(session.respond_access(&card, AccessAnswer::Once).is_err());
    assert!(!workspace.path().join("x.txt").exists());
    worker.join().unwrap();
}

#[test]
fn yolo_approves_outside_access_and_allow_once_and_still_shows_cards_without_one() {
    let workspace = temp_dir();
    let directory = workspace.path().join("project");
    std::fs::create_dir_all(&directory).unwrap();
    let outside = workspace.path().join("outside.txt");
    std::fs::write(&outside, "yolo").unwrap();
    let outside_text = path_text(&outside);
    let data = workspace.path().join("cliora-app-data");
    std::fs::create_dir_all(&data).unwrap();
    std::fs::write(data.join("cliora.db"), "db").unwrap();
    crate::safe_fs::protect(&data);
    let data_text = path_text(&data.join("cliora.db"));
    let (io, mut agent) = pair();
    let (answer_tx, answer_rx) = channel();
    let worker = std::thread::spawn(move || {
        agent.handshake(false);
        let prompt = agent.next_line();
        let read = call(&mut agent, 40, "fs/read_text_file", json!({ "sessionId": "session-1", "path": outside_text }));
        assert_eq!(read["result"]["content"], "yolo", "{read}");
        // Cliora's own data stays refused under YOLO.
        let refused = call(&mut agent, 41, "fs/read_text_file", json!({ "sessionId": "session-1", "path": data_text }));
        assert!(refused["error"]["message"].as_str().unwrap().contains("Cliora"), "{refused}");
        let permission = |id: u64, call: &str, options: Value| {
            json!({
                "jsonrpc": "2.0", "id": id, "method": "session/request_permission",
                "params": { "sessionId": "session-1", "toolCall": { "toolCallId": call, "title": format!("工具 {call}") }, "options": options },
            })
        };
        agent.send(permission(42, "c1", json!([
            { "optionId": "always", "name": "总是允许", "kind": "allow_always" },
            { "optionId": "once", "name": "允许一次", "kind": "allow_once" },
            { "optionId": "no", "name": "拒绝", "kind": "reject_once" },
        ])));
        let first = agent.next_line();
        // Only allow-always: YOLO never picks it, the user decides.
        agent.send(permission(43, "c2", json!([
            { "optionId": "always", "name": "总是允许", "kind": "allow_always" },
            { "optionId": "no", "name": "拒绝", "kind": "reject_once" },
        ])));
        let second = agent.next_line();
        // No allow option: the user still decides.
        agent.send(permission(44, "c3", json!([
            { "optionId": "no", "name": "拒绝", "kind": "reject_once" },
            { "optionId": "odd", "name": "未标注" },
        ])));
        let third = agent.next_line();
        let _ = answer_tx.send((first, second, third));
        finish_prompt(&agent, &prompt);
        agent.stay_connected();
    });
    let mut start = spec(&directory);
    start.mode = LaunchMode::Yolo;
    let snapshot = open(start, io).unwrap();
    assert_eq!(snapshot.mode, LaunchMode::Yolo);
    prompt(&snapshot.id, "全部放行").unwrap();
    // The second request offers only allow-always: it waits for the user.
    let card = wait_for(|| snapshot_of(&snapshot.id).pending.into_iter().next(), "只有 allow_always 时的授权卡");
    assert_eq!(card, "43");
    respond_permission(&snapshot.id, "43", Some("no")).unwrap();
    // The third request has no allow option and waits for the user too.
    let card = wait_for(
        || snapshot_of(&snapshot.id).pending.into_iter().find(|pending| pending == "44"),
        "没有允许选项时的授权卡",
    );
    assert_eq!(card, "44");
    respond_permission(&snapshot.id, "44", Some("no")).unwrap();
    let (first, second, third) = answer_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    assert_eq!(first["result"]["outcome"], json!({ "outcome": "selected", "optionId": "once" }), "选择 allow_once");
    assert_eq!(second["result"]["outcome"], json!({ "outcome": "selected", "optionId": "no" }), "YOLO 不回退到 allow_always");
    assert_eq!(third["result"]["outcome"], json!({ "outcome": "selected", "optionId": "no" }));
    wait_until_idle(&snapshot.id, Duration::from_secs(8)).unwrap();
    let current = snapshot_of(&snapshot.id);
    let records = accesses(&current);
    assert_eq!(records.len(), 1, "受保护目录的拒绝不进入授权记录");
    assert_eq!(records[0].decision, "yolo");
    assert_eq!(records[0].access_kind, "read");
    let notices: Vec<String> = current
        .timeline
        .iter()
        .filter_map(|item| match item {
            AcpTimelineItem::Notice(notice) if notice.code == "yolo_allowed" => Some(notice.text.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(notices.len(), 1, "只有 allow_once 被自动允许：{notices:?}");
    assert!(notices[0].contains("工具 c1"), "{}", notices[0]);
    // The auto-approved calls appear as tools, without a card.
    let calls = tools(&current);
    assert_eq!(calls.iter().map(|call| call.call_id.as_str()).collect::<Vec<_>>(), ["c1", "c2", "c3"]);
    assert!(calls.iter().all(|call| call.permission.is_none()));
    assert!(current.grants.is_empty(), "YOLO 不是本会话授权");
    close(&snapshot.id).unwrap();
    worker.join().unwrap();
}

/// A device, a pipe or a directory outside the session directory is refused
/// at once: no card is opened and YOLO records no allow for it.
fn wrong_kind_targets_outside_are_refused_without_a_card(mode: LaunchMode) {
    let workspace = temp_dir();
    let directory = workspace.path().join("project");
    std::fs::create_dir_all(&directory).unwrap();
    let outside_dir = workspace.path().join("outside-dir");
    std::fs::create_dir_all(&outside_dir).unwrap();
    let outside_file = workspace.path().join("outside.txt");
    std::fs::write(&outside_file, "x").unwrap();
    let mut reads = vec![path_text(&outside_dir)];
    let mut writes = vec![path_text(&outside_dir), path_text(&outside_file.join("below-a-file.txt"))];
    if cfg!(unix) {
        reads.push("/dev/zero".into());
        writes.push("/dev/null".into());
        #[cfg(unix)]
        {
            let fifo = workspace.path().join("outside.fifo");
            assert!(std::process::Command::new("mkfifo").arg(&fifo).status().unwrap().success());
            reads.push(path_text(&fifo));
            writes.push(path_text(&fifo));
        }
    }
    let cwd = path_text(&outside_file);
    let (command, args) = short_command();
    let (io, mut agent) = pair();
    let (done_tx, done_rx) = channel();
    let worker = std::thread::spawn(move || {
        agent.handshake(false);
        let prompt = agent.next_line();
        let mut id = 300;
        for path in &reads {
            id += 1;
            let reply = call(&mut agent, id, "fs/read_text_file", json!({ "sessionId": "session-1", "path": path }));
            assert!(reply["error"]["message"].as_str().is_some(), "{path}: {reply}");
        }
        for path in &writes {
            id += 1;
            let reply = call(&mut agent, id, "fs/write_text_file", json!({ "sessionId": "session-1", "path": path, "content": "x" }));
            assert!(reply["error"]["message"].as_str().is_some(), "{path}: {reply}");
        }
        let terminal = call(&mut agent, 399, "terminal/create", json!({ "sessionId": "session-1", "command": command, "args": args, "cwd": cwd }));
        assert!(terminal["error"]["message"].as_str().unwrap().contains("目录"), "{terminal}");
        let _ = done_tx.send(());
        finish_prompt(&agent, &prompt);
        agent.stay_connected();
    });
    let mut start = spec(&directory);
    start.mode = mode;
    let snapshot = open(start, io).unwrap();
    prompt(&snapshot.id, "访问目录外的特殊目标").unwrap();
    // Every request is answered without anyone answering a card.
    done_rx.recv_timeout(Duration::from_secs(20)).unwrap();
    wait_until_idle(&snapshot.id, Duration::from_secs(8)).unwrap();
    let current = snapshot_of(&snapshot.id);
    assert!(accesses(&current).is_empty(), "不应出现审批卡或放行记录：{:?}", accesses(&current));
    assert!(current.pending.is_empty());
    assert!(current.terminals.is_empty());
    assert!(std::fs::read_dir(&outside_dir).unwrap().next().is_none(), "目录不会被当作文件写入");
    assert_eq!(std::fs::read_to_string(&outside_file).unwrap(), "x");
    close(&snapshot.id).unwrap();
    worker.join().unwrap();
}

#[test]
fn devices_pipes_and_directories_outside_are_refused_before_any_card() {
    wrong_kind_targets_outside_are_refused_without_a_card(LaunchMode::Normal);
}

#[test]
fn yolo_records_no_allow_for_a_target_that_is_refused_anyway() {
    wrong_kind_targets_outside_are_refused_without_a_card(LaunchMode::Yolo);
}

fn short_command() -> (&'static str, Vec<String>) {
    if cfg!(windows) {
        ("cmd", vec!["/C".into(), "echo hello".into()])
    } else {
        ("sh", vec!["-c".into(), "echo hello; echo oops 1>&2".into()])
    }
}

fn long_command() -> (&'static str, Vec<String>) {
    // A tree: the interpreter and a child it waits for.
    if cfg!(windows) {
        ("cmd", ["/C", "ping", "-n", "30", "127.0.0.1"].iter().map(|part| part.to_string()).collect())
    } else {
        ("sh", vec!["-c".into(), "sleep 30 & sleep 30; wait".into()])
    }
}

/// Rebuild a terminal's output from its events the way a view does.
fn replay_output(id: &str, terminal: &str) -> String {
    let mut held: Vec<u16> = Vec::new();
    for event in events_of(id) {
        if let AcpUpdate::TerminalOutput { terminal_id, text, dropped, .. } = &event.update {
            if terminal_id == terminal {
                held.extend(text.encode_utf16());
                held.drain(..(*dropped).min(held.len()));
            }
        }
    }
    String::from_utf16(&held).unwrap()
}

#[test]
fn a_terminal_runs_reports_its_output_waits_and_releases() {
    let directory = temp_dir();
    let (command, args) = short_command();
    let (io, mut agent) = pair();
    let (terminal_tx, terminal_rx) = channel();
    let worker = std::thread::spawn(move || {
        agent.handshake(false);
        let created = call(&mut agent, 50, "terminal/create", json!({ "sessionId": "session-1", "command": command, "args": args, "env": [{ "name": "CLIORA_TEST_TERMINAL", "value": "1" }] }));
        let terminal = created["result"]["terminalId"].as_str().expect("终端编号").to_owned();
        let exit = call(&mut agent, 51, "terminal/wait_for_exit", json!({ "sessionId": "session-1", "terminalId": terminal }));
        assert_eq!(exit["result"]["exitCode"], 0, "{exit}");
        let output = call(&mut agent, 52, "terminal/output", json!({ "sessionId": "session-1", "terminalId": terminal }));
        assert!(output["result"]["output"].as_str().unwrap().contains("hello"), "{output}");
        assert_eq!(output["result"]["truncated"], false);
        assert_eq!(output["result"]["exitStatus"]["exitCode"], 0);
        let released = call(&mut agent, 53, "terminal/release", json!({ "sessionId": "session-1", "terminalId": terminal }));
        assert_eq!(released["result"], json!({}), "{released}");
        // A released id no longer answers.
        let gone = call(&mut agent, 54, "terminal/output", json!({ "sessionId": "session-1", "terminalId": terminal }));
        assert!(gone.get("error").is_some(), "{gone}");
        let unknown = call(&mut agent, 55, "terminal/output", json!({ "sessionId": "session-1", "terminalId": "nope" }));
        assert!(unknown.get("error").is_some());
        // A program that does not exist is refused, never handed to a shell.
        let missing = call(&mut agent, 56, "terminal/create", json!({ "sessionId": "session-1", "command": "cliora-no-such-program-xyz" }));
        assert!(missing["error"]["message"].as_str().unwrap().contains("找不到"), "{missing}");
        let _ = terminal_tx.send(terminal);
        agent.stay_connected();
    });
    let snapshot = open(spec(directory.path()), io).unwrap();
    let terminal = terminal_rx.recv_timeout(Duration::from_secs(20)).unwrap();
    let current = snapshot_of(&snapshot.id);
    let state = current.terminals.iter().find(|item| item.terminal_id == terminal).expect("快照保留终端");
    assert!(state.released);
    assert!(state.output.contains("hello"));
    assert_eq!(state.exit_status.as_ref().and_then(|exit| exit.exit_code), Some(0));
    // The events rebuild exactly the retained output, in order.
    assert_eq!(replay_output(&snapshot.id, &terminal), state.output);
    let kinds: Vec<&str> = events_of(&snapshot.id)
        .iter()
        .filter_map(|event| match &event.update {
            AcpUpdate::Terminal { terminal: created } if created.terminal_id == terminal => Some("terminal"),
            AcpUpdate::TerminalOutput { terminal_id, .. } if *terminal_id == terminal => Some("output"),
            _ => None,
        })
        .collect();
    assert_eq!(kinds.first(), Some(&"terminal"), "创建事件先于输出");
    let seqs: Vec<u64> = events_of(&snapshot.id).iter().map(|event| event.seq).collect();
    assert!(seqs.windows(2).all(|pair| pair[0] < pair[1]), "事件按序发出");
    close(&snapshot.id).unwrap();
    worker.join().unwrap();
}

#[test]
fn terminal_output_past_its_limit_drops_the_oldest_text_on_a_character_boundary() {
    let directory = temp_dir();
    let (io, mut agent) = pair();
    let (terminal_tx, terminal_rx) = channel();
    let (command, args): (&str, Vec<String>) = if cfg!(windows) {
        ("cmd", vec!["/C".into(), "echo 0123456789abcdefghij中文0123456789".into()])
    } else {
        ("sh", vec!["-c".into(), "printf '0123456789abcdefghij中文0123456789\\n'".into()])
    };
    let worker = std::thread::spawn(move || {
        agent.handshake(false);
        let created = call(&mut agent, 60, "terminal/create", json!({ "sessionId": "session-1", "command": command, "args": args, "outputByteLimit": 13 }));
        let terminal = created["result"]["terminalId"].as_str().unwrap().to_owned();
        call(&mut agent, 61, "terminal/wait_for_exit", json!({ "sessionId": "session-1", "terminalId": terminal }));
        let output = call(&mut agent, 62, "terminal/output", json!({ "sessionId": "session-1", "terminalId": terminal }));
        let _ = terminal_tx.send((terminal, output));
        agent.stay_connected();
    });
    let snapshot = open(spec(directory.path()), io).unwrap();
    let (terminal, output) = terminal_rx.recv_timeout(Duration::from_secs(20)).unwrap();
    let text = output["result"]["output"].as_str().unwrap();
    assert!(text.len() <= 13, "{text:?}");
    assert!(text.starts_with("0123456789") || text.contains("789"), "{text:?}");
    assert_eq!(output["result"]["truncated"], true);
    assert_eq!(replay_output(&snapshot.id, &terminal), text, "事件按 dropped 重建出同样的尾部");
    // Cutting inside a multi-byte character moves to the next boundary.
    let mut held = String::from("ab中");
    let dropped = super::terminal::bounded_for_tests(&mut held, "文", 4);
    assert_eq!(held, "文");
    assert_eq!(dropped, 3);
    close(&snapshot.id).unwrap();
    worker.join().unwrap();
}

#[test]
fn terminal_output_is_utf8_and_falls_back_to_the_system_code_page_on_windows() {
    use super::terminal::decode_for_tests as decode;
    // UTF-8, with a character split across reads, stays UTF-8.
    let utf8 = "中文 ok\n".as_bytes();
    assert_eq!(decode(Some(936), &[&utf8[..2], &utf8[2..]]), "中文 ok\n");
    // Without a fallback an invalid byte becomes a replacement character.
    assert_eq!(decode(None, &[b"a\xffb"]), "a\u{FFFD}b");
    #[cfg(windows)]
    {
        // "中文" in CP936 is D6 D0 CE C4. The first lead byte arrives alone and
        // first looks like the start of a UTF-8 sequence.
        let gbk: &[&[u8]] = &[b"dir ", &[0xD6], &[0xD0, 0xCE], &[0xC4, b'\r', b'\n']];
        assert_eq!(decode(Some(936), gbk), "dir 中文\r\n");
        // A lead byte left at the very end is still decoded, never dropped.
        let tail = decode(Some(936), &[&[0xD6, 0xD0, 0xCE]]);
        assert!(tail.starts_with('中') && tail.chars().count() == 2, "{tail:?}");
        // A single-byte code page decodes byte by byte.
        assert_eq!(decode(Some(1252), &[b"caf\xe9"]), "café");
    }
}

#[test]
fn killing_a_terminal_ends_its_whole_tree_and_closing_the_session_leaves_nothing_running() {
    let directory = temp_dir();
    let (command, args) = long_command();
    let (io, mut agent) = pair();
    let (ids_tx, ids_rx) = channel();
    let (go_tx, go_rx) = channel::<()>();
    let worker = std::thread::spawn(move || {
        agent.handshake(false);
        let first = call(&mut agent, 70, "terminal/create", json!({ "sessionId": "session-1", "command": command, "args": args }));
        let second = call(&mut agent, 71, "terminal/create", json!({ "sessionId": "session-1", "command": command, "args": args }));
        let first = first["result"]["terminalId"].as_str().unwrap().to_owned();
        let second = second["result"]["terminalId"].as_str().unwrap().to_owned();
        let _ = ids_tx.send((first.clone(), second));
        go_rx.recv().unwrap();
        // The agent's own kill: the terminal stays readable and reports the exit.
        let killed = call(&mut agent, 72, "terminal/kill", json!({ "sessionId": "session-1", "terminalId": first }));
        assert_eq!(killed["result"], json!({}));
        let exit = call(&mut agent, 73, "terminal/wait_for_exit", json!({ "sessionId": "session-1", "terminalId": first }));
        assert!(exit.get("result").is_some(), "{exit}");
        let _ = ids_tx.send((String::new(), String::new()));
        agent.stay_connected();
    });
    let snapshot = open(spec(directory.path()), io).unwrap();
    let (first, second) = ids_rx.recv_timeout(Duration::from_secs(20)).unwrap();
    let session = lookup(&snapshot.id).unwrap();
    let first_tree = TreeProbe::of(&session, &first).expect("第一个终端的进程树");
    let second_tree = TreeProbe::of(&session, &second).expect("第二个终端的进程树");
    wait_for(|| (first_tree.alive() && second_tree.alive()).then_some(()), "进程树启动");
    go_tx.send(()).unwrap();
    ids_rx.recv_timeout(Duration::from_secs(20)).unwrap();
    wait_for(|| (!first_tree.alive()).then_some(()), "terminal/kill 结束整棵进程树");
    assert!(second_tree.alive(), "只结束被指定的终端");
    // The user's stop goes through the same path.
    assert!(kill_terminal(&snapshot.id, "nope").is_err());
    close(&snapshot.id).unwrap();
    wait_for(|| (!second_tree.alive()).then_some(()), "会话关闭后不残留子进程");
    let current = session.snapshot();
    assert!(current.terminals.iter().all(|terminal| terminal.released));
    worker.join().unwrap();
}

#[test]
fn a_session_holds_a_bounded_number_of_live_terminals() {
    let directory = temp_dir();
    let (io, mut agent) = pair();
    let (done_tx, done_rx) = channel();
    let (command, args) = short_command();
    let worker = std::thread::spawn(move || {
        agent.handshake(false);
        let mut ids = Vec::new();
        for index in 0..super::terminal::MAX_TERMINALS as u64 {
            let created = call(&mut agent, 100 + index, "terminal/create", json!({ "sessionId": "session-1", "command": command, "args": args }));
            ids.push(created["result"]["terminalId"].as_str().expect("上限内的终端").to_owned());
        }
        let refused = call(&mut agent, 200, "terminal/create", json!({ "sessionId": "session-1", "command": command, "args": args }));
        assert!(refused["error"]["message"].as_str().unwrap().contains("最多"), "{refused}");
        // Releasing one frees a slot.
        call(&mut agent, 201, "terminal/release", json!({ "sessionId": "session-1", "terminalId": ids[0] }));
        let again = call(&mut agent, 202, "terminal/create", json!({ "sessionId": "session-1", "command": command, "args": args }));
        assert!(again.get("result").is_some(), "{again}");
        let _ = done_tx.send(());
        agent.stay_connected();
    });
    let snapshot = open(spec(directory.path()), io).unwrap();
    done_rx.recv_timeout(Duration::from_secs(60)).unwrap();
    close(&snapshot.id).unwrap();
    worker.join().unwrap();
}

#[test]
fn a_terminal_outside_the_directory_needs_an_execute_approval() {
    let workspace = temp_dir();
    let directory = workspace.path().join("project");
    std::fs::create_dir_all(&directory).unwrap();
    let outside_text = path_text(workspace.path());
    let (command, args) = short_command();
    let (io, mut agent) = pair();
    let (done_tx, done_rx) = channel();
    let worker = std::thread::spawn(move || {
        agent.handshake(false);
        let prompt = agent.next_line();
        let refused = call(&mut agent, 80, "terminal/create", json!({ "sessionId": "session-1", "command": command, "args": args, "cwd": outside_text }));
        assert!(refused.get("error").is_some(), "{refused}");
        let _ = done_tx.send(());
        finish_prompt(&agent, &prompt);
        agent.stay_connected();
    });
    let snapshot = open(spec(&directory), io).unwrap();
    prompt(&snapshot.id, "在上级目录运行").unwrap();
    let card = open_card(&snapshot.id);
    let pending = accesses(&snapshot_of(&snapshot.id)).into_iter().find(|access| access.decision == "pending").unwrap();
    assert_eq!(pending.access_kind, "execute");
    assert!(pending.detail.as_deref().unwrap_or_default().contains("hello"), "{:?}", pending.detail);
    respond_access(&snapshot.id, &card, "deny").unwrap();
    done_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    assert!(snapshot_of(&snapshot.id).terminals.is_empty(), "被拒绝的命令不会启动");
    close(&snapshot.id).unwrap();
    worker.join().unwrap();
}
