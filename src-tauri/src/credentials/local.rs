//! Signature-independent macOS storage. Values are plaintext, restricted to the
//! current user, and deliberately separate from the general settings database.
//! Legacy items are copied unchanged only after a successful read. A durable
//! tombstone prevents a deleted credential from reappearing from the keychain.

use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{AppCredentialStore, CredentialStore};

pub(super) struct LocalCredentialStore {
    root: PathBuf,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u8,
    secret: Option<String>,
}

impl LocalCredentialStore {
    pub(super) fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn path(&self, id: &str) -> Result<PathBuf, String> {
        AppCredentialStore::validate_id(id)?;
        let path = self.root.join(format!("{id}.json"));
        for ancestor in path.ancestors() {
            match fs::symlink_metadata(ancestor) {
                Ok(metadata)
                    if metadata.file_type().is_symlink()
                        && !crate::path_policy::is_platform_directory_alias(ancestor) =>
                {
                    return Err("本机凭据路径不可包含符号链接".into());
                }
                Ok(_) => {}
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(_) => return Err("无法检查本机凭据路径；请检查目录权限".into()),
            }
        }
        Ok(path)
    }

    // Outer None means no local record; inner None is a deletion tombstone.
    fn read(&self, id: &str) -> Result<Option<Option<String>>, String> {
        let path = self.path(id)?;
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("无法读取本机凭据；请检查数据目录权限".into()),
        };
        let record: Record = serde_json::from_slice(&bytes)
            .map_err(|_| "本机凭据文件损坏；请恢复备份或重新保存该密钥")?;
        if record.version != 1 {
            return Err("本机凭据格式版本不受支持；请使用兼容的 Cliora 版本".into());
        }
        Ok(Some(record.secret))
    }

    fn write(&self, id: &str, secret: Option<&str>, only_if_absent: bool) -> Result<(), String> {
        let path = self.path(id)?;
        create_private_directory(&self.root)?;
        let mut stage =
            tempfile::NamedTempFile::new_in(&self.root).map_err(|_| "无法建立本机凭据临时文件")?;
        // NamedTempFile creates mode 0600 on Unix, before any secret is written.
        let bytes = serde_json::to_vec(&Record {
            version: 1,
            secret: secret.map(str::to_owned),
        })
        .map_err(|_| "无法编码本机凭据")?;
        stage
            .write_all(&bytes)
            .and_then(|_| stage.as_file().sync_all())
            .map_err(|_| "无法完整写入本机凭据；原凭据保留")?;
        if only_if_absent {
            match stage.persist_noclobber(&path) {
                Ok(_) => {}
                // Another process may have replaced/deleted this id during the
                // legacy read. Its record wins over the stale migration value.
                Err(error) if error.error.kind() == ErrorKind::AlreadyExists => return Ok(()),
                Err(_) => return Err("无法迁移旧凭据；钥匙串原值保留".into()),
            }
        } else {
            stage
                .persist(&path)
                .map_err(|_| "无法保存本机凭据；原凭据保留")?;
        }
        #[cfg(unix)]
        fs::File::open(&self.root)
            .and_then(|dir| dir.sync_all())
            .map_err(|_| "无法同步本机凭据目录；请检查磁盘后重试")?;
        Ok(())
    }

    pub(super) fn lookup_or_migrate(
        &self,
        id: &str,
        legacy: impl FnOnce(&str) -> Result<Option<String>, String>,
    ) -> Result<Option<String>, String> {
        if let Some(value) = self.read(id)? {
            return Ok(value);
        }
        if let Some(secret) = legacy(id)? {
            self.write(id, Some(&secret), true)?;
            return self
                .read(id)?
                .ok_or_else(|| "迁移后的本机凭据不可读取".into());
        }
        // Do not cache absence: the user may repair an old keychain later.
        Ok(None)
    }
}

fn create_private_directory(root: &Path) -> Result<(), String> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(root).map_err(|_| "无法创建本机凭据目录")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root, fs::Permissions::from_mode(0o700))
            .map_err(|_| "无法限制本机凭据目录权限")?;
    }
    Ok(())
}

impl CredentialStore for LocalCredentialStore {
    fn put(&self, id: &str, secret: &str) -> Result<(), String> {
        self.write(id, Some(secret), false)
    }

    fn get(&self, id: &str) -> Result<String, String> {
        self.lookup(id)?.ok_or_else(|| "missing".into())
    }

    fn lookup(&self, id: &str) -> Result<Option<String>, String> {
        Ok(self.read(id)?.flatten())
    }

