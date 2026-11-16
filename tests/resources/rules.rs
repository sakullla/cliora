use super::*;
use std::collections::HashMap;
use std::sync::Mutex;

struct MemoryStore(Mutex<HashMap<String, String>>);
impl CredentialStore for MemoryStore {
    fn put(&self, key: &str, value: &str) -> Result<(), String> {
        self.0.lock().unwrap().insert(key.into(), value.into());
        Ok(())
    }
    fn get(&self, key: &str) -> Result<String, String> {
        self.0
            .lock()
            .unwrap()
            .get(key)
            .cloned()
            .ok_or_else(|| "missing".into())
    }
    fn delete(&self, key: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(key);
        Ok(())
    }
}

#[test]
fn rule_preview_requires_fresh_confirm_and_preserves_external_edit() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("test.db")).unwrap();
    let credential = MemoryStore(Mutex::new(HashMap::new()));
    let registry = Registry::builtins();
    let project = temp.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    let rule = library::save(
        &db,
        library::LibraryDraft {
            id: None,
            kind: LibraryKind::Rule,
            title: "Rule".into(),
            body: "new rule".into(),
            category: String::new(),
            project_id: None,
            expected_version: None,
        },
    )
    .unwrap();
    let target = RuleTarget { context_id: None,
        tool_id: "codex".into(),
        scope: Scope::Project,
        project_path: Some(project.display().to_string()),
        baseline_hash: None,
    };
    let path = project.join("AGENTS.md");
    std::fs::write(&path, "old rule").unwrap();
    let first_preview = preview(&db, &registry, temp.path(), &rule.id, vec![target.clone()]);
    assert_eq!(first_preview[0].existing, "old rule");
    assert_eq!(first_preview[0].proposed, "new rule");
    std::fs::write(&path, "external rule").unwrap();
    let failed = apply(
        &db,
        &credential,
        &registry,
        temp.path(),
        &rule.id,
        rule.version,
        vec![first_preview[0].target.clone()],
    );
    assert_eq!(failed[0].status, "failed");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "external rule");
    let refreshed = preview(&db, &registry, temp.path(), &rule.id, vec![target]);
    let applied = apply(
        &db,
        &credential,
        &registry,
        temp.path(),
        &rule.id,
        rule.version,
        vec![refreshed[0].target.clone()],
    );
    assert_eq!(applied[0].status, "written");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "new rule");
    let target=refreshed[0].target.clone();
    set_enabled(&db,&credential,&registry,temp.path(),&target,false).unwrap();
    assert!(!enabled(&db,&registry,temp.path(),&target).unwrap());
    set_enabled(&db,&credential,&registry,temp.path(),&target,false).unwrap();
    std::fs::write(&path,"external while disabled").unwrap();
    assert!(set_enabled(&db,&credential,&registry,temp.path(),&target,true).is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(),"external while disabled");
    std::fs::write(&path,"").unwrap();
    set_enabled(&db,&credential,&registry,temp.path(),&target,true).unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(),"new rule");
    assert!(save_current(&db,&credential,&registry,temp.path(),&target,"old rule","ours").is_err());
    save_current(&db,&credential,&registry,temp.path(),&target,"new rule","direct edited").unwrap();
    let native_path=std::path::PathBuf::from(read_current(&db,&registry,temp.path(),&target).unwrap().path);
    let backups=transaction::recent_backups(&db,&native_path).unwrap();
    let id=&backups[0].transaction_id;
    let diff=transaction::preview_backup(&db,&credential,&native_path,id).unwrap();
    assert_eq!(diff.original,"new rule");
    assert!(transaction::restore_backup(&db,&credential,&native_path,id,"stale baseline",|_|Ok(())).is_err());
    transaction::restore_backup(&db,&credential,&native_path,id,"direct edited",|_|Ok(())).unwrap();
    assert_eq!(std::fs::read_to_string(path).unwrap(),"new rule");
}

