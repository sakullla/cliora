use super::*;
use std::collections::HashMap;
#[derive(Default)]
struct MemoryStore(Mutex<HashMap<String, String>>);
impl CredentialStore for MemoryStore {
    fn put(&self, id: &str, value: &str) -> Result<(), String> {
        self.0.lock().unwrap().insert(id.into(), value.into());
        Ok(())
    }
    fn get(&self, id: &str) -> Result<String, String> {
        self.0
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or("missing".into())
    }
    fn delete(&self, id: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(id);
        Ok(())
    }
}
fn target(tool: &str) -> PluginTarget {
    PluginTarget {
        tool_id: tool.into(),
        scope: Scope::Global,
        project_path: None,
        context_id: None,
    }
}
fn request(tool: &str, action: &str, source: &str) -> PluginRequest {
    PluginRequest {
        target: target(tool),
        action: action.into(),
        source: source.into(),
        baseline: String::new(),
        trusted: true,
    }
}

#[test]
fn command_contract_does_not_invent_cross_cli_parity() {
    assert_eq!(
        adapters::plugins::command_args("claude_code", "disable", "x@m", true).unwrap(),
        ["plugin", "disable", "x@m", "--scope", "project", "--json"]
    );
    assert_eq!(
        adapters::plugins::command_args("grok", "install", "owner/repo@v1", false).unwrap(),
        ["plugin", "install", "owner/repo@v1", "--trust"]
    );
    assert_eq!(
        adapters::plugins::command_args("pi", "update", "npm:example", false).unwrap(),
        ["update", "--extension", "npm:example", "--no-approve"]
    );
    assert!(adapters::plugins::command_args("codex", "update", "x@m", false).is_err());
    assert!(adapters::plugins::command_args("grok", "install", "x", true).is_err());
    assert!(adapters::plugins::command_args("pi", "update", "x", true).is_err());
    assert!(adapters::plugins::command_args("claude_code", "install", "--yes", false).is_err());
}
#[test]
fn native_list_policy_and_scope_are_preserved() {
    let entries = parse_list("codex", &json!({"installed":[{"pluginId":"x@m","enabled":true,"version":"1","installPolicy":"REQUIRED"}]}), &target("codex")).unwrap();
    assert!(entries[0].read_only);
    assert_eq!(entries[0].enabled, Some(true));
    assert!(parse_list("grok", &json!({"unknown":[]}), &target("grok")).is_err());
    let rows = json!([{"id":"x@m","scope":"user","enabled":true},{"id":"x@m","scope":"project","projectPath":"/fixture/a","enabled":false},{"id":"managed@m","scope":"managed"}]);
    let global = parse_list("claude_code", &rows, &target("claude_code")).unwrap();
    assert_eq!(global.len(), 2);
    assert!(global[1].read_only);
    let mut project = target("claude_code");
    project.scope = Scope::Project;
    project.project_path = Some("/fixture/a".into());
    let project = parse_list("claude_code", &rows, &project).unwrap();
    assert_eq!(project.len(), 1);
    assert_eq!(project[0].enabled, Some(false));
    let mut other = target("claude_code");
    other.scope = Scope::Project;
    other.project_path = Some("/fixture/b".into());
    assert!(
        parse_list("claude_code", &rows, &other).unwrap().is_empty(),
        "native list includes other project installations; do not expose them for mutation"
    );
}
#[test]
fn config_disable_restore_preserves_filters_unknown_fields_and_context() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let db = Database::open(&home.join("data.sqlite")).unwrap();
    let credentials = MemoryStore::default();
    let path = home.join(".pi/agent/settings.json");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let original = json!({"customFuture":{"on":true},"packages":[{"source":"npm:fixture@1","extensions":["!old.ts"],"skills":[],"future":42},"npm:another"]});
    fs::write(&path, serde_json::to_string(&original).unwrap()).unwrap();
    mutate_config(
        &db,
        &credentials,
        home,
        &request("pi", "disable", "npm:fixture@1"),
    )
    .unwrap();
    let entries = config_entries(&db, home, &target("pi")).unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].enabled, Some(false));
    let disabled_file: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(disabled_file["packages"][0]["extensions"], json!([]));
    assert_eq!(disabled_file["packages"][0]["themes"], json!([]));
    assert_eq!(disabled_file["packages"][0]["future"], 42);
    let mut other = target("pi");
    other.context_id = Some("different-account".into());
    assert!(disabled(&db, &other).unwrap().is_empty());
    mutate_config(
        &db,
        &credentials,
        home,
        &request("pi", "enable", "npm:fixture@1"),
    )
    .unwrap();
    let restored: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(restored["customFuture"], original["customFuture"]);
    assert_eq!(restored["packages"][0], original["packages"][0]);
    assert!(disabled(&db, &target("pi")).unwrap().is_empty());
}
#[test]
fn codex_switch_preserves_native_fields() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let db = Database::open(&home.join("db")).unwrap();
    // enter explicit context so a developer's CODEX_HOME cannot influence fixture.
    let root = home.join("codex");
    fs::create_dir_all(&root).unwrap();
    let context = crate::accounts::NativeContext {
        id: "fixture".into(),
        tool_id: "codex".into(),
        root: root.clone(),
        config_root: root.clone(),
        auth_files: vec![],
        history_roots: vec![],
        resource_root: root.clone(),
        environment: Default::default(),
        remove_environment: vec![],
        cli_args: vec![],
    };
    let _context = selection::enter(Some(context));
    fs::write(
        root.join("config.toml"),
        "model = 'keep'\n[plugins.\"x@m\"]\nenabled = true\nfuture = 42\n",
    )
    .unwrap();
    mutate_config(
        &db,
        &MemoryStore::default(),
        home,
        &request("codex", "disable", "x@m"),
    )
    .unwrap();
    let value = format::parse(
        FileKind::Toml,
        &fs::read_to_string(root.join("config.toml")).unwrap(),
    )
    .unwrap();
    assert_eq!(value["plugins"]["x@m"]["enabled"], false);
    assert_eq!(value["plugins"]["x@m"]["future"], 42);
    assert_eq!(value["model"], "keep");
}
#[test]
fn directory_fingerprint_detects_external_content_and_membership() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a"), "first").unwrap();
    let hash = || {
        let mut value = String::new();
        digest_path(dir.path(), &mut value, &mut (0, 0)).unwrap();
        transaction::fingerprint(value.as_bytes())
    };
    let first = hash();
    fs::write(dir.path().join("a"), "other").unwrap();
    let second = hash();
    assert_ne!(first, second);
    fs::create_dir(dir.path().join("agents")).unwrap();
    assert_ne!(second, hash());
}
#[test]
fn opencode_configuration_is_not_reported_as_installed() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("db")).unwrap();
    let credentials = MemoryStore::default();
    mutate_config(
        &db,
        &credentials,
        dir.path(),
        &request("open_code", "install", "example@1.0.0"),
    )
    .unwrap();
    let entries = config_entries(&db, dir.path(), &target("open_code")).unwrap();
    assert_eq!(entries[0].state, "configured_load_unknown");
    mutate_config(
        &db,
        &credentials,
        dir.path(),
        &request("open_code", "disable", "example@1.0.0"),
    )
    .unwrap();
    mutate_config(
        &db,
        &credentials,
        dir.path(),
        &request("open_code", "uninstall", "example@1.0.0"),
    )
    .unwrap();
    assert!(config_entries(&db, dir.path(), &target("open_code"))
        .unwrap()
        .is_empty());
}

