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
fn target(tool: &str, root: &Path) -> PluginTarget {
    PluginTarget {
        tool_id: tool.into(),
        scope: Scope::Project,
        project_path: Some(root.display().to_string()),
        context_id: None,
    }
}
fn request(
    home: &Path,
    target: &PluginTarget,
    action: &str,
    entry: Option<&AgentEntry>,
    content: &str,
) -> AgentRequest {
    AgentRequest {
        target: target.clone(),
        action: action.into(),
        id: entry.map(|e| e.id.clone()),
        name: "reviewer".into(),
        content: content.into(),
        baseline: snapshot_inner(home, target, &[]).unwrap().baseline,
        transaction_id: None,
    }
}
fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

#[test]
fn opencode_agent_capability_reference_labels_both_verified_lines() {
    let capability = contract::capability("open_code").unwrap();
    assert!(
        capability.version.contains("1.18.34") && capability.version.contains("2.0.29"),
        "{}",
        capability.version
    );
}

#[test]
fn native_formats_reject_invalid_fields_preserve_unknown_and_keep_pi_explicit() {
    for tool in ["codex", "claude_code", "grok", "open_code"] {
        let cap = contract::capability(tool).unwrap();
        assert!(
            contract::validate(tool, cap.format, cap.template, "reviewer").is_ok(),
            "{tool}"
        );
    }
    assert!(!contract::capability("pi").unwrap().supported);
    assert!(contract::validate(
        "claude_code",
        "markdown",
        "---\nname: a\ndescription: x\ntools: 9\n---\nx",
        "a"
    )
    .is_err());
    assert!(contract::validate(
        "grok",
        "markdown",
        "---\nname: a\ndescription: x\npermissionMode: wrong\n---\nx",
        "a"
    )
    .is_err());
    assert!(contract::validate("open_code", "json", r#"{"model":4}"#, "a").is_err());
    assert!(contract::validate(
        "open_code",
        "json",
        r#"{"permission":{"edit":"sometimes"}}"#,
        "a"
    )
    .is_err());
    assert!(contract::validate(
        "open_code",
        "json",
        r#"{"description":"x","custom":{"future":true}}"#,
        "a"
    )
    .is_ok());
    let cap = contract::capability("codex").unwrap();
    assert!(contract::validate(
        "codex",
        "toml",
        &format!("{}\nunknown_option = true", cap.template),
        "a"
    )
    .is_err());
    assert!(contract::validate(
        "codex",
        "toml",
        &format!("{}\nmodel = 42", cap.template),
        "a"
    )
    .is_err());
    assert!(contract::validate(
        "codex",
        "toml",
        &format!("{}\nmodel_reasoning_effort = \"high\"", cap.template),
        "a"
    )
    .is_ok());
}

#[test]
fn four_cli_file_lifecycles_and_group_restore_are_byte_preserving() {
    for tool in ["codex", "claude_code", "grok", "open_code"] {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let db = Database::open(&home.join("db.sqlite")).unwrap();
        let store = MemoryStore::default();
        let target = target(tool, home);
        let cap = contract::capability(tool).unwrap();
        let created = operate_inner(
            &db,
            &store,
            home,
            &request(home, &target, "create", None, cap.template),
            &[],
        )
        .unwrap();
        let entry = &created.snapshot.entries[0];
        let original = entry.path.clone();
        assert_eq!(entry.content, cap.template);
        let disabled = operate_inner(
            &db,
            &store,
            home,
            &request(home, &target, "disable", Some(entry), ""),
            &[],
        )
        .unwrap();
        assert!(!Path::new(&original).exists());
        assert!(!disabled.snapshot.entries[0].enabled);
        assert_eq!(disabled.changed_paths.len(), 2);
        assert_eq!(disabled.snapshot.entries[0].content, cap.template);
        let preview = transaction::preview_backup(
            &db,
            &store,
            Path::new(&original),
            &disabled.transaction_id,
        )
        .unwrap();
        assert_eq!(preview.affected_paths.len(), 2);
        let mut restore = request(home, &target, "restore", None, "");
        restore.id = Some(original.clone());
        restore.transaction_id = Some(disabled.transaction_id.clone());
        let restored = operate_inner(&db, &store, home, &restore, &[]).unwrap();
        assert!(restored.snapshot.entries[0].enabled);
        assert_eq!(restored.snapshot.entries.len(), 1);
        let entry = &restored.snapshot.entries[0];
        let edited = if tool == "codex" {
            format!("{}\n# preserved comment\n", cap.template)
        } else {
            cap.template.replace(
                "description: Review code",
                "description: Updated\ncustom: keep-me",
            )
        };
        let saved = operate_inner(
            &db,
            &store,
            home,
            &request(home, &target, "save", Some(entry), &edited),
            &[],
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&original).unwrap(), edited);
        let disabled = operate_inner(
            &db,
            &store,
            home,
            &request(
                home,
                &target,
                "disable",
                Some(&saved.snapshot.entries[0]),
                "",
            ),
            &[],
        )
        .unwrap();
        let enabled = operate_inner(
            &db,
            &store,
            home,
            &request(
                home,
                &target,
                "enable",
                Some(&disabled.snapshot.entries[0]),
                "",
            ),
            &[],
        )
        .unwrap();
        assert!(enabled.snapshot.entries[0].enabled);
        let deleted = operate_inner(
            &db,
            &store,
            home,
            &request(
                home,
                &target,
                "delete",
                Some(&enabled.snapshot.entries[0]),
                "",
            ),
            &[],
        )
        .unwrap();
        assert!(deleted.snapshot.entries.is_empty());
        assert!(!Path::new(&original).exists());
        transaction::restore_backup(
            &db,
            &store,
            Path::new(&original),
            &deleted.transaction_id,
            "",
            |_| Ok(()),
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&original).unwrap(), edited);
    }
}