#[test]
fn selected_rules_are_concatenated_and_an_external_file_is_kept() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("test.db")).unwrap();
    let credential = MemoryStore(Mutex::new(HashMap::new()));
    let registry = Registry::builtins();
    let project = temp.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    let first = library::save(&db, library::LibraryDraft { id: None, kind: LibraryKind::Rule, title: "测试".into(), body: "先跑测试。".into(), category: String::new(), project_id: None, expected_version: None }).unwrap();
    let second = library::save(&db, library::LibraryDraft { id: None, kind: LibraryKind::Rule, title: "格式".into(), body: "使用 rustfmt。".into(), category: String::new(), project_id: None, expected_version: None }).unwrap();
    let selection = |id: &str, allow_replace| RuleClientSelection { tool_ids: vec![id.into()], scope: Scope::Project, project_path: Some(project.display().to_string()), allow_replace };
    let written = sync_clients(&db, &credential, &registry, temp.path(), &first.id, first.version, selection("codex", false)).unwrap();
    assert_eq!(written[0].status, "written");
    sync_clients(&db, &credential, &registry, temp.path(), &second.id, second.version, selection("codex", false)).unwrap();
    let path = project.join("AGENTS.md");
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(text.find("# 测试").unwrap() < text.find("# 格式").unwrap());
    assert!(text.contains("先跑测试。"));
    assert!(text.contains("使用 rustfmt。"));
    std::fs::write(&path, "外部改过\n").unwrap();
    let blocked = sync_clients(&db, &credential, &registry, temp.path(), &first.id, first.version, selection("codex", false)).unwrap();
    assert_eq!(blocked[0].status, "conflict");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "外部改过\n");
    let replaced = sync_clients(&db, &credential, &registry, temp.path(), &first.id, first.version, selection("codex", true)).unwrap();
    assert_eq!(replaced[0].status, "written");
    let restored = std::fs::read_to_string(&path).unwrap();
    assert!(restored.contains("# 测试"));
    assert!(restored.contains("# 格式"));
    let removed = sync_clients(&db, &credential, &registry, temp.path(), &first.id, first.version, RuleClientSelection { tool_ids: vec![], scope: Scope::Project, project_path: Some(project.display().to_string()), allow_replace: false }).unwrap();
    assert_eq!(removed[0].status, "written");
    let left = std::fs::read_to_string(&path).unwrap();
    assert!(!left.contains("# 测试"));
    assert!(left.contains("# 格式"));
}

#[test]
fn new_adapter_rule_scopes_use_native_paths_and_shared_conflict_checks() {
    let temp = tempfile::tempdir().unwrap(); let home = temp.path();
    let project = home.join("project"); std::fs::create_dir_all(&project).unwrap();
    let db = Database::open(&home.join("test.db")).unwrap();
    let registry = Registry::builtins(); let store = MemoryStore(Mutex::new(HashMap::new()));
    for (id, global) in [("kimi_code", ".kimi-code/AGENTS.md"), ("qoder_cn", ".qoder-cn/AGENTS.md"), ("deepseek", ".dsh/AGENTS.md"), ("zcode", ".zcode/AGENTS.md")] {
        let adapter = registry.get(id).unwrap();
        assert!(adapter.descriptor().management.rules.global && adapter.descriptor().management.rules.project);
        for scope in [Scope::Global, Scope::Project] {
            let target = RuleTarget { context_id: None, tool_id: id.into(), scope, project_path: if scope == Scope::Project { Some(project.display().to_string()) } else { None }, baseline_hash: None };
            let expected = if scope == Scope::Project { project.join("AGENTS.md") } else { home.join(global) };
            assert_eq!(path_for(&db, &registry, home, &target).unwrap(), if scope == Scope::Project { project.canonicalize().unwrap().join("AGENTS.md") } else { expected.clone() });
            let before = read_current(&db, &registry, home, &target).unwrap();
            let instructions = format!("native instructions for {id}");
            save_current(&db, &store, &registry, home, &target, &before.text, &instructions).unwrap();
            assert_eq!(std::fs::read_to_string(&expected).unwrap(), instructions);
            assert!(save_current(&db, &store, &registry, home, &target, "old", "overwrite").is_err());
        }
    }
    std::fs::create_dir_all(project.join(".kimi-code")).unwrap();
    std::fs::write(project.join(".kimi-code/AGENTS.md"), "nested instructions").unwrap();
    assert_eq!(registry.get("kimi_code").unwrap().rule_path(Scope::Project, home, Some(&project)).unwrap(), project.join(".kimi-code/AGENTS.md"));
}

fn remote_rule(id: &str, title: &str, body: &str) -> library::LibraryItem {
    library::LibraryItem { id: id.into(), kind: LibraryKind::Rule, title: title.into(), body: body.into(), category: String::new(), project_id: None, version: 1, updated_at: 1 }
}

