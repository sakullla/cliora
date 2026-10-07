use super::*;

#[test]
fn file_discovery_does_not_require_an_installed_executable() {
    let home = tempfile::tempdir().unwrap();
    let db = Database::open(&home.path().join("cliora.db")).unwrap();
    for id in ["claude_code", "kimi_code", "codebuddy", "deepseek"] {
        let target = PluginTarget { tool_id: id.into(), scope: Scope::Global, project_path: None, context_id: None };
        assert!(scan(&db, home.path(), &target).unwrap().entries.is_empty());
        if id != "deepseek" { assert!(crate::resources::agents::scan(&db, home.path(), &target).is_ok()); }
    }
}

#[test]
fn zcode_preview_uses_native_catalog_but_never_grants_an_operation_baseline() {
    let home = tempfile::tempdir().unwrap();
    let db = Database::open(&home.path().join("preview.db")).unwrap();
    let root = home.path().join(".zcode/cli/plugins");
    let catalog = root.join("marketplaces/zcode-plugins-official/bundled-marketplace.json");
    fs::create_dir_all(catalog.parent().unwrap()).unwrap();
    assert!(preview(&db, home.path(), &target("zcode")).unwrap().is_none());
    fs::write(&catalog, serde_json::to_string(&json!({"version":1,"manifest":{"plugins":[
        {"name":"fixture","version":"0.9.0","cachePath":root.join("cache/fixture/0.9.0")},
        {"name":"removed","version":"1.0.0","cachePath":root.join("cache/removed/1.0.0")}
    ]}})).unwrap()).unwrap();
    fs::write(root.parent().unwrap().join("config.json"), r#"{"plugins":{"suppressedBuiltins":["removed@zcode-plugins-official"]}}"#).unwrap();
    let inventory = preview(&db, home.path(), &target("zcode")).unwrap().unwrap();
    assert_eq!(inventory.entries.len(), 1);
    assert_eq!(inventory.entries[0].id, "fixture@zcode-plugins-official");
    assert_eq!(inventory.entries[0].version.as_deref(), Some("0.9.0"));
    assert_eq!(inventory.entries[0].enabled, None);
    assert!(inventory.entries[0].read_only && inventory.capability.actions.is_empty() && inventory.baseline.is_empty());
    let req = request("zcode", "disable", "fixture@zcode-plugins-official");
    assert!(operate(&db, &MemoryStore::default(), home.path(), &req).unwrap_err().contains("尚未完成核对"));
    fs::write(catalog, r#"{"version":2,"manifest":{"plugins":[]}}"#).unwrap();
    assert!(preview(&db, home.path(), &target("zcode")).is_err());
}
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
fn parallel_package_reads_preserve_order_and_detect_same_size_edits() {
    let dir = tempfile::tempdir().unwrap();
    let mut expected = dir.path().display().to_string();
    for index in 0..16 {
        let path = dir.path().join(format!("{index:02}.txt"));
        let content = format!("fixture {index:02}");
        fs::write(&path, &content).unwrap();
        expected.push_str(&path.display().to_string());
        expected.push_str(&transaction::fingerprint(content.as_bytes()));
    }
    let mut actual = String::new();
    digest_path(dir.path(), &mut actual, &mut (0, 0)).unwrap();
    assert_eq!(actual, expected);
    let path = dir.path().join("07.txt");
    let modified = fs::metadata(&path).unwrap().modified().unwrap();
    fs::write(&path, "changed 07").unwrap();
    fs::File::options().write(true).open(&path).unwrap()
        .set_times(fs::FileTimes::new().set_modified(modified)).unwrap();
    actual.clear();
    digest_path(dir.path(), &mut actual, &mut (0, 0)).unwrap();
    assert_ne!(actual, expected);
    assert!(digest_path(dir.path(), &mut String::new(), &mut (20000, 0)).is_err());
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
    let inventory = preview(&db, dir.path(), &target("open_code")).unwrap().unwrap();
    assert_eq!(inventory.entries.len(), entries.len());
    assert!(inventory.baseline.is_empty() && inventory.capability.actions.is_empty());
    assert!(inventory.entries.iter().all(|entry| entry.read_only && entry.enabled.is_none()));
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
    let before = snapshot_inner(&db, dir.path(), &req.target, Some(Path::new("unused"))).unwrap();
    let (path, _) = config(dir.path(), &req.target).unwrap();
    fs::write(path, r#"{"plugin":["fixture@2"],"future":true}"#).unwrap();
    let after = snapshot_inner(&db, dir.path(), &req.target, Some(Path::new("unused"))).unwrap();
    assert_ne!(before.baseline, after.baseline);
    let mut context = req.target.clone();
    context.context_id = Some("another-account".into());
    assert_ne!(
        after.baseline,
        snapshot_inner(&db, dir.path(), &context, Some(Path::new("unused")))
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

#[test]
fn native_pi_delta_replacement_and_installed_path_semantics() {
    let pi = std::env::var_os("CLIORA_PI_PACKAGE_ROOT")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("APPDATA").map(|root| {
                PathBuf::from(root).join("npm/node_modules/@earendil-works/pi-coding-agent")
            })
        });
    let Some(pi) = pi.filter(|path| path.join("dist/core/package-manager.js").is_file()) else {
        eprintln!("Pi native regression not accepted: set CLIORA_PI_PACKAGE_ROOT to a tested Pi reference (0.99.2/1.0.x)");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let source = root.join("package").display().to_string();
    let original = json!({"source":source,"autoload":false,"extensions":["-extensions/fixture.ts"],"unknownFuture":42});
    let disabled = crate::adapters::pi::plugins::pi_disabled(&original, &source);
    assert_eq!(disabled["autoload"], true);
    assert_eq!(disabled["unknownFuture"], 42);
    let input = root.join("declarations.json");
    fs::write(
        &input,
        serde_json::to_vec(&json!({"original":original,"disabled":disabled})).unwrap(),
    )
    .unwrap();
    let mut expected = vec![];
    for (source, scope, base, relative) in [
        (
            "npm:@scope/fixture@1.2.3",
            "user",
            root.join("agent"),
            "npm/node_modules/@scope/fixture",
        ),
        (
            "npm:fixture@^1",
            "project",
            root.join(".pi"),
            "npm/node_modules/fixture",
        ),
        (
            "git:github.com/team/pkg@v1",
            "user",
            root.join("agent"),
            "git/github.com/team/pkg",
        ),
        (
            "https://github.com/team/pkg.git#v1",
            "project",
            root.join(".pi"),
            "git/github.com/team/pkg",
        ),
        (
            "git:git@example.test:team/pkg@main",
            "user",
            root.join("agent"),
            "git/example.test/team/pkg",
        ),
    ] {
        fs::create_dir_all(base.join(relative)).unwrap();
        let resolved = crate::adapters::pi::plugins::pi_installed_root(source, &base, root).unwrap();
        assert_eq!(resolved, base.join(relative));
        expected
            .push(json!({"source":source,"scope":scope,"expected":resolved.display().to_string()}));
    }
    let roots = root.join("roots.json");
    fs::write(&roots, serde_json::to_vec(&expected).unwrap()).unwrap();
    let output = crate::background_process::command("node")
        .arg(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../tests/fixtures/plugins/pi-native-semantics.mjs"),
        )
        .args([
            pi.as_os_str(),
            root.as_os_str(),
            input.as_os_str(),
            roots.as_os_str(),
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    eprintln!("{}", String::from_utf8_lossy(&output.stdout));
}

#[test]
fn pi_npm_git_manifest_ownership_and_package_edits_change_baseline() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let db = Database::open(&home.join("db")).unwrap();
    let base = home.join(".pi/agent");
    fs::create_dir_all(&base).unwrap();
    let settings = json!({"packages":["npm:@scope/example@1.2.3","git:github.com/team/pkg@v2"]});
    fs::write(
        base.join("settings.json"),
        serde_json::to_vec(&settings).unwrap(),
    )
    .unwrap();
    for relative in ["npm/node_modules/@scope/example", "git/github.com/team/pkg"] {
        let package = base.join(relative);
        fs::create_dir_all(package.join("custom-code")).unwrap();
        fs::create_dir_all(package.join("custom-prompts")).unwrap();
        fs::write(package.join("custom-code/fixture.ts"), "// fixture").unwrap();
        fs::write(package.join("custom-prompts/review.md"), "fixture").unwrap();
        fs::write(package.join("package.json"), serde_json::to_vec(&json!({"name":relative,"version":"1.2.3","pi":{"extensions":["custom-code/*.ts"],"prompts":["custom-prompts/review.md"],"themes":[]}})).unwrap()).unwrap();
    }
    let before = snapshot_inner(&db, home, &target("pi"), Some(Path::new("unused"))).unwrap();
    assert_eq!(before.entries.len(), 2);
    for entry in &before.entries {
        assert!(!entry.read_only, "{}", entry.policy);
        assert!(entry.root.is_some());
        assert_eq!(entry.version.as_deref(), Some("1.2.3"));
        assert_eq!(entry.resources.len(), 2);
        assert!(entry
            .resources
            .iter()
            .all(|resource| resource.owner_id == entry.id));
    }
    fs::write(
        base.join("npm/node_modules/@scope/example/custom-code/fixture.ts"),
        "// external edit",
    )
    .unwrap();
    let npm_changed = snapshot_inner(&db, home, &target("pi"), Some(Path::new("unused"))).unwrap();
    assert_ne!(before.baseline, npm_changed.baseline);
    fs::write(
        base.join("git/github.com/team/pkg/custom-prompts/review.md"),
        "external edit",
    )
    .unwrap();
    assert_ne!(
        npm_changed.baseline,
        snapshot_inner(&db, home, &target("pi"), Some(Path::new("unused")))
            .unwrap()
            .baseline
    );
    fs::write(
        base.join("settings.json"),
        r#"{"packages":["npm:not-installed@1"]}"#,
    )
    .unwrap();
    let missing = config_entries(&db, home, &target("pi")).unwrap();
    assert!(missing[0].read_only);
    assert!(missing[0].policy.contains("安装目录未找到"));
    assert!(crate::adapters::pi::plugins::pi_installed_root("npm:../../outside", &base, home).is_err());
    assert!(crate::adapters::pi::plugins::pi_installed_root("git:github.com/../outside", &base, home).is_err());
}

#[test]
fn backup_restore_reconciles_only_exact_original_then_allows_management() {
    for tool in ["pi", "open_code"] {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let db = Database::open(&home.join("db")).unwrap();
        let credentials = MemoryStore::default();
        let package = home.join("package");
        fs::create_dir(&package).unwrap();
        let source = package.display().to_string();
        let req = request(tool, "disable", &source);
        let original = if tool == "pi" {
            json!({"packages":[{"source":source,"autoload":false,"extensions":["!old.ts"],"future":true}]})
        } else {
            json!({"plugin":[source]})
        };
        let (path, _) = config(home, &req.target).unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, serde_json::to_vec(&original).unwrap()).unwrap();
        let id = mutate_config(&db, &credentials, home, &req).unwrap();
        let disabled_entries = config_entries(&db, home, &req.target).unwrap();
        assert_eq!(disabled_entries[0].enabled, Some(false));
        assert!(!disabled_entries[0].read_only);
        let current = fs::read_to_string(&path).unwrap();
        transaction::restore_backup(&db, &credentials, &path, &id, &current, |_| Ok(())).unwrap();
        let restored = config_entries(&db, home, &req.target).unwrap();
        assert_eq!(restored[0].enabled, Some(true));
        assert!(!restored[0].read_only);
        assert!(disabled(&db, &req.target).unwrap().is_empty());
        assert_eq!(
            serde_json::from_str::<Value>(&fs::read_to_string(&path).unwrap()).unwrap(),
            original
        );
        mutate_config(&db, &credentials, home, &req).unwrap();
        mutate_config(&db, &credentials, home, &request(tool, "enable", &source)).unwrap();
        assert_eq!(
            config_entries(&db, home, &req.target).unwrap()[0].enabled,
            Some(true)
        );
    }
}

#[test]
fn unknown_external_change_does_not_claim_disabled_or_overwrite_files() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let db = Database::open(&home.join("db")).unwrap();
    let credentials = MemoryStore::default();
    let package = home.join("package");
    fs::create_dir(&package).unwrap();
    let source = package.display().to_string();
    let req = request("pi", "disable", &source);
    let (path, _) = config(home, &req.target).unwrap();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        serde_json::to_vec(&json!({"packages":[{"source":source,"future":1}]})).unwrap(),
    )
    .unwrap();
    mutate_config(&db, &credentials, home, &req).unwrap();
    let external =
        serde_json::to_string(&json!({"packages":[{"source":source,"future":2}]})).unwrap();
    fs::write(&path, &external).unwrap();
    let entry = &config_entries(&db, home, &req.target).unwrap()[0];
    assert_eq!(entry.enabled, None);
    assert_eq!(entry.state, "state_unknown");
    assert!(entry.read_only);
    assert_eq!(fs::read_to_string(&path).unwrap(), external);
    assert!(!disabled(&db, &req.target).unwrap().is_empty());
}

#[test]
fn specific_backup_restores_disabled_metadata_after_enable_or_uninstall() {
    for tool in ["pi", "open_code"] {
        for action in ["enable", "uninstall"] {
            let dir = tempfile::tempdir().unwrap();
            let home = dir.path();
            let db = Database::open(&home.join("db")).unwrap();
            let credentials = MemoryStore::default();
            let package = home.join("package");
            fs::create_dir(&package).unwrap();
            let source = package.display().to_string();
            let t = target(tool);
            let (path, _) = config(home, &t).unwrap();
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let original = if tool == "pi" {
                json!({"packages":[{"source":source,"autoload":false,"extensions":["!old.ts"],"future":"backup-metadata-private-marker"}]})
            } else {
                json!({"plugin":[source]})
            };
            fs::write(&path, serde_json::to_vec(&original).unwrap()).unwrap();
            let disable_id =
                mutate_config(&db, &credentials, home, &request(tool, "disable", &source)).unwrap();
            let disabled_file = fs::read_to_string(&path).unwrap();
            let disabled_metadata = disabled(&db, &t).unwrap();
            let action_id =
                mutate_config(&db, &credentials, home, &request(tool, action, &source)).unwrap();
            assert_ne!(disable_id, action_id);
            assert!(!action_id.is_empty());
            assert!(disabled(&db, &t).unwrap().is_empty());
            let after_action = fs::read_to_string(&path).unwrap();
            let restore = transaction::restore_backup(
                &db,
                &credentials,
                &path,
                &action_id,
                &after_action,
                |_| Ok(()),
            )
            .unwrap();
            assert_eq!(fs::read_to_string(&path).unwrap(), disabled_file);
            assert_eq!(disabled(&db, &t).unwrap(), disabled_metadata);
            let entries = config_entries(&db, home, &t).unwrap();
            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0].enabled, Some(false));
            assert!(!entries[0].read_only);
            // Undoing a restore must also restore the metadata present before it.
            transaction::restore_backup(
                &db,
                &credentials,
                &path,
                &restore.transaction_id,
                &disabled_file,
                |_| Ok(()),
            )
            .unwrap();
            assert_eq!(fs::read_to_string(&path).unwrap(), after_action);
            assert!(disabled(&db, &t).unwrap().is_empty());
            transaction::restore_backup(
                &db,
                &credentials,
                &path,
                &action_id,
                &after_action,
                |_| Ok(()),
            )
            .unwrap();
            mutate_config(&db, &credentials, home, &request(tool, "enable", &source)).unwrap();
            assert_eq!(
                config_entries(&db, home, &t).unwrap()[0].enabled,
                Some(true)
            );
            assert_eq!(
                serde_json::from_str::<Value>(&fs::read_to_string(&path).unwrap()).unwrap(),
                original
            );
            db.with_connection(|conn| {
                let journal: String = conn
                    .query_row(
                        "SELECT data FROM native_transactions WHERE id=?1",
                        [&action_id],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert!(!journal.contains("backup-metadata-private-marker"));
                Ok(())
            })
            .unwrap();
        }
    }
}

#[test]
fn configuration_edit_backup_also_preserves_plugin_recovery_and_failed_restore_is_atomic() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let db = Database::open(&home.join("db")).unwrap();
    let credentials = MemoryStore::default();
    let source = "fixture@1";
    let t = target("open_code");
    let (path, _) = config(home, &t).unwrap();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, r#"{"plugin":["fixture@1"]}"#).unwrap();
    mutate_config(
        &db,
        &credentials,
        home,
        &request("open_code", "disable", source),
    )
    .unwrap();
    let disabled_file = fs::read_to_string(&path).unwrap();
    let metadata = disabled(&db, &t).unwrap();
    // This models the configuration editor, not a plugin lifecycle operation.
    let edit = transaction::apply_text(
        &db,
        &credentials,
        &[transaction::TextPatch {
            path: path.clone(),
            baseline: disabled_file.clone(),
            contents: r#"{"plugin":[],"unrelated":42}"#.into(),
            sensitive: true,
        }],
        |_| Ok(()),
    )
    .unwrap();
    mutate_config(
        &db,
        &credentials,
        home,
        &request("open_code", "enable", source),
    )
    .unwrap();
    let before_restore = fs::read_to_string(&path).unwrap();
    let failure = transaction::restore_backup(
        &db,
        &credentials,
        &path,
        &edit.transaction_id,
        &before_restore,
        |_| Err("injected metadata commit failure".into()),
    );
    assert!(failure
        .unwrap_err()
        .contains("injected metadata commit failure"));
    assert_eq!(fs::read_to_string(&path).unwrap(), before_restore);
    assert!(disabled(&db, &t).unwrap().is_empty());
    fs::write(&path, "{\"external\":true}").unwrap();
    assert!(transaction::restore_backup(
        &db,
        &credentials,
        &path,
        &edit.transaction_id,
        &before_restore,
        |_| Ok(())
    )
    .is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "{\"external\":true}");
    assert!(disabled(&db, &t).unwrap().is_empty());
    transaction::restore_backup(
        &db,
        &credentials,
        &path,
        &edit.transaction_id,
        "{\"external\":true}",
        |_| Ok(()),
    )
    .unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), disabled_file);
    assert_eq!(disabled(&db, &t).unwrap(), metadata);
    mutate_config(
        &db,
        &credentials,
        home,
        &request("open_code", "enable", source),
    )
    .unwrap();
    assert_eq!(
        config_entries(&db, home, &t).unwrap()[0].enabled,
        Some(true)
    );
}

