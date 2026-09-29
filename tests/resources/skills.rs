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
