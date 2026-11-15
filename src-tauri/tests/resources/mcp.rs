use super::*;

fn draft() -> McpDraft {
    McpDraft {
        id: None,
        name: "example".into(),
        cwd: String::new(), transport: McpTransport::Stdio,
        command: "npx".into(),
        args: vec!["-y".into(), "example-mcp".into()],
        url: String::new(),
        env: IndexMap::new(),
        headers: IndexMap::new(),
        in_library: true,
        expected_version: None,
    }
}

fn target(tool: &str) -> McpDraftTargetRequest {
    McpDraftTargetRequest {
        operation: McpTargetOperation::Write,
        target: McpTargetRequest {
        context_id: None,
        tool_id: tool.into(),
        scope: Scope::Global,
        project_path: None,
        enabled: true,
        baseline_hash: None,
        allow_replace: false,
        preview_token: None,
        },
    }
}

fn confirmed(
    requests: &[McpDraftTargetRequest],
    preview: &[McpTargetResult],
) -> Vec<McpDraftTargetRequest> {
    requests
        .iter()
        .zip(preview)
        .map(|(request, inspected)| McpDraftTargetRequest {
            target: McpTargetRequest {
                baseline_hash: inspected.baseline_hash.clone(),
                preview_token: inspected.preview_token.clone(),
                context_id: inspected.context_id.clone(),
                ..request.target.clone()
            },
            ..request.clone()
        })
        .collect()
}

fn write_parent(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

struct WorkingStore;
impl CredentialStore for WorkingStore {
    fn put(&self, _id: &str, _secret: &str) -> Result<(), String> { Ok(()) }
    fn get(&self, _id: &str) -> Result<String, String> { Ok("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".into()) }
    fn delete(&self, _id: &str) -> Result<(), String> { Ok(()) }
}

struct FailingStore;
impl CredentialStore for FailingStore {
    fn put(&self, _id: &str, _secret: &str) -> Result<(), String> {
        Ok(())
    }

    fn get(&self, _id: &str) -> Result<String, String> {
        Err("credential unavailable".into())
    }

    fn delete(&self, _id: &str) -> Result<(), String> {
        Ok(())
    }
}

#[test]
fn omp_external_mcp_is_read_only_and_native_names_win() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let registry = Registry::builtins();
    let native = temp.path().join(".omp/agent/mcp.json");
    write_parent(
        &native,
        r#"{"mcpServers":{"shared":{"command":"native"},"bad":{"type":"websocket","url":"https://example.test"}},"disabledServers":["shared"]}"#,
    );
    let external = temp.path().join(".claude/mcp.json");
    write_parent(
        &external,
        r#"{"mcpServers":{"shared":{"command":"external"},"github":{"type":"http","url":"https://example.test/mcp"}}}"#,
    );
    write_parent(
        &temp.path().join(".omp/agent/config.yml"),
        "enabledProviders:\n  - claude\n",
    );
    let store = list_native(&db, &registry, temp.path(), &target("omp").target).unwrap();
    assert!(store.issues.is_empty(), "{:?}", store.issues);
    let entries = store.entries;
    let shared = entries.iter().find(|entry| entry.name == "shared").unwrap();
    assert!(!shared.read_only);
    assert_eq!(shared.command, "native");
    assert!(!shared.enabled, "OMP disabledServers must hide a same-name native entry");
    let github = entries.iter().find(|entry| entry.name == "github").unwrap();
    assert!(github.read_only);
    assert!(github.switchable);
    assert_eq!(github.source.as_deref(), Some("Claude Code"));
    assert!(github.detail.as_deref().unwrap().contains(".claude"));
    // A malformed native entry keeps the valid ones visible and reports its own issue.
    let bad = entries.iter().find(|entry| entry.name == "bad").unwrap();
    assert!(bad.issue.as_deref().unwrap().contains("未知"));
    assert!(!bad.enabled);
}

