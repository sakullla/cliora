/// The native credential boundary. Callers persist only opaque IDs in SQLite.
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

pub struct SystemCredentialStore;

impl SystemCredentialStore {
    fn operation_error(action: &str, error: keyring::Error) -> String {
        let detail = error.to_string();
        #[cfg(target_os = "macos")]
        {
            return format!(
                "无法{action}；macOS 返回：{detail}。如果应用是卸载后重装的，请在“钥匙串访问”中搜索 com.cliora.desktop，给当前 Cliora.app 授权后重试；如果旧条目已不存在，请重新输入密钥。"
            );
        }
        #[cfg(not(target_os = "macos"))]
        {
            format!("无法{action}：{detail}")
        }
    }

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
        assert_eq!(store.lookup(&id).unwrap(), None);
    }
}
