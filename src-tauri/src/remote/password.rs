//! Saved SSH passwords for remote targets.
//!
//! The password lives only in the system credential store, keyed by the
//! target id. OpenSSH never sees it on the command line or in its environment:
//! Cliora points `SSH_ASKPASS` at its own executable together with the opaque
//! credential id, and the askpass entry reads the store and answers the single
//! password prompt. A missing saved password leaves the connection
//! interactive, so the terminal still asks as before.

use std::ffi::OsString;
use std::process::Command;

use crate::credentials::{CredentialStore, SystemCredentialStore};

use super::{RemoteError, RemoteTarget};

/// Environment variable carrying the opaque credential id to the askpass entry.
pub const ASKPASS_ID_ENV: &str = "CLIORA_SSH_ASKPASS_ID";
const MAX_PASSWORD_BYTES: usize = 1024;

/// Credential-store id for one target. Target ids are UUIDs, but anything else
/// is rejected by the store's identifier check before the OS store is touched.
pub fn credential_id(target_id: &str) -> String {
    format!("remote-ssh-{target_id}")
}

fn validate_password(password: &str) -> Result<(), RemoteError> {
    if password.is_empty() || password.len() > MAX_PASSWORD_BYTES || password.contains(['\0', '\r', '\n']) {
        return Err(RemoteError::Storage("密码不能为空，且不能包含换行".into()));
    }
    Ok(())
}

pub fn save(store: &dyn CredentialStore, target_id: &str, password: &str) -> Result<(), RemoteError> {
    validate_password(password)?;
    store.put(&credential_id(target_id), password).map_err(RemoteError::Storage)
}

/// Remove a saved password. An already-absent entry is not an error.
pub fn forget(store: &dyn CredentialStore, target_id: &str) -> Result<(), RemoteError> {
    match store.lookup(&credential_id(target_id)) {
        Ok(None) => Ok(()),
        Ok(Some(_)) => store.delete(&credential_id(target_id)).map_err(RemoteError::Storage),
        Err(error) => Err(RemoteError::Storage(error)),
    }
}

pub fn is_saved(store: &dyn CredentialStore, target_id: &str) -> bool {
    matches!(store.lookup(&credential_id(target_id)), Ok(Some(_)))
}

/// Apply the save request that accompanies a target save. `None` keeps the
/// current secret; key authentication drops any stale password.
pub fn apply_save_request(store: &dyn CredentialStore, target: &RemoteTarget, password: Option<&str>) -> Result<(), RemoteError> {
    if target.auth_method != "password" {
        return forget(store, &target.id);
    }
    match password {
        Some(value) if !value.is_empty() => save(store, &target.id, value),
        _ => Ok(()),
    }
}

/// Non-secret environment that lets OpenSSH ask Cliora for the saved password.
/// Empty when the target uses keys or has no saved password.
pub fn askpass_environment(target: &RemoteTarget) -> Vec<(String, String)> {
    askpass_environment_with(&SystemCredentialStore, target)
}

pub fn askpass_environment_with(store: &dyn CredentialStore, target: &RemoteTarget) -> Vec<(String, String)> {
    if target.auth_method != "password" || !is_saved(store, &target.id) {
        return Vec::new();
    }
    let Ok(executable) = std::env::current_exe() else {
        return Vec::new();
    };
    let executable = executable.to_string_lossy().into_owned();
    let mut environment = vec![
        ("SSH_ASKPASS".to_owned(), executable),
        // OpenSSH 8.4+ uses askpass even when a terminal is attached.
        ("SSH_ASKPASS_REQUIRE".to_owned(), "force".to_owned()),
        (ASKPASS_ID_ENV.to_owned(), credential_id(&target.id)),
    ];
    // Older OpenSSH releases only consult askpass when DISPLAY is present.
    if std::env::var_os("DISPLAY").is_none() {
        environment.push(("DISPLAY".to_owned(), "cliora:0".to_owned()));
    }
    environment
}