#[test]
fn external_mcp_toggle_writes_only_the_omp_override_and_reports_source_errors() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let registry = Registry::builtins();
    let native = temp.path().join(".omp/agent/mcp.json");
    write_parent(&native, "{\"mcpServers\":{}}");
    let external = temp.path().join(".claude.json");
    let original = r#"{"mcpServers":{"github":{"type":"http","url":"https://example.test/mcp","headers":{"Authorization":"Bearer literal-secret"}},"tool-owned":{"command":"npx","enabled":false}}}"#;
    write_parent(&external, original);
    write_parent(
        &temp.path().join(".omp/agent/config.yml"),
        "enabledProviders:\n  - claude\n",
    );
    let target = target("omp").target;
    set_external_mcp_enabled(
        &db,
        &WorkingStore,
        &registry,
        temp.path(),
        &target,
        "github",
        false,
    )
    .unwrap();
    let overlay: Value =
        serde_json::from_str(&std::fs::read_to_string(&native).unwrap()).unwrap();
    assert_eq!(overlay["disabledServers"], serde_json::json!(["github"]));
    assert_eq!(std::fs::read_to_string(&external).unwrap(), original);
    assert!(
        !list_native(&db, &registry, temp.path(), &target)
            .unwrap()
            .entries
            .iter()
            .find(|entry| entry.name == "github")
            .unwrap()
            .enabled
    );
    let github = list_native(&db, &registry, temp.path(), &target)
        .unwrap()
        .entries
        .into_iter()
        .find(|entry| entry.name == "github")
        .unwrap();
    assert!(github.protected_values);
    assert!(github.headers.is_empty(), "literal external secrets stay out of the view");

    // An entry disabled by its own provider is force-enabled through the
    // OMP allowlist, never by editing the source file.
    set_external_mcp_enabled(
        &db,
        &WorkingStore,
        &registry,
        temp.path(),
        &target,
        "tool-owned",
        true,
    )
    .unwrap();
    let overlay: Value =
        serde_json::from_str(&std::fs::read_to_string(&native).unwrap()).unwrap();
    assert_eq!(overlay["enabledServers"], serde_json::json!(["tool-owned"]));
    assert_eq!(std::fs::read_to_string(&external).unwrap(), original);

    // A malformed foreign file stays an issue while valid sources remain.
    write_parent(&temp.path().join(".claude/mcp.json"), "{ broken");
    let store = list_native(&db, &registry, temp.path(), &target).unwrap();
    assert!(store.entries.iter().any(|entry| entry.name == "github"));
    assert!(store
        .issues
        .iter()
        .any(|issue| issue.path.ends_with("mcp.json")));
}

#[test]
fn project_mcp_is_reported_and_refused_when_omp_disables_project_config() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let registry = Registry::builtins();
    write_parent(
        &temp.path().join(".omp/agent/config.yml"),
        "mcp:\n  enableProjectConfig: false\n",
    );
    let project = temp.path().join("project");
    let native = project.join(".omp/mcp.json");
    write_parent(&native, "{\"mcpServers\":{\"project-one\":{\"command\":\"npx\"}}}");
    let mut request = target("omp").target;
    request.scope = Scope::Project;
    request.project_path = Some(project.display().to_string());
    let store = list_native(&db, &registry, temp.path(), &request).unwrap();
    let entry = store
        .entries
        .iter()
        .find(|entry| entry.name == "project-one")
        .unwrap();
    assert!(!entry.enabled);
    assert!(entry.issue.as_deref().unwrap().contains("enableProjectConfig=false"));
    assert!(store
        .issues
        .iter()
        .any(|issue| issue.kind == "mcp_project_disabled"));
    let error = set_external_mcp_enabled(
        &db,
        &WorkingStore,
        &registry,
        temp.path(),
        &request,
        "project-one",
        false,
    )
    .unwrap_err();
    assert!(error.contains("enableProjectConfig=false"));
}

