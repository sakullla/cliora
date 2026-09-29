use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use base64::{engine::general_purpose::STANDARD, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Key, Nonce,
};
use rand::Rng;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::format::{self, FileKind};
use crate::credentials::CredentialStore;
use crate::database::Database;

#[derive(Clone, Debug)]
pub struct FieldChange {
    pub path: Vec<String>,
    pub value: Option<Value>,
}

#[derive(Clone, Debug)]
pub struct FilePatch {
    pub path: PathBuf,
    pub kind: FileKind,
    pub baseline: String,
    pub changes: Vec<FieldChange>,
    pub sensitive: bool,
    /// Rewrite unchanged sensitive files through the restricted staging path.
    pub force_restrict: bool,
}

#[derive(Clone, Debug)]
pub struct TextPatch {
    pub path: PathBuf,
    pub baseline: String,
    pub contents: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOutcome {
    pub transaction_id: String,
    pub changed_files: Vec<String>,
    pub status: &'static str,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct JournalFile {
    path: PathBuf,
    existed: bool,
    old_hash: String,
    new_hash: String,
    backup: Option<String>,
    nonce: Option<String>,
    old_readonly: bool,
    #[serde(default)]
    sensitive: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Journal {
    id: String,
    key_id: String,
    files: Vec<JournalFile>,
}

pub fn fingerprint(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

const INTEGRITY_KEY_ID: &str = "native-integrity-key-v1";
const INTEGRITY_SETTING: &str = "native_integrity_key_v1";
const DIGEST_PREFIX: &str = "h1:";

fn hmac_digest(key: &[u8; 32], digest: &[u8]) -> String {
    let mut inner_pad = [0x36_u8; 64];
    let mut outer_pad = [0x5c_u8; 64];
    for (index, byte) in key.iter().enumerate() {
        inner_pad[index] ^= byte;
        outer_pad[index] ^= byte;
    }
    let mut inner = Sha256::new();
    inner.update(inner_pad);
    inner.update(digest);
    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner.finalize());
    format!("{DIGEST_PREFIX}{:x}", outer.finalize())
}

pub fn keyed_fingerprint(key: &[u8; 32], bytes: &[u8]) -> String {
    hmac_digest(key, &Sha256::digest(bytes))
}

fn is_legacy_digest(value: &str) -> Result<bool, String> {
    let (digest, legacy) = match value.strip_prefix(DIGEST_PREFIX) {
        Some(digest) => (digest, false),
        None => (value, true),
    };
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("原生摘要格式异常；保留原记录并停止写入".into());
    }
    Ok(legacy)
}

fn migrate_digest(value: &mut String, key: &[u8; 32]) -> Result<bool, String> {
    if !is_legacy_digest(value)? {
        return Ok(false);
    }
    let digest = (0..32)
        .map(|index| u8::from_str_radix(&value[index * 2..index * 2 + 2], 16))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "旧原生摘要格式异常；保留原记录并停止写入")?;
    *value = hmac_digest(key, &digest);
    Ok(true)
}

fn managed_has_legacy(value: &Value) -> Result<bool, String> {
    match value {
        Value::Object(map) => {
            let mut legacy = match map.get("__cliora_secret_sha256") {
                Some(Value::String(digest)) => is_legacy_digest(digest)?,
                Some(_) => return Err("活动配置摘要损坏".into()),
                None => false,
            };
            for nested in map.values() {
                legacy |= managed_has_legacy(nested)?;
            }
            Ok(legacy)
        }
        Value::Array(items) => {
            let mut legacy = false;
            for nested in items {
                legacy |= managed_has_legacy(nested)?;
            }
            Ok(legacy)
        }
        _ => Ok(false),
    }
}

fn has_legacy_digests(db: &Database) -> Result<bool, String> {
    let (bindings, journals): (Vec<String>, Vec<String>) = db.with_connection(|conn| {
        let bindings = {
            let mut statement = conn
                .prepare("SELECT managed FROM applied_bindings")
                .map_err(|_| "无法读取活动配置摘要")?;
            let rows = statement
                .query_map([], |row| row.get(0))
                .map_err(|_| "无法读取活动配置摘要")?
                .collect::<Result<_, _>>()
                .map_err(|_| "无法读取活动配置摘要")?;
            rows
        };
        let journals = {
            let mut statement = conn
                .prepare("SELECT data FROM native_transactions")
                .map_err(|_| "无法读取原生事务摘要")?;
            let rows = statement
                .query_map([], |row| row.get(0))
                .map_err(|_| "无法读取原生事务摘要")?
                .collect::<Result<_, _>>()
                .map_err(|_| "无法读取原生事务摘要")?;
            rows
        };
        Ok((bindings, journals))
    })?;
    let mut legacy = false;
    for data in bindings {
        let managed: Value = serde_json::from_str(&data).map_err(|_| "活动配置摘要损坏")?;
        legacy |= managed_has_legacy(&managed)?;
    }
    for data in journals {
        let journal: Journal = serde_json::from_str(&data).map_err(|_| "原生事务日志损坏")?;
        for file in journal.files {
            legacy |= is_legacy_digest(&file.old_hash)?;
            legacy |= is_legacy_digest(&file.new_hash)?;
        }
    }
    Ok(legacy)
}

fn migrate_managed(value: &mut Value, key: &[u8; 32]) -> Result<bool, String> {
    match value {
        Value::Object(map) => {
            let mut changed = false;
            match map.get_mut("__cliora_secret_sha256") {
                Some(Value::String(hash)) => changed |= migrate_digest(hash, key)?,
                Some(_) => return Err("活动配置摘要损坏".into()),
                None => {}
            }
            for nested in map.values_mut() {
                changed |= migrate_managed(nested, key)?;
            }
            Ok(changed)
        }
        Value::Array(items) => {
            let mut changed = false;
            for nested in items {
                changed |= migrate_managed(nested, key)?;
            }
            Ok(changed)
        }
        _ => Ok(false),
    }
}

