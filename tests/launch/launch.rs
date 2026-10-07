use super::*;
use std::collections::BTreeMap;
use std::collections::HashMap;

#[test]
fn cmd_launch_rejects_oversized_commands_without_truncating_other_terminals() {
    let mut plan = sample(TerminalId::Cmd);
    plan.cli_args = vec!["x".repeat(4000)];
    assert!(terminal_command(&plan, None).unwrap_err().contains("CMD 长度限制"));
    assert!(shell_terminal(TerminalId::Cmd, &plan.directory, &"x".repeat(4000)).unwrap_err().contains("CMD 长度限制"));
    plan.terminal = TerminalId::PowerShell;
    assert!(terminal_command(&plan, None).is_ok());
}

#[cfg(windows)]
#[test]
fn cmd_runs_literal_arguments_in_project_and_retains_saved_selection() {
    use std::os::windows::process::CommandExt;
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join("中文 project [one] & ! %PATH%");
    std::fs::create_dir(&directory).unwrap();
    let cli = directory.join("test cli's.ps1");
    std::fs::write(&cli, "[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); @{ arguments = @($args); directory = $PWD.Path; marker = $env:CLIORA_TEST_SESSION; color = $env:NO_COLOR } | ConvertTo-Json -Compress\n").unwrap();
    let mut plan = sample(TerminalId::Cmd);
    plan.directory = directory.clone();
    plan.executable = cli;
    plan.session_markers = &["CLIORA_TEST_SESSION"];
    plan.cli_args = vec!["--resume".into(), "会话 'one' %PATH% ! & \"quote\"".into(), "$(New-Item unwanted)\nline two".into()];
    let terminal = terminal_command(&plan, None).unwrap();
    let (program, line) = console_command_line(&terminal).unwrap();
    let prefix = format!("\"{}\" ", terminal_path(&program).unwrap());
    // Use the same /S quoting as the real console, but exit after the fixture.
    let raw_args = line.strip_prefix(&prefix).unwrap().replacen("/S /K ", "/S /C ", 1);
    let output = crate::background_process::command(&program).raw_arg(raw_args)
        .current_dir(&directory).env("CLIORA_TEST_SESSION", "nested").env("NO_COLOR", "1").output().unwrap();
    assert!(output.status.success(), "CMD failed: {}", String::from_utf8_lossy(&output.stderr));
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["arguments"], serde_json::json!(plan.cli_args));
    assert_eq!(value["directory"], directory.to_str().unwrap());
    assert!(value["marker"].is_null());
    assert!(value["color"].is_null());
    assert!(!directory.join("unwanted").exists());
    let copy = native_command(&plan).unwrap();
    assert!(copy.contains("-EncodedCommand"));
    assert!(!copy.contains("New-Item"));
    let copied = crate::background_process::command(&program).raw_arg(format!("/D /V:OFF /S /C \"{copy}\""))
        .current_dir(&directory).output().unwrap();
    assert!(copied.status.success());
    let copied: serde_json::Value = serde_json::from_slice(&copied.stdout).unwrap();
    assert_eq!(copied["arguments"], value["arguments"]);
    let db_path = temp.path().join("app.db");
    let db = Database::open(&db_path).unwrap();
    assert!(terminal_options().iter().any(|option| option.id == TerminalId::Cmd && option.available));
    assert_eq!(set_terminal(&db, TerminalId::Cmd).unwrap().selected, TerminalId::Cmd);
    set_default_mode(&db, "cli", LaunchMode::Yolo).unwrap();
    drop(db);
    let db = Database::open(&db_path).unwrap();
    assert_eq!(selected_terminal(&db).unwrap(), TerminalId::Cmd);
    assert_eq!(settings(&db).unwrap().cli_mode, LaunchMode::Yolo);
}

