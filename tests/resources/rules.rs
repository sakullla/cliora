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
    let external = plan_host_rule_sync(&[rule.clone()], &RuleHostState::default(), &[global_codex("hand written\n")], &[], &rule.id, 1, &global_tools(&["codex"], false)).unwrap();
    assert!(!external.commit);
    assert!(external.writes.is_empty());
    assert_eq!(external.results[0].status, "conflict");
    assert_eq!(external.state, RuleHostState::default());
    let written = plan_host_rule_sync(&[rule.clone()], &RuleHostState::default(), &[global_codex("")], &[], &rule.id, 1, &global_tools(&["codex"], false)).unwrap();
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
