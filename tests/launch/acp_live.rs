//! Live ACP sampling against the agents installed on this machine.
//!
//! This drives the real host (`crate::acp`): the adapter resolves the entry,
//! the host spawns it, runs the handshake, creates a session and submits real
//! prompts. It may incur inference cost, so it is `#[ignore]` and does nothing
//! unless explicitly enabled:
//!
//! ```text
//! CLIORA_LIVE_ACP_TESTS=1 CLIORA_LIVE_ACP_AGENTS=open_code,kimi_code \
//!   cargo test --manifest-path src-tauri/Cargo.toml --lib acp::live_tests -- --ignored --nocapture
//! ```
//!
//! `CLIORA_LIVE_ACP_AGENTS` takes adapter ids or `all`. `CLIORA_LIVE_ACP_REPORT`
//! sets where the JSON report goes (default: the system temp directory).
//!
//! Each agent gets two very short prompts in a fresh temporary directory, never
//! in the repository: a normal session asks it to read the first line of
//! README.md (an authorization card is answered "allow once" as a user would),
//! and a YOLO session asks it to run `echo cliora-acp-ok` (the host answers on
//! its own). The report keeps protocol facts only: method names, update kinds,
//! option kinds and short reply excerpts. It never reads or prints credentials;
//! an agent that is not logged in is recorded as such and is not logged in.
use super::*;
use serde_json::Map;
use std::collections::BTreeMap;
use std::path::Path;

const README_LINE: &str = "cliora-acp-live-readme-7f3a";
const ECHO_MARKER: &str = "cliora-acp-ok";
const READ_PROMPT: &str =
    "Read the first line of the file README.md in the current working directory and reply with exactly that line, nothing else.";
const RUN_PROMPT: &str = "Run the shell command `echo cliora-acp-ok` and reply with its output only.";
const TURN_LIMIT: Duration = Duration::from_secs(240);

/// What crossed the wire, as names and kinds only.
#[derive(Default)]
struct Probe {
    /// Requests the agent sent to the client, by method.
    agent_requests: BTreeMap<String, u32>,
    /// session/update kinds the agent sent.
    updates: BTreeMap<String, u32>,
    /// Requests the host sent to the agent, by method.
    host_requests: BTreeMap<String, u32>,
    host_methods: HashMap<String, String>,
    agent_methods: HashMap<String, String>,
    /// Option kinds of each open permission request, by JSON-RPC id.
    offers: HashMap<String, Vec<(String, String)>>,
    permissions: Vec<Value>,
    /// Error answers in either direction: "method: message".
    errors: Vec<String>,
}