fn migrate_integrity_records(db: &Database, key: &[u8; 32]) -> Result<(), String> {
    db.with_connection(|conn| {
        let tx = conn.transaction().map_err(|_| "无法迁移原生摘要")?;
        let bindings: Vec<(String, String, String)> = {
            let mut statement = tx
                .prepare("SELECT scope_key, tool, managed FROM applied_bindings")
                .map_err(|_| "无法读取活动配置摘要")?;
            let rows = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .map_err(|_| "无法读取活动配置摘要")?
                .collect::<Result<_, _>>()
                .map_err(|_| "无法读取活动配置摘要")?;
            rows
        };
        for (scope, tool, data) in bindings {
            let mut managed: Value = serde_json::from_str(&data).map_err(|_| "活动配置摘要损坏")?;
            if migrate_managed(&mut managed, key)? {
                tx.execute(
                    "UPDATE applied_bindings SET managed = ?3 WHERE scope_key = ?1 AND tool = ?2",
                    params![
                        scope,
                        tool,
                        serde_json::to_string(&managed).map_err(|_| "无法迁移活动配置摘要")?
                    ],
                )
                .map_err(|_| "无法迁移活动配置摘要")?;
            }
        }
        let journals: Vec<(String, String)> = {
            let mut statement = tx
                .prepare("SELECT id, data FROM native_transactions")
                .map_err(|_| "无法读取原生事务摘要")?;
            let rows = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .map_err(|_| "无法读取原生事务摘要")?
                .collect::<Result<_, _>>()
                .map_err(|_| "无法读取原生事务摘要")?;
            rows
        };
        for (id, data) in journals {
            let mut journal: Journal =
                serde_json::from_str(&data).map_err(|_| "原生事务日志损坏")?;
            let mut changed = false;
            for file in &mut journal.files {
                changed |= migrate_digest(&mut file.old_hash, key)?;
                changed |= migrate_digest(&mut file.new_hash, key)?;
            }
            if changed {
                tx.execute(
                    "UPDATE native_transactions SET data = ?2 WHERE id = ?1",
                    params![
                        id,
                        serde_json::to_string(&journal).map_err(|_| "无法迁移原生事务摘要")?
                    ],
                )
                .map_err(|_| "无法迁移原生事务摘要")?;
            }
        }
        tx.commit().map_err(|_| "无法提交原生摘要迁移".into())
    })
}

enum IntegrityKeyError {
    CredentialUnavailable(String),
    Data(String),
}

impl IntegrityKeyError {
    fn message(self) -> String {
        match self {
            Self::CredentialUnavailable(message) | Self::Data(message) => message,
        }
    }
}

/// Stable, purpose-specific HMAC key; losing it must fail closed instead of
/// silently accepting a different native configuration as previously managed.
fn integrity_key_checked(
    db: &Database,
    credentials: &dyn CredentialStore,
) -> Result<[u8; 32], IntegrityKeyError> {
    static KEY_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let _guard = KEY_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| IntegrityKeyError::Data("原生摘要服务暂时不可用".into()))?;
    let registered: bool = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT value FROM app_settings WHERE key = ?1",
                [INTEGRITY_SETTING],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map(|value| value.is_some())
            .map_err(|_| "无法检查原生摘要密钥".into())
        })
        .map_err(IntegrityKeyError::Data)?;
    let encoded = if registered {
        credentials.get(INTEGRITY_KEY_ID).map_err(|_| {
            IntegrityKeyError::CredentialUnavailable(
                "原生摘要密钥已丢失；请修复系统凭据库，原文件未修改".into(),
            )
        })?
    } else {
        let encoded = match credentials.get(INTEGRITY_KEY_ID) {
            Ok(existing) => existing,
            Err(_) => {
                let mut key = [0_u8; 32];
                rand::rng().fill(&mut key);
                let encoded = STANDARD.encode(key);
                credentials.put(INTEGRITY_KEY_ID, &encoded).map_err(|_| {
                    IntegrityKeyError::CredentialUnavailable(
                        "无法保存原生摘要密钥；原文件未修改".into(),
                    )
                })?;
                encoded
            }
        };
        if STANDARD
            .decode(&encoded)
            .map_or(true, |bytes| bytes.len() != 32)
        {
            return Err(IntegrityKeyError::Data(
                "原生摘要密钥格式错误；原文件未修改".into(),
            ));
        }
        db.with_connection(|conn| {
            conn.execute(
                "INSERT INTO app_settings (key, value) VALUES (?1, 'keyring')",
                [INTEGRITY_SETTING],
            )
            .map_err(|_| String::from("无法登记原生摘要密钥"))?;
            Ok(())
        })
        .map_err(IntegrityKeyError::Data)?;
        encoded
    };
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| IntegrityKeyError::Data("原生摘要密钥格式错误".into()))?;
    let key: [u8; 32] = bytes
        .try_into()
        .map_err(|_| IntegrityKeyError::Data("原生摘要密钥长度错误".into()))?;
    migrate_integrity_records(db, &key).map_err(IntegrityKeyError::Data)?;
    Ok(key)
}

pub fn integrity_key(db: &Database, credentials: &dyn CredentialStore) -> Result<[u8; 32], String> {
    integrity_key_checked(db, credentials).map_err(IntegrityKeyError::message)
}

fn write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub fn read_native(path: &Path) -> Result<String, String> {
    if path.is_symlink() {
        return Err(format!("不跟随符号链接：{}", path.display()));
    }
    match fs::read_to_string(path) {
        Ok(text) => Ok(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(_) => Err(format!("无法读取原生配置：{}", path.display())),
    }
}

fn value_at<'a>(root: &'a Value, path: &[String]) -> Option<&'a Value> {
    path.iter()
        .try_fold(root, |value, segment| value.get(segment))
}

