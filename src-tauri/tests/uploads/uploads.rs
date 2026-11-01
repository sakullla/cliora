use super::*;
use std::io::Read;
use std::path::Path;
use std::process::Command;

use super::super::hide_console_window;
use super::super::tests::with_local_transport;

fn upload_target() -> RemoteTarget {
    RemoteTarget {
        id: "upload-fixture.invalid".into(),
        name: "upload-fixture.invalid".into(),
        host: "upload-fixture.invalid".into(),
        port: 22,
        user: "root".into(),
        auth_method: "key".into(),
        identity_file: None,
        ssh_config: None,
        default_path: None,
        enabled: true,
        created_at: 0,
        updated_at: 0,
    }
}

#[test]
fn file_names_split_and_candidates_increment_without_overwriting() {
    assert_eq!(split_file_name("report.tar.gz"), ("report.tar", Some("gz")));
    assert_eq!(split_file_name("archive"), ("archive", None));
    assert_eq!(split_file_name(".gitignore"), (".gitignore", None));
    assert_eq!(claim_candidates("report.tar.gz", 4), [
        "report.tar.gz", "report.tar-1.gz", "report.tar-2.gz", "report.tar-3.gz",
    ]);
    assert_eq!(claim_candidates("archive", 3), ["archive", "archive-1", "archive-2"]);
    assert_eq!(claim_candidates(".gitignore", 2), [".gitignore", ".gitignore-1"]);
    let bounded = claim_candidates("name.txt", 100);
    assert_eq!(bounded.len(), 100);
    assert_eq!(bounded[99], "name-99.txt");
}

#[test]
fn claim_command_claims_first_free_name_and_reports_exhaustion() {
    let candidates = claim_candidates("report.pdf", 4);
    let command = claim_command(
        "/srv/demo/.cliora/uploads",
        "/srv/demo/.cliora/uploads/.cliora-upload-abc",
        &candidates,
    )
    .unwrap();
    assert!(!command.contains('\n'));
    assert!(command.starts_with(
        "dir='/srv/demo/.cliora/uploads'; tmp='/srv/demo/.cliora/uploads/.cliora-upload-abc'; "
    ));
    for candidate in &candidates {
        assert!(command.contains(&format!(
            "name='{candidate}'; if ln -- \"$tmp\" \"$dir/$name\" 2>/dev/null; then rm -f -- \"$tmp\"; printf '%s\\n' \"$dir/$name\"; exit 0; fi; "
        )));
    }
    assert_eq!(command.matches("if ln -- ").count(), 4, "one claim attempt per candidate");
    assert!(command.ends_with(">&2; exit 48"), "exhausted names fail distinctly: {command}");

    let odd = claim_command(
        "/srv/demo/.cliora/uploads",
        "/srv/demo/.cliora/uploads/.cliora-upload-abc",
        &["it's a 'file' (1).txt".to_owned()],
    )
    .unwrap();
    assert!(odd.contains("name='it'\\''s a '\\''file'\\'' (1).txt';"), "odd names stay quoted data: {odd}");

    let directory = "/srv/demo/.cliora/uploads";
    let temporary = "/srv/demo/.cliora/uploads/.cliora-upload-abc";
    assert!(claim_command(directory, temporary, &[]).is_err(), "no candidates is invalid");
    assert!(claim_command("~/uploads", temporary, &candidates).is_err());
    assert!(claim_command(directory, temporary, &["bad/name".to_owned()]).is_err());
    assert!(claim_command(directory, temporary, &["line\nbreak".to_owned()]).is_err());
}

#[test]
fn upload_directory_and_prepare_command_reuse_and_validate_paths() {
    assert_eq!(upload_directory("/srv/demo").unwrap(), "/srv/demo/.cliora/uploads");
    assert_eq!(upload_directory("/srv/demo/").unwrap(), "/srv/demo/.cliora/uploads");
    assert!(upload_directory("~/demo").is_err());
    assert!(upload_directory("/srv/demo\nhidden").is_err());
    assert!(upload_directory("").is_err());

    let directory = upload_directory("/srv/demo").unwrap();
    let command = upload_directory_prepare_command("/srv/demo", &directory).unwrap();
    assert!(!command.contains('\n'));
    assert!(command.contains("parent='/srv/demo';"));
    assert!(command.contains("mkdir -- \"$parent/.cliora\" 2>/dev/null"));
    assert!(command.contains("mkdir -- \"$parent/uploads\" 2>/dev/null"));
    assert!(command.contains("[ -d \"$parent/uploads\" ]"), "an existing directory counts as success");

    assert!(upload_directory_prepare_command("~/demo", &directory).is_err());
    assert!(upload_directory_prepare_command("/srv/demo", "/srv/demo/.cliora/other").is_err());
    assert!(upload_directory_prepare_command("/srv/demo/", &format!("{}/.cliora/uploads", "/srv/demo")).is_ok());
}

