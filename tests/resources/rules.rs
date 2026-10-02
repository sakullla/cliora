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