fn prepare(
    patches: &[FilePatch],
    integrity: &[u8; 32],
) -> Result<Vec<(JournalFile, String)>, String> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for patch in patches {
        if !seen.insert(&patch.path) {
            return Err("同一事务中出现重复目标文件".into());
        }
        if patch.changes.is_empty() && !patch.force_restrict {
            continue;
        }
        let baseline = format::parse(patch.kind, &patch.baseline)?;
        let current_text = read_native(&patch.path)?;
        let current = format::parse(patch.kind, &current_text)?;
        let mut output = current_text.clone();
        for change in &patch.changes {
            if change.path.is_empty() {
                return Err("配置字段路径不能为空".into());
            }
            if value_at(&baseline, &change.path) != value_at(&current, &change.path) {
                return Err(format!(
                    "原生配置中的字段已被外部修改：{}",
                    change.path.join(".")
                ));
            }
            output = format::set_path(patch.kind, &output, &change.path, change.value.as_ref())?;
        }
        if output == current_text && !patch.force_restrict {
            continue;
        }
        let existed = patch.path.exists();
        let old_readonly = if existed {
            fs::metadata(&patch.path)
                .map_err(|_| "无法检查原生文件权限")?
                .permissions()
                .readonly()
        } else {
            false
        };
        result.push((
            JournalFile {
                path: patch.path.clone(),
                existed,
                old_hash: keyed_fingerprint(integrity, current_text.as_bytes()),
                new_hash: keyed_fingerprint(integrity, output.as_bytes()),
                backup: None,
                nonce: None,
                old_readonly,
                sensitive: patch.sensitive,
            },
            output,
        ));
    }
    Ok(result)
}

fn save_journal(db: &Database, journal: &Journal, status: &str) -> Result<(), String> {
    let data = serde_json::to_string(journal).map_err(|_| "无法序列化原生事务")?;
    db.with_connection(|conn| {
        conn.execute("INSERT INTO native_transactions (id, status, data) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data", params![journal.id, status, data]).map_err(|e| format!("无法持久化原生事务：{e}"))?;
        Ok(())
    })
}

fn set_status(db: &Database, id: &str, status: &str) -> Result<(), String> {
    db.with_connection(|conn| {
        conn.execute(
            "UPDATE native_transactions SET status = ?2 WHERE id = ?1",
            params![id, status],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
}

fn encrypt(key: &[u8; 32], original: &[u8]) -> Result<(String, String), String> {
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    let mut nonce_bytes = [0_u8; 12];
    rand::rng().fill(&mut nonce_bytes);
    let encrypted = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), original)
        .map_err(|_| "无法加密原生备份")?;
    Ok((STANDARD.encode(encrypted), STANDARD.encode(nonce_bytes)))
}

fn decrypt(key: &[u8; 32], encrypted: &str, nonce: &str) -> Result<Vec<u8>, String> {
    let ciphertext = STANDARD.decode(encrypted).map_err(|_| "原生备份内容损坏")?;
    let nonce = STANDARD.decode(nonce).map_err(|_| "原生备份标识损坏")?;
    if nonce.len() != 12 {
        return Err("原生备份标识长度错误".into());
    }
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    cipher
        .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| "无法解密原生备份".into())
}

#[cfg(windows)]
fn restrict_windows_stage(stage: &Path) -> Result<(), String> {
    use std::process::Command;
    let system32 =
        PathBuf::from(std::env::var_os("SystemRoot").ok_or("无法定位 Windows 系统目录")?)
            .join("System32");
    let identity = Command::new(system32.join("whoami.exe"))
        .args(["/user", "/fo", "csv", "/nh"])
        .output()
        .map_err(|_| "无法检查当前 Windows 用户身份")?;
    if !identity.status.success() {
        return Err("无法检查当前 Windows 用户身份".into());
    }
    let output = String::from_utf8(identity.stdout).map_err(|_| "Windows 用户身份编码异常")?;
    let sid = output
        .trim()
        .rsplit(',')
        .next()
        .unwrap_or("")
        .trim_matches('"');
    if !sid.starts_with("S-1-") || !sid[4..].chars().all(|c| c.is_ascii_digit() || c == '-') {
        return Err("Windows 用户 SID 无效，拒绝写入原生密钥".into());
    }
    // A newly created stage normally has only inherited entries, but reset
    // also removes any explicit grants before the inheritance is removed.
    let reset = Command::new(system32.join("icacls.exe"))
        .arg(stage)
        .arg("/reset")
        .output()
        .map_err(|_| "无法重设原生密钥文件的 Windows ACL")?;
    if !reset.status.success() {
        return Err("无法重设原生密钥文件的 Windows ACL，未写入密钥".into());
    }
    let user = format!("*{sid}:F");
    let status = Command::new(system32.join("icacls.exe"))
        .arg(stage)
        .args(["/inheritance:r", "/grant:r"])
        .arg(&user)
        .args(["/grant:r", "*S-1-5-18:F"])
        .output()
        .map_err(|_| "无法限制原生密钥文件的 Windows ACL")?;
    if !status.status.success() {
        return Err("无法限制原生密钥文件的 Windows ACL，未写入密钥".into());
    }
    Ok(())
}

fn write_replacement(
    path: &Path,
    contents: &[u8],
    id: &str,
    sensitive: bool,
) -> Result<(), String> {
    let parent = path.parent().ok_or("原生文件缺少父目录")?;
    fs::create_dir_all(parent)
        .map_err(|_| format!("无法创建原生配置目录：{}", parent.display()))?;
    let stage = parent.join(format!(".cliora-{id}.tmp"));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    let mut file = options
        .open(&stage)
        .map_err(|_| format!("无法建立临时原生文件：{}", stage.display()))?;
    #[cfg(windows)]
    if sensitive {
        if let Err(error) = restrict_windows_stage(&stage) {
            drop(file);
            let _ = fs::remove_file(&stage);
            return Err(error);
        }
    }
    #[cfg(not(windows))]
    let _ = sensitive;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|_| "无法限制原生文件权限")?;
    }
    file.write_all(contents)
        .and_then(|_| file.sync_all())
        .map_err(|_| "无法完整写入临时原生文件")?;
    drop(file);
    if let Err(error) = fs::rename(&stage, path) {
        let _ = fs::remove_file(&stage);
        return Err(format!("无法替换原生文件 {}：{error}", path.display()));
    }
    Ok(())
}

