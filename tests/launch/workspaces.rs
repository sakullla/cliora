use super::*;

const HOST: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
fn db() -> Database {
    Database::open(Path::new(":memory:")).unwrap()
}
fn git(root: &Path, args: &[&str]) {
    let result = std::process::Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}
fn repository(root: &Path) {
    fs::create_dir_all(root).unwrap();
    git(root, &["init", "-q"]);
    git(
        root,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "--allow-empty",
            "-qm",
            "initial",
        ],
    );
}
#[test]
fn legacy_contexts_and_invalid_directories_survive_seed_and_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("state.db");
    let db = Database::open(&path).unwrap();
    let folder = temp.path().join("plain");
    fs::create_dir(&folder).unwrap();
    let project = crate::projects::add(
        &db,
        &crate::adapters::Registry::builtins(),
        folder.to_str().unwrap(),
        Some("Original"),
        None,
    )
    .unwrap();
    seed_legacy(&db, HOST).unwrap();
    let initial = list(&db, HOST).unwrap();
    assert_eq!(initial.len(), 1);
    assert_eq!(initial[0].id, project.id);
    assert_eq!(initial[0].repositories[0].locations[0].kind, "legacy");
    assert_eq!(
        initial[0].repositories[0].locations[0]
            .project_id
            .as_deref(),
        Some(project.id.as_str())
    );
    assert_eq!(list(&db, HOST).unwrap().len(), 1);
    drop(db);
    fs::remove_dir(folder).unwrap();
    let db = Database::open(&path).unwrap();
    let reopened = list(&db, HOST).unwrap();
    assert!(!reopened[0].repositories[0].locations[0].available);
    assert_eq!(
        crate::projects::get(&db, &project.id).unwrap().name,
        "Original"
    );
}
#[test]
fn batch_scan_and_members_preserve_repo_and_worktree_identity() {
    let temp = tempfile::tempdir().unwrap();
    let a = temp.path().join("one/api");
    let b = temp.path().join("two/api");
    repository(&a);
    repository(&b);
    let linked = temp.path().join("linked");
    git(
        &a,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feature",
            linked.to_str().unwrap(),
        ],
    );
    let nested = a.join("nested");
    repository(&nested);
    let scan = scan(&[temp.path().to_string_lossy().into()], "test-scan", true).unwrap();
    assert!(!scan.partial);
    assert!(
        scan.candidates
            .iter()
            .filter(|c| c.kind == "repository")
            .count()
            >= 4
    );
    let db = db();
    let workspace = create(&db, HOST, "Business").unwrap();
    let added = add_paths(
        &db,
        HOST,
        &workspace.id,
        &[
            a.to_string_lossy().into(),
            linked.to_string_lossy().into(),
            b.to_string_lossy().into(),
        ],
        workspace.revision,
    )
    .unwrap();
    assert!(added.iter().all(|r| r.error.is_none()));
    assert_eq!(added[0].repository_id, added[1].repository_id);
    assert_ne!(added[0].repository_id, added[2].repository_id);
    let view = get(&db, HOST, &workspace.id).unwrap();
    assert_eq!(view.repositories.len(), 2);
    let first = added[0].repository_id.as_deref().unwrap();
    let (native, directory) =
        prepare_launch(&db, HOST, &workspace.id, first, linked.to_str()).unwrap();
    assert_eq!(Path::new(&directory), linked.canonicalize().unwrap());
    assert!(crate::projects::get(&db, &native).is_ok());
    assert!(prepare_launch(&db, HOST, &workspace.id, first, b.to_str()).is_err());
    remove_member(&db, HOST, &workspace.id, first, view.revision).unwrap();
    assert!(a.join(".git").exists());
    assert!(linked.exists());
}
#[test]
fn manifest_cas_unknown_versions_and_projection_recovery_preserve_files() {
    let temp = tempfile::tempdir().unwrap();
    let db = db();
    let workspace = create(&db, HOST, "Shared").unwrap();
    let path = temp.path().join("shared.dev-workspace.json");
    let exported = export_manifest(&db, HOST, &workspace.id, path.to_str().unwrap(), 1).unwrap();
    assert_eq!(exported.manifest_revision, Some(1));
    let preview = preview_manifest(&db, path.to_str().unwrap()).unwrap();
    assert!(!preview.conflict);
    let mut external = preview.manifest;
    external.revision = 2;
    external.name = "From peer".into();
    fs::write(&path, serde_json::to_vec_pretty(&external).unwrap()).unwrap();
    assert!(rename(&db, HOST, &workspace.id, "stale", 1).is_err());
    let refresh = refresh_manifest(&db, HOST, &workspace.id).unwrap();
    assert_eq!(refresh.name, "From peer");
    assert_eq!(refresh.revision, 2);
    let updated = rename(&db, HOST, &workspace.id, "Current", 2).unwrap();
    assert_eq!(updated.revision, 3);
    assert_eq!(read_manifest(&path).unwrap().0.name, "Current");
    external.schema_version = 99;
    fs::write(&path, serde_json::to_vec(&external).unwrap()).unwrap();
    let failed = refresh_manifest(&db, HOST, &workspace.id).unwrap();
    assert!(failed.error.is_some());
    assert_eq!(failed.name, "Current");
    assert!(rename(&db, HOST, &workspace.id, "No overwrite", 3).is_err());
    assert!(fs::read_to_string(&path).unwrap().contains("99"));
}
#[test]
fn foreign_host_locations_are_not_local_and_same_name_is_not_identity() {
    let temp = tempfile::tempdir().unwrap();
    repository(temp.path());
    let db = db();
    let value = Manifest {
        schema_version: 1,
        workspace_id: Uuid::new_v4().to_string(),
        name: "Same".into(),
        revision: 1,
        repositories: vec![ManifestRepository {
            id: Uuid::new_v4().to_string(),
            name: "Repo".into(),
            locations: vec![ManifestLocation {
                host_id: Uuid::new_v4().to_string(),
                path: temp.path().to_string_lossy().into(),
            }],
        }],
    };
    project_manifest(&db, &value, None, None).unwrap();
    create(&db, HOST, "Same").unwrap();
    let list = list(&db, HOST).unwrap();
    assert_eq!(list.len(), 2);
    let imported = list.iter().find(|w| w.id == value.workspace_id).unwrap();
    assert!(!imported.repositories[0].locations[0].available);
    assert!(prepare_launch(
        &db,
        HOST,
        &value.workspace_id,
        &value.repositories[0].id,
        None
    )
    .is_err());
}
#[test]
fn session_identity_survives_multiple_restores_without_changing_directory() {
    let db = db();
    let context = SessionContext {
        session_id: "old".into(),
        workspace_id: "workspace".into(),
        repository_id: "repository".into(),
        host_id: HOST.into(),
        directory: "/original/repo".into(),
    };
    remember_session(&db, &context).unwrap();
    restore_session_context(&db, "old", "new").unwrap();
    restore_session_context(&db, "new", "third").unwrap();
    let contexts = session_contexts(&db).unwrap();
    assert_eq!(contexts.len(), 3);
    assert!(contexts
        .iter()
        .all(|c| c.directory == context.directory && c.workspace_id == context.workspace_id));
}
#[test]
fn cancellation_is_distinct_from_empty_and_shared_host_identity_is_stable() {
    let cancel = AtomicBool::new(true);
    let result = scan_with(&["/unused".into()], true, &cancel).unwrap();
    assert!(result.cancelled && result.partial);
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("host-id");
    let first = host_id_at(&path).unwrap();
    assert_eq!(host_id_at(&path).unwrap(), first);
    fs::write(&path, "broken").unwrap();
    assert!(host_id_at(&path).is_err());
    assert_eq!(fs::read_to_string(path).unwrap(), "broken");
}
#[test]
fn refreshing_locations_replaces_only_that_projects_references() {
    let temp = tempfile::tempdir().unwrap();
    let a = temp.path().join("old");
    let b = temp.path().join("new");
    repository(&a);
    repository(&b);
    let db = db();
    let repo = Uuid::new_v4().to_string();
    let mut value = Manifest {
        schema_version: 1,
        workspace_id: Uuid::new_v4().to_string(),
        name: "A".into(),
        revision: 1,
        repositories: vec![ManifestRepository {
            id: repo.clone(),
            name: "Repo".into(),
            locations: vec![ManifestLocation {
                host_id: HOST.into(),
                path: a.to_string_lossy().into(),
            }],
        }],
    };
    project_manifest(&db, &value, None, None).unwrap();
    let first = value.workspace_id.clone();
    value.workspace_id = Uuid::new_v4().to_string();
    value.name = "B".into();
    project_manifest(&db, &value, None, None).unwrap();
    let second = value.workspace_id.clone();
    value.workspace_id = first.clone();
    value.name = "A".into();
    value.revision = 2;
    value.repositories[0].locations[0].path = b.to_string_lossy().into();
    project_manifest(&db, &value, None, None).unwrap();
    assert_eq!(
        get(&db, HOST, &first).unwrap().repositories[0]
            .locations
            .len(),
        1
    );
    assert_eq!(
        get(&db, HOST, &first).unwrap().repositories[0].locations[0]
            .path
            .as_deref(),
        b.to_str()
    );
    assert_eq!(
        get(&db, HOST, &second).unwrap().repositories[0].locations[0]
            .path
            .as_deref(),
        a.to_str()
    );
    assert!(prepare_launch(&db, HOST, &first, &repo, a.to_str()).is_err());
    value.revision = MAX_REVISION + 1;
    assert!(validate_manifest(&value).is_err());
}
#[test]
fn contract_fixtures_and_deep_links_are_strict_and_preview_only() {
    let valid: Manifest =
        serde_json::from_str(include_str!("../fixtures/workspaces/valid-v1.json")).unwrap();
    validate_manifest(&valid).unwrap();
    let invalid: Manifest =
        serde_json::from_str(include_str!("../fixtures/workspaces/invalid-version.json")).unwrap();
    assert!(validate_manifest(&invalid).is_err());
    // A local absolute path: rooted on Unix, drive-qualified on Windows.
    let (encoded, path) = if cfg!(windows) {
        ("C%3A%5Cwork%5Cproject.dev-workspace.json", r"C:\work\project.dev-workspace.json")
    } else {
        ("%2Ftmp%2Fproject.dev-workspace.json", "/tmp/project.dev-workspace.json")
    };
    assert_eq!(manifest_link(&format!("cliora://workspace?v=1&file={encoded}")).unwrap(), path);
    for url in [
        "cliora://workspace?v=1&file=relative.json",
        "cliora://workspace?v=1&file=%2Ftmp%2Fone&file=%2Ftmp%2Ftwo",
        "cliora://workspace?v=1&file=%2Ftmp%2Fone&command=delete",
        "cliora://workspace?v=2&file=%2Ftmp%2Fone",
        "cliora://user@workspace?v=1&file=%2Ftmp%2Fone",
    ] {
        assert!(manifest_link(url).is_err(), "{url}");
    }
}
#[test]
fn legacy_main_and_linked_checkouts_share_repository_but_keep_native_contexts() {
    let temp = tempfile::tempdir().unwrap();
    let main = temp.path().join("main");
    let linked = temp.path().join("feature");
    repository(&main);
    git(
        &main,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feature",
            linked.to_str().unwrap(),
        ],
    );
    let db = db();
    let a = crate::projects::add(
        &db,
        &crate::adapters::Registry::builtins(),
        main.to_str().unwrap(),
        Some("Main config"),
        None,
    )
    .unwrap();
    let b = crate::projects::add(
        &db,
        &crate::adapters::Registry::builtins(),
        linked.to_str().unwrap(),
        Some("Feature config"),
        None,
    )
    .unwrap();
    seed_legacy(&db, HOST).unwrap();
    let rows = list(&db, HOST).unwrap();
    let first = rows.iter().find(|w| w.id == a.id).unwrap();
    let second = rows.iter().find(|w| w.id == b.id).unwrap();
    assert_eq!(first.repositories[0].id, second.repositories[0].id);
    assert_eq!(
        first.repositories[0].locations[0].project_id.as_deref(),
        Some(a.id.as_str())
    );
    assert_eq!(
        second.repositories[0].locations[0].project_id.as_deref(),
        Some(b.id.as_str())
    );
    assert_eq!(
        crate::projects::get(&db, &a.id).unwrap().name,
        "Main config"
    );
    assert_eq!(
        crate::projects::get(&db, &b.id).unwrap().name,
        "Feature config"
    );
}
#[test]
fn old_checkpoint_gets_exact_project_scope_without_rewriting_account_or_directory() {
    let temp = tempfile::tempdir().unwrap();
    repository(temp.path());
    let db = db();
    let project = crate::projects::add(
        &db,
        &crate::adapters::Registry::builtins(),
        temp.path().to_str().unwrap(),
        None,
        None,
    )
    .unwrap();
    seed_legacy(&db, HOST).unwrap();
    let saved = crate::workbench_restore::SavedSession {
        id: "legacy-session".into(),
        tool_id: "codex".into(),
        project_id: Some(project.id.clone()),
        directory: temp.path().to_string_lossy().into(),
        mode: crate::adapters::LaunchMode::Normal,
        started_at: 1,
        stopped_at: None,
        native_id: Some("native".into()),
        account_id: Some("account".into()),
        context_id: Some("context".into()),
    };
    crate::workbench_restore::save(&db, &saved).unwrap();
    let contexts = session_contexts(&db).unwrap();
    assert_eq!(contexts[0].workspace_id, project.id);
    assert_eq!(contexts[0].directory, saved.directory);
    let after = crate::workbench_restore::list(&db).unwrap();
    assert_eq!(after[0].account_id, saved.account_id);
    assert_eq!(after[0].context_id, saved.context_id);
    assert_eq!(after[0].directory, saved.directory);
}
#[test]
fn launch_prefers_exact_checkout_configuration_over_main_repository_context() {
    let temp = tempfile::tempdir().unwrap();
    let main = temp.path().join("main");
    let linked = temp.path().join("feature");
    repository(&main);
    git(
        &main,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feature",
            linked.to_str().unwrap(),
        ],
    );
    let db = db();
    let a = crate::projects::add(
        &db,
        &crate::adapters::Registry::builtins(),
        main.to_str().unwrap(),
        None,
        None,
    )
    .unwrap();
    let b = crate::projects::add(
        &db,
        &crate::adapters::Registry::builtins(),
        linked.to_str().unwrap(),
        None,
        None,
    )
    .unwrap();
    seed_legacy(&db, HOST).unwrap();
    let rows = list(&db, HOST).unwrap();
    let workspace = rows.iter().find(|w| w.id == a.id).unwrap();
    let repo = &workspace.repositories[0];
    let (selected, directory) =
        prepare_launch(&db, HOST, &workspace.id, &repo.id, linked.to_str()).unwrap();
    assert_eq!(selected, b.id);
    assert_eq!(Path::new(&directory), linked.canonicalize().unwrap());
}
#[test]
fn refresh_rejects_revision_rollback_and_equal_version_changed_content() {
    let temp = tempfile::tempdir().unwrap();
    let db = db();
    let workspace = create(&db, HOST, "Original").unwrap();
    let path = temp.path().join("shared.dev-workspace.json");
    export_manifest(&db, HOST, &workspace.id, path.to_str().unwrap(), 1).unwrap();
    rename(&db, HOST, &workspace.id, "New", 1).unwrap();
    let mut value = read_manifest(&path).unwrap().0;
    value.name = "Same version changed".into();
    fs::write(&path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    let failed = refresh_manifest(&db, HOST, &workspace.id).unwrap();
    assert_eq!(failed.name, "New");
    assert!(failed.error.is_some());
    value.revision = 1;
    fs::write(&path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    let failed = refresh_manifest(&db, HOST, &workspace.id).unwrap();
    assert_eq!(failed.revision, 2);
    assert!(failed.error.is_some());
    let preview = preview_manifest(&db, path.to_str().unwrap()).unwrap();
    assert!(preview.conflict);
    let adopted =
        attach_manifest(&db, HOST, path.to_str().unwrap(), &preview.digest, true).unwrap();
    assert_eq!(adopted.revision, 1);
}
#[test]
fn submodule_candidates_never_offer_git_administration_directories_as_checkouts() {
    let temp = tempfile::tempdir().unwrap();
    let parent = temp.path().join("parent");
    let source = temp.path().join("source");
    repository(&parent);
    repository(&source);
    git(
        &parent,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            source.to_str().unwrap(),
            "vendor/lib",
        ],
    );
    let module = parent.join("vendor/lib");
    let db = db();
    let workspace = create(&db, HOST, "Submodules").unwrap();
    let added = add_paths(
        &db,
        HOST,
        &workspace.id,
        &[
            parent.to_string_lossy().into(),
            module.to_string_lossy().into(),
        ],
        workspace.revision,
    )
    .unwrap();
    assert!(added.iter().all(|item| item.error.is_none()));
    assert_ne!(added[0].repository_id, added[1].repository_id);
    let view = get(&db, HOST, &workspace.id).unwrap();
    let sub = view
        .repositories
        .iter()
        .find(|repo| Some(&repo.id) == added[1].repository_id.as_ref())
        .unwrap();
    let location = &sub.locations[0];
    assert_eq!(location.worktrees.len(), 1);
    assert_eq!(
        Path::new(&location.worktrees[0].path),
        module.canonicalize().unwrap()
    );
    assert!(prepare_launch(
        &db,
        HOST,
        &workspace.id,
        &sub.id,
        Some(&location.worktrees[0].path)
    )
    .is_ok());
}
#[test]
fn explicit_unlock_releases_lock_even_while_an_inherited_descriptor_remains_open() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("shared.dev-workspace.json");
    let guard = lock_file(&path).unwrap();
    assert!(
        lock_file(&path).is_err(),
        "a live writer must exclude another writer"
    );
    // Like a fork before exec closes CLOEXEC fds, cloning retains the same open file description.
    let inherited = guard.0.try_clone().unwrap();
    drop(guard);
    let next = lock_file(&path)
        .expect("the guard must explicitly unlock before closing its own descriptor");
    drop(next);
    drop(inherited);
}