#[test]
fn draft_preview_and_cancel_leave_database_and_native_files_untouched() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let registry = Registry::builtins();
    let path = temp.path().join(".pi/agent/mcp.json");
    let original = "{\"theme\":\"quiet\",\"mcpServers\":{}}";
    write_parent(&path, original);

    let preview = preview_draft(
        &db,
        &registry,
        temp.path(),
        draft(),
        vec![target("pi")],
    )
    .unwrap();

    assert!(!preview.definition.id.is_empty());
    assert_eq!(preview.definition.version, 1);
    assert_eq!(preview.targets[0].status, "ready");
    assert!(preview.targets[0].preview_token.is_some());
    assert!(preview.targets[0].baseline_hash.is_some());
    assert!(preview.targets[0].existing.is_none());
    assert!(preview.targets[0].proposed.is_some());
    drop(preview); // Cancel is simply dropping the non-persisted candidate.
    assert!(list_definitions(&db).unwrap().is_empty());
    assert_eq!(std::fs::read_to_string(path).unwrap(), original);
}

#[test]
fn draft_commit_rejects_changed_candidate_baseline_and_context_before_any_write() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let registry = Registry::builtins();
    let path = temp.path().join(".pi/agent/mcp.json");
    let original = "{\"mcpServers\":{\"example\":{\"command\":\"npx\",\"args\":[]}}}";
    write_parent(&path, original);
    let preview = preview_draft(
        &db,
        &registry,
        temp.path(),
        draft(),
        vec![target("pi")],
    )
    .unwrap();
    let requests = confirmed(&[target("pi")], &preview.targets);

    let mut changed = preview.draft.clone();
    changed.command = "changed".into();
    assert!(commit_draft(
        &db,
        &FailingStore,
        &registry,
        temp.path(),
        changed,
        requests.clone(),
    )
    .is_err());

    let mut stale = requests.clone();
    stale[0].target.baseline_hash = Some("stale".into());
    assert!(commit_draft(
        &db,
        &FailingStore,
        &registry,
        temp.path(),
        preview.draft.clone(),
        stale,
    )
    .is_err());

    let mut wrong_context = requests.clone();
    wrong_context[0].target.context_id = Some("changed-context".into());
    assert!(commit_draft(
        &db,
        &FailingStore,
        &registry,
        temp.path(),
        preview.draft.clone(),
        wrong_context,
    )
    .is_err());

    let externally_changed = "{\"mcpServers\":{\"example\":{\"command\":\"outside\",\"args\":[]}}}";
    std::fs::write(&path, externally_changed).unwrap();
    assert!(commit_draft(
        &db,
        &FailingStore,
        &registry,
        temp.path(),
        preview.draft,
        requests,
    )
    .is_err());
    assert!(list_definitions(&db).unwrap().is_empty());
    assert_eq!(std::fs::read_to_string(path).unwrap(), externally_changed);
}

#[test]
fn draft_commit_rejects_an_expired_definition_version_before_native_writes() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let registry = Registry::builtins();
    let path = temp.path().join(".pi/agent/mcp.json");
    let original = "{\"mcpServers\":{}}";
    write_parent(&path, original);
    let existing = save_definition(&db, draft()).unwrap();
    let mut editing = draft();
    editing.id = Some(existing.id.clone());
    editing.expected_version = Some(existing.version);
    let preview = preview_draft(
        &db,
        &registry,
        temp.path(),
        editing,
        vec![target("pi")],
    )
    .unwrap();
    let requests = confirmed(&[target("pi")], &preview.targets);

    let mut external = draft();
    external.id = Some(existing.id.clone());
    external.expected_version = Some(existing.version);
    external.command = "external".into();
    save_definition(&db, external).unwrap();

    assert!(commit_draft(
        &db,
        &FailingStore,
        &registry,
        temp.path(),
        preview.draft,
        requests,
    )
    .is_err());
    assert_eq!(get_definition(&db, &existing.id).unwrap().command, "external");
    assert_eq!(get_definition(&db, &existing.id).unwrap().version, 2);
    assert_eq!(std::fs::read_to_string(path).unwrap(), original);
}