#[cfg(windows)]
#[test]
fn cmd_package_managers_and_extensionless_shims_use_windows_entrypoints() {
    use std::os::windows::process::CommandExt;
    let temp = tempfile::tempdir().unwrap();
    for name in ["npm", "npx"] {
        std::fs::write(temp.path().join(name), "#!/bin/sh\nexit 99\n").unwrap();
        std::fs::write(temp.path().join(format!("{name}.ps1")), "throw 'wrong entrypoint'\n").unwrap();
        std::fs::write(temp.path().join(format!("{name}.cmd")), format!("@echo off\r\necho {name}-batch:%~1\r\n")).unwrap();
    }
    let script = cmd_helper_script("npm --version; npx --version", &[temp.path().to_path_buf()]);
    let terminal = shell_terminal(TerminalId::Cmd, temp.path(), &script).unwrap();
    let (program, line) = console_command_line(&terminal).unwrap();
    let prefix = format!("\"{}\" ", terminal_path(&program).unwrap());
    let raw_args = line.strip_prefix(&prefix).unwrap().replacen("/S /K ", "/S /C ", 1);
    let output = crate::background_process::command(&program).raw_arg(raw_args).current_dir(temp.path()).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("npm-batch:--version"));
    assert!(stdout.contains("npx-batch:--version"));
    let mut plan = sample(TerminalId::Cmd);
    plan.executable = temp.path().join("npm");
    plan.directory = temp.path().into();
    plan.cli_args = vec!["--version".into()];
    let script = powershell_script(&plan, None).unwrap();
    let output = crate::background_process::command(system_console_path(TerminalId::PowerShell).unwrap())
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", &encoded_powershell(&script)]).output().unwrap();
    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("npm-batch:--version"));
    std::fs::write(temp.path().join("npm.bat"), "@echo off\r\necho bat-entry\r\n").unwrap();
    std::fs::remove_file(temp.path().join("npm.cmd")).unwrap();
    assert_eq!(windows_cli_path(&plan.executable), temp.path().join("npm.bat"));
}

#[cfg(windows)]
#[test]
fn browser_bridge_streams_url_opens_once_and_rejects_untrusted_output() {
    let temp = tempfile::tempdir().unwrap();
    let receipt = temp.path().join("url.txt");
    let native = "& { Write-Output 'Go to: https://evil.test/oauth/authorize'; Write-Output 'Go to: https://auth.openai.com/oauth/authorize?state=synthetic'; Write-Output 'Go to: https://auth.openai.com/oauth/authorize?state=second' }";
    let bridge = browser_login_invocation(native, "https://auth.openai.com/oauth/authorize", &receipt).unwrap();
    let count = temp.path().join("opened.txt");
    let script = format!("function Start-Process {{ param($FilePath, $ErrorAction); Add-Content -LiteralPath {} -Value 'opened' }}; {bridge}", quote_powershell(count.to_str().unwrap()));
    let result = crate::background_process::command("powershell.exe").args(["-NoProfile", "-Command", &script]).output().unwrap();
    assert!(result.status.success(), "browser bridge failed");
    assert_eq!(std::fs::read_to_string(&receipt).unwrap().trim().trim_start_matches('\u{feff}'), "https://auth.openai.com/oauth/authorize?state=synthetic");
    assert_eq!(std::fs::read_to_string(count).unwrap().lines().count(), 1);
}

#[test]
fn macos_terminal_receives_path_directory_and_escaped_cli_arguments() {
    let mut plan = sample(TerminalId::MacTerminal);
    plan.directory = PathBuf::from("/Users/test/项目 'one'");
    plan.executable = PathBuf::from("/Users/test/.nvm/bin/codex");
    plan.cli_args = vec!["prompt with \"quotes\", \\slashes and\nnewlines $(touch unwanted)".into()];
    let terminal = terminal_command(&plan, None).unwrap();
    assert_eq!(terminal.program, "/usr/bin/open");
    assert_eq!(terminal.args, ["-a", "Terminal"]);
    let script = terminal.mac_script.unwrap();
    assert!(script.contains("export PATH="));
    assert!(script.contains("cd -- '/Users/test/项目 '\"'\"'one'\"'\"''"));
    assert!(script.contains("prompt with \"quotes\", \\slashes and\nnewlines $(touch unwanted)"));
    assert!(!script.contains("tell application"));
    assert!(terminal.args.iter().all(|arg| !arg.contains("do script") && arg.len() < 1024));
    let maintenance = shell_terminal(TerminalId::MacTerminal, &plan.directory, "npm install -g example").unwrap();
    let maintenance = maintenance.mac_script.unwrap();
    assert!(maintenance.contains("export PATH="));
    assert!(maintenance.contains("cd -- "));
    assert!(maintenance.contains("&& npm install -g example"));
}