fn global_codex(existing: &str) -> HostRuleFile {
    HostRuleFile { tool_id: "codex".into(), scope_key: "global".into(), path: "$HOME/.codex/AGENTS.md".into(), existing: existing.into() }
}

fn global_tools(tools: &[&str], allow_replace: bool) -> RuleClientSelection {
    RuleClientSelection { tool_ids: tools.iter().map(|item| (*item).to_owned()).collect(), scope: Scope::Global, project_path: None, allow_replace }
}

#[test]
fn remote_rule_plan_uses_the_host_library_and_leaves_an_external_file() {
    let missing = plan_host_rule_sync(&[], &RuleHostState::default(), &[], &[], "missing", 1, &global_tools(&["codex"], false)).unwrap_err();
    assert_eq!(missing, "资料条目不存在");
    let rule = remote_rule("rule-1", "Keep", "stay remote");
    let external = plan_host_rule_sync(std::slice::from_ref(&rule), &RuleHostState::default(), &[global_codex("hand written\n")], &[], &rule.id, 1, &global_tools(&["codex"], false)).unwrap();
    assert!(!external.commit);
    assert!(external.writes.is_empty());
    assert_eq!(external.results[0].status, "conflict");
    assert_eq!(external.state, RuleHostState::default());
    let written = plan_host_rule_sync(std::slice::from_ref(&rule), &RuleHostState::default(), &[global_codex("")], &[], &rule.id, 1, &global_tools(&["codex"], false)).unwrap();
    assert!(written.commit);
    assert_eq!(written.writes[0].path, "$HOME/.codex/AGENTS.md");
    assert_eq!(written.writes[0].contents, "# Keep\n\nstay remote\n");
    assert_eq!(written.state.placements.len(), 1);
    assert_eq!(written.state.placements[0].tool_id, "codex");
    assert!(!written.writes[0].contents.contains("local-only-rule"));
}

#[test]
fn remote_rule_plan_removes_one_section_without_wiping_another() {
    let first = remote_rule("rule-1", "Keep", "stay remote");
    let second = remote_rule("rule-2", "Other", "also remote");
    let existing = "# Keep\n\nstay remote\n\n# Other\n\nalso remote\n";
    let state = RuleHostState {
        placements: vec![
            RuleMembership { rule_id: "rule-1".into(), tool_id: "codex".into(), scope_key: "global".into(), position: 1 },
            RuleMembership { rule_id: "rule-2".into(), tool_id: "codex".into(), scope_key: "global".into(), position: 2 },
        ],
        files: vec![RuleFileRecord { tool_id: "codex".into(), scope_key: "global".into(), managed_hash: crate::native::transaction::fingerprint(existing.as_bytes()) }],
    };
    let removed = plan_host_rule_sync(&[first.clone(), second], &state, &[global_codex(existing)], &[], &first.id, 1, &global_tools(&[], false)).unwrap();
    assert!(removed.commit);
    assert_eq!(removed.writes[0].contents, "# Other\n\nalso remote\n");
    assert!(removed.state.placements.iter().all(|item| item.rule_id != "rule-1"));
    assert!(removed.state.placements.iter().any(|item| item.rule_id == "rule-2"));
    let blocked = plan_host_rule_sync(&[first], &state, &[global_codex("hand written\n")], &[], "rule-1", 1, &global_tools(&[], false)).unwrap();
    assert!(!blocked.commit);
    assert!(blocked.writes.is_empty());
    assert_eq!(blocked.results[0].status, "conflict");
    assert_eq!(blocked.state.placements.len(), 2);
}

