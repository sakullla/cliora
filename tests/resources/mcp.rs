use super::*;
use std::collections::HashMap;
use std::sync::Mutex;

fn fixture_registry() -> Registry {
    Registry::builtins()
        .with_fixture_installation("codex", "0.158.0")
        .with_fixture_installation("claude_code", "2.1.284")
        .with_fixture_installation("grok", "1.0.41")
        .with_fixture_installation("open_code", "1.18.33")
}

#[derive(Default)]
struct MemoryStore(Mutex<HashMap<String, String>>);
impl CredentialStore for MemoryStore {
    fn put(&self, id: &str, secret: &str) -> Result<(), String> {
        self.0.lock().unwrap().insert(id.into(), secret.into());
        Ok(())
    }
    fn get(&self, id: &str) -> Result<String, String> {
        self.0
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or("missing key".into())
    }
    fn delete(&self, id: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(id);
        Ok(())
    }
}

fn sample(db: &Database) -> McpDefinition {
    save_definition(
        db,
        McpDraft {
            id: None,
            name: "example".into(),
            transport: McpTransport::Stdio,
            command: "npx".into(),
            args: vec!["-y".into(), "example-mcp".into()],
            url: String::new(),
            env: BTreeMap::from([("API_KEY".into(), "${EXAMPLE_KEY}".into())]),
            headers: BTreeMap::new(),
            in_library: true,
            expected_version: None,
        },
    )
    .unwrap()
}

fn target(tool: &str, enabled: bool) -> McpTargetRequest {
    McpTargetRequest { context_id: None,
        tool_id: tool.into(),
        scope: Scope::Global,
        project_path: None,
        enabled,
        baseline_hash: None,
        allow_replace: false,
        preview_token: None,
    }
}

#[test]
fn deepseek_sequence_preview_write_remove_preserves_native_patches() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let registry = Registry::builtins();
    let keys = MemoryStore::default();
    let path = temp.path().join(".dsh/profiles/desktop/cordis.patch.yml");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let original = include_str!("../fixtures/native/dsh-0.2.0-rc.2.yml");
    std::fs::write(&path, original).unwrap();
    let definition = sample(&db);
    let targets = previewed(&db, &registry, temp.path(), &definition.id, vec![target("deepseek", true)]);
    let result = distribute(&db, &keys, &registry, temp.path(), &definition.id, targets);
    assert_eq!(result[0].status, "written", "{:?}", result[0]);
    let entries = list_native(&db, &registry, temp.path(), &target("deepseek", true)).unwrap();
    assert!(entries.iter().any(|entry| entry.name == "example" && entry.command == "npx"));
    let parsed = format::parse(format::FileKind::Yaml, &std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(parsed[0], format::parse(format::FileKind::Yaml, original).unwrap()[0]);
    remove_native(&db, &keys, &registry, temp.path(), &target("deepseek", true), "example").unwrap();
    let remaining = list_native(&db, &registry, temp.path(), &target("deepseek", true)).unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].name, "memory");
}

fn previewed(
    db: &Database,
    registry: &Registry,
    home: &Path,
    id: &str,
    targets: Vec<McpTargetRequest>,
) -> Vec<McpTargetRequest> {
    let preview = preview_targets(db, registry, home, id, targets.clone());
    targets
        .into_iter()
        .zip(preview)
        .map(|(mut request, inspected)| {
            request.baseline_hash = inspected.baseline_hash;
            request.preview_token = inspected.preview_token;
            request
        })
        .collect()
}