#[test]
fn custom_terminal_keeps_one_script_placeholder_and_presets_are_templates() {
    let temp = tempfile::tempdir().unwrap();
    let program = temp.path().join("terminal");
    std::fs::write(&program, "").unwrap();
    let missing = normalize_custom(program.to_str().unwrap(), &["--flag".into()]).unwrap_err();
    assert!(missing.contains("{script}"));
    let command = normalize_custom(program.to_str().unwrap(), &["--flag".into(), "{script}".into()]).unwrap();
    assert_eq!(command.args, ["--flag", "{script}"]);
    let expanded: Vec<_> = command.args.iter().map(|arg| if arg == "{script}" { "/tmp/cliora launch.command".to_owned() } else { arg.clone() }).collect();
    assert_eq!(expanded, ["--flag".to_owned(), "/tmp/cliora launch.command".to_owned()]);
    let presets = terminal_presets();
    assert!(presets.iter().all(|preset| preset.args.iter().filter(|arg| arg.as_str() == "{script}").count() == 1));
    let mut plan = sample(TerminalId::Custom);
    plan.cli_args = vec!["y".repeat(2000)];
    let terminal = terminal_command(&plan, None).unwrap();
    assert!(terminal.args.iter().map(String::len).sum::<usize>() < 1024);
    assert!(terminal.mac_script.unwrap().contains(&"y".repeat(2000)));
}

#[test]
fn macos_launch_keeps_long_commands_out_of_the_tty_input_buffer() {
    let mut plan = sample(TerminalId::MacTerminal);
    plan.cli_args = vec!["resume".into(), "x".repeat(2000)];
    let terminal = terminal_command(&plan, None).unwrap();
    let script = terminal.mac_script.unwrap();
    assert!(script.contains(&"x".repeat(2000)));
    assert!(terminal.args.iter().map(String::len).sum::<usize>() < 1024);
    assert!(!format!("{:?}", terminal.args).contains("do script"));
}

#[cfg(target_os = "macos")]
#[test]
fn macos_launch_script_runs_in_the_original_directory_with_literal_arguments() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join("项目 with 'quotes' and spaces");
    std::fs::create_dir(&directory).unwrap();
    let executable = temp.path().join("test cli");
    std::fs::write(&executable, "#!/bin/sh\nprintf '%s\\0' \"$PWD\" \"$@\"\n").unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let plan = LaunchPlan {
        account_version: None,
        account_context: None,
        directory: directory.canonicalize().unwrap(),
        executable,
        cli_args: vec!["--resume".into(), "session 'one'".into(), "\"quote\" \\slash\nnewline $(touch unwanted)".into()],
        ..sample(TerminalId::MacTerminal)
    };
    let terminal = terminal_command(&plan, None).unwrap();
    let script = terminal.mac_script.unwrap();
    let output = Command::new("/bin/sh").args(["-c", &script])
        .env_clear().env("PATH", "/usr/bin:/bin").output().unwrap();
    assert!(output.status.success(), "{:?}", output.stderr);
    let fields: Vec<_> = output.stdout.split(|byte| *byte == 0).collect();
    assert_eq!(fields[0], plan.directory.to_str().unwrap().as_bytes());
    for (index, arg) in plan.cli_args.iter().enumerate() {
        assert_eq!(fields[index + 1], arg.as_bytes());
    }
    assert!(!plan.directory.join("unwanted").exists());
}

#[test]
fn macos_terminal_denial_is_an_error_and_does_not_echo_private_commands() {
    assert!(mac_terminal_result(true, "").is_ok());
    let denied = mac_terminal_result(false, "Not authorized to send Apple events to Terminal. (-1743)").unwrap_err();
    assert!(denied.contains("自动化"));
    let failed = mac_terminal_result(false, "private initial prompt in an AppleScript error").unwrap_err();
    assert!(!failed.contains("private initial prompt"));
}

fn sample(terminal: TerminalId) -> LaunchPlan {
    LaunchPlan {
        account_version: None,
        account_context: None,
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
        session_markers: &[],
        credential: None,
    }
}