impl Probe {
    fn line(&mut self, line: &[u8], inbound: bool) {
        let Ok(value) = serde_json::from_slice::<Value>(line) else { return };
        let id = value.get("id").map(Value::to_string);
        let method = value.get("method").and_then(Value::as_str).map(ToOwned::to_owned);
        match (inbound, id, method) {
            (true, Some(id), Some(method)) => {
                *self.agent_requests.entry(method.clone()).or_default() += 1;
                if method == "session/request_permission" {
                    let offered = value["params"]["options"]
                        .as_array()
                        .map(|options| {
                            options
                                .iter()
                                .map(|option| {
                                    (
                                        option["optionId"].as_str().unwrap_or_default().to_owned(),
                                        option["kind"].as_str().unwrap_or(UNKNOWN_PERMISSION_KIND).to_owned(),
                                    )
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    self.offers.insert(id.clone(), offered);
                }
                self.agent_methods.insert(id, method);
            }
            (true, None, Some(method)) => {
                if method == "session/update" {
                    let kind = value["params"]["update"]["sessionUpdate"].as_str().unwrap_or("?").to_owned();
                    *self.updates.entry(kind).or_default() += 1;
                } else {
                    *self.updates.entry(format!("notification:{method}")).or_default() += 1;
                }
            }
            (true, Some(id), None) => {
                if let Some(error) = value.get("error") {
                    let method = self.host_methods.get(&id).cloned().unwrap_or_default();
                    let message = error["message"].as_str().unwrap_or_default();
                    self.errors.push(format!("agent→{method}: {}", redact(message)));
                }
            }
            (false, Some(id), Some(method)) => {
                *self.host_requests.entry(method.clone()).or_default() += 1;
                self.host_methods.insert(id, method);
            }
            (false, Some(id), None) => {
                if let Some(offered) = self.offers.remove(&id) {
                    let outcome = &value["result"]["outcome"];
                    let chosen = outcome["optionId"].as_str();
                    let kind = chosen.and_then(|chosen| offered.iter().find(|(option, _)| option == chosen)).map(|(_, kind)| kind.clone());
                    self.permissions.push(json!({
                        "offered": offered.iter().map(|(_, kind)| kind.clone()).collect::<Vec<_>>(),
                        "outcome": outcome["outcome"],
                        "chosenKind": kind,
                    }));
                } else if let Some(error) = value.get("error") {
                    let method = self.agent_methods.get(&id).cloned().unwrap_or_default();
                    let message = error["message"].as_str().unwrap_or_default();
                    self.errors.push(format!("client→{method}: {}", redact(message)));
                }
            }
            _ => {}
        }
    }
}

/// A stream that records each complete JSON-RPC line passing through it.
struct Tap<T> {
    inner: T,
    pending: Vec<u8>,
    probe: Arc<Mutex<Probe>>,
    inbound: bool,
}

impl<T> Tap<T> {
    fn feed(&mut self, bytes: &[u8]) {
        self.pending.extend_from_slice(bytes);
        while let Some(end) = self.pending.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=end).collect();
            guard(&self.probe).line(&line, self.inbound);
        }
    }
}

impl<T: Read> Read for Tap<T> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let count = self.inner.read(buffer)?;
        self.feed(&buffer[..count]);
        Ok(count)
    }
}

