//! Launch interaction routing: how a local new session decides between the
//! terminal and an ACP conversation, and what it refuses before a worktree or a
//! process exists.
use super::*;
use crate::adapters::{AcpOrigin, CliAdapter, LaunchForm};
use crate::native::adapter::Installation;

fn fixture_installation(home: &Path, name: &str) -> (Installation, PathBuf) {
    let directory = home.join("bin");
    std::fs::create_dir_all(&directory).unwrap();
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    let program = directory.join(format!("{name}{suffix}"));
    std::fs::write(&program, b"fixture").unwrap();
    (
        Installation {
            path: program.display().to_string(),
            version: Some("2.7.0".into()),
            source: "test_fixture",
            status: "available",
            detail: None,
        },
        program,
    )
}

fn request(tool: &str) -> LaunchRequest {
    LaunchRequest {
        tool_id: tool.into(),
        project_id: None,
        session_id: None,
        directory: None,
        initial_prompt: None,
        mode: LaunchMode::Normal,
        resume_latest: false,
        remote_intent: None,
        agent: None,
        session_options: None,
        interaction: None,
    }
}

#[test]
fn a_stored_interaction_reads_as_terminal_until_it_is_changed() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("app.db")).unwrap();
    // An installation from before this field existed keeps the terminal.
    assert_eq!(interaction_preference(&db).unwrap(), (InteractionMode::Terminal, None));
    assert_eq!(settings(&db).unwrap().interaction, InteractionMode::Terminal);
    assert!(settings(&db).unwrap().interaction_error.is_none());

    let saved = set_interaction(&db, "acp").unwrap();
    assert_eq!(saved.interaction, InteractionMode::Acp);
    assert_eq!(interaction_preference(&db).unwrap().0, InteractionMode::Acp);
    assert_eq!(set_interaction(&db, "terminal").unwrap().interaction, InteractionMode::Terminal);

    // An unknown value is refused before writing, so the row keeps its value.
    assert!(set_interaction(&db, "chat").is_err());
    assert_eq!(interaction_preference(&db).unwrap().0, InteractionMode::Terminal);

    // A row written by something else reads as the terminal and says so.
    write_setting(&db, INTERACTION_KEY, "\"chat\"").unwrap();
    let (mode, error) = interaction_preference(&db).unwrap();
    assert_eq!(mode, InteractionMode::Terminal);
    assert_eq!(error.as_deref(), Some(INTERACTION_FORMAT));
    assert_eq!(settings(&db).unwrap().interaction_error.as_deref(), Some(INTERACTION_FORMAT));
}

#[test]
fn a_conversation_is_chosen_only_for_a_local_new_session() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("app.db")).unwrap();
    let home = temp.path();
    let (installation, program) = fixture_installation(home, "opencode");
    let adapter: &dyn CliAdapter = &crate::adapters::OPENCODE;
    set_interaction(&db, "acp").unwrap();

    // The stored preference decides a plain new session.
    let (mode, command) = resolve_interaction(
        &db, &request("open_code"), LaunchForm::Terminal, adapter, home, &installation, Some("2.7.0"),
    )
    .unwrap();
    assert_eq!(mode, InteractionMode::Acp);
    let command = command.expect("ACP 启动必须解析出入口");
    assert_eq!(command.program, program, "必须使用所选安装里的入口");
    assert_eq!(command.args, ["acp"]);
    assert_eq!(command.origin, AcpOrigin::Native.as_str());

    // An explicit terminal is how a failed ACP start retries in the same
    // directory without changing the setting.
    let mut retry = request("open_code");
    retry.interaction = Some(InteractionMode::Terminal);
    let (mode, command) = resolve_interaction(
        &db, &retry, LaunchForm::Terminal, adapter, home, &installation, Some("2.7.0"),
    )
    .unwrap();
    assert_eq!(mode, InteractionMode::Terminal);
    assert!(command.is_none());

    // A resumed record and a latest-session resume belong to the terminal
    // launch: they continue an existing CLI conversation, so the stored
    // preference falls back instead of refusing to open the record at all.
    let mut resumed = request("open_code");
    resumed.session_id = Some("native-1".into());
    let (mode, command) = resolve_interaction(
        &db, &resumed, LaunchForm::Terminal, adapter, home, &installation, Some("2.7.0"),
    )
    .unwrap();
    assert_eq!(mode, InteractionMode::Terminal);
    assert!(command.is_none());

    let mut latest = request("open_code");
    latest.resume_latest = true;
    let (mode, command) = resolve_interaction(
        &db, &latest, LaunchForm::Terminal, adapter, home, &installation, Some("2.7.0"),
    )
    .unwrap();
    assert_eq!(mode, InteractionMode::Terminal);
    assert!(command.is_none());

    // YOLO asks the CLI to approve every tool by itself. An ACP entry publishes
    // no such switch and a conversation surfaces approvals as cards, so the
    // mode is refused instead of silently disappearing.
    let mut yolo = request("open_code");
    yolo.mode = LaunchMode::Yolo;
    let failure = resolve_interaction(
        &db, &yolo, LaunchForm::Terminal, adapter, home, &installation, Some("2.7.0"),
    )
    .unwrap_err();
    assert_eq!(failure.stage, LaunchStage::Tool);
    assert!(failure.message.contains("YOLO"), "{}", failure.message);
    // A YOLO terminal launch is unaffected by the stored preference.
    yolo.interaction = Some(InteractionMode::Terminal);
    assert_eq!(
        resolve_interaction(&db, &yolo, LaunchForm::Terminal, adapter, home, &installation, Some("2.7.0"))
            .unwrap()
            .0,
        InteractionMode::Terminal
    );

    let mut agent = request("open_code");
    agent.agent = Some("reviewer".into());
    let failure = resolve_interaction(
        &db, &agent, LaunchForm::Terminal, adapter, home, &installation, Some("2.7.0"),
    )
    .unwrap_err();
    assert!(failure.message.contains("Agent"), "{}", failure.message);

    let mut options = request("open_code");
    options.session_options = Some([("model".to_string(), "a".to_string())].into_iter().collect());
    assert!(resolve_interaction(
        &db, &options, LaunchForm::Terminal, adapter, home, &installation, Some("2.7.0"),
    )
    .is_err());

    // A desktop application keeps its own path, and asking for a conversation
    // is an explicit refusal rather than a silent terminal launch.
    let mut desktop = request("open_code");
    desktop.interaction = Some(InteractionMode::Acp);
    let failure = resolve_interaction(
        &db, &desktop, LaunchForm::Desktop, adapter, home, &installation, Some("2.7.0"),
    )
    .unwrap_err();
    assert!(failure.message.contains("桌面应用"), "{}", failure.message);
    assert_eq!(
        resolve_interaction(
            &db, &request("open_code"), LaunchForm::Desktop, adapter, home, &installation, Some("2.7.0"),
        )
        .unwrap().0,
        InteractionMode::Terminal
    );
}