#[test]
fn terminal_plans_quote_unicode_spaces_and_shell_metacharacters_as_data() {
    let ps = terminal_command(&sample(TerminalId::PowerShell), None).unwrap();
    let command = ps.args.last().unwrap();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(command)
        .unwrap();
    let command = String::from_utf16(
        &bytes
            .chunks_exact(2)
            .map(|v| u16::from_le_bytes([v[0], v[1]]))
            .collect::<Vec<_>>(),
    )
    .unwrap();
    assert!(command.contains("Set-Location -LiteralPath 'C:/用户/我的 project [one]'"));
    assert!(command.contains("& 'C:/Program Files/工具''s cli/grok.ps1'"));
    assert!(command.contains("'会话 ''1'''"));
    assert!(command.contains("'模型 A'"));
    assert!(command.contains("Remove-Item Env:NO_COLOR"));
    assert!(command.contains("$env:TERM -eq 'dumb'"));
    assert!(!command.contains("CLAUDE_CODE_CHILD_SESSION"));
    let shell = terminal_command(&sample(TerminalId::GnomeTerminal), None).unwrap();
    let command = shell.args.last().unwrap();
    assert!(command.contains("unset NO_COLOR"));
    assert!(!command.contains("CLAUDE_CODE_CHILD_SESSION"));
    let registry = Registry::builtins();
    let markers = registry.get("claude_code").unwrap().session_env_markers();
    assert!(markers.contains(&"CLAUDE_CODE_CHILD_SESSION"));
    let mut claude = sample(TerminalId::PowerShell);
    claude.tool_id = "claude_code".into();
    claude.session_markers = markers;
    let claude_ps = terminal_command(&claude, None).unwrap();
    let bytes = base64::engine::general_purpose::STANDARD.decode(claude_ps.args.last().unwrap()).unwrap();
    let decoded = String::from_utf16(&bytes.chunks_exact(2).map(|value| u16::from_le_bytes([value[0], value[1]])).collect::<Vec<_>>()).unwrap();
    assert!(decoded.contains("'CLAUDE_CODE_CHILD_SESSION'"));
    assert!(decoded.contains("Remove-Item -LiteralPath \"Env:$name\""));
    assert_eq!(claude_ps.session_markers, markers);
    let mut claude_sh = sample(TerminalId::GnomeTerminal);
    claude_sh.session_markers = markers;
    let claude_shell = terminal_command(&claude_sh, None).unwrap();
    assert!(claude_shell.args.last().unwrap().contains("unset CLAUDECODE CLAUDE_CODE_CHILD_SESSION"));
    let maintenance = shell_terminal(TerminalId::PowerShell, Path::new("C:/Users/me"), "irm https://chatgpt.com/codex/install.ps1 | iex").unwrap();
    let encoded = maintenance.args.last().unwrap();
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).unwrap();
    let decoded = String::from_utf16(&bytes.chunks_exact(2).map(|value| u16::from_le_bytes([value[0], value[1]])).collect::<Vec<_>>()).unwrap();
    assert_eq!(decoded, "irm https://chatgpt.com/codex/install.ps1 | iex");
    assert!(command.contains("cd -- 'C:/用户/我的 project [one]'"));
    assert!(command.contains("'C:/Program Files/工具'\"'\"'s cli/grok.ps1'"));
    assert!(command.contains("'会话 '\"'\"'1'\"'\"''"));
}

#[test]
fn launch_mode_and_project_model_are_adapter_capabilities() {
    let registry = Registry::builtins();
    let grok = registry.get("grok").unwrap();
    assert!(grok.supports_project_model_override());
    assert!(grok.project_model_args(Some(" ")).is_err());
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
            directory: None,
            initial_prompt: None,
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
            directory: None,
            initial_prompt: None,
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
            directory: None,
            initial_prompt: None,
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
            directory: None,
            initial_prompt: None,
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
        directory: None,
            initial_prompt: None,
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
            directory: None,
            initial_prompt: None,
            mode: LaunchMode::Yolo,
        },
    )
    .unwrap();
    assert_eq!(planned.directory, project_path.canonicalize().unwrap());
    assert_eq!(
        planned.cli_args,
        ["--resume", "session 1", "--yolo", "-m", "grok-4.7"]
    );
    let command = terminal_command(&planned, None).unwrap();
    assert_eq!(
        command.directory,
        PathBuf::from(terminal_path(&planned.directory).unwrap())
    );
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
            directory: None,
            initial_prompt: None,
            mode: LaunchMode::Normal,
        },
    )
    .unwrap_err();
    assert_eq!(failure.stage, LaunchStage::Terminal);
}

