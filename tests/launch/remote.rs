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
    assert!(command.contains("tmux -u new-session -d -s"));
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
    let end_args = plan.remote_end_args.as_ref().unwrap();
    assert_eq!(end_args[0], "-T");
    assert!(end_args.last().unwrap().contains("CLIORA_REMOTE_ABSENT:"));
    assert!(!end_args.last().unwrap().ends_with("|| true"));
    let reattach = crate::launch::remote_reattach_command(plan.remote_session_id.as_deref().unwrap());
    assert!(reattach.contains("tmux -u list-sessions"));
    assert!(reattach.contains("tmux -u attach-session"));
    assert!(reattach.contains("COLORTERM=truecolor"));
    assert!(reattach.contains("screen -U -r"));
    assert!(reattach.contains("exit 44"));
}

/// Execute the production shell with function-only muxes. No SSH, tmux server,
/// user configuration, package manager, or persistent fixture files are used.
fn run_remote_mux_shell(command: &str, scenario: &str) -> std::process::Output {
    let shell = format!(r#"
scenario={scenario}
created=0
tmux() {{
    [ "$1" = -u ] || return 90
    shift
    case "$1" in
        new-session) created=1; printf 'NEW\n' ;;
        list-sessions)
            case "$scenario" in
                unknown) echo 'permission denied' >&2; return 1 ;;
                screen|absent) echo cliora-fixture-other ;;
                prefix) echo cliora-fixture-long ;;
                new*) [ "$created" = 1 ] && printf 'cliora-fixture\ncliora-sibling\n' ;;
                *) printf 'cliora-fixture\ncliora-sibling\n' ;;
            esac ;;
        set-option)
            shift
            # Existing unrelated setup is inert. A mouse change must be exact,
            # session-scoped, and must never touch the sibling/global setting.
            if [ "$1" = -g ]; then [ "$2" = status ] || return 91; return 0; fi
            [ "$#" = 4 ] && [ "$1" = -t ] && [ "$2" = =cliora-fixture: ] && [ "$3" = mouse ] && [ "$4" = on ] || return 92
            printf 'MOUSE:=cliora-fixture:on\n'
            [ "$scenario" != setup_failed ] && [ "$scenario" != new_setup_failed ] ;;
        attach-session)
            [ "$#" = 3 ] && [ "$2" = -t ] && [ "$3" = =cliora-fixture ] || return 93
            printf 'ATTACH:=cliora-fixture\n' ;;
        set-window-option|set-environment) return 0 ;;
        *) echo 'unexpected tmux command' >&2; return 94 ;;
    esac
}}
screen() {{
    case "$1" in
        -ls) if [ "$scenario" = screen ]; then printf '123.cliora-fixture (Detached)\n'; else echo 'No Sockets found'; return 1; fi ;;
        -U) [ "$scenario" = screen ] && [ "$2" = -r ] && [ "$3" = cliora-fixture ] || return 95; printf 'SCREEN_ATTACH\n' ;;
        *) return 96 ;;
    esac
}}
{command}
"#);
    run_posix_shell(&shell)
}

fn run_posix_shell(shell: &str) -> std::process::Output {
    use std::io::Write;
    use std::process::{Command, Stdio};
    #[cfg(windows)]
    let mut process = {
        let mut process = Command::new("wsl.exe");
        process.args(["--exec", "sh", "-s"]);
        // Development opt-in below must not open a console window.
        use std::os::windows::process::CommandExt;
        process.creation_flags(0x08000000);
        process
    };
    #[cfg(not(windows))]
    let mut process = {
        let mut process = Command::new("sh");
        process.arg("-s");
        process
    };
    let mut child = process.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    child.stdin.take().unwrap().write_all(shell.as_bytes()).unwrap();
    child.wait_with_output().unwrap()
}