#[cfg(windows)]
#[test]
fn plugin_edits_preserve_restricted_secret_file_acl_under_permissive_parent() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let db = Database::open(&home.join("db")).unwrap();
    let credentials = MemoryStore::default();
    let req = request("open_code", "install", "fixture@1");
    let (path, _) = config(home, &req.target).unwrap();
    let parent = path.parent().unwrap();
    fs::create_dir_all(parent).unwrap();
    let icacls = PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32/icacls.exe");
    let grant = crate::background_process::command(&icacls)
        .arg(parent)
        .args(["/grant", "*S-1-5-32-545:(OI)(CI)R"])
        .output()
        .unwrap();
    assert!(grant.status.success());
    let secret = r#"{"provider":{"openai":{"options":{"apiKey":"synthetic-secret-only"}}}}"#;
    fs::write(&path, secret).unwrap();
    transaction::apply(
        &db,
        &credentials,
        &[FilePatch {
            path: path.clone(),
            kind: FileKind::Json,
            baseline: secret.into(),
            changes: vec![],
            sensitive: true,
            force_restrict: true,
        }],
        |_| Ok(()),
    )
    .unwrap();
    for action in ["install", "disable", "uninstall"] {
        mutate_config(
            &db,
            &credentials,
            home,
            &request("open_code", action, "fixture@1"),
        )
        .unwrap();
        let acl = crate::background_process::command(&icacls)
            .arg(&path)
            .output()
            .unwrap();
        assert!(acl.status.success());
        assert!(!String::from_utf8_lossy(&acl.stdout).contains("(I)"));
        let users = crate::background_process::command(&icacls)
            .arg(&path)
            .args(["/findsid", "*S-1-5-32-545"])
            .output()
            .unwrap();
        assert!(users.status.success());
        assert!(!String::from_utf8_lossy(&users.stdout).contains(&path.display().to_string()));
        assert!(fs::read_to_string(&path)
            .unwrap()
            .contains("synthetic-secret-only"));
    }
}

