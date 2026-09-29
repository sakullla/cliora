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
    let target = RuleTarget {
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
    assert_eq!(std::fs::read_to_string(path).unwrap(), "new rule");
}