/// The stored preference decides a *new* session only. An existing record and a
/// history resume are terminal conversations, so they must keep planning a
/// terminal launch while the preference says ACP, or every old tab would be
/// unopenable.
#[test]
fn a_stored_conversation_preference_still_plans_existing_records_as_terminals() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("app.db")).unwrap();
    let home = temp.path();
    let (installation, _program) = fixture_installation(home, "opencode");
    let mut registry = Registry::builtins();
    registry.fixture_installations.insert("open_code".into(), vec![installation.clone()]);
    set_interaction(&db, "acp").unwrap();

    // A saved terminal tab: the restore worker plans it with its own
    // interaction, which is the terminal.
    let mut saved = request("open_code");
    saved.session_id = Some("native-1".into());
    saved.interaction = Some(InteractionMode::Terminal);
    let plan = plan_history_context(&db, &registry, home, saved, home, None)
        .expect("既有终端记录必须仍能规划");
    assert_eq!(plan.interaction, InteractionMode::Terminal);
    assert!(plan.acp.is_none(), "终端恢复不得解析 ACP 入口");
    assert_eq!(plan.resume_native_id.as_deref(), Some("native-1"));

    // A history resume plans the same way; the preference never leaks into it.
    let mut history = request("open_code");
    history.session_id = Some("native-2".into());
    let plan = plan_history_context(&db, &registry, home, history, home, None)
        .expect("历史续聊必须仍能规划");
    assert_eq!(plan.interaction, InteractionMode::Terminal);
    assert!(plan.acp.is_none());

    // A new session still follows the preference: the fallback above is about
    // records, not about the setting.
    let plan = plan_history_context(&db, &registry, home, request("open_code"), home, None).unwrap();
    assert_eq!(plan.interaction, InteractionMode::Acp);
    assert!(plan.acp.is_some());
}

#[test]
fn the_selected_installation_wins_over_another_copy() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("app.db")).unwrap();
    let home = temp.path();
    // Two installations of the same executable: an older one on the adapter's
    // own directory and the one the user selected elsewhere.
    let (older, older_program) = fixture_installation(home, "kimi");
    let selected_directory = home.join("selected");
    std::fs::create_dir_all(&selected_directory).unwrap();
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    let selected_program = selected_directory.join(format!("kimi{suffix}"));
    std::fs::write(&selected_program, b"fixture").unwrap();
    std::fs::write(&older_program, b"fixture").unwrap();
    let selected = Installation { path: selected_program.display().to_string(), ..older };

    let adapter: &dyn CliAdapter = &crate::adapters::KIMI_CODE;
    let mut wanted = request("kimi_code");
    wanted.interaction = Some(InteractionMode::Acp);
    let (mode, command) = resolve_interaction(
        &db, &wanted, LaunchForm::Terminal, adapter, home, &selected, Some("2.7.0"),
    )
    .unwrap();
    assert_eq!(mode, InteractionMode::Acp);
    assert_eq!(
        command.unwrap().program,
        selected_program,
        "命中程序必须来自所选安装，而不是搜索到的另一份"
    );
}

#[test]
fn a_version_outside_the_line_is_refused_with_the_shared_wording() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("app.db")).unwrap();
    let home = temp.path();
    let (installation, _program) = fixture_installation(home, "kimi");
    let adapter: &dyn CliAdapter = &crate::adapters::KIMI_CODE;
    let mut wanted = request("kimi_code");
    wanted.interaction = Some(InteractionMode::Acp);

    let failure = resolve_interaction(
        &db, &wanted, LaunchForm::Terminal, adapter, home, &installation, Some("1.52.0"),
    )
    .unwrap_err();
    assert_eq!(failure.stage, LaunchStage::Tool);
    assert!(failure.message.contains("无法以 ACP 对话启动"), "{}", failure.message);
    assert!(failure.message.contains("旧版 Kimi CLI"), "{}", failure.message);
    assert!(
        failure.message.contains(crate::adapters::ACP_VERSION_OUT_OF_RANGE),
        "越界文案必须来自共享常量：{}",
        failure.message
    );

    // An unverified version never satisfies a declared line either.
    let failure = resolve_interaction(
        &db, &wanted, LaunchForm::Terminal, adapter, home, &installation, None,
    )
    .unwrap_err();
    assert!(failure.message.contains(crate::adapters::ACP_VERSION_OUT_OF_RANGE));
}