#[test]
fn pi_native_mcp_writes_mcp_json_and_keeps_a_disabled_entry() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let keys = MemoryStore::default();
    let registry = fixture_registry();
    let user_file = temp.path().join(".pi/agent/mcp.json");
    std::fs::create_dir_all(user_file.parent().unwrap()).unwrap();
    std::fs::write(&user_file, "{\"theme\":\"quiet\",\"mcpServers\":{\"other\":{\"command\":\"echo\",\"args\":[]}}}").unwrap();
    let definition = sample(&db);
    let preview = preview_targets(&db, &registry, temp.path(), &definition.id, vec![target("pi", true)]);
    assert_eq!(preview[0].status, "ready", "{preview:?}");
    let preview_path = std::path::PathBuf::from(preview[0].path.clone().unwrap());
    assert_eq!(preview_path, user_file, "Pi 全局 MCP 应写到 ~/.pi/agent/mcp.json");
    let written = distribute(
        &db,
        &keys,
        &registry,
        temp.path(),
        &definition.id,
        previewed(&db, &registry, temp.path(), &definition.id, vec![target("pi", true)]),
    );
    assert_eq!(written[0].status, "written", "{written:?}");
    let text = std::fs::read_to_string(&user_file).unwrap();
    assert!(text.contains("\"mcpServers\""));
    assert!(text.contains("\"other\""));
    assert!(text.contains("\"theme\""));
    assert!(text.contains("\"command\": \"npx\""));
    assert!(text.contains("\"type\": \"stdio\""));
    assert!(text.contains("\"enabled\": true"));
    let listed = list_native(&db, &registry, temp.path(), &target("pi", true)).unwrap();
    let example = listed.iter().find(|entry| entry.name == "example").unwrap();
    assert!(example.enabled);
    assert_eq!(example.command, "npx");
    assert!(listed.iter().any(|entry| entry.name == "other"));

    let project = temp.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    let mut project_target = target("pi", true);
    project_target.scope = Scope::Project;
    project_target.project_path = Some(project.display().to_string());
    let project_written = distribute(
        &db,
        &keys,
        &registry,
        temp.path(),
        &definition.id,
        previewed(&db, &registry, temp.path(), &definition.id, vec![project_target]),
    );
    assert_eq!(project_written[0].status, "written", "{project_written:?}");
    assert!(std::fs::read_to_string(project.join(".pi/mcp.json")).unwrap().contains("\"mcpServers\""));

    let disabled = distribute(
        &db,
        &keys,
        &registry,
        temp.path(),
        &definition.id,
        previewed(&db, &registry, temp.path(), &definition.id, vec![target("pi", false)]),
    );
    assert_eq!(disabled[0].status, "written", "{disabled:?}");
    let after = std::fs::read_to_string(&user_file).unwrap();
    assert!(after.contains("\"enabled\": false"));
    assert!(after.contains("\"example\""));
    assert!(!list_native(&db, &registry, temp.path(), &target("pi", true)).unwrap().iter().find(|entry| entry.name == "example").unwrap().enabled);
}

#[test]
fn per_cli_mcp_writes_preserve_other_fields_and_claude_disable_removes_native_entry() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let keys = MemoryStore::default();
    let registry = fixture_registry();
    let codex_path = temp.path().join(".codex/config.toml");
    std::fs::create_dir_all(codex_path.parent().unwrap()).unwrap();
    std::fs::write(
        &codex_path,
        "model = 'gpt-6'\n[mcp_servers.example]\ncommand = 'old'\ncustom = 7\n[mcp_servers.example.env]\nLOG_LEVEL = 'debug'\nAPI_TOKEN = 'literal-fixture'\n",
    )
    .unwrap();
    let opencode_path = temp.path().join(".config/opencode/opencode.json");
    std::fs::create_dir_all(opencode_path.parent().unwrap()).unwrap();
    std::fs::write(
        &opencode_path,
        "{\"mcp\":{\"other\":{\"type\":\"local\",\"command\":[\"echo\"]}}}",
    )
    .unwrap();
    let definition = sample(&db);
    let preview = preview_targets(
        &db,
        &registry,
        temp.path(),
        &definition.id,
        vec![target("codex", true)],
    );
    assert_eq!(preview[0].status, "conflict");
    let mut codex_target = target("codex", true);
    codex_target.baseline_hash = preview[0].baseline_hash.clone();
    codex_target.preview_token = preview[0].preview_token.clone();
    codex_target.allow_replace = true;
    let result = distribute(
        &db,
        &keys,
        &registry,
        temp.path(),
        &definition.id,
        vec![
            codex_target,
            previewed(
                &db,
                &registry,
                temp.path(),
                &definition.id,
                vec![target("claude_code", true)],
            )[0]
            .clone(),
            previewed(
                &db,
                &registry,
                temp.path(),
                &definition.id,
                vec![target("open_code", true)],
            )[0]
            .clone(),
            previewed(
                &db,
                &registry,
                temp.path(),
                &definition.id,
                vec![target("grok", true)],
            )[0]
            .clone(),
        ],
    );
    assert!(
        result.iter().all(|item| item.status == "written"),
        "{result:?}"
    );
    let codex = std::fs::read_to_string(&codex_path).unwrap();
    assert!(codex.contains("model = 'gpt-6'"));
    assert!(codex.contains("custom = 7"));
    assert!(!codex.contains("LOG_LEVEL"));
    assert!(codex.contains("literal-fixture"));
    assert!(codex.contains("enabled = true"));
    let claude = std::fs::read_to_string(temp.path().join(".claude.json")).unwrap();
    assert!(claude.contains("\"mcpServers\""));
    assert!(claude.contains("\"command\": \"npx\""));
    let open_code = std::fs::read_to_string(&opencode_path).unwrap();
    assert!(open_code.contains("\"command\": ["));
    assert!(open_code.contains("\"type\": \"local\""));
    assert!(
        std::fs::read_to_string(temp.path().join(".grok/config.toml"))
            .unwrap()
            .contains("[mcp_servers.example]")
    );
    let entries = list_native(&db, &registry, temp.path(), &target("codex", true)).unwrap();
    assert_eq!(entries[0].name, "example");
    assert_eq!(entries[0].env["API_KEY"], "${EXAMPLE_KEY}");

    let disabled = distribute(
        &db,
        &keys,
        &registry,
        temp.path(),
        &definition.id,
        previewed(
            &db,
            &registry,
            temp.path(),
            &definition.id,
            vec![target("codex", false), target("claude_code", false)],
        ),
    );
    assert!(
        disabled.iter().all(|item| item.status == "written"),
        "{disabled:?}"
    );
    assert!(std::fs::read_to_string(&codex_path)
        .unwrap()
        .contains("enabled = false"));
    assert!(
        list_native(&db, &registry, temp.path(), &target("claude_code", true))
            .unwrap()
            .is_empty()
    );
    assert_eq!(managed_enabled(&db,&definition.id,&target("claude_code",true)).unwrap(),Some(false));
    assert_eq!(
        distribute(
            &db,
            &keys,
            &registry,
            temp.path(),
            &definition.id,
            previewed(
                &db,
                &registry,
                temp.path(),
                &definition.id,
                vec![target("claude_code", true)]
            )
        )[0]
        .status,
        "written"
    );
    assert_eq!(
        list_native(&db, &registry, temp.path(), &target("claude_code", true))
            .unwrap()
            .len(),
        1
    );
    assert_eq!(managed_enabled(&db,&definition.id,&target("claude_code",true)).unwrap(),Some(true));
}