#[test]
fn empty_create_bodies_follow_the_native_file_layout() {
    let temp = tempfile::tempdir().unwrap(); let home = temp.path();
    let project = home.join("project"); std::fs::create_dir_all(&project).unwrap();
    let db = Database::open(&home.join("create.db")).unwrap();
    let registry = Registry::builtins(); let store = MemoryStore(Mutex::new(HashMap::new()));
    // Cursor .mdc keeps the historical frontmatter template.
    let cursor = RuleTarget { context_id: None, tool_id: "cursor".into(), scope: Scope::Project, project_path: Some(project.display().to_string()), baseline_hash: None };
    create_file(&db, &store, &registry, home, &cursor, "review", "").unwrap();
    assert_eq!(
        std::fs::read_to_string(project.join(".cursor/rules/review.mdc")).unwrap(),
        "---\ndescription: \"\"\nalwaysApply: false\n---\n"
    );
    // Kiro steering .md files are plain markdown: no Cursor-style
    // alwaysApply frontmatter is injected into a format Kiro does not read.
    let kiro = RuleTarget { context_id: None, tool_id: "kiro".into(), scope: Scope::Project, project_path: Some(project.display().to_string()), baseline_hash: None };
    create_file(&db, &store, &registry, home, &kiro, "security", "").unwrap();
    let created = std::fs::read_to_string(project.join(".kiro/steering/security.md")).unwrap();
    assert_eq!(created, "# security\n");
    assert!(!created.contains("alwaysApply"));
    // The new file appears in the catalog under its own extension and both
    // stay whole-file editable through the shared service.
    let files = list_files(&db, &registry, home, &kiro).unwrap();
    let names: Vec<&str> = files.iter().map(|file| file.name.as_str()).collect();
    assert!(names.contains(&"security.md"), "{names:?}");
    assert!(files.iter().all(|file| file.kind != "inert"));
}

#[test]
fn catalog_policy_defaults_keep_cursor_and_kiro_on_the_historical_whitelist() {
    let temp = tempfile::tempdir().unwrap(); let home = temp.path();
    let project = home.join("project"); std::fs::create_dir_all(&project).unwrap();
    let db = Database::open(&home.join("policy.db")).unwrap();
    let registry = Registry::builtins(); let store = MemoryStore(Mutex::new(HashMap::new()));
    const TEMPLATE: &str = "---\ndescription: \"\"\nalwaysApply: false\n---\n";
    // Service calls compare canonicalized spec paths, so every operation
    // below addresses files through the paths the listing itself returned.
    let catalog_path = |files: &Vec<NativeRuleFile>, name: &str| {
        files.iter().find(|file| file.name == name).unwrap().path.clone()
    };
    // Cursor: the .mdc lifecycle keeps delete + toggle; the hierarchical
    // AGENTS.md entry stays editable only.
    let cursor = RuleTarget { context_id: None, tool_id: "cursor".into(), scope: Scope::Project, project_path: Some(project.display().to_string()), baseline_hash: None };
    create_file(&db, &store, &registry, home, &cursor, "lifecycle", "").unwrap();
    let mdc = catalog_path(&list_files(&db, &registry, home, &cursor).unwrap(), "lifecycle.mdc");
    set_file_enabled(&db, &store, &registry, home, &cursor, &mdc, false, TEMPLATE).unwrap();
    let parked = catalog_path(&list_files(&db, &registry, home, &cursor).unwrap(), "lifecycle.mdc");
    assert!(parked.replace('\\', "/").contains(".cliora-disabled-rules"), "停用移入 Cliora 槽位：{parked}");
    set_file_enabled(&db, &store, &registry, home, &cursor, &parked, true, TEMPLATE).unwrap();
    let restored = catalog_path(&list_files(&db, &registry, home, &cursor).unwrap(), "lifecycle.mdc");
    assert!(restored.replace('\\', "/").ends_with(".cursor/rules/lifecycle.mdc"), "{restored}");
    delete_file(&db, &store, &registry, home, &cursor, &restored, TEMPLATE).unwrap();
    assert!(list_files(&db, &registry, home, &cursor).unwrap().iter().all(|file| file.name != "lifecycle.mdc"));
    std::fs::write(project.join("AGENTS.md"), "cursor agents").unwrap();
    let agents = list_files(&db, &registry, home, &cursor).unwrap()
        .into_iter().find(|file| file.kind == "agents").unwrap();
    assert!(agents.writable && !agents.removable && !agents.toggleable);
    assert!(delete_file(&db, &store, &registry, home, &cursor, &agents.path, "cursor agents")
        .unwrap_err()
        .contains("不支持删除"));
    assert!(set_file_enabled(&db, &store, &registry, home, &cursor, &agents.path, false, "cursor agents")
        .unwrap_err()
        .contains("不支持启停"));
    // Kiro: the steering .md and permissions entries never delete/toggle.
    let kiro = RuleTarget { context_id: None, tool_id: "kiro".into(), scope: Scope::Project, project_path: Some(project.display().to_string()), baseline_hash: None };
    create_file(&db, &store, &registry, home, &kiro, "security", "").unwrap();
    let steering = list_files(&db, &registry, home, &kiro).unwrap()
        .into_iter().find(|file| file.name == "security.md").unwrap();
    assert!(steering.writable && !steering.removable && !steering.toggleable);
    assert!(delete_file(&db, &store, &registry, home, &kiro, &steering.path, "# security\n")
        .unwrap_err()
        .contains("不支持删除"));
    // The global catalog stays project-only where not declared: cursor and
    // kiro keep their recorded global reasons instead of a global listing.
    for tool in ["cursor", "kiro"] {
        let global = RuleTarget { context_id: None, tool_id: tool.into(), scope: Scope::Global, project_path: None, baseline_hash: None };
        assert!(list_files(&db, &registry, home, &global).is_err(), "{tool} 全局目录必须被拒绝");
    }
}