#[test]
fn default_launch_modes_start_normal_and_save_cli_and_project_separately() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("app.db")).unwrap();
    let initial = settings(&db).unwrap();
    assert_eq!(initial.cli_mode, LaunchMode::Normal);
    assert_eq!(initial.project_mode, LaunchMode::Normal);
    let cli = set_default_mode(&db, "cli", LaunchMode::Yolo).unwrap();
    assert_eq!(cli.cli_mode, LaunchMode::Yolo);
    assert_eq!(cli.project_mode, LaunchMode::Normal);
    let both = set_default_mode(&db, "project", LaunchMode::Yolo).unwrap();
    assert_eq!(both.cli_mode, LaunchMode::Yolo);
    assert_eq!(both.project_mode, LaunchMode::Yolo);
    assert!(set_default_mode(&db, "tray", LaunchMode::Yolo).is_err());
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES ('default_launch_modes', '\"nope\"')
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [],
        )
        .map_err(|error| error.to_string())?;
        Ok(())
    })
    .unwrap();
    assert!(settings(&db).unwrap_err().contains("默认启动模式格式无法识别"));
}

struct MemoryCredentialStore(HashMap<String, String>);
impl CredentialStore for MemoryCredentialStore {
    fn put(&self, _: &str, _: &str) -> Result<(), String> {
        unreachable!()
    }
    fn get(&self, id: &str) -> Result<String, String> {
        self.0.get(id).cloned().ok_or("missing".into())
    }
    fn delete(&self, _: &str) -> Result<(), String> {
        unreachable!()
    }
}

fn registered_profile(
    tool: &str,
    secret_ref: Option<&str>,
) -> crate::native::profile::RegisteredProfile {
    crate::native::profile::RegisteredProfile {
        editing: None,
        id: format!("{tool}-profile"),
        tool: tool.into(),
        name: "测试".into(),
        version: 1,
        revision: String::new(),
        inherit_common: false,
        files: BTreeMap::new(),
        suppressed: BTreeMap::new(),
        authentication: crate::native::profile::ProfileAuthentication::ApiKey,
        connection: secret_ref.map(|id| crate::native::profile::Connection {
            provider_id: "official".into(),
            interface_format: "openai_responses".into(),
            base_url: "https://example.test/v1".into(),
            model: "model".into(),
            secret_ref: Some(id.into()),
            auth_env_var: None,
            model_records: Vec::new(),
        }),
        native_credentials: BTreeMap::new(),
    }
}

fn insert_applied_binding(db: &Database, tool: &str, key: &str, secret_ref: Option<&str>) {
    let profile = registered_profile(tool, secret_ref);
    let snapshot = serde_json::to_string(&crate::native::apply::AppliedProfileSnapshot {
        source_profile: profile.clone(),
        runtime_profile: profile,
        model_summary: None,
    })
    .unwrap();
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO applied_bindings (scope_key, tool, profile_id, profile_version, managed, context_id, applied_profile) VALUES (?1, ?2, ?3, 1, '{}', NULL, ?4)",
            params![key, tool, format!("{tool}-profile"), snapshot],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
    })
    .unwrap();
}

#[test]
fn launch_credential_port_is_gated_to_env_channel_adapters() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("app.db")).unwrap();
    let registry = Registry::builtins();
    let reference = "connection-00000000-0000-4000-8000-000000000011";
    insert_applied_binding(&db, "kiro", "global", Some(reference));
    insert_applied_binding(&db, "codex", "global", Some(reference));
    insert_applied_binding(&db, "cline", "global", Some(reference));
    let kiro = registry.get("kiro").unwrap();
    let resolved =
        launch_credential_binding(&db, kiro, "kiro", Scope::Global, temp.path())
            .unwrap()
            .unwrap();
    assert_eq!(resolved.env_name, "KIRO_API_KEY");
    assert_eq!(resolved.secret_ref, reference);
    // A project-scoped launch falls back to the globally applied key.
    let project = temp.path().join("project");
    std::fs::create_dir(&project).unwrap();
    assert_eq!(
        launch_credential_binding(&db, kiro, "kiro", Scope::Project, &project)
            .unwrap()
            .as_ref(),
        Some(&resolved)
    );
    // File-channel adapters (the legacy enum five included) stay unchanged.
    let codex = registry.get("codex").unwrap();
    assert!(
        launch_credential_binding(&db, codex, "codex", Scope::Global, temp.path())
            .unwrap()
            .is_none()
    );
    // Tools without a managed env key are unchanged.
    let cline = registry.get("cline").unwrap();
    assert!(
        launch_credential_binding(&db, cline, "cline", Scope::Global, temp.path())
            .unwrap()
            .is_none()
    );
    // No applied binding means no credential and no launch failure.
    let antigravity = registry.get("antigravity").unwrap();
    assert!(
        launch_credential_binding(&db, antigravity, "antigravity", Scope::Global, temp.path())
            .unwrap()
            .is_none()
    );
}

