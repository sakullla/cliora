//! Read-only migration source. New writes/deletes never use Keychain. Do not
//! repair global keychain settings, rename login files, or change item ACLs.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use security_framework::base::Error;
use security_framework::os::macos::keychain::SecKeychain;
use security_framework::os::macos::passwords::find_generic_password;

use super::SERVICE;

const NOT_FOUND: i32 = -25300;

fn resolve_login(dir: &Path) -> Option<PathBuf> {
    for name in ["login.keychain-db", "login.keychain"] {
        let path = dir.join(name);
        if path.is_file() {
            return Some(path);
        }
    }
    let mut renamed: Vec<_> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.starts_with("login_renamed_")
                && (name.ends_with(".keychain-db") || name.ends_with(".keychain"))
                && entry.path().is_file()
        })
        .map(|entry| entry.path())
        .collect();
    renamed.sort_by_key(|path| {
        (
            std::fs::metadata(path)
                .and_then(|metadata| metadata.modified())
                .ok(),
            path.clone(),
        )
    });
    renamed.pop()
}

fn needs_authorization(error: &Error) -> bool {
    matches!(error.code(), -25308 | -25293)
}

fn read(keychain: &SecKeychain, id: &str) -> Result<Option<String>, String> {
    match find_generic_password(Some(std::slice::from_ref(keychain)), SERVICE, id) {
        Ok((password, _)) => String::from_utf8(password.to_vec())
            .map(Some)
            .map_err(|_| "旧钥匙串凭据不是文本；原值保留".into()),
        Err(error) if error.code() == NOT_FOUND => Ok(None),
        Err(error) => Err(migration_error(error)),
    }
}

fn migration_error(error: Error) -> String {
    format!(
        "旧钥匙串凭据尚未迁移（macOS 错误 {}）；请在“钥匙串访问”中搜索 {SERVICE}，允许当前 Cliora 读取后重试。迁移成功后更新应用无需再次授权；原密钥未修改。",
        error.code()
    )
}

pub(super) fn lookup(id: &str) -> Result<Option<String>, String> {
    static LOCK: Mutex<()> = Mutex::new(());
    let _guard = LOCK.lock().map_err(|_| "旧凭据迁移服务忙")?;
    let dir = dirs::home_dir()
        .ok_or("无法定位用户主目录")?
        .join("Library/Keychains");
    let Some(path) = resolve_login(&dir) else {
        // Absence of the whole keychain is not evidence that this id never
        // existed. Preserve the error so integrity keys cannot be regenerated.
        return Err("找不到旧登录钥匙串；已有凭据无法迁移。可重新保存连接密钥；摘要密钥须恢复原钥匙串或本机凭据备份。".into());
    };
    let interaction = SecKeychain::disable_user_interaction().map_err(migration_error)?;
    let keychain = SecKeychain::open(&path).map_err(migration_error)?;
    let first = find_generic_password(Some(std::slice::from_ref(&keychain)), SERVICE, id);
    drop(interaction);
    match first {
        Ok((password, _)) => String::from_utf8(password.to_vec())
            .map(Some)
            .map_err(|_| "旧钥匙串凭据不是文本；原值保留".into()),
        Err(error) if error.code() == NOT_FOUND => Ok(None),
        Err(error) if needs_authorization(&error) => read(&keychain, id),
        Err(error) => Err(migration_error(error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_resolves_renamed_login_without_changing_any_files() {
        let root = tempfile::tempdir().unwrap();
        let renamed = root.path().join("login_renamed_1.keychain-db");
        std::fs::write(&renamed, "synthetic").unwrap();
        assert_eq!(resolve_login(root.path()), Some(renamed.clone()));
        assert!(renamed.is_file());
        let login = root.path().join("login.keychain-db");
        std::fs::write(&login, "synthetic").unwrap();
        assert_eq!(resolve_login(root.path()), Some(login));
        assert_eq!(resolve_login(&root.path().join("missing")), None);
    }

    #[test]
    fn migration_reads_original_bytes_from_isolated_keychain() {
        let root = tempfile::tempdir().unwrap();
        let keychain = security_framework::os::macos::keychain::CreateOptions::new()
            .password("synthetic-password")
            .create(root.path().join("test.keychain-db"))
            .unwrap();
        keychain
            .add_generic_password(SERVICE, "test-key", b"original-value")
            .unwrap();
        assert_eq!(
            read(&keychain, "test-key").unwrap().as_deref(),
            Some("original-value")
        );
        assert_eq!(read(&keychain, "missing").unwrap(), None);
    }
}