#[test]
fn antigravity_catalog_rules_follow_the_native_directories() {
    let temp = tempfile::tempdir().unwrap(); let home = temp.path();
    let project = home.join("project");
    let rules = project.join(".agents").join("rules");
    std::fs::create_dir_all(&rules).unwrap();
    std::fs::write(rules.join("review.md"), "---\ntrigger: manual\n---\n先跑测试。").unwrap();
    std::fs::write(project.join("AGENTS.md"), "root agents").unwrap();
    let db = Database::open(&home.join("agy-rules.db")).unwrap();
    let registry = Registry::builtins(); let store = MemoryStore(Mutex::new(HashMap::new()));
    let target = RuleTarget { context_id: None, tool_id: "antigravity".into(), scope: Scope::Project, project_path: Some(project.display().to_string()), baseline_hash: None };
    // The listing carries the adapter-declared per-kind operation policy.
    let files = list_files(&db, &registry, home, &target).unwrap();
    let review = files.iter().find(|file| file.kind == "md").unwrap();
    assert_eq!(review.name, "review.md");
    assert!(review.enabled && review.writable && review.removable && review.toggleable);
    let agents = files.iter().find(|file| file.kind == "agents").unwrap();
    assert!(agents.writable && !agents.removable && !agents.toggleable);
    // Saving goes through the shared transaction with baseline checks.
    let updated = "---\ntrigger: manual\n---\n先跑测试，再提交。";
    save_file(&db, &store, &registry, home, &target, &review.path, &review.text, updated).unwrap();
    assert_eq!(std::fs::read_to_string(rules.join("review.md")).unwrap(), updated);
    std::fs::write(rules.join("review.md"), "外部进程改过").unwrap();
    let conflict = save_file(&db, &store, &registry, home, &target, &review.path, &review.text, "再写一次").unwrap_err();
    assert!(conflict.contains("外部修改"), "{conflict}");
    // Disable/enable relocates between the scan directory and the Cliora
    // slot; the content itself never changes. Operations address files
    // through the paths the listing returned (canonicalized on the service
    // side), never through locally re-joined paths.
    set_file_enabled(&db, &store, &registry, home, &target, &review.path, false, "外部进程改过").unwrap();
    assert!(!rules.join("review.md").exists());
    let parked = list_files(&db, &registry, home, &target).unwrap()
        .into_iter().find(|file| file.name == "review.md").unwrap();
    assert!(!parked.enabled, "槽位中的规则不加载");
    assert_eq!(parked.text, "外部进程改过");
    set_file_enabled(&db, &store, &registry, home, &target, &parked.path, true, "外部进程改过").unwrap();
    assert_eq!(std::fs::read_to_string(rules.join("review.md")).unwrap(), "外部进程改过");
    // Delete removes the directory rule; the hierarchical document refuses.
    delete_file(&db, &store, &registry, home, &target, &review.path, "外部进程改过").unwrap();
    assert!(!rules.join("review.md").exists());
    assert!(delete_file(&db, &store, &registry, home, &target, &agents.path, "root agents")
        .unwrap_err()
        .contains("不支持删除"));
    // Created rules carry the verified always_on trigger frontmatter on both
    // scopes; the global create lands in ~/.gemini/config/rules/.
    create_file(&db, &store, &registry, home, &target, "style", "").unwrap();
    assert_eq!(
        std::fs::read_to_string(rules.join("style.md")).unwrap(),
        "---\ntrigger: always_on\n---\n# style\n"
    );
    let global = RuleTarget { context_id: None, tool_id: "antigravity".into(), scope: Scope::Global, project_path: None, baseline_hash: None };
    create_file(&db, &store, &registry, home, &global, "globalstyle", "").unwrap();
    let global_rules = home.join(".gemini").join("config").join("rules");
    assert_eq!(
        std::fs::read_to_string(global_rules.join("globalstyle.md")).unwrap(),
        "---\ntrigger: always_on\n---\n# globalstyle\n"
    );
    // The global catalog lists the rules folder plus the config-root
    // hierarchical documents the changelog names as global customizations.
    std::fs::write(home.join(".gemini").join("config").join("AGENTS.md"), "global agents").unwrap();
    std::fs::write(home.join(".gemini").join("config").join("GEMINI.md"), "global gemini").unwrap();
    let global_files = list_files(&db, &registry, home, &global).unwrap();
    let summary: Vec<(&str, bool)> = global_files.iter().map(|file| (file.kind.as_str(), file.enabled)).collect();
    assert_eq!(
        summary,
        vec![("agents", true), ("gemini", true), ("md", true)],
        "{global_files:?}"
    );
    assert!(global_files.iter().all(|file| file.writable));
}

