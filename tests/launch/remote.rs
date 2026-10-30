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
        resume_latest: false, remote_intent: None,
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
        resume_latest: false, remote_intent: None,
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
        resume_latest: false, remote_intent: None,
    }).unwrap();
    let command = plan.cli_args.last().unwrap();
    assert!(command.contains("tmux -u new-session -s"));
    assert!(!command.contains("new-session -A"));
    assert!(command.contains("identity already exists"));
    assert!(command.contains("export TERM=xterm-256color COLORTERM=truecolor"));
    assert!(command.contains("LANG=C.UTF-8"));
    assert!(command.contains("screen -U -dmS"));
    assert!(command.contains("sh -lc"));
    assert!(command.contains("export PATH=\"$HOME/.local/bin:$HOME/bin:$PATH\""));
    assert!(command.contains("apt-get install -y tmux"));
    assert!(command.contains("sudo -n"));
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

#[test]
fn remote_claude_yolo_marks_root_as_sandbox_and_normal_does_not() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open(&directory.path().join("remote-claude.db")).unwrap();
    db.update_preferences(|preferences| preferences.remote_ssh_enabled = true).unwrap();
    let target = crate::remote::save_target(&db, crate::remote::RemoteTarget {
        id: String::new(), name: "fixture".into(), host: "example.test".into(), port: 22,
        user: "root".into(), auth_method: "key".into(), identity_file: None, ssh_config: None, default_path: None, enabled: true,
        created_at: 0, updated_at: 0,
    }).unwrap();
    let project = crate::remote::save_project(&db, crate::remote::RemoteProject {
        id: String::new(), target_id: target.id, name: "claude".into(), path: "/src/project".into(),
        preferred_tool: Some("claude_code".into()), updated_at: 0,
    }).unwrap();
    let yolo = plan(&db, &Registry::builtins(), directory.path(), LaunchRequest {
        tool_id: "claude_code".into(), project_id: Some(format!("remote:{}", project.id)),
        session_id: None, directory: None, initial_prompt: None, mode: LaunchMode::Yolo,
        resume_latest: false, remote_intent: None,
    }).unwrap();
    let yolo_command = yolo.cli_args.last().unwrap();
    assert!(yolo_command.contains("--dangerously-skip-permissions"));
    assert!(yolo_command.contains("export IS_SANDBOX=1"));
    assert!(yolo_command.contains("id -u"));
    let normal = plan(&db, &Registry::builtins(), directory.path(), LaunchRequest {
        tool_id: "claude_code".into(), project_id: Some(format!("remote:{}", project.id)),
        session_id: None, directory: None, initial_prompt: None, mode: LaunchMode::Normal,
        resume_latest: false, remote_intent: None,
    }).unwrap();
    let normal_command = normal.cli_args.last().unwrap();
    assert!(!normal_command.contains("IS_SANDBOX"));
    assert!(!normal_command.contains("--dangerously-skip-permissions"));
}


fn independent_fixture() -> (tempfile::TempDir, Database, crate::remote::RemoteProject) {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open(&directory.path().join("independent.db")).unwrap();
    db.update_preferences(|preferences| preferences.remote_ssh_enabled = true).unwrap();
    let target = crate::remote::save_target(&db, crate::remote::RemoteTarget {
        id: String::new(), name: "offline fixture".into(), host: "fixture.invalid".into(), port: 22,
        user: "fixture".into(), auth_method: "key".into(), identity_file: None, ssh_config: None,
        default_path: None, enabled: true, created_at: 0, updated_at: 0,
    }).unwrap();
    let project = crate::remote::save_project(&db, crate::remote::RemoteProject {
        id: String::new(), target_id: target.id, name: "shared directory".into(), path: "/srv/shared".into(),
        preferred_tool: Some("codex".into()), updated_at: 0,
    }).unwrap();
    (directory, db, project)
}

fn independent_request(project: &crate::remote::RemoteProject) -> LaunchRequest {
    LaunchRequest {
        tool_id: "codex".into(), project_id: Some(format!("remote:{}", project.id)),
        session_id: None, directory: None, initial_prompt: None, mode: LaunchMode::Normal,
        resume_latest: false, remote_intent: Some(RemoteLaunchIntent::New),
    }
}