fn restore(
    db: &Database,
    credentials: &dyn CredentialStore,
    journal: &Journal,
    integrity: &[u8; 32],
) -> Result<(), String> {
    let encoded_key = credentials
        .get(&journal.key_id)
        .map_err(|_| "无法取得原生备份密钥；原文件和备份仍保留")?;
    let bytes = STANDARD
        .decode(encoded_key)
        .map_err(|_| "原生备份密钥格式错误")?;
    let key: [u8; 32] = bytes.try_into().map_err(|_| "原生备份密钥长度错误")?;
    let mut problems = Vec::new();
    for item in journal.files.iter().rev() {
        let current = match read_native(&item.path) {
            Ok(text) => text,
            Err(error) => {
                problems.push(error);
                continue;
            }
        };
        if let Some(parent) = item.path.parent() {
            let stage = parent.join(format!(".cliora-{}.tmp", journal.id));
            if stage.is_file() {
                let _ = fs::remove_file(stage);
            }
        }
        let hash = keyed_fingerprint(integrity, current.as_bytes());
        if hash == item.old_hash {
            continue;
        }
        if hash != item.new_hash {
            problems.push(format!(
                "{} 已出现新的外部修改，不能自动恢复",
                item.path.display()
            ));
            continue;
        }
        let result = if item.existed {
            let original = match (&item.backup, &item.nonce) {
                (Some(backup), Some(nonce)) => decrypt(&key, backup, nonce),
                _ => Err("原生备份缺失".into()),
            };
            original.and_then(|bytes| {
                // Older journals predate the sensitive flag. Their encrypted
                // backup may still contain a native token, so restore privately.
                write_replacement(&item.path, &bytes, &Uuid::new_v4().to_string(), true)?;
                if item.old_readonly {
                    let mut permissions = fs::metadata(&item.path)
                        .map_err(|_| "无法读取恢复文件权限")?
                        .permissions();
                    permissions.set_readonly(true);
                    fs::set_permissions(&item.path, permissions).map_err(|_| "无法恢复文件权限")?;
                }
                Ok(())
            })
        } else {
            fs::remove_file(&item.path).map_err(|_| "无法删除本事务新建的文件".into())
        };
        if let Err(error) = result {
            problems.push(error);
        }
    }
    if !problems.is_empty() {
        set_status(db, &journal.id, "recovery_needed")?;
        return Err(problems.join("；"));
    }
    set_status(db, &journal.id, "rolled_back")
}

pub fn recover_pending(
    db: &Database,
    credentials: &dyn CredentialStore,
) -> Result<Vec<String>, String> {
    let _guard = write_lock().lock().map_err(|_| "原生事务服务暂时不可用")?;
    let pending_ids: Vec<String> = db.with_connection(|conn| {
        let mut statement = conn.prepare("SELECT id FROM native_transactions WHERE status IN ('prepared', 'applying', 'recovery_needed') ORDER BY id").map_err(|e| e.to_string())?;
        let ids = statement.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?
            .collect::<Result<_, _>>().map_err(|e| e.to_string())?;
        Ok(ids)
    })?;
    if pending_ids.is_empty() {
        // Browsing never needs a key unless older records still contain bare
        // digests. Migrate those on the next unlocked browse, without making
        // a locked keyring hide the editor.
        if has_legacy_digests(db)? {
            match integrity_key_checked(db, credentials) {
                Ok(_) | Err(IntegrityKeyError::CredentialUnavailable(_)) => {}
                Err(error) => return Err(error.message()),
            }
        }
        return Ok(Vec::new());
    }
    let integrity = match integrity_key_checked(db, credentials) {
        Ok(key) => key,
        Err(IntegrityKeyError::CredentialUnavailable(_)) => return Ok(pending_ids),
        Err(error) => return Err(error.message()),
    };
    // Legacy unkeyed digests are migrated by integrity_key, so load the
    // journals after that migration rather than retaining stale copies.
    let pending: Vec<Journal> = db.with_connection(|conn| {
        let mut statement = conn.prepare("SELECT data FROM native_transactions WHERE status IN ('prepared', 'applying', 'recovery_needed') ORDER BY id").map_err(|e| e.to_string())?;
        let journals = statement.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?
            .map(|row| serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| format!("原生事务日志损坏：{e}"))).collect();
        journals
    })?;
    let mut unresolved = Vec::new();
    for journal in pending {
        if restore(db, credentials, &journal, &integrity).is_err() {
            unresolved.push(journal.id);
        }
    }
    Ok(unresolved)
}