fn moved_repository_fixture() -> (tempfile::TempDir, Database, String, String, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let old = temp.path().join("old");
    let moved = temp.path().join("moved");
    repository(&old);
    let db = db();
    let workspace = create(&db, HOST, "Repository A").unwrap();
    let added = add_paths(&db, HOST, &workspace.id, &[text(&old).unwrap()], 1).unwrap();
    let repository_id = added[0].repository_id.clone().unwrap();
    fs::rename(&old, &moved).unwrap();
    relink(
        &db,
        HOST,
        &workspace.id,
        &repository_id,
        moved.to_str().unwrap(),
        2,
    )
    .unwrap();
    repository(&old);
    (temp, db, workspace.id, repository_id, old)
}

#[test]
fn retired_location_does_not_adopt_a_new_repository_at_its_old_path() {
    let (_temp, db, workspace_id, repository_a, old) = moved_repository_fixture();
    let other = create(&db, HOST, "Repository B").unwrap();
    let added = add_paths(&db, HOST, &other.id, &[text(&old).unwrap()], 1).unwrap();
    assert!(added[0].error.is_none(), "{:?}", added[0]);
    assert_ne!(
        added[0].repository_id.as_deref(),
        Some(repository_a.as_str())
    );
    assert_eq!(
        get(&db, HOST, &workspace_id).unwrap().repositories[0].id,
        repository_a
    );
}

