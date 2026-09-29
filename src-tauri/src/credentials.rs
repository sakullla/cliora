/// The native credential boundary. Callers persist only opaque IDs in SQLite.
/// Secrets never cross the general settings IPC or enter application logs.
pub trait CredentialStore {
    fn put(&self, id: &str, secret: &str) -> Result<(), String>;
    fn get(&self, id: &str) -> Result<String, String>;
    fn delete(&self, id: &str) -> Result<(), String>;
}

pub struct SystemCredentialStore;

impl SystemCredentialStore {
    fn entry(id: &str) -> Result<keyring::Entry, String> {
        if id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        {
            return Err("无效的凭据标识".into());
        }
        keyring::Entry::new("com.cliora.desktop", id).map_err(|_| "系统凭据服务不可用".into())
    }
}

impl CredentialStore for SystemCredentialStore {
    fn put(&self, id: &str, secret: &str) -> Result<(), String> {
        Self::entry(id)?
            .set_password(secret)
            .map_err(|_| "无法保存到系统凭据服务".into())
    }

    fn get(&self, id: &str) -> Result<String, String> {
        Self::entry(id)?
            .get_password()
            .map_err(|_| "无法从系统凭据服务读取".into())
    }

    fn delete(&self, id: &str) -> Result<(), String> {
        Self::entry(id)?
            .delete_credential()
            .map_err(|_| "无法从系统凭据服务删除".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unbounded_or_path_like_identifiers_before_touching_os_store() {
        for id in ["", "../token", "a/b", "a\\b", "a b"] {
            assert!(SystemCredentialStore::entry(id).is_err());
        }
        assert!(SystemCredentialStore::entry(&"a".repeat(129)).is_err());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_system_store_round_trip() {
        let store = SystemCredentialStore;
        let id = format!("cliora-test-{}", std::process::id());
        store.put(&id, "test-only-value").unwrap();
        assert_eq!(store.get(&id).unwrap(), "test-only-value");
        store.delete(&id).unwrap();
    }
}
