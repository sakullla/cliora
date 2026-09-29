use std::collections::BTreeMap;
use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::database::Database;
use crate::native::adapter::Scope;
use crate::native::adapters::Registry;
use crate::projects;

const MAX_FILES: usize = 256;
const MAX_BYTES: usize = 12 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPackage {
    pub id: String,
    pub name: String,
    pub description: String,
    pub compatibility: Option<String>,
    pub source: String,
    pub digest: String,
    pub file_count: usize,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstallation {
    pub package_id: String,
    pub tool_id: String,
    pub scope: Scope,
    pub project_path: Option<String>,
    pub target_path: String,
    pub digest: String,
    pub state: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillTargetResult {
    pub tool_id: String,
    pub scope: Scope,
    pub project_path: Option<String>,
    pub path: Option<String>,
    pub status: &'static str,
    pub detail: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSkillEntry {
    pub name: String,
    pub path: String,
    pub digest: Option<String>,
    pub state: &'static str,
    pub detail: String,
    pub package_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillTargetPreview {
    pub path: String,
    pub status: &'static str,
    pub detail: String,
    pub preview_token: Option<String>,
    pub existing_digest: Option<String>,
    pub package_digest: String,
    pub changes: Vec<SkillFileChange>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillImportPreview {
    pub name: String,
    pub source: String,
    pub digest: String,
    pub file_count: usize,
    pub compatibility: Option<String>,
    pub existing_digest: Option<String>,
    pub changed_files: Vec<String>,
    pub changes: Vec<SkillFileChange>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFileChange {
    pub path: String,
    pub before: Option<String>,
    pub after: Option<String>,
    pub before_size: Option<usize>,
    pub after_size: Option<usize>,
    pub before_digest: Option<String>,
    pub after_digest: Option<String>,
}

struct Candidate {
    name: String,
    description: String,
    compatibility: Option<String>,
    source: String,
    files: BTreeMap<String, String>,
    digest: String,
}

fn compare_files(
    old_files: &BTreeMap<String, String>,
    new_files: &BTreeMap<String, String>,
) -> Result<Vec<SkillFileChange>, String> {
    old_files
        .keys()
        .chain(new_files.keys())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .filter(|name| old_files.get(*name) != new_files.get(*name))
        .map(|path| {
            let decode = |encoded: Option<&String>| {
                encoded
                    .map(|value| STANDARD.decode(value).map_err(|_| "Skills 包文件损坏"))
                    .transpose()
            };
            let before = decode(old_files.get(path))?;
            let after = decode(new_files.get(path))?;
            let summary =
                |value: Option<&Vec<u8>>| -> (Option<String>, Option<usize>, Option<String>) {
                    let size = value.map(Vec::len);
                    let hash = value.map(|bytes| format!("{:x}", Sha256::digest(bytes)));
                    let text = value.and_then(|bytes| {
                        if bytes.len() <= 256 * 1024 && !bytes.contains(&0) {
                            std::str::from_utf8(bytes).ok().map(str::to_owned)
                        } else {
                            None
                        }
                    });
                    (text, size, hash)
                };
            let (before, before_size, before_digest) = summary(before.as_ref());
            let (after, after_size, after_digest) = summary(after.as_ref());
            Ok(SkillFileChange {
                path: path.clone(),
                before,
                after,
                before_size,
                after_size,
                before_digest,
                after_digest,
            })
        })
        .collect()
}

fn preview_candidate(db: &Database, candidate: &Candidate) -> Result<SkillImportPreview, String> {
    let existing: Option<(String, String)> = db.with_connection(|conn| {
        conn.query_row(
            "SELECT digest, files_json FROM skill_packages WHERE name = ?1",
            [&candidate.name],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())
    })?;
    let old_files: BTreeMap<String, String> = existing
        .as_ref()
        .map(|(_, text)| serde_json::from_str(text).map_err(|_| "已有 Skills 包内容损坏"))
        .transpose()?
        .unwrap_or_default();
    let changes = compare_files(&old_files, &candidate.files)?;
    let changed_files = changes.iter().map(|change| change.path.clone()).collect();
    Ok(SkillImportPreview {
        name: candidate.name.clone(),
        source: candidate.source.clone(),
        digest: candidate.digest.clone(),
        file_count: candidate.files.len(),
        compatibility: candidate.compatibility.clone(),
        existing_digest: existing.map(|(digest, _)| digest),
        changed_files,
        changes,
    })
}

fn manifest_info(
    files: &BTreeMap<String, String>,
    name: &str,
) -> Result<(String, Option<String>), String> {
    let encoded = files
        .get("SKILL.md")
        .ok_or("Skills 包需要根目录 SKILL.md")?;
    let text = String::from_utf8(STANDARD.decode(encoded).map_err(|_| "SKILL.md 编码错误")?)
        .map_err(|_| "SKILL.md 应为 UTF-8")?;
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return Err("SKILL.md 需要 name 和 description 的 YAML 元数据".into());
    }
    let mut declared_name = None;
    let mut description = None;
    let mut compatibility = None;
    let mut closed = false;
    for line in lines {
        if line.trim() == "---" {
            closed = true;
            break;
        }
        if let Some((key, value)) = line.split_once(':') {
            let value = value.trim().trim_matches('"').trim_matches('\'').to_owned();
            match key.trim() {
                "name" => declared_name = Some(value),
                "description" => description = Some(value),
                "compatibility" => compatibility = Some(value),
                _ => {}
            }
        }
    }
    if !closed || declared_name.as_deref() != Some(name) {
        return Err("SKILL.md 的 name 必须与 Skills 目录名一致".into());
    }
    let description = description
        .filter(|value| !value.is_empty() && value.len() <= 1024)
        .ok_or("SKILL.md 需要非空 description")?;
    if compatibility
        .as_deref()
        .is_some_and(|value| value.is_empty() || value.len() > 500)
    {
        return Err("SKILL.md compatibility 长度无效".into());
    }
    Ok((description, compatibility))
}

fn lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[derive(Debug)]
struct SkillOperation {
    id: String,
    package_id: String,
    tool: String,
    scope_key: String,
    target: PathBuf,
    stage: PathBuf,
    backup: PathBuf,
    old_digest: Option<String>,
    old_managed_digest: Option<String>,
    new_digest: Option<String>,
    removing: bool,
    status: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRecoveryIssue {
    pub operation_id: String,
    pub tool_id: String,
    pub scope: Scope,
    pub project_path: Option<String>,
    pub target_path: String,
    pub backup_path: String,
    pub detail: String,
    #[serde(skip)]
    pub scope_key: String,
}

impl SkillRecoveryIssue {
    fn from_operation(op: &SkillOperation, detail: String) -> Self {
        Self {
            operation_id: op.id.clone(),
            tool_id: op.tool.clone(),
            scope: if op.scope_key == "global" {
                Scope::Global
            } else {
                Scope::Project
            },
            project_path: op.scope_key.strip_prefix("project:").map(str::to_owned),
            target_path: op.target.display().to_string(),
            backup_path: op.backup.display().to_string(),
            detail,
            scope_key: op.scope_key.clone(),
        }
    }

    pub fn affects(&self, tool: &str, scope_key: &str) -> bool {
        self.tool_id == tool && (self.scope_key == "global" || self.scope_key == scope_key)
    }

    fn message(&self) -> String {
        format!(
            "{}：{}；备份保留于 {}",
            self.tool_id, self.detail, self.backup_path
        )
    }
}

fn save_operation(db: &Database, operation: &SkillOperation) -> Result<(), String> {
    db.with_connection(|conn| conn.execute("INSERT INTO skill_operations (id, package_id, tool, scope_key, target_path, stage_path, backup_path, old_digest, old_managed_digest, new_digest, removing, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![operation.id, operation.package_id, operation.tool, operation.scope_key, operation.target.display().to_string(), operation.stage.display().to_string(), operation.backup.display().to_string(), operation.old_digest, operation.old_managed_digest, operation.new_digest, operation.removing as i64, operation.status])
        .map(|_| ()).map_err(|error| error.to_string()))
}

fn clear_operation(db: &Database, id: &str) -> Result<(), String> {
    db.with_connection(|conn| {
        conn.execute("DELETE FROM skill_operations WHERE id = ?1", [id])
            .map(|_| ())
            .map_err(|error| error.to_string())
    })
}

fn mark_rollback(db: &Database, op: &SkillOperation) -> Result<(), String> {
    db.with_connection(|conn| {
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        if let Some(digest) = op.old_managed_digest.as_deref() {
            tx.execute("INSERT INTO skill_installations (package_id, tool, scope_key, target_path, digest) VALUES (?1, ?2, ?3, ?4, ?5)
                ON CONFLICT(package_id, tool, scope_key) DO UPDATE SET target_path = excluded.target_path, digest = excluded.digest",
                params![op.package_id, op.tool, op.scope_key, op.target.display().to_string(), digest])
                .map_err(|error| error.to_string())?;
        } else {
            tx.execute("DELETE FROM skill_installations WHERE package_id = ?1 AND tool = ?2 AND scope_key = ?3",
                params![op.package_id, op.tool, op.scope_key]).map_err(|error| error.to_string())?;
        }
        tx.execute("UPDATE skill_operations SET status = 'rollback' WHERE id = ?1", [&op.id])
            .map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())
    })
}

fn restore_rollback(op: &SkillOperation) -> Result<(), String> {
    let actual = on_disk(&op.target)?;
    if op.backup.exists() {
        let name = op
            .target
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or("Skills 目录名无效")?;
        if actual.is_some() || on_disk_as(&op.backup, name)? != op.old_digest {
            return Err("Skills 备份或目标已变化，保留现场以便恢复".into());
        }
        fs::rename(&op.backup, &op.target).map_err(|error| error.to_string())?;
    } else if actual != op.old_digest {
        return Err("Skills 旧目录缺失，保留恢复记录".into());
    }
    Ok(())
}

fn verify_backup(op: &SkillOperation) -> Result<(), String> {
    let name = op
        .target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("Skills 目录名无效")?;
    if on_disk_as(&op.backup, name)? != op.old_digest {
        return Err("Skills 备份内容与操作记录不符，已保留现场".into());
    }
    Ok(())
}

fn recover_locked_report(db: &Database) -> Result<Vec<SkillRecoveryIssue>, String> {
    let operations = db.with_connection(|conn| {
        let mut statement = conn.prepare("SELECT id, package_id, tool, scope_key, target_path, stage_path, backup_path, old_digest, old_managed_digest, new_digest, removing, status FROM skill_operations ORDER BY rowid").map_err(|error| error.to_string())?;
        let rows = statement.query_map([], |row| Ok(SkillOperation {
            id: row.get(0)?, package_id: row.get(1)?, tool: row.get(2)?, scope_key: row.get(3)?, target: PathBuf::from(row.get::<_, String>(4)?), stage: PathBuf::from(row.get::<_, String>(5)?), backup: PathBuf::from(row.get::<_, String>(6)?), old_digest: row.get(7)?, old_managed_digest: row.get(8)?, new_digest: row.get(9)?, removing: row.get::<_, i64>(10)? != 0, status: row.get(11)?, }))
            .map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
        Ok(rows)
    })?;
    let mut issues = Vec::new();
    for op in operations {
        let attempt = (|| {
            let parent = op.target.parent().ok_or("Skills 恢复路径无效")?;
            if op.stage.parent() != Some(parent)
                || op.backup.parent() != Some(parent)
                || op.stage.file_name().and_then(|v| v.to_str())
                    != Some(format!(".cliora-stage-{}", op.id).as_str())
                || op.backup.file_name().and_then(|v| v.to_str())
                    != Some(format!(".cliora-backup-{}", op.id).as_str())
            {
                return Err("Skills 恢复记录路径不匹配；请检查应用数据".into());
            }
            if op.status == "committed" {
                let actual = on_disk(&op.target)?;
                if actual == op.new_digest {
                    if op.backup.exists() {
                        verify_backup(&op)?;
                        fs::remove_dir_all(&op.backup).map_err(|error| error.to_string())?;
                    }
                } else if actual.is_none()
                    && !op.removing
                    && (op.backup.exists() || op.old_digest.is_none())
                {
                    mark_rollback(db, &op)?;
                    restore_rollback(&op)?;
                } else {
                    return Err(format!(
                        "Skills {} 在安装后再次变化，保留备份以便检查",
                        op.target.display()
                    ));
                }
            } else if op.status == "rollback" {
                restore_rollback(&op)?;
            } else if op.status == "prepared" {
                if op.backup.exists() {
                    verify_backup(&op)?;
                    let actual = on_disk(&op.target)?;
                    if actual.is_some() {
                        if actual != op.new_digest {
                            return Err("Skills 目录在中断后被外部修改，已保留现场".into());
                        }
                        fs::remove_dir_all(&op.target).map_err(|error| error.to_string())?;
                    }
                    fs::rename(&op.backup, &op.target).map_err(|error| error.to_string())?;
                } else {
                    let actual = on_disk(&op.target)?;
                    if op.old_digest.is_some() && actual != op.old_digest {
                        return Err("Skills 原目录已变化，无法自动恢复".into());
                    }
                    if op.old_digest.is_none() && actual.is_some() {
                        if actual != op.new_digest {
                            return Err("Skills 新目录在中断后被外部修改，已保留现场".into());
                        }
                        fs::remove_dir_all(&op.target).map_err(|error| error.to_string())?;
                    }
                }
            } else {
                return Err("Skills 恢复记录状态无效".into());
            }
            if op.stage.exists() {
                fs::remove_dir_all(&op.stage).map_err(|error| error.to_string())?;
            }
            clear_operation(db, &op.id)?;
            Ok::<(), String>(())
        })();
        if let Err(detail) = attempt {
            issues.push(SkillRecoveryIssue::from_operation(&op, detail));
        }
    }
    Ok(issues)
}

fn recover_operation_locked(db: &Database, operation_id: &str) -> Result<(), String> {
    let issues = recover_locked_report(db)?;
    issues
        .iter()
        .find(|issue| issue.operation_id == operation_id)
        .map_or(Ok(()), |issue| Err(issue.message()))
}

pub fn recover_report(db: &Database) -> Result<Vec<SkillRecoveryIssue>, String> {
    let _guard = lock().lock().map_err(|_| "Skills 恢复服务暂时不可用")?;
    recover_locked_report(db)
}

pub fn recover(db: &Database) -> Result<(), String> {
    let issues = recover_report(db)?;
    issues.first().map_or(Ok(()), |issue| Err(issue.message()))
}

fn timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| time.as_secs())
}
fn safe_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && !value.starts_with('-')
        && !value.ends_with('-')
        && !value.contains("--")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}
fn digest(files: &BTreeMap<String, String>) -> Result<String, String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(files).map_err(|error| error.to_string())?)
    ))
}
fn collect(
    root: &Path,
    dir: &Path,
    files: &mut BTreeMap<String, String>,
    bytes: &mut usize,
) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let meta = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        if meta.file_type().is_symlink() {
            return Err("Skills 包不能包含符号链接".into());
        }
        if meta.is_dir() {
            collect(root, &path, files, bytes)?;
            continue;
        }
        if !meta.is_file() {
            return Err("Skills 包只能包含普通文件".into());
        }
        if files.len() >= MAX_FILES {
            return Err("Skills 包文件数量超出上限".into());
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "Skills 文件不在来源目录中")?
            .components()
            .map(|part| part.as_os_str().to_str().ok_or("Skills 文件名无法识别"))
            .collect::<Result<Vec<_>, _>>()?
            .join("/");
        if meta.len() > (MAX_BYTES - *bytes) as u64 {
            return Err("Skills 包超过 12 MiB".into());
        }
        let contents = fs::read(path).map_err(|error| error.to_string())?;
        *bytes += contents.len();
        if *bytes > MAX_BYTES {
            return Err("Skills 包超过 12 MiB".into());
        }
        files.insert(relative, STANDARD.encode(contents));
    }
    Ok(())
}
fn snapshot(
    path: &Path,
) -> Result<
    (
        String,
        String,
        Option<String>,
        BTreeMap<String, String>,
        String,
    ),
    String,