pub fn apply<F>(
    db: &Database,
    credentials: &dyn CredentialStore,
    patches: &[FilePatch],
    commit: F,
) -> Result<ApplyOutcome, String>
where
    F: FnOnce(&rusqlite::Transaction<'_>) -> Result<(), String>,
{
    let _guard = write_lock().lock().map_err(|_| "原生事务服务暂时不可用")?;
    let integrity = integrity_key(db, credentials)?;
    let prepared = prepare(patches, &integrity)?;
    apply_prepared(db, credentials, &integrity, prepared, commit)
}

pub fn apply_text<F>(
    db: &Database,
    credentials: &dyn CredentialStore,
    patches: &[TextPatch],
    commit: F,
) -> Result<ApplyOutcome, String>
where
    F: FnOnce(&rusqlite::Transaction<'_>) -> Result<(), String>,
{
    let _guard = write_lock().lock().map_err(|_| "原生事务服务暂时不可用")?;
    let integrity = integrity_key(db, credentials)?;
    let mut seen = HashSet::new();
    let mut prepared = Vec::new();
    for patch in patches {
        if !seen.insert(&patch.path) {
            return Err("同一事务中出现重复目标文件".into());
        }
        let current = read_native(&patch.path)?;
        if current != patch.baseline {
            return Err(format!("原生文本已被外部修改：{}", patch.path.display()));
        }
        if current == patch.contents {
            continue;
        }
        let existed = patch.path.exists();
        let old_readonly = if existed {
            fs::metadata(&patch.path)
                .map_err(|_| "无法检查原生文件权限")?
                .permissions()
                .readonly()
        } else {
            false
        };
        prepared.push((
            JournalFile {
                path: patch.path.clone(),
                existed,
                old_hash: keyed_fingerprint(&integrity, current.as_bytes()),
                new_hash: keyed_fingerprint(&integrity, patch.contents.as_bytes()),
                backup: None,
                nonce: None,
                old_readonly,
                sensitive: false,
            },
            patch.contents.clone(),
        ));
    }
    apply_prepared(db, credentials, &integrity, prepared, commit)
}

fn apply_prepared<F>(
    db: &Database,
    credentials: &dyn CredentialStore,
    integrity: &[u8; 32],
    prepared: Vec<(JournalFile, String)>,
    commit: F,
) -> Result<ApplyOutcome, String>
where
    F: FnOnce(&rusqlite::Transaction<'_>) -> Result<(), String>,
{
    if prepared.is_empty() {
        return Err("没有需要写入的原生字段".into());
    }
    let targets: Vec<_> = prepared.iter().map(|(item, _)| item.path.clone()).collect();
    let pending = pending_target_collision(db, &targets)?;
    if pending {
        return Err("目标文件有未解决的原生事务，请先恢复".into());
    }
    let id = Uuid::new_v4().to_string();
    let key_id = format!("native-backup-{id}");
    let mut key = [0_u8; 32];
    rand::rng().fill(&mut key);
    credentials
        .put(&key_id, &STANDARD.encode(key))
        .map_err(|_| "系统凭据服务无法保存原生备份密钥；未写入配置")?;
    let mut files = Vec::new();
    for (item, _) in &prepared {
        let mut item = item.clone();
        if item.existed {
            let bytes = fs::read(&item.path).map_err(|_| "准备备份时无法读取原生文件")?;
            if keyed_fingerprint(&integrity, &bytes) != item.old_hash {
                return Err("原生文件在准备备份期间发生变化".into());
            }
            let (backup, nonce) = encrypt(&key, &bytes)?;
            item.backup = Some(backup);
            item.nonce = Some(nonce);
        }
        files.push(item);
    }
    let journal = Journal {
        id: id.clone(),
        key_id,
        files,
    };
    save_journal(db, &journal, "prepared")?;
    let attempt = (|| {
        set_status(db, &id, "applying")?;
        for (item, output) in &prepared {
            let current = read_native(&item.path)?;
            if keyed_fingerprint(&integrity, current.as_bytes()) != item.old_hash {
                return Err(format!("原生文件写入前发生变化：{}", item.path.display()));
            }
            write_replacement(&item.path, output.as_bytes(), &id, item.sensitive)?;
            let written = fs::read(&item.path).map_err(|_| "无法核验原生写入")?;
            if keyed_fingerprint(&integrity, &written) != item.new_hash {
                return Err("原生写入后校验失败".into());
            }
        }
        for (item, _) in &prepared {
            let written = fs::read(&item.path).map_err(|_| "提交前无法重读原生文件")?;
            if keyed_fingerprint(&integrity, &written) != item.new_hash {
                return Err(format!("提交前发现外部修改：{}", item.path.display()));
            }
        }
        db.with_connection(|conn| {
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            commit(&tx)?;
            tx.execute(
                "UPDATE native_transactions SET status = 'committed' WHERE id = ?1",
                [&id],
            )
            .map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())
        })
    })();
    if let Err(error) = attempt {
        return match restore(db, credentials, &journal, &integrity) {
            Ok(()) => Err(error),
            Err(recovery) => Err(format!("{error}；自动恢复未完成：{recovery}")),
        };
    }
    Ok(ApplyOutcome {
        transaction_id: id,
        changed_files: targets
            .iter()
            .map(|path| path.display().to_string())
            .collect(),
        status: "written_for_next_session",
    })
}

fn pending_target_collision(db: &Database, targets: &[PathBuf]) -> Result<bool, String> {
    db.with_connection(|conn| {
        let mut statement = conn.prepare("SELECT data FROM native_transactions WHERE status IN ('prepared', 'applying', 'recovery_needed')").map_err(|e| e.to_string())?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
        let mut collision = false;
        for row in rows {
            let journal: Journal = serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|_| "原生事务日志损坏")?;
            collision |= journal.files.iter().any(|item| targets.contains(&item.path));
        }
        Ok(collision)
    })
}

/// Commit a matching profile only while the same native-write lock protects the
/// pending journal check and a second read of every unchanged target.
pub fn commit_matching<F>(
    db: &Database,
    baselines: &[(PathBuf, String)],
    commit: F,
) -> Result<ApplyOutcome, String>
where
    F: FnOnce(&rusqlite::Transaction<'_>) -> Result<(), String>,
{
    let _guard = write_lock().lock().map_err(|_| "原生事务服务暂时不可用")?;
    let targets: Vec<_> = baselines.iter().map(|(path, _)| path.clone()).collect();
    if pending_target_collision(db, &targets)? {
        return Err("目标文件有未解决的原生事务，请先恢复".into());
    }
    for (path, baseline) in baselines {
        if fingerprint(read_native(path)?.as_bytes()) != fingerprint(baseline.as_bytes()) {
            return Err(format!("原生文件在检查期间发生变化：{}", path.display()));
        }
    }
    db.with_connection(|conn| {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        commit(&tx)?;
        tx.commit().map_err(|e| e.to_string())
    })?;
    Ok(ApplyOutcome {
        transaction_id: "already-matching".into(),
        changed_files: Vec::new(),
        status: "already_matching",
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemoryStore(Mutex<HashMap<String, String>>);
    impl CredentialStore for MemoryStore {
        fn put(&self, id: &str, secret: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert(id.into(), secret.into());
            Ok(())
        }
        fn get(&self, id: &str) -> Result<String, String> {
            self.0
                .lock()
                .unwrap()
                .get(id)
                .cloned()
                .ok_or("missing".into())
        }
        fn delete(&self, id: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(id);
            Ok(())
        }
    }

    struct LockedStore;
    impl CredentialStore for LockedStore {
        fn put(&self, _id: &str, _secret: &str) -> Result<(), String> {
            Err("locked".into())
        }
        fn get(&self, _id: &str) -> Result<String, String> {
            Err("locked".into())
        }
        fn delete(&self, _id: &str) -> Result<(), String> {
            Err("locked".into())
        }
    }

    #[test]
    fn empty_workspace_recovery_does_not_require_or_create_a_keyring_key() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let store = MemoryStore::default();
        assert!(recover_pending(&db, &store).unwrap().is_empty());
        assert!(store.get(INTEGRITY_KEY_ID).is_err());
    }

    #[test]
    fn committed_history_does_not_block_reading_when_keyring_is_locked() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let store = MemoryStore::default();
        integrity_key(&db, &store).unwrap();
        let old_hash = fingerprint(b"low-entropy-old-file");
        let secret_hash = fingerprint(b"short-key");
        let journal = Journal {
            id: "committed-history".into(),
            key_id: "missing".into(),
            files: vec![JournalFile {
                path: temp.path().join("old.json"),
                existed: true,
                old_hash: old_hash.clone(),
                new_hash: old_hash.clone(),
                backup: None,
                nonce: None,
                old_readonly: false,
                sensitive: true,
            }],
        };
        save_journal(&db, &journal, "committed").unwrap();
        db.with_connection(|conn| {
            let managed = serde_json::json!({"settings": {"/env/ANTHROPIC_API_KEY": {"__cliora_secret_sha256": secret_hash}}});
            conn.execute("INSERT INTO applied_bindings (scope_key, tool, profile_id, profile_version, managed) VALUES ('global', 'claude_code', 'legacy', 1, ?1)", [managed.to_string()]).map_err(|e| e.to_string())?;
            Ok(())
        }).unwrap();
        assert!(recover_pending(&db, &LockedStore).unwrap().is_empty());
        db.with_connection(|conn| {
            let data: String = conn
                .query_row(
                    "SELECT data FROM native_transactions WHERE id = 'committed-history'",
                    [],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            assert!(data.contains(&old_hash));
            let binding: String = conn
                .query_row("SELECT managed FROM applied_bindings", [], |row| row.get(0))
                .map_err(|e| e.to_string())?;
            assert!(binding.contains(&secret_hash));
            Ok(())
        })
        .unwrap();
        assert!(recover_pending(&db, &store).unwrap().is_empty());
        let migrated = db
            .with_connection(|conn| {
                let data: String = conn
                    .query_row(
                        "SELECT data FROM native_transactions WHERE id = 'committed-history'",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                let binding: String = conn
                    .query_row("SELECT managed FROM applied_bindings", [], |row| row.get(0))
                    .map_err(|e| e.to_string())?;
                Ok((data, binding))
            })
            .unwrap();
        assert!(!migrated.0.contains(&old_hash));
        assert!(!migrated.1.contains(&secret_hash));
        assert!(migrated.0.contains("h1:"));
        assert!(migrated.1.contains("h1:"));
        assert!(recover_pending(&db, &store).unwrap().is_empty());
        assert!(recover_pending(&db, &LockedStore).unwrap().is_empty());
        db.with_connection(|conn| {
            let data: String = conn
                .query_row(
                    "SELECT data FROM native_transactions WHERE id = 'committed-history'",
                    [],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            let binding: String = conn
                .query_row("SELECT managed FROM applied_bindings", [], |row| row.get(0))
                .map_err(|e| e.to_string())?;
            assert_eq!((data, binding), migrated);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn corrupt_committed_digest_is_reported_instead_of_masked_as_locked_keyring() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let journal = Journal {
            id: "corrupt-history".into(),
            key_id: "missing".into(),
            files: vec![JournalFile {
                path: temp.path().join("old.json"),
                existed: true,
                old_hash: "broken-digest".into(),
                new_hash: fingerprint(b"next"),
                backup: None,
                nonce: None,
                old_readonly: false,
                sensitive: true,
            }],
        };
        save_journal(&db, &journal, "committed").unwrap();
        assert!(recover_pending(&db, &LockedStore)
            .unwrap_err()
            .contains("摘要格式异常"));
    }

    #[test]
    fn locked_keyring_reports_pending_id_without_writing_and_later_recovers() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("settings.json");
        let original = br#"{"model":"old"}"#;
        let written = br#"{"model":"new"}"#;
        fs::write(&path, written).unwrap();
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let store = MemoryStore::default();
        let integrity = integrity_key(&db, &store).unwrap();
        let backup_key = [3_u8; 32];
        store
            .put("native-backup-pending", &STANDARD.encode(backup_key))
            .unwrap();
        let (backup, nonce) = encrypt(&backup_key, original).unwrap();
        let journal = Journal {
            id: "pending".into(),
            key_id: "native-backup-pending".into(),
            files: vec![JournalFile {
                path: path.clone(),
                existed: true,
                old_hash: keyed_fingerprint(&integrity, original),
                new_hash: keyed_fingerprint(&integrity, written),
                backup: Some(backup),
                nonce: Some(nonce),
                old_readonly: false,
                sensitive: false,
            }],
        };
        save_journal(&db, &journal, "applying").unwrap();
        assert_eq!(recover_pending(&db, &LockedStore).unwrap(), vec!["pending"]);
        assert_eq!(fs::read(&path).unwrap(), written);
        db.with_connection(|conn| {
            let status: String = conn
                .query_row(
                    "SELECT status FROM native_transactions WHERE id = 'pending'",
                    [],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            assert_eq!(status, "applying");
            Ok(())
        })
        .unwrap();
        assert!(recover_pending(&db, &store).unwrap().is_empty());
        assert_eq!(fs::read(&path).unwrap(), original);
        db.with_connection(|conn| {
            let status: String = conn
                .query_row(
                    "SELECT status FROM native_transactions WHERE id = 'pending'",
                    [],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            assert_eq!(status, "rolled_back");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn hmac_matches_standard_vector_and_legacy_records_migrate_without_bare_hashes() {
        let mut vector_key = [0_u8; 32];
        vector_key[..4].copy_from_slice(b"Jefe");
        assert_eq!(
            hmac_digest(&vector_key, b"what do ya want for nothing?"),
            "h1:5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );

        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let store = MemoryStore::default();
        store
            .put(INTEGRITY_KEY_ID, &STANDARD.encode([7_u8; 32]))
            .unwrap();
        let raw_secret_hash = fingerprint(b"short-key");
        let raw_file_hash = fingerprint(b"{\"apiKey\":\"short-key\"}");
        db.with_connection(|conn| {
            let managed = serde_json::json!({"settings": {"/env/ANTHROPIC_API_KEY": {"__cliora_secret_sha256": raw_secret_hash}}});
            conn.execute("INSERT INTO applied_bindings (scope_key, tool, profile_id, profile_version, managed) VALUES ('global', 'claude_code', 'legacy', 1, ?1)", [managed.to_string()]).map_err(|e| e.to_string())?;
            let journal = Journal {
                id: "legacy".into(), key_id: "native-backup-legacy".into(),
                files: vec![JournalFile {path: temp.path().join("settings.json"), existed: true,
                    old_hash: raw_file_hash.clone(), new_hash: raw_file_hash.clone(),
                    backup: None, nonce: None, old_readonly: false, sensitive: true}],
            };
            conn.execute("INSERT INTO native_transactions (id, status, data) VALUES ('legacy', 'committed', ?1)", [serde_json::to_string(&journal).unwrap()]).map_err(|e| e.to_string())?;
            Ok(())
        }).unwrap();
        let key = integrity_key(&db, &store).unwrap();
        assert_eq!(key, [7_u8; 32]);
        assert_eq!(integrity_key(&db, &store).unwrap(), key);
        db.with_connection(|conn| {
            let binding: String = conn
                .query_row("SELECT managed FROM applied_bindings", [], |row| row.get(0))
                .map_err(|e| e.to_string())?;
            let journal: String = conn
                .query_row("SELECT data FROM native_transactions", [], |row| row.get(0))
                .map_err(|e| e.to_string())?;
            assert!(!binding.contains(&raw_secret_hash));
            assert!(!journal.contains(&raw_file_hash));
            assert!(binding.contains("h1:"));
            assert!(journal.contains("h1:"));
            assert!(!binding.contains("short-key"));
            assert!(!journal.contains("short-key"));
            Ok(())
        })
        .unwrap();
        store.delete(INTEGRITY_KEY_ID).unwrap();
        assert!(integrity_key(&db, &store).unwrap_err().contains("已丢失"));
    }

    #[test]
    fn matching_secret_content_still_uses_restricted_transaction() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("settings.json");
        let text = r#"{"env":{"ANTHROPIC_API_KEY":"short-key"}}"#;
        fs::write(&path, text).unwrap();
        #[cfg(windows)]
        {
            use std::process::Command;
            let system32 = PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32");
            let grant = Command::new(system32.join("icacls.exe"))
                .arg(&path)
                .args(["/grant", "*S-1-5-32-545:R"])
                .output()
                .unwrap();
            assert!(grant.status.success());
            let before = Command::new(system32.join("icacls.exe"))
                .arg(&path)
                .args(["/findsid", "*S-1-5-32-545"])
                .output()
                .unwrap();
            assert!(String::from_utf8_lossy(&before.stdout).contains(&path.display().to_string()));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        }
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let store = MemoryStore::default();
        let patch = FilePatch {
            path: path.clone(),
            kind: FileKind::Json,
            baseline: text.into(),
            changes: Vec::new(),
            sensitive: true,
            force_restrict: true,
        };
        let outcome = apply(&db, &store, &[patch], |_| Ok(())).unwrap();
        assert_eq!(outcome.changed_files, vec![path.display().to_string()]);
        assert_eq!(fs::read_to_string(&path).unwrap(), text);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o077, 0);
        }
        #[cfg(windows)]
        {
            use std::process::Command;
            let system32 = PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32");
            let output = Command::new(system32.join("icacls.exe"))
                .arg(&path)
                .output()
                .unwrap();
            assert!(output.status.success());
            assert!(!String::from_utf8_lossy(&output.stdout).contains("(I)"));
            let users = Command::new(system32.join("icacls.exe"))
                .arg(&path)
                .args(["/findsid", "*S-1-5-32-545"])
                .output()
                .unwrap();
            assert!(users.status.success());
            assert!(!String::from_utf8_lossy(&users.stdout).contains(&path.display().to_string()));
        }
        db.with_connection(|conn| {
            let data: String = conn
                .query_row("SELECT data FROM native_transactions", [], |row| row.get(0))
                .map_err(|e| e.to_string())?;
            assert!(!data.contains(&fingerprint(text.as_bytes())));
            assert!(data.contains("h1:"));
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn matching_commit_refuses_pending_target_without_changing_binding() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("config.toml");
        fs::write(&file, "model = \"one\"\n").unwrap();
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let journal = Journal {
            id: "pending".into(),
            key_id: "missing".into(),
            files: vec![JournalFile {
                path: file.clone(),
                existed: true,
                old_hash: fingerprint(b"model = \"one\"\n"),
                new_hash: fingerprint(b"model = \"two\"\n"),
                backup: None,
                nonce: None,
                old_readonly: false,
                sensitive: false,
            }],
        };
        save_journal(&db, &journal, "recovery_needed").unwrap();
        let result = commit_matching(&db, &[(file.clone(), "model = \"one\"\n".into())], |tx| {
            tx.execute("INSERT INTO applied_bindings (scope_key, tool, profile_id, profile_version, managed) VALUES ('global', 'codex', 'new', 2, '{}')", []).map_err(|e| e.to_string())?;
            Ok(())
        });
        assert!(result.unwrap_err().contains("未解决"));
        db.with_connection(|conn| {
            let count: i64 = conn
                .query_row("SELECT count(*) FROM applied_bindings", [], |row| {
                    row.get(0)
                })
                .map_err(|e| e.to_string())?;
            assert_eq!(count, 0);
            Ok(())
        })
        .unwrap();
        assert_eq!(fs::read_to_string(file).unwrap(), "model = \"one\"\n");
    }

    #[test]
    fn unrelated_external_edit_merges_and_same_field_conflicts() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("config.toml");
        let baseline = "model = \"old\"\n# keep\n";
        fs::write(&file, "model = \"old\"\n# keep\nother = 1\n").unwrap();
        let patch = FilePatch {
            path: file.clone(),
            kind: FileKind::Toml,
            baseline: baseline.into(),
            changes: vec![FieldChange {
                path: vec!["model".into()],
                value: Some(Value::String("new".into())),
            }],
            sensitive: false,
            force_restrict: false,
        };
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        apply(&db, &MemoryStore::default(), &[patch.clone()], |_| Ok(())).unwrap();
        let output = fs::read_to_string(&file).unwrap();
        assert!(output.contains("# keep"));
        assert!(output.contains("other = 1"));
        assert!(output.contains("model = \"new\""));
        fs::write(&file, "model = \"external\"\n").unwrap();
        assert!(prepare(&[patch], &[1_u8; 32])
            .unwrap_err()
            .contains("外部修改"));
        assert_eq!(fs::read_to_string(&file).unwrap(), "model = \"external\"\n");
    }

    #[test]
    fn database_failure_restores_original_from_encrypted_backup() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("settings.jsonc");
        let baseline = "{\"model\":\"old\", // preserve\n\"other\":2}";
        fs::write(&file, baseline).unwrap();
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let store = MemoryStore::default();
        let patch = FilePatch {
            path: file.clone(),
            kind: FileKind::Jsonc,
            baseline: baseline.into(),
            changes: vec![FieldChange {
                path: vec!["model".into()],
                value: Some(Value::String("new".into())),
            }],
            sensitive: false,
            force_restrict: false,
        };
        assert!(
            apply(&db, &store, &[patch], |_| Err("injected failure".into()))
                .unwrap_err()
                .contains("injected failure")
        );
        assert_eq!(fs::read_to_string(file).unwrap(), baseline);
        db.with_connection(|conn| {
            let (status, data): (String, String) = conn
                .query_row("SELECT status, data FROM native_transactions", [], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })
                .map_err(|e| e.to_string())?;
            assert_eq!(status, "rolled_back");
            assert!(!data.contains(baseline));
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn interrupted_multifile_transaction_recovers_only_its_written_version() {
        let temp = tempfile::tempdir().unwrap();
        let first = temp.path().join("settings.json");
        let second = temp.path().join("models.json");
        fs::write(&first, b"{\"model\":\"old\"}").unwrap();
        fs::write(&second, b"{\"providers\":{}}").unwrap();
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let store = MemoryStore::default();
        let id = Uuid::new_v4().to_string();
        let key_id = format!("native-backup-{id}");
        let key = [7_u8; 32];
        store.put(&key_id, &STANDARD.encode(key)).unwrap();
        let make_file = |path: &Path, new: &[u8]| {
            let old = fs::read(path).unwrap();
            let (backup, nonce) = encrypt(&key, &old).unwrap();
            JournalFile {
                path: path.into(),
                existed: true,
                old_hash: fingerprint(&old),
                new_hash: fingerprint(new),
                backup: Some(backup),
                nonce: Some(nonce),
                old_readonly: false,
                sensitive: false,
            }
        };
        let journal = Journal {
            id: id.clone(),
            key_id,
            files: vec![
                make_file(&first, b"{\"model\":\"new\"}"),
                make_file(&second, b"{\"providers\":{\"x\":{}}}"),
            ],
        };
        save_journal(&db, &journal, "applying").unwrap();
        write_replacement(&first, b"{\"model\":\"new\"}", &id, false).unwrap();
        assert!(recover_pending(&db, &store).unwrap().is_empty());
        assert_eq!(fs::read(&first).unwrap(), b"{\"model\":\"old\"}");
        assert_eq!(fs::read(&second).unwrap(), b"{\"providers\":{}}");
    }

    #[test]
    fn recovery_preserves_new_external_edit_and_encrypted_backup() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("config.toml");
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let store = MemoryStore::default();
        let id = Uuid::new_v4().to_string();
        let key_id = format!("native-backup-{id}");
        let key = [9_u8; 32];
        store.put(&key_id, &STANDARD.encode(key)).unwrap();
        let original = b"model = \"old\"\n";
        let (backup, nonce) = encrypt(&key, original).unwrap();
        let journal = Journal {
            id: id.clone(),
            key_id,
            files: vec![JournalFile {
                path: file.clone(),
                existed: true,
                old_hash: fingerprint(original),
                new_hash: fingerprint(b"model = \"new\"\n"),
                backup: Some(backup),
                nonce: Some(nonce),
                old_readonly: false,
                sensitive: false,
            }],
        };
        save_journal(&db, &journal, "applying").unwrap();
        fs::write(&file, b"model = \"external\"\n").unwrap();
        assert_eq!(recover_pending(&db, &store).unwrap(), vec![id]);
        assert_eq!(fs::read(file).unwrap(), b"model = \"external\"\n");
        db.with_connection(|conn| {
            let (status, data): (String, String) = conn
                .query_row("SELECT status, data FROM native_transactions", [], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })
                .map_err(|e| e.to_string())?;
            assert_eq!(status, "recovery_needed");
            assert!(!data.contains("model = \\\"old\\\""));
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn failed_sensitive_commit_restores_old_secret_without_plaintext_journal() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("settings.json");
        let original = r#"{"env":{"ANTHROPIC_API_KEY":"old-test-key"}}"#;
        fs::write(&file, original).unwrap();
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let patch = FilePatch {
            path: file.clone(),
            kind: FileKind::Json,
            baseline: original.into(),
            sensitive: true,
            force_restrict: true,
            changes: vec![FieldChange {
                path: vec!["env".into(), "ANTHROPIC_API_KEY".into()],
                value: Some(Value::String("new-test-key".into())),
            }],
        };
        assert!(apply(&db, &MemoryStore::default(), &[patch], |_| Err(
            "injected database failure".into()
        ))
        .is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), original);
        db.with_connection(|conn| {
            let data: String = conn
                .query_row("SELECT data FROM native_transactions", [], |row| row.get(0))
                .map_err(|e| e.to_string())?;
            assert!(!data.contains("old-test-key"));
            assert!(!data.contains("new-test-key"));
            Ok(())
        })
        .unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn sensitive_native_file_has_no_inherited_windows_acl_after_write() {
        use std::process::Command;
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("private.json");
        write_replacement(&file, b"{\"apiKey\":\"test-only\"}", "acl-test", true).unwrap();
        let system32 = PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32");
        let output = Command::new(system32.join("icacls.exe"))
            .arg(&file)
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(!String::from_utf8_lossy(&output.stdout).contains("(I)"));
    }
}