#[test]
fn credential_value_resolves_at_spawn_time_and_never_enters_the_plan() {
    let reference = "connection-00000000-0000-4000-8000-000000000012";
    let store =
        MemoryCredentialStore(HashMap::from([(reference.into(), "gemini-test-31".into())]));
    let mut plan = sample(TerminalId::PowerShell);
    assert_eq!(resolve_credential(&plan, &store).unwrap(), None);
    plan.credential = Some(LaunchCredential {
        env_name: "GEMINI_API_KEY".into(),
        secret_ref: reference.into(),
    });
    assert_eq!(
        resolve_credential(&plan, &store).unwrap(),
        Some(("GEMINI_API_KEY".into(), "gemini-test-31".into()))
    );
    // The plan carries only the adapter-owned name and store reference.
    assert!(!format!("{plan:?}").contains("gemini-test-31"));
    let missing = MemoryCredentialStore(HashMap::new());
    assert!(resolve_credential(&plan, &missing)
        .unwrap_err()
        .contains("重新保存"));
}

fn decode_encoded_command(encoded: &str) -> String {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .unwrap();
    String::from_utf16(
        &bytes
            .chunks_exact(2)
            .map(|value| u16::from_le_bytes([value[0], value[1]]))
            .collect::<Vec<_>>(),
    )
    .unwrap()
}

#[test]
fn terminal_scripts_carry_the_resolved_key_but_copyable_commands_do_not() {
    let credential = ("KIRO_API_KEY".to_owned(), "ksk-test-917".to_owned());
    let plan = sample(TerminalId::PowerShell);
    let ps = terminal_command(&plan, Some(&credential)).unwrap();
    let decoded = decode_encoded_command(ps.args.last().unwrap());
    assert!(decoded.contains("$env:KIRO_API_KEY = 'ksk-test-917'"));
    let shell = terminal_command(&sample(TerminalId::GnomeTerminal), Some(&credential)).unwrap();
    assert!(shell
        .args
        .last()
        .unwrap()
        .contains("export KIRO_API_KEY='ksk-test-917'"));
    // Without a planned credential the script is byte-identical to before.
    let plain = terminal_command(&plan, None).unwrap();
    assert!(!decode_encoded_command(plain.args.last().unwrap()).contains("ksk-test-917"));
    // The copyable resume command never embeds the stored key.
    let copy = native_command(&plan).unwrap();
    assert!(!copy.contains("ksk-test-917"));
}

#[cfg(windows)]
#[test]
fn windows_child_process_environment_receives_the_resolved_credential() {
    let temp = tempfile::tempdir().unwrap();
    let cli = temp.path().join("cli.ps1");
    std::fs::write(
        &cli,
        "[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); Write-Output \"key=$env:CLIORA_TEST_LAUNCH_KEY\"\n",
    )
    .unwrap();
    let mut plan = sample(TerminalId::PowerShell);
    plan.executable = cli;
    plan.directory = temp.path().to_path_buf();
    plan.cli_args.clear();
    let credential = (
        "CLIORA_TEST_LAUNCH_KEY".to_owned(),
        "ksk-test-917".to_owned(),
    );
    let script = powershell_script(&plan, Some(&credential)).unwrap();
    let output = crate::background_process::command(system_console_path(TerminalId::PowerShell).unwrap())
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", &encoded_powershell(&script)])
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    assert!(String::from_utf8_lossy(&output.stdout).contains("key=ksk-test-917"));
}