#[test]
fn legacy_seed_does_not_reuse_retired_repository_identity() {
    let (_temp, db, _workspace_id, repository_a, old) = moved_repository_fixture();
    let legacy = crate::projects::add(
        &db,
        &crate::adapters::Registry::builtins(),
        old.to_str().unwrap(),
        Some("New B"),
        None,
    )
    .unwrap();
    seed_legacy(&db, HOST).unwrap();
    let rows = list(&db, HOST).unwrap();
    let seeded = rows.iter().find(|item| item.id == legacy.id).unwrap();
    assert_ne!(seeded.repositories[0].id, repository_a);
    assert_eq!(
        seeded.repositories[0].locations[0].project_id.as_deref(),
        Some(legacy.id.as_str())
    );
}

#[test]
fn known_identity_conflict_is_rejected_before_publishing_shared_manifest() {
    let temp = tempfile::tempdir().unwrap();
    let a = temp.path().join("a");
    let b = temp.path().join("b");
    repository(&a);
    repository(&b);
    let db = db();
    let first = create(&db, HOST, "A").unwrap();
    let second = create(&db, HOST, "B").unwrap();
    let repo_a = add_paths(&db, HOST, &first.id, &[text(&a).unwrap()], 1).unwrap()[0]
        .repository_id
        .clone()
        .unwrap();
    add_paths(&db, HOST, &second.id, &[text(&b).unwrap()], 1).unwrap();
    let source = temp.path().join("a.dev-workspace.json");
    export_manifest(&db, HOST, &first.id, source.to_str().unwrap(), 2).unwrap();
    let before = fs::read(&source).unwrap();
    let error = relink(&db, HOST, &first.id, &repo_a, b.to_str().unwrap(), 2).unwrap_err();
    assert!(
        !error.contains("清单已保存"),
        "predictable conflicts are not publication failures: {error}"
    );
    assert_eq!(fs::read(&source).unwrap(), before);
    assert_eq!(get(&db, HOST, &first.id).unwrap().revision, 2);
    assert_eq!(refresh_manifest(&db, HOST, &first.id).unwrap().error, None);
}

