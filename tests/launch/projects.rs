use super::*;

#[test]
fn project_identity_survives_relink_and_unicode_path_without_losing_tool_model() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("app.db")).unwrap();
    let first = temp.path().join("工作 project [one]");
    let moved = temp.path().join("重命名 project [two]");
    std::fs::create_dir(&first).unwrap();
    let registry = Registry::builtins();
    let project = add(
        &db,
        &registry,
        first.to_str().unwrap(),
        Some("工作项目"),
        Some("grok"),
    )
    .unwrap();
    assert_eq!(project.preferred_tool.as_deref(), Some("grok"));
    let existing = add(&db, &registry, first.to_str().unwrap(), None, None).unwrap();
    assert_eq!(existing.id, project.id);
    assert_eq!(existing.name, "工作项目");
    assert!(add(
        &db,
        &registry,
        first.to_str().unwrap(),
        None,
        Some("unknown")
    )
    .is_err());
    let updated =
        set_model_override(&db, &registry, &project.id, "grok", Some("grok-4.7")).unwrap();
    assert_eq!(updated.model_overrides["grok"], "grok-4.7");
    record_applied_profile(&db, &first, "grok", "profile-1").unwrap();
    assert!(
        set_model_override(&db, &registry, &project.id, "pi", Some("model"))
            .unwrap_err()
            .contains("不支持")
    );
    std::fs::rename(&first, &moved).unwrap();
    assert!(!get(&db, &project.id).unwrap().available);
    let relinked = relink(&db, &project.id, moved.to_str().unwrap()).unwrap();
    assert_eq!(relinked.id, project.id);
    assert!(relinked.available);
    assert_eq!(relinked.model_overrides["grok"], "grok-4.7");
    assert_eq!(relinked.selected_profiles["grok"], "profile-1");
    assert!(relinked.applied_profiles.is_empty());
    assert_eq!(relinked.preferred_tool.as_deref(), Some("grok"));
    assert_eq!(list(&db).unwrap().len(), 1);
    assert!(relink(&db, &project.id, first.to_str().unwrap()).is_err());
}

#[test]
fn model_override_rejects_controls_and_can_be_removed() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("app.db")).unwrap();
    let registry = Registry::builtins();
    let project = add(
        &db,
        &registry,
        temp.path().to_str().unwrap(),
        Some("Demo"),
        None,
    )
    .unwrap();
    assert!(set_model_override(&db, &registry, &project.id, "grok", Some("bad\nmodel")).is_err());
    let project =
        set_model_override(&db, &registry, &project.id, "grok", Some("grok-4.7")).unwrap();
    assert_eq!(project.model_overrides.len(), 1);
    let project = set_model_override(&db, &registry, &project.id, "grok", None).unwrap();
    assert!(project.model_overrides.is_empty());
}