#[test]
fn same_directory_new_launch_never_reuses_or_probes_indexed_sessions() {
    let (directory, db, project) = independent_fixture();
    remember_remote_session(&db, &project.id, "codex", LaunchMode::Normal, "cliora-existing-a").unwrap();
    let registry = Registry::builtins();
    let a = plan(&db, &registry, directory.path(), independent_request(&project)).unwrap();
    let b = plan(&db, &registry, directory.path(), independent_request(&project)).unwrap();
    assert_ne!(a.remote_session_id, b.remote_session_id);
    assert_ne!(a.remote_session_id.as_deref(), Some("cliora-existing-a"));
    for command in [a.cli_args.last().unwrap(), b.cli_args.last().unwrap()] {
        assert!(!command.contains("new-session -A"));
        assert!(!command.contains("attach-session"));
    }
    // The fixture host is unreachable; listing remains local and lossless.
    assert_eq!(list_remote_sessions(&db).unwrap()[0].remote_session_id, "cliora-existing-a");
}

#[test]
fn remote_restore_requires_exact_indexed_identity_and_never_falls_back_to_new() {
    let (directory, db, project) = independent_fixture();
    remember_remote_session(&db, &project.id, "codex", LaunchMode::Normal, "cliora-existing-a").unwrap();
    let mut request = independent_request(&project);
    request.remote_intent = Some(RemoteLaunchIntent::Reattach { remote_session_id: "cliora-existing-a".into() });
    let restored = plan(&db, &Registry::builtins(), directory.path(), request.clone()).unwrap();
    assert_eq!(restored.remote_session_id.as_deref(), Some("cliora-existing-a"));
    assert!(restored.cli_args.last().unwrap().contains("attach-session"));
    assert!(!restored.cli_args.last().unwrap().contains("new-session"));
    request.tool_id = "claude_code".into();
    assert!(plan(&db, &Registry::builtins(), directory.path(), request.clone()).is_err());
    request.tool_id = "codex".into();
    request.remote_intent = Some(RemoteLaunchIntent::Reattach { remote_session_id: "not-indexed".into() });
    assert!(plan(&db, &Registry::builtins(), directory.path(), request.clone()).is_err());
    request.remote_intent = None;
    request.session_id = Some("__remote_reattach__".into());
    assert!(plan(&db, &Registry::builtins(), directory.path(), request.clone()).is_err());
    request.session_id = Some("__remote_reattach__:cliora-existing-a".into());
    assert!(plan(&db, &Registry::builtins(), directory.path(), request).is_ok());
}

#[test]
fn same_directory_index_survives_concurrent_updates_reopen_and_single_identity_delete() {
    let (directory, db, project) = independent_fixture();
    let db = std::sync::Arc::new(db);
    std::thread::scope(|scope| {
        for index in 0..12 {
            let db = std::sync::Arc::clone(&db);
            let project_id = project.id.clone();
            scope.spawn(move || remember_remote_session(&db, &project_id, "codex", LaunchMode::Normal, &format!("cliora-{index:02}")).unwrap());
        }
    });
    assert_eq!(list_remote_sessions(&db).unwrap().len(), 12);
    remember_remote_session(&db, &project.id, "codex", LaunchMode::Normal, "cliora-00").unwrap();
    assert_eq!(list_remote_history(&db).unwrap().len(), 12);
    drop(db);
    let reopened = Database::open(&directory.path().join("independent.db")).unwrap();
    assert_eq!(list_remote_sessions(&reopened).unwrap().len(), 12);
    forget_remote_session(&reopened, "another-target", "cliora-00").unwrap();
    assert_eq!(list_remote_sessions(&reopened).unwrap().len(), 12);
    forget_remote_session(&reopened, &project.target_id, "cliora-00").unwrap();
    let remaining = list_remote_sessions(&reopened).unwrap();
    assert_eq!(remaining.len(), 11);
    assert!(!remaining.iter().any(|entry| entry.remote_session_id == "cliora-00"));
}

