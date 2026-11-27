//! Shared safe file primitives, against real temporary directories.
use super::*;
use std::fs;

fn root() -> (tempfile::TempDir, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("project");
    fs::create_dir_all(root.join("src")).unwrap();
    (temp, root)
}

#[test]
fn paths_inside_the_root_resolve_inside_including_new_files() {
    let (_temp, root) = root();
    fs::write(root.join("src/a.ts"), "a").unwrap();
    let inside = resolve_within_protected(&root, &root.join("src/a.ts"), &[]).unwrap();
    assert!(inside.inside());
    assert_eq!(inside.path(), fs::canonicalize(root.join("src/a.ts")).unwrap());
    // A file that does not exist yet, under a directory that does not either.
    let new = resolve_within_protected(&root, &root.join("src/new/b.ts"), &[]).unwrap();
    assert!(new.inside());
    assert_eq!(new.path(), fs::canonicalize(root.join("src")).unwrap().join("new").join("b.ts"));
    // The root itself is inside.
    assert!(resolve_within_protected(&root, &root, &[]).unwrap().inside());
}

#[test]
fn dot_dot_and_sibling_paths_are_outside() {
    let (temp, root) = root();
    fs::write(temp.path().join("secret.txt"), "s").unwrap();
    let escaped = resolve_within_protected(&root, &root.join("..").join("secret.txt"), &[]).unwrap();
    assert!(!escaped.inside(), "经 .. 跳出目录必须判为目录外");
    assert_eq!(escaped.path(), fs::canonicalize(temp.path().join("secret.txt")).unwrap());
    // A sibling whose name merely starts like the root is not inside it.
    fs::create_dir_all(temp.path().join("project-other")).unwrap();
    let sibling = resolve_within_protected(&root, &temp.path().join("project-other").join("x"), &[]).unwrap();
    assert!(!sibling.inside());
    // On Unix, `..` after a component that does not exist cannot be resolved
    // physically. Windows folds `..` lexically before the filesystem sees the
    // path, so the same path names root\x there, exactly as the OS opens it.
    let folded = resolve_within_protected(&root, &root.join("missing").join("..").join("x"), &[]);
    if cfg!(windows) {
        assert_eq!(folded.unwrap(), Resolved::Inside(fs::canonicalize(&root).unwrap().join("x")));
    } else {
        assert!(folded.is_err());
    }
}

#[cfg(unix)]
#[test]
fn a_symbolic_link_out_of_the_root_is_outside() {
    let (temp, root) = root();
    let outside = temp.path().join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("key.txt"), "k").unwrap();
    std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
    let through = resolve_within_protected(&root, &root.join("link").join("key.txt"), &[]).unwrap();
    assert!(!through.inside(), "经符号链接跳出目录必须判为目录外");
    // A new file under the link lands outside too.
    let created = resolve_within_protected(&root, &root.join("link").join("new.txt"), &[]).unwrap();
    assert!(!created.inside());
}

#[cfg(windows)]
#[test]
fn a_junction_out_of_the_root_is_outside() {
    let (temp, root) = root();
    let outside = temp.path().join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("key.txt"), "k").unwrap();
    let link = root.join("link");
    let status = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&link)
        .arg(&outside)
        .stdout(std::process::Stdio::null())
        .status()
        .unwrap();
    assert!(status.success(), "无法创建联接点");
    let through = resolve_within_protected(&root, &link.join("key.txt"), &[]).unwrap();
    assert!(!through.inside(), "经联接点跳出目录必须判为目录外");
    let created = resolve_within_protected(&root, &link.join("new.txt"), &[]).unwrap();
    assert!(!created.inside());
    assert!(within(created.path(), &fs::canonicalize(&outside).unwrap()));
}