> {
    if !path.is_dir() || path.is_symlink() {
        return Err("请选择普通 Skills 目录".into());
    }
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("Skills 目录名无效")?
        .to_owned();
    if !safe_name(&name) {
        return Err("Skills 目录名需使用小写字母、数字和单个连字符".into());
    }
    let mut files = BTreeMap::new();
    collect(path, path, &mut files, &mut 0)?;
    let (description, compatibility) = manifest_info(&files, &name)?;
    let checksum = digest(&files)?;
    Ok((name, description, compatibility, files, checksum))
}

fn local_candidate(source: &str) -> Result<Candidate, String> {
    let path = Path::new(source)
        .canonicalize()
        .map_err(|_| "Skills 来源目录不存在")?;
    let (name, description, compatibility, files, checksum) = snapshot(&path)?;
    Ok(Candidate {
        name,
        description,
        compatibility,
        source: path.display().to_string(),
        files,
        digest: checksum,
    })
}
pub fn preview_local(db: &Database, source: &str) -> Result<SkillImportPreview, String> {
    preview_candidate(db, &local_candidate(source)?)
}
pub fn import_local(
    db: &Database,
    source: &str,
    expected_new: Option<&str>,
    expected_existing: Option<&str>,
) -> Result<SkillPackage, String> {
    save_candidate(
        db,
        local_candidate(source)?,
        expected_new,
        expected_existing,
    )
}
fn save_candidate(
    db: &Database,
    candidate: Candidate,
    expected_new: Option<&str>,
    expected_existing: Option<&str>,
) -> Result<SkillPackage, String> {
    let _guard = lock().lock().map_err(|_| "Skills 写入服务暂时不可用")?;
    let preview = preview_candidate(db, &candidate)?;
    if preview.existing_digest.as_deref() != Some(&candidate.digest)
        && preview.existing_digest.is_some()
        && (expected_new != Some(candidate.digest.as_str())
            || expected_existing != preview.existing_digest.as_deref())
    {
        return Err("已有同名 Skills 包且内容不同；请比较变更文件后明确更新".into());
    }
    let Candidate {
        name,
        description,
        compatibility,
        source,
        files,
        digest: checksum,
    } = candidate;
    let id = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT id FROM skill_packages WHERE name = ?1",
                [&name],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())
        })?
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let updated_at = timestamp();
    db.with_connection(|conn| {
        let changed = conn.execute("INSERT INTO skill_packages (id, name, description, source, digest, files_json, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(id) DO UPDATE SET description = excluded.description, source = excluded.source, digest = excluded.digest, files_json = excluded.files_json, updated_at = excluded.updated_at
            WHERE skill_packages.digest = ?8",
            params![id, name, description, source, checksum, serde_json::to_string(&files).map_err(|error| error.to_string())?, updated_at as i64, preview.existing_digest.as_deref().unwrap_or("")])
            .map_err(|error| error.to_string())?;
        if changed != 1 { return Err("同名 Skills 包在预览后变化，请重新比较".into()); }
        Ok(())
    })?;
    Ok(SkillPackage {
        id,
        name,
        description,
        compatibility,
        source,
        digest: checksum,
        file_count: files.len(),
        updated_at,
    })
}

