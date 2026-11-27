//! The ordered timeline, the handshake record and the session settings,
//! exercised with the same in-memory scripted agent as `acp.rs`. Nothing here
//! starts a CLI, calls a model or costs an inference.
use super::tests::{events_of, messages, pair, snapshot_of, spec, temp_dir, tools, wait_for, Agent};
use super::timeline::{Timeline, MAX_DIFF_CHARS, TRIMMED_NOTICE_ID};
use super::*;
use std::time::Duration;

fn update(agent: &Agent, session: &str, update: Value) {
    agent.send(json!({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": { "sessionId": session, "update": update },
    }));
}

fn reply(agent: &Agent, request: &Value, result: Value) {
    agent.send(json!({ "jsonrpc": "2.0", "id": request["id"], "result": result }));
}

/// Answer initialize and session/new with the given results; returns the two
/// frames the host sent.
fn handshake_with(agent: &mut Agent, initialize: Value, new: Value) -> (Value, Value) {
    let init = agent.next_line();
    assert_eq!(init["method"], "initialize");
    reply(agent, &init, initialize);
    let created = agent.next_line();
    assert_eq!(created["method"], "session/new");
    reply(agent, &created, new);
    (init, created)
}

fn kinds(snapshot: &AcpSessionSnapshot) -> Vec<String> {
    snapshot
        .timeline
        .iter()
        .map(|item| match item {
            AcpTimelineItem::Message(message) => format!("message:{}", message.role),
            AcpTimelineItem::Tool(call) => format!("tool:{}", call.call_id),
            AcpTimelineItem::Notice(notice) => format!("notice:{}", notice.code),
            AcpTimelineItem::Turn(turn) => format!("turn:{}", turn.reason),
            AcpTimelineItem::Subagent(child) => format!("subagent:{}", child.session_id),
            AcpTimelineItem::Access(access) => format!("access:{}", access.access_kind),
        })
        .collect()
}

fn event_kind(event: &AcpEvent) -> &'static str {
    match &event.update {
        AcpUpdate::Snapshot { .. } => "snapshot",
        AcpUpdate::Chunk { .. } => "chunk",
        AcpUpdate::Tool { .. } => "tool",
        AcpUpdate::Item { .. } => "item",
        AcpUpdate::Plan { .. } => "plan",
        AcpUpdate::Commands { .. } => "commands",
        AcpUpdate::Config { .. } => "config",
        AcpUpdate::Info { .. } => "info",
        AcpUpdate::Pending { .. } => "pending",
        AcpUpdate::Terminal { .. } => "terminal",
        AcpUpdate::TerminalOutput { .. } => "terminalOutput",
    }
}

fn plain_chunk(agent: &Agent, text: &str) {
    update(
        agent,
        "session-1",
        json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": text } }),
    );
}