    fn delete(&self, id: &str) -> Result<(), String> {
        // Never consult or modify the old keychain, even if access is denied.
        self.write(id, None, false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unavailable(_: &str) -> Result<Option<String>, String> {
        Err("legacy authorization denied".into())
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn differently_signed_executables_share_local_credentials_after_update() {
        use std::process::Command;
        let root = tempfile::tempdir().unwrap();
        let executable = std::env::current_exe().unwrap();
        let mut signatures = Vec::new();
        for (version, action) in [("first", "write"), ("updated", "read")] {
            let copy = root.path().join(version);
            fs::copy(&executable, &copy).unwrap();
            let signed = Command::new("/usr/bin/codesign")
                .args(["--force", "--sign", "-", "--identifier"])
                .arg(format!("com.cliora.credential-test.{version}"))
                .arg(&copy)
                .output()
                .unwrap();
            assert!(
                signed.status.success(),
                "{}",
                String::from_utf8_lossy(&signed.stderr)
            );
            let signature = Command::new("/usr/bin/codesign")
                .args(["-dvvv"])
                .arg(&copy)
                .output()
                .unwrap();
            signatures.push(
                String::from_utf8_lossy(&signature.stderr)
                    .lines()
                    .find(|line| line.starts_with("CDHash="))
                    .unwrap()
                    .to_owned(),
            );
            let result = Command::new(&copy)
                .args([
                    "--exact",
                    "credentials::local::tests::signed_upgrade_child",
                    "--ignored",
                ])
                .env(
                    "CLIORA_TEST_CREDENTIAL_ROOT",
                    root.path().join("credentials"),
                )
                .env("CLIORA_TEST_CREDENTIAL_ACTION", action)
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&result.stdout),
                String::from_utf8_lossy(&result.stderr)
            );
        }
        assert_ne!(signatures[0], signatures[1]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "subprocess helper; run by differently_signed_executables test"]
    fn signed_upgrade_child() {
        let store = LocalCredentialStore::new(
            std::env::var_os("CLIORA_TEST_CREDENTIAL_ROOT")
                .unwrap()
                .into(),
        );
        if std::env::var("CLIORA_TEST_CREDENTIAL_ACTION").unwrap() == "write" {
            store
                .put("connection-upgrade", "synthetic-persistent-value")
                .unwrap();
        } else {
            assert_eq!(
                store
                    .lookup_or_migrate("connection-upgrade", |_| panic!(
                        "updated executable must not access Keychain"
                    ))
                    .unwrap()
                    .as_deref(),
                Some("synthetic-persistent-value")
            );
        }
    }

    #[test]
    fn saved_credentials_survive_restart_with_unavailable_keychain() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("credentials");
        let first = LocalCredentialStore::new(path.clone());
        first
            .put("connection-test", "synthetic-秘密\nvalue")
            .unwrap();
        drop(first);
        let upgraded = LocalCredentialStore::new(path);
        assert_eq!(
            upgraded
                .lookup_or_migrate("connection-test", unavailable)
                .unwrap()
                .as_deref(),
            Some("synthetic-秘密\nvalue")
        );
        upgraded.put("connection-test", "replacement").unwrap();
        assert_eq!(upgraded.get("connection-test").unwrap(), "replacement");
        upgraded.delete("connection-test").unwrap();
        upgraded.delete("connection-test").unwrap();
        assert_eq!(
            upgraded
                .lookup_or_migrate("connection-test", unavailable)
                .unwrap(),
            None
        );
    }

    #[test]
    fn migrates_original_integrity_key_once_without_rotating_or_reading_legacy_again() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalCredentialStore::new(root.path().join("credentials"));
        let original = "synthetic-original-integrity-key";
        let migrated = store
            .lookup_or_migrate("native-integrity-key-v1", |_| Ok(Some(original.into())))
            .unwrap();
        assert_eq!(migrated.as_deref(), Some(original));
        assert_eq!(
            store
                .lookup_or_migrate("native-integrity-key-v1", |_| panic!(
                    "must not touch Keychain again"
                ))
                .unwrap(),
            migrated
        );
    }