#[test]
fn inline_opencode_preserves_comments_credentials_and_unknown_fields() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let db = Database::open(&home.join("db.sqlite")).unwrap();
    let store = MemoryStore::default();
    let target = target("open_code", home);
    let path = home.join("opencode.jsonc");
    write(&path,"{\n// keep\n\"provider\":{\"fixture\":{\"apiKey\":\"synthetic-only\"}},\"agent\":{\"reviewer\":{\"description\":\"review\",\"prompt\":\"do it\",\"options\":{\"extra\":7}}}}\n");
    let snap = snapshot_inner(home, &target, &[]).unwrap();
    assert_eq!(snap.entries.len(), 1);
    let disabled = operate_inner(
        &db,
        &store,
        home,
        &request(home, &target, "disable", Some(&snap.entries[0]), ""),
        &[],
    )
    .unwrap();
    assert!(!disabled.snapshot.entries[0].enabled);
    let text = fs::read_to_string(&path).unwrap();
    assert!(text.contains("// keep"));
    assert!(text.contains("synthetic-only"));
    assert!(text.contains("extra"));
    let enabled = operate_inner(
        &db,
        &store,
        home,
        &request(
            home,
            &target,
            "enable",
            Some(&disabled.snapshot.entries[0]),
            "",
        ),
        &[],
    )
    .unwrap();
    assert!(enabled.snapshot.entries[0].enabled);
    operate_inner(
        &db,
        &store,
        home,
        &request(
            home,
            &target,
            "delete",
            Some(&enabled.snapshot.entries[0]),
            "",
        ),
        &[],
    )
    .unwrap();
    assert!(fs::read_to_string(&path)
        .unwrap()
        .contains("synthetic-only"));
}

