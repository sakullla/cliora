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
            &crate::adapters::Registry::builtins(),
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

#[test]
fn multi_repository_legacy_body_edit_preserves_new_scope_and_tags_but_cannot_drop_them() {
    let temp=tempfile::tempdir().unwrap(); let db=Database::open(&temp.path().join("db.sqlite")).unwrap();
    let item=save(&db,LibraryDraft{id:None,kind:LibraryKind::Prompt,title:"Prompt".into(),body:"before".into(),category:"legacy".into(),project_id:None,expected_version:None}).unwrap();
    let meta=crate::prompts::PromptMetadata{scope:crate::prompts::PromptScope::Repository{repository_id:"retained-orphan".into()},tags:vec!["new-tag".into(),"other-tag".into()]};
    db.with_connection(|conn|crate::prompts::restore_metadata(conn,&item.id,&meta)).unwrap();
    let edited=save(&db,LibraryDraft{id:Some(item.id.clone()),kind:LibraryKind::Prompt,title:"Updated".into(),body:"after".into(),category:"legacy".into(),project_id:None,expected_version:Some(item.version)}).unwrap();
    let metadata=crate::prompts::export_metadata(&db).unwrap();
    assert_eq!(metadata[&item.id],meta);
    assert_eq!(edited.body,"after");
    db.with_connection(|conn|{conn.execute("INSERT INTO projects(id,name,path,preferred_tool,last_opened) VALUES('different-project','Other',NULL,NULL,0)",[]).unwrap();Ok(())}).unwrap();
    assert!(save(&db,LibraryDraft{id:Some(item.id.clone()),kind:LibraryKind::Prompt,title:edited.title.clone(),body:"must not write".into(),category:"replacement tags".into(),project_id:Some("different-project".into()),expected_version:Some(edited.version)}).unwrap_err().contains("旧格式不能覆盖"));
    assert_eq!(get(&db,&item.id).unwrap().body,"after");
    assert_eq!(crate::prompts::export_metadata(&db).unwrap()[&item.id],meta);
}