#[test]
fn bearer_environment_reference_is_visible_but_literal_token_is_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let saved = save_definition(
        &db,
        McpDraft {
            id: None,
            name: "remote".into(),
            transport: McpTransport::Http,
            command: String::new(),
            args: Vec::new(),
            url: "https://example.com/mcp".into(),
            env: BTreeMap::new(),
            headers: BTreeMap::from([("Authorization".into(), "Bearer ${API_TOKEN}".into())]),
            in_library: true,
            expected_version: None,
        },
    )
    .unwrap();
    let keys = MemoryStore::default();
    let registry = fixture_registry();
    assert_eq!(
        distribute(
            &db,
            &keys,
            &registry,
            temp.path(),
            &saved.id,
            previewed(
                &db,
                &registry,
                temp.path(),
                &saved.id,
                vec![target("grok", true)]
            )
        )[0]
        .status,
        "written"
    );
    let entries = list_native(&db, &registry, temp.path(), &target("grok", true)).unwrap();
    assert_eq!(entries[0].headers["Authorization"], "Bearer ${API_TOKEN}");
    assert!(!entries[0].protected_values);
    let rejected = save_definition(
        &db,
        McpDraft {
            id: None,
            name: "literal".into(),
            transport: McpTransport::Http,
            command: String::new(),
            args: Vec::new(),
            url: "https://example.com/mcp".into(),
            env: BTreeMap::new(),
            headers: BTreeMap::from([("Authorization".into(), "Bearer plaintext".into())]),
            in_library: true,
            expected_version: None,
        },
    );
    assert!(rejected.is_err());
}