#[test]
fn stale_baseline_duplicate_names_invalid_import_and_package_ownership_block_writes() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let db = Database::open(&home.join("db.sqlite")).unwrap();
    let store = MemoryStore::default();
    let target = target("claude_code", home);
    let template = contract::capability("claude_code").unwrap().template;
    let initial = request(home, &target, "create", None, template);
    let created = operate_inner(&db, &store, home, &initial, &[]).unwrap();
    assert!(operate_inner(&db, &store, home, &initial, &[]).is_err());
    let mut duplicate = request(home, &target, "create", None, template);
    duplicate.name = "other".into();
    assert!(operate_inner(&db, &store, home, &duplicate, &[]).is_err());
    let original = created.snapshot.entries[0].content.clone();
    let invalid = request(
        home,
        &target,
        "save",
        Some(&created.snapshot.entries[0]),
        "invalid",
    );
    assert!(operate_inner(&db, &store, home, &invalid, &[]).is_err());
    assert_eq!(
        read(Path::new(&created.snapshot.entries[0].path)).unwrap(),
        original
    );
    let plugin_dir = home.join("plugins/owned/agents");
    write(
        &plugin_dir.join("other.md"),
        &template.replace("reviewer", "owned"),
    );
    let plugins = vec![plugins::PluginEntry {
        id: "owned@market".into(),
        name: "Owned".into(),
        source: "fixture".into(),
        version: None,
        scope: "user".into(),
        enabled: Some(true),
        state: "installed".into(),
        policy: "".into(),
        read_only: false,
        root: None,
        resources: vec![plugins::PluginResource {
            kind: "agents".into(),
            path: plugin_dir.display().to_string(),
            owner_id: "owned@market".into(),
        }],
    }];
    let snap = snapshot_inner(home, &target, &plugins).unwrap();
    let owned = snap
        .entries
        .iter()
        .find(|e| e.name == "owned:owned")
        .unwrap();
    assert!(owned.read_only);
    let mut req = request(home, &target, "delete", Some(owned), "");
    req.baseline = snap.baseline;
    assert!(operate_inner(&db, &store, home, &req, &plugins).is_err());
    write(&home.join(".claude/agents/nested/same.md"), template);
    let snap = snapshot_inner(home, &target, &[]).unwrap();
    assert!(snap.entries.iter().all(|e| e.read_only));
}

#[test]
fn codex_explicit_roles_are_discovered_read_only_and_cannot_be_shadowed() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let target = target("codex", home);
    write(
        &home.join(".codex/config.toml"),
        "[agents.legacy]\ndescription = \"old role\"\nconfig_file = \"roles/legacy.toml\"\n",
    );
    write(
        &home.join(".codex/roles/legacy.toml"),
        "model = \"gpt-5\"\n",
    );
    let snapshot = snapshot_inner(home, &target, &[]).unwrap();
    assert_eq!(snapshot.entries[0].name, "legacy");
    assert!(snapshot.entries[0].read_only);
    assert!(snapshot.entries[0].content.contains("gpt-5"));
}

#[test]
fn coupled_transaction_rolls_back_and_rejects_external_changes_on_either_file() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let db = Database::open(&home.join("db.sqlite")).unwrap();
    let store = MemoryStore::default();
    let a = home.join("agents/a.md");
    let b = home.join("disabled/a.md");
    write(&a, "original");
    let changes = vec![
        FileMutation {
            path: a.clone(),
            baseline: Some("original".into()),
            contents: None,
        },
        FileMutation {
            path: b.clone(),
            baseline: None,
            contents: Some("original".into()),
        },
    ];
    assert!(transaction::apply_files(&db, &store, &changes, |_| Err(
        "injected commit failure".into()
    ))
    .is_err());
    assert_eq!(read(&a).unwrap(), "original");
    assert!(!b.exists());
    let outcome = transaction::apply_files(&db, &store, &changes, |_| Ok(())).unwrap();
    write(&b, "external");
    assert!(
        transaction::restore_backup(&db, &store, &a, &outcome.transaction_id, "", |_| Ok(()))
            .is_err()
    );
    assert!(!a.exists());
    assert_eq!(read(&b).unwrap(), "external");
    write(&b, "original");
    write(&a, "");
    assert!(
        transaction::restore_backup(&db, &store, &a, &outcome.transaction_id, "", |_| Ok(()))
            .is_err()
    );
    fs::remove_file(&a).unwrap();
    transaction::restore_backup(&db, &store, &a, &outcome.transaction_id, "", |_| Ok(())).unwrap();
    assert_eq!(read(&a).unwrap(), "original");
    assert!(!b.exists());
    write(&b, "");
    assert!(transaction::apply_files(&db, &store, &changes, |_| Ok(())).is_err());
    assert!(a.exists());
}