#[test]
fn relative_device_and_stream_paths_are_refused() {
    let (_temp, root) = root();
    assert!(resolve_within_protected(&root, Path::new("src/a.ts"), &[]).is_err(), "相对路径必须拒绝");
    assert!(resolve_within_protected(&root, Path::new(""), &[]).is_err());
    #[cfg(windows)]
    {
        for path in [r"\\.\COM1", r"\\.\PhysicalDrive0", r"\\?\C:\Windows\win.ini", r"\\server\share\x.txt", r"C:relative.txt"] {
            assert!(resolve_within_protected(&root, Path::new(path), &[]).is_err(), "{path} 必须拒绝");
        }
        let stream = root.join("src").join("a.ts:hidden");
        assert!(resolve_within_protected(&root, &stream, &[]).is_err(), "ADS 必须拒绝");
        for name in ["NUL", "con.txt", "COM1", "lpt9.log"] {
            assert!(resolve_within_protected(&root, &root.join(name), &[]).is_err(), "{name} 必须拒绝");
        }
    }
}

#[test]
fn targets_of_the_wrong_kind_are_refused_before_classification_is_used() {
    let (temp, root) = root();
    fs::write(root.join("src/a.ts"), "a").unwrap();
    fs::write(temp.path().join("outside.txt"), "o").unwrap();
    fs::create_dir_all(temp.path().join("outside-dir")).unwrap();
    let file = |path: &Path| resolve_target_protected(&root, path, Expect::File, &[]);
    let write = |path: &Path| resolve_target_protected(&root, path, Expect::FileOrNew, &[]);
    let directory = |path: &Path| resolve_target_protected(&root, path, Expect::Directory, &[]);
    // The right kind resolves as before, inside or outside.
    assert!(file(&root.join("src/a.ts")).unwrap().inside());
    assert!(!file(&temp.path().join("outside.txt")).unwrap().inside());
    assert!(write(&root.join("src/new/b.ts")).unwrap().inside());
    assert!(!write(&temp.path().join("outside-new.txt")).unwrap().inside());
    assert!(!directory(&temp.path().join("outside-dir")).unwrap().inside());
    assert!(directory(&root).unwrap().inside());
    // A directory is not a file, outside or inside.
    assert!(file(&temp.path().join("outside-dir")).unwrap_err().contains("普通文件"));
    assert!(write(&temp.path().join("outside-dir")).unwrap_err().contains("普通文件"));
    assert!(file(&root.join("src")).is_err());
    // A file is not a working directory; a missing one is not either.
    assert!(directory(&temp.path().join("outside.txt")).unwrap_err().contains("目录"));
    assert!(directory(&temp.path().join("missing-dir")).is_err());
    // A read needs an existing file; a write may create one, but not under a file.
    assert!(file(&temp.path().join("missing.txt")).unwrap_err().contains("不存在"));
    assert!(write(&temp.path().join("outside.txt").join("x")).is_err(), "文件下不能新建文件");
}

#[cfg(unix)]
#[test]
fn devices_and_pipes_are_refused_whatever_the_location() {
    let (temp, root) = root();
    for expect in [Expect::File, Expect::FileOrNew, Expect::Directory] {
        let refused = resolve_target_protected(&root, Path::new("/dev/null"), expect, &[]);
        assert!(refused.is_err(), "/dev/null 必须拒绝（{expect:?}）");
    }
    for (dir, name) in [(temp.path().to_path_buf(), "outside.fifo"), (root.clone(), "inside.fifo")] {
        let fifo = dir.join(name);
        let status = std::process::Command::new("mkfifo").arg(&fifo).status().unwrap();
        assert!(status.success(), "无法创建 FIFO");
        assert!(resolve_target_protected(&root, &fifo, Expect::File, &[]).unwrap_err().contains("普通文件"));
        assert!(resolve_target_protected(&root, &fifo, Expect::FileOrNew, &[]).is_err());
    }
}

#[test]
fn reads_require_a_regular_text_file_and_honour_line_and_limit() {
    let (_temp, root) = root();
    let file = root.join("src").join("lines.txt");
    fs::write(&file, "one\ntwo\r\nthree\nfour").unwrap();
    assert_eq!(read_text(&file, None, None, MAX_READ_BYTES).unwrap(), "one\ntwo\r\nthree\nfour");
    assert_eq!(read_text(&file, Some(2), Some(2), MAX_READ_BYTES).unwrap(), "two\r\nthree\n");
    assert_eq!(read_text(&file, Some(4), None, MAX_READ_BYTES).unwrap(), "four");
    assert_eq!(read_text(&file, None, Some(1), MAX_READ_BYTES).unwrap(), "one\n");
    assert_eq!(read_text(&file, Some(9), Some(3), MAX_READ_BYTES).unwrap(), "");
    // A directory is not a regular file.
    assert!(read_text(&root.join("src"), None, None, MAX_READ_BYTES).unwrap_err().contains("普通文件"));
    // Invalid UTF-8 is reported, not replaced.
    let binary = root.join("bin.dat");
    fs::write(&binary, [0xff, 0xfe, 0x00]).unwrap();
    assert!(read_text(&binary, None, None, MAX_READ_BYTES).unwrap_err().contains("UTF-8"));
    // The size bound holds.
    assert!(read_text(&file, None, None, 4).is_err());
    assert!(read_text(&root.join("missing.txt"), None, None, MAX_READ_BYTES).is_err());
}