#[test]
fn external_same_name_and_later_modification_require_fresh_explicit_replace() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let keys = MemoryStore::default();
    let registry = fixture_registry();
    let definition = sample(&db);
    let path = temp.path().join(".codex/config.toml");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, "[mcp_servers.example]\ncommand = 'outside'\n").unwrap();
    let denied = distribute(
        &db,
        &keys,
        &registry,
        temp.path(),
        &definition.id,
        vec![target("codex", true)],
    );
    assert_eq!(denied[0].status, "failed");
    assert!(std::fs::read_to_string(&path).unwrap().contains("outside"));
    let preview = preview_targets(
        &db,
        &registry,
        temp.path(),
        &definition.id,
        vec![target("codex", true)],
    );
    let mut confirmed = target("codex", true);
    confirmed.allow_replace = true;
    confirmed.baseline_hash = preview[0].baseline_hash.clone();
    confirmed.preview_token = preview[0].preview_token.clone();
    std::fs::write(&path, "[mcp_servers.example]\ncommand = 'new-outside'\n").unwrap();
    let stale = distribute(
        &db,
        &keys,
        &registry,
        temp.path(),
        &definition.id,
        vec![confirmed.clone()],
    );
    assert_eq!(stale[0].status, "failed");
    assert!(std::fs::read_to_string(&path)
        .unwrap()
        .contains("new-outside"));
    let fresh = preview_targets(
        &db,
        &registry,
        temp.path(),
        &definition.id,
        vec![target("codex", true)],
    );
    confirmed.baseline_hash = fresh[0].baseline_hash.clone();
    confirmed.preview_token = fresh[0].preview_token.clone();
    assert_eq!(
        distribute(
            &db,
            &keys,
            &registry,
            temp.path(),
            &definition.id,
            vec![confirmed]
        )[0]
        .status,
        "written"
    );
    std::fs::write(&path, "[mcp_servers.example]\ncommand = 'changed-again'\n").unwrap();
    assert_eq!(
        distribute(
            &db,
            &keys,
            &registry,
            temp.path(),
            &definition.id,
            vec![target("codex", true)]
        )[0]
        .status,
        "failed"
    );
}

#[test]
fn preview_is_bound_to_definition_version_scope_and_target_content() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let registry = fixture_registry();
    let keys = MemoryStore::default();
    let definition = sample(&db);
    let project = temp.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    let mut request = previewed(
        &db,
        &registry,
        temp.path(),
        &definition.id,
        vec![target("codex", true)],
    )[0]
    .clone();
    request.scope = Scope::Project;
    request.project_path = Some(project.display().to_string());
    assert_eq!(
        distribute(
            &db,
            &keys,
            &registry,
            temp.path(),
            &definition.id,
            vec![request]
        )[0]
        .status,
        "failed"
    );
    let request = previewed(
        &db,
        &registry,
        temp.path(),
        &definition.id,
        vec![target("codex", true)],
    );
    save_definition(
        &db,
        McpDraft {
            id: Some(definition.id.clone()),
            expected_version: Some(definition.version),
            name: definition.name.clone(),
            transport: definition.transport,
            command: "different-command".into(),
            args: definition.args.clone(),
            url: definition.url.clone(),
            env: definition.env.clone(),
            headers: definition.headers.clone(),
            in_library: true,
        },
    )
    .unwrap();
    let rejected = distribute(&db, &keys, &registry, temp.path(), &definition.id, request);
    assert_eq!(rejected[0].status, "failed");
    assert!(rejected[0].detail.contains("预览"));
    assert!(!temp.path().join(".codex/config.toml").exists());
    let fresh = previewed(
        &db,
        &registry,
        temp.path(),
        &definition.id,
        vec![target("codex", true)],
    );
    assert_eq!(
        distribute(&db, &keys, &registry, temp.path(), &definition.id, fresh)[0].status,
        "written"
    );
}

#[test]
fn preview_compares_native_entries_without_exposing_literal_credentials() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let registry = fixture_registry();
    let definition = sample(&db);
    let path = temp.path().join(".codex/config.toml");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, "[mcp_servers.example]\ncommand = 'outside'\n[mcp_servers.example.env]\nAPI_KEY = 'private-token'\n").unwrap();
    let preview = preview_targets(
        &db,
        &registry,
        temp.path(),
        &definition.id,
        vec![target("codex", true)],
    );
    assert_eq!(preview[0].status, "conflict");
    let before = preview[0].existing.as_ref().unwrap();
    let after = preview[0].proposed.as_ref().unwrap();
    assert_eq!(before["command"], "outside");
    assert_eq!(after["command"], "npx");
    let rendered = serde_json::to_string(&preview[0]).unwrap();
    assert!(!rendered.contains("private-token"));
}

