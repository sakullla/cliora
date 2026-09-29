use super::*;

#[test]
fn complete_package_install_update_and_external_conflict() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let registry = Registry::builtins();
    let source = temp.path().join("my-skill");
    fs::create_dir_all(source.join("scripts")).unwrap();
    fs::write(
        source.join("SKILL.md"),
        "---\nname: my-skill\ndescription: Example\ncompatibility: Requires git\n---\n",
    )
    .unwrap();
    fs::write(source.join("scripts/helper.txt"), "v1").unwrap();
    let first = import_local(&db, source.to_str().unwrap(), None, None).unwrap();
    assert_eq!(first.file_count, 2);
    assert_eq!(first.compatibility.as_deref(), Some("Requires git"));
    let home = temp.path().join("home");
    let path = home.join(".claude/skills/my-skill");
    let installed = install(
        &db,
        &registry,
        &home,
        &first.id,
        "claude_code",
        Scope::Global,
        None,
    );
    assert_eq!(installed.status, "installed", "{}", installed.detail);
    assert_eq!(
        fs::read_to_string(path.join("scripts/helper.txt")).unwrap(),
        "v1"
    );
    fs::write(source.join("scripts/helper.txt"), "v2").unwrap();
    assert!(import_local(&db, source.to_str().unwrap(), None, None).is_err());
    assert_eq!(list(&db).unwrap()[0].digest, first.digest);
    let preview = preview_local(&db, source.to_str().unwrap()).unwrap();
    assert_eq!(preview.changed_files, vec!["scripts/helper.txt"]);
    assert_eq!(preview.changes[0].before.as_deref(), Some("v1"));
    assert_eq!(preview.changes[0].after.as_deref(), Some("v2"));
    let second = import_local(
        &db,
        source.to_str().unwrap(),
        Some(&preview.digest),
        preview.existing_digest.as_deref(),
    )
    .unwrap();
    assert_eq!(second.id, first.id);
    assert_eq!(
        installations(&db, &registry, &home, &first.id).unwrap()[0].state,
        "update_available"
    );
    assert_eq!(
        install(
            &db,
            &registry,
            &home,
            &first.id,
            "claude_code",
            Scope::Global,
            None
        )
        .status,
        "installed"
    );
    assert_eq!(
        fs::read_to_string(path.join("scripts/helper.txt")).unwrap(),
        "v2"
    );
    fs::write(path.join("scripts/helper.txt"), "external").unwrap();
    let failed = remove(
        &db,
        &registry,
        &home,
        &first.id,
        "claude_code",
        Scope::Global,
        None,
    );
    assert_eq!(failed.status, "failed");
    assert_eq!(
        fs::read_to_string(path.join("scripts/helper.txt")).unwrap(),
        "external"
    );
}

#[test]
fn native_scan_and_explicit_takeover_compare_files_and_reject_stale_preview() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let registry = Registry::builtins();
    let source = temp.path().join("my-skill");
    fs::create_dir_all(&source).unwrap();
    fs::write(
        source.join("SKILL.md"),
        "---\nname: my-skill\ndescription: Package\n---\n",
    )
    .unwrap();
    fs::write(source.join("notes.txt"), "package text").unwrap();
    let package = import_local(&db, source.to_str().unwrap(), None, None).unwrap();
    let home = temp.path().join("home");
    let target = home.join(".claude/skills/my-skill");
    fs::create_dir_all(&target).unwrap();
    fs::write(
        target.join("SKILL.md"),
        "---\nname: my-skill\ndescription: Native\n---\n",
    )
    .unwrap();
    fs::write(target.join("notes.txt"), "native text").unwrap();
    let found = scan_native(&db, &registry, &home, "claude_code", Scope::Global, None).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].state, "external");
    assert_eq!(found[0].package_id.as_deref(), Some(package.id.as_str()));
    let preview = preview_target(
        &db,
        &registry,
        &home,
        &package.id,
        "claude_code",
        Scope::Global,
        None,
    )
    .unwrap();
    assert_eq!(preview.status, "conflict");
    assert_eq!(
        preview
            .changes
            .iter()
            .find(|change| change.path == "notes.txt")
            .unwrap()
            .before
            .as_deref(),
        Some("native text")
    );
    assert_eq!(
        install(
            &db,
            &registry,
            &home,
            &package.id,
            "claude_code",
            Scope::Global,
            None
        )
        .status,
        "failed"
    );
    fs::write(target.join("notes.txt"), "changed again").unwrap();
    assert_eq!(
        install_confirmed(
            &db,
            &registry,
            &home,
            &package.id,
            "claude_code",
            Scope::Global,
            None,
            preview.preview_token.as_deref(),
            true
        )
        .status,
        "failed"
    );
    assert_eq!(
        fs::read_to_string(target.join("notes.txt")).unwrap(),
        "changed again"
    );
    let fresh = preview_target(
        &db,
        &registry,
        &home,
        &package.id,
        "claude_code",
        Scope::Global,
        None,
    )
    .unwrap();
    let result = install_confirmed(
        &db,
        &registry,
        &home,
        &package.id,
        "claude_code",
        Scope::Global,
        None,
        fresh.preview_token.as_deref(),
        true,
    );
    assert_eq!(result.status, "installed", "{}", result.detail);
    assert_eq!(
        fs::read_to_string(target.join("notes.txt")).unwrap(),
        "package text"
    );
    assert_eq!(
        scan_native(&db, &registry, &home, "claude_code", Scope::Global, None).unwrap()[0].state,
        "managed"
    );
}