#[test]
fn antigravity_long_term_rules_distribute_to_the_agents_standard_documents() {
    let temp = tempfile::tempdir().unwrap(); let home = temp.path();
    let project = home.join("project"); std::fs::create_dir_all(&project).unwrap();
    let config = home.join(".gemini").join("config");
    std::fs::create_dir_all(&config).unwrap();
    let db = Database::open(&home.join("agy-distribute.db")).unwrap();
    let registry = Registry::builtins(); let store = MemoryStore(Mutex::new(HashMap::new()));
    // The single-file port resolves the hierarchical AGENTS.md documents.
    let global = RuleTarget { context_id: None, tool_id: "antigravity".into(), scope: Scope::Global, project_path: None, baseline_hash: None };
    let global_path = home.join(".gemini").join("config").join("AGENTS.md");
    let scoped = RuleTarget { context_id: None, tool_id: "antigravity".into(), scope: Scope::Project, project_path: Some(project.display().to_string()), baseline_hash: None };
    assert_eq!(path_for(&db, &registry, home, &global).unwrap(), global_path);
    assert_eq!(
        path_for(&db, &registry, home, &scoped).unwrap(),
        project.canonicalize().unwrap().join("AGENTS.md")
    );
    // Distribution composes into the global document with the shared
    // conflict gate; an external edit blocks the write until confirmed.
    let first = library::save(&db, library::LibraryDraft { id: None, kind: LibraryKind::Rule, title: "测试".into(), body: "先跑测试。".into(), category: String::new(), project_id: None, expected_version: None }).unwrap();
    let selection = RuleClientSelection { tool_ids: vec!["antigravity".into()], scope: Scope::Global, project_path: None, allow_replace: false };
    let written = sync_clients(&db, &store, &registry, home, &first.id, first.version, selection.clone()).unwrap();
    assert_eq!(written[0].status, "written");
    let text = std::fs::read_to_string(&global_path).unwrap();
    assert!(text.contains("# 测试") && text.contains("先跑测试。"), "{text}");
    std::fs::write(&global_path, "外部改过\n").unwrap();
    let blocked = sync_clients(&db, &store, &registry, home, &first.id, first.version, selection.clone()).unwrap();
    assert_eq!(blocked[0].status, "conflict");
    assert_eq!(std::fs::read_to_string(&global_path).unwrap(), "外部改过\n");
    let replaced = RuleClientSelection { tool_ids: vec!["antigravity".into()], scope: Scope::Global, project_path: None, allow_replace: true };
    let confirmed = sync_clients(&db, &store, &registry, home, &first.id, first.version, replaced).unwrap();
    assert_eq!(confirmed[0].status, "written");
    assert!(std::fs::read_to_string(&global_path).unwrap().contains("# 测试"));
    // Editing the document directly keeps the same shared protections.
    let current = read_current(&db, &registry, home, &global).unwrap();
    save_current(&db, &store, &registry, home, &global, &current.text, "直接编辑").unwrap();
    assert!(save_current(&db, &store, &registry, home, &global, "旧正文", "覆盖").is_err());
    assert_eq!(std::fs::read_to_string(&global_path).unwrap(), "直接编辑");
}