#[test]
fn scope_and_context_paths_are_isolated_and_stale_context_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let db = Database::open(&home.join("db.sqlite")).unwrap();
    let context =
        crate::accounts::context::context_at(home.join("account-a"), "claude_code", "ctx-a".into())
            .unwrap();
    let _guard = selection::enter(Some(context));
    let mut target = target("claude_code", home);
    target.scope = Scope::Global;
    target.project_path = None;
    assert!(scan(&db, home, &target).unwrap_err().contains("上下文"));
    let root = contract::root("claude_code", Scope::Global, home, None).unwrap();
    assert_eq!(root, home.join("account-a"));
    assert_eq!(
        contract::root("claude_code", Scope::Project, home, Some(home)).unwrap(),
        home.join(".claude")
    );
}

#[test]
fn opencode_native_disable_flag_is_visible_and_can_be_enabled_without_losing_comments() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let db = Database::open(&home.join("db.sqlite")).unwrap();
    let store = MemoryStore::default();
    let target = target("open_code", home);
    let path = home.join(".opencode/agents/reviewer.md");
    write(
        &path,
        "---\ndescription: Review\ndisable: true # keep\ncustom: retained\n---\nPrompt\n",
    );
    let snapshot = snapshot_inner(home, &target, &[]).unwrap();
    assert!(!snapshot.entries[0].enabled);
    let result = operate_inner(
        &db,
        &store,
        home,
        &request(home, &target, "enable", Some(&snapshot.entries[0]), ""),
        &[],
    )
    .unwrap();
    assert!(result.snapshot.entries[0].enabled);
    let text = read(&path).unwrap();
    assert!(text.contains("disable: false # keep"));
    assert!(text.contains("custom: retained"));
    let nested = home.join(".opencode/opencode.json");
    write(
        &nested,
        r#"{"agent":{"reviewer":{"description":"collision"}}}"#,
    );
    let snapshot = snapshot_inner(home, &target, &[]).unwrap();
    assert_eq!(snapshot.entries.len(), 2);
    assert!(snapshot.entries.iter().all(|e| e.read_only));
}

#[test]
fn grok_only_scans_direct_agent_files_as_verified_by_native_inspect() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let target = target("grok", home);
    let text = contract::capability("grok").unwrap().template;
    write(&home.join(".grok/agents/top.md"), text);
    write(
        &home.join(".grok/agents/nested/other.md"),
        &text.replace("reviewer", "nested"),
    );
    let snapshot = snapshot_inner(home, &target, &[]).unwrap();
    assert_eq!(snapshot.entries.len(), 1);
    assert_eq!(snapshot.entries[0].name, "reviewer");
}

#[test]
fn agent_save_undo_rejects_external_edits_after_rescan_but_explicit_preview_restore_still_works() {
    for tool in ["codex", "claude_code"] {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let db = Database::open(&home.join("db.sqlite")).unwrap();
        let store = MemoryStore::default();
        let target = target(tool, home);
        let original = contract::capability(tool).unwrap().template;
        let created = operate_inner(
            &db,
            &store,
            home,
            &request(home, &target, "create", None, original),
            &[],
        )
        .unwrap();
        let updated = original.replace("Review code", "Updated review");
        let saved = operate_inner(
            &db,
            &store,
            home,
            &request(
                home,
                &target,
                "save",
                Some(&created.snapshot.entries[0]),
                &updated,
            ),
            &[],
        )
        .unwrap();
        let path = Path::new(&saved.restore_path);
        let external = updated.replace("Updated review", "External edit");
        write(path, &external);
        // Fresh snapshot models the UI's rescan; retaining the undo record must not authorize C -> A.
        let mut undo = request(home, &target, "restore", None, "");
        undo.id = Some(saved.restore_path.clone());
        undo.transaction_id = Some(saved.transaction_id.clone());
        assert!(operate_inner(&db, &store, home, &undo, &[])
            .unwrap_err()
            .contains("修改"));
        assert_eq!(read(path).unwrap(), external);
        fs::remove_file(path).unwrap();
        undo.baseline = snapshot_inner(home, &target, &[]).unwrap().baseline;
        assert!(operate_inner(&db, &store, home, &undo, &[]).is_err());
        assert!(!path.exists());
        write(path, &updated);
        undo.baseline = snapshot_inner(home, &target, &[]).unwrap().baseline;
        operate_inner(&db, &store, home, &undo, &[]).unwrap();
        assert_eq!(read(path).unwrap(), original);
        // The existing native-file editor has an explicit current/original diff and keeps its contract.
        write(path, &external);
        let preview =
            transaction::preview_backup(&db, &store, path, &saved.transaction_id).unwrap();
        assert_eq!(preview.current, external);
        transaction::restore_backup(
            &db,
            &store,
            path,
            &saved.transaction_id,
            &preview.current,
            |_| Ok(()),
        )
        .unwrap();
        assert_eq!(read(path).unwrap(), original);
    }
}