#[test]
fn writes_replace_atomically_and_return_the_previous_text() {
    let (_temp, root) = root();
    let file = root.join("src").join("a.ts");
    fs::write(&file, "old\n").unwrap();
    let outcome = write_text_atomic(&file, "new\n").unwrap();
    assert_eq!(outcome, WriteOutcome { old: Some("old\n".into()), existed: true, old_omitted: false });
    assert_eq!(fs::read_to_string(&file).unwrap(), "new\n");
    // No temporary file is left beside the target.
    let names: Vec<String> = fs::read_dir(root.join("src")).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(names, ["a.ts"]);
    // A new file, in a directory that is created on the way.
    let created = root.join("src").join("deep").join("b.ts");
    let outcome = write_text_atomic(&created, "b").unwrap();
    assert_eq!(outcome, WriteOutcome { old: None, existed: false, old_omitted: false });
    assert_eq!(fs::read_to_string(&created).unwrap(), "b");
    // A previous content that is not text is replaced but not kept.
    let binary = root.join("bin.dat");
    fs::write(&binary, [0xff, 0xfe]).unwrap();
    assert_eq!(write_text_atomic(&binary, "t").unwrap(), WriteOutcome { old: None, existed: true, old_omitted: true });
    // A directory is never replaced.
    assert!(write_text_atomic(&root.join("src"), "x").is_err());
    assert!(root.join("src").is_dir());
}

#[cfg(unix)]
#[test]
fn writes_keep_the_original_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let (_temp, root) = root();
    let file = root.join("run.sh");
    fs::write(&file, "#!/bin/sh\n").unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o750)).unwrap();
    write_text_atomic(&file, "#!/bin/sh\necho hi\n").unwrap();
    assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o750);
}

#[test]
fn the_application_data_directory_is_refused_even_inside_the_root() {
    let (temp, root) = root();
    let data = temp.path().join("cliora-data");
    fs::create_dir_all(&data).unwrap();
    fs::write(data.join("cliora.db"), "db").unwrap();
    let protected = vec![data.clone()];
    let refused = resolve_within_protected(&root, &data.join("cliora.db"), &protected).unwrap_err();
    assert_eq!(refused, PROTECTED_MESSAGE);
    assert!(resolve_within_protected(&root, &data.join("new-file"), &protected).is_err());
    // A protected directory under the session root is refused as well: being
    // inside the session directory is not a grant for Cliora's own data.
    let nested = root.join("app-data");
    fs::create_dir_all(&nested).unwrap();
    assert!(resolve_within_protected(&root, &nested.join("x"), std::slice::from_ref(&nested)).is_err());
    // And a path that reaches it through `..` is refused, not merely outside.
    let sneaky = root.join("..").join("cliora-data").join("cliora.db");
    assert_eq!(resolve_within_protected(&root, &sneaky, &protected).unwrap_err(), PROTECTED_MESSAGE);
    // The global registry feeds resolve_target.
    protect(&data);
    assert_eq!(resolve_target(&root, &data.join("cliora.db"), Expect::File).unwrap_err(), PROTECTED_MESSAGE);
    assert!(is_protected(&fs::canonicalize(&data).unwrap(), &protected_roots()));
}

#[test]
fn display_drops_the_verbatim_prefix() {
    let (_temp, root) = root();
    let canonical = fs::canonicalize(&root).unwrap();
    let shown = display(&canonical);
    assert!(!shown.starts_with(r"\\?\"), "{shown}");
}