#[test]
#[cfg_attr(windows, ignore = "requires WSL POSIX shell; opt in with --include-ignored")]
fn remote_tmux_mouse_setup_is_exact_and_precedes_ready_on_new_and_reattach() {
    for new in [false, true] {
        let command = if new {
            remote_persistent_command("/srv/fixture", "fixture-cli", &[], "cliora-fixture", Default::default())
        } else {
            remote_reattach_command("cliora-fixture")
        };
        let output = run_remote_mux_shell(&command, if new { "new" } else { "reattach" });
        let stdout = String::from_utf8(output.stdout).unwrap();
        assert!(output.status.success(), "{stdout}: {}", String::from_utf8_lossy(&output.stderr));
        let setup = stdout.find("MOUSE:=cliora-fixture:on").unwrap();
        let ready = stdout.find(";cliora-fixture;ready").unwrap();
        let attach = stdout.find("ATTACH:=cliora-fixture").unwrap();
        assert!(setup < ready && ready < attach, "{stdout}");
        assert_eq!(stdout.matches("MOUSE:").count(), 1, "{stdout}");
        assert_eq!(stdout.contains("NEW"), new, "{stdout}");
        assert!(stdout.contains(";cliora-fixture;disconnected"), "{stdout}");
    }
}

#[test]
#[ignore = "requires local POSIX shell and tmux; opt in with --include-ignored"]
fn remote_generated_commands_use_real_tmux_target_parsing_on_an_isolated_socket() {
    // Optional paths let Windows development use a locally extracted tmux in WSL.
    // No installation, default server, user tmux config, SSH or native app is used.
    let binary = remote_shell_quote(&std::env::var("CLIORA_TEST_TMUX").unwrap_or_else(|_| "tmux".into()));
    let libraries = remote_shell_quote(&std::env::var("CLIORA_TEST_TMUX_LIBRARY_PATH").unwrap_or_default());
    let reattach = remote_reattach_command("cliora-fixture");
    let legacy = reattach.replace("set-option -t '=cliora-fixture:'", "set-option -t '=cliora-fixture'");
    assert_ne!(legacy, reattach, "negative control must reproduce the original target");
    let new = remote_persistent_command("/tmp", "sleep", &["60".into()], "cliora-fixture", Default::default());
    let shell = format!(r#"
set -eu
tmux_bin={binary}
export LD_LIBRARY_PATH={libraries}
unset TMUX TMUX_PANE
task_root=$(mktemp -d /tmp/cliora-launch-tmux-XXXXXX)
socket="$task_root/socket"
export HOME="$task_root/home"
mkdir "$HOME"
cleanup() {{
    "$tmux_bin" -S "$socket" kill-server >/dev/null 2>&1 || :
    if [ -S "$socket" ]; then rm -- "$socket"; fi
    rmdir "$HOME" "$task_root"
}}
trap cleanup EXIT
mux() {{ "$tmux_bin" -f /dev/null -S "$socket" "$@"; }}
tmux() {{
    if [ "$1" = -u ] && [ "$2" = attach-session ]; then
        # Control mode exercises the real attach-session parser and attachment,
        # then detaches immediately without requiring a desktop PTY.
        printf 'detach-client\n' | mux -C "$@"
    else
        mux "$@"
    fi
}}
mux -V
mux new-session -d -s cliora-fixture-long -- sleep 60
mux set-option -g mouse off
mux new-session -d -s cliora-fixture -- sleep 60
if legacy_output=$( ( set +e; {legacy} ) ); then
    echo 'legacy target unexpectedly succeeded' >&2; exit 80
else
    [ "$?" = 46 ] || exit 81
fi
case "$legacy_output" in *';ready'*) exit 82 ;; esac
[ "$(mux show-options -Av -t '=cliora-fixture:' mouse)" = off ]
mux has-session -t '=cliora-fixture'
printf 'LEGACY_FAILED_BEFORE_READY\n'
mux kill-session -t '=cliora-fixture'
new_output=$( ( set +e; {new} ) )
printf 'NEW_RESULT:%s\n' "$new_output"
[ "$(mux show-options -Av -t '=cliora-fixture:' mouse)" = on ]
[ "$(mux show-options -Av -t '=cliora-fixture-long:' mouse)" = off ]
[ "$(mux show-options -gv mouse)" = off ]
mux set-option -t '=cliora-fixture:' mouse off
reattach_output=$( ( set +e; {reattach} ) )
printf 'REATTACH_RESULT:%s\n' "$reattach_output"
[ "$(mux show-options -Av -t '=cliora-fixture:' mouse)" = on ]
[ "$(mux show-options -Av -t '=cliora-fixture-long:' mouse)" = off ]
[ "$(mux show-options -gv mouse)" = off ]
mux kill-session -t '=cliora-fixture'
if missing_output=$( ( set +e; {reattach} ) ); then exit 83; else [ "$?" = 44 ] || exit 84; fi
case "$missing_output" in *';ready'*) exit 85 ;; esac
mux has-session -t '=cliora-fixture-long'
printf 'ISOLATED_TMUX_OK\n'
"#);
    let output = run_posix_shell(&shell);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success(), "{stdout}: {}", String::from_utf8_lossy(&output.stderr));
    assert!(stdout.contains("LEGACY_FAILED_BEFORE_READY") && stdout.contains("ISOLATED_TMUX_OK"), "{stdout}");
    assert_eq!(stdout.matches(";cliora-fixture;ready").count(), 2, "{stdout}");
    assert_eq!(stdout.matches("%session-changed").count(), 2, "{stdout}");
    assert_eq!(stdout.matches(";cliora-fixture;disconnected").count(), 2, "{stdout}");
    assert!(!stdout.contains("%error"), "{stdout}");
}