#[test]
fn dsh_user_bundle_toggle_is_transactional_and_retains_official_layers() {
    let home = tempfile::tempdir().unwrap();
    let db = Database::open(&home.path().join("test.db")).unwrap();
    let profile = home.path().join(".dsh/profiles/desktop");
    let package = profile.join("node_modules/@fixture/user-plugin");
    fs::create_dir_all(&package).unwrap();
    fs::write(package.join("package.json"), r#"{"name":"@fixture/user-plugin","version":"1.0.0","dsh":{"bundle":{"patch":"./cordis.patch.yml"}}}"#).unwrap();
    let config = profile.join("package.json");
    fs::write(&config, r#"{"private":true,"dependencies":{"@fixture/user-plugin":"1.0.0"},"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@fixture/user-plugin"]}},"custom":"retain"}"#).unwrap();
    let target = target("deepseek");
    let before = scan(&db, home.path(), &target).unwrap();
    assert_eq!(before.entries.len(), 1);
    assert_eq!(before.entries[0].enabled, Some(true));
    let mut req = request("deepseek", "disable", "@fixture/user-plugin");
    req.baseline = before.baseline;
    let store = MemoryStore::default();
    let disabled = operate(&db, &store, home.path(), &req).unwrap();
    assert_eq!(disabled.status, "configuration_written");
    assert_eq!(disabled.snapshot.as_ref().unwrap().entries[0].enabled, Some(false));
    let parsed: Value = serde_json::from_str(&fs::read_to_string(&config).unwrap()).unwrap();
    assert_eq!(parsed["custom"], "retain");
    assert_eq!(parsed.pointer("/dsh/profile/bundles").unwrap(), &json!(["@deepseek-ai/dsh-base"]));
    assert!(package.join("package.json").is_file());
    assert!(operate(&db, &store, home.path(), &req).is_err(), "old baseline must not write twice");
    req.action = "enable".into(); req.baseline = disabled.snapshot.unwrap().baseline;
    let enabled = operate(&db, &store, home.path(), &req).unwrap();
    assert_eq!(enabled.snapshot.unwrap().entries[0].enabled, Some(true));
    assert_eq!(transaction::recent_backups(&db, &config).unwrap().len(), 2);
}

#[test]
fn claude_ledger_is_fast_file_discovery_with_scope_and_enablement_baselines() {
    let home = tempfile::tempdir().unwrap();
    let db = Database::open(&home.path().join("test.db")).unwrap();
    let root = home.path().join(".claude"); fs::create_dir_all(root.join("plugins")).unwrap();
    let project = home.path().join("project"); fs::create_dir_all(project.join(".claude")).unwrap();
    let ledger = root.join("plugins/installed_plugins.json");
    fs::write(&ledger, serde_json::to_string(&json!({"version":2,"plugins":{"fixture@custom":[{"scope":"user","version":"1"},{"scope":"project","projectPath":project.to_str().unwrap(),"version":"2"},{"scope":"project","projectPath":"/elsewhere","version":"3"}]}})).unwrap()).unwrap();
    fs::write(root.join("settings.json"), r#"{"enabledPlugins":{"fixture@custom":true}}"#).unwrap();
    fs::write(project.join(".claude/settings.local.json"), r#"{"enabledPlugins":{"fixture@custom":false}}"#).unwrap();
    let user = scan(&db, home.path(), &target("claude_code")).unwrap();
    assert_eq!(user.entries.len(), 1); assert_eq!(user.entries[0].enabled, Some(true));
    let project_target = PluginTarget { scope: Scope::Project, project_path: Some(project.display().to_string()), ..target("claude_code") };
    let local = scan(&db, home.path(), &project_target).unwrap();
    assert_eq!(local.entries.len(), 1); assert_eq!(local.entries[0].enabled, Some(false));
    fs::write(project.join(".claude/settings.local.json"), r#"{"enabledPlugins":{"fixture@custom":true}}"#).unwrap();
    assert_ne!(local.baseline, scan(&db, home.path(), &project_target).unwrap().baseline);
    fs::write(ledger, r#"{"version":3,"plugins":{}}"#).unwrap();
    assert!(scan(&db, home.path(), &target("claude_code")).is_err());
}