#[test]
fn draft_commit_returns_saved_definition_and_truthful_per_target_results() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let registry = Registry::builtins().with_fixture_installation("codex", "0.158.0");
    let pi_path = temp.path().join(".pi/agent/mcp.json");
    let cursor_path = temp.path().join(".cursor/mcp.json");
    let codex_path = temp.path().join(".codex/config.toml");
    write_parent(&pi_path, "{\"mcpServers\":{}}");
    write_parent(&cursor_path, "{\"mcpServers\":{}}");
    let codex_original = "[mcp_servers.example]\ncommand = \"outside\"\n";
    write_parent(&codex_path, codex_original);
    let requests = vec![
        target("pi"),
        target("cursor"),
        target("not_registered"),
        target("codex"),
    ];
    let preview = preview_draft(
        &db,
        &registry,
        temp.path(),
        draft(),
        requests.clone(),
    )
    .unwrap();
    assert_eq!(preview.targets[2].status, "unsupported");
    assert_eq!(preview.targets[3].status, "conflict");
    let requests = confirmed(&requests, &preview.targets);

    let committed = commit_draft(
        &db,
        &FailingStore,
        &registry,
        temp.path(),
        preview.draft,
        requests,
    )
    .unwrap();

    assert_eq!(committed.definition.version, 1);
    assert_eq!(get_definition(&db, &committed.definition.id).unwrap().name, "example");
    assert_eq!(committed.targets[0].status, "written");
    assert_eq!(committed.targets[1].status, "failed");
    assert!(committed.targets[1].detail.contains("credential unavailable"));
    assert_eq!(committed.targets[2].status, "unsupported");
    assert_eq!(committed.targets[3].status, "conflict");
    assert!(std::fs::read_to_string(pi_path).unwrap().contains("example-mcp"));
    assert_eq!(std::fs::read_to_string(cursor_path).unwrap(), "{\"mcpServers\":{}}");
    assert_eq!(std::fs::read_to_string(codex_path).unwrap(), codex_original);
}

#[test]
fn draft_remove_rejects_external_changes_then_requires_a_fresh_confirmation() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let registry = Registry::builtins();
    let path = temp.path().join(".pi/agent/mcp.json");
    write_parent(&path, "{\"mcpServers\":{}}");
    let existing = save_definition(&db, draft()).unwrap();
    let mut write = target("pi").target;
    let inspected = preview_targets(&db, &registry, temp.path(), &existing.id, vec![write.clone()]);
    write.baseline_hash = inspected[0].baseline_hash.clone();
    write.preview_token = inspected[0].preview_token.clone();
    assert_eq!(distribute(&db, &WorkingStore, &registry, temp.path(), &existing.id, vec![write])[0].status, "written");
    assert_eq!(list_placements(&db).unwrap().len(), 1);

    let mut editing = draft();
    editing.id = Some(existing.id.clone());
    editing.expected_version = Some(existing.version);
    let mut removal = target("pi");
    removal.operation = McpTargetOperation::Remove;
    let preview = preview_draft(&db, &registry, temp.path(), editing.clone(), vec![removal.clone()]).unwrap();
    assert_eq!(preview.targets[0].operation, McpTargetOperation::Remove);
    assert_eq!(preview.targets[0].status, "ready");
    assert!(preview.targets[0].existing.is_some());
    assert!(preview.targets[0].proposed.is_none());
    let requests = confirmed(&[removal.clone()], &preview.targets);

    let externally_changed = "{\"mcpServers\":{\"example\":{\"command\":\"outside\",\"args\":[]}}}";
    std::fs::write(&path, externally_changed).unwrap();
    let error = commit_draft(&db, &WorkingStore, &registry, temp.path(), preview.draft, requests).unwrap_err();
    assert!(error.contains("预览后变化"));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), externally_changed);
    assert_eq!(get_definition(&db, &existing.id).unwrap().version, 1);
    assert_eq!(list_placements(&db).unwrap().len(), 1);

    let fresh = preview_draft(&db, &registry, temp.path(), editing, vec![removal.clone()]).unwrap();
    assert_eq!(fresh.targets[0].status, "conflict");
    let mut confirmed_removal = confirmed(&[removal], &fresh.targets);
    confirmed_removal[0].target.allow_replace = true;
    let committed = commit_draft(&db, &WorkingStore, &registry, temp.path(), fresh.draft, confirmed_removal).unwrap();
    assert_eq!(committed.targets[0].status, "removed", "{:?}", committed.targets[0]);
    assert!(!std::fs::read_to_string(&path).unwrap().contains("example"));
    assert!(list_placements(&db).unwrap().is_empty());
}
