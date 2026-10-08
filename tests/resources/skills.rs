use super::*;

#[test]
fn a_linked_skill_directory_is_read_from_its_target() {
    let temp = tempfile::tempdir().unwrap();
    let real = temp.path().join("source").join("linkup-automation");
    fs::create_dir_all(&real).unwrap();
    fs::write(real.join("SKILL.md"), "---\nname: linkup-automation\ndescription: hello there\n---\n").unwrap();
    let link = temp.path().join("linkup-automation");
    #[cfg(windows)]
    let linked = std::os::windows::fs::symlink_dir(&real, &link);
    #[cfg(not(windows))]
    let linked = std::os::unix::fs::symlink(&real, &link);
    if linked.is_err() { return; }
    let (name, description, _, _, digest) = snapshot(&link).unwrap();
    assert_eq!(name, "linkup-automation");
    assert_eq!(description, "hello there");
    assert!(!digest.is_empty());
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let registry = Registry::builtins();
    let package = import_local(&db, real.to_str().unwrap(), None, None).unwrap();
    let home = temp.path().join("home");
    let linked = home.join(".claude/skills");
    fs::create_dir_all(&linked).unwrap();
    let destination = linked.join("linkup-automation");
    #[cfg(windows)]
    let placed = std::os::windows::fs::symlink_dir(&real, &destination);
    #[cfg(not(windows))]
    let placed = std::os::unix::fs::symlink(&real, &destination);
    if placed.is_err() { return; }
    let preview = preview_target(&db, &registry, &home, &package.id, "claude_code", Scope::Global, None).unwrap();
    assert_eq!(preview.status, "ready");
    let result = install(&db, &registry, &home, &package.id, "claude_code", Scope::Global, None);
    assert_eq!(result.status, "already_current");
    assert!(destination.is_symlink());
}