#[test]
fn shared_path_contract_rejects_drive_relative_and_incomplete_unc_paths() {
    let cases: serde_json::Value =
        serde_json::from_str(include_str!("../fixtures/workspaces/path-cases-v1.json")).unwrap();
    let mut manifest: Manifest =
        serde_json::from_str(include_str!("../fixtures/workspaces/valid-v1.json")).unwrap();
    manifest.repositories.truncate(1);
    for path in cases["invalid"].as_array().unwrap() {
        manifest.repositories[0].locations[0].path = path.as_str().unwrap().into();
        assert!(
            validate_manifest(&manifest).is_err(),
            "accepted invalid location: {path}"
        );
    }
    for path in cases["valid"].as_array().unwrap() {
        manifest.repositories[0].locations[0].path = path.as_str().unwrap().into();
        validate_manifest(&manifest)
            .unwrap_or_else(|error| panic!("rejected valid location {path}: {error}"));
    }
}

#[test]
fn actual_storage_failure_after_publication_remains_recoverable_by_refresh() {
    let temp = tempfile::tempdir().unwrap();
    let db = db();
    let workspace = create(&db, HOST, "Before").unwrap();
    let source = temp.path().join("shared.dev-workspace.json");
    export_manifest(&db, HOST, &workspace.id, source.to_str().unwrap(), 1).unwrap();
    db.with_connection(|conn|conn.execute_batch("CREATE TRIGGER reject_workspace_projection BEFORE UPDATE ON workspace_projects BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END;").map_err(sql)).unwrap();
    let error = rename(&db, HOST, &workspace.id, "After", 1).unwrap_err();
    assert!(error.contains("清单已保存，本机投影待刷新"), "{error}");
    assert_eq!(read_manifest(&source).unwrap().0.name, "After");
    assert_eq!(get(&db, HOST, &workspace.id).unwrap().name, "Before");
    db.with_connection(|conn| {
        conn.execute_batch("DROP TRIGGER reject_workspace_projection;")
            .map_err(sql)
    })
    .unwrap();
    let refreshed = refresh_manifest(&db, HOST, &workspace.id).unwrap();
    assert_eq!(refreshed.name, "After");
    assert_eq!(refreshed.revision, 2);
    assert_eq!(refreshed.error, None);
    assert_eq!(
        refresh_manifest(&db, HOST, &workspace.id).unwrap().revision,
        2
    );
}