#[test]
fn batch_script_quotes_both_operands_of_every_put() {
    assert_eq!(escape_sftp_text("a\"b\\c"), "a\\\"b\\\\c");
    #[cfg(windows)]
    assert_eq!(batch_local_path("C:\\Users\\me\\a b.txt"), "C:/Users/me/a b.txt");

    let entries = [
        UploadEntry {
            local_path: "/tmp/data.bin".into(),
            file_name: "data.bin".into(),
            temporary_path: "/srv/demo/.cliora/uploads/.cliora-upload-one".into(),
        },
        UploadEntry {
            local_path: "quote \"name\".txt".into(),
            file_name: "quote \"name\".txt".into(),
            temporary_path: "/srv/demo/.cliora/uploads/.cliora-upload-two".into(),
        },
    ];
    let script = upload_batch_script(&entries);
    let lines: Vec<&str> = script.lines().collect();
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0], "put \"/tmp/data.bin\" \"/srv/demo/.cliora/uploads/.cliora-upload-one\"");
    assert_eq!(lines[1], "put \"quote \\\"name\\\".txt\" \"/srv/demo/.cliora/uploads/.cliora-upload-two\"");
}

#[test]
fn local_input_precheck_rejects_directories_and_unreadable_files() {
    let fixture = tempfile::tempdir().unwrap();
    let file = fixture.path().join("readable.txt");
    std::fs::write(&file, "body").unwrap();
    assert_eq!(precheck_local_file(&file.to_string_lossy()).unwrap(), "readable.txt");

    let directory = fixture.path().join("folder");
    std::fs::create_dir(&directory).unwrap();
    let error = precheck_local_file(&directory.to_string_lossy()).unwrap_err().to_string();
    assert!(error.contains("目录"), "{error}");

    let missing = fixture.path().join("absent.txt");
    let error = precheck_local_file(&missing.to_string_lossy()).unwrap_err().to_string();
    assert!(error.contains("不存在"), "{error}");

    let error = precheck_local_file("control\ncharacter.txt").unwrap_err().to_string();
    assert!(error.contains("无效"), "{error}");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let secret = fixture.path().join("secret.txt");
        std::fs::write(&secret, "body").unwrap();
        std::fs::set_permissions(&secret, std::fs::Permissions::from_mode(0o000)).unwrap();
        let error = precheck_local_file(&secret.to_string_lossy()).unwrap_err().to_string();
        assert!(error.contains("不可读"), "{error}");
        std::fs::set_permissions(&secret, std::fs::Permissions::from_mode(0o644)).unwrap();
    }
}

#[test]
fn claim_command_links_first_free_name_and_never_overwrites() {
    #[cfg(windows)]
    let shell = std::env::var("CLIORA_TEST_POSIX_SHELL")
        .unwrap_or_else(|_| "C:/Program Files/Git/bin/bash.exe".into());
    #[cfg(not(windows))]
    let shell = "/bin/sh".to_owned();
    if !Path::new(&shell).exists() {
        eprintln!("POSIX shell unavailable; native claim checks still required");
        return;
    }
    let fixture = tempfile::tempdir().unwrap();
    let uploads = fixture.path().join("uploads");
    std::fs::create_dir(&uploads).unwrap();
    let directory = uploads.to_string_lossy().replace('\\', "/");
    let temporary = format!("{directory}/.cliora-upload-abc");
    let candidates = claim_candidates("report.pdf", 3);
    let run = || {
        let mut command = Command::new(&shell);
        command.arg("-c").arg(claim_command(&directory, &temporary, &candidates).unwrap());
        hide_console_window(&mut command);
        command.output().unwrap()
    };

    std::fs::write(&temporary, "fresh-body").unwrap();
    let first = run();
    assert!(first.status.success(), "{}", String::from_utf8_lossy(&first.stderr));
    assert_eq!(String::from_utf8_lossy(&first.stdout).trim(), format!("{directory}/report.pdf"));
    assert_eq!(std::fs::read_to_string(format!("{directory}/report.pdf")).unwrap(), "fresh-body");
    assert!(!Path::new(&temporary).exists(), "a claimed temporary name is cleaned up");

    std::fs::write(format!("{directory}/report.pdf"), "original").unwrap();
    std::fs::write(format!("{directory}/report-1.pdf"), "one").unwrap();
    std::fs::write(&temporary, "second-body").unwrap();
    let second = run();
    assert!(second.status.success(), "{}", String::from_utf8_lossy(&second.stderr));
    assert_eq!(String::from_utf8_lossy(&second.stdout).trim(), format!("{directory}/report-2.pdf"));
    assert_eq!(
        std::fs::read_to_string(format!("{directory}/report.pdf")).unwrap(),
        "original",
        "an existing remote file is never overwritten"
    );
    assert!(!Path::new(&temporary).exists());

    std::fs::write(format!("{directory}/report-2.pdf"), "two").unwrap();
    std::fs::write(&temporary, "third-body").unwrap();
    let exhausted = run();
    assert_eq!(exhausted.status.code(), Some(48));
    assert!(Path::new(&temporary).exists(), "an unclaimed temporary file is kept");
}

