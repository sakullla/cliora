use super::*;

#[test]
fn library_crud_search_project_filter_and_optimistic_versions_survive_restart() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("cliora.db");
    let id;
    {
        let db = Database::open(&path).unwrap();
        let project = crate::projects::add(
            &db,
            &crate::native::adapters::Registry::builtins(),
            temp.path().to_str().unwrap(),
            Some("测试项目"),
            None,
        )
        .unwrap();
        let first = save(
            &db,
            LibraryDraft {
                id: None,
                kind: LibraryKind::Prompt,
                title: "  代码审查  ".into(),
                body: "请审查完整正文中的并发问题".into(),
                category: " 开发 ".into(),
                project_id: Some(project.id.clone()),
                expected_version: None,
            },
        )
        .unwrap();
        id = first.id.clone();
        assert_eq!(first.title, "代码审查");
        assert_eq!(first.category, "开发");
        assert_eq!(
            list(&db, LibraryKind::Prompt, Some(&project.id), "并发")
                .unwrap()
                .len(),
            1
        );
        assert!(list(&db, LibraryKind::Prompt, None, "不存在")
            .unwrap()
            .is_empty());
        assert!(list(&db, LibraryKind::Rule, None, "").unwrap().is_empty());
        let edited = save(
            &db,
            LibraryDraft {
                id: Some(id.clone()),
                kind: LibraryKind::Prompt,
                title: first.title.clone(),
                body: "更新后的完整内容".into(),
                category: first.category.clone(),
                project_id: Some(project.id),
                expected_version: Some(first.version),
            },
        )
        .unwrap();
        assert_eq!(edited.version, 2);
        assert!(save(
            &db,
            LibraryDraft {
                id: Some(id.clone()),
                kind: LibraryKind::Prompt,
                title: "过期".into(),
                body: String::new(),
                category: String::new(),
                project_id: None,
                expected_version: Some(1),
            }
        )
        .is_err());
    }
    let db = Database::open(&path).unwrap();
    assert_eq!(get(&db, &id).unwrap().body, "更新后的完整内容");
    assert!(delete(&db, &id, 1).is_err());
    delete(&db, &id, 2).unwrap();
    assert!(list(&db, LibraryKind::Prompt, None, "").unwrap().is_empty());
}