#[test]
#[cfg_attr(windows, ignore = "requires WSL POSIX shell; opt in with --include-ignored")]
fn remote_tmux_mouse_setup_failure_and_probe_errors_never_attach_or_report_ready() {
    for (scenario, exit, mouse_attempted) in [("setup_failed", 46, true), ("new_setup_failed", 46, true), ("unknown", 46, false), ("absent", 44, false), ("prefix", 44, false)] {
        let new = scenario == "new_setup_failed";
        let command = if new {
            remote_persistent_command("/srv/fixture", "fixture-cli", &[], "cliora-fixture", Default::default())
        } else {
            remote_reattach_command("cliora-fixture")
        };
        let output = run_remote_mux_shell(&command, scenario);
        let stdout = String::from_utf8(output.stdout).unwrap();
        assert_eq!(output.status.code(), Some(exit), "{scenario}: {stdout}");
        assert!(!stdout.contains("ATTACH") && !stdout.contains(";ready"), "{scenario}: {stdout}");
        assert_eq!(stdout.contains("NEW"), new, "{scenario}: {stdout}");
        assert_eq!(stdout.contains("MOUSE:"), mouse_attempted, "{scenario}: {stdout}");
        assert_eq!(stdout.contains(";ended"), exit == 44, "{scenario}: {stdout}");
        assert!(!String::from_utf8_lossy(&output.stderr).contains("unexpected tmux command"), "must not kill or replace the remote session");
    }
    // The screen fallback keeps its own behavior and receives no tmux options.
    let output = run_remote_mux_shell(&remote_reattach_command("cliora-fixture"), "screen");
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(output.status.success(), "{stdout}: {}", String::from_utf8_lossy(&output.stderr));
    assert!(stdout.contains("SCREEN_ATTACH") && stdout.contains(";ready"), "{stdout}");
    assert!(!stdout.contains("MOUSE:"), "{stdout}");
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
        assert!(!command.contains("cliora-existing-a"));
        assert!(command.find("new-session -d -s").unwrap() < command.find("attach-session").unwrap());
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
        fn drop(&mut self) { for id in &self.0 { crate::session_host::detach_for_tests(id); } }
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
