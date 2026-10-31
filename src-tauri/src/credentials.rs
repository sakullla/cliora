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

const SERVICE: &str = "com.cliora.desktop";

impl SystemCredentialStore {
    fn validate_id(id: &str) -> Result<(), String> {
        if id.is_empty()
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
impl SystemCredentialStore {
    fn operation_error(action: &str, error: keyring::Error) -> String {
        format!("无法{action}：{error}")
    }

    fn entry(id: &str) -> Result<keyring::Entry, String> {
        Self::validate_id(id)?;
        keyring::Entry::new(SERVICE, id).map_err(|_| "系统凭据服务不可用".into())
    }
}

#[cfg(not(target_os = "macos"))]
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

/// macOS credential IO stays on the login keychain file.
///
/// `SecKeychainCopyDomainDefault` follows the user default keychain. A signing
/// helper can point that default at a temporary keychain and then delete the
/// file. The next read, save, or delete asks Security to show a modal
/// “找不到钥匙串” dialog; its buttons do not restore the missing file, and the
/// call never returns, so the configuration cannot be saved or removed.
/// Opening `login.keychain-db` by path never consults that default. When the
/// default file is already gone, the search list is pointed back at the login
/// keychain so the rest of the system stops presenting the same dialog.
#[cfg(target_os = "macos")]
mod macos {
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;
    use std::thread;
    use std::time::{Duration, Instant};

    use security_framework::base::Error;
    use security_framework::os::macos::keychain::SecKeychain;
    use security_framework::os::macos::passwords::find_generic_password;

    use super::{CredentialStore, SystemCredentialStore, SERVICE};

    const NOT_FOUND: i32 = -25300;
    const AUTH_FAILED: i32 = -25293;
    const USER_CANCELED: i32 = -128;
    const INTERACTION_NOT_ALLOWED: i32 = -25308;
    const SECURITY_TIMEOUT: Duration = Duration::from_secs(3);

    enum Failure {
        NotFound,
        InvalidSecret,
        Message(String),
        Os(Error),
    }

    fn operation_error(action: &str, detail: &str) -> String {
        format!(
            "无法{action}；macOS 返回：{detail}。Cliora 只使用本机登录钥匙串。如果应用是卸载后重装的，请在“钥匙串访问”中搜索 {SERVICE}，给当前 Cliora.app 授权后重试；如果旧条目已不存在，请重新输入密钥。"
        )
    }

    fn describe(error: Error) -> String {
        error
            .message()
            .filter(|message| !message.is_empty())
            .unwrap_or_else(|| format!("错误码 {}", error.code()))
    }

    fn missing_secret(action: &str) -> String {
        format!(
            "无法{action}；登录钥匙串里没有这个密钥。它如果曾写在已经删除的临时钥匙串中，无法找回，请重新输入。"
        )
    }

    fn authorization_denied(action: &str) -> String {
        format!(
            "无法{action}；登录钥匙串还没有允许当前 Cliora 访问这条密钥。请在系统提示中选择允许；如果没有出现提示，请打开“钥匙串访问”搜索 {SERVICE}，允许当前应用后再试。"
        )
    }

    /// A rebuilt or relocated app is absent from the item's trusted list. With
    /// interaction disabled, Security reports authorization failure rather than
    /// a missing item. Retrying after interaction is enabled lets the system
    /// prompt; the secret itself is still there.
    fn needs_user_authorization(code: i32) -> bool {
        code == INTERACTION_NOT_ALLOWED || code == AUTH_FAILED
    }

    fn map_failure(action: &str, failure: Failure) -> String {
        match failure {
            Failure::NotFound => missing_secret(action),
            Failure::InvalidSecret => format!("无法{action}；登录钥匙串中的值不是文本"),
            Failure::Message(message) => message,
            Failure::Os(error)
                if needs_user_authorization(error.code()) || error.code() == USER_CANCELED =>
            {
                authorization_denied(action)
            }
            Failure::Os(error) => operation_error(action, &describe(error)),
        }
    }

    fn is_not_found(error: &Error) -> bool {
        error.code() == NOT_FOUND
    }

    fn keychain_dir() -> Result<PathBuf, String> {
        dirs::home_dir()
            .map(|home| home.join("Library/Keychains"))
            .ok_or_else(|| "无法定位用户主目录".to_string())
    }

    fn renamed_login_files(dir: &Path) -> Vec<PathBuf> {
        let mut found = Vec::new();
        let Ok(entries) = std::fs::read_dir(dir) else {
            return found;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("login_renamed_")
                && (name.ends_with(".keychain-db") || name.ends_with(".keychain"))
            {
                found.push(entry.path());
            }
        }
        found.sort_by(|left, right| {
            let left_key = (
                std::fs::metadata(left)
                    .and_then(|meta| meta.modified())
                    .ok(),
                left.file_name().map(std::ffi::OsStr::to_os_string),
            );
            let right_key = (
                std::fs::metadata(right)
                    .and_then(|meta| meta.modified())
                    .ok(),
                right.file_name().map(std::ffi::OsStr::to_os_string),
            );
            left_key.cmp(&right_key)
        });
        found
    }

    /// Pick the login keychain file. A single `login_renamed_*` file is moved
    /// back to `login.keychain-db` when that name is absent: macOS unlocks the
    /// login keychain by this filename at sign-in.
    pub(super) fn resolve_login_keychain(dir: &Path) -> Result<PathBuf, String> {
        let modern = dir.join("login.keychain-db");
        if modern.is_file() {
            return Ok(modern);
        }
        let legacy = dir.join("login.keychain");
        if legacy.is_file() {
            return Ok(legacy);
        }
        let mut renamed = renamed_login_files(dir);
        if renamed.is_empty() {
            return Err("找不到登录钥匙串。请在“钥匙串访问”中确认“登录”钥匙串存在后再试。".into());
        }
        if renamed.len() == 1 {
            let source = renamed.remove(0);
            match std::fs::rename(&source, &modern) {
                Ok(()) => Ok(modern),
                Err(_) if source.is_file() => Ok(source),
                Err(error) => Err(format!("无法恢复登录钥匙串文件名：{error}")),
            }
        } else {
            renamed.pop().ok_or_else(|| "找不到登录钥匙串".to_string())
        }
    }

    fn run_security(args: &[&str]) -> Result<(), String> {
        let mut child = Command::new("/usr/bin/security")
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("无法执行钥匙串工具：{error}"))?;
        let started = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) if status.success() => return Ok(()),
                Ok(Some(status)) => {
                    return Err(format!("钥匙串工具退出码 {}", status.code().unwrap_or(-1)));
                }
                Ok(None) if started.elapsed() > SECURITY_TIMEOUT => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("钥匙串工具超时".into());
                }
                Ok(None) => thread::sleep(Duration::from_millis(20)),
                Err(error) => return Err(format!("无法等待钥匙串工具：{error}")),
            }
        }
    }

    fn command_output(args: &[&str]) -> Option<std::process::Output> {
        let mut child = Command::new("/usr/bin/security")
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let started = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return child.wait_with_output().ok(),
                Ok(None) if started.elapsed() > SECURITY_TIMEOUT => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                Ok(None) => thread::sleep(Duration::from_millis(20)),
                Err(_) => return None,
            }
        }
    }

    fn quoted_path(text: &str) -> Option<PathBuf> {
        let line = text.lines().find(|line| line.contains('"'))?;
        let start = line.find('"')? + 1;
        let end = start + line[start..].find('"')?;
        let path = &line[start..end];
        if path.is_empty() {
            return None;
        }
        let expanded = path.strip_prefix("~/").map_or_else(
            || PathBuf::from(path),
            |rest| {
                dirs::home_dir()
                    .map(|home| home.join(rest))
                    .unwrap_or_else(|| PathBuf::from(path))
            },
        );
        Some(expanded)
    }

    pub(super) fn current_default_keychain() -> Option<PathBuf> {
        let output = command_output(&["default-keychain"])?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8(output.stdout).ok()?;
        quoted_path(&text)
    }

    fn restore_default_if_missing(login: &Path) {
        static DONE: AtomicBool = AtomicBool::new(false);
        if DONE.load(Ordering::Acquire) {
            return;
        }
        if current_default_keychain().is_some_and(|path| path.is_file()) {
            DONE.store(true, Ordering::Release);
            return;
        }
        let Some(login) = login.to_str() else {
            return;
        };
        // The system domain already contains System.keychain. Adding it to the
        // user search list makes it appear twice and is not required.
        if run_security(&["list-keychains", "-d", "user", "-s", login]).is_ok()
            && run_security(&["default-keychain", "-d", "user", "-s", login]).is_ok()
        {
            DONE.store(true, Ordering::Release);
        }
    }

    fn open_login() -> Result<SecKeychain, String> {
        let path = resolve_login_keychain(&keychain_dir()?)?;
        restore_default_if_missing(&path);
        if !path.is_file() {
            return Err("找不到登录钥匙串。请在“钥匙串访问”中确认“登录”钥匙串存在后再试。".into());
        }
        SecKeychain::open(&path)
            .map_err(|error| operation_error("打开登录钥匙串", &describe(error)))
    }

    fn with_login<T>(operation: impl Fn(&SecKeychain) -> Result<T, Failure>) -> Result<T, Failure> {
        static LOCK: Mutex<()> = Mutex::new(());
        let _guard = LOCK
            .lock()
            .map_err(|_| Failure::Message("系统凭据服务忙".into()))?;
        let interaction = SecKeychain::disable_user_interaction().ok();
        let keychain = match open_login() {
            Ok(keychain) => keychain,
            Err(message) => return Err(Failure::Message(message)),
        };
        let first = operation(&keychain);
        drop(interaction);
        match first {
            Err(Failure::Os(error)) if needs_user_authorization(error.code()) => {
                operation(&keychain)
            }
            other => other,
        }
    }

    pub(super) fn read_for_test(keychain: &SecKeychain, id: &str) -> Result<String, String> {
        read(keychain, id).map_err(|failure| map_failure("从系统凭据服务读取", failure))
    }

    pub(super) fn write_for_test(
        keychain: &SecKeychain,
        id: &str,
        secret: &str,
    ) -> Result<(), String> {
        write(keychain, id, secret).map_err(|failure| map_failure("保存到系统凭据服务", failure))
    }

    pub(super) fn remove_for_test(keychain: &SecKeychain, id: &str) -> Result<(), String> {
        remove(keychain, id).map_err(|failure| map_failure("从系统凭据服务删除", failure))
    }

    fn read(keychain: &SecKeychain, id: &str) -> Result<String, Failure> {
        match find_generic_password(Some(std::slice::from_ref(keychain)), SERVICE, id) {
            Ok((password, _)) => {
                String::from_utf8(password.to_vec()).map_err(|_| Failure::InvalidSecret)
            }
            Err(error) if is_not_found(&error) => Err(Failure::NotFound),
            Err(error) => Err(Failure::Os(error)),
        }
    }

    fn write(keychain: &SecKeychain, id: &str, secret: &str) -> Result<(), Failure> {
        match find_generic_password(Some(std::slice::from_ref(keychain)), SERVICE, id) {
            Ok((_, mut item)) => item.set_password(secret.as_bytes()).map_err(Failure::Os),
            Err(error) if is_not_found(&error) => keychain
                .add_generic_password(SERVICE, id, secret.as_bytes())
                .map_err(Failure::Os),
            Err(error) => Err(Failure::Os(error)),
        }
    }

    fn remove(keychain: &SecKeychain, id: &str) -> Result<(), Failure> {
        match find_generic_password(Some(std::slice::from_ref(keychain)), SERVICE, id) {
            Ok((_, item)) => {
                item.delete();
                match find_generic_password(Some(std::slice::from_ref(keychain)), SERVICE, id) {
                    Err(error) if is_not_found(&error) => Ok(()),
                    Ok(_) => Err(Failure::Os(Error::from_code(-61))),
                    Err(error) => Err(Failure::Os(error)),
                }
            }
            Err(error) if is_not_found(&error) => Ok(()),
            Err(error) => Err(Failure::Os(error)),
        }
    }

    impl CredentialStore for SystemCredentialStore {
        fn put(&self, id: &str, secret: &str) -> Result<(), String> {
            SystemCredentialStore::validate_id(id)?;
            with_login(|keychain| write(keychain, id, secret))
                .map_err(|failure| map_failure("保存到系统凭据服务", failure))
        }

        fn get(&self, id: &str) -> Result<String, String> {
            SystemCredentialStore::validate_id(id)?;
            with_login(|keychain| read(keychain, id))
                .map_err(|failure| map_failure("从系统凭据服务读取", failure))
        }

        fn lookup(&self, id: &str) -> Result<Option<String>, String> {
            SystemCredentialStore::validate_id(id)?;
            match with_login(|keychain| read(keychain, id)) {
                Ok(secret) => Ok(Some(secret)),
                Err(Failure::NotFound) => Ok(None),
                Err(failure) => Err(map_failure("从系统凭据服务读取", failure)),
            }
        }

        fn delete(&self, id: &str) -> Result<(), String> {
            SystemCredentialStore::validate_id(id)?;
            // A secret that lived only in a deleted temporary keychain is already
            // gone. Delete must still succeed so the configuration can be removed.
            with_login(|keychain| remove(keychain, id))
                .map_err(|failure| map_failure("从系统凭据服务删除", failure))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unbounded_or_path_like_identifiers_before_touching_os_store() {
        for id in ["", "../token", "a/b", "a\\b", "a b"] {
            assert!(SystemCredentialStore::validate_id(id).is_err());
        }
        assert!(SystemCredentialStore::validate_id(&"a".repeat(129)).is_err());
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

    #[cfg(target_os = "macos")]
    #[test]
    fn login_keychain_resolution_prefers_standard_file_and_restores_one_renamed_file() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        std::fs::write(dir.join("login_renamed_1.keychain-db"), "renamed").unwrap();
        let resolved = macos::resolve_login_keychain(dir).unwrap();
        assert_eq!(resolved, dir.join("login.keychain-db"));
        assert!(!dir.join("login_renamed_1.keychain-db").exists());
        assert_eq!(std::fs::read(&resolved).unwrap(), b"renamed");

        std::fs::write(dir.join("login.keychain-db"), "modern").unwrap();
        std::fs::write(dir.join("login_renamed_2.keychain-db"), "other").unwrap();
        assert_eq!(
            macos::resolve_login_keychain(dir).unwrap(),
            dir.join("login.keychain-db")
        );
        assert!(dir.join("login_renamed_2.keychain-db").exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn login_keychain_resolution_keeps_every_file_when_several_renamed_copies_exist() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        let older = dir.join("login_renamed_1.keychain-db");
        let newer = dir.join("login_renamed_9.keychain-db");
        std::fs::write(&older, "older").unwrap();
        std::fs::write(&newer, "newer").unwrap();
        let newer_time = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(50_000);
        let older_time = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(10);
        utime(&older, older_time);
        utime(&newer, newer_time);
        assert_eq!(macos::resolve_login_keychain(dir).unwrap(), newer);
        assert!(older.exists());
        assert!(!dir.join("login.keychain-db").exists());
        assert!(macos::resolve_login_keychain(&dir.join("missing")).is_err());
    }

    #[cfg(target_os = "macos")]
    fn utime(path: &std::path::Path, time: std::time::SystemTime) {
        let file = std::fs::File::options().write(true).open(path).unwrap();
        file.set_modified(time).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn explicit_keychain_round_trip_does_not_replace_the_user_default_keychain() {
        let before = macos::current_default_keychain();
        let _interaction =
            security_framework::os::macos::keychain::SecKeychain::disable_user_interaction();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("cliora-test.keychain-db");
        let mut keychain = security_framework::os::macos::keychain::CreateOptions::new()
            .password("test-only")
            .create(&path)
            .unwrap();
        keychain
            .set_settings(&security_framework::os::macos::keychain::KeychainSettings::new())
            .unwrap();
        let id = format!("cliora-test-{}", std::process::id());
        macos::write_for_test(&keychain, &id, "test-only-value").unwrap();
        assert_eq!(
            macos::read_for_test(&keychain, &id).unwrap(),
            "test-only-value"
        );
        macos::write_for_test(&keychain, &id, "replaced-value").unwrap();
        assert_eq!(
            macos::read_for_test(&keychain, &id).unwrap(),
            "replaced-value"
        );
        macos::remove_for_test(&keychain, &id).unwrap();
        macos::remove_for_test(&keychain, &id).unwrap();
        assert!(macos::read_for_test(&keychain, &id).is_err());
        drop(keychain);
        drop(_interaction);

        let store_id = format!("cliora-login-{pid}", pid = std::process::id());
        let _cleanup = DeleteOnDrop(store_id.clone());
        let store = SystemCredentialStore;
        store.put(&store_id, "login-value").unwrap();
        assert_eq!(store.get(&store_id).unwrap(), "login-value");
        assert_eq!(
            store.lookup(&store_id).unwrap().as_deref(),
            Some("login-value")
        );
        store.delete(&store_id).unwrap();
        store.delete(&store_id).unwrap();
        assert_eq!(store.lookup(&store_id).unwrap(), None);
        assert!(store.get(&store_id).is_err());
        assert_eq!(macos::current_default_keychain(), before);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn authorization_failure_is_not_reported_as_a_missing_secret() {
        let _interaction =
            security_framework::os::macos::keychain::SecKeychain::disable_user_interaction();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("cliora-auth.keychain-db");
        let mut keychain = security_framework::os::macos::keychain::CreateOptions::new()
            .password("test-only")
            .create(&path)
            .unwrap();
        keychain
            .set_settings(&security_framework::os::macos::keychain::KeychainSettings::new())
            .unwrap();
        let id = format!("cliora-auth-{}", std::process::id());
        let unlock = std::process::Command::new("/usr/bin/security")
            .args(["unlock-keychain", "-p", "test-only"])
            .arg(&path)
            .output()
            .unwrap();
        assert!(unlock.status.success(), "{}", String::from_utf8_lossy(&unlock.stderr));
        let added = std::process::Command::new("/usr/bin/security")
            .args([
                "add-generic-password",
                "-a",
                &id,
                "-s",
                "com.cliora.desktop",
                "-w",
                "probe-secret-value",
                "-T",
                "/usr/bin/true",
            ])
            .arg(&path)
            .output()
            .unwrap();
        assert!(added.status.success(), "{}", String::from_utf8_lossy(&added.stderr));
        let error = macos::read_for_test(&keychain, &id).unwrap_err();
        assert!(error.contains("还没有允许当前 Cliora"), "{error}");
        assert!(!error.contains("没有这个密钥"), "{error}");
        drop(_interaction);
    }

    #[cfg(target_os = "macos")]
    struct DeleteOnDrop(String);

    #[cfg(target_os = "macos")]
    impl Drop for DeleteOnDrop {
        fn drop(&mut self) {
            let _ = SystemCredentialStore.delete(&self.0);
        }
    }
}
