use super::*;

fn sample(terminal: TerminalId) -> LaunchPlan {
    LaunchPlan {
        tool_id: "grok".into(),
        project_id: Some("project-1".into()),
        mode: LaunchMode::Normal,
        executable: PathBuf::from("C:/Program Files/工具's cli/grok.ps1"),
        cli_args: vec![
            "--resume".into(),
            "会话 '1'".into(),
            "-m".into(),
            "模型 A".into(),
        ],
        directory: PathBuf::from("C:/用户/我的 project [one]"),
        terminal,
    }
}

#[test]
fn terminal_plans_quote_unicode_spaces_and_shell_metacharacters_as_data() {
    let ps = terminal_command(&sample(TerminalId::PowerShell)).unwrap();
    let command = ps.args.last().unwrap();
    assert!(command.contains("Set-Location -LiteralPath 'C:/用户/我的 project [one]'"));
    assert!(command.contains("& 'C:/Program Files/工具''s cli/grok.ps1'"));
    assert!(command.contains("'会话 ''1'''"));
    assert!(command.contains("'模型 A'"));
    let shell = terminal_command(&sample(TerminalId::GnomeTerminal)).unwrap();
    let command = shell.args.last().unwrap();
    assert!(command.contains("cd -- 'C:/用户/我的 project [one]'"));
    assert!(command.contains("'C:/Program Files/工具'\"'\"'s cli/grok.ps1'"));
    assert!(command.contains("'会话 '\"'\"'1'\"'\"''"));
}

#[test]
fn launch_mode_and_project_model_are_adapter_capabilities() {
    let registry = Registry::builtins();
    let grok = registry.get("grok").unwrap();
    let mut grok_args = adapters::plan_launch(
        &registry,
        "grok",
        "1.1.0",
        Some("session-1"),
        LaunchMode::Yolo,
    )
    .unwrap();
    grok_args.extend(grok.project_model_args(Some("grok-4.7")).unwrap());
    assert_eq!(
        grok_args,
        ["--resume", "session-1", "--yolo", "-m", "grok-4.7"]
    );
    assert!(adapters::plan_launch(&registry, "pi", "0.88.0", None, LaunchMode::Yolo).is_err());
    assert!(registry
        .get("pi")
        .unwrap()
        .project_model_args(Some("model"))
        .is_err());
}

#[test]
fn missing_project_never_falls_back_to_user_home() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("app.db")).unwrap();
    let result = plan_with_stage(
        &db,
        &Registry::builtins(),
        temp.path(),
        LaunchRequest {
            tool_id: "grok".into(),
            project_id: Some("missing-project".into()),
            session_id: None,
            mode: LaunchMode::Normal,
        },
    );
    let failure = result.unwrap_err();
    assert_eq!(failure.stage, LaunchStage::ProjectDirectory);
    assert!(failure.message.contains("项目不存在"));
}

#[cfg(windows)]
#[test]
fn project_launch_plan_uses_real_probe_and_project_model_without_shell_expansion() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("app.db")).unwrap();
    let project_path = temp.path().join("中文 project [one]");
    std::fs::create_dir(&project_path).unwrap();
    let cli = temp.path().join("grok.ps1");
    std::fs::write(&cli, "Write-Output 'grok 1.0.0'\n").unwrap();
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO installation_choices (tool, path) VALUES ('grok', ?1)",
            [cli.to_str().unwrap()],
        )
        .map_err(|error| error.to_string())?;
        Ok(())
    })
    .unwrap();
    let registry = Registry::builtins();
    let project = projects::add(
        &db,
        &registry,
        project_path.to_str().unwrap(),
        None,
        Some("grok"),
    )
    .unwrap();
    projects::set_model_override(&db, &registry, &project.id, "grok", Some("grok-4.7")).unwrap();
    let planned = plan(
        &db,
        &registry,
        temp.path(),
        LaunchRequest {
            tool_id: "grok".into(),
            project_id: Some(project.id.clone()),
            session_id: Some("session 1".into()),
            mode: LaunchMode::Yolo,
        },
    )
    .unwrap();
    assert_eq!(planned.directory, project_path.canonicalize().unwrap());
    assert_eq!(
        planned.cli_args,
        ["--resume", "session 1", "--yolo", "-m", "grok-4.7"]
    );
    let command = terminal_command(&planned).unwrap();
    assert_eq!(command.directory, planned.directory);
    assert!(!format!("{:?}", command.args).contains("API_KEY"));

    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES ('preferred_terminal', '\"mac_terminal\"')",
            [],
        )
        .map_err(|error| error.to_string())?;
        Ok(())
    })
    .unwrap();
    let failure = plan_with_stage(
        &db,
        &registry,
        temp.path(),
        LaunchRequest {
            tool_id: "grok".into(),
            project_id: Some(project.id),
            session_id: None,
            mode: LaunchMode::Normal,
        },
    )
    .unwrap_err();
    assert_eq!(failure.stage, LaunchStage::Terminal);
}