/// Map a Windows temp path to its WSL view so the claim commands run in a real
/// POSIX shell through the local transport while the assertions stay native.
#[cfg(windows)]
fn wsl_path(windows_path: &Path) -> String {
    let text = windows_path.to_string_lossy().replace('\\', "/");
    let drive = text.chars().next().unwrap_or('c').to_ascii_lowercase();
    format!("/mnt/{drive}/{}", &text[3..])
}

/// The channel test keeps the remote side inside the WSL tree; the fixture sftp
/// binary maps a remote path back to the native Windows path before copying.
#[cfg(windows)]
fn native_path(remote_path: &str) -> String {
    if let Some(rest) = remote_path.strip_prefix("/mnt/") {
        let mut characters = rest.chars();
        if let Some(drive) = characters.next() {
            let rest = characters.as_str();
            if drive.is_ascii_alphabetic() && rest.starts_with('/') {
                return format!("{}:/{}", drive, &rest[1..]);
            }
        }
    }
    remote_path.to_owned()
}

fn parse_quoted(input: &str) -> Option<(String, &str)> {
    let mut value = String::new();
    let mut characters = input.char_indices();
    while let Some((index, character)) = characters.next() {
        match character {
            '"' => return Some((value, &input[index + 1..])),
            '\\' => match characters.next() {
                Some((_, escaped @ ('"' | '\\'))) => value.push(escaped),
                _ => return None,
            },
            _ => value.push(character),
        }
    }
    None
}

fn parse_put_line(line: &str) -> Option<(String, String)> {
    let rest = line.strip_prefix("put \"")?;
    let (local, rest) = parse_quoted(rest)?;
    let rest = rest.strip_prefix(" \"")?;
    let (remote, rest) = parse_quoted(rest)?;
    rest.is_empty().then_some((local, remote))
}

/// sftp fixture: consumes the batch from stdin and performs each `put` as a
/// local copy, aborting like batch-mode sftp on the first failure.
#[test]
fn upload_sftp_fixture_child() {
    if std::env::var_os("CLIORA_UPLOAD_SFTP_FIXTURE").is_none() {
        return;
    }
    let mut batch = String::new();
    std::io::stdin().read_to_string(&mut batch).unwrap();
    let fail_after: usize = std::env::var("CLIORA_UPLOAD_SFTP_FAIL_AFTER")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(usize::MAX);
    let mut copied = 0usize;
    for line in batch.lines() {
        if line.is_empty() {
            continue;
        }
        let Some((local, remote)) = parse_put_line(line) else {
            eprintln!("sftp: unsupported batch line: {line}");
            std::process::exit(1);
        };
        if copied >= fail_after {
            eprintln!("sftp: \"{remote}\" upload failed");
            std::process::exit(1);
        }
        #[cfg(windows)]
        let remote = native_path(&remote);
        if let Err(error) = std::fs::copy(&local, &remote) {
            eprintln!("sftp: \"{local}\" copy failed: {error}");
            std::process::exit(1);
        }
        copied += 1;
    }
    std::process::exit(0);
}