#[test]
fn replies_and_tools_keep_their_arrival_order_and_merge_in_place() {
    let directory = temp_dir();
    let (io, mut agent) = pair();
    let worker = std::thread::spawn(move || {
        agent.handshake(false);
        let prompt = agent.next_line();
        // No message ids: a reply that resumes after a tool is a new message.
        plain_chunk(&agent, "先读");
        plain_chunk(&agent, "一下文件。");
        update(&agent, "session-1", json!({ "sessionUpdate": "tool_call", "toolCallId": "A", "title": "读取 a.ts", "kind": "read", "status": "in_progress" }));
        plain_chunk(&agent, "读完了，接着改。");
        update(&agent, "session-1", json!({ "sessionUpdate": "tool_call_update", "toolCallId": "A", "status": "completed" }));
        update(&agent, "session-1", json!({ "sessionUpdate": "tool_call", "toolCallId": "B", "title": "编辑 a.ts", "kind": "edit" }));
        reply(&agent, &prompt, json!({ "stopReason": "end_turn" }));
        agent.stay_connected();
    });
    let snapshot = open(spec(directory.path()), io).unwrap();
    prompt(&snapshot.id, "改一下 a.ts").unwrap();
    wait_until_idle(&snapshot.id, Duration::from_secs(8)).unwrap();
    let current = snapshot_of(&snapshot.id);
    assert_eq!(
        kinds(&current),
        vec!["message:user", "message:agent", "tool:A", "message:agent", "tool:B", "turn:end_turn"],
        "回复、工具 A、回复、工具 B 必须按到达顺序排列"
    );
    let replies = messages(&current);
    assert_eq!(replies[1].text, "先读一下文件。", "连续的片段合并为同一条回复");
    assert_eq!(replies[2].text, "读完了，接着改。");
    let calls = tools(&current);
    assert_eq!(calls.iter().filter(|call| call.call_id == "A").count(), 1, "A 的更新原位合并，不重复");
    assert_eq!(calls[0].status, "completed");
    assert_eq!(calls[0].title, "读取 a.ts");
    assert_eq!(calls[1].status, "pending");
    assert_eq!(current.last_turn_reason, "end_turn");

    // The events say the same thing in the same order, and each chunk names the
    // message it extends.
    let events = events_of(&snapshot.id);
    let streamed: Vec<&str> = events
        .iter()
        .map(event_kind)
        .filter(|kind| matches!(*kind, "chunk" | "tool" | "item"))
        .collect();
    assert_eq!(streamed, vec!["chunk", "chunk", "tool", "chunk", "tool", "tool", "item"]);
    let chunk_ids: Vec<String> = events
        .iter()
        .filter_map(|event| match &event.update {
            AcpUpdate::Chunk { message_id, .. } => Some(message_id.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(chunk_ids[0], chunk_ids[1]);
    assert_ne!(chunk_ids[1], chunk_ids[2], "工具之后的回复是新的一条消息");
    let sequence: Vec<u64> = events.iter().map(|event| event.seq).collect();
    assert!(sequence.windows(2).all(|pair| pair[0] < pair[1]), "事件序号必须递增");
    close(&snapshot.id).unwrap();
    worker.join().unwrap();
}

#[test]
fn a_message_id_merges_into_its_own_message_wherever_it_stands() {
    let directory = temp_dir();
    let (io, mut agent) = pair();
    let worker = std::thread::spawn(move || {
        agent.handshake(false);
        let prompt = agent.next_line();
        agent.chunk("session-1", "m1", "第一条");
        update(&agent, "session-1", json!({ "sessionUpdate": "tool_call", "toolCallId": "A", "title": "搜索" }));
        agent.chunk("session-1", "m2", "第二条");
        agent.chunk("session-1", "m1", "（补充）");
        reply(&agent, &prompt, json!({ "stopReason": "end_turn" }));
        agent.stay_connected();
    });
    let snapshot = open(spec(directory.path()), io).unwrap();
    prompt(&snapshot.id, "开始").unwrap();
    wait_until_idle(&snapshot.id, Duration::from_secs(8)).unwrap();
    let current = snapshot_of(&snapshot.id);
    assert_eq!(kinds(&current), vec!["message:user", "message:agent", "tool:A", "message:agent", "turn:end_turn"]);
    let replies = messages(&current);
    assert_eq!(replies[1].id, "m1");
    assert_eq!(replies[1].text, "第一条（补充）");
    assert_eq!(replies[2].text, "第二条");
    close(&snapshot.id).unwrap();
    worker.join().unwrap();
}

#[test]
fn tool_content_keeps_kind_locations_input_diff_terminal_and_image() {
    let directory = temp_dir();
    let (io, mut agent) = pair();
    let long = "x".repeat(MAX_DIFF_CHARS + 10);
    let worker = std::thread::spawn(move || {
        agent.handshake(false);
        let prompt = agent.next_line();
        update(&agent, "session-1", json!({
            "sessionUpdate": "tool_call", "toolCallId": "edit-1", "title": "编辑 main.rs", "kind": "edit",
            "status": "pending",
            "locations": [{ "path": "/work/src/main.rs", "line": 12 }, { "path": "/work/README.md" }],
            "rawInput": { "path": "/work/src/main.rs", "replace": "fn main() {}" },
        }));
        update(&agent, "session-1", json!({
            "sessionUpdate": "tool_call_update", "toolCallId": "edit-1", "status": "completed",
            "content": [
                { "type": "content", "content": { "type": "text", "text": "已写入" } },
                { "type": "diff", "path": "/work/src/main.rs", "oldText": "fn main() {}", "newText": "fn main() { run(); }" },
                { "type": "diff", "path": "/work/new.txt", "newText": long },
                { "type": "terminal", "terminalId": "term-7" },
                { "type": "content", "content": { "type": "image", "mimeType": "image/png", "data": "iVBORw0KGgo=" } },
                { "type": "content", "content": { "type": "resource", "resource": { "uri": "file:///work/a.txt", "text": "资源文本" } } },
            ],
        }));
        update(&agent, "session-1", json!({ "sessionUpdate": "tool_call", "toolCallId": "odd-1", "title": "未知工具", "kind": "teleport" }));
        reply(&agent, &prompt, json!({ "stopReason": "end_turn" }));
        agent.stay_connected();
    });
    let snapshot = open(spec(directory.path()), io).unwrap();
    prompt(&snapshot.id, "改 main.rs").unwrap();
    wait_until_idle(&snapshot.id, Duration::from_secs(8)).unwrap();
    let current = snapshot_of(&snapshot.id);
    let calls = tools(&current);
    let edit = &calls[0];
    assert_eq!(edit.tool_kind, "edit");
    assert_eq!(edit.status, "completed");
    assert_eq!(
        edit.locations,
        vec![
            AcpToolLocation { path: "/work/src/main.rs".into(), line: Some(12) },
            AcpToolLocation { path: "/work/README.md".into(), line: None },
        ],
        "未在更新中出现的 locations 保持原值"
    );
    let input = edit.raw_input.as_deref().unwrap();
    assert!(input.contains("\"replace\""), "{input}");
    assert_eq!(edit.content[0], AcpToolContent::Text { text: "已写入".into(), truncated: false });
    assert_eq!(
        edit.content[1],
        AcpToolContent::Diff {
            path: "/work/src/main.rs".into(),
            old_text: Some("fn main() {}".into()),
            new_text: "fn main() { run(); }".into(),
            truncated: false,
        }
    );
    match &edit.content[2] {
        AcpToolContent::Diff { old_text, new_text, truncated, .. } => {
            assert!(old_text.is_none(), "新文件没有旧内容");
            assert_eq!(new_text.chars().count(), MAX_DIFF_CHARS);
            assert!(*truncated, "超过上限的 diff 必须标记截断");
        }
        other => panic!("expected a diff, got {other:?}"),
    }
    assert_eq!(edit.content[3], AcpToolContent::Terminal { terminal_id: "term-7".into() });
    assert_eq!(edit.content[4], AcpToolContent::Image { mime_type: "image/png".into() });
    assert_eq!(edit.content[5], AcpToolContent::Text { text: "资源文本".into(), truncated: false });
    let serialized = serde_json::to_string(&current).unwrap();
    assert!(!serialized.contains("iVBORw0KGgo="), "图片只保留占位，不保留数据");
    // The wire shape the view reads: the item tag and the tool kind never collide.
    let wire = serde_json::to_value(&current.timeline).unwrap();
    let item = wire.as_array().unwrap().iter().find(|item| item["callId"] == "edit-1").unwrap();
    assert_eq!(item["kind"], "tool");
    assert_eq!(item["toolKind"], "edit");
    assert_eq!(item["content"][1]["type"], "diff");
    assert_eq!(item["content"][1]["oldText"], "fn main() {}");
    assert_eq!(item["content"][3]["terminalId"], "term-7");
    assert_eq!(item["content"][4]["mimeType"], "image/png");
    assert_eq!(item["locations"][0]["line"], 12);
    assert_eq!(calls[1].tool_kind, "other", "未知 kind 记为 other");
    close(&snapshot.id).unwrap();
    worker.join().unwrap();
}

#[test]
fn a_permission_tool_call_merges_into_the_same_tool_item() {
    let directory = temp_dir();
    let (io, mut agent) = pair();
    let worker = std::thread::spawn(move || {
        agent.handshake(false);
        let prompt = agent.next_line();
        update(&agent, "session-1", json!({ "sessionUpdate": "tool_call", "toolCallId": "run-1", "title": "运行测试", "kind": "execute" }));
        agent.send(json!({
            "jsonrpc": "2.0", "id": 41, "method": "session/request_permission",
            "params": {
                "sessionId": "session-1",
                "toolCall": { "toolCallId": "run-1", "rawInput": { "command": "npm test" }, "locations": [{ "path": "/work" }] },
                "options": [
                    { "optionId": "ok", "name": "允许", "kind": "allow_once" },
                    { "optionId": "no", "name": "拒绝" },
                ],
            },
        }));
        let answer = agent.next_line();
        assert_eq!(answer["id"], 41);
        assert_eq!(answer["result"]["outcome"]["optionId"], "ok");
        reply(&agent, &prompt, json!({ "stopReason": "end_turn" }));
        agent.stay_connected();
    });
    let snapshot = open(spec(directory.path()), io).unwrap();
    prompt(&snapshot.id, "跑测试").unwrap();
    wait_for(|| (!snapshot_of(&snapshot.id).pending.is_empty()).then_some(()), "授权请求");
    let asked = snapshot_of(&snapshot.id);
    assert_eq!(asked.state, "waiting_permission");
    let calls = tools(&asked);
    assert_eq!(calls.len(), 1, "授权请求的 toolCall 合并到同一工具项");
    assert_eq!(calls[0].title, "运行测试");
    assert_eq!(calls[0].tool_kind, "execute");
    assert!(calls[0].raw_input.as_deref().unwrap().contains("npm test"));
    assert_eq!(calls[0].locations, vec![AcpToolLocation { path: "/work".into(), line: None }]);
    assert_eq!(asked.pending, vec!["41".to_string()]);
    let option_kinds: Vec<&str> = calls[0]
        .permission
        .as_ref()
        .unwrap()
        .options
        .iter()
        .map(|option| option.kind.as_str())
        .collect();
    assert_eq!(option_kinds, vec!["allow_once", UNKNOWN_PERMISSION_KIND], "缺少 kind 的选项不能被补成允许");
    let events = events_of(&snapshot.id);
    assert!(events.iter().any(|event| matches!(&event.update, AcpUpdate::Pending { pending } if pending == &vec!["41".to_string()])));
    respond_permission(&snapshot.id, "41", Some("ok")).unwrap();
    wait_until_idle(&snapshot.id, Duration::from_secs(8)).unwrap();
    let done = snapshot_of(&snapshot.id);
    assert!(done.pending.is_empty());
    assert!(events_of(&snapshot.id).iter().any(|event| matches!(&event.update, AcpUpdate::Pending { pending } if pending.is_empty())));
    close(&snapshot.id).unwrap();
    worker.join().unwrap();
}

#[test]
fn notices_and_turn_ends_enter_the_timeline() {
    let directory = temp_dir();
    let (io, mut agent) = pair();
    let worker = std::thread::spawn(move || {
        agent.handshake(false);
        let first = agent.next_line();
        reply(&agent, &first, json!({ "stopReason": "max_tokens" }));
        let second = agent.next_line();
        reply(&agent, &second, json!({ "stopReason": "refusal" }));
        agent.stay_connected();
    });
    let mut start = spec(directory.path());
    // Not negotiated: the host says so in the timeline.
    start.resume_native_id = Some("previous".into());
    let snapshot = open(start, io).unwrap();
    prompt(&snapshot.id, "一").unwrap();
    wait_until_idle(&snapshot.id, Duration::from_secs(8)).unwrap();
    prompt(&snapshot.id, "二").unwrap();
    wait_until_idle(&snapshot.id, Duration::from_secs(8)).unwrap();
    let current = snapshot_of(&snapshot.id);
    assert_eq!(
        kinds(&current),
        vec!["notice:resume_unsupported", "message:user", "turn:limit", "message:user", "turn:refusal"]
    );
    close(&snapshot.id).unwrap();
    worker.join().unwrap();
}

#[test]
fn an_over_budget_timeline_drops_finished_turns_and_says_so() {
    // Budget 80, low-water mark 60.
    let mut timeline = Timeline::new(80);
    timeline.append_chunk("agent", Some("old-1"), None, "turn-1", &"a".repeat(30));
    timeline.append_chunk("agent", Some("old-2"), None, "turn-1", &"b".repeat(30));
    assert!(!timeline.trim(Some("turn-2")), "预算内不裁剪");
    timeline.append_chunk("agent", Some("new-1"), None, "turn-2", &"c".repeat(30));
    assert!(timeline.trim(Some("turn-2")));
    let ids: Vec<&str> = timeline.items().iter().map(AcpTimelineItem::id).collect();
    assert_eq!(ids, vec![TRIMMED_NOTICE_ID, "old-2", "new-1"], "从最旧的已结束轮次开始裁剪");
    match &timeline.items()[0] {
        AcpTimelineItem::Notice(notice) => {
            assert_eq!(notice.code, "trimmed");
            assert!(notice.text.contains("已省略"), "{}", notice.text);
        }
        other => panic!("expected the trimmed notice, got {other:?}"),
    }
    // The active turn is never dropped, even when the budget stays exceeded.
    timeline.append_chunk("agent", Some("new-2"), None, "turn-2", &"d".repeat(60));
    timeline.trim(Some("turn-2"));
    let ids: Vec<&str> = timeline.items().iter().map(AcpTimelineItem::id).collect();
    assert_eq!(ids, vec![TRIMMED_NOTICE_ID, "new-1", "new-2"]);
    assert_eq!(
        timeline.items().iter().filter(|item| item.id() == TRIMMED_NOTICE_ID).count(),
        1,
        "省略提示只有一条"
    );
    // Nothing left to drop: the active turn alone keeps it over budget, and
    // further growth trims nothing (so nothing is republished).
    timeline.append_chunk("agent", Some("new-2"), None, "turn-2", "e");
    assert!(!timeline.trim(Some("turn-2")));
}

#[test]
fn a_trim_goes_down_to_the_low_water_mark_so_later_growth_does_not_trim_again() {
    // Budget 1000, low-water mark 750; 100 finished items of 10 characters.
    let mut timeline = Timeline::new(1000);
    for index in 0..100 {
        timeline.append_chunk("agent", Some(&format!("old-{index}")), None, "turn-1", &"a".repeat(10));
    }
    timeline.append_chunk("agent", Some("new"), None, "turn-2", "b");
    assert!(timeline.trim(Some("turn-2")), "越过预算后裁剪一次");
    // Down to the low-water mark, plus the one notice that reports the trim.
    assert!(timeline.weight() <= 750 + 20, "一次裁剪降到低水位，实际 {}", timeline.weight());
    // A further 200 single-character chunks stay under the budget: none of
    // them trims again.
    let trims = (0..200)
        .filter(|_| {
            timeline.append_chunk("agent", Some("new"), None, "turn-2", "c");
            timeline.trim(Some("turn-2"))
        })
        .count();
    assert_eq!(trims, 0, "低水位之上的增长不再触发裁剪");
}

#[test]
fn a_grouped_select_keeps_its_nested_choices_within_the_entry_bound() {
    let nested: Vec<Value> = (0..300).map(|index| json!({ "value": format!("v{index}"), "name": format!("V{index}") })).collect();
    let option = super::capabilities::parse_config_option(&json!({
        "id": "model", "name": "模型", "type": "select", "currentValue": "v0",
        "options": [
            { "group": "g1", "name": "大组", "options": nested },
            { "value": "tail", "name": "末尾" },
        ],
    }))
    .unwrap();
    assert_eq!(option.options.len(), 200, "分组内的选项同样受条目上限约束");
    assert_eq!(option.options[199].value, "v199");
}

#[test]
fn streaming_past_the_budget_republishes_a_bounded_number_of_snapshots() {
    // The first turn fills the timeline past its budget with many small
    // messages; the second streams many chunks. Each trim republishes the
    // whole snapshot, so the trim must leave room instead of shaving one old
    // item per chunk.
    const OLD_MESSAGES: usize = 2_100;
    const OLD_CHARS: usize = 1_000;
    const CHUNKS: usize = 1_000;
    const CHUNK_CHARS: usize = 100;
    let directory = temp_dir();
    let (io, mut agent) = pair();
    let worker = std::thread::spawn(move || {
        agent.handshake(false);
        let first = agent.next_line();
        let old = "a".repeat(OLD_CHARS);
        for index in 0..OLD_MESSAGES {
            agent.chunk("session-1", &format!("old-{index}"), &old);
        }
        reply(&agent, &first, json!({ "stopReason": "end_turn" }));
        let second = agent.next_line();
        let piece = "b".repeat(CHUNK_CHARS);
        for _ in 0..CHUNKS {
            agent.chunk("session-1", "new", &piece);
        }
        reply(&agent, &second, json!({ "stopReason": "end_turn" }));
        agent.stay_connected();
    });
    let snapshot = open(spec(directory.path()), io).unwrap();
    prompt(&snapshot.id, "一").unwrap();
    wait_until_idle(&snapshot.id, Duration::from_secs(30)).unwrap();
    let before = events_of(&snapshot.id).len();
    prompt(&snapshot.id, "二").unwrap();
    wait_until_idle(&snapshot.id, Duration::from_secs(30)).unwrap();
    let events = events_of(&snapshot.id);
    let second_turn = &events[before..];
    let chunks = second_turn.iter().filter(|event| event_kind(event) == "chunk").count();
    assert_eq!(chunks, CHUNKS, "每个片段都以增量事件发出");
    let snapshots = second_turn.iter().filter(|event| event_kind(event) == "snapshot").count();
    // The turn's own start and end plus one trim; before the low-water mark
    // this was one snapshot per ten chunks.
    assert!(snapshots <= 4, "越过预算后的快照事件必须有上限，实际 {snapshots}");
    let current = snapshot_of(&snapshot.id);
    assert_eq!(current.timeline[0].id(), TRIMMED_NOTICE_ID, "裁剪确实发生");
    assert_eq!(messages(&current).last().unwrap().text.len(), CHUNKS * CHUNK_CHARS);
    close(&snapshot.id).unwrap();
    worker.join().unwrap();
}

#[test]
fn plan_commands_modes_config_title_and_usage_land_in_the_snapshot_with_their_events() {
    let directory = temp_dir();
    let (io, mut agent) = pair();
    let worker = std::thread::spawn(move || {
        handshake_with(
            &mut agent,
            json!({ "protocolVersion": 1, "agentCapabilities": {} }),
            json!({
                "sessionId": "session-1",
                "modes": { "currentModeId": "ask", "availableModes": [{ "id": "ask", "name": "询问" }, { "id": "code", "name": "编码" }] },
            }),
        );
        let prompt = agent.next_line();
        update(&agent, "session-1", json!({ "sessionUpdate": "plan", "entries": [
            { "content": "读代码", "priority": "high", "status": "completed" },
            { "content": "改代码", "priority": "medium", "status": "in_progress" },
        ] }));
        update(&agent, "session-1", json!({ "sessionUpdate": "plan", "entries": [
            { "content": "只剩这一步", "priority": "low", "status": "pending" },
        ] }));
        update(&agent, "session-1", json!({ "sessionUpdate": "available_commands_update", "availableCommands": [
            { "name": "review", "description": "审查改动" },
            { "name": "test", "description": "运行测试", "input": { "hint": "测试名" } },
        ] }));
        update(&agent, "session-1", json!({ "sessionUpdate": "current_mode_update", "currentModeId": "code" }));
        update(&agent, "session-1", json!({ "sessionUpdate": "config_option_update", "configOptions": [
            { "id": "effort", "name": "思考强度", "category": "thought_level", "type": "select", "currentValue": "high",
              "options": [{ "value": "low", "name": "低" }, { "value": "high", "name": "高" }] },
        ] }));
        update(&agent, "session-1", json!({ "sessionUpdate": "session_info_update", "title": "修复登录", "updatedAt": "2026-11-27T10:00:00Z" }));
        update(&agent, "session-1", json!({ "sessionUpdate": "usage_update", "used": 1200, "size": 200000, "cost": { "amount": 0.12, "currency": "USD" } }));
        reply(&agent, &prompt, json!({ "stopReason": "end_turn" }));
        let next = agent.next_line();
        // An empty plan clears the plan.
        update(&agent, "session-1", json!({ "sessionUpdate": "plan", "entries": [] }));
        update(&agent, "session-1", json!({ "sessionUpdate": "session_info_update", "title": null }));
        reply(&agent, &next, json!({ "stopReason": "end_turn" }));
        agent.stay_connected();
    });
    let snapshot = open(spec(directory.path()), io).unwrap();
    assert_eq!(snapshot.config.modes.as_ref().unwrap().current_mode_id, "ask");
    assert!(snapshot.info.usage.is_none(), "用量只在上报后出现");
    prompt(&snapshot.id, "开始").unwrap();
    wait_until_idle(&snapshot.id, Duration::from_secs(8)).unwrap();
    let current = snapshot_of(&snapshot.id);
    assert_eq!(
        current.plan,
        vec![AcpPlanEntry { content: "只剩这一步".into(), priority: "low", status: "pending" }],
        "plan 整体替换"
    );
    assert_eq!(current.commands.len(), 2);
    assert_eq!(current.commands[1].hint.as_deref(), Some("测试名"));
    assert_eq!(current.config.modes.as_ref().unwrap().current_mode_id, "code");
    assert_eq!(current.config.modes.as_ref().unwrap().available_modes.len(), 2);
    assert_eq!(current.config.options[0].id, "effort");
    assert_eq!(current.config.options[0].current_value, json!("high"));
    assert_eq!(current.config.options[0].options.len(), 2);
    assert_eq!(current.info.title.as_deref(), Some("修复登录"));
    let usage = current.info.usage.as_ref().unwrap();
    assert_eq!((usage.used, usage.size), (1200, 200000));
    assert_eq!(usage.cost.as_ref().unwrap().currency, "USD");
    let emitted: Vec<&str> = events_of(&snapshot.id).iter().map(event_kind).collect();
    for kind in ["plan", "commands", "config", "info"] {
        assert!(emitted.contains(&kind), "缺少 {kind} 事件：{emitted:?}");
    }
    assert_eq!(emitted.iter().filter(|kind| **kind == "plan").count(), 2);
    assert_eq!(emitted.iter().filter(|kind| **kind == "config").count(), 2);
    assert_eq!(emitted.iter().filter(|kind| **kind == "info").count(), 2);

    prompt(&snapshot.id, "继续").unwrap();
    wait_until_idle(&snapshot.id, Duration::from_secs(8)).unwrap();
    let cleared = snapshot_of(&snapshot.id);
    assert!(cleared.plan.is_empty(), "空 plan 清除计划");
    assert!(cleared.info.title.is_none(), "title 为 null 时清除");
    assert!(cleared.info.usage.is_some(), "未出现的字段保持原值");
    close(&snapshot.id).unwrap();
    worker.join().unwrap();
}

#[test]
fn a_subagent_is_registered_and_its_updates_and_requests_are_attributed_to_it() {
    let directory = temp_dir();
    let (io, mut agent) = pair();
    let (answer_tx, answer_rx) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        agent.handshake(false);
        let prompt = agent.next_line();
        // Before the announcement, a child's update is someone else's.
        update(&agent, "child-1", json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "过早" } }));
        update(&agent, "session-1", json!({ "sessionUpdate": "subagent_update", "sessionId": "child-1", "title": "测试排查", "description": "排查 Windows 测试失败", "state": { "state": "running" } }));
        update(&agent, "child-1", json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "子会话在查日志" } }));
        // The same call id in the parent and in the child are two calls.
        update(&agent, "child-1", json!({ "sessionUpdate": "tool_call", "toolCallId": "call_001", "title": "跑集成测试", "kind": "execute" }));
        update(&agent, "session-1", json!({ "sessionUpdate": "tool_call", "toolCallId": "call_001", "title": "派发子任务", "kind": "other" }));
        // A child's own plan and commands are not the conversation's.
        update(&agent, "child-1", json!({ "sessionUpdate": "available_commands_update", "availableCommands": [{ "name": "child-only", "description": "x" }] }));
        agent.send(json!({
            "jsonrpc": "2.0", "id": 77, "method": "session/request_permission",
            "params": {
                "sessionId": "child-1",
                "toolCall": { "toolCallId": "call_001" },
                "options": [{ "optionId": "allow-once", "name": "允许一次", "kind": "allow_once" }],
            },
        }));
        let answer = agent.next_line();
        let _ = answer_tx.send(answer);
        update(&agent, "session-1", json!({ "sessionUpdate": "subagent_update", "sessionId": "child-1", "state": { "state": "idle", "stopReason": "end_turn" } }));
        reply(&agent, &prompt, json!({ "stopReason": "end_turn" }));
        agent.stay_connected();
    });
    let snapshot = open(spec(directory.path()), io).unwrap();
    prompt(&snapshot.id, "并行排查").unwrap();
    wait_for(|| (!snapshot_of(&snapshot.id).pending.is_empty()).then_some(()), "子会话的授权请求");
    let asked = snapshot_of(&snapshot.id);
    let child_call = tools(&asked).into_iter().find(|call| call.subagent.as_deref() == Some("child-1")).unwrap();
    assert_eq!(child_call.title, "跑集成测试");
    assert_eq!(child_call.permission.as_ref().unwrap().request_id, "77", "子会话的授权卡归属到子会话的工具项");
    respond_permission(&snapshot.id, "77", Some("allow-once")).unwrap();
    let answer = answer_rx.recv_timeout(Duration::from_secs(8)).unwrap();
    assert_eq!(answer["id"], 77);
    assert_eq!(answer["result"]["outcome"]["optionId"], "allow-once");
    wait_until_idle(&snapshot.id, Duration::from_secs(8)).unwrap();
    let current = snapshot_of(&snapshot.id);
    let all_tools = tools(&current);
    assert_eq!(all_tools.len(), 2, "父子会话相同的 toolCallId 是两项");
    assert!(all_tools.iter().any(|call| call.subagent.is_none() && call.title == "派发子任务"));
    let child_messages: Vec<_> = messages(&current).into_iter().filter(|message| message.subagent.is_some()).collect();
    assert_eq!(child_messages.len(), 1);
    assert_eq!(child_messages[0].text, "子会话在查日志");
    assert!(messages(&current).iter().all(|message| message.text != "过早"), "未登记的子会话更新不得混入");
    let child = current
        .timeline
        .iter()
        .find_map(|item| match item {
            AcpTimelineItem::Subagent(child) => Some(child.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(child.session_id, "child-1");
    assert_eq!(child.title.as_deref(), Some("测试排查"));
    assert_eq!(child.state.as_deref(), Some("idle"));
    assert_eq!(child.stop_reason.as_deref(), Some("end_turn"));
    assert_eq!(child.summary, "子会话在查日志");
    assert!(current.commands.is_empty(), "子会话的命令不得作为本会话的输入");
    assert!(current.diagnostics.iter().any(|line| line.contains("其他会话")));
    close(&snapshot.id).unwrap();
    worker.join().unwrap();
}

#[test]
fn initialize_publishes_client_info_and_only_honoured_capabilities_and_keeps_the_agent_record() {
    let directory = temp_dir();
    let (io, mut agent) = pair();
    let (frames_tx, frames_rx) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let frames = handshake_with(
            &mut agent,
            json!({
                "protocolVersion": 1,
                "agentInfo": { "name": "fixture-agent", "title": "Fixture Agent", "version": "2.1.0" },
                "agentCapabilities": {
                    "loadSession": true,
                    "promptCapabilities": { "image": true, "embeddedContext": true },
                    "sessionCapabilities": { "list": {}, "resume": {}, "delete": null },
                },
                "authMethods": [{ "id": "login", "name": "登录", "description": "浏览器登录" }],
            }),
            json!({
                "sessionId": "session-1",
                "modes": { "currentModeId": "ask", "availableModes": [{ "id": "ask", "name": "询问" }] },
                "configOptions": [{ "id": "fast", "name": "快速模式", "type": "boolean", "currentValue": false }],
                "models": { "currentModelId": "m1", "availableModels": [{ "modelId": "m1", "name": "模型一" }, { "modelId": "m2", "name": "模型二" }] },
            }),
        );
        let _ = frames_tx.send(frames);
        agent.stay_connected();
    });
    let snapshot = open(spec(directory.path()), io).unwrap();
    let (initialize, created) = frames_rx.recv_timeout(Duration::from_secs(8)).unwrap();
    assert_eq!(initialize["params"]["protocolVersion"], 1);
    assert_eq!(initialize["params"]["clientInfo"]["name"], "Cliora");
    assert!(initialize["params"]["clientInfo"]["version"].is_string());
    let declared = &initialize["params"]["clientCapabilities"];
    assert_eq!(declared["fs"]["readTextFile"], true, "已实现的文件能力必须声明");
    assert_eq!(declared["fs"]["writeTextFile"], true);
    assert_eq!(declared["terminal"], true);
    assert!(declared.get("elicitation").is_none(), "未实现的 elicitation 不声明");
    assert_eq!(declared["subagents"], json!({}));
    assert_eq!(created["params"]["mcpServers"], json!([]));

    let record = &snapshot.agent;
    assert_eq!(record.protocol_version, Some(1));
    let info = record.agent_info.as_ref().unwrap();
    assert_eq!((info.name.as_str(), info.title.as_deref(), info.version.as_deref()), ("fixture-agent", Some("Fixture Agent"), Some("2.1.0")));
    assert!(record.prompt_capabilities.image);
    assert!(!record.prompt_capabilities.audio);
    assert!(record.prompt_capabilities.embedded_context);
    assert_eq!(
        record.session_capabilities,
        AcpSessionCapabilities { list: true, resume: true, delete: false, close: false }
    );
    assert!(record.load_session);
    assert_eq!(record.auth_methods.len(), 1);
    assert_eq!(record.auth_methods[0].kind, "agent");
    assert_eq!(snapshot.config.modes.as_ref().unwrap().available_modes[0].name, "询问");
    assert_eq!(snapshot.config.options[0].kind, "boolean");
    assert_eq!(snapshot.config.options[0].current_value, json!(false));
    assert_eq!(snapshot.config.models.as_ref().unwrap().available_models.len(), 2);
    let serialized = serde_json::to_value(&snapshot).unwrap();
    for key in ["agentInfo", "promptCapabilities", "sessionCapabilities", "loadSession", "authMethods"] {
        assert!(serialized["agent"].get(key).is_some(), "快照 agent 字段缺少 {key}");
    }
    close(&snapshot.id).unwrap();
    worker.join().unwrap();
}

