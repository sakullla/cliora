use super::*;
use std::collections::HashMap;
use std::sync::Mutex;

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
            expected_version: None,
        },
    )
    .unwrap()
}

fn target(tool: &str, enabled: bool) -> McpTargetRequest {
    McpTargetRequest {
        tool_id: tool.into(),
        scope: Scope::Global,
        project_path: None,
        enabled,
        baseline_hash: None,
        allow_replace: false,
        preview_token: None,
    }
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
fn unsupported_pi_mcp_is_reported_without_creating_a_fake_native_file() {
    let registry = Registry::builtins();
    let home = tempfile::tempdir().unwrap();
    let db = Database::open(&home.path().join("cliora.db")).unwrap();
    let definition = sample(&db);
    let preview = preview_targets(
        &db,
        &registry,
        home.path(),
        &definition.id,
        vec![target("pi", true)],
    );
    assert_eq!(preview[0].status, "unsupported");
    assert!(preview[0].path.is_none());
}

#[test]
fn per_cli_mcp_writes_preserve_other_fields_and_claude_disable_removes_native_entry() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let keys = MemoryStore::default();
    let registry = Registry::builtins();
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
            expected_version: None,
        },
    )
    .unwrap();
    let keys = MemoryStore::default();
    let registry = Registry::builtins();
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
    let registry = Registry::builtins();
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
    let registry = Registry::builtins();
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
    let registry = Registry::builtins();
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
    let registry = Registry::builtins();
    let keys = MemoryStore::default();
    #[cfg(windows)]
    let executable = temp.path().join("opencode.ps1");
    #[cfg(not(windows))]
    let executable = temp.path().join("opencode");
    #[cfg(windows)]
    std::fs::write(&executable, "Write-Output 'opencode 2.1.0'\n").unwrap();
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(&executable, "#!/bin/sh\necho 'opencode 2.1.0'\n").unwrap();
        let mut mode = std::fs::metadata(&executable).unwrap().permissions();
        mode.set_mode(0o755);
        std::fs::set_permissions(&executable, mode).unwrap();
    }
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO installation_choices (tool, path) VALUES ('open_code', ?1)",
            [executable.display().to_string()],
        )
        .map_err(|error| error.to_string())?;
        Ok(())
    })
    .unwrap();
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
    let registry = Registry::builtins();
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