#[cfg(not(windows))]
#[test]
fn foreign_absolute_hint_with_matching_host_is_still_not_a_local_working_directory() {
    let db = db();
    let mut value: Manifest =
        serde_json::from_str(include_str!("../fixtures/workspaces/valid-v1.json")).unwrap();
    value.repositories.truncate(1);
    value.repositories[0].locations[0].host_id = HOST.into();
    value.repositories[0].locations[0].path = r"C:\work\repo".into();
    project_manifest(&db, &value, None, None).unwrap();
    let view = get(&db, HOST, &value.workspace_id).unwrap();
    assert!(!view.repositories[0].locations[0].available);
    assert!(view.repositories[0].locations[0]
        .reason
        .as_deref()
        .unwrap()
        .contains("本机绝对路径"));
    assert!(prepare_launch(
        &db,
        HOST,
        &value.workspace_id,
        &value.repositories[0].id,
        Some(r"C:\work\repo")
    )
    .unwrap_err()
    .contains("本机绝对路径"));
}
#[test]
fn launch_directories_are_not_projects_and_untouched_seeds_leave_with_their_directory() {
    let temp = tempfile::tempdir().unwrap();
    let db = db();
    let add = |name: &str| {
        let folder = temp.path().join(name);
        fs::create_dir(&folder).unwrap();
        crate::projects::add(&db, &crate::adapters::Registry::builtins(), folder.to_str().unwrap(), Some(name), None).unwrap()
    };
    let fresh = add("fresh");
    assert!(list(&db, HOST).unwrap().is_empty(), "a launch directory is not a business project");
    crate::projects::remove(&db, &fresh.id).unwrap();

    // An older version seeded these; one stays untouched, the other was renamed by the user.
    let untouched = add("untouched");
    let renamed = add("renamed");
    let kept = add("kept");
    seed_legacy(&db, HOST).unwrap();
    rename(&db, HOST, &renamed.id, "Renamed by user", 1).unwrap();
    let prompt = crate::library::save(&db, crate::library::LibraryDraft { id: None, kind: crate::library::LibraryKind::Prompt, title: "Scoped".into(), body: "body".into(), category: String::new(), project_id: Some(untouched.id.clone()), expected_version: None }).unwrap();
    crate::prompts::ensure_metadata(&db).unwrap();
    assert_eq!(crate::prompts::get(&db, &prompt.id, None).unwrap().scope, crate::prompts::PromptScope::Workspace { workspace_id: untouched.id.clone() });

    crate::projects::remove(&db, &untouched.id).unwrap();
    crate::projects::remove(&db, &renamed.id).unwrap();
    let ids: Vec<String> = list(&db, HOST).unwrap().into_iter().map(|item| item.id).collect();
    assert!(!ids.contains(&untouched.id), "an untouched seed leaves with its directory");
    assert!(ids.contains(&renamed.id), "a project the user changed stays");
    assert!(ids.contains(&kept.id), "a seed whose directory still exists stays");
    assert_eq!(crate::prompts::get(&db, &prompt.id, None).unwrap().scope, crate::prompts::PromptScope::Global, "scoped prompts become general instead of disappearing");
    // The retired seed is not recreated by later lists or prompt queries.
    assert!(!list(&db, HOST).unwrap().iter().any(|item| item.id == untouched.id));
}
#[test]
fn deleting_a_project_keeps_sessions_and_repositories_and_frees_its_scope() {
    let temp = tempfile::tempdir().unwrap();
    repository(temp.path());
    let db = db();
    let workspace = create(&db, HOST, "Group").unwrap();
    add_paths(&db, HOST, &workspace.id, &[temp.path().to_string_lossy().into()], workspace.revision).unwrap();
    let repository_id = get(&db, HOST, &workspace.id).unwrap().repositories[0].id.clone();
    remember_session(&db, &SessionContext { session_id: "s1".into(), workspace_id: workspace.id.clone(), repository_id, host_id: HOST.into(), directory: temp.path().to_string_lossy().into() }).unwrap();
    delete(&db, &workspace.id).unwrap();
    assert!(list(&db, HOST).unwrap().is_empty());
    assert!(session_contexts(&db).unwrap().is_empty());
    assert!(temp.path().join(".git").exists(), "source files are never touched");
    // Its old path can be added to a new project again.
    let next = create(&db, HOST, "Again").unwrap();
    add_paths(&db, HOST, &next.id, &[temp.path().to_string_lossy().into()], next.revision).unwrap();
    assert_eq!(get(&db, HOST, &next.id).unwrap().repositories.len(), 1);
}
#[test]
fn identity_reads_never_wait_for_or_fail_on_a_held_lock() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("host-id");
    let id = host_id_at(&path).unwrap();
    // Another window (or a sibling app) holds the identity lock: reading still succeeds.
    let _held = lock_file(&path).unwrap();
    assert_eq!(host_id_at(&path).unwrap(), id);
}
/// Timing evidence for a project with hundreds of repositories: the parallel
/// location check against the same work done on one thread.
#[test]
#[ignore = "creates 400 Git repositories; run manually for timing evidence"]
fn hundreds_of_repositories_are_checked_in_parallel() {
    let temp = tempfile::tempdir().unwrap();
    let paths: Vec<String> = (0..400)
        .map(|index| {
            let root = temp.path().join(format!("service-{index:03}"));
            fs::create_dir_all(&root).unwrap();
            git(&root, &["init", "-q"]);
            root.to_string_lossy().into()
        })
        .collect();
    let db = db();
    let workspace = create(&db, HOST, "Large").unwrap();
    let added = add_paths(&db, HOST, &workspace.id, &paths, workspace.revision).unwrap();
    assert!(added.iter().all(|item| item.error.is_none()));
    let best = |run: &dyn Fn()| (0..3).map(|_| { let started = std::time::Instant::now(); run(); started.elapsed() }).min().unwrap();
    let parallel = best(&|| {
        let value = get(&db, HOST, &workspace.id).unwrap();
        assert_eq!(value.repositories.len(), 400);
        assert!(value.repositories.iter().all(|repo| repo.locations.iter().all(|location| location.available)));
    });
    let template = get(&db, HOST, &workspace.id).unwrap();
    let sequential = best(&|| {
        let mut value = template.clone();
        for repo in &mut value.repositories {
            let name = repo.name.clone();
            for location in &mut repo.locations {
                location.available = false;
                location.worktrees.clear();
                probe_location(HOST, &name, location).unwrap();
            }
        }
    });
    println!("400 repositories: parallel get {parallel:?}, one-thread location checks {sequential:?}");
}