impl<T: Write> Write for Tap<T> {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let count = self.inner.write(buffer)?;
        self.feed(&buffer[..count]);
        Ok(count)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

fn excerpt(text: &str, limit: usize) -> String {
    let trimmed = text.trim();
    let mut out: String = trimmed.chars().take(limit).collect();
    if trimmed.chars().count() > limit {
        out.push('…');
    }
    out
}

fn counts(map: &BTreeMap<String, u32>) -> Value {
    Value::Object(map.iter().map(|(key, value)| (key.clone(), json!(value))).collect::<Map<_, _>>())
}

/// Answer what a user would: an authorization card "allow once" (or "always"
/// when nothing else allows), an approval card once, a form cancelled.
fn answer_pending(id: &str, answered: &mut Vec<String>) {
    let Ok(current) = snapshot(id) else { return };
    for item in &current.timeline {
        match item {
            AcpTimelineItem::Tool(call) => {
                let Some(request) = &call.permission else { continue };
                if !current.pending.contains(&request.request_id) || answered.contains(&request.request_id) {
                    continue;
                }
                let option = request
                    .options
                    .iter()
                    .find(|option| option.kind == "allow_once")
                    .or_else(|| request.options.iter().find(|option| option.kind == "allow_always"));
                answered.push(request.request_id.clone());
                let _ = respond_permission(id, &request.request_id, option.map(|option| option.option_id.as_str()));
            }
            AcpTimelineItem::Access(access) => {
                let Some(request) = &access.request_id else { continue };
                if access.decision != "pending" || !current.pending.contains(request) || answered.contains(request) {
                    continue;
                }
                answered.push(request.clone());
                let _ = respond_access(id, request, "once");
            }
            AcpTimelineItem::Elicitation(form) => {
                let Some(request) = &form.request_id else { continue };
                if !current.pending.contains(request) || answered.contains(request) {
                    continue;
                }
                answered.push(request.clone());
                let _ = respond_elicitation(id, request, "cancel", None);
            }
            _ => {}
        }
    }
}

/// Submit one prompt and wait for its turn to end, answering cards on the way.
fn run_turn(id: &str, text: &str, marker: &str) -> Value {
    let started = Instant::now();
    if let Err(error) = prompt(id, text) {
        return json!({ "submitted": false, "error": error });
    }
    let mut answered = Vec::new();
    let mut timed_out = false;
    loop {
        answer_pending(id, &mut answered);
        let Ok(session) = lookup(id) else { break };
        let settled = !matches!(*guard(&session.state), "running" | "stopping");
        if guard(&session.turn).is_none() && settled {
            break;
        }
        if started.elapsed() > TURN_LIMIT {
            timed_out = true;
            let _ = cancel(id);
            std::thread::sleep(Duration::from_secs(5));
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    let Ok(current) = snapshot(id) else {
        return json!({ "submitted": true, "error": "会话已消失" });
    };
    let turn = current
        .timeline
        .iter()
        .rev()
        .find_map(|item| match item {
            AcpTimelineItem::Message(message) if message.role == "user" => Some(message.turn_id.clone()),
            _ => None,
        })
        .unwrap_or_default();
    let mut reply = String::new();
    let mut tools = Vec::new();
    let mut accesses = Vec::new();
    let mut notices = Vec::new();
    for item in &current.timeline {
        match item {
            AcpTimelineItem::Message(message) if message.turn_id == turn && message.role == "agent" => reply.push_str(&message.text),
            AcpTimelineItem::Tool(call) if call.turn_id == turn => {
                tools.push(json!({ "kind": call.tool_kind, "status": call.status, "content": call.content.len(), "locations": call.locations.len() }))
            }
            AcpTimelineItem::Access(access) if access.turn_id == turn => {
                accesses.push(json!({ "kind": access.access_kind, "decision": access.decision, "diff": access.diff.is_some() }))
            }
            AcpTimelineItem::Notice(notice) if notice.turn_id == turn || notice.turn_id.is_empty() => {
                notices.push(json!({ "level": notice.level, "code": notice.code, "text": excerpt(&notice.text, 160) }))
            }
            _ => {}
        }
    }
    json!({
        "submitted": true,
        "seconds": started.elapsed().as_secs(),
        "timedOut": timed_out,
        "turnReason": current.last_turn_reason,
        "state": current.state,
        "reply": excerpt(&reply, 240),
        "replyHasMarker": reply.contains(marker),
        "tools": tools,
        "plan": current.plan.len(),
        "accesses": accesses,
        "notices": notices,
        "terminals": current.terminals.iter().map(|terminal| json!({
            "command": excerpt(&terminal.command, 80),
            "exit": terminal.exit_status.as_ref().and_then(|status| status.exit_code),
            "outputHasMarker": terminal.output.contains(ECHO_MARKER),
        })).collect::<Vec<_>>(),
        "answeredByTest": answered.len(),
    })
}

/// One session of one agent: start, record the declarations, run one prompt.
fn run_session(adapter: &dyn crate::adapters::CliAdapter, command: &AcpCommand, mode: LaunchMode, directory: &Path, text: &str, marker: &str) -> Value {
    let mut command = command.clone();
    let mut yolo_mode = None;
    if mode == LaunchMode::Yolo {
        match command.yolo {
            Some(crate::adapters::AcpYolo::Client) => {}
            Some(crate::adapters::AcpYolo::Args { args }) => command.args.extend(args.iter().map(|arg| (*arg).to_owned())),
            Some(crate::adapters::AcpYolo::Mode { mode_id }) => yolo_mode = Some(mode_id.to_owned()),
            None => return json!({ "started": false, "error": crate::adapters::ACP_YOLO_UNDECLARED }),
        }
    }
    let spec = AcpStart {
        tool_id: adapter.id().to_owned(),
        project_id: None,
        directory: directory.to_path_buf(),
        mode,
        environment: command.environment.clone(),
        remove_environment: command.remove_environment.clone(),
        command,
        credential: None,
        session_markers: adapter.session_env_markers(),
        initial_prompt: None,
        resume_native_id: None,
        timeout: Duration::from_secs(90),
        yolo_mode,
    };
    let probe = Arc::new(Mutex::new(Probe::default()));
    let started = Instant::now();
    let opened = spawn_io(&spec).and_then(|(io, secret)| {
        let AcpIo { reader, writer, diagnostics, shutdown } = io;
        let io = AcpIo {
            reader: Box::new(Tap { inner: reader, pending: Vec::new(), probe: Arc::clone(&probe), inbound: true }),
            writer: Box::new(Tap { inner: writer, pending: Vec::new(), probe: Arc::clone(&probe), inbound: false }),
            diagnostics,
            shutdown,
        };
        open_with(spec, io, secret, None)
    });
    let handshake_seconds = started.elapsed().as_secs_f32();
    let mut record = match &opened {
        Err(error) => json!({ "started": false, "error": excerpt(error, 300) }),
        Ok(snapshot) => json!({
            "started": true,
            "state": snapshot.state,
            "startSeconds": (handshake_seconds * 10.0).round() / 10.0,
            "agent": {
                "protocolVersion": snapshot.agent.protocol_version,
                "agentInfo": snapshot.agent.agent_info,
                "loadSession": snapshot.agent.load_session,
                "sessionCapabilities": snapshot.agent.session_capabilities,
                "promptCapabilities": snapshot.agent.prompt_capabilities,
                "authMethods": snapshot.agent.auth_methods.iter().map(|method| method.id.clone()).collect::<Vec<_>>(),
            },
            "sessionNew": snapshot.native_session_id.is_some(),
            "authError": snapshot.auth_error.as_deref().map(|text| excerpt(text, 200)),
            "modes": snapshot.config.modes.as_ref().map(|modes| json!({
                "current": modes.current_mode_id,
                "available": modes.available_modes.iter().map(|mode| mode.id.clone()).collect::<Vec<_>>(),
            })),
            "configOptions": snapshot.config.options.iter().map(|option| option.id.clone()).collect::<Vec<_>>(),
            "models": snapshot.config.models.as_ref().map(|models| models.available_models.len()),
        }),
    };
    if let Ok(snapshot) = &opened {
        let id = snapshot.id.clone();
        if snapshot.state == "ready" {
            record["turn"] = run_turn(&id, text, marker);
        }
        if let Ok(current) = super::snapshot(&id) {
            record["commands"] = json!(current.commands.len());
            record["diagnostics"] = json!(current.diagnostics.iter().take(4).map(|line| excerpt(line, 200)).collect::<Vec<_>>());
            record["title"] = json!(current.info.title.is_some());
            record["usage"] = json!(current.info.usage.is_some());
        }
        let _ = close(&id);
    }
    let probe = guard(&probe);
    record["wire"] = json!({
        "agentRequests": counts(&probe.agent_requests),
        "updates": counts(&probe.updates),
        "hostRequests": counts(&probe.host_requests),
        "permissions": probe.permissions,
        "errors": probe.errors.iter().take(6).cloned().collect::<Vec<_>>(),
    });
    record
}

fn sample(id: &str, home: &Path) -> Value {
    let registry = &crate::adapters::Registry::builtins();
    let Some(adapter) = registry.get(id) else {
        return json!({ "id": id, "error": "未注册的适配器" });
    };
    let installation = match crate::native::adapter::probe_registered_launch(registry, id, None, home) {
        Ok(Some(installation)) => installation,
        Ok(None) => return json!({ "id": id, "resolved": false, "code": "not-installed", "reason": "CLI 未检测到可用安装" }),
        Err(error) => return json!({ "id": id, "resolved": false, "code": "probe-failed", "reason": excerpt(&error, 200) }),
    };
    let version = installation.version.clone();
    let command = match adapter.acp_command(home, Some(Path::new(&installation.path)), version.as_deref()) {
        Ok(command) => command,
        Err(issue) => return json!({ "id": id, "version": version, "resolved": false, "code": issue.code, "reason": excerpt(&issue.reason, 200) }),
    };
    let program = command.program.file_name().map(|name| name.to_string_lossy().into_owned());
    let mut record = json!({
        "id": id,
        "version": version,
        "resolved": true,
        "entry": { "program": program, "args": command.args, "origin": command.origin, "yolo": format!("{:?}", command.yolo) },
    });
    for (key, mode, text, marker) in [
        ("normal", LaunchMode::Normal, READ_PROMPT, README_LINE),
        ("yolo", LaunchMode::Yolo, RUN_PROMPT, ECHO_MARKER),
    ] {
        let directory = tempfile::Builder::new().prefix("cliora-live-acp-").tempdir().expect("临时目录");
        std::fs::write(directory.path().join("README.md"), format!("{README_LINE}\nsecond line of the live sample\n")).expect("写入 README.md");
        record[key] = run_session(adapter, &command, mode, directory.path(), text, marker);
        // An agent may keep files open briefly after it is stopped.
        std::thread::sleep(Duration::from_millis(500));
        drop(directory);
        // A session that never authenticated makes the second one pointless.
        if record[key]["state"] == "auth_required" || record[key]["started"] == false {
            break;
        }
    }
    record
}

#[test]
#[ignore = "live ACP agents: may incur inference cost; set CLIORA_LIVE_ACP_TESTS=1 and CLIORA_LIVE_ACP_AGENTS"]
fn live_agents_report_their_real_protocol_behaviour() {
    if std::env::var("CLIORA_LIVE_ACP_TESTS").ok().as_deref() != Some("1") {
        eprintln!("live ACP sampling skipped: CLIORA_LIVE_ACP_TESTS is not 1");
        return;
    }
    let registry = crate::adapters::Registry::builtins();
    let requested = std::env::var("CLIORA_LIVE_ACP_AGENTS").unwrap_or_default();
    let ids: Vec<String> = if requested.trim() == "all" {
        registry.iter().map(|adapter| adapter.id().to_owned()).collect()
    } else {
        requested.split(',').map(str::trim).filter(|id| !id.is_empty()).map(ToOwned::to_owned).collect()
    };
    assert!(!ids.is_empty(), "CLIORA_LIVE_ACP_AGENTS 为空：写适配器 id（逗号分隔）或 all");
    for id in &ids {
        assert!(registry.get(id).is_some(), "未注册的适配器 id：{id}");
    }
    let home = dirs::home_dir().expect("home directory");
    // Agents run side by side; each owns its temporary directories and sessions.
    let handles: Vec<_> = ids
        .iter()
        .cloned()
        .map(|id| {
            let home = home.clone();
            std::thread::spawn(move || sample(&id, &home))
        })
        .collect();
    let records: Vec<Value> = handles.into_iter().map(|handle| handle.join().unwrap_or_else(|_| json!({ "error": "采样线程崩溃" }))).collect();
    let report = json!({
        "kind": "cliora-live-acp-sampling",
        "platform": std::env::consts::OS,
        "prompts": { "normal": READ_PROMPT, "yolo": RUN_PROMPT },
        "agents": records,
    });
    let path = std::env::var_os("CLIORA_LIVE_ACP_REPORT")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("cliora-live-acp-report.json"));
    std::fs::write(&path, serde_json::to_string_pretty(&report).unwrap()).expect("写入报告");
    for record in report["agents"].as_array().unwrap() {
        eprintln!("{}", record);
    }
    eprintln!("report: {}", path.display());
}