#[test]
fn opencode_v2_probe_writes_nested_servers_and_disabled_flag() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let registry = fixture_registry().with_fixture_installation("open_code", "2.1.0");
    let keys = MemoryStore::default();
    let path = temp.path().join(".config/opencode/opencode.json");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, "{\"mcp\":{\"timeout\":{\"startup\":45000}}}").unwrap();
    let definition = sample(&db);
    let first = distribute(
        &db,
        &keys,
        &registry,
        temp.path(),
        &definition.id,
        previewed(
            &db,
            &registry,
            temp.path(),
            &definition.id,
            vec![target("open_code", true)],
        ),
    );
    assert_eq!(first[0].status, "written", "{first:?}");
    let parsed: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(parsed["mcp"]["timeout"]["startup"], 45000);
    assert_eq!(parsed["mcp"]["servers"]["example"]["disabled"], false);
    assert!(parsed["mcp"]["example"].is_null());
    let second = distribute(
        &db,
        &keys,
        &registry,
        temp.path(),
        &definition.id,
        previewed(
            &db,
            &registry,
            temp.path(),
            &definition.id,
            vec![target("open_code", false)],
        ),
    );
    assert_eq!(second[0].status, "written", "{second:?}");
    let parsed: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(parsed["mcp"]["servers"]["example"]["disabled"], true);
}

#[test]
fn one_invalid_target_does_not_prevent_another_and_can_be_retried() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let keys = MemoryStore::default();
    let registry = fixture_registry();
    let grok_path = temp.path().join(".grok/config.toml");
    std::fs::create_dir_all(grok_path.parent().unwrap()).unwrap();
    std::fs::write(&grok_path, "[broken\n").unwrap();
    let definition = sample(&db);
    let result = distribute(
        &db,
        &keys,
        &registry,
        temp.path(),
        &definition.id,
        previewed(
            &db,
            &registry,
            temp.path(),
            &definition.id,
            vec![target("grok", true), target("codex", true)],
        ),
    );
    assert_eq!(result[0].status, "failed");
    assert_eq!(result[1].status, "written");
    assert_eq!(std::fs::read_to_string(&grok_path).unwrap(), "[broken\n");
    std::fs::write(&grok_path, "[ui]\ncompact_mode = true\n").unwrap();
    let retried = distribute(
        &db,
        &keys,
        &registry,
        temp.path(),
        &definition.id,
        previewed(
            &db,
            &registry,
            temp.path(),
            &definition.id,
            vec![target("grok", true)],
        ),
    );
    assert_eq!(retried[0].status, "written");
    assert!(std::fs::read_to_string(&grok_path)
        .unwrap()
        .contains("compact_mode = true"));
}

#[test]
fn deleting_a_definition_checks_version_and_native_removal_keeps_other_entries() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let saved = sample(&db);
    assert!(delete_definition(&db, &saved.id, 0).is_err());
    delete_definition(&db, &saved.id, saved.version).unwrap();
    assert!(get_definition(&db, &saved.id).is_err());

    let registry = fixture_registry();
    let keys = MemoryStore::default();
    let codex_path = temp.path().join(".codex/config.toml");
    std::fs::create_dir_all(codex_path.parent().unwrap()).unwrap();
    std::fs::write(&codex_path, "model = 'gpt-6'\n[mcp_servers.example]\ncommand = 'old'\n[mcp_servers.other]\ncommand = 'stay'\n").unwrap();
    remove_native(&db, &keys, &registry, temp.path(), &target("codex", true), "example").unwrap();
    let text = std::fs::read_to_string(&codex_path).unwrap();
    assert!(!text.contains("[mcp_servers.example]"));
    assert!(text.contains("[mcp_servers.other]"));
    assert!(text.contains("gpt-6"));
}

#[test]
fn pasted_stdio_command_line_is_split_before_a_client_spawns_it() {
    let (command, args) = stdio_command("npx -y chrome-devtools-mcp@latest", &[]);
    assert_eq!(command, "npx");
    assert_eq!(args, ["-y", "chrome-devtools-mcp@latest"]);
    let (command, args) = stdio_command(r#""C:\Program Files\nodejs\npx.cmd" -y pkg"#, &[]);
    assert_eq!(command, r"C:\Program Files\nodejs\npx.cmd");
    assert_eq!(args, ["-y", "pkg"]);
    let (command, args) = stdio_command("npx", &["-y".into(), "pkg".into()]);
    assert_eq!((command.as_str(), args), ("npx", vec!["-y".into(), "pkg".into()]));
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let saved = save_definition(
        &db,
        McpDraft {
            id: None,
            name: "chrome-devtools-mcp".into(),
            transport: McpTransport::Stdio,
            command: "npx -y chrome-devtools-mcp@latest".into(),
            args: vec![],
            url: String::new(),
            env: BTreeMap::new(),
            headers: BTreeMap::new(),
            in_library: true,
            expected_version: None,
        },
    )
    .unwrap();
    assert_eq!(saved.command, "npx");
    assert_eq!(saved.args, ["-y", "chrome-devtools-mcp@latest"]);
}