fn with_sftp_fixture(run: impl FnOnce(&str)) {
    let directory = tempfile::tempdir().unwrap();
    let executable = std::env::current_exe().unwrap().to_string_lossy().replace('\\', "/");
    let child = "remote::uploads::tests::upload_sftp_fixture_child";
    #[cfg(windows)]
    let wrapper = {
        let wrapper = directory.path().join("sftp-fixture.cmd");
        std::fs::write(
            &wrapper,
            format!("@echo off\r\nset CLIORA_UPLOAD_SFTP_FIXTURE=1\r\n\"{executable}\" --exact {child} --nocapture\r\n"),
        )
        .unwrap();
        wrapper
    };
    #[cfg(not(windows))]
    let wrapper = {
        use std::os::unix::fs::PermissionsExt;
        let wrapper = directory.path().join("sftp-fixture.sh");
        std::fs::write(
            &wrapper,
            format!("#!/bin/sh\nCLIORA_UPLOAD_SFTP_FIXTURE=1 exec '{executable}' --exact {child} --nocapture\n"),
        )
        .unwrap();
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
        wrapper
    };
    let binary = wrapper.to_string_lossy().into_owned();
    let previous = std::env::var("CLIORA_SFTP_BINARY").ok();
    std::env::set_var("CLIORA_SFTP_BINARY", &binary);
    struct Restore(Option<String>);
    impl Drop for Restore {
        fn drop(&mut self) {
            match self.0.take() {
                Some(value) => std::env::set_var("CLIORA_SFTP_BINARY", value),
                None => std::env::remove_var("CLIORA_SFTP_BINARY"),
            }
        }
    }
    let _restore = Restore(previous);
    run(&binary);
}

fn uploaded_final_names(directory: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| !name.starts_with(".cliora-upload-"))
        .collect();
    names.sort();
    names
}

#[test]
fn upload_files_moves_through_sftp_temp_and_atomic_claim() {
    let fixture = tempfile::tempdir().unwrap();
    let local_one = fixture.path().join("notes v2.txt");
    std::fs::write(&local_one, "notes body").unwrap();
    let local_two = fixture.path().join("data.bin");
    std::fs::write(&local_two, b"binary\x00body").unwrap();
    let project_root = fixture.path().join("project");
    std::fs::create_dir(&project_root).unwrap();
    #[cfg(windows)]
    let project_path = wsl_path(&project_root);
    #[cfg(not(windows))]
    let project_path = project_root.to_string_lossy().into_owned();
    let uploads_directory = upload_directory(&project_path).unwrap();
    let uploads_prefix = format!("{uploads_directory}/");
    let native_uploads = project_root.join(".cliora").join("uploads");

    let target = upload_target();
    with_local_transport(&target, |_| {
        with_sftp_fixture(|_| {
            let first = upload_files(
                &target,
                &project_path,
                &[local_one.to_string_lossy().into_owned(), local_two.to_string_lossy().into_owned()],
            )
            .unwrap();
            assert_eq!(
                first,
                [format!("{uploads_prefix}notes v2.txt"), format!("{uploads_prefix}data.bin")]
            );
            assert_eq!(std::fs::read(native_uploads.join("notes v2.txt")).unwrap(), b"notes body");
            assert_eq!(std::fs::read(native_uploads.join("data.bin")).unwrap(), b"binary\x00body");
            assert_eq!(uploaded_final_names(&native_uploads), ["data.bin", "notes v2.txt"]);

            let second = upload_files(
                &target,
                &project_path,
                &[local_one.to_string_lossy().into_owned(), local_two.to_string_lossy().into_owned()],
            )
            .unwrap();
            assert_eq!(
                second,
                [format!("{uploads_prefix}notes v2-1.txt"), format!("{uploads_prefix}data-1.bin")],
                "colliding names grow an incremented suffix"
            );
            assert_eq!(std::fs::read(native_uploads.join("notes v2.txt")).unwrap(), b"notes body");
            assert_eq!(
                uploaded_final_names(&native_uploads),
                ["data-1.bin", "data.bin", "notes v2-1.txt", "notes v2.txt"]
            );

            let local_three = fixture.path().join("third.txt");
            std::fs::write(&local_three, "third body").unwrap();
            let local_four = fixture.path().join("fourth.md");
            std::fs::write(&local_four, "fourth body").unwrap();
            std::env::set_var("CLIORA_UPLOAD_SFTP_FAIL_AFTER", "1");
            let error = upload_files(
                &target,
                &project_path,
                &[local_three.to_string_lossy().into_owned(), local_four.to_string_lossy().into_owned()],
            );
            std::env::remove_var("CLIORA_UPLOAD_SFTP_FAIL_AFTER");
            let error = error.unwrap_err();
            assert!(
                matches!(error, RemoteError::Operation(_)),
                "a failed put must fail the whole request: {error}"
            );
            assert_eq!(
                uploaded_final_names(&native_uploads),
                ["data-1.bin", "data.bin", "notes v2-1.txt", "notes v2.txt"],
                "no final name appears when any file fails"
            );
        });
    });
}