#[test]
fn another_protocol_version_fails_with_a_stated_reason() {
    let directory = temp_dir();
    let (io, mut agent) = pair();
    let worker = std::thread::spawn(move || {
        let initialize = agent.next_line();
        reply(&agent, &initialize, json!({ "protocolVersion": 2, "agentCapabilities": {} }));
    });
    let error = open(spec(directory.path()), io).expect_err("协议版本不为 1 时必须失败");
    assert!(error.contains("协议版本 2"), "{error}");
    assert!(error.contains("版本 1"), "{error}");
    let leaked = list()
        .into_iter()
        .filter(|session| session.directory == directory.path().display().to_string())
        .count();
    assert_eq!(leaked, 0);
    worker.join().unwrap();
}

#[test]
fn a_prompt_turn_outlives_the_request_timeout_while_other_requests_still_time_out() {
    let directory = temp_dir();
    let (io, mut agent) = pair();
    let worker = std::thread::spawn(move || {
        handshake_with(
            &mut agent,
            json!({ "protocolVersion": 1, "agentCapabilities": {} }),
            json!({ "sessionId": "session-1", "modes": { "currentModeId": "ask", "availableModes": [{ "id": "ask", "name": "询问" }, { "id": "code", "name": "编码" }] } }),
        );
        let prompt = agent.next_line();
        assert_eq!(prompt["method"], "session/prompt");
        // Answer well after the request deadline.
        std::thread::sleep(Duration::from_millis(1_200));
        plain_chunk(&agent, "终于好了");
        reply(&agent, &prompt, json!({ "stopReason": "end_turn" }));
        // A mode switch is an ordinary request: never answered, it times out.
        let switch = agent.next_line();
        assert_eq!(switch["method"], "session/set_mode");
        agent.stay_connected();
    });
    let mut start = spec(directory.path());
    start.timeout = Duration::from_millis(400);
    let snapshot = open(start, io).unwrap();
    prompt(&snapshot.id, "慢慢来").unwrap();
    std::thread::sleep(Duration::from_millis(700));
    assert_eq!(snapshot_of(&snapshot.id).state, "running", "超过请求超时后轮次仍在进行");
    wait_until_idle(&snapshot.id, Duration::from_secs(8)).unwrap();
    let ended = snapshot_of(&snapshot.id);
    assert_eq!(ended.last_turn_reason, "end_turn", "轮次以 agent 的 stopReason 结束");
    assert!(messages(&ended).iter().any(|message| message.text == "终于好了"));
    let error = set_mode(&snapshot.id, "code").unwrap_err();
    assert!(error.contains("超时"), "{error}");
    assert_eq!(snapshot_of(&snapshot.id).config.modes.unwrap().current_mode_id, "ask");
    close(&snapshot.id).unwrap();
    worker.join().unwrap();
}