fn download_zip(source: &str) -> Result<Vec<u8>, String> {
    let parsed = url::Url::parse(source).map_err(|_| "来源 URL 无效")?;
    if parsed.scheme() != "https" {
        return Err("远程 Skills 来源需要 HTTPS ZIP 地址".into());
    }
    let client = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?;
    let mut response = client
        .get(parsed)
        .send()
        .map_err(|error| format!("无法获取 Skills 归档：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("Skills 归档请求返回 {}", response.status()));
    }
    let mut bytes = Vec::new();
    response
        .by_ref()
        .take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err("Skills 归档下载超过 12 MiB".into());
    }
    Ok(bytes)
}
pub fn preview_https_zip(
    db: &Database,
    source: &str,
    subdirectory: Option<&str>,
) -> Result<SkillImportPreview, String> {
    preview_candidate(
        db,
        &zip_candidate(source, subdirectory, download_zip(source)?)?,
    )
}
pub fn import_https_zip(
    db: &Database,
    source: &str,
    subdirectory: Option<&str>,
    expected_new: Option<&str>,
    expected_existing: Option<&str>,
) -> Result<SkillPackage, String> {
    save_candidate(
        db,
        zip_candidate(source, subdirectory, download_zip(source)?)?,
        expected_new,
        expected_existing,
    )
}
#[cfg(test)]
fn import_zip_bytes(
    db: &Database,
    source: &str,
    subdirectory: Option<&str>,
    bytes: Vec<u8>,
) -> Result<SkillPackage, String> {
    save_candidate(db, zip_candidate(source, subdirectory, bytes)?, None, None)
}
fn zip_candidate(
    source: &str,
    subdirectory: Option<&str>,
    bytes: Vec<u8>,
) -> Result<Candidate, String> {
    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "来源不是可读取的 ZIP 归档")?;
    if archive.len() > MAX_FILES * 4 {
        return Err("Skills 归档条目过多".into());
    }
    let mut archive_files = BTreeMap::<String, Vec<u8>>::new();
    let mut total = 0_usize;
    for index in 0..archive.len() {
        let mut item = archive.by_index(index).map_err(|error| error.to_string())?;
        let path = item.enclosed_name().ok_or("ZIP 包含越界路径")?;
        let relative = path
            .components()
            .map(|part| part.as_os_str().to_str().ok_or("ZIP 文件名无法识别"))
            .collect::<Result<Vec<_>, _>>()?
            .join("/");
        if item
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("ZIP 包含符号链接".into());
        }
        if item.is_dir() {
            continue;
        }
        if !item.is_file() {
            return Err("ZIP 包只能包含普通文件".into());
        }
        if item.size() > (MAX_BYTES - total) as u64 {
            return Err("Skills 归档解压超过 12 MiB".into());
        }
        let mut contents = Vec::new();
        item.by_ref()
            .take((MAX_BYTES - total + 1) as u64)
            .read_to_end(&mut contents)
            .map_err(|error| error.to_string())?;
        total += contents.len();
        if total > MAX_BYTES {
            return Err("Skills 归档解压超过 12 MiB".into());
        }
        if archive_files.insert(relative, contents).is_some() {
            return Err("ZIP 包含重复文件路径".into());
        }
    }
    let prefix = if let Some(chosen) = subdirectory.filter(|value| !value.trim().is_empty()) {
        let chosen = chosen.trim_matches('/');
        if Path::new(chosen)
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
        {
            return Err("Skills 子目录路径无效".into());
        }
        chosen.to_owned()
    } else {
        let candidates: Vec<_> = archive_files
            .keys()
            .filter_map(|path| {
                path.strip_suffix("/SKILL.md").or_else(|| {
                    if path == "SKILL.md" {
                        Some("")
                    } else {
                        None
                    }
                })
            })
            .collect();
        if candidates.len() != 1 {
            return Err("归档中找到零个或多个 SKILL.md；请指定 Skills 子目录".into());
        }
        candidates[0].to_owned()
    };
    let name = prefix
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .or_else(|| Path::new(source).file_stem().and_then(|stem| stem.to_str()))
        .ok_or("Skills 名称无法识别")?
        .to_owned();
    if !safe_name(&name) {
        return Err("Skills 名称需使用小写字母、数字和单个连字符".into());
    }
    let mut files = BTreeMap::new();
    for (path, contents) in archive_files {
        let relative = if prefix.is_empty() {
            path.as_str()
        } else if let Some(rest) = path.strip_prefix(&format!("{prefix}/")) {
            rest
        } else {
            continue;
        };
        if files.len() >= MAX_FILES {
            return Err("Skills 包文件数量超出上限".into());
        }
        if !relative.is_empty() {
            files.insert(relative.to_owned(), STANDARD.encode(contents));
        }
    }
    let (description, compatibility) = manifest_info(&files, &name)?;
    let checksum = digest(&files)?;
    let source_label = if prefix.is_empty() {
        source.to_owned()
    } else {
        format!("{source}#{prefix}")
    };
    Ok(Candidate {
        name,
        description,
        compatibility,
        source: source_label,
        files,
        digest: checksum,
    })
}
pub fn list(db: &Database) -> Result<Vec<SkillPackage>, String> {
    let _ = recover_report(db)?;
    db.with_connection(|conn| {
        let mut statement = conn.prepare("SELECT id, name, description, source, digest, files_json, updated_at FROM skill_packages ORDER BY name COLLATE NOCASE")
            .map_err(|error| error.to_string())?;
        let rows = statement.query_map([], |row| {
            let json: String = row.get(5)?;
            let file_count = serde_json::from_str::<BTreeMap<String, String>>(&json).map_or(0, |files| files.len());
            let name: String = row.get(1)?;
            let compatibility = serde_json::from_str::<BTreeMap<String, String>>(&json).ok()
                .and_then(|files| manifest_info(&files, &name).ok()).and_then(|(_, compatibility)| compatibility);
            Ok(SkillPackage { id: row.get(0)?, name, description: row.get(2)?, compatibility, source: row.get(3)?, digest: row.get(4)?, file_count, updated_at: row.get::<_, i64>(6)?.max(0) as u64 })
        }).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
        Ok(rows)
    })
}
fn package(db: &Database, id: &str) -> Result<(SkillPackage, BTreeMap<String, String>), String> {
    db.with_connection(|conn| {
        let row: Option<(String, String, String, String, String, String, i64)> = conn.query_row(
            "SELECT id, name, description, source, digest, files_json, updated_at FROM skill_packages WHERE id = ?1", [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)))
            .optional().map_err(|error| error.to_string())?;
        let (id, name, description, source, checksum, json, updated_at) = row.ok_or("Skills 包不存在")?;
        let files: BTreeMap<String, String> = serde_json::from_str(&json).map_err(|_| "Skills 包内容损坏")?;
        if digest(&files)? != checksum || !files.contains_key("SKILL.md") { return Err("Skills 包完整性校验失败".into()); }
        let (_, compatibility) = manifest_info(&files, &name)?;
        let package = SkillPackage { id, name, description, compatibility, source, digest: checksum, file_count: files.len(), updated_at: updated_at.max(0) as u64 };
        Ok((package, files))
    })
}
fn target(
    registry: &Registry,
    home: &Path,
    tool: &str,
    scope: Scope,
    project_path: Option<&str>,
    name: &str,
) -> Result<(PathBuf, String), String> {
    let adapter = registry.get(tool).ok_or("此 CLI 尚无注册适配器")?;
    let project = if scope == Scope::Project {
        Some(projects::checked_directory(
            project_path.ok_or("请选择项目目录")?,
        )?)
    } else {
        None
    };
    let root = adapter
        .skill_root(scope, home, project.as_deref())
        .ok_or("此 CLI 在当前范围没有已确认的原生 Skills 目录")?;
    let key = project.as_ref().map_or_else(
        || "global".to_owned(),
        |path| format!("project:{}", path.display()),
    );
    Ok((root.join(name), key))
}
fn on_disk(path: &Path) -> Result<Option<String>, String> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("Skills 目录名无效")?;
    on_disk_as(path, name)
}
fn on_disk_as(path: &Path, name: &str) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    if !path.is_dir() || path.is_symlink() {
        return Err("Skills 目录不是普通目录".into());
    }
    let mut files = BTreeMap::new();
    collect(path, path, &mut files, &mut 0)?;
    manifest_info(&files, name)?;
    Ok(Some(digest(&files)?))
}