#[test]
fn interrupted_skill_replacement_recovers_old_directory_and_committed_cleanup() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let registry = Registry::builtins();
    let source = temp.path().join("my-skill");
    fs::create_dir_all(&source).unwrap();
    fs::write(
        source.join("SKILL.md"),
        "---\nname: my-skill\ndescription: Package\n---\n",
    )
    .unwrap();
    fs::write(source.join("notes.txt"), "new").unwrap();
    let package = import_local(&db, source.to_str().unwrap(), None, None).unwrap();
    let home = temp.path().join("home");
    let target = home.join(".claude/skills/my-skill");
    fs::create_dir_all(&target).unwrap();
    fs::write(
        target.join("SKILL.md"),
        "---\nname: my-skill\ndescription: Old\n---\n",
    )
    .unwrap();
    fs::write(target.join("notes.txt"), "old").unwrap();
    let old_digest = on_disk(&target).unwrap();
    let parent = target.parent().unwrap();
    let id = Uuid::new_v4().to_string();
    let stage = parent.join(format!(".cliora-stage-{id}"));
    let backup = parent.join(format!(".cliora-backup-{id}"));
    fs::create_dir(&stage).unwrap();
    fs::write(
        stage.join("SKILL.md"),
        fs::read(source.join("SKILL.md")).unwrap(),
    )
    .unwrap();
    fs::write(stage.join("notes.txt"), "new").unwrap();
    save_operation(
        &db,
        &SkillOperation {
            id: id.clone(),
            package_id: package.id.clone(),
            tool: "claude_code".into(),
            scope_key: "global".into(),
            target: target.clone(),
            stage: stage.clone(),
            backup: backup.clone(),
            old_digest,
            old_managed_digest: None,
            new_digest: Some(package.digest.clone()),
            removing: false,
            status: "prepared".into(),
        },
    )
    .unwrap();
    fs::rename(&target, &backup).unwrap();
    fs::rename(&stage, &target).unwrap();
    drop(db);
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    recover(&db).unwrap();
    assert_eq!(fs::read_to_string(target.join("notes.txt")).unwrap(), "old");
    assert!(!backup.exists());
    let preview = preview_target(
        &db,
        &registry,
        &home,
        &package.id,
        "claude_code",
        Scope::Global,
        None,
    )
    .unwrap();
    assert_eq!(
        install_confirmed(
            &db,
            &registry,
            &home,
            &package.id,
            "claude_code",
            Scope::Global,
            None,
            preview.preview_token.as_deref(),
            true
        )
        .status,
        "installed"
    );
    let second_id = Uuid::new_v4().to_string();
    let second_stage = parent.join(format!(".cliora-stage-{second_id}"));
    let second_backup = parent.join(format!(".cliora-backup-{second_id}"));
    fs::create_dir(&second_backup).unwrap();
    fs::write(
        second_backup.join("SKILL.md"),
        "---\nname: my-skill\ndescription: Old\n---\n",
    )
    .unwrap();
    fs::write(second_backup.join("notes.txt"), "old").unwrap();
    save_operation(
        &db,
        &SkillOperation {
            id: second_id,
            package_id: package.id.clone(),
            tool: "claude_code".into(),
            scope_key: "global".into(),
            target: target.clone(),
            stage: second_stage,
            backup: second_backup.clone(),
            old_digest: on_disk_as(&second_backup, "my-skill").unwrap(),
            old_managed_digest: None,
            new_digest: Some(package.digest.clone()),
            removing: false,
            status: "committed".into(),
        },
    )
    .unwrap();
    drop(db);
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    recover(&db).unwrap();
    assert!(!second_backup.exists());
    assert_eq!(fs::read_to_string(target.join("notes.txt")).unwrap(), "new");
    let third_id = Uuid::new_v4().to_string();
    let third_backup = parent.join(format!(".cliora-backup-{third_id}"));
    fs::create_dir(&third_backup).unwrap();
    fs::write(
        third_backup.join("SKILL.md"),
        "---\nname: my-skill\ndescription: Old\n---\n",
    )
    .unwrap();
    fs::write(third_backup.join("notes.txt"), "old").unwrap();
    save_operation(
        &db,
        &SkillOperation {
            id: third_id.clone(),
            package_id: package.id.clone(),
            tool: "claude_code".into(),
            scope_key: "global".into(),
            target: target.clone(),
            stage: parent.join(format!(".cliora-stage-{third_id}")),
            backup: third_backup.clone(),
            old_digest: on_disk_as(&third_backup, "my-skill").unwrap(),
            old_managed_digest: None,
            new_digest: Some(package.digest.clone()),
            removing: false,
            status: "committed".into(),
        },
    )
    .unwrap();
    fs::remove_dir_all(&target).unwrap();
    drop(db);
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    recover(&db).unwrap();
    assert_eq!(fs::read_to_string(target.join("notes.txt")).unwrap(), "old");
    assert!(!third_backup.exists());
    assert!(installations(&db, &registry, &home, &package.id)
        .unwrap()
        .is_empty());
}