#[test]
fn captured_native_shapes_and_snapshot_drift_are_checked() {
    for (tool, fixture) in [
        (
            "claude_code",
            include_str!("../fixtures/plugins/claude-list.json"),
        ),
        ("codex", include_str!("../fixtures/plugins/codex-list.json")),
        ("grok", include_str!("../fixtures/plugins/grok-list.json")),
    ] {
        let entries =
            parse_list(tool, &serde_json::from_str(fixture).unwrap(), &target(tool)).unwrap();
        assert_eq!(entries.len(), 1);
        assert!(!entries[0].read_only);
        assert_eq!(entries[0].version.as_deref(), Some("1.0.0"));
    }
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("db")).unwrap();
    let credentials = MemoryStore::default();
    let req = request("open_code", "install", "fixture@1");
    mutate_config(&db, &credentials, dir.path(), &req).unwrap();
    let before = snapshot_inner(&db, dir.path(), &req.target, Path::new("unused")).unwrap();
    let (path, _) = config(dir.path(), &req.target).unwrap();
    fs::write(path, r#"{"plugin":["fixture@2"],"future":true}"#).unwrap();
    let after = snapshot_inner(&db, dir.path(), &req.target, Path::new("unused")).unwrap();
    assert_ne!(before.baseline, after.baseline);
    let mut context = req.target.clone();
    context.context_id = Some("another-account".into());
    assert_ne!(
        after.baseline,
        snapshot_inner(&db, dir.path(), &context, Path::new("unused"))
            .unwrap()
            .baseline
    );
}

#[test]
fn project_recovery_is_shared_but_global_recovery_is_account_specific() {
    let mut a = target("pi");
    a.scope = Scope::Project;
    a.project_path = Some("/project".into());
    a.context_id = Some("a".into());
    let mut b = a.clone();
    b.context_id = Some("b".into());
    assert_eq!(disabled_key(&a), disabled_key(&b));
    a.scope = Scope::Global;
    b.scope = Scope::Global;
    assert_ne!(disabled_key(&a), disabled_key(&b));
}
