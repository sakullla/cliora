#![cfg(debug_assertions)]

use cliora_lib::{
    database::Database,
    remote::{save_target, RemoteTarget},
};
use serde_json::Value;
use std::{
    path::Path,
    process::{Command, Output},
};

fn call(path: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_cliora"))
        .arg("--twiglane-remote-v1")
        .args(args)
        .env("CLIORA_TWIGLANE_TEST_DB", path)
        .output()
        .unwrap()
}

fn error(output: Output) -> Value {
    assert!(!output.status.success());
    serde_json::from_slice::<Value>(&output.stderr).unwrap()["error"].clone()
}

#[test]
fn desktop_exit_mode_resolves_only_current_enabled_targets_and_rejects_untrusted_uploads() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("cliora.db");
    let version = call(&path, &["version"]);
    assert_eq!(
        serde_json::from_slice::<Value>(&version.stdout).unwrap()["protocol"],
        1
    );
    assert!(!path.exists());
    assert_eq!(error(call(&path, &["list"])), "database_unavailable");
    assert!(!path.exists());
    let db = Database::open(&path).unwrap();
    assert_eq!(error(call(&path, &["list"])), "remote_disabled");
    db.update_preferences(|prefs| prefs.remote_ssh_enabled = true)
        .unwrap();
    let ssh_config = home.path().join("ssh_config");
    let initial_config = "Host test.invalid\n  HostName first.invalid\n  HostKeyAlias first-key\n";
    std::fs::write(&ssh_config, initial_config).unwrap();
    let mut target = RemoteTarget {
        id: "test-build".into(),
        name: "Build box".into(),
        host: "test.invalid".into(),
        port: 22,
        user: "builder".into(),
        auth_method: "key".into(),
        identity_file: Some("/private/test-key".into()),
        ssh_config: Some(ssh_config.to_string_lossy().into_owned()),
        default_path: None,
        enabled: true,
        created_at: 0,
        updated_at: 0,
    };
    save_target(&db, target.clone()).unwrap();
    let listed = call(&path, &["list"]);
    assert!(listed.status.success());
    let listed: Value = serde_json::from_slice(&listed.stdout).unwrap();
    let first = &listed["targets"][0];
    assert_eq!(first["targetId"], "test-build");
    assert!(first.get("identityFile").is_none());
    let revision = first["targetRevision"].as_str().unwrap();
    assert_eq!(
        error(call(
            &path,
            &["install", &target.id, revision, &"0".repeat(64), "bad"]
        )),
        "invalid_artifact"
    );
    assert_eq!(first["effectiveHost"], "first.invalid");
    for config in [
        "Host test.invalid\n  HostName second.invalid\n  HostKeyAlias first-key\n",
        "Host test.invalid\n  HostName first.invalid\n  HostKeyAlias second-key\n",
    ] {
        std::fs::write(&ssh_config, config).unwrap();
        assert_eq!(
            error(call(&path, &["probe", &target.id, revision])),
            "target_changed"
        );
    }
    std::fs::write(&ssh_config, initial_config).unwrap();
    target.host = "other.invalid".into();
    save_target(&db, target.clone()).unwrap();
    assert_eq!(
        error(call(&path, &["probe", &target.id, revision])),
        "target_changed"
    );
    target.enabled = false;
    save_target(&db, target.clone()).unwrap();
    let listed: Value = serde_json::from_slice(&call(&path, &["list"]).stdout).unwrap();
    assert_eq!(listed["targets"].as_array().unwrap().len(), 0);
    assert_eq!(
        error(call(&path, &["probe", &target.id, revision])),
        "target_unavailable"
    );
    assert_eq!(
        error(call(&path, &["exec", "arbitrary"])),
        "unsupported_action"
    );
}

#[cfg(unix)]
#[test]
fn missing_and_cancelled_session_passwords_do_not_connect() {
    use std::{ffi::OsString, fs, os::unix::fs::PermissionsExt};

    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("cliora.db");
    let db = Database::open(&path).unwrap();
    db.update_preferences(|prefs| prefs.remote_ssh_enabled = true)
        .unwrap();
    let target = save_target(
        &db,
        RemoteTarget {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Password test".into(),
            host: "unreachable.invalid".into(),
            port: 22,
            user: "fixture".into(),
            auth_method: "password".into(),
            identity_file: None,
            ssh_config: None,
            default_path: None,
            enabled: true,
            created_at: 0,
            updated_at: 0,
        },
    )
    .unwrap();
    let app = env!("CARGO_BIN_EXE_cliora");
    let family = "--twiglane-remote-v1";

    let fake_ssh = home.path().join("ssh");
    let cancelled = home.path().join("cancel-prompt");
    // Exercise OpenSSH's cancellation exit, without a live login attempt or entering a password.
    fs::write(
        &fake_ssh,
        "#!/bin/sh\nif [ \"$1\" = -G ]; then exec /usr/bin/ssh \"$@\"; fi\n\"$SSH_ASKPASS\" 'Password:' || exit 255\nexit 1\n",
    )
    .unwrap();
    fs::write(&cancelled, "#!/bin/sh\nexit 1\n").unwrap();
    for file in [&fake_ssh, &cancelled] {
        fs::set_permissions(file, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let mut search_path = OsString::from(home.path());
    search_path.push(":");
    search_path.push(std::env::var_os("PATH").unwrap_or_default());
    let fixture_command = || {
        let mut command = Command::new(app);
        command
            .arg(family)
            .env("CLIORA_TWIGLANE_TEST_DB", &path)
            .env("HOME", home.path())
            .env("XDG_DATA_HOME", home.path())
            .env("CLIORA_SSH_PROXY", "off")
            .env_remove("SSH_ASKPASS")
            .env_remove("SSH_ASKPASS_REQUIRE")
            .env("PATH", &search_path);
        command
    };
    let list = fixture_command().arg("list").output().unwrap();
    let revision = serde_json::from_slice::<Value>(&list.stdout).unwrap()["targets"][0]
        ["targetRevision"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut command = fixture_command();
    command.args(["probe", &target.id, &revision]);
    assert_eq!(error(command.output().unwrap()), "password_required");
    let result = command
        .env("SSH_ASKPASS", cancelled)
        .env("SSH_ASKPASS_REQUIRE", "force")
        .output()
        .unwrap();
    assert_eq!(result.status.code(), Some(255));
    assert!(result.stdout.is_empty());
}