#[test]
fn import_rejects_missing_skill_manifest() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let source = temp.path().join("empty-skill");
    fs::create_dir_all(&source).unwrap();
    assert!(import_local(&db, source.to_str().unwrap(), None, None).is_err());
}

#[test]
fn zip_import_keeps_bundle_and_requires_explicit_subdirectory_when_ambiguous() {
    use std::io::{Cursor, Write};
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    writer
        .start_file("repo-main/skills/alpha/SKILL.md", options)
        .unwrap();
    writer
        .write_all(b"---\nname: alpha\ndescription: Alpha\n---\n")
        .unwrap();
    writer
        .start_file("repo-main/skills/alpha/scripts/run.txt", options)
        .unwrap();
    writer.write_all(b"whole resource").unwrap();
    writer
        .start_file("repo-main/skills/beta/SKILL.md", options)
        .unwrap();
    writer
        .write_all(b"---\nname: beta\ndescription: Beta\n---\n")
        .unwrap();
    let bytes = writer.finish().unwrap().into_inner();
    assert!(import_zip_bytes(&db, "https://example.com/archive.zip", None, bytes.clone()).is_err());
    let package = import_zip_bytes(
        &db,
        "https://example.com/archive.zip",
        Some("repo-main/skills/alpha"),
        bytes,
    )
    .unwrap();
    assert_eq!(package.name, "alpha");
    assert_eq!(package.file_count, 2);
    assert_eq!(
        package.source,
        "https://example.com/archive.zip#repo-main/skills/alpha"
    );
}

#[test]
fn zip_import_rejects_parent_path_before_any_package_is_saved() {
    use std::io::{Cursor, Write};
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .start_file(
            "../escape/SKILL.md",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
    writer
        .write_all(b"---\nname: escape\ndescription: Nope\n---\n")
        .unwrap();
    let bytes = writer.finish().unwrap().into_inner();
    assert!(import_zip_bytes(&db, "https://example.com/escape.zip", None, bytes).is_err());
    assert!(list(&db).unwrap().is_empty());
}