#[test]
fn inline_agent_undo_never_reverts_later_unrelated_config_after_rescan() {
    for action in ["save", "disable", "enable", "delete"] {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let db = Database::open(&home.join("db.sqlite")).unwrap();
        let store = MemoryStore::default();
        let target = target("open_code", home);
        let path = home.join("opencode.jsonc");
        let original = format!("{{\n// preserved\n\"provider\":{{\"fixture\":{{\"options\":{{\"apiKey\":\"synthetic-only\"}}}}}},\"agent\":{{\"reviewer\":{{\"description\":\"original\",\"disable\":{}}}}}}}", action == "enable");
        write(&path, &original);
        let snapshot = snapshot_inner(home, &target, &[]).unwrap();
        let result = operate_inner(
            &db,
            &store,
            home,
            &request(
                home,
                &target,
                action,
                Some(&snapshot.entries[0]),
                r#"{"description":"updated","prompt":"review"}"#,
            ),
            &[],
        )
        .unwrap();
        let committed = read(&path).unwrap();
        let external = format::set_path(
            FileKind::Jsonc,
            &committed,
            &["model".into()],
            Some(&Value::String("external/model".into())),
        )
        .unwrap();
        write(&path, &external);
        let mut undo = request(home, &target, "restore", None, "");
        undo.id = Some(result.restore_path.clone());
        undo.transaction_id = Some(result.transaction_id.clone());
        assert!(
            operate_inner(&db, &store, home, &undo, &[])
                .unwrap_err()
                .contains("修改"),
            "{action}"
        );
        assert_eq!(read(&path).unwrap(), external);
        write(&path, &committed);
        undo.baseline = snapshot_inner(home, &target, &[]).unwrap().baseline;
        operate_inner(&db, &store, home, &undo, &[]).unwrap();
        assert_eq!(read(&path).unwrap(), original, "{action}");
    }
}

#[test]
fn claude_plugin_namespace_keeps_local_same_names_editable_and_nested_plugins_distinct() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let db = Database::open(&home.join("db.sqlite")).unwrap();
    let store = MemoryStore::default();
    let target = target("claude_code", home);
    let template = contract::capability("claude_code").unwrap().template;
    let mut plugins = Vec::new();
    for id in ["my-plugin@market", "other-plugin@market"] {
        let root = home.join("plugins").join(id).join("agents");
        write(&root.join("reviewer.md"), template);
        write(
            &root.join("review/security.md"),
            &template.replace("reviewer", "security"),
        );
        plugins.push(plugins::PluginEntry {
            id: id.into(),
            name: id.into(),
            source: "fixture".into(),
            version: None,
            scope: "user".into(),
            enabled: Some(true),
            state: "installed".into(),
            policy: String::new(),
            read_only: false,
            root: None,
            resources: vec![plugins::PluginResource {
                kind: "agents".into(),
                path: root.display().to_string(),
                owner_id: id.into(),
            }],
        });
    }
    let initial = snapshot_inner(home, &target, &plugins).unwrap();
    for name in [
        "my-plugin:reviewer",
        "other-plugin:reviewer",
        "my-plugin:review:security",
        "other-plugin:review:security",
    ] {
        let item = initial
            .entries
            .iter()
            .find(|entry| entry.name == name)
            .unwrap();
        assert!(item.read_only);
        assert!(!item.detail.contains("同名"));
        assert_eq!(read(Path::new(&item.path)).unwrap(), item.content);
    }
    let mut create = request(home, &target, "create", None, template);
    create.baseline = initial.baseline;
    let mut snapshot = operate_inner(&db, &store, home, &create, &plugins)
        .unwrap()
        .snapshot;
    for action in ["save", "disable", "enable", "delete"] {
        let local = snapshot
            .entries
            .iter()
            .find(|entry| entry.name == "reviewer")
            .unwrap();
        assert!(!local.read_only);
        let mut req = request(
            home,
            &target,
            action,
            Some(local),
            &template.replace("Review code", "Local updated"),
        );
        req.baseline = snapshot.baseline;
        snapshot = operate_inner(&db, &store, home, &req, &plugins)
            .unwrap()
            .snapshot;
    }
    assert_eq!(snapshot.entries.len(), 4);
    assert!(snapshot.entries.iter().all(|entry| entry.read_only));
}

