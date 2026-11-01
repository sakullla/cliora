/// The native credential boundary. Callers persist only opaque IDs in SQLite.
/// macOS stores values in private local files; other platforms use the OS store.
/// Secrets never cross the general settings IPC or enter application logs.
pub trait CredentialStore {
    fn put(&self, id: &str, secret: &str) -> Result<(), String>;
    fn get(&self, id: &str) -> Result<String, String>;
    fn delete(&self, id: &str) -> Result<(), String>;
    /// `Ok(None)` only when the store confirms the id is absent.
    /// A read failure stays `Err` and must not be treated as absence.
    /// Test stores report absence with the exact error `missing`.
    fn lookup(&self, id: &str) -> Result<Option<String>, String> {
        match self.get(id) {
            Ok(secret) => Ok(Some(secret)),
            Err(error) if error == "missing" => Ok(None),
            Err(error) => Err(error),
        }
    }
}

pub struct AppCredentialStore;

#[cfg(target_os = "macos")]
mod legacy_macos;
#[cfg(any(target_os = "macos", test))]
mod local;

const SERVICE: &str = "com.cliora.desktop";

impl AppCredentialStore {
    fn validate_id(id: &str) -> Result<(), String> {
        if matches!(id, "" | "." | "..")
            || id.len() > 128
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        {
            return Err("无效的凭据标识".into());
        }
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
impl AppCredentialStore {
    fn operation_error(action: &str, error: keyring::Error) -> String {
        format!("无法{action}：{error}")
    }

    fn entry(id: &str) -> Result<keyring::Entry, String> {
        Self::validate_id(id)?;
        keyring::Entry::new(SERVICE, id).map_err(|_| "系统凭据服务不可用".into())
    }
}

#[cfg(not(target_os = "macos"))]
impl CredentialStore for AppCredentialStore {
    fn put(&self, id: &str, secret: &str) -> Result<(), String> {
        Self::entry(id)?
            .set_password(secret)
            .map_err(|error| Self::operation_error("保存到系统凭据服务", error))
    }

    fn get(&self, id: &str) -> Result<String, String> {
        Self::entry(id)?
            .get_password()
            .map_err(|error| Self::operation_error("从系统凭据服务读取", error))
    }

    fn lookup(&self, id: &str) -> Result<Option<String>, String> {
        match Self::entry(id)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("无法从系统凭据服务读取".into()),
        }
    }

    fn delete(&self, id: &str) -> Result<(), String> {
        Self::entry(id)?
            .delete_credential()
            .map_err(|error| Self::operation_error("从系统凭据服务删除", error))
    }
}

#[cfg(target_os = "macos")]
impl AppCredentialStore {
    fn local() -> Result<local::LocalCredentialStore, String> {
        // Tauri app_data_dir uses data_dir + bundle identifier on macOS.
        // This also works in the SSH askpass child before Tauri is initialized.
        let root = dirs::data_dir()
            .ok_or("无法定位本机数据目录")?
            .join(SERVICE)
            .join("credentials");
        Ok(local::LocalCredentialStore::new(root))
    }
}

#[cfg(target_os = "macos")]
impl CredentialStore for AppCredentialStore {
    fn put(&self, id: &str, secret: &str) -> Result<(), String> {
        Self::local()?.put(id, secret)
    }

    fn get(&self, id: &str) -> Result<String, String> {
        self.lookup(id)?
            .ok_or_else(|| "本机凭据库中没有这个密钥；请重新保存密钥".into())
    }

    fn lookup(&self, id: &str) -> Result<Option<String>, String> {
        Self::local()?.lookup_or_migrate(id, legacy_macos::lookup)
    }

    fn delete(&self, id: &str) -> Result<(), String> {
        Self::local()?.delete(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unbounded_or_path_like_identifiers_before_touching_store() {
        for id in ["", ".", "..", "../token", "a/b", "a\\b", "a b"] {
            assert!(AppCredentialStore::validate_id(id).is_err());
        }
        assert!(AppCredentialStore::validate_id(&"a".repeat(129)).is_err());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_system_store_round_trip() {
        let store = AppCredentialStore;
        let id = format!("cliora-test-{}", std::process::id());
        store.put(&id, "test-only-value").unwrap();
        assert_eq!(store.get(&id).unwrap(), "test-only-value");
        store.delete(&id).unwrap();
        assert_eq!(store.lookup(&id).unwrap(), None);
    }
}