pub fn apply(target: &RemoteTarget, command: &mut Command) {
    for (key, value) in askpass_environment(target) {
        command.env(key, value);
    }
}

/// Askpass entry point. Returns `true` when this process was started by
/// OpenSSH as the askpass program; the caller must then exit without starting
/// the application. Only a password prompt is answered: host-key questions and
/// key passphrases receive no reply, so they fail closed.
pub fn askpass_entry() -> bool {
    let Some(id) = std::env::var_os(ASKPASS_ID_ENV) else {
        return false;
    };
    let args: Vec<OsString> = std::env::args_os().collect();
    if args.len() != 2 {
        return false;
    }
    let prompt = args[1].to_string_lossy().to_ascii_lowercase();
    let id = id.to_string_lossy().into_owned();
    let answer = if prompt.contains("password") && id.starts_with("remote-ssh-") {
        SystemCredentialStore.lookup(&id).ok().flatten()
    } else {
        None
    };
    match answer {
        Some(password) => {
            use std::io::Write;
            let mut stdout = std::io::stdout();
            let written = stdout.write_all(password.as_bytes()).and_then(|_| stdout.write_all(b"\n")).and_then(|_| stdout.flush());
            std::process::exit(if written.is_ok() { 0 } else { 1 });
        }
        None => std::process::exit(1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[derive(Default)]
    struct MemoryStore(RefCell<HashMap<String, String>>);

    impl CredentialStore for MemoryStore {
        fn put(&self, id: &str, secret: &str) -> Result<(), String> {
            self.0.borrow_mut().insert(id.into(), secret.into());
            Ok(())
        }
        fn get(&self, id: &str) -> Result<String, String> {
            self.0.borrow().get(id).cloned().ok_or_else(|| "missing".into())
        }
        fn delete(&self, id: &str) -> Result<(), String> {
            self.0.borrow_mut().remove(id).map(|_| ()).ok_or_else(|| "missing".into())
        }
    }

    fn target(auth_method: &str) -> RemoteTarget {
        RemoteTarget {
            id: "0b5d6c1e-1111-4222-8333-944445555666".into(),
            name: "prod".into(),
            host: "example.com".into(),
            port: 22,
            user: "root".into(),
            auth_method: auth_method.into(),
            identity_file: None,
            ssh_config: None,
            default_path: None,
            enabled: true,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn saves_keeps_and_forgets_passwords_by_auth_method() {
        let store = MemoryStore::default();
        let password_target = target("password");
        apply_save_request(&store, &password_target, Some("s3cret")).unwrap();
        assert!(is_saved(&store, &password_target.id));
        // An empty field on edit keeps the saved password.
        apply_save_request(&store, &password_target, Some("")).unwrap();
        apply_save_request(&store, &password_target, None).unwrap();
        assert_eq!(store.get(&credential_id(&password_target.id)).unwrap(), "s3cret");
        // Switching to key authentication drops the stale secret.
        apply_save_request(&store, &target("key"), None).unwrap();
        assert!(!is_saved(&store, &password_target.id));
        forget(&store, &password_target.id).unwrap();
    }

    #[test]
    fn rejects_multiline_passwords() {
        let store = MemoryStore::default();
        assert!(save(&store, "id", "a\nb").is_err());
        assert!(save(&store, "id", "").is_err());
    }

    #[test]
    fn askpass_environment_never_contains_the_secret() {
        let store = MemoryStore::default();
        let password_target = target("password");
        assert!(askpass_environment_with(&store, &password_target).is_empty());
        save(&store, &password_target.id, "s3cret").unwrap();
        let environment = askpass_environment_with(&store, &password_target);
        assert!(environment.iter().any(|(key, value)| key == ASKPASS_ID_ENV && value == &credential_id(&password_target.id)));
        assert!(environment.iter().any(|(key, value)| key == "SSH_ASKPASS_REQUIRE" && value == "force"));
        assert!(environment.iter().all(|(_, value)| !value.contains("s3cret")));
        assert!(askpass_environment_with(&store, &target("key")).is_empty());
    }
}
