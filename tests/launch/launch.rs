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

#[test]
fn launch_recovers_interrupted_skills_before_tool_probe_without_opening_tools_page() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("app.db")).unwrap();
    let parent = temp.path().join(".claude/skills");
    std::fs::create_dir_all(&parent).unwrap();
    let target = parent.join("sample");
    let stage = parent.join(".cliora-stage-interrupted");
    let backup = parent.join(".cliora-backup-interrupted");
    std::fs::create_dir(&stage).unwrap();
    std::fs::write(stage.join("SKILL.md"), "partial stage").unwrap();
    db.with_connection(|conn| conn.execute(
        "INSERT INTO skill_operations (id, package_id, tool, scope_key, target_path, stage_path, backup_path, old_digest, old_managed_digest, new_digest, removing, status) VALUES ('interrupted', 'package', 'claude_code', 'global', ?1, ?2, ?3, NULL, NULL, 'new-digest', 0, 'prepared')",
        params![target.display().to_string(), stage.display().to_string(), backup.display().to_string()],
    ).map(|_| ()).map_err(|error| error.to_string())).unwrap();
    let result = plan_with_stage(
        &db,
        &Registry::builtins(),
        temp.path(),
        LaunchRequest {
            tool_id: "unregistered".into(),
            project_id: None,
            session_id: None,
            mode: LaunchMode::Normal,
        },
    );
    assert_eq!(result.unwrap_err().stage, LaunchStage::Tool);
    assert!(!stage.exists());
    let pending: i64 = db
        .with_connection(|conn| {
            conn.query_row("SELECT COUNT(*) FROM skill_operations", [], |row| {
                row.get(0)
            })
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(pending, 0);
}

#[cfg(windows)]
#[test]
fn damaged_claude_skill_backup_blocks_claude_but_not_grok_launch() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("app.db")).unwrap();
    let parent = temp.path().join(".claude/skills");
    std::fs::create_dir_all(&parent).unwrap();
    let target = parent.join("sample");
    let stage = parent.join(".cliora-stage-interrupted");
    let backup = parent.join(".cliora-backup-interrupted");
    std::fs::create_dir(&backup).unwrap();
    std::fs::write(
        backup.join("SKILL.md"),
        "---\nname: sample\ndescription: Previous\n---\n",
    )
    .unwrap();
    db.with_connection(|conn| conn.execute(
        "INSERT INTO skill_operations (id, package_id, tool, scope_key, target_path, stage_path, backup_path, old_digest, old_managed_digest, new_digest, removing, status) VALUES ('interrupted', 'package', 'claude_code', 'global', ?1, ?2, ?3, 'different-digest', NULL, NULL, 1, 'committed')",
        params![target.display().to_string(), stage.display().to_string(), backup.display().to_string()],
    ).map(|_| ()).map_err(|error| error.to_string())).unwrap();
    let cli = temp.path().join("grok.ps1");
    std::fs::write(&cli, "Write-Output 'grok 1.0.0'\n").unwrap();
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO installation_choices (tool, path) VALUES ('grok', ?1)",
            [cli.to_str().unwrap()],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
    })
    .unwrap();
    let unrelated = plan_with_stage(
        &db,
        &Registry::builtins(),
        temp.path(),
        LaunchRequest {
            tool_id: "grok".into(),
            project_id: None,
            session_id: None,
            mode: LaunchMode::Normal,
        },
    )
    .unwrap();
    assert_eq!(unrelated.tool_id, "grok");
    let failure = plan_with_stage(
        &db,
        &Registry::builtins(),
        temp.path(),
        LaunchRequest {
            tool_id: "claude_code".into(),
            project_id: None,
            session_id: None,
            mode: LaunchMode::Normal,
        },
    )
    .unwrap_err();
    assert_eq!(failure.stage, LaunchStage::Skills);
    assert!(failure.message.contains("备份"));
    assert!(backup.exists());
}

#[cfg(windows)]
#[test]
fn damaged_project_skill_backup_only_blocks_that_project() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("app.db")).unwrap();
    let registry = Registry::builtins();
    let cli = temp.path().join("grok.ps1");
    std::fs::write(&cli, "Write-Output 'grok 1.0.0'\n").unwrap();
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO installation_choices (tool, path) VALUES ('grok', ?1)",
            [cli.to_str().unwrap()],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
    })
    .unwrap();
    let first_path = temp.path().join("first");
    let second_path = temp.path().join("second");
    std::fs::create_dir_all(&first_path).unwrap();
    std::fs::create_dir_all(&second_path).unwrap();
    let first = projects::add(
        &db,
        &registry,
        first_path.to_str().unwrap(),
        None,
        Some("grok"),
    )
    .unwrap();
    let second = projects::add(
        &db,
        &registry,
        second_path.to_str().unwrap(),
        None,
        Some("grok"),
    )
    .unwrap();
    let parent = first_path.join(".grok/skills");
    std::fs::create_dir_all(&parent).unwrap();
    let target = parent.join("sample");
    let stage = parent.join(".cliora-stage-interrupted");
    let backup = parent.join(".cliora-backup-interrupted");
    std::fs::create_dir(&backup).unwrap();
    std::fs::write(
        backup.join("SKILL.md"),
        "---\nname: sample\ndescription: Previous\n---\n",
    )
    .unwrap();
    let scope = format!("project:{}", first_path.canonicalize().unwrap().display());
    db.with_connection(|conn| conn.execute(
        "INSERT INTO skill_operations (id, package_id, tool, scope_key, target_path, stage_path, backup_path, old_digest, old_managed_digest, new_digest, removing, status) VALUES ('interrupted', 'package', 'grok', ?1, ?2, ?3, ?4, 'different-digest', NULL, NULL, 1, 'committed')",
        params![scope, target.display().to_string(), stage.display().to_string(), backup.display().to_string()],
    ).map(|_| ()).map_err(|error| error.to_string())).unwrap();
    let request = |project_id: Option<String>| LaunchRequest {
        tool_id: "grok".into(),
        project_id,
        session_id: None,
        mode: LaunchMode::Normal,
    };
    assert_eq!(
        plan_with_stage(&db, &registry, temp.path(), request(Some(first.id)))
            .unwrap_err()
            .stage,
        LaunchStage::Skills
    );
    assert_eq!(
        plan_with_stage(&db, &registry, temp.path(), request(Some(second.id)))
            .unwrap()
            .tool_id,
        "grok"
    );
    assert_eq!(
        plan_with_stage(&db, &registry, temp.path(), request(None))
            .unwrap()
            .tool_id,
        "grok"
    );
    assert!(backup.exists());
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
