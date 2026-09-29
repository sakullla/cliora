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
use rusqlite::params;
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

fn prepare(patches: &[FilePatch]) -> Result<Vec<(JournalFile, String)>, String> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for patch in patches {
        if !seen.insert(&patch.path) {
            return Err("同一事务中出现重复目标文件".into());
        }
        if patch.changes.is_empty() {
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
        if output == current_text {
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
                old_hash: fingerprint(current_text.as_bytes()),
                new_hash: fingerprint(output.as_bytes()),
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
        let hash = fingerprint(current.as_bytes());
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
    let pending: Vec<Journal> = db.with_connection(|conn| {
        let mut statement = conn.prepare("SELECT data FROM native_transactions WHERE status IN ('prepared', 'applying', 'recovery_needed')").map_err(|e| e.to_string())?;
        let journals = statement.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?
            .map(|row| serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| format!("原生事务日志损坏：{e}"))).collect();
        journals
    })?;
    let mut unresolved = Vec::new();
    for journal in pending {
        if restore(db, credentials, &journal).is_err() {
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
    let prepared = prepare(patches)?;
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
            if fingerprint(&bytes) != item.old_hash {
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
            if fingerprint(current.as_bytes()) != item.old_hash {
                return Err(format!("原生文件写入前发生变化：{}", item.path.display()));
            }
            write_replacement(&item.path, output.as_bytes(), &id, item.sensitive)?;
            let written = fs::read(&item.path).map_err(|_| "无法核验原生写入")?;
            if fingerprint(&written) != item.new_hash {
                return Err("原生写入后校验失败".into());
            }
        }
        for (item, _) in &prepared {
            let written = fs::read(&item.path).map_err(|_| "提交前无法重读原生文件")?;
            if fingerprint(&written) != item.new_hash {
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
        return match restore(db, credentials, &journal) {
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
        };
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        apply(&db, &MemoryStore::default(), &[patch.clone()], |_| Ok(())).unwrap();
        let output = fs::read_to_string(&file).unwrap();
        assert!(output.contains("# keep"));
        assert!(output.contains("other = 1"));
        assert!(output.contains("model = \"new\""));
        fs::write(&file, "model = \"external\"\n").unwrap();
        assert!(prepare(&[patch]).unwrap_err().contains("外部修改"));
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