fn target_token(
    package: &SkillPackage,
    tool: &str,
    scope_key: &str,
    path: &Path,
    actual: Option<&str>,
    managed: Option<&str>,
) -> Result<String, String> {
    let bound = serde_json::to_vec(&(
        package.id.as_str(),
        package.digest.as_str(),
        tool,
        scope_key,
        path.to_string_lossy(),
        actual,
        managed,
    ))
    .map_err(|error| error.to_string())?;
    Ok(format!("{:x}", Sha256::digest(bound)))
}

pub fn scan_native(
    db: &Database,
    registry: &Registry,
    home: &Path,
    tool: &str,
    scope: Scope,
    project_path: Option<&str>,
) -> Result<Vec<NativeSkillEntry>, String> {
    let _ = recover_report(db)?;
    let (placeholder, scope_key) = target(registry, home, tool, scope, project_path, "scan")?;
    let root = placeholder.parent().ok_or("Skills 原生目录无效")?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || !entry.path().is_dir() {
            continue;
        }
        if entries.len() >= 128 {
            return Err("原生 Skills 目录超过 128 个，请缩小管理范围".into());
        }
        let path = entry.path();
        let inspected = snapshot(&path);
        let (checksum, detail) = match inspected {
            Ok((_, description, _, _, checksum)) => (Some(checksum), description),
            Err(error) => (None, error),
        };
        let package_id: Option<String> = db.with_connection(|conn| {
            conn.query_row(
                "SELECT id FROM skill_packages WHERE name = ?1",
                [&name],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())
        })?;
        let managed: Option<String> = if let Some(id) = package_id.as_deref() {
            db.with_connection(|conn| conn.query_row("SELECT digest FROM skill_installations WHERE package_id = ?1 AND tool = ?2 AND scope_key = ?3 AND target_path = ?4", params![id, tool, scope_key, path.display().to_string()], |row| row.get(0)).optional().map_err(|error| error.to_string()))?
        } else {
            None
        };
        let state = if checksum.is_none() {
            "unreadable"
        } else if managed.as_deref() == checksum.as_deref() {
            "managed"
        } else {
            "external"
        };
        entries.push(NativeSkillEntry {
            name,
            path: path.display().to_string(),
            digest: checksum,
            state,
            detail,
            package_id,
        });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

pub fn preview_target(
    db: &Database,
    registry: &Registry,
    home: &Path,
    package_id: &str,
    tool: &str,
    scope: Scope,
    project_path: Option<&str>,
) -> Result<SkillTargetPreview, String> {
    let issues = recover_report(db)?;
    let (package, files) = package(db, package_id)?;
    let (path, scope_key) = target(registry, home, tool, scope, project_path, &package.name)?;
    if let Some(issue) = issues.iter().find(|issue| issue.affects(tool, &scope_key)) {
        return Err(issue.message());
    }
    let old_files = if path.exists() {
        snapshot(&path)?.3
    } else {
        BTreeMap::new()
    };
    let existing_digest = if old_files.is_empty() {
        None
    } else {
        Some(digest(&old_files)?)
    };
    let managed: Option<String> = db.with_connection(|conn| conn.query_row("SELECT digest FROM skill_installations WHERE package_id = ?1 AND tool = ?2 AND scope_key = ?3 AND target_path = ?4", params![package_id, tool, scope_key, path.display().to_string()], |row| row.get(0)).optional().map_err(|error| error.to_string()))?;
    let conflict = existing_digest.is_some() && managed.as_deref() != existing_digest.as_deref();
    let status = if conflict { "conflict" } else { "ready" };
    let detail = if conflict {
        "同名原生 Skills 未受当前包管理，或安装后被外部修改；请比较后确认接管"
    } else if existing_digest.is_some() {
        "将更新当前原生 Skills"
    } else {
        "将安装到 CLI 原生目录"
    };
    let token = target_token(
        &package,
        tool,
        &scope_key,
        &path,
        existing_digest.as_deref(),
        managed.as_deref(),
    )?;
    Ok(SkillTargetPreview {
        path: path.display().to_string(),
        status,
        detail: detail.into(),
        preview_token: Some(token),
        existing_digest,
        package_digest: package.digest,
        changes: compare_files(&old_files, &files)?,
    })
}
pub fn installations(
    db: &Database,
    registry: &Registry,
    home: &Path,
    package_id: &str,
) -> Result<Vec<SkillInstallation>, String> {
    let _ = recover_report(db)?;
    let (package, _) = package(db, package_id)?;
    db.with_connection(|conn| {
        let mut statement = conn.prepare("SELECT tool, scope_key, target_path, digest FROM skill_installations WHERE package_id = ?1 ORDER BY tool, scope_key")
            .map_err(|error| error.to_string())?;
        let records = statement.query_map([package_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?)))
            .map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
        Ok(records.into_iter().map(|(tool_id, scope_key, target_path, checksum)| {
            let scope = if scope_key == "global" { Scope::Global } else { Scope::Project };
            let project_path = scope_key.strip_prefix("project:").map(str::to_owned);
            let expected = target(registry, home, &tool_id, scope, project_path.as_deref(), &package.name);
            let state = if expected.as_ref().is_ok_and(|(path, _)| path.to_string_lossy() == target_path) {
                match on_disk(Path::new(&target_path)) { Ok(Some(actual)) if actual == checksum => if checksum == package.digest { "current" } else { "update_available" }, Ok(None) => "missing", _ => "conflict" }
            } else { "unavailable" };
            SkillInstallation { package_id: package_id.into(), tool_id, scope, project_path, target_path, digest: checksum, state }
        }).collect())
    })
}
pub fn install(
    db: &Database,
    registry: &Registry,
    home: &Path,
    package_id: &str,
    tool_id: &str,
    scope: Scope,
    project_path: Option<&str>,
) -> SkillTargetResult {
    install_confirmed(
        db,
        registry,
        home,
        package_id,
        tool_id,
        scope,
        project_path,
        None,
        false,
    )
}
pub fn install_confirmed(
    db: &Database,
    registry: &Registry,
    home: &Path,
    package_id: &str,
    tool_id: &str,
    scope: Scope,
    project_path: Option<&str>,
    preview_token: Option<&str>,
    allow_takeover: bool,
) -> SkillTargetResult {
    operate(
        db,
        registry,
        home,
        package_id,
        tool_id,
        scope,
        project_path,
        false,
        preview_token,
        allow_takeover,
    )
}
pub fn remove(
    db: &Database,
    registry: &Registry,
    home: &Path,
    package_id: &str,
    tool_id: &str,
    scope: Scope,
    project_path: Option<&str>,
) -> SkillTargetResult {
    operate(
        db,
        registry,
        home,
        package_id,
        tool_id,
        scope,
        project_path,
        true,
        None,
        false,
    )
}
fn operate(
    db: &Database,
    registry: &Registry,
    home: &Path,
    package_id: &str,
    tool_id: &str,
    scope: Scope,
    project_path: Option<&str>,
    removing: bool,
    preview_token: Option<&str>,
    allow_takeover: bool,
) -> SkillTargetResult {
    let mut result = SkillTargetResult {
        tool_id: tool_id.into(),
        scope,
        project_path: project_path.map(str::to_owned),
        path: None,
        status: "failed",
        detail: String::new(),
    };
    let attempt = (|| {
        let _guard = lock().lock().map_err(|_| "Skills 写入服务暂时不可用")?;
        let issues = recover_locked_report(db)?;
        let (package, files) = package(db, package_id)?;
        let (path, key) = target(registry, home, tool_id, scope, project_path, &package.name)?;
        if let Some(issue) = issues.iter().find(|issue| issue.affects(tool_id, &key)) {
            return Err(issue.message());
        }
        result.path = Some(path.display().to_string());
        let managed: Option<(String, String)> = db.with_connection(|conn| conn.query_row(
            "SELECT target_path, digest FROM skill_installations WHERE package_id = ?1 AND tool = ?2 AND scope_key = ?3",
            params![package_id, tool_id, key], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional().map_err(|error| error.to_string()))?;
        let actual = on_disk(&path)?;
        let expected_token = target_token(
            &package,
            tool_id,
            &key,
            &path,
            actual.as_deref(),
            managed.as_ref().map(|(_, digest)| digest.as_str()),
        )?;
        if preview_token.is_some_and(|token| token != expected_token) {
            return Err("Skills 包、目标或原生目录在预览后变化；请重新预览".into());
        }
        match (&managed, &actual) {
            (None, Some(_))
                if !allow_takeover || preview_token != Some(expected_token.as_str()) =>
            {
                return Err("目标已有同名 Skills；请预览差异并确认接管".into())
            }
            (Some((old, _)), _) if old != &path.display().to_string() => {
                return Err("已管理的 Skills 路径已变化，请检查旧目录".into())
            }
            (Some((_, old)), Some(actual))
                if old != actual
                    && (!allow_takeover || preview_token != Some(expected_token.as_str())) =>
            {
                return Err("Skills 目录已被外部修改；请预览差异并确认接管".into())
            }
            (Some(_), None) if removing => return Err("Skills 目录已在外部移除".into()),
            _ => {}
        }
        if removing && managed.is_none() {
            return Err("此目标没有由 Cliora 安装的 Skills".into());
        }
        if !removing
            && managed
                .as_ref()
                .is_some_and(|(_, digest)| digest == &package.digest)
            && actual.as_ref() == Some(&package.digest)
        {
            return Ok("already_current");
        }
        let parent = path.parent().ok_or("Skills 目标目录无效")?;
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let token = Uuid::new_v4();
        let stage = parent.join(format!(".cliora-stage-{token}"));
        let backup = parent.join(format!(".cliora-backup-{token}"));
        let had_old = actual.is_some();
        let operation = SkillOperation {
            id: token.to_string(),
            package_id: package_id.into(),
            tool: tool_id.into(),
            scope_key: key.clone(),
            target: path.clone(),
            stage: stage.clone(),
            backup: backup.clone(),
            old_digest: actual.clone(),
            old_managed_digest: managed.as_ref().map(|(_, digest)| digest.clone()),
            new_digest: if removing {
                None
            } else {
                Some(package.digest.clone())
            },
            removing,
            status: "prepared".into(),
        };
        save_operation(db, &operation)?;
        if !removing {
            if let Err(error) = fs::create_dir(&stage) {
                let recovery = recover_operation_locked(db, &operation.id);
                return Err(format!(
                    "无法准备 Skills：{error}；{}",
                    recovery.map_or_else(|error| error, |_| "已清理临时目录".into())
                ));
            }
            let staged = (|| {
                for (relative, encoded) in &files {
                    if Path::new(relative)
                        .components()
                        .any(|part| !matches!(part, std::path::Component::Normal(_)))
                    {
                        return Err("Skills 包文件路径无效".into());
                    }
                    let destination = stage.join(relative);
                    fs::create_dir_all(destination.parent().ok_or("Skills 文件路径无效")?)
                        .map_err(|error| error.to_string())?;
                    fs::write(
                        destination,
                        STANDARD.decode(encoded).map_err(|_| "Skills 包文件损坏")?,
                    )
                    .map_err(|error| error.to_string())?;
                }
                Ok::<(), String>(())
            })();
            if let Err(error) = staged {
                let recovery = recover_operation_locked(db, &operation.id);
                return Err(format!(
                    "{error}；{}",
                    recovery.map_or_else(|error| error, |_| "已清理临时目录".into())
                ));
            }
        }
        if had_old {
            if let Err(error) = fs::rename(&path, &backup) {
                let _ = recover_operation_locked(db, &operation.id);
                return Err(format!("无法备份现有 Skills：{error}"));
            }
        }
        if !removing {
            if let Err(error) = fs::rename(&stage, &path) {
                let _ = recover_operation_locked(db, &operation.id);
                return Err(format!("无法安装 Skills：{error}"));
            }
        }
        let saved = db.with_connection(|conn| {
            let tx = conn.transaction().map_err(|error| error.to_string())?;
            if removing { tx.execute("DELETE FROM skill_installations WHERE package_id = ?1 AND tool = ?2 AND scope_key = ?3", params![package_id, tool_id, key]) }
            else { tx.execute("INSERT INTO skill_installations (package_id, tool, scope_key, target_path, digest) VALUES (?1, ?2, ?3, ?4, ?5)
                ON CONFLICT(package_id, tool, scope_key) DO UPDATE SET target_path = excluded.target_path, digest = excluded.digest",
                params![package_id, tool_id, key, path.display().to_string(), package.digest]) }
                .map_err(|error| error.to_string())?;
            tx.execute("UPDATE skill_operations SET status = 'committed' WHERE id = ?1", [&operation.id]).map_err(|error| error.to_string())?;
            tx.commit().map_err(|error| error.to_string())
        });
        if let Err(error) = saved {
            let recovery = recover_operation_locked(db, &operation.id);
            return Err(format!(
                "Skills 记录失败：{error}；恢复结果：{}",
                recovery.map_or_else(|error| error, |_| "已恢复旧目录".into())
            ));
        }
        recover_operation_locked(db, &operation.id)?;
        Ok(if removing { "removed" } else { "installed" })
    })();
    match attempt {
        Ok(status) => {
            result.status = status;
            result.detail = "完成".into();
        }
        Err(error) => result.detail = error,
    }
    result
}

#[cfg(test)]
#[path = "../../../tests/resources/skills.rs"]
mod tests;
