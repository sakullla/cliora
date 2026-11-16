use super::*;
const HOST: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
fn db() -> Database {
    Database::open(Path::new(":memory:")).unwrap()
}
fn draft(title: &str, body: &str, scope: PromptScope) -> PromptDraft {
    PromptDraft {
        id: None,
        title: title.into(),
        body: body.into(),
        scope,
        tags: vec!["review".into()],
        expected_version: None,
    }
}
fn context(db: &Database) -> (String, String) {
    let workspace = crate::workspaces::create(db, HOST, "Business").unwrap();
    let repo = Uuid::new_v4().to_string();
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO workspace_repositories(id,name) VALUES(?1,'Repo')",
            [&repo],
        )
        .map_err(sql)?;
        conn.execute(
            "INSERT INTO workspace_members(workspace_id,repository_id) VALUES(?1,?2)",
            params![workspace.id, repo],
        )
        .map_err(sql)?;
        Ok(())
    })
    .unwrap();
    (workspace.id, repo)
}
#[test]
fn scope_and_full_body_query_return_bounded_summaries_and_enforce_membership() {
    let db = db();
    let (a, repo) = context(&db);
    let (b, _) = context(&db);
    save(&db, &draft("global", "shared", PromptScope::Global)).unwrap();
    save(
        &db,
        &draft(
            "same title",
            &format!("{}unique-tail", "x".repeat(600)),
            PromptScope::Workspace {
                workspace_id: a.clone(),
            },
        ),
    )
    .unwrap();
    save(
        &db,
        &draft(
            "same title",
            "other project",
            PromptScope::Workspace {
                workspace_id: b.clone(),
            },
        ),
    )
    .unwrap();
    save(
        &db,
        &draft(
            "repo",
            "specific",
            PromptScope::Repository {
                repository_id: repo.clone(),
            },
        ),
    )
    .unwrap();
    let scope = PromptQuery {
        workspace_id: Some(a.clone()),
        repository_id: Some(repo.clone()),
        ..Default::default()
    };
    assert_eq!(query(&db, &scope).unwrap().total, 3);
    let found = query(
        &db,
        &PromptQuery {
            search: "unique-tail".into(),
            ..scope.clone()
        },
    )
    .unwrap();
    assert_eq!(found.total, 1);
    assert!(!found.items[0].preview.contains("unique-tail"));
    assert_eq!(
        get(&db, &found.items[0].id, Some(found.items[0].version))
            .unwrap()
            .body
            .len(),
        611
    );
    assert!(query(
        &db,
        &PromptQuery {
            workspace_id: Some(b),
            repository_id: Some(repo),
            ..Default::default()
        }
    )
    .is_err());
    assert_eq!(query(&db, &PromptQuery::default()).unwrap().total, 1);
    assert_eq!(
        query(
            &db,
            &PromptQuery {
                include_other_scopes: true,
                ..Default::default()
            }
        )
        .unwrap()
        .total,
        4
    );
}
#[test]
fn legacy_project_scope_resolves_exactly_and_old_body_edits_preserve_metadata() {
    let temp = tempfile::tempdir().unwrap();
    let db = db();
    let project = crate::projects::add(
        &db,
        &crate::adapters::Registry::builtins(),
        temp.path().to_str().unwrap(),
        Some("Old"),
        None,
    )
    .unwrap();
    let old = crate::library::save(
        &db,
        crate::library::LibraryDraft {
            id: None,
            kind: crate::library::LibraryKind::Prompt,
            title: "Old prompt".into(),
            body: "before".into(),
            category: "开发,review".into(),
            project_id: Some(project.id.clone()),
            expected_version: None,
        },
    )
    .unwrap();
    let unresolved = get(&db, &old.id, None).unwrap();
    assert_eq!(
        unresolved.scope,
        PromptScope::Unresolved {
            legacy_project_id: project.id.clone()
        }
    );
    crate::workspaces::seed_legacy(&db, HOST).unwrap();
    let resolved = get(&db, &old.id, None).unwrap();
    assert_eq!(
        resolved.scope,
        PromptScope::Workspace {
            workspace_id: project.id.clone()
        }
    );
    assert_eq!(resolved.tags, vec!["开发", "review"]);
    crate::library::save(
        &db,
        crate::library::LibraryDraft {
            id: Some(old.id.clone()),
            kind: crate::library::LibraryKind::Prompt,
            title: old.title,
            body: "after".into(),
            category: String::new(),
            project_id: Some(project.id),
            expected_version: Some(old.version),
        },
    )
    .unwrap();
    let updated = get(&db, &old.id, None).unwrap();
    assert_eq!(updated.scope, resolved.scope);
    assert_eq!(updated.tags, resolved.tags);
    assert_eq!(updated.body, "after");
}
#[test]
fn partial_batch_retry_is_idempotent_and_changed_success_input_is_rejected() {
    let db = db();
    let valid = BatchItem {
        item_id: Uuid::new_v4().to_string(),
        action: BatchAction::Create,
        draft: draft("one", "body", PromptScope::Global),
    };
    let invalid = BatchItem {
        item_id: Uuid::new_v4().to_string(),
        action: BatchAction::Create,
        draft: draft("", "body", PromptScope::Global),
    };
    let mut batch = PromptBatch {
        operation_id: Uuid::new_v4().to_string(),
        items: vec![valid, invalid],
    };
    let first = apply_batch(&db, &batch).unwrap();
    assert_eq!(first.items[0].status, BatchStatus::Saved);
    assert_eq!(first.items[1].status, BatchStatus::Failed);
    assert_eq!(query(&db, &PromptQuery::default()).unwrap().total, 1);
    batch.items[1].draft.title = "two".into();
    let retry = apply_batch(&db, &batch).unwrap();
    assert!(retry.items.iter().all(|r| r.status == BatchStatus::Saved));
    assert_eq!(query(&db, &PromptQuery::default()).unwrap().total, 2);
    batch.items[0].draft.body = "different mutation".into();
    let changed = apply_batch(&db, &batch).unwrap();
    assert_eq!(changed.items[0].status, BatchStatus::Conflict);
    assert_eq!(
        get(&db, &batch.items[0].item_id, None).unwrap().body,
        "body"
    );
}
#[test]
fn cas_and_metadata_failures_leave_both_prompt_body_and_scope_unchanged() {
    let db = db();
    let saved = save(&db, &draft("Saved", "original", PromptScope::Global)).unwrap();
    let change = PromptDraft {
        id: Some(saved.id.clone()),
        title: saved.title.clone(),
        body: "new".into(),
        scope: PromptScope::Global,
        tags: vec!["new".into()],
        expected_version: Some(saved.version),
    };
    db.with_connection(|conn|conn.execute_batch("CREATE TRIGGER deny_prompt_metadata BEFORE UPDATE ON prompt_metadata BEGIN SELECT RAISE(ABORT, 'metadata failure'); END;").map_err(sql)).unwrap();
    assert!(save(&db, &change).is_err());
    assert_eq!(get(&db, &saved.id, None).unwrap().body, "original");
    db.with_connection(|conn| {
        conn.execute_batch("DROP TRIGGER deny_prompt_metadata;")
            .map_err(sql)
    })
    .unwrap();
    save(&db, &change).unwrap();
    assert!(save(&db, &change).is_err());
    assert_eq!(get(&db, &saved.id, None).unwrap().version, 2);
}
#[test]
fn favorites_and_recent_usage_do_not_change_content_version_or_cross_hosts() {
    let db = db();
    let saved = save(&db, &draft("Favorite", "body", PromptScope::Global)).unwrap();
    record_usage(&db, "remote:other", &saved.id, Some(true), true).unwrap();
    assert_eq!(
        query(
            &db,
            &PromptQuery {
                favorites_only: true,
                ..Default::default()
            }
        )
        .unwrap()
        .total,
        0
    );
    record_usage(&db, "local", &saved.id, Some(true), true).unwrap();
    assert_eq!(
        query(
            &db,
            &PromptQuery {
                favorites_only: true,
                recent_only: true,
                ..Default::default()
            }
        )
        .unwrap()
        .total,
        1
    );
    assert_eq!(get(&db, &saved.id, None).unwrap().version, saved.version);
}
#[test]
fn import_preview_keeps_multiline_files_and_reports_duplicates_without_saving() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("review.md");
    std::fs::write(&path, "line one\nline two\n").unwrap();
    let db = db();
    let old = save(&db, &draft("Existing", "same", PromptScope::Global)).unwrap();
    let preview=preview_import(ImportInput{json_text:"[{\"title\":\"Duplicate\",\"body\":\"same\"},{\"title\":\"\",\"body\":\"invalid\"}]".into(),files:vec![path.to_string_lossy().into()],..Default::default()},&[old]).unwrap();
    assert_eq!(preview.rows.len(), 3);
    assert_eq!(preview.rows[0].matches.len(), 1);
    assert!(preview.rows[1].error.is_some());
    assert_eq!(preview.rows[2].item.draft.body, "line one\nline two\n");
    assert_eq!(query(&db, &PromptQuery::default()).unwrap().total, 1);
}
#[test]
fn remote_metadata_survives_legacy_body_edit_and_receipts_prevent_repeat_creation() {
    let mut items = Vec::new();
    let mut state = RemotePromptState::default();
    let operation = Uuid::new_v4().to_string();
    let item = BatchItem {
        item_id: Uuid::new_v4().to_string(),
        action: BatchAction::Create,
        draft: draft(
            "Remote",
            "original",
            PromptScope::Repository {
                repository_id: "repo".into(),
            },
        ),
    };
    let saved = apply_remote_item(&mut items, &mut state, &operation, &item).unwrap();
    assert_eq!(saved.status, BatchStatus::Saved);
    items[0].body = "edited by legacy client".into();
    items[0].version += 1;
    apply_remote_item(&mut items, &mut state, &operation, &item).unwrap();
    assert_eq!(items.len(), 1);
    let doc = remote_document(&items[0], &state);
    assert_eq!(doc.body, "edited by legacy client");
    assert_eq!(doc.scope, item.draft.scope);
    assert_eq!(doc.tags, item.draft.tags);
    state.schema_version = 99;
    assert!(apply_remote_item(&mut items, &mut state, &operation, &item).is_err());
}
#[test]
fn large_prompt_list_paginates_and_matches_long_body_after_the_preview() {
    let db = db();
    for index in 0..130 {
        save(
            &db,
            &draft(
                &format!("Prompt {index:03}"),
                &format!("{} searchable-{index:03}", "content ".repeat(40)),
                PromptScope::Global,
            ),
        )
        .unwrap();
    }
    let first = query(
        &db,
        &PromptQuery {
            limit: 30,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(first.items.len(), 30);
    assert_eq!(first.total, 130);
    assert_eq!(first.next_offset, Some(30));
    let second = query(
        &db,
        &PromptQuery {
            limit: 30,
            offset: 30,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(first
        .items
        .iter()
        .all(|a| second.items.iter().all(|b| a.id != b.id)));
    let searched = query(
        &db,
        &PromptQuery {
            search: "searchable-129".into(),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(searched.total, 1);
    assert!(!searched.items[0].preview.contains("searchable-129"));
}

#[test]
fn batch_reclassification_preserves_body_and_rejects_stale_versions() {
    let db = db();
    let (workspace, _) = context(&db);
    let saved = save(
        &db,
        &draft("Original title", "full\noriginal body", PromptScope::Global),
    )
    .unwrap();
    let item = BatchItem {
        item_id: Uuid::new_v4().to_string(),
        action: BatchAction::Reclassify,
        draft: PromptDraft {
            id: Some(saved.id.clone()),
            title: "must not replace".into(),
            body: "must not replace".into(),
            scope: PromptScope::Workspace {
                workspace_id: workspace.clone(),
            },
            tags: vec!["release".into()],
            expected_version: Some(saved.version),
        },
    };
    let batch = PromptBatch {
        operation_id: Uuid::new_v4().to_string(),
        items: vec![item.clone()],
    };
    let result = apply_batch(&db, &batch).unwrap();
    assert_eq!(result.items[0].status, BatchStatus::Saved);
    let updated = get(&db, &saved.id, None).unwrap();
    assert_eq!(updated.title, saved.title);
    assert_eq!(updated.body, saved.body);
    assert_eq!(
        updated.scope,
        PromptScope::Workspace {
            workspace_id: workspace
        }
    );
    assert_eq!(updated.tags, vec!["release"]);
    let stale = apply_batch(
        &db,
        &PromptBatch {
            operation_id: Uuid::new_v4().to_string(),
            items: vec![item],
        },
    )
    .unwrap();
    assert_eq!(stale.items[0].status, BatchStatus::Conflict);
    assert_eq!(get(&db, &saved.id, None).unwrap().version, 2);
}

#[test]
fn import_reads_enforce_actual_byte_limit_and_reject_invalid_utf8() {
    assert_eq!(
        read_import_text(std::io::Cursor::new(b"abc"), 3).unwrap(),
        "abc"
    );
    assert!(read_import_text(std::io::Cursor::new(b"abcd"), 3).is_err());
    assert!(read_import_text(std::io::Cursor::new([0xff]), 4).is_err());
    let db = db();
    let before = query(&db, &PromptQuery::default()).unwrap().total;
    assert!(preview_import(
        ImportInput {
            json_text: "x".repeat(MAX_INPUT + 1),
            ..Default::default()
        },
        &[]
    )
    .is_err());
    assert_eq!(query(&db, &PromptQuery::default()).unwrap().total, before);
}

#[test]
fn import_preview_reports_batch_duplicates_without_inventing_stored_targets() {
    let preview = preview_import(ImportInput {
        json_text: r#"[{"title":"same","body":"same body"},{"title":"same","body":"same body"},{"title":"SAME","body":"different"},{"title":"other","body":"same body"},{"title":"unique","body":"unique"}]"#.into(),
        ..Default::default()
    }, &[]).unwrap();
    let serialized = serde_json::to_value(&preview).unwrap();
    for index in 0..4 {
        let matches = serialized["rows"][index]["batchMatches"].as_array()
            .expect("incoming duplicates must be visible independently of stored matches");
        assert!(!matches.is_empty());
        assert!(matches.iter().all(|item| item["itemId"] != preview.rows[index].item.item_id));
        assert!(matches.iter().all(|item| item.get("version").is_none() && item.get("id").is_none()));
        assert!(preview.rows[index].matches.is_empty());
        assert!(preview.rows[index].error.is_none());
    }
    assert_eq!(serialized["rows"][4]["batchMatches"], serde_json::json!([]));
    // Keeping copies remains an explicit valid operation; preview performs no write.
    let db = db();
    assert_eq!(query(&db, &PromptQuery::default()).unwrap().total, 0);
    let results = apply_batch(&db, &PromptBatch {
        operation_id: preview.operation_id,
        items: preview.rows.into_iter().map(|row| row.item).collect(),
    }).unwrap();
    assert!(results.items.iter().all(|item| item.status == BatchStatus::Saved));
    assert_eq!(query(&db, &PromptQuery::default()).unwrap().total, 5);
}

#[test]
fn valid_legacy_tags_remain_readable_editable_and_portable_without_relaxing_new_writes() {
    let db = db();
    let tags: Vec<_> = (0x4e00..0x4e21).map(|code| char::from_u32(code).unwrap().to_string()).collect();
    let category = tags.join(",");
    assert_eq!(category.chars().count(), 65);
    let old = crate::library::save(&db, crate::library::LibraryDraft {
        id: None, kind: crate::library::LibraryKind::Prompt,
        title: "Legacy".into(), body: "preserved".into(), category,
        project_id: None, expected_version: None,
    }).unwrap();
    assert_eq!(query(&db, &PromptQuery::default()).unwrap().total, 1);
    let old_doc = get(&db, &old.id, None).unwrap();
    assert_eq!(old_doc.tags, tags);
    save(&db, &draft("Unrelated", "still works", PromptScope::Global)).unwrap();
    let mut edit = PromptDraft {
        id: Some(old.id.clone()), title: old.title, body: "edited".into(),
        scope: PromptScope::Global, tags: tags.clone(), expected_version: Some(old.version),
    };
    let edited = save(&db, &edit).unwrap();
    assert_eq!(edited.tags, tags);
    let exported = export_metadata(&db).unwrap();
    db.with_connection(|conn| restore_metadata(conn, &old.id, &exported[&old.id])).unwrap();
    assert_eq!(get(&db, &old.id, None).unwrap().tags, tags);
    let mut new = draft("New oversized", "not saved", PromptScope::Global);
    new.tags = tags;
    assert!(save(&db, &new).is_err());
    assert!(normalize_draft(&new).is_err());
    edit.expected_version = Some(edited.version);
    edit.tags = vec!["cleaned".into()];
    assert_eq!(save(&db, &edit).unwrap().tags, vec!["cleaned"]);
    assert_eq!(query(&db, &PromptQuery::default()).unwrap().total, 2);
}

#[test]
fn remote_legacy_tags_can_be_preserved_but_not_created_or_expanded() {
    let tags: Vec<_> = (0x4e00..0x4e21).map(|code| char::from_u32(code).unwrap().to_string()).collect();
    let mut items = vec![crate::library::LibraryItem {
        id: "old".into(), kind: crate::library::LibraryKind::Prompt,
        title: "Legacy".into(), body: "old body".into(), category: tags.join(","),
        project_id: None, version: 1, updated_at: 1,
    }];
    let mut state = RemotePromptState::default();
    let mut item = BatchItem { item_id: Uuid::new_v4().to_string(), action: BatchAction::Replace,
        draft: PromptDraft { id: Some("old".into()), title: "Legacy".into(), body: "edited".into(), scope: PromptScope::Global, tags: tags.clone(), expected_version: Some(1) },
    };
    apply_remote_item(&mut items, &mut state, &Uuid::new_v4().to_string(), &item).unwrap();
    assert_eq!(remote_document(&items[0], &state).tags, tags);
    item.draft.expected_version = Some(2);
    item.draft.tags.push("new".into());
    assert!(apply_remote_item(&mut items, &mut state, &Uuid::new_v4().to_string(), &item).is_err());
    item.action = BatchAction::Create; item.draft.id = None; item.draft.expected_version = None;
    item.draft.tags = tags;
    assert!(apply_remote_item(&mut items, &mut state, &Uuid::new_v4().to_string(), &item).is_err());
    assert_eq!(items.len(), 1);
}

#[test]
fn duplicate_preview_bounds_match_samples_for_large_identical_input() {
    let input = serde_json::to_string(&vec![serde_json::json!({"title":"same", "body":"same"}); MAX_BATCH]).unwrap();
    let preview = preview_import(ImportInput { json_text: input, ..Default::default() }, &[]).unwrap();
    assert_eq!(preview.rows.len(), MAX_BATCH);
    assert!(preview.rows.iter().all(|row| row.batch_matches.len() == 8));
}