#[test]
fn qoder_cn_builtins_are_read_only_and_allow_custom_overrides() {
    let temp = tempfile::tempdir().unwrap(); let home = temp.path();
    let db = Database::open(&home.join("test.db")).unwrap();
    let target = PluginTarget { tool_id: "qoder_cn".into(), scope: Scope::Global, project_path: None, context_id: None };
    let first = snapshot_inner(home, &target, &[]).unwrap();
    assert_eq!(first.entries.len(), 5);
    assert!(first.entries.iter().all(|entry| entry.builtin && entry.read_only && entry.path.is_empty()));
    let builtin = first.entries.iter().find(|entry| entry.name == "Explore").unwrap();
    assert!(operate_inner(&db, &MemoryStore::default(), home, &request(home, &target, "delete", Some(builtin), ""), &[]).is_err());
    let content = "---\nname: Explore\ndescription: Custom explorer\n---\nRead the project.";
    let mut create = request(home, &target, "create", None, content); create.name = "Explore".into();
    operate_inner(&db, &MemoryStore::default(), home, &create, &[]).unwrap();
    let after = snapshot_inner(home, &target, &[]).unwrap();
    let custom = after.entries.iter().find(|entry| !entry.builtin && entry.name == "Explore").unwrap();
    assert!(custom.enabled && !custom.read_only);
    assert!(!after.entries.iter().find(|entry| entry.builtin && entry.name == "Explore").unwrap().enabled);
}