    #[test]
    fn migrated_integrity_and_backup_keys_restore_existing_native_history() {
        use crate::native::transaction::{self, TextPatch};
        struct Migrating<'a> {
            local: &'a LocalCredentialStore,
            legacy: &'a LocalCredentialStore,
        }
        impl CredentialStore for Migrating<'_> {
            fn put(&self, id: &str, value: &str) -> Result<(), String> {
                self.local.put(id, value)
            }
            fn delete(&self, id: &str) -> Result<(), String> {
                self.local.delete(id)
            }
            fn get(&self, id: &str) -> Result<String, String> {
                self.lookup(id)?.ok_or_else(|| "missing".into())
            }
            fn lookup(&self, id: &str) -> Result<Option<String>, String> {
                self.local
                    .lookup_or_migrate(id, |id| self.legacy.lookup(id))
            }
        }
        let root = tempfile::tempdir().unwrap();
        let db = crate::database::Database::open(&root.path().join("app.db")).unwrap();
        let legacy = LocalCredentialStore::new(root.path().join("legacy"));
        let current = LocalCredentialStore::new(root.path().join("current"));
        let target = root.path().join("settings.json");
        fs::write(&target, "original configuration").unwrap();
        let outcome = transaction::apply_text(
            &db,
            &legacy,
            &[TextPatch {
                path: target.clone(),
                baseline: "original configuration".into(),
                contents: "updated configuration".into(),
                sensitive: true,
            }],
            |_| Ok(()),
        )
        .unwrap();
        let integrity = transaction::integrity_key(&db, &legacy).unwrap();
        let migration = Migrating {
            local: &current,
            legacy: &legacy,
        };
        assert_eq!(
            transaction::preview_backup(&db, &migration, &target, &outcome.transaction_id)
                .unwrap()
                .original,
            "original configuration"
        );
        assert_eq!(
            transaction::integrity_key(&db, &current).unwrap(),
            integrity
        );
        fs::remove_dir_all(root.path().join("legacy")).unwrap();
        transaction::restore_backup(
            &db,
            &current,
            &target,
            &outcome.transaction_id,
            "updated configuration",
            |_| Ok(()),
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(target).unwrap(),
            "original configuration"
        );
    }

    #[test]
    fn failed_migration_is_not_absence_and_can_be_retried() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalCredentialStore::new(root.path().join("credentials"));
        assert_eq!(
            store.lookup_or_migrate("key", unavailable).unwrap_err(),
            "legacy authorization denied"
        );
        assert!(!store.path("key").unwrap().exists());
        assert_eq!(store.lookup_or_migrate("key", |_| Ok(None)).unwrap(), None);
        assert_eq!(
            store
                .lookup_or_migrate("key", |_| Ok(Some("recovered".into())))
                .unwrap()
                .as_deref(),
            Some("recovered")
        );
    }

    #[test]
    fn replacing_and_deleting_locked_legacy_credentials_never_requires_authorization() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalCredentialStore::new(root.path().join("credentials"));
        store.put("locked", "new-value").unwrap();
        assert_eq!(
            store
                .lookup_or_migrate("locked", unavailable)
                .unwrap()
                .as_deref(),
            Some("new-value")
        );
        store.delete("legacy-only").unwrap();
        assert_eq!(
            store
                .lookup_or_migrate("legacy-only", |_| panic!(
                    "deleted legacy value must not resurrect"
                ))
                .unwrap(),
            None
        );
    }

    #[test]
    fn concurrent_replacement_or_deletion_wins_over_stale_migration() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalCredentialStore::new(root.path().join("credentials"));
        let replaced = store
            .lookup_or_migrate("replaced", |_| {
                store.put("replaced", "new-value")?;
                Ok(Some("stale-value".into()))
            })
            .unwrap();
        assert_eq!(replaced.as_deref(), Some("new-value"));
        let deleted = store
            .lookup_or_migrate("deleted", |_| {
                store.delete("deleted")?;
                Ok(Some("stale-value".into()))
            })
            .unwrap();
        assert_eq!(deleted, None);
    }

    #[test]
    fn corrupt_or_future_files_do_not_fall_back_to_stale_secrets() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalCredentialStore::new(root.path().join("credentials"));
        store.put("key", "original").unwrap();
        for bytes in [
            "{broken synthetic-secret",
            r#"{"version":2,"secret":"future-secret"}"#,
        ] {
            fs::write(store.path("key").unwrap(), bytes).unwrap();
            let error = store
                .lookup_or_migrate("key", |_| {
                    panic!("must not fall back after local corruption")
                })
                .unwrap_err();
            assert!(!error.contains("synthetic-secret"));
            assert!(!error.contains("future-secret"));
        }
    }

    #[test]
    fn failed_write_preserves_old_value_and_does_not_report_successful_migration() {
        let root = tempfile::tempdir().unwrap();
        let blocked = root.path().join("not-a-directory");
        fs::write(&blocked, "original").unwrap();
        let store = LocalCredentialStore::new(blocked.clone());
        assert!(store.put("key", "replacement").is_err());
        assert!(store
            .lookup_or_migrate("key", |_| Ok(Some("legacy-value".into())))
            .is_err());
        assert_eq!(fs::read_to_string(blocked).unwrap(), "original");
    }

    #[cfg(unix)]
    #[test]
    fn files_and_directories_are_private_and_symlinks_are_rejected() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("credentials");
        let store = LocalCredentialStore::new(directory.clone());
        store.put("key", "synthetic").unwrap();
        assert_eq!(
            fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(store.path("key").unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        let target = root.path().join("untouched");
        fs::write(&target, "original").unwrap();
        symlink(&target, directory.join("link.json")).unwrap();
        assert!(store.get("link").is_err());
        assert!(store.put("link", "changed").is_err());
        assert!(store.delete("link").is_err());
        assert_eq!(fs::read_to_string(target).unwrap(), "original");
        symlink(&directory, root.path().join("alias")).unwrap();
        assert!(LocalCredentialStore::new(root.path().join("alias"))
            .get("key")
            .is_err());
    }
}
