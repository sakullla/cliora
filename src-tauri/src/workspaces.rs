//! Business projects organize repositories. Native `projects` retain their directory semantics.
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};

use crate::database::Database;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const MAX_REVISION: u64 = 9_007_199_254_740_991;
const MAX_MANIFEST: u64 = 8 * 1024 * 1024;
const MAX_SCAN: usize = 50_000;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManifestLocation {
    pub host_id: String,
    pub path: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManifestRepository {
    pub id: String,
    pub name: String,
    pub locations: Vec<ManifestLocation>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub schema_version: u32,
    pub workspace_id: String,
    pub name: String,
    pub revision: u64,
    pub repositories: Vec<ManifestRepository>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceLocation {
    pub id: String,
    pub host_id: String,
    pub path: Option<String>,
    pub project_id: Option<String>,
    pub target_id: Option<String>,
    pub available: bool,
    pub kind: String,
    pub reason: Option<String>,
    pub worktrees: Vec<crate::git_context::Worktree>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRepository {
    pub id: String,
    pub name: String,
    pub favorite: bool,
    pub locations: Vec<WorkspaceLocation>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub revision: u64,
    pub manifest_path: Option<String>,
    pub manifest_revision: Option<u64>,
    pub error: Option<String>,
    pub repositories: Vec<WorkspaceRepository>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionContext {
    pub session_id: String,
    pub workspace_id: String,
    pub repository_id: String,
    pub host_id: String,
    pub directory: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub reason: Option<String>,
    pub common_directory: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub candidates: Vec<Candidate>,
    pub cancelled: bool,
    pub partial: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberResult {
    pub path: String,
    pub repository_id: Option<String>,
    pub error: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestPreview {
    pub manifest: Manifest,
    pub path: String,
    pub digest: String,
    pub conflict: bool,
}

fn sql(error: rusqlite::Error) -> String {
    error.to_string()
}
fn text(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| "目录名称无法用当前系统文字编码表示".into())
}
fn name(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 160 || value.chars().any(char::is_control) {
        return Err("名称需为 1 至 160 个非控制字符".into());
    }
    Ok(value.into())
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn private_file(file: &File) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    let _ = file;
    Ok(())
}
struct ManifestLock(File);
impl Drop for ManifestLock {
    fn drop(&mut self) {
        // Unlock explicitly: a concurrent fork may temporarily inherit the open file
        // description, so closing only our descriptor need not release its flock yet.
        let _ = self.0.unlock();
    }
}
/// Another window or sibling app (such as Twiglane) holding the same manifest lock.
pub(crate) const MANIFEST_BUSY: &str = "项目清单正在其他窗口更新，请稍后重试";
fn lock_file(path: &Path) -> Result<ManifestLock, String> {
    lock_file_with(path, false)
}
fn lock_file_with(path: &Path, wait: bool) -> Result<ManifestLock, String> {
    let mut lock_name = path.as_os_str().to_os_string();
    lock_name.push(".lock");
    let lock_path = PathBuf::from(lock_name);
    if fs::symlink_metadata(&lock_path).is_ok_and(|metadata| !metadata.file_type().is_file()) {
        return Err("项目清单锁不是普通文件，未打开".into());
    }
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock_path)
        .map_err(|e| format!("无法锁定项目清单：{e}"))?;
    private_file(&file)?;
    if wait {
        return file.lock().map(|()| ManifestLock(file)).map_err(|error| format!("项目清单锁定失败：{error}"));
    }
    match file.try_lock() {
        Ok(()) => Ok(ManifestLock(file)),
        Err(std::fs::TryLockError::WouldBlock) => Err(MANIFEST_BUSY.into()),
        Err(std::fs::TryLockError::Error(error)) => Err(format!("项目清单锁定失败：{error}")),
    }
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("文件没有父目录")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    private_file(temp.as_file())?;
    temp.write_all(bytes).map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| e.error.to_string())?;
    Ok(())
}
/// Shared only between local products; never export this token as a credential.
/// The token marks path provenance, it does not authorize filesystem access.
pub fn local_host_id() -> Result<String, String> {
    let root = dirs::data_local_dir()
        .ok_or("无法确定本机数据目录")?
        .join("sakullla")
        .join("workspace-identity");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    host_id_at(&root.join("host-id"))
}
/// The identity is written once, atomically, so reading it needs no lock: concurrent windows
/// and sibling apps sharing this directory can never make an ordinary list fail. Only the
/// first creation waits for the lock, then re-reads in case another process won the race.
fn host_id_at(path: &Path) -> Result<String, String> {
    if let Some(id) = read_host_id(path)? {
        return Ok(id);
    }
    let _lock = lock_file_with(path, true)?;
    if let Some(id) = read_host_id(path)? {
        return Ok(id);
    }
    let id = Uuid::new_v4().to_string();
    atomic_write(path, id.as_bytes())?;
    Ok(id)
}
fn read_host_id(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(value) => {
            let value = value.trim();
            Uuid::parse_str(value).map_err(|_| "本机项目身份文件损坏，原文件已保留")?;
            Ok(Some(value.into()))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}
/// Cross-platform location-hint syntax shared with portable organization data.
/// This does not authorize local use: callers still require host provenance,
/// native Path::is_absolute/canonicalization and Git verification before launch.
pub(crate) fn absolute_location_path(path: &str) -> bool {
    fn drive(path: &str) -> bool {
        let bytes = path.as_bytes();
        bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'/' | b'\\')
    }
    fn unc(tail: &str) -> bool {
        let mut parts = tail.split(['/', '\\']);
        let server = parts.next().unwrap_or_default();
        let share = parts.next().unwrap_or_default();
        let valid = |value: &str| {
            !value.is_empty() && !matches!(value, "." | ".." | "?") && !value.contains(':')
        };
        valid(server) && valid(share)
    }
    // Rust's Windows canonicalize returns these extended disk path forms.
    if let Some(tail) = path.strip_prefix(r"\\?\") {
        return tail
            .strip_prefix(r"UNC\")
            .map(unc)
            .unwrap_or_else(|| drive(tail));
    }
    if let Some(tail) = path.strip_prefix(r"\\").or_else(|| path.strip_prefix("//")) {
        return unc(tail);
    }
    path.starts_with('/') || drive(path)
}

pub fn validate_manifest(value: &Manifest) -> Result<(), String> {
    if value.schema_version != 1 {
        return Err("项目清单版本不受支持，请更新应用；原文件已保留".into());
    }
    Uuid::parse_str(&value.workspace_id).map_err(|_| "项目 ID 无效")?;
    name(&value.name)?;
    if value.revision == 0 || value.revision > MAX_REVISION {
        return Err("项目清单版本号无效".into());
    }
    let mut ids = HashSet::new();
    let mut positions = HashSet::new();
    for repo in &value.repositories {
        Uuid::parse_str(&repo.id).map_err(|_| "仓库 ID 无效")?;
        name(&repo.name)?;
        if !ids.insert(&repo.id) {
            return Err("项目清单含重复仓库 ID".into());
        }
        for location in &repo.locations {
            Uuid::parse_str(&location.host_id).map_err(|_| "工作位置的主机 ID 无效")?;
            if location.path.is_empty()
                || location.path.chars().any(char::is_control)
                || location.path.len() > 16_384
            {
                return Err("工作位置路径无效".into());
            }
            // Foreign-platform absolute hints are valid data, never implicitly local paths.
            if !absolute_location_path(&location.path) {
                return Err("工作位置必须为完整绝对路径".into());
            }
            if !positions.insert((&location.host_id, &location.path)) {
                return Err("项目清单含重复工作位置".into());
            }
        }
    }
    Ok(())
}
fn read_manifest(path: &Path) -> Result<(Manifest, String), String> {
    if fs::symlink_metadata(path).is_ok_and(|metadata| !metadata.file_type().is_file()) {
        return Err("项目清单来源已变化，需重新选择普通文件".into());
    }
    let mut file = File::open(path).map_err(|e| format!("项目清单无法读取：{e}"))?;
    if file.metadata().map_err(|e| e.to_string())?.len() > MAX_MANIFEST {
        return Err("项目清单过大，未读取或覆盖".into());
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_MANIFEST + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_MANIFEST {
        return Err("项目清单过大，未读取或覆盖".into());
    }
    let value: Manifest =
        serde_json::from_slice(&bytes).map_err(|e| format!("项目清单格式无效：{e}"))?;
    validate_manifest(&value)?;
    Ok((value, digest(&bytes)))
}
/// Seeds exact legacy identities, without probing or modifying any source directory.
pub fn seed_legacy(db: &Database, host: &str) -> Result<(), String> {
    let (pending, existing) = db.with_connection(|conn| {
        let mut q = conn.prepare("SELECT p.id,p.name,p.path FROM projects p WHERE NOT EXISTS(SELECT 1 FROM workspace_legacy_map m WHERE m.project_id=p.id) ORDER BY p.id").map_err(sql)?;
        let pending = q.query_map([], |r| Ok((r.get::<_,String>(0)?, r.get::<_,String>(1)?, r.get::<_,Option<String>>(2)?))).map_err(sql)?.collect::<Result<Vec<_>,_>>().map_err(sql)?;
        let mut q = conn.prepare("SELECT l.repository_id,l.path FROM workspace_locations l WHERE l.host_id=?1 AND l.path IS NOT NULL AND EXISTS(SELECT 1 FROM workspace_member_locations m WHERE m.location_id=l.id) ORDER BY l.id").map_err(sql)?;
        let existing = q.query_map([host], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(sql)?.collect::<Result<Vec<_>,_>>().map_err(sql)?;
        Ok((pending, existing))
    })?;
    let mut identities: HashMap<PathBuf, String> = existing
        .into_iter()
        .filter_map(|(id, path)| {
            Path::new(&path)
                .is_absolute()
                .then(|| crate::git_context::repository_identity(Path::new(&path)))
                .flatten()
                .map(|(_, common)| (common, id))
        })
        .collect();
    for (project_id, title, path) in pending {
        let identity = path
            .as_deref()
            .filter(|p| Path::new(p).is_absolute())
            .and_then(|p| crate::git_context::repository_identity(Path::new(p)));
        let repository_id = identity
            .as_ref()
            .and_then(|(_, common)| identities.get(common))
            .cloned()
            .unwrap_or_else(|| project_id.clone());
        if let Some((_, common)) = &identity {
            identities.insert(common.clone(), repository_id.clone());
        }
        db.with_connection(|conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(sql)?;
            retire_locations(&tx)?;
            // A concurrent seed may have already installed this exact legacy mapping.
            if tx.query_row("SELECT EXISTS(SELECT 1 FROM workspace_legacy_map WHERE project_id=?1)",[&project_id],|r|r.get::<_,bool>(0)).map_err(sql)? { return Ok(()); }
            tx.execute("INSERT INTO workspace_projects(id,name) VALUES(?1,?2) ON CONFLICT DO NOTHING",params![project_id,title]).map_err(sql)?;
            tx.execute("INSERT INTO workspace_repositories(id,name) VALUES(?1,?2) ON CONFLICT DO NOTHING",params![repository_id,title]).map_err(sql)?;
            tx.execute("INSERT INTO workspace_members(workspace_id,repository_id) VALUES(?1,?2) ON CONFLICT DO NOTHING",params![project_id,repository_id]).map_err(sql)?;
            tx.execute("INSERT INTO workspace_locations(id,repository_id,host_id,path,native_project_id,kind) VALUES(?1,?2,?3,?4,?1,?5) ON CONFLICT DO NOTHING",params![project_id,repository_id,host,path,if identity.is_some(){"repository"}else{"legacy"}]).map_err(sql)?;
            tx.execute("INSERT INTO workspace_member_locations(workspace_id,repository_id,location_id) SELECT ?1,?2,id FROM workspace_locations WHERE id=?1 OR (host_id=?3 AND path=?4) ON CONFLICT DO NOTHING",params![project_id,repository_id,host,path]).map_err(sql)?;
            tx.execute("INSERT INTO workspace_legacy_map(project_id,workspace_id,repository_id) VALUES(?1,?1,?2)",params![project_id,repository_id]).map_err(sql)?;
            tx.commit().map_err(sql)
        })?;
    }
    Ok(())
}

/// Business projects are a management grouping the user curates. Launch directories no longer
/// become projects on their own; projects an older version seeded from a directory, and that
/// were never changed since, leave together with that directory.
pub fn list(db: &Database, host: &str) -> Result<Vec<Workspace>, String> {
    retire_orphan_seeds(db)?;
    let ids: Vec<String> = db.with_connection(|conn| {
        let mut q = conn
            .prepare("SELECT id FROM workspace_projects ORDER BY name COLLATE NOCASE,id")
            .map_err(sql)?;
        let rows = q.query_map([], |row| row.get(0)).map_err(sql)?;
        rows.collect::<Result<_, _>>().map_err(sql)
    })?;
    ids.iter().map(|id| get(db, host, id)).collect()
}
fn retire_orphan_seeds(db: &Database) -> Result<(), String> {
    let ids: Vec<String> = db.with_connection(|conn| {
        let mut q = conn.prepare("SELECT w.id FROM workspace_projects w JOIN workspace_legacy_map m ON m.workspace_id=w.id AND m.project_id=w.id WHERE w.manifest_path IS NULL AND w.revision=1 AND NOT EXISTS(SELECT 1 FROM projects p WHERE p.id=m.project_id) AND (SELECT COUNT(*) FROM workspace_members x WHERE x.workspace_id=w.id)<=1 ORDER BY w.id").map_err(sql)?;
        let rows = q.query_map([], |row| row.get(0)).map_err(sql)?;
        rows.collect::<Result<_, _>>().map_err(sql)
    })?;
    for id in ids {
        delete(db, &id)?;
    }
    Ok(())
}
/// Deletes only the grouping: repositories on disk, branches, sessions and their history stay.
/// Prompts scoped to the project become general prompts so none of them disappear.
pub fn delete(db: &Database, id: &str) -> Result<(), String> {
    db.with_connection(|conn| {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(sql)?;
        tx.execute("UPDATE prompt_metadata SET scope_json=json_object('kind','global') WHERE json_extract(scope_json,'$.kind')='workspace' AND json_extract(scope_json,'$.workspaceId')=?1", [id]).map_err(sql)?;
        tx.execute("DELETE FROM workspace_sessions WHERE workspace_id=?1", [id]).map_err(sql)?;
        // The legacy map row stays: lookups join workspace_projects, and the row keeps an old
        // directory from being treated as never seen.
        tx.execute("DELETE FROM workspace_projects WHERE id=?1", [id]).map_err(sql)?;
        retire_locations(&tx)?;
        tx.commit().map_err(sql)
    })
}
/// Source display metadata must not probe the project's other repositories.
pub fn display_name(db: &Database, id: &str) -> Result<Option<String>, String> {
    db.with_connection(|conn| conn.query_row("SELECT name FROM workspace_projects WHERE id=?1", [id], |row| row.get(0)).optional().map_err(sql))
}

pub fn get(db: &Database, host: &str, id: &str) -> Result<Workspace, String> {
    let mut value = db.with_connection(|conn| {
        let mut value = conn.query_row("SELECT name,revision,manifest_path,manifest_revision,last_error FROM workspace_projects WHERE id=?1", [id], |row| Ok(Workspace { id:id.into(), name:row.get(0)?, revision:row.get::<_,i64>(1)?.max(0) as u64, manifest_path:row.get(2)?, manifest_revision:row.get::<_,Option<i64>>(3)?.map(|v|v.max(0) as u64), error:row.get(4)?, repositories:Vec::new() })).optional().map_err(sql)?.ok_or("业务项目不存在")?;
        let mut q = conn.prepare("SELECT r.id,r.name,m.favorite FROM workspace_members m JOIN workspace_repositories r ON r.id=m.repository_id WHERE m.workspace_id=?1 ORDER BY m.favorite DESC,r.name COLLATE NOCASE,r.id").map_err(sql)?;
        let repos = q.query_map([id], |row| Ok(WorkspaceRepository {id:row.get(0)?,name:row.get(1)?,favorite:row.get(2)?,locations:Vec::new()})).map_err(sql)?.collect::<Result<Vec<_>,_>>().map_err(sql)?;
        for mut repo in repos {
            let mut q = conn.prepare("SELECT l.id,l.host_id,l.path,l.native_project_id,l.target_id,l.kind FROM workspace_locations l JOIN workspace_member_locations m ON m.location_id=l.id WHERE m.repository_id=?1 AND m.workspace_id=?2 ORDER BY l.host_id,l.path").map_err(sql)?;
            repo.locations = q.query_map(params![repo.id,id], |row| Ok(WorkspaceLocation {id:row.get(0)?,host_id:row.get(1)?,path:row.get(2)?,project_id:row.get(3)?,target_id:row.get(4)?,kind:row.get(5)?,available:false,reason:None,worktrees:Vec::new()})).map_err(sql)?.collect::<Result<_,_>>().map_err(sql)?;
            value.repositories.push(repo);
        }
        Ok(value)
    })?;
    for repo in &mut value.repositories {
        for location in &mut repo.locations {
            if location.host_id != host || location.target_id.is_some() {
                location.reason = Some("其他主机的位置，请关联本机目录".into());
                continue;
            }
            let Some(path) = location.path.as_deref().map(Path::new) else {
                location.reason = Some("旧目录尚未关联，原记录已保留".into());
                continue;
            };
            if !path.is_absolute() {
                location.reason = Some("此位置不是本机绝对路径，请重新关联本机目录".into());
                continue;
            }
            if !path.is_dir() {
                location.reason = Some("目录不存在或不可访问".into());
                continue;
            }
            location.available = true;
            if let Some((root, common)) = crate::git_context::repository_identity(path) {
                location.kind = "repository".into();
                match crate::git_context::worktrees_checked(path) {
                    Ok(trees) => {
                        location.worktrees = trees
                            .into_iter()
                            .filter(|tree| {
                                crate::git_context::repository_identity(Path::new(&tree.path))
                                    .is_some_and(|(_, identity)| identity == common)
                            })
                            .collect()
                    }
                    Err(reason) => location.reason = Some(reason),
                }
                if !location.worktrees.iter().any(|tree| {
                    Path::new(&tree.path)
                        .canonicalize()
                        .is_ok_and(|path| path == root)
                }) {
                    let context = crate::git_context::read(&root);
                    location.worktrees.insert(
                        0,
                        crate::git_context::Worktree {
                            name: root
                                .file_name()
                                .map(|name| name.to_string_lossy().into())
                                .unwrap_or_else(|| repo.name.clone()),
                            branch: context.and_then(|c| c.branch),
                            path: text(&root)?,
                            current: true,
                        },
                    );
                }
            } else if location.kind == "legacy" {
                location.reason = Some("原目录可继续使用，尚未识别为 Git 仓库".into());
            } else {
                location.available = false;
                location.reason = Some("工作位置未通过 Git 仓库校验，请重新关联".into());
            }
        }
    }
    Ok(value)
}
pub fn create(db: &Database, host: &str, title: &str) -> Result<Workspace, String> {
    let id = Uuid::new_v4().to_string();
    let title = name(title)?;
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO workspace_projects(id,name) VALUES(?1,?2)",
            params![id, title],
        )
        .map(|_| ())
        .map_err(sql)
    })?;
    get(db, host, &id)
}
fn manifest_from_db(db: &Database, id: &str) -> Result<Manifest, String> {
    db.with_connection(|conn| {
        let (title,revision):(String,u64)=conn.query_row("SELECT name,revision FROM workspace_projects WHERE id=?1",[id],|r|Ok((r.get(0)?,r.get::<_,i64>(1)?.max(0) as u64))).map_err(sql)?;
        let mut q=conn.prepare("SELECT r.id,r.name FROM workspace_members m JOIN workspace_repositories r ON r.id=m.repository_id WHERE m.workspace_id=?1 ORDER BY r.id").map_err(sql)?;
        let mut repos=q.query_map([id],|r|Ok(ManifestRepository{id:r.get(0)?,name:r.get(1)?,locations:Vec::new()})).map_err(sql)?.collect::<Result<Vec<_>,_>>().map_err(sql)?;
        for repo in &mut repos {
            let mut q=conn.prepare("SELECT l.host_id,l.path FROM workspace_locations l JOIN workspace_member_locations m ON m.location_id=l.id WHERE m.repository_id=?1 AND m.workspace_id=?2 AND l.path IS NOT NULL ORDER BY l.host_id,l.path").map_err(sql)?;
            repo.locations=q.query_map(params![repo.id,id],|r|Ok(ManifestLocation{host_id:r.get(0)?,path:r.get(1)?})).map_err(sql)?.collect::<Result<_,_>>().map_err(sql)?;
        }
        Ok(Manifest{schema_version:1,workspace_id:id.into(),name:title,revision,repositories:repos})
    })
}
/// Retired locations keep historical native-context metadata but release their live path claim.
/// Only workspace_member_locations grants current ownership or identity-observation authority.
fn retire_locations(conn: &Connection) -> Result<(), String> {
    conn.execute("UPDATE workspace_locations SET path=NULL WHERE path IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workspace_member_locations m WHERE m.location_id=workspace_locations.id)",[]).map_err(sql)?;
    Ok(())
}

fn validate_projection(
    conn: &Connection,
    value: &Manifest,
    expected: Option<u64>,
) -> Result<(), String> {
    validate_manifest(value)?;
    if let Some(expected) = expected {
        let actual = conn
            .query_row(
                "SELECT revision FROM workspace_projects WHERE id=?1",
                [&value.workspace_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(sql)?;
        if actual < 0 || actual as u64 != expected {
            return Err("项目已在其他窗口更新，请刷新后重试".into());
        }
    }
    for repo in &value.repositories {
        for location in &repo.locations {
            let owner:Option<String> = conn.query_row("SELECT l.repository_id FROM workspace_locations l WHERE l.host_id=?1 AND l.path=?2 AND EXISTS(SELECT 1 FROM workspace_member_locations m WHERE m.location_id=l.id)",params![location.host_id,location.path],|row|row.get(0)).optional().map_err(sql)?;
            if owner.as_deref().is_some_and(|id| id != repo.id) {
                return Err("清单工作位置已关联另一个仓库，请先处理关联冲突".into());
            }
        }
    }
    Ok(())
}

fn write_projection(
    tx: &Transaction<'_>,
    value: &Manifest,
    source: Option<(&str, &str)>,
) -> Result<(), String> {
    let json = serde_json::to_string(value).map_err(|error| error.to_string())?;
    // Clean aliases from previously removed/relinked memberships before claiming any reused path.
    retire_locations(tx)?;
    let (path, hash) = source
        .map(|(p, h)| (Some(p), Some(h)))
        .unwrap_or((None, None));
    tx.execute("INSERT INTO workspace_projects(id,name,revision,manifest_path,manifest_revision,manifest_digest,manifest_json) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET name=excluded.name,revision=excluded.revision,manifest_path=COALESCE(excluded.manifest_path,workspace_projects.manifest_path),manifest_revision=COALESCE(excluded.manifest_revision,workspace_projects.manifest_revision),manifest_digest=COALESCE(excluded.manifest_digest,workspace_projects.manifest_digest),manifest_json=excluded.manifest_json,last_error=NULL",params![value.workspace_id,value.name,value.revision as i64,path,source.map(|_|value.revision as i64),hash,json]).map_err(sql)?;
    let favorites: HashMap<String, bool> = {
        let mut query = tx
            .prepare("SELECT repository_id,favorite FROM workspace_members WHERE workspace_id=?1")
            .map_err(sql)?;
        let rows = query
            .query_map([&value.workspace_id], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(sql)?;
        rows.collect::<Result<_, _>>().map_err(sql)?
    };
    tx.execute(
        "DELETE FROM workspace_member_locations WHERE workspace_id=?1",
        [&value.workspace_id],
    )
    .map_err(sql)?;
    tx.execute(
        "DELETE FROM workspace_members WHERE workspace_id=?1",
        [&value.workspace_id],
    )
    .map_err(sql)?;
    for repo in &value.repositories {
        tx.execute("INSERT INTO workspace_repositories(id,name) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET name=excluded.name",params![repo.id,repo.name]).map_err(sql)?;
        tx.execute(
            "INSERT INTO workspace_members(workspace_id,repository_id,favorite) VALUES(?1,?2,?3)",
            params![
                value.workspace_id,
                repo.id,
                favorites.get(&repo.id).copied().unwrap_or(false)
            ],
        )
        .map_err(sql)?;
        for location in &repo.locations {
            let native: Option<String> = tx
                .query_row(
                    "SELECT id FROM projects WHERE path=?1",
                    [&location.path],
                    |row| row.get(0),
                )
                .optional()
                .map_err(sql)?;
            tx.execute("INSERT INTO workspace_locations(id,repository_id,host_id,path,native_project_id,kind) VALUES(?1,?2,?3,?4,?5,'repository') ON CONFLICT(host_id,path) DO NOTHING",params![Uuid::new_v4().to_string(),repo.id,location.host_id,location.path,native]).map_err(sql)?;
            tx.execute("INSERT INTO workspace_member_locations(workspace_id,repository_id,location_id) SELECT ?1,?2,id FROM workspace_locations WHERE host_id=?3 AND path=?4 ON CONFLICT DO NOTHING",params![value.workspace_id,repo.id,location.host_id,location.path]).map_err(sql)?;
        }
    }
    retire_locations(tx)?;
    Ok(())
}

fn project_manifest(
    db: &Database,
    value: &Manifest,
    source: Option<(&str, &str)>,
    expected: Option<u64>,
) -> Result<(), String> {
    db.with_connection(|conn| {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql)?;
        validate_projection(&tx, value, expected)?;
        write_projection(&tx, value, source)?;
        tx.commit().map_err(sql)
    })
}

/// Hold SQLite's write transaction across preflight and publication so another local writer
/// cannot introduce a known location conflict between those two steps.
fn publish_manifest(
    db: &Database,
    value: &Manifest,
    path: &Path,
    expected: u64,
) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    let path_text = text(path)?;
    db.with_connection(|conn| {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql)?;
        validate_projection(&tx, value, Some(expected))?;
        atomic_write(path, &bytes)?;
        // Only failures after actual publication receive this recovery message.
        (|| {
            write_projection(&tx, value, Some((&path_text, &digest(&bytes))))?;
            tx.commit().map_err(sql)
        })()
        .map_err(|error| format!("清单已保存，本机投影待刷新：{error}"))
    })
}

fn mutate(
    db: &Database,
    id: &str,
    expected: u64,
    change: impl FnOnce(&mut Manifest) -> Result<(), String>,
) -> Result<(), String> {
    let source:Option<(String,String)>=db.with_connection(|conn|conn.query_row("SELECT manifest_path,manifest_digest FROM workspace_projects WHERE id=?1 AND manifest_path IS NOT NULL",[id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(sql))?;
    let _lock = source
        .as_ref()
        .map(|(p, _)| lock_file(Path::new(p)))
        .transpose()?;
    let mut value = manifest_from_db(db, id)?;
    if value.revision != expected {
        return Err("项目已更新，请刷新后重试".into());
    }
    if let Some((path, hash)) = &source {
        let (current, current_hash) = read_manifest(Path::new(path))?;
        if current.workspace_id != id || current_hash != *hash || current.revision != expected {
            return Err("项目清单已在另一端变化，请刷新后重试".into());
        }
        value = current;
    }
    change(&mut value)?;
    value.revision = value
        .revision
        .checked_add(1)
        .filter(|v| *v <= MAX_REVISION)
        .ok_or("项目版本号已耗尽")?;
    validate_manifest(&value)?;
    if let Some((path, _)) = source {
        publish_manifest(db, &value, Path::new(&path), expected)
    } else {
        project_manifest(db, &value, None, Some(expected))
    }
}
pub fn rename(
    db: &Database,
    host: &str,
    id: &str,
    title: &str,
    expected: u64,
) -> Result<Workspace, String> {
    let title = name(title)?;
    mutate(db, id, expected, |value| {
        value.name = title;
        Ok(())
    })?;
    get(db, host, id)
}
pub fn remove_member(
    db: &Database,
    host: &str,
    id: &str,
    repository_id: &str,
    expected: u64,
) -> Result<Workspace, String> {
    mutate(db, id, expected, |value| {
        value.repositories.retain(|r| r.id != repository_id);
        Ok(())
    })?;
    get(db, host, id)
}
pub fn favorite(
    db: &Database,
    host: &str,
    id: &str,
    repository_id: &str,
    value: bool,
) -> Result<Workspace, String> {
    db.with_connection(|conn| {
        conn.execute(
            "UPDATE workspace_members SET favorite=?3 WHERE workspace_id=?1 AND repository_id=?2",
            params![id, repository_id, value],
        )
        .map(|_| ())
        .map_err(sql)
    })?;
    get(db, host, id)
}
pub fn add_paths(
    db: &Database,
    host: &str,
    id: &str,
    paths: &[String],
    expected: u64,
) -> Result<Vec<MemberResult>, String> {
    let mut version = expected;
    let mut results = Vec::new();
    for raw in paths {
        let attempt = (|| {
            let path = crate::projects::checked_directory(raw)?;
            let (root, common) = crate::git_context::repository_identity(&path)
                .ok_or("所选目录不是可识别的 Git 仓库")?;
            let path = text(&root)?;
            let existing:Vec<(String,String)>=db.with_connection(|conn|{let mut q=conn.prepare("SELECT l.repository_id,l.path FROM workspace_locations l WHERE l.host_id=?1 AND l.path IS NOT NULL AND EXISTS(SELECT 1 FROM workspace_member_locations m WHERE m.location_id=l.id)").map_err(sql)?;let rows=q.query_map([host],|r|Ok((r.get(0)?,r.get(1)?))).map_err(sql)?;rows.collect::<Result<_,_>>().map_err(sql)})?;
            let repository_id = existing
                .iter()
                .find(|(_, p)| {
                    crate::git_context::repository_identity(Path::new(p))
                        .is_some_and(|(_, c)| c == common)
                })
                .map(|(r, _)| r.clone())
                .unwrap_or_else(|| Uuid::new_v4().to_string());
            let title = root
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("Repository")
                .to_owned();
            mutate(db, id, version, |value| {
                if let Some(repo) = value
                    .repositories
                    .iter_mut()
                    .find(|r| r.id == repository_id)
                {
                    if !repo
                        .locations
                        .iter()
                        .any(|l| l.host_id == host && l.path == path)
                    {
                        repo.locations.push(ManifestLocation {
                            host_id: host.into(),
                            path: path.clone(),
                        });
                    }
                } else {
                    value.repositories.push(ManifestRepository {
                        id: repository_id.clone(),
                        name: title,
                        locations: vec![ManifestLocation {
                            host_id: host.into(),
                            path: path.clone(),
                        }],
                    });
                }
                Ok(())
            })?;
            version += 1;
            Ok(repository_id)
        })();
        match attempt {
            Ok(repo) => results.push(MemberResult {
                path: raw.clone(),
                repository_id: Some(repo),
                error: None,
            }),
            Err(error) => results.push(MemberResult {
                path: raw.clone(),
                repository_id: None,
                error: Some(error),
            }),
        }
    }
    Ok(results)
}
/// Replace a position in the organization only; never call projects::relink or apply native files.
pub fn relink(
    db: &Database,
    host: &str,
    id: &str,
    repository_id: &str,
    path: &str,
    expected: u64,
) -> Result<Workspace, String> {
    let root = crate::projects::checked_directory(path)?;
    let (root, _) =
        crate::git_context::repository_identity(&root).ok_or("新目录不是可识别的 Git 仓库")?;
    let path = text(&root)?;
    mutate(db, id, expected, |value| {
        let repo = value
            .repositories
            .iter_mut()
            .find(|r| r.id == repository_id)
            .ok_or("仓库已从项目移除")?;
        repo.locations.retain(|l| l.host_id != host);
        repo.locations.push(ManifestLocation {
            host_id: host.into(),
            path,
        });
        Ok(())
    })?;
    get(db, host, id)
}
pub fn preview_manifest(db: &Database, path: &str) -> Result<ManifestPreview, String> {
    let path = Path::new(path).canonicalize().map_err(|e| e.to_string())?;
    let (manifest, hash) = read_manifest(&path)?;
    let local: Option<(String, Option<String>)> = db.with_connection(|conn| {
        conn.query_row(
            "SELECT name,manifest_digest FROM workspace_projects WHERE id=?1",
            [&manifest.workspace_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(sql)
    })?;
    let conflict = local.is_some_and(|(_, h)| h.as_deref() != Some(&hash));
    Ok(ManifestPreview {
        manifest,
        path: text(&path)?,
        digest: hash,
        conflict,
    })
}
pub fn attach_manifest(
    db: &Database,
    host: &str,
    path: &str,
    expected_digest: &str,
    replace: bool,
) -> Result<Workspace, String> {
    let preview = preview_manifest(db, path)?;
    if preview.digest != expected_digest {
        return Err("清单在预览后已变化，请重新预览".into());
    }
    if preview.conflict && !replace {
        return Err("本机已有该项目，请确认采用清单中的版本".into());
    }
    project_manifest(
        db,
        &preview.manifest,
        Some((&preview.path, &preview.digest)),
        None,
    )?;
    get(db, host, &preview.manifest.workspace_id)
}
pub fn export_manifest(
    db: &Database,
    host: &str,
    id: &str,
    path: &str,
    expected: u64,
) -> Result<Workspace, String> {
    let requested = Path::new(path);
    if !requested.is_absolute() {
        return Err("项目清单需使用绝对路径".into());
    }
    let parent = requested
        .parent()
        .ok_or("文件没有父目录")?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let path = parent.join(requested.file_name().ok_or("文件名无效")?);
    let _lock = lock_file(&path)?;
    if path.exists() {
        return Err("目标文件已存在，请通过打开清单关联，或选择新文件名".into());
    }
    let value = manifest_from_db(db, id)?;
    if value.revision != expected {
        return Err("项目已更新，请刷新".into());
    }
    validate_manifest(&value)?;
    publish_manifest(db, &value, &path, expected)?;
    get(db, host, id)
}
pub fn refresh_manifest(db: &Database, host: &str, id: &str) -> Result<Workspace, String> {
    let path: Option<String> = db.with_connection(|conn| {
        conn.query_row(
            "SELECT manifest_path FROM workspace_projects WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .map_err(sql)
    })?;
    if let Some(path) = path {
        let result = (|| {
            let _lock = lock_file(Path::new(&path))?;
            let (version, previous_hash): (u64, Option<String>) = db.with_connection(|conn| {
                conn.query_row(
                    "SELECT revision,manifest_digest FROM workspace_projects WHERE id=?1",
                    [id],
                    |r| Ok((r.get::<_, i64>(0)?.max(0) as u64, r.get(1)?)),
                )
                .map_err(sql)
            })?;
            let (value, hash) = read_manifest(Path::new(&path))?;
            if value.workspace_id != id {
                return Err("清单项目身份已变化，原关联已保留".into());
            }
            if value.revision < version
                || (value.revision == version
                    && previous_hash
                        .as_deref()
                        .is_some_and(|previous| previous != hash))
            {
                return Err(
                    "清单版本倒退或同版本内容发生变化，请重新预览并明确采用；原名单已保留".into(),
                );
            }
            project_manifest(db, &value, Some((&path, &hash)), Some(version))
        })();
        // A lock held by another window is not a fault of the project source: keep the last
        // projection and its previous status, and let the next refresh pick the change up.
        if let Err(error) = result.map(|_| ()) {
            if error != MANIFEST_BUSY {
                db.with_connection(|conn| {
                    conn.execute(
                        "UPDATE workspace_projects SET last_error=?2 WHERE id=?1",
                        params![id, error],
                    )
                    .map(|_| ())
                    .map_err(sql)
                })?;
            }
        }
    }
    get(db, host, id)
}

fn scans() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static SCANS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    SCANS.get_or_init(|| Mutex::new(HashMap::new()))
}
pub fn cancel_scan(id: &str) {
    if let Some(cancel) = scans().lock().unwrap_or_else(|e| e.into_inner()).get(id) {
        cancel.store(true, Ordering::Relaxed);
    }
}
pub fn scan(roots: &[String], operation_id: &str, recursive: bool) -> Result<ScanResult, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut active = scans().lock().unwrap_or_else(|e| e.into_inner());
        if active.contains_key(operation_id) {
            return Err("扫描标识正在使用".into());
        }
        active.insert(operation_id.into(), cancel.clone());
    }
    let result = scan_with(roots, recursive, &cancel);
    scans()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(operation_id);
    result
}
fn scan_with(roots: &[String], recursive: bool, cancel: &AtomicBool) -> Result<ScanResult, String> {
    let mut queue: VecDeque<PathBuf> = roots.iter().map(PathBuf::from).collect();
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    let mut count = 0;
    while let Some(raw) = queue.pop_front() {
        if cancel.load(Ordering::Relaxed) {
            return Ok(ScanResult {
                candidates,
                cancelled: true,
                partial: true,
            });
        }
        count += 1;
        if count > MAX_SCAN {
            return Ok(ScanResult {
                candidates,
                cancelled: false,
                partial: true,
            });
        }
        let candidate = |kind: &str, reason: Option<String>, common: Option<String>| Candidate {
            path: raw.to_string_lossy().into(),
            name: raw
                .file_name()
                .map(|n| n.to_string_lossy().into())
                .unwrap_or_default(),
            kind: kind.into(),
            reason,
            common_directory: common,
        };
        let path = match raw.canonicalize() {
            Ok(p) => p,
            Err(e) => {
                candidates.push(candidate("unavailable", Some(e.to_string()), None));
                continue;
            }
        };
        if !seen.insert(path.clone()) {
            candidates.push(candidate("duplicate", Some("重复目录".into()), None));
            continue;
        }
        if !path.is_dir() {
            candidates.push(candidate("unavailable", Some("不是目录".into()), None));
            continue;
        }
        let git = crate::git_context::repository_identity(&path);
        if let Some((root, common)) = git {
            if root == path || !recursive {
                candidates.push(Candidate {
                    path: text(&root)?,
                    name: root
                        .file_name()
                        .map(|n| n.to_string_lossy().into())
                        .unwrap_or_default(),
                    kind: "repository".into(),
                    reason: None,
                    common_directory: Some(text(&common)?),
                });
            }
        } else if !recursive || roots.iter().any(|r| Path::new(r) == raw) {
            candidates.push(candidate(
                "directory",
                Some("普通目录，仅扫描其下的仓库".into()),
                None,
            ));
        }
        if !recursive {
            continue;
        }
        match fs::read_dir(&path) {
            Ok(entries) => {
                for entry in entries {
                    let entry = match entry {
                        Ok(e) => e,
                        Err(e) => {
                            candidates.push(candidate("unavailable", Some(e.to_string()), None));
                            continue;
                        }
                    };
                    let file_name = entry.file_name();
                    if matches!(
                        file_name.to_str(),
                        Some(".git" | "node_modules" | "target" | ".DS_Store")
                    ) {
                        continue;
                    }
                    if entry
                        .file_type()
                        .is_ok_and(|t| t.is_dir() && !t.is_symlink())
                    {
                        queue.push_back(entry.path());
                    }
                }
            }
            Err(e) => candidates.push(candidate("unavailable", Some(e.to_string()), None)),
        }
    }
    Ok(ScanResult {
        candidates,
        cancelled: false,
        partial: false,
    })
}

pub fn prepare_launch(
    db: &Database,
    host: &str,
    workspace_id: &str,
    repository_id: &str,
    directory: Option<&str>,
) -> Result<(String, String), String> {
    let value = get(db, host, workspace_id)?;
    let repo = value
        .repositories
        .iter()
        .find(|r| r.id == repository_id)
        .ok_or("仓库已从项目移除")?;
    let locations: Vec<_> = repo
        .locations
        .iter()
        .filter(|l| l.host_id == host && l.target_id.is_none())
        .collect();
    let selected = directory
        .map(PathBuf::from)
        .or_else(|| {
            locations
                .iter()
                .find(|l| l.available)
                .and_then(|l| l.path.as_deref())
                .map(PathBuf::from)
        })
        .ok_or("请关联可用的本机工作目录")?;
    if !selected.is_absolute() {
        return Err("工作目录必须是本机绝对路径".into());
    }
    let selected = selected
        .canonicalize()
        .map_err(|_| "工作目录不存在，未启动替代目录")?;
    let requested_identity = crate::git_context::repository_identity(&selected);
    let exact = |location: &&WorkspaceLocation| {
        location
            .path
            .as_deref()
            .is_some_and(|p| Path::new(p).canonicalize().is_ok_and(|p| p == selected))
    };
    let location = locations
        .iter()
        .copied()
        .find(exact)
        .or_else(|| {
            locations.iter().copied().find(|location| {
                location.path.as_deref().is_some_and(|p| {
                    match (
                        &requested_identity,
                        crate::git_context::repository_identity(Path::new(p)),
                    ) {
                        (Some((_, a)), Some((_, b))) => *a == b,
                        _ => false,
                    }
                })
            })
        })
        .ok_or("所选工作目录不属于该仓库")?;
    if !location.available {
        return Err("工作位置不可用，请先重新关联目录".into());
    }
    // An explicitly configured linked checkout must keep its own native profile context.
    let selected_text = text(&selected)?;
    let exact_context: Option<String> = db.with_connection(|conn| {
        conn.query_row(
            "SELECT id FROM projects WHERE path=?1",
            [&selected_text],
            |r| r.get(0),
        )
        .optional()
        .map_err(sql)
    })?;
    let old_id = exact_context.or_else(|| {
        location
            .project_id
            .as_ref()
            .filter(|id| crate::projects::get(db, id).is_ok())
            .cloned()
    });
    let native_id = if let Some(id) = old_id {
        id
    } else {
        let project = crate::projects::add(
            db,
            &crate::adapters::Registry::builtins(),
            &text(&selected)?,
            None,
            None,
        )?;
        db.with_connection(|conn|{conn.execute("UPDATE workspace_locations SET native_project_id=?2 WHERE id=?1",params![location.id,project.id]).map_err(sql)?;conn.execute("INSERT INTO workspace_legacy_map(project_id,workspace_id,repository_id) VALUES(?1,?2,?3) ON CONFLICT DO NOTHING",params![project.id,workspace_id,repository_id]).map_err(sql)?;Ok(())})?;
        project.id
    };
    Ok((native_id, text(&selected)?))
}
pub fn remember_session(db: &Database, context: &SessionContext) -> Result<(), String> {
    db.with_connection(|conn|conn.execute("INSERT INTO workspace_sessions(session_id,workspace_id,repository_id,host_id,directory) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(session_id) DO UPDATE SET workspace_id=excluded.workspace_id,repository_id=excluded.repository_id,host_id=excluded.host_id,directory=excluded.directory",params![context.session_id,context.workspace_id,context.repository_id,context.host_id,context.directory]).map(|_|()).map_err(sql))
}
pub fn session_contexts(db: &Database) -> Result<Vec<SessionContext>, String> {
    // Old checkpoints predate explicit workspace metadata. Their original directory-project
    // mapping is exact, unlike a name/path guess, and never rewrites their launch directory.
    for saved in crate::workbench_restore::list(db)? {
        let Some(project_id) = saved
            .project_id
            .as_deref()
            .filter(|id| !id.starts_with("remote:"))
        else {
            continue;
        };
        let has_context = db.with_connection(|conn| {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM workspace_sessions WHERE session_id=?1)",
                [&saved.id],
                |r| r.get::<_, bool>(0),
            )
            .map_err(sql)
        })?;
        if has_context {
            continue;
        }
        let mapping: Option<(String,String,String)> = db.with_connection(|conn|conn.query_row("SELECT m.workspace_id,m.repository_id,l.host_id FROM workspace_legacy_map m JOIN workspace_locations l ON l.native_project_id=m.project_id JOIN workspace_members members ON members.workspace_id=m.workspace_id AND members.repository_id=m.repository_id WHERE m.project_id=?1 LIMIT 1",[project_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(sql))?;
        if let Some((workspace_id, repository_id, host_id)) = mapping {
            remember_session(
                db,
                &SessionContext {
                    session_id: saved.id,
                    workspace_id,
                    repository_id,
                    host_id,
                    directory: saved.directory,
                },
            )?;
        }
    }
    db.with_connection(|conn|{let mut q=conn.prepare("SELECT session_id,workspace_id,repository_id,host_id,directory FROM workspace_sessions").map_err(sql)?;let rows=q.query_map([],|r|Ok(SessionContext{session_id:r.get(0)?,workspace_id:r.get(1)?,repository_id:r.get(2)?,host_id:r.get(3)?,directory:r.get(4)?})).map_err(sql)?;rows.collect::<Result<_,_>>().map_err(sql)})
}
pub fn restore_session_context(db: &Database, old_id: &str, new_id: &str) -> Result<(), String> {
    db.with_connection(|conn|conn.execute("INSERT INTO workspace_sessions(session_id,workspace_id,repository_id,host_id,directory) SELECT ?2,workspace_id,repository_id,host_id,directory FROM workspace_sessions WHERE session_id=?1 ON CONFLICT(session_id) DO NOTHING",params![old_id,new_id]).map(|_|()).map_err(sql))
}

#[cfg(test)]
#[path = "../../tests/launch/workspaces.rs"]
mod tests;

/// Deep links only request a preview; they never establish membership or execute Git.
pub fn manifest_link(url: &str) -> Result<String, String> {
    if url.len() > 16_384 || url.chars().any(|c| c.is_control() || c == ' ') || url.contains('#') {
        return Err("项目清单链接无效".into());
    }
    let query = url
        .strip_prefix("cliora://workspace?")
        .or_else(|| url.strip_prefix("cliora://workspace/?"))
        .ok_or("项目清单链接无效")?;
    let mut version = None;
    let mut path = None;
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
        match key.as_ref() {
            "v" if version.is_none() => version = Some(value.into_owned()),
            "file" if path.is_none() => path = Some(value.into_owned()),
            _ => return Err("项目清单链接含未知或重复字段".into()),
        }
    }
    if version.as_deref() != Some("1") {
        return Err("项目清单链接版本不受支持".into());
    }
    let path = path.ok_or("项目清单链接缺少文件")?;
    if !Path::new(&path).is_absolute() || path.chars().any(char::is_control) {
        return Err("项目清单链接需使用本机绝对路径".into());
    }
    Ok(path)
}
