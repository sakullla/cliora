use super::*;

#[test]
fn remote_project_plan_uses_strict_ssh_and_remote_working_directory() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open(&directory.path().join("remote-launch.db")).unwrap();
    db.update_preferences(|preferences| preferences.remote_ssh_enabled = true)
        .unwrap();
    let target = crate::remote::save_target(
        &db,
        crate::remote::RemoteTarget {
            id: String::new(),
            name: "fixture".into(),
            host: "example.test".into(),
            port: 2222,
            user: "root".into(),
            auth_method: "key".into(),
            identity_file: None,
            ssh_config: None,
            default_path: None,
            enabled: true,
            created_at: 0,
            updated_at: 0,
        },
    )
    .unwrap();
    let project = crate::remote::save_project(
        &db,
        crate::remote::RemoteProject {
            id: String::new(),
            target_id: target.id,
            name: "remote demo".into(),
            path: "/srv/project".into(),
            preferred_tool: Some("codex".into()),
            updated_at: 0,
        },
    )
    .unwrap();
    let request = LaunchRequest {
        tool_id: "codex".into(),
        project_id: Some(format!("remote:{}", project.id)),
        session_id: None,
        directory: None,
        initial_prompt: Some("hello remote".into()),
        mode: LaunchMode::Normal,
        resume_latest: false,
    };
    let remote_plan = plan(&db, &Registry::builtins(), directory.path(), request).unwrap();
    assert_eq!(remote_plan.directory, PathBuf::from("/srv/project"));
    assert_eq!(remote_plan.executable, PathBuf::from("ssh"));
    assert_eq!(remote_plan.terminal, TerminalId::Workbench);
    assert!(remote_plan.cli_args.contains(&"-tt".to_string()));
    assert!(remote_plan.cli_args.iter().any(|value| value.contains("root@example.test")));
    assert!(remote_plan.cli_args.iter().any(|value| value.contains("/srv/project")));
    assert!(remote_plan.cli_args.iter().any(|value| value.contains("hello remote")));

    let claude_request = LaunchRequest {
        tool_id: "claude_code".into(),
        project_id: Some(format!("remote:{}", project.id)),
        session_id: None,
        directory: None,
        initial_prompt: None,
        mode: LaunchMode::Normal,
        resume_latest: false,
    };
    let claude = plan(&db, &Registry::builtins(), directory.path(), claude_request).unwrap();
    let command = claude.cli_args.last().unwrap();
    assert!(command.contains("'claude'"), "adapter command was not used: {command}");
}

#[test]
fn remote_plan_uses_persistent_mux_and_refuses_plain_ssh_fallback() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open(&directory.path().join("remote-mux.db")).unwrap();
    db.update_preferences(|preferences| preferences.remote_ssh_enabled = true).unwrap();
    let target = crate::remote::save_target(&db, crate::remote::RemoteTarget {
        id: String::new(), name: "fixture".into(), host: "example.test".into(), port: 22,
        user: "root".into(), auth_method: "key".into(), identity_file: None, ssh_config: None, default_path: None, enabled: true,
        created_at: 0, updated_at: 0,
    }).unwrap();
    let project = crate::remote::save_project(&db, crate::remote::RemoteProject {
        id: String::new(), target_id: target.id, name: "mux".into(), path: "/srv/mux".into(),
        preferred_tool: Some("codex".into()), updated_at: 0,
    }).unwrap();
    let plan = plan(&db, &Registry::builtins(), directory.path(), LaunchRequest {
        tool_id: "codex".into(), project_id: Some(format!("remote:{}", project.id)),
        session_id: None, directory: None, initial_prompt: None, mode: LaunchMode::Normal,
        resume_latest: false,
    }).unwrap();
    let command = plan.cli_args.last().unwrap();
    assert!(command.contains("tmux -u new-session -A"));
    assert!(command.contains("export TERM=xterm-256color COLORTERM=truecolor"));
    assert!(command.contains("LANG=C.UTF-8"));
    assert!(command.contains("screen -U -dmS"));
    assert!(command.contains("sh -lc"));
    assert!(command.contains("requires tmux or screen"));
    assert!(plan.remote_session_id.as_deref().is_some_and(|id| id.starts_with("cliora-")));
    assert!(plan.remote_end_args.is_some());
    let reattach = crate::launch::remote_reattach_command(plan.remote_session_id.as_deref().unwrap());
    assert!(reattach.contains("tmux -u has-session"));
    assert!(reattach.contains("tmux -u attach-session"));
    assert!(reattach.contains("COLORTERM=truecolor"));
    assert!(reattach.contains("screen -U -r"));
    assert!(reattach.contains("exit 44"));
}