#[test]
fn set_mode_and_set_config_apply_on_success_and_republish_the_old_value_on_failure() {
    let directory = temp_dir();
    let (io, mut agent) = pair();
    let worker = std::thread::spawn(move || {
        handshake_with(
            &mut agent,
            json!({ "protocolVersion": 1, "agentCapabilities": {} }),
            json!({
                "sessionId": "session-1",
                "modes": { "currentModeId": "ask", "availableModes": [{ "id": "ask", "name": "询问" }, { "id": "code", "name": "编码" }] },
                "configOptions": [
                    { "id": "model", "name": "模型", "category": "model", "type": "select", "currentValue": "a",
                      "options": [{ "group": "g1", "name": "常用", "options": [{ "value": "a", "name": "A" }, { "value": "b", "name": "B" }] }] },
                    { "id": "fast", "name": "快速模式", "type": "boolean", "currentValue": false },
                ],
                "models": { "currentModelId": "m1", "availableModels": [{ "modelId": "m1", "name": "一" }, { "modelId": "m2", "name": "二" }] },
            }),
        );
        let mode = agent.next_line();
        assert_eq!(mode["method"], "session/set_mode");
        assert_eq!(mode["params"], json!({ "sessionId": "session-1", "modeId": "code" }));
        reply(&agent, &mode, json!({}));
        let refused = agent.next_line();
        assert_eq!(refused["params"]["modeId"], "ask");
        agent.send(json!({ "jsonrpc": "2.0", "id": refused["id"], "error": { "code": -32603, "message": "mode locked" } }));
        let select = agent.next_line();
        assert_eq!(select["method"], "session/set_config_option");
        assert_eq!(select["params"], json!({ "sessionId": "session-1", "configId": "model", "value": "b" }));
        reply(&agent, &select, json!({ "configOptions": [
            { "id": "model", "name": "模型", "type": "select", "currentValue": "b", "options": [{ "value": "a", "name": "A" }, { "value": "b", "name": "B" }] },
            { "id": "fast", "name": "快速模式", "type": "boolean", "currentValue": true },
        ] }));
        let boolean = agent.next_line();
        assert_eq!(boolean["params"], json!({ "sessionId": "session-1", "configId": "fast", "type": "boolean", "value": false }));
        agent.send(json!({ "jsonrpc": "2.0", "id": boolean["id"], "error": { "code": -32603, "message": "busy" } }));
        let legacy = agent.next_line();
        assert_eq!(legacy["method"], "session/set_model");
        assert_eq!(legacy["params"], json!({ "sessionId": "session-1", "modelId": "m2" }));
        reply(&agent, &legacy, json!({}));
        agent.stay_connected();
    });
    let snapshot = open(spec(directory.path()), io).unwrap();
    let id = snapshot.id.clone();
    assert_eq!(snapshot.config.options[0].options[0].group.as_deref(), Some("常用"));

    set_mode(&id, "code").unwrap();
    assert_eq!(snapshot_of(&id).config.modes.unwrap().current_mode_id, "code");
    assert!(matches!(events_of(&id).last().map(|event| &event.update), Some(AcpUpdate::Config { .. })));

    let refused = set_mode(&id, "ask").unwrap_err();
    assert!(refused.contains("mode locked"), "{refused}");
    match events_of(&id).last().map(|event| &event.update) {
        Some(AcpUpdate::Snapshot { snapshot }) => {
            assert_eq!(snapshot.config.modes.as_ref().unwrap().current_mode_id, "code", "失败后发布原值快照");
        }
        other => panic!("失败后必须发布快照：{other:?}"),
    }
    // Values outside the declaration are refused before anything is sent.
    assert!(set_mode(&id, "plan").is_err());
    assert!(set_config(&id, "model", &json!("zzz")).is_err());
    assert!(set_config(&id, "fast", &json!("yes")).is_err());
    assert!(set_config(&id, "unknown", &json!("a")).is_err());

    set_config(&id, "model", &json!("b")).unwrap();
    let current = snapshot_of(&id);
    assert_eq!(current.config.options[0].current_value, json!("b"));
    assert_eq!(current.config.options[1].current_value, json!(true), "回应中的完整选项集整体替换");

    let refused = set_config(&id, "fast", &json!(false)).unwrap_err();
    assert!(refused.contains("busy"), "{refused}");
    match events_of(&id).last().map(|event| &event.update) {
        Some(AcpUpdate::Snapshot { snapshot }) => assert_eq!(snapshot.config.options[1].current_value, json!(true)),
        other => panic!("失败后必须发布快照：{other:?}"),
    }

    set_config(&id, LEGACY_MODEL_CONFIG_ID, &json!("m2")).unwrap();
    assert_eq!(snapshot_of(&id).config.models.unwrap().current_model_id, "m2");
    close(&id).unwrap();
    worker.join().unwrap();
}