#[test]
fn skill_switches_restore_each_native_policy_and_complete_archived_package() {
    use crate::credentials::CredentialStore;
    use std::collections::HashMap;
    use std::sync::Mutex;
    #[derive(Default)] struct Store(Mutex<HashMap<String,String>>);
    impl CredentialStore for Store {
        fn put(&self,key:&str,value:&str)->Result<(),String>{self.0.lock().unwrap().insert(key.into(),value.into());Ok(())}
        fn get(&self,key:&str)->Result<String,String>{self.0.lock().unwrap().get(key).cloned().ok_or("missing".into())}
        fn delete(&self,key:&str)->Result<(),String>{self.0.lock().unwrap().remove(key);Ok(())}
    }
    let temp=tempfile::tempdir().unwrap();
    let db=Database::open(&temp.path().join("app.db")).unwrap();
    let store=Store::default(); let registry=Registry::builtins(); let home=temp.path().join("home");
    let mut packages=Vec::new();
    for name in ["alpha","beta"] {
        let source=temp.path().join(name); fs::create_dir_all(source.join("references")).unwrap();
        fs::write(source.join("SKILL.md"),format!("---\nname: {name}\ndescription: Test\n---\n")).unwrap();
        fs::write(source.join("references/原始.txt"),"原始完整资源").unwrap();
        let package=import_local(&db,source.to_str().unwrap(),None,None).unwrap();
        for tool in ["codex","claude_code","open_code","pi"] { let result=install(&db,&registry,&home,&package.id,tool,Scope::Global,None); assert_eq!(result.status,"installed","{tool}: {}",result.detail); }
        packages.push(package);
    }
    let codex=registry.get("codex").unwrap();
    let config=codex.skill_switch_location(Scope::Global,&home,None,"alpha").unwrap().path;
    fs::create_dir_all(config.parent().unwrap()).unwrap();
    let alpha=home.join(".agents/skills/alpha/SKILL.md").display().to_string();
    let initial=serde_json::json!({"skills":{"config":[{"path":alpha,"enabled":true,"extra":"preserve"},{"path":"not-a-real-other/SKILL.md","enabled":false}]}});
    fs::write(&config,toml::to_string(&initial).unwrap()).unwrap();
    for package in &packages { set_enabled(&db,&store,&registry,&home,&package.id,"codex",Scope::Global,None,false).unwrap(); }
    // Repeated disable keeps the first policy, and enabling A leaves B disabled.
    set_enabled(&db,&store,&registry,&home,&packages[0].id,"codex",Scope::Global,None,false).unwrap();
    set_enabled(&db,&store,&registry,&home,&packages[0].id,"codex",Scope::Global,None,true).unwrap();
    assert!(enabled(&db,&registry,&home,&packages[0].id,"codex",Scope::Global,None).unwrap());
    assert!(!enabled(&db,&registry,&home,&packages[1].id,"codex",Scope::Global,None).unwrap());
    set_enabled(&db,&store,&registry,&home,&packages[1].id,"codex",Scope::Global,None,true).unwrap();
    let restored=crate::native::format::parse(crate::native::format::FileKind::Toml,&fs::read_to_string(&config).unwrap()).unwrap();
    assert_eq!(restored,initial);
    let missing=temp.path().join("nonexistent-target");
    let unrelated=serde_json::json!([{"path":"another-missing/SKILL.md","enabled":false}]);
    assert!(codex.skill_switch_enabled(&unrelated,&missing),"failed canonicalization cannot match unrelated paths");
    assert_eq!(codex.skill_switch_value(&unrelated,false,&missing).as_array().unwrap().len(),2);
    for tool in ["claude_code","open_code","pi"] {
        let package=&packages[0];
        let path=target(&registry,&home,tool,Scope::Global,None,&package.name).unwrap().0;
        set_enabled(&db,&store,&registry,&home,&package.id,tool,Scope::Global,None,false).unwrap();
        assert!(!enabled(&db,&registry,&home,&package.id,tool,Scope::Global,None).unwrap());
        if tool=="pi" {assert!(!path.exists()); assert_eq!(installations(&db,&registry,&home,&package.id).unwrap().iter().find(|item|item.tool_id==tool).unwrap().state,"disabled");}
        else {assert_eq!(fs::read_to_string(path.join("references/原始.txt")).unwrap(),"原始完整资源");}
        set_enabled(&db,&store,&registry,&home,&package.id,tool,Scope::Global,None,true).unwrap();
        assert!(enabled(&db,&registry,&home,&package.id,tool,Scope::Global,None).unwrap());
        assert_eq!(fs::read_to_string(path.join("references/原始.txt")).unwrap(),"原始完整资源");
    }
}

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
fn committed_skill_recovery_keeps_a_modified_backup_and_journal() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let source = temp.path().join("my-skill");
    fs::create_dir_all(&source).unwrap();
    fs::write(
        source.join("SKILL.md"),
        "---\nname: my-skill\ndescription: Package\n---\n",
    )
    .unwrap();
    fs::write(source.join("notes.txt"), "new").unwrap();
    let package = import_local(&db, source.to_str().unwrap(), None, None).unwrap();
    let target = temp.path().join("home/.claude/skills/my-skill");
    fs::create_dir_all(&target).unwrap();
    fs::write(
        target.join("SKILL.md"),
        fs::read(source.join("SKILL.md")).unwrap(),
    )
    .unwrap();
    fs::write(target.join("notes.txt"), "new").unwrap();
    let id = Uuid::new_v4().to_string();
    let parent = target.parent().unwrap();
    let backup = parent.join(format!(".cliora-backup-{id}"));
    fs::create_dir(&backup).unwrap();
    fs::write(
        backup.join("SKILL.md"),
        "---\nname: my-skill\ndescription: Old\n---\n",
    )
    .unwrap();
    fs::write(backup.join("notes.txt"), "old").unwrap();
    let old_digest = on_disk_as(&backup, "my-skill").unwrap();
    save_operation(
        &db,
        &SkillOperation {
            id: id.clone(),
            package_id: package.id.clone(),
            tool: "claude_code".into(),
            scope_key: "global".into(),
            target: target.clone(),
            stage: parent.join(format!(".cliora-stage-{id}")),
            backup: backup.clone(),
            old_digest,
            old_managed_digest: None,
            new_digest: Some(package.digest.clone()),
            removing: false,
            status: "committed".into(),
        },
    )
    .unwrap();
    fs::write(backup.join("notes.txt"), "changed after commit").unwrap();
    let other_parent = temp.path().join("home/.codex/skills");
    fs::create_dir_all(&other_parent).unwrap();
    let other_stage = other_parent.join(".cliora-stage-other");
    fs::create_dir(&other_stage).unwrap();
    fs::write(
        other_stage.join("SKILL.md"),
        fs::read(source.join("SKILL.md")).unwrap(),
    )
    .unwrap();
    save_operation(
        &db,
        &SkillOperation {
            id: "other".into(),
            package_id: package.id.clone(),
            tool: "codex".into(),
            scope_key: "global".into(),
            target: other_parent.join("my-skill"),
            stage: other_stage.clone(),
            backup: other_parent.join(".cliora-backup-other"),
            old_digest: None,
            old_managed_digest: None,
            new_digest: Some(package.digest.clone()),
            removing: false,
            status: "prepared".into(),
        },
    )
    .unwrap();
    let issues = recover_report(&db).unwrap();
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].tool_id, "claude_code");
    assert!(issues[0].affects("claude_code", "global"));
    assert!(!issues[0].affects("codex", "global"));
    assert!(
        !other_stage.exists(),
        "healthy later operation must still recover"
    );
    assert_eq!(list(&db).unwrap().len(), 1);
    assert!(scan_native(
        &db,
        &Registry::builtins(),
        &temp.path().join("home"),
        "codex",
        Scope::Global,
        None
    )
    .unwrap()
    .is_empty());
    let unrelated = install(
        &db,
        &Registry::builtins(),
        &temp.path().join("home"),
        &package.id,
        "codex",
        Scope::Global,
        None,
    );
    assert_eq!(unrelated.status, "installed", "{}", unrelated.detail);
    let error = recover(&db).unwrap_err();
    assert!(error.contains("备份"), "{error}");
    assert_eq!(
        fs::read_to_string(backup.join("notes.txt")).unwrap(),
        "changed after commit"
    );
    assert_eq!(fs::read_to_string(target.join("notes.txt")).unwrap(), "new");
    let pending: i64 = db
        .with_connection(|conn| {
            conn.query_row("SELECT COUNT(*) FROM skill_operations", [], |row| {
                row.get(0)
            })
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(pending, 1);
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
    let local_zip = temp.path().join("archive.zip");
    fs::write(&local_zip, &bytes).unwrap();
    let local_source = local_zip.to_str().unwrap();
    let local_db = Database::open(&temp.path().join("local.db")).unwrap();
    assert_eq!(list_zip_entries(local_source, true).unwrap(), vec!["repo-main/skills/alpha", "repo-main/skills/beta"]);
    assert!(preview_local_zip(&local_db, local_source, None).is_err());
    let preview = preview_local_zip(&local_db, local_source, Some("repo-main/skills/beta")).unwrap();
    assert_eq!(preview.file_count, 1);
    assert!(import_local_zip(&local_db, local_source, Some("repo-main/skills/alpha"), Some(&preview.digest), preview.existing_digest.as_deref()).is_err());
    let local_package = import_local_zip(&local_db, local_source, Some("repo-main/skills/alpha"), None, None).unwrap();
    assert_eq!(local_package.file_count, 2);
    assert!(preview_local_zip(&db, local_source, Some("../../outside")).is_err());
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

#[test]
fn loose_frontmatter_stays_readable_and_round_trips_skill_markdown() {
    use crate::credentials::CredentialStore;
    use std::collections::HashMap;
    use std::sync::Mutex;
    #[derive(Default)]
    struct Store(Mutex<HashMap<String, String>>);
    impl CredentialStore for Store {
        fn put(&self, key: &str, value: &str) -> Result<(), String> { self.0.lock().unwrap().insert(key.into(), value.into()); Ok(()) }
        fn get(&self, key: &str) -> Result<String, String> { self.0.lock().unwrap().get(key).cloned().ok_or_else(|| "missing".into()) }
        fn delete(&self, key: &str) -> Result<(), String> { self.0.lock().unwrap().remove(key); Ok(()) }
    }
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let registry = Registry::builtins();
    let home = temp.path().join("home");
    let mismatched = home.join(".claude/skills/crud-page");
    fs::create_dir_all(&mismatched).unwrap();
    let original = "---\nname: other-name\ndescription:\n---\n# page\n";
    fs::write(mismatched.join("SKILL.md"), original).unwrap();
    let bare = home.join(".claude/skills/lark-apps");
    fs::create_dir_all(&bare).unwrap();
    fs::write(bare.join("SKILL.md"), "# just markdown\n").unwrap();
    let described = home.join(".claude/skills/named-elsewhere");
    fs::create_dir_all(&described).unwrap();
    fs::write(described.join("SKILL.md"), "---\nname: wrong\ndescription: still here\n---\n").unwrap();
    let fresh = home.join(".claude/skills/fresh-skill");
    fs::create_dir_all(&fresh).unwrap();

    let found = scan_native(&db, &registry, &home, "claude_code", Scope::Global, None).unwrap();
    assert!(found.iter().all(|entry| entry.state == "external"), "{found:?}");
    assert_eq!(found.iter().map(|entry| entry.name.as_str()).collect::<Vec<_>>(), ["crud-page", "fresh-skill", "lark-apps", "named-elsewhere"]);
    assert_eq!(found.iter().find(|entry| entry.name == "crud-page").unwrap().detail, "");
    assert_eq!(found.iter().find(|entry| entry.name == "named-elsewhere").unwrap().detail, "still here");

    let crud = found.iter().find(|entry| entry.name == "crud-page").unwrap();
    let document = read_document(&db, &registry, &home, "claude_code", Scope::Global, None, &crud.path).unwrap();
    assert_eq!(document.name, "crud-page");
    assert_eq!(document.content, original);
    let edited = format!("{original}\nedited\n");
    let store = Store::default();
    save_document(&db, &store, &registry, &home, "claude_code", Scope::Global, None, &crud.path, &document.content, &edited).unwrap();
    assert_eq!(fs::read_to_string(mismatched.join("SKILL.md")).unwrap(), edited);
    let again = read_document(&db, &registry, &home, "claude_code", Scope::Global, None, &crud.path).unwrap();
    assert_eq!(again.content, edited);
    save_document(&db, &store, &registry, &home, "claude_code", Scope::Global, None, &crud.path, &again.content, &again.content).unwrap();
    let stale = save_document(&db, &store, &registry, &home, "claude_code", Scope::Global, None, &crud.path, &document.content, "nope");
    assert!(stale.is_err(), "{stale:?}");
    assert_eq!(fs::read_to_string(mismatched.join("SKILL.md")).unwrap(), edited);

    let created = read_document(&db, &registry, &home, "claude_code", Scope::Global, None, &fresh.display().to_string()).unwrap();
    assert_eq!(created.content, "");
    save_document(&db, &store, &registry, &home, "claude_code", Scope::Global, None, &created.path, "", "# hello\n").unwrap();
    assert_eq!(fs::read_to_string(fresh.join("SKILL.md")).unwrap(), "# hello\n");

    let outside = temp.path().join("outside");
    fs::create_dir_all(&outside).unwrap();
    assert!(read_document(&db, &registry, &home, "claude_code", Scope::Global, None, &outside.display().to_string()).is_err());

    let source = temp.path().join("loose-skill");
    fs::create_dir_all(&source).unwrap();
    fs::write(source.join("SKILL.md"), "---\nname: not-the-dir\n---\nbody\n").unwrap();
    let package = import_local(&db, source.to_str().unwrap(), None, None).unwrap();
    assert_eq!(package.name, "loose-skill");
    assert!(package.description.is_empty());
}