#[test]
fn minimax_code_agents_use_directory_agent_md_and_keep_builtins_read_only() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let db = Database::open(&home.join("test.db")).unwrap();
    let store = MemoryStore::default();
    let data = home.join(".minimax");
    let target = PluginTarget {
        tool_id: "minimax_code".into(),
        scope: Scope::Global,
        project_path: None,
        context_id: None,
    };
    assert!(snapshot_inner(home, &target, &[]).unwrap_err().contains("数据目录不存在"));
    assert!(!data.exists());
    fs::create_dir(&data).unwrap();
    let project = home.join("project");
    fs::create_dir(&project).unwrap();
    let project_target = PluginTarget {
        tool_id: "minimax_code".into(),
        scope: Scope::Project,
        project_path: Some(project.display().to_string()),
        context_id: None,
    };
    assert!(snapshot_inner(home, &project_target, &[])
        .unwrap_err()
        .contains("项目作用域没有独立目录"));

    let builtin = "---\nname: explore\ndescription: Explore\ntools:\n  - Read\nfeatures:\n  mavis: false\n  delegation: false\n  webSearch: true\nx-mavis:\n  displayName: Explore\n---\nExplore.\n";
    write(&data.join("agents/.builtin/explore/agent.md"), builtin);
    write(&data.join("agents/.builtin/mavis/agent.md"), "---\nname: mavis\ndescription: Built-in\nfeatures:\n  mavis: true\n  delegation: true\n  webSearch: true\n---\nMavis.\n");
    write(&data.join("agents/reviewer/agent.md"), "---\nname: reviewer\ndescription: Review code\n---\nReview.\n");
    write(&data.join("agents/reviewer/crons/daily.md"), "---\nname: daily\ndescription: Cron\n---\nDaily.\n");
    write(&data.join("agents/reviewer/memory/MEMORY.md"), "---\nname: memory\ndescription: Memory\n---\nMemory.\n");
    write(&data.join("agents/notes.md"), "---\nname: notes\ndescription: Notes\n---\nNotes.\n");
    write(&data.join("agents/mavis/agent.md"), "---\nname: mavis\ndescription: Reserved\n---\nReserved.\n");
    write(&data.join("agents/main/agent.md"), "---\nname: main\ndescription: Reserved\n---\nReserved.\n");
    write(&data.join("agents/helper/agent.md"), "---\nname: other\ndescription: Mismatch\n---\nOther.\n");

    let snapshot = snapshot_inner(home, &target, &[]).unwrap();
    let names: Vec<_> = snapshot.entries.iter().map(|entry| entry.name.as_str()).collect();
    assert!(names.contains(&"explore"));
    assert!(names.contains(&"mavis"));
    assert!(names.contains(&"reviewer"));
    assert!(names.contains(&"other"));
    assert!(!names.iter().any(|name| matches!(*name, "daily" | "memory" | "notes" | "main" | "agent")));
    let explore = snapshot.entries.iter().find(|entry| entry.name == "explore").unwrap();
    assert!(explore.read_only && explore.owner.contains("内置"));
    assert!(operate_inner(&db, &store, home, &request(home, &target, "delete", Some(explore), ""), &[]).is_err());
    let mavis = snapshot.entries.iter().find(|entry| entry.name == "mavis").unwrap();
    assert!(mavis.read_only);
    assert!(Path::new(&mavis.path).ends_with(Path::new("agents/.builtin/mavis/agent.md")));
    let reviewer = snapshot.entries.iter().find(|entry| entry.name == "reviewer").unwrap();
    assert!(!reviewer.read_only && reviewer.enabled);
    let helper = snapshot.entries.iter().find(|entry| entry.name == "other").unwrap();
    assert!(helper.detail.contains("name 必须与目录名一致"));

    let template = snapshot.capability.template;
    let second_body = template.replace("name: reviewer", "name: second");
    let mut uppercase = request(home, &target, "create", None, template);
    uppercase.name = "Reviewer".into();
    assert!(operate_inner(&db, &store, home, &uppercase, &[]).is_err());
    let mut permission = request(home, &target, "create", None, "---\nname: reviewer\ndescription: Review\npermissionMode: bypassPermissions\n---\nReview.\n");
    permission.name = "second".into();
    assert!(operate_inner(&db, &store, home, &permission, &[])
        .unwrap_err()
        .contains("permissionMode"));
    let mut mismatch = request(home, &target, "create", None, "---\nname: other\ndescription: Other\n---\nOther.\n");
    mismatch.name = "second".into();
    assert!(operate_inner(&db, &store, home, &mismatch, &[])
        .unwrap_err()
        .contains("name 必须与目录名一致"));

    let mut create = request(home, &target, "create", None, &second_body);
    create.name = "second".into();
    let created = operate_inner(&db, &store, home, &create, &[]).unwrap();
    let second = created.snapshot.entries.iter().find(|entry| entry.name == "second").unwrap();
    assert!(!second.read_only && second.enabled);
    assert!(Path::new(&second.path).ends_with(Path::new("agents/second/agent.md")));
    assert!(data.join("agents/second/agent.md").is_file());

    let mut disable = request(home, &target, "disable", Some(second), &second.content);
    disable.baseline = created.snapshot.baseline;
    let disabled = operate_inner(&db, &store, home, &disable, &[]).unwrap();
    let parked = disabled.snapshot.entries.iter().find(|entry| entry.name == "second").unwrap();
    assert!(!parked.enabled && !parked.read_only);
    assert!(Path::new(&parked.path).ends_with(Path::new(".cliora-disabled-agents/agents/second/agent.md")));
    let mut enable = request(home, &target, "enable", Some(parked), &parked.content);
    enable.baseline = disabled.snapshot.baseline;
    let enabled = operate_inner(&db, &store, home, &enable, &[]).unwrap();
    let restored = enabled.snapshot.entries.iter().find(|entry| entry.name == "second").unwrap();
    assert!(restored.enabled);
    assert!(Path::new(&restored.path).ends_with(Path::new("agents/second/agent.md")));
}
