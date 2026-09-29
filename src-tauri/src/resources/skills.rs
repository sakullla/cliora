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
    let changed_files: Vec<String> = old_files
        .keys()
        .chain(candidate.files.keys())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .filter(|name| old_files.get(*name) != candidate.files.get(*name))
        .cloned()
        .collect();
    let changes = changed_files
        .iter()
        .map(|path| {
            let before = old_files
                .get(path)
                .map(|value| STANDARD.decode(value).map_err(|_| "已有 Skills 包文件损坏"))
                .transpose()?;
            let after = candidate
                .files
                .get(path)
                .map(|value| STANDARD.decode(value).map_err(|_| "新 Skills 包文件损坏"))
                .transpose()?;
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
            let (before_text, before_size, before_digest) = summary(before.as_ref());
            let (after_text, after_size, after_digest) = summary(after.as_ref());
            Ok::<_, String>(SkillFileChange {
                path: path.clone(),
                before: before_text,
                after: after_text,
                before_size,
                after_size,
                before_digest,
                after_digest,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
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
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(snapshot(path)?.4))
}
pub fn installations(
    db: &Database,
    registry: &Registry,
    home: &Path,
    package_id: &str,
) -> Result<Vec<SkillInstallation>, String> {
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
    operate(
        db,
        registry,
        home,
        package_id,
        tool_id,
        scope,
        project_path,
        false,
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
        let (package, files) = package(db, package_id)?;
        let (path, key) = target(registry, home, tool_id, scope, project_path, &package.name)?;
        result.path = Some(path.display().to_string());
        let managed: Option<(String, String)> = db.with_connection(|conn| conn.query_row(
            "SELECT target_path, digest FROM skill_installations WHERE package_id = ?1 AND tool = ?2 AND scope_key = ?3",
            params![package_id, tool_id, key], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional().map_err(|error| error.to_string()))?;
        let actual = on_disk(&path)?;
        match (&managed, &actual) {
            (None, Some(_)) => return Err("目标已有同名 Skills；未覆盖非本应用安装的目录".into()),
            (Some((old, _)), _) if old != &path.display().to_string() => {
                return Err("已管理的 Skills 路径已变化，请检查旧目录".into())
            }
            (Some((_, old)), Some(actual)) if old != actual => {
                return Err("Skills 目录已被外部修改；未覆盖".into())
            }
            (Some(_), None) if removing => return Err("Skills 目录已在外部移除".into()),
            _ => {}
        }
        if removing && managed.is_none() {
            return Err("此目标没有由 Cliora 安装的 Skills".into());
        }
        if !removing && actual.as_ref() == Some(&package.digest) {
            return Ok("already_current");
        }
        let parent = path.parent().ok_or("Skills 目标目录无效")?;
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let token = Uuid::new_v4();
        let stage = parent.join(format!(".cliora-stage-{token}"));
        let backup = parent.join(format!(".cliora-backup-{token}"));
        if !removing {
            fs::create_dir(&stage).map_err(|error| error.to_string())?;
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
                let _ = fs::remove_dir_all(&stage);
                return Err(error);
            }
        }
        let had_old = actual.is_some();
        if had_old {
            if let Err(error) = fs::rename(&path, &backup) {
                let _ = fs::remove_dir_all(&stage);
                return Err(format!("无法备份现有 Skills：{error}"));
            }
        }
        if !removing {
            if let Err(error) = fs::rename(&stage, &path) {
                if had_old {
                    let _ = fs::rename(&backup, &path);
                }
                let _ = fs::remove_dir_all(&stage);
                return Err(format!("无法安装 Skills：{error}"));
            }
        }
        let saved = db.with_connection(|conn| {
            if removing { conn.execute("DELETE FROM skill_installations WHERE package_id = ?1 AND tool = ?2 AND scope_key = ?3", params![package_id, tool_id, key]) }
            else { conn.execute("INSERT INTO skill_installations (package_id, tool, scope_key, target_path, digest) VALUES (?1, ?2, ?3, ?4, ?5)
                ON CONFLICT(package_id, tool, scope_key) DO UPDATE SET target_path = excluded.target_path, digest = excluded.digest",
                params![package_id, tool_id, key, path.display().to_string(), package.digest]) }
                .map_err(|error| error.to_string())?;
            Ok(())
        });
        if let Err(error) = saved {
            if !removing {
                let _ = fs::remove_dir_all(&path);
            }
            if had_old {
                let _ = fs::rename(&backup, &path);
            }
            return Err(format!("Skills 记录失败，尝试恢复原目录：{error}"));
        }
        if had_old {
            let _ = fs::remove_dir_all(backup);
        }
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