#[test]
fn version_28_migration_preserves_same_directory_legacy_sessions_and_deduplicates_only_identity() {
    let (directory, db, project) = independent_fixture();
    let make = |id: &str, seen| RemoteSessionIndexEntry {
        remote_session_id: id.into(), project_id: project.id.clone(), target_id: project.target_id.clone(),
        tool_id: "codex".into(), directory: project.path.clone(), mode: LaunchMode::Normal,
        started_at: 1, last_seen_at: seen,
    };
    let legacy = serde_json::to_string(&vec![make("cliora-a", 10), make("cliora-b", 20), make("cliora-c", 30), make("cliora-a", 40)]).unwrap();
    db.with_connection(|conn| {
        conn.execute("INSERT INTO app_settings (key,value) VALUES ('remote_session_index_v1',?1)", [&legacy]).map_err(|error| error.to_string())?;
        conn.execute_batch("DROP TABLE remote_session_index; PRAGMA user_version = 27;").map_err(|error| error.to_string())
    }).unwrap();
    drop(db);
    let reopened = Database::open(&directory.path().join("independent.db")).unwrap();
    let entries = list_remote_sessions(&reopened).unwrap();
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0].remote_session_id, "cliora-a");
    assert_eq!(entries[0].last_seen_at, 40);
    assert_eq!(entries[0].started_at, 1);
    drop(reopened);
    assert_eq!(list_remote_sessions(&Database::open(&directory.path().join("independent.db")).unwrap()).unwrap().len(), 3);
}

#[cfg(windows)]
#[test]
fn independent_remote_plans_spawn_distinct_controlled_ssh_processes_and_keep_input_separate() {
    use base64::Engine;
    let _guard = crate::session_host::lock_for_tests();
    let (directory, db, project) = independent_fixture();
    let script = directory.path().join("controlled-ssh.ps1");
    std::fs::write(&script, r#"
[System.IO.File]::WriteAllText($env:CLIORA_TEST_SSH_LOG, [string]$args[-1])
[Console]::WriteLine('CONTROLLED_SSH_READY')
while ($null -ne ($line = [Console]::ReadLine())) { [Console]::WriteLine('PROCESS_REPLY:' + $line) }
"#).unwrap();
    struct Attachments(Vec<String>);
    impl Drop for Attachments {
        fn drop(&mut self) { for id in &self.0 { let _ = crate::session_host::close(id); } }
    }
    let mut attachments = Attachments(Vec::new());
    let mut names = Vec::new();
    let replay = |id: &str| {
        let encoded = crate::session_host::replay(id).unwrap();
        String::from_utf8_lossy(&base64::engine::general_purpose::STANDARD.decode(encoded).unwrap()).to_string()
    };
    for ordinal in 0..2 {
        let mut plan = plan(&db, &Registry::builtins(), directory.path(), independent_request(&project)).unwrap();
        names.push(plan.remote_session_id.clone().unwrap());
        let log = directory.path().join(format!("ssh-{ordinal}.log"));
        plan.executable = script.clone();
        plan.environment.push(("CLIORA_TEST_SSH_LOG".into(), log.display().to_string()));
        plan.remote_end_args = None; // This executable is a transport fixture, not a real SSH server.
        let started = crate::session_host::start(plan, None).unwrap();
        let id = started.session_id.unwrap();
        attachments.0.push(id.clone());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while !log.exists() || !replay(&id).contains("CONTROLLED_SSH_READY") {
            assert!(std::time::Instant::now() < deadline, "controlled SSH failed to start: {}", replay(&id));
            let _ = crate::session_host::write(&id, &base64::engine::general_purpose::STANDARD.encode(b"\x1b[1;1R"));
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let invoked = std::fs::read_to_string(log).unwrap();
        assert!(invoked.contains(&names[ordinal]));
        assert!(!invoked.contains("new-session -A"));
    }
    assert_ne!(names[0], names[1]);
    crate::session_host::write(&attachments.0[0], &base64::engine::general_purpose::STANDARD.encode(b"only-process-a\r")).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !replay(&attachments.0[0]).contains("PROCESS_REPLY:only-process-a") {
        assert!(std::time::Instant::now() < deadline, "input was not handled by A: {}", replay(&attachments.0[0]));
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    assert!(!replay(&attachments.0[1]).contains("only-process-a"));
}

#[test]
fn restoring_exact_session_preserves_its_original_directory_and_mode_after_project_changes() {
    let (directory, db, mut project) = independent_fixture();
    remember_remote_session(&db, &project.id, "codex", LaunchMode::Normal, "cliora-original").unwrap();
    project.path = "/srv/changed-project".into();
    crate::remote::save_project(&db, project.clone()).unwrap();
    let mut request = independent_request(&project);
    request.mode = LaunchMode::Yolo;
    request.remote_intent = Some(RemoteLaunchIntent::Reattach { remote_session_id: "cliora-original".into() });
    let restored = plan(&db, &Registry::builtins(), directory.path(), request).unwrap();
    assert_eq!(restored.directory, PathBuf::from("/srv/shared"));
    assert_eq!(restored.mode, LaunchMode::Normal);
}
