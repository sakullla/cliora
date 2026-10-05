//! WebDAV carries encrypted immutable entity versions and an encrypted, conditional manifest.
//! Native CLI files, active bindings, OAuth state and history never enter this protocol.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::blocking::{Client, Response};
use reqwest::header::{ETAG, IF_MATCH, IF_NONE_MATCH};
use reqwest::{Method, StatusCode, Url};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{
    apply_import, collect_snapshot, crypto, preview_import, PortableEntity, PortablePayload,
    PortableSnapshot,
};
use crate::credentials::CredentialStore;
use crate::database::Database;
use crate::adapters::Registry;

const MAX_REMOTE: usize = 96 * 1024 * 1024;
const MAX_HEADS: usize = 8;
#[cfg(not(test))]
static SYNC_LOCK: Mutex<()> = Mutex::new(());

// Each fixture database represents a separate application/device. Keep calls on
// that device serialized without making independent protocol fixtures wait for it.
#[cfg(test)]
fn fixture_sync_lock(db: &Database) -> Result<std::sync::Arc<Mutex<()>>, String> {
    use std::sync::{Arc, Weak};
    static LOCKS: Mutex<BTreeMap<String, Weak<Mutex<()>>>> = Mutex::new(BTreeMap::new());
    let path = db.with_connection(|conn| conn.path().map(str::to_owned).ok_or_else(|| "同步测试需要独立数据库路径".into()))?;
    let mut locks = LOCKS.lock().unwrap();
    if let Some(lock) = locks.get(&path).and_then(Weak::upgrade) { return Ok(lock); }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(path, Arc::downgrade(&lock));
    Ok(lock)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfig {
    pub endpoint: String,
    pub username: String,
    pub space_id: String,
    pub enabled: bool,
    pub last_success: Option<i64>,
    pub last_error: Option<String>,
    pub retry_after: i64,
    pub failure_count: u32,
    #[serde(skip)]
    auth_secret_id: String,
    #[serde(skip)]
    space_secret_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSetup {
    pub endpoint: String,
    pub username: String,
    pub auth_password: String,
    pub encryption_password: String,
    #[serde(default)]
    pub previous_encryption_password: String,
    pub enabled: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConflict {
    pub key: String,
    pub label: String,
    pub local_present: bool,
    #[serde(default)]
    pub local_digest: String,
    pub remote_versions: usize,
    pub remote_deleted: bool,
    #[serde(default)]
    pub versions: Vec<SyncConflictVersion>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConflictVersion {
    pub id: String,
    pub digest: String,
    pub deleted: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictVersionPreview {
    pub id: String,
    pub summary: String,
    pub deleted: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictPreview {
    pub key: String,
    pub local_summary: String,
    pub versions: Vec<ConflictVersionPreview>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub configured: bool,
    pub enabled: bool,
    pub endpoint: Option<String>,
    pub last_success: Option<i64>,
    pub last_error: Option<String>,
    pub retry_after: Option<i64>,
    pub uploaded: usize,
    pub downloaded: usize,
    pub pending_changes: usize,
    pub conflicts: Vec<SyncConflict>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Version {
    id: String,
    parents: Vec<String>,
    digest: String,
    deleted: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema_version: u32,
    space_id: String,
    heads: BTreeMap<String, Vec<Version>>,
    #[serde(default)]
    history: BTreeMap<String, Vec<Version>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionObject {
    key: String,
    version_id: String,
    entity: Option<PortableEntity>,
}

#[derive(Clone)]
struct LocalState {
    digest: String,
    heads: Vec<String>,
    deleted: bool,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| time.as_secs() as i64)
}

fn endpoint(value: &str) -> Result<Url, String> {
    let mut url = Url::parse(value).map_err(|_| "WebDAV 地址无效".to_string())?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
        || url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("WebDAV 需要 HTTPS 地址；仅本机测试允许 HTTP".into());
    }
    if !url.path().ends_with('/') {
        url.set_path(&format!("{}/", url.path()));
    }
    Ok(url)
}

struct Dav {
    client: Client,
    base: Url,
    username: String,
    password: String,
}

impl Dav {
    fn new(base: Url, username: &str, password: &str) -> Result<Self, String> {
        let client = Client::builder()
            .timeout(Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "无法建立 WebDAV 连接".to_string())?;
        Ok(Self {
            client,
            base,
            username: username.into(),
            password: password.into(),
        })
    }
    fn url(&self, name: &str) -> Result<Url, String> {
        self.base.join(name).map_err(|_| "WebDAV 路径无效".into())
    }
    fn request(
        &self,
        method: Method,
        name: &str,
    ) -> Result<reqwest::blocking::RequestBuilder, String> {
        Ok(self
            .client
            .request(method, self.url(name)?)
            .basic_auth(&self.username, Some(&self.password)))
    }
    fn send(&self, request: reqwest::blocking::RequestBuilder) -> Result<Response, String> {
        request
            .send()
            .map_err(|error| format!("WebDAV 无法连接：{error}"))
    }
    fn read(&self, name: &str) -> Result<Option<(Vec<u8>, Option<String>)>, String> {
        let response = self.send(self.request(Method::GET, name)?)?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(format!("WebDAV 读取失败：HTTP {}", response.status()));
        }
        let etag = response
            .headers()
            .get(ETAG)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let mut bytes = Vec::new();
        response
            .take((MAX_REMOTE + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| "WebDAV 响应读取失败".to_string())?;
        if bytes.len() > MAX_REMOTE {
            return Err("WebDAV 资料超过大小限制".into());
        }
        Ok(Some((bytes, etag)))
    }
    fn put(&self, name: &str, bytes: Vec<u8>, etag: Option<&str>) -> Result<bool, String> {
        if bytes.len() > MAX_REMOTE {
            return Err("WebDAV 资料超过大小限制".into());
        }
        let request = self
            .request(Method::PUT, name)?
            .header("content-type", "application/octet-stream")
            .body(bytes);
        let request = if let Some(etag) = etag {
            request.header(IF_MATCH, etag)
        } else {
            request.header(IF_NONE_MATCH, "*")
        };
        let response = self.send(request)?;
        if response.status() == StatusCode::PRECONDITION_FAILED {
            return Ok(false);
        }
        if !response.status().is_success() {
            return Err(format!("WebDAV 条件写入失败：HTTP {}", response.status()));
        }
        Ok(true)
    }
    fn mkdir_versions(&self) -> Result<(), String> {
        let method = Method::from_bytes(b"MKCOL").map_err(|_| "WebDAV 方法不可用".to_string())?;
        let response = self.send(self.request(method, "versions/")?)?;
        if response.status().is_success()
            || matches!(
                response.status(),
                StatusCode::METHOD_NOT_ALLOWED | StatusCode::CONFLICT
            )
        {
            return Ok(());
        }
        Err(format!(
            "WebDAV 无法建立版本目录：HTTP {}",
            response.status()
        ))
    }
    fn list(&self) -> Result<(), String> {
        let method =
            Method::from_bytes(b"PROPFIND").map_err(|_| "WebDAV 方法不可用".to_string())?;
        let response = self.send(self.request(method, "")?.header("Depth", "0"))?;
        if response.status() != StatusCode::MULTI_STATUS {
            return Err(format!("WebDAV 列表不受支持：HTTP {}", response.status()));
        }
        Ok(())
    }
    fn delete(&self, name: &str, etag: &str) -> Result<(), String> {
        let response = self.send(self.request(Method::DELETE, name)?.header(IF_MATCH, etag))?;
        if !response.status().is_success() {
            return Err(format!(
                "WebDAV 测试文件清理失败：HTTP {}",
                response.status()
            ));
        }
        Ok(())
    }
}

fn test_connection(dav: &Dav) -> Result<(), String> {
    dav.list()?;
    let name = format!("test-{}.cliora", Uuid::new_v4());
    if !dav.put(&name, b"cliora-webdav-test".to_vec(), None)? {
        return Err("WebDAV 测试文件已存在".into());
    }
    let result = (|| -> Result<(), String> {
        let (bytes, etag) = dav.read(&name)?.ok_or("WebDAV 无法读取刚写入的测试文件")?;
        if bytes != b"cliora-webdav-test" {
            return Err("WebDAV 测试文件内容不一致".into());
        }
        let etag = etag.ok_or("WebDAV 未返回测试文件 ETag")?;
        if dav.put(
            &name,
            b"wrong-conditional".to_vec(),
            Some("\"cliora-wrong-etag\""),
        )? {
            return Err("WebDAV 忽略 If-Match，无法安全同步".into());
        }
        if !dav.put(&name, b"cliora-webdav-updated".to_vec(), Some(&etag))? {
            return Err("WebDAV 条件更新测试失败".into());
        }
        let (bytes, _) = dav.read(&name)?.ok_or("WebDAV 条件更新后文件丢失")?;
        if bytes != b"cliora-webdav-updated" {
            return Err("WebDAV 条件更新未生效".into());
        }
        Ok(())
    })();
    let cleanup = dav
        .read(&name)?
        .and_then(|(_, etag)| etag)
        .ok_or("WebDAV 测试文件无 ETag".to_string())
        .and_then(|etag| dav.delete(&name, &etag));
    result?;
    cleanup
}

fn validate_manifest(manifest: &Manifest, space_id: &str) -> Result<(), String> {
    if !matches!(manifest.schema_version, 1 | 2)
        || manifest.space_id != space_id
        || manifest.heads.len() > 10_000
        || manifest.history.len() > 10_000
    {
        return Err("同步清单版本、空间或数量不受支持".into());
    }
    for (key, heads) in &manifest.heads {
        if key.len() > 300 || !key.contains(':') || heads.len() > MAX_HEADS || heads.is_empty() {
            return Err("同步清单实体无效".into());
        }
        let mut ids = BTreeSet::new();
        for head in heads
            .iter()
            .chain(manifest.history.get(key).into_iter().flatten())
        {
            if Uuid::parse_str(&head.id).is_err()
                || head.parents.len() > MAX_HEADS
                || head.digest.len() != 64
                || !head.digest.bytes().all(|byte| byte.is_ascii_hexdigit())
                || !ids.insert(&head.id)
                || head.parents.contains(&head.id)
            {
                return Err("同步清单版本无效".into());
            }
        }
    }
    if manifest
        .history
        .keys()
        .any(|key| !manifest.heads.contains_key(key))
        || manifest.history.values().map(Vec::len).sum::<usize>() > 100_000
    {
        return Err("同步清单版本历史无效".into());
    }
    Ok(())
}

fn descends_from(manifest: &Manifest, key: &str, head: &Version, ancestor: &str) -> bool {
    let versions: BTreeMap<_, _> = manifest
        .history
        .get(key)
        .into_iter()
        .flatten()
        .chain(manifest.heads.get(key).into_iter().flatten())
        .map(|version| (version.id.as_str(), version))
        .collect();
    let mut pending = vec![head.id.as_str()];
    let mut visited = BTreeSet::new();
    while let Some(id) = pending.pop() {
        if id == ancestor {
            return true;
        }
        if !visited.insert(id) {
            continue;
        }
        if let Some(version) = versions.get(id) {
            pending.extend(version.parents.iter().map(String::as_str));
        }
    }
    false
}

fn read_space(dav: &Dav, password: &str) -> Result<Option<(String, [u8; 32])>, String> {
    let Some((bytes, _)) = dav.read("space.cliora")? else {
        return Ok(None);
    };
    crypto::open_sync_space(password, &bytes).map(Some)
}

fn read_manifest(
    dav: &Dav,
    space_id: &str,
    key: &[u8; 32],
) -> Result<Option<(Manifest, String)>, String> {
    let Some((bytes, etag)) = dav.read("manifest.cliora")? else {
        return Ok(None);
    };
    let etag = etag.ok_or("WebDAV 未返回 ETag，无法安全同步")?;
    if etag.starts_with("W/") {
        return Err("WebDAV 返回弱 ETag，无法安全进行条件写入".into());
    }
    if crypto::peek_sync_space(&bytes)? != space_id {
        return Err("远端同步空间不匹配".into());
    }
    let plain = crypto::open_sync(key, space_id, &bytes)?;
    let manifest: Manifest =
        serde_json::from_slice(&plain).map_err(|_| "同步清单结构损坏".to_string())?;
    validate_manifest(&manifest, &space_id)?;
    Ok(Some((manifest, etag)))
}

fn save_manifest(
    dav: &Dav,
    manifest: &Manifest,
    key: &[u8; 32],
    etag: Option<&str>,
) -> Result<bool, String> {
    let mut upgraded = manifest.clone();
    upgraded.schema_version = 2;
    let manifest = &upgraded;
    validate_manifest(manifest, &manifest.space_id)?;
    let plain = serde_json::to_vec(manifest).map_err(|_| "无法整理同步清单".to_string())?;
    dav.put(
        "manifest.cliora",
        crypto::seal_sync(key, &manifest.space_id, &plain)?,
        etag,
    )
}

fn read_config(db: &Database) -> Result<Option<SyncConfig>, String> {
    db.with_connection(|conn| conn.query_row(
        "SELECT endpoint,username,auth_secret_id,space_secret_id,space_id,enabled,last_success,last_error,retry_after,failure_count FROM sync_config WHERE id=1", [], |row| Ok(SyncConfig {
            endpoint: row.get(0)?, username: row.get(1)?, auth_secret_id: row.get(2)?,
            space_secret_id: row.get(3)?, space_id: row.get(4)?, enabled: row.get::<_,i64>(5)? != 0,
            last_success: row.get(6)?, last_error: row.get(7)?, retry_after: row.get(8)?,
            failure_count: row.get::<_,i64>(9)?.max(0) as u32,
        })).optional().map_err(|error| error.to_string()))
}

pub fn status(db: &Database) -> Result<SyncStatus, String> {
    let config = read_config(db)?;
    let pending_rotation: Option<String> = db.with_connection(|conn| {
        conn.query_row(
            "SELECT value FROM app_settings WHERE key='sync_rotation_pending'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())
    })?;
    let pending_changes: usize = db.with_connection(|conn| {
        conn.query_row("SELECT count(*) FROM sync_outbox", [], |row| {
            row.get::<_, i64>(0)
        })
        .map(|count| count.max(0) as usize)
        .map_err(|error| error.to_string())
    })?;
    let conflicts: Vec<SyncConflict> = db.with_connection(|conn| {
        let value: Option<String> = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key='sync_conflicts'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        value
            .map(|text| serde_json::from_str(&text).map_err(|_| "同步冲突记录损坏".to_string()))
            .transpose()
            .map(|value| value.unwrap_or_default())
    })?;
    Ok(SyncStatus {
        configured: config.is_some(),
        enabled: config.as_ref().is_some_and(|item| item.enabled),
        endpoint: config.as_ref().map(|item| item.endpoint.clone()),
        last_success: config.as_ref().and_then(|item| item.last_success),
        last_error: config
            .as_ref()
            .and_then(|item| item.last_error.clone())
            .or(pending_rotation),
        retry_after: config.as_ref().map(|item| item.retry_after),
        uploaded: 0,
        downloaded: 0,
        pending_changes,
        conflicts,
    })
}

pub fn configure(
    db: &Database,
    store: &dyn CredentialStore,
    setup: SyncSetup,
) -> Result<SyncStatus, String> {
    #[cfg(test)]
    let fixture_lock = fixture_sync_lock(db)?;
    #[cfg(test)]
    let _guard = fixture_lock.try_lock().map_err(|_| "同步正在进行，请稍后修改配置".to_string())?;
    #[cfg(not(test))]
    let _guard = SYNC_LOCK
        .try_lock()
        .map_err(|_| "同步正在进行，请稍后修改配置".to_string())?;
    let url = endpoint(&setup.endpoint)?;
    if setup.username.is_empty() || setup.auth_password.is_empty() {
        return Err("请输入 WebDAV 用户名和密码".into());
    }
    let dav = Dav::new(url.clone(), &setup.username, &setup.auth_password)?;
    let old = read_config(db)?;
    let encryption_password = if setup.encryption_password.is_empty() {
        setup.auth_password.clone()
    } else {
        setup.encryption_password.clone()
    };
    if encryption_password.len() < 12 {
        return Err("WebDAV 密码至少 12 位，或设置独立加密口令".into());
    }
    let previous_password = if !setup.previous_encryption_password.is_empty() {
        Some(setup.previous_encryption_password.clone())
    } else if let Some(existing) = old.as_ref().filter(|item| item.endpoint == url.as_str()) {
        Some(store.get(&existing.space_secret_id)?)
    } else {
        None
    };
    let mut finalize_rotation = false;
    let (space_id, key, created_space) = match dav.read("space.cliora")? {
        Some((old_bytes, etag)) => {
            let opened = previous_password
                .as_deref()
                .and_then(|password| crypto::open_sync_space(password, &old_bytes).ok())
                .or_else(|| crypto::open_sync_space(&encryption_password, &old_bytes).ok())
                .ok_or("同步空间无法用当前或旧加密口令解锁；本机连接保持不变")?;
            let (space_id, key) = opened;
            if old.as_ref().is_some_and(|existing| {
                existing.endpoint == url.as_str() && existing.space_id != space_id
            }) {
                return Err("远端同步空间已更换；本机连接保持不变".into());
            }
            read_manifest(&dav, &space_id, &key)?.ok_or("远端同步清单缺失；请先恢复远端备份")?;
            test_connection(&dav)?;
            if crypto::open_primary_sync_space(&encryption_password, &old_bytes).is_err() {
                let etag = etag.ok_or("WebDAV 未返回同步空间 ETag，无法安全轮换口令")?;
                if etag.starts_with("W/") {
                    return Err("WebDAV 返回弱 ETag，无法安全轮换口令".into());
                }
                let next = crypto::stage_sync_space_rotation(
                    &space_id,
                    &key,
                    &encryption_password,
                    &old_bytes,
                )?;
                let verified = crypto::open_sync_space(&encryption_password, &next)?;
                if verified != (space_id.clone(), key) {
                    return Err("新同步口令验证失败".into());
                }
                if !dav.put("space.cliora", next, Some(&etag))? {
                    return Err("同步空间在口令轮换期间变化；本机连接保持不变".into());
                }
                let readback = dav
                    .read("space.cliora")?
                    .ok_or("轮换后同步空间无法读取；旧本机凭据已保留")?;
                if crypto::open_primary_sync_space(&encryption_password, &readback.0)?
                    != (space_id.clone(), key)
                {
                    return Err("轮换后同步空间验证失败；旧本机凭据已保留".into());
                }
                finalize_rotation = true;
            } else if old
                .as_ref()
                .is_some_and(|existing| existing.endpoint == url.as_str())
            {
                finalize_rotation = crypto::sync_space_has_previous(&old_bytes)?;
            }
            (space_id, key, false)
        }
        None => {
            if dav.read("manifest.cliora")?.is_some() {
                return Err(
                    "远端清单存在但空间密钥文件缺失；请先恢复远端备份，本机资料未改动".into(),
                );
            }
            let (space_id, key, space_bytes) = crypto::make_sync_space(&encryption_password)?;
            dav.mkdir_versions()?;
            if !dav.put("space.cliora", space_bytes, None)? {
                return Err("远端同步空间刚被其他设备建立，请重新连接".into());
            }
            (space_id, key, true)
        }
    };
    match read_manifest(&dav, &space_id, &key)? {
        Some(_) => {}
        None => {
            if !created_space {
                return Err("远端同步清单缺失；请先恢复远端备份，本机资料未改动".into());
            }
            let manifest = Manifest {
                schema_version: 2,
                space_id: space_id.clone(),
                heads: BTreeMap::new(),
                history: BTreeMap::new(),
            };
            if !save_manifest(&dav, &manifest, &key, None)? {
                return Err("远端同步空间刚被其他设备建立，请重新连接".into());
            }
        }
    }
    if created_space {
        test_connection(&dav)?;
    }
    let auth_id = format!("sync-auth-{}", Uuid::new_v4());
    let space_secret_id = format!("sync-space-{}", Uuid::new_v4());
    store.put(&auth_id, &setup.auth_password)?;
    if let Err(error) = store.put(&space_secret_id, &encryption_password) {
        let _ = store.delete(&auth_id);
        return Err(error);
    }
    let result = db.with_connection(|conn| {
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        if old.as_ref().is_some_and(|item| item.space_id != space_id || item.endpoint != url.as_str()) {
            tx.execute("DELETE FROM sync_entity_state", []).map_err(|error| error.to_string())?;
            tx.execute("DELETE FROM sync_seen", []).map_err(|error| error.to_string())?;
            tx.execute("DELETE FROM app_settings WHERE key='sync_conflicts'", []).map_err(|error| error.to_string())?;
        }
        tx.execute("INSERT INTO sync_config (id,endpoint,username,auth_secret_id,space_secret_id,space_id,epoch,enabled,last_success,last_error,retry_after,failure_count)
            VALUES (1,?1,?2,?3,?4,?5,1,?6,NULL,NULL,0,0)
            ON CONFLICT(id) DO UPDATE SET endpoint=excluded.endpoint,username=excluded.username,auth_secret_id=excluded.auth_secret_id,
            space_secret_id=excluded.space_secret_id,space_id=excluded.space_id,epoch=1,enabled=excluded.enabled,
            last_error=NULL,retry_after=0,failure_count=0",
            params![url.as_str(),setup.username,auth_id,space_secret_id,space_id,setup.enabled as i64])
            .map_err(|error| error.to_string())?;
        if finalize_rotation {
            tx.execute("INSERT INTO app_settings (key,value) VALUES ('sync_rotation_pending',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                ["口令轮换待完成：请重新验证并保存连接以移除旧包装"])
                .map_err(|error| error.to_string())?;
        } else {
            tx.execute("DELETE FROM app_settings WHERE key='sync_rotation_pending'", [])
                .map_err(|error| error.to_string())?;
        }
        tx.commit().map_err(|error| error.to_string())
    });
    if let Err(error) = result {
        let _ = store.delete(&auth_id);
        let _ = store.delete(&space_secret_id);
        return Err(error);
    }
    // Once committed, the current credentials work with either staged or finalized space headers.
    if let Some(old) = old {
        let _ = store.delete(&old.auth_secret_id);
        let _ = store.delete(&old.space_secret_id);
    }
    if finalize_rotation {
        let finish = (|| -> Result<(), String> {
            let (bytes, etag) = dav
                .read("space.cliora")?
                .ok_or("口令轮换待完成：远端空间无法读取")?;
            if crypto::open_primary_sync_space(&encryption_password, &bytes)?
                != (space_id.clone(), key)
            {
                return Err("口令轮换待完成：新口令无法验证远端空间".into());
            }
            let etag = etag.ok_or("口令轮换待完成：WebDAV 未返回 ETag")?;
            if etag.starts_with("W/") {
                return Err("WebDAV 返回弱 ETag，无法安全完成口令轮换".into());
            }
            if !dav.put(
                "space.cliora",
                crypto::finish_sync_space_rotation(&bytes)?,
                Some(&etag),
            )? {
                return Err("口令轮换待完成：远端空间已变化，请重试；旧与新口令仍可恢复".into());
            }
            let final_bytes = dav
                .read("space.cliora")?
                .ok_or("口令轮换后远端空间不可读取，请重试")?
                .0;
            if crypto::open_primary_sync_space(&encryption_password, &final_bytes)?
                != (space_id.clone(), key)
            {
                return Err("口令轮换后新口令验证失败，请重试".into());
            }
            Ok(())
        })();
        if let Err(error) = finish {
            let message =
                format!("口令轮换待完成：{error}；本机新凭据已保存，请重新验证并保存连接");
            let _ = db.with_connection(|conn| {
                let tx = conn.transaction().map_err(|error| error.to_string())?;
                tx.execute(
                    "UPDATE sync_config SET last_error=?1 WHERE id=1",
                    [&message],
                )
                .map_err(|error| error.to_string())?;
                tx.execute(
                    "UPDATE app_settings SET value=?1 WHERE key='sync_rotation_pending'",
                    [&message],
                )
                .map_err(|error| error.to_string())?;
                tx.commit().map_err(|error| error.to_string())
            });
            return Err(message);
        }
        db.with_connection(|conn| {
            conn.execute(
                "DELETE FROM app_settings WHERE key='sync_rotation_pending'",
                [],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })?;
    }
    status(db)
}

pub fn set_enabled(db: &Database, enabled: bool) -> Result<SyncStatus, String> {
    db.with_connection(|conn| {
        if conn
            .execute(
                "UPDATE sync_config SET enabled=?1 WHERE id=1",
                [enabled as i64],
            )
            .map_err(|error| error.to_string())?
            == 0
        {
            return Err("请先配置 WebDAV".into());
        }
        Ok(())
    })?;
    status(db)
}

fn local_states(db: &Database) -> Result<BTreeMap<String, LocalState>, String> {
    db.with_connection(|conn| {
        let mut statement = conn
            .prepare("SELECT entity_key,local_digest,heads_json,deleted FROM sync_entity_state")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        let mut result = BTreeMap::new();
        for row in rows {
            let (key, digest, heads, deleted) = row.map_err(|error| error.to_string())?;
            result.insert(
                key,
                LocalState {
                    digest,
                    heads: serde_json::from_str(&heads)
                        .map_err(|_| "本机同步状态损坏".to_string())?,
                    deleted: deleted != 0,
                },
            );
        }
        Ok(result)
    })
}

fn save_state(
    db: &Database,
    entity_key: &str,
    digest: &str,
    heads: &[String],
    deleted: bool,
) -> Result<(), String> {
    db.with_connection(|conn| {
        conn.execute("INSERT INTO sync_entity_state (entity_key,local_digest,heads_json,deleted) VALUES (?1,?2,?3,?4)
            ON CONFLICT(entity_key) DO UPDATE SET local_digest=excluded.local_digest,heads_json=excluded.heads_json,deleted=excluded.deleted",
            params![entity_key,digest,serde_json::to_string(heads).map_err(|error| error.to_string())?,deleted as i64])
            .map_err(|error| error.to_string())?;
        Ok(())
    })
}

fn version_path(id: &str) -> Result<String, String> {
    Uuid::parse_str(id).map_err(|_| "远端版本 ID 无效".to_string())?;
    Ok(format!("versions/{id}.cliora"))
}

fn read_version(
    dav: &Dav,
    key: &[u8; 32],
    space_id: &str,
    entity_key: &str,
    head: &Version,
) -> Result<Option<PortableEntity>, String> {
    let (bytes, _) = dav
        .read(&version_path(&head.id)?)?
        .ok_or("远端版本文件缺失")?;
    let plaintext = crypto::open_sync(key, space_id, &bytes)?;
    let object: VersionObject =
        serde_json::from_slice(&plaintext).map_err(|_| "远端版本结构损坏".to_string())?;
    if object.key != entity_key
        || object.version_id != head.id
        || object.entity.is_none() != head.deleted
    {
        return Err("远端版本与同步清单不匹配".into());
    }
    if let Some(entity) = &object.entity {
        if entity.key() != entity_key || entity.digest()? != head.digest {
            return Err("远端版本内容摘要不匹配".into());
        }
        super::validate_snapshot(&PortableSnapshot {
            schema_version: 2,
            entities: vec![entity.clone()],
        })?;
    }
    Ok(object.entity)
}

fn write_version(
    dav: &Dav,
    key: &[u8; 32],
    space_id: &str,
    entity_key: &str,
    version: &Version,
    entity: Option<PortableEntity>,
) -> Result<(), String> {
    let object = VersionObject {
        key: entity_key.into(),
        version_id: version.id.clone(),
        entity,
    };
    let plain = serde_json::to_vec(&object).map_err(|_| "无法整理同步版本".to_string())?;
    let path = version_path(&version.id)?;
    let bytes = crypto::seal_sync(key, space_id, &plain)?;
    if !dav.put(&path, bytes, None)? {
        return Err("远端版本 ID 已存在，已停止同步".into());
    }
    Ok(())
}

fn delete_local(
    db: &Database,
    store: &dyn CredentialStore,
    registry: &Registry,
    entity_key: &str,
    expected_digest: &str,
) -> Result<(), String> {
    let (kind, id) = entity_key.split_once(':').ok_or("同步实体标识无效")?;
    db.with_connection(|conn| {
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        let current = super::collect_snapshot_on(&tx, store, registry)?
            .entities
            .into_iter()
            .find(|entity| entity.key() == entity_key);
        if current
            .as_ref()
            .map(PortableEntity::digest)
            .transpose()?
            .unwrap_or_default()
            != expected_digest
        {
            return Err("本机资料已变化，请重新同步后处理冲突".into());
        }
        match kind {
            "preferences" => {
                tx.execute("DELETE FROM app_settings WHERE key='preferences'", [])
                    .map_err(|error| error.to_string())?;
            }
            "profile" => {
                let active: i64 = tx
                    .query_row(
                        "SELECT count(*) FROM applied_bindings WHERE profile_id=?1",
                        [id],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                if active > 0 {
                    return Err("远端已删除活动配置，请先在工具页切换后处理冲突".into());
                }
                tx.execute("DELETE FROM native_profiles WHERE id=?1", [id])
                    .map_err(|error| error.to_string())?;
            }
            "common" => {
                tx.execute("DELETE FROM common_configs WHERE tool=?1", [id])
                    .map_err(|error| error.to_string())?;
                crate::native::profile::invalidate_common_bindings(&tx, id)?;
            }
            "project" => {
                let local_path: Option<String> = tx
                    .query_row("SELECT path FROM projects WHERE id=?1", [id], |row| {
                        row.get(0)
                    })
                    .optional()
                    .map_err(|error| error.to_string())?
                    .flatten();
                let library_links: i64 = tx
                    .query_row(
                        "SELECT count(*) FROM library_items WHERE project_id=?1",
                        [id],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                if local_path.is_some() || library_links > 0 {
                    return Err("项目仍关联本机目录或资料，请先解除关联后处理删除冲突".into());
                }
                tx.execute(
                    "UPDATE library_items SET project_id=NULL WHERE project_id=?1",
                    [id],
                )
                .map_err(|error| error.to_string())?;
                tx.execute("DELETE FROM project_tool_models WHERE project_id=?1", [id])
                    .map_err(|error| error.to_string())?;
                tx.execute("DELETE FROM projects WHERE id=?1", [id])
                    .map_err(|error| error.to_string())?;
            }
            "library" => {
                tx.execute("DELETE FROM library_items WHERE id=?1", [id])
                    .map_err(|error| error.to_string())?;
            }
            "mcp" => {
                tx.execute("DELETE FROM mcp_definitions WHERE id=?1", [id])
                    .map_err(|error| error.to_string())?;
            }
            "skill" => {
                tx.execute("DELETE FROM skill_packages WHERE id=?1", [id])
                    .map_err(|error| error.to_string())?;
            }
            _ => return Err("未知同步资料类型".into()),
        }
        tx.commit().map_err(|error| error.to_string())
    })
}

fn apply_remote(
    db: &Database,
    store: &dyn CredentialStore,
    registry: &Registry,
    dav: &Dav,
    key: &[u8; 32],
    space_id: &str,
    entity_key: &str,
    head: &Version,
    expected_digest: &str,
) -> Result<(), String> {
    apply_entity(
        db,
        store,
        registry,
        entity_key,
        read_version(dav, key, space_id, entity_key, head)?,
        expected_digest,
    )
}

fn apply_entity(
    db: &Database,
    store: &dyn CredentialStore,
    registry: &Registry,
    entity_key: &str,
    entity: Option<PortableEntity>,
    expected_digest: &str,
) -> Result<(), String> {
    match entity {
        Some(entity) => {
            let draft = preview_import(
                db,
                store,
                registry,
                PortableSnapshot {
                    schema_version: 2,
                    entities: vec![entity],
                },
            )?;
            if draft
                .baseline
                .get(entity_key)
                .and_then(|digest| digest.as_deref())
                .unwrap_or("")
                != expected_digest
            {
                return Err("本机资料已变化，请重新同步后处理冲突".into());
            }
            apply_import(
                db,
                store,
                registry,
                &draft,
                &BTreeSet::from([entity_key.to_owned()]),
            )?;
        }
        None => delete_local(db, store, registry, entity_key, expected_digest)?,
    }
    Ok(())
}

fn record_local_race(
    db: &Database,
    store: &dyn CredentialStore,
    registry: &Registry,
    status: &mut SyncStatus,
    entity_key: &str,
    head: &Version,
) -> Result<(), String> {
    let current = collect_snapshot(db, store, registry)?
        .entities
        .into_iter()
        .find(|entity| entity.key() == entity_key);
    status.conflicts.push(SyncConflict {
        key: entity_key.into(),
        label: current
            .as_ref()
            .map(PortableEntity::label)
            .unwrap_or_else(|| "本机资料".into()),
        local_present: current.is_some(),
        local_digest: current
            .as_ref()
            .map(PortableEntity::digest)
            .transpose()?
            .unwrap_or_default(),
        remote_versions: 1,
        remote_deleted: head.deleted,
        versions: vec![SyncConflictVersion {
            id: head.id.clone(),
            digest: head.digest.clone(),
            deleted: head.deleted,
        }],
    });
    Ok(())
}

fn seen_versions(db: &Database) -> Result<BTreeSet<String>, String> {
    db.with_connection(|conn| {
        let mut statement = conn
            .prepare("SELECT id FROM sync_seen")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<BTreeSet<_>, _>>()
            .map_err(|error| error.to_string())
    })
}

fn mark_seen(db: &Database, ids: &[String]) -> Result<(), String> {
    db.with_connection(|conn| {
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        for id in ids {
            tx.execute("INSERT OR IGNORE INTO sync_seen (id) VALUES (?1)", [id])
                .map_err(|error| error.to_string())?;
        }
        tx.commit().map_err(|error| error.to_string())
    })
}

fn outbox_tokens(db: &Database) -> Result<BTreeMap<String, String>, String> {
    db.with_connection(|conn| {
        let mut statement = conn
            .prepare("SELECT id,object_json FROM sync_outbox")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<BTreeMap<_, _>, _>>()
            .map_err(|error| error.to_string())
    })
}

fn clear_outbox(
    db: &Database,
    keys: &BTreeSet<String>,
    tokens: &BTreeMap<String, String>,
) -> Result<(), String> {
    db.with_connection(|conn| {
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        for key in keys {
            if let Some(token) = tokens.get(key) {
                tx.execute(
                    "DELETE FROM sync_outbox WHERE id=?1 AND object_json=?2",
                    params![key, token],
                )
                .map_err(|error| error.to_string())?;
            }
        }
        tx.commit().map_err(|error| error.to_string())
    })
}

fn merge_head(heads: &mut Vec<Version>, version: Version) -> Result<(), String> {
    let parents: BTreeSet<_> = version.parents.iter().collect();
    heads.retain(|head| !parents.contains(&head.id));
    heads.push(version);
    if heads.len() > MAX_HEADS {
        return Err("远端同项版本过多，请先处理同步冲突".into());
    }
    Ok(())
}

fn run_once(
    db: &Database,
    store: &dyn CredentialStore,
    registry: &Registry,
    config: &SyncConfig,
) -> Result<SyncStatus, String> {
    let dav = Dav::new(
        endpoint(&config.endpoint)?,
        &config.username,
        &store.get(&config.auth_secret_id)?,
    )?;
    let password = store.get(&config.space_secret_id)?;
    let (space_id, key) =
        read_space(&dav, &password)?.ok_or("远端同步空间缺失，请检查地址；本机资料未改动")?;
    if space_id != config.space_id {
        return Err("远端同步空间已更换，本机资料未改动".into());
    }
    let (mut manifest, etag) = read_manifest(&dav, &space_id, &key)?
        .ok_or("远端同步清单缺失，请检查地址；本机资料未改动")?;
    if manifest.space_id != config.space_id {
        return Err("远端同步空间已更换，本机资料未改动".into());
    }
    let pending_tokens = outbox_tokens(db)?;
    let snapshot = collect_snapshot(db, store, registry)?;
    let seen = seen_versions(db)?;
    let mut verified = BTreeMap::new();
    for (entity_key, heads) in &manifest.heads {
        for head in heads {
            if !seen.contains(&head.id) {
                let entity = read_version(&dav, &key, &manifest.space_id, entity_key, head)?;
                verified.insert((entity_key.clone(), head.id.clone()), entity);
            }
        }
    }
    let local: BTreeMap<String, PortableEntity> = snapshot
        .entities
        .into_iter()
        .map(|item| (item.key(), item))
        .collect();
    let states = local_states(db)?;
    let mut all_keys: BTreeSet<String> = local.keys().cloned().collect();
    all_keys.extend(states.keys().cloned());
    all_keys.extend(manifest.heads.keys().cloned());
    let mut status = status(db)?;
    status.conflicts.clear();
    let mut pending_states = Vec::new();
    let mut changed_manifest = false;
    let mut processed_keys = BTreeSet::new();
    for entity_key in all_keys {
        processed_keys.insert(entity_key.clone());
        let current = local.get(&entity_key);
        let current_digest = current
            .map(PortableEntity::digest)
            .transpose()?
            .unwrap_or_default();
        let known = states.get(&entity_key);
        let remote = manifest.heads.get(&entity_key).cloned().unwrap_or_default();
        if known.is_some_and(|state| !state.heads.is_empty()) && remote.is_empty() {
            return Err("远端同步清单缺少已知版本，可能被截断；本机资料未覆盖".into());
        }
        if remote.len() == 1 && !remote[0].deleted && remote[0].digest == current_digest {
            save_state(
                db,
                &entity_key,
                &current_digest,
                &[remote[0].id.clone()],
                false,
            )?;
            continue;
        }
        let local_changed = known.map_or(current.is_some(), |state| {
            state.digest != current_digest || state.deleted != current.is_none()
        });
        let remote_changed = known.map_or(!remote.is_empty(), |state| {
            remote.len() != state.heads.len()
                || remote.iter().any(|head| !state.heads.contains(&head.id))
        });
        let safe_remote_lineage = known.is_none_or(|state| {
            state.heads.iter().all(|id| {
                remote
                    .first()
                    .is_some_and(|head| descends_from(&manifest, &entity_key, head, id))
            })
        });
        if !local_changed && remote.len() == 1 && remote_changed && safe_remote_lineage {
            let inbound = verified
                .get(&(entity_key.clone(), remote[0].id.clone()))
                .cloned();
            let outcome = if let Some(entity) = inbound {
                apply_entity(db, store, registry, &entity_key, entity, &current_digest)
            } else {
                apply_remote(
                    db,
                    store,
                    registry,
                    &dav,
                    &key,
                    &manifest.space_id,
                    &entity_key,
                    &remote[0],
                    &current_digest,
                )
            };
            match outcome {
                Ok(()) => {
                    save_state(
                        db,
                        &entity_key,
                        &remote[0].digest,
                        &[remote[0].id.clone()],
                        remote[0].deleted,
                    )?;
                    status.downloaded += 1;
                    continue;
                }
                Err(error)
                    if remote[0].deleted
                        && (error.contains("活动配置") || error.contains("仍关联")) => {}
                Err(error) if error.starts_with("本机资料已变化") => {
                    record_local_race(db, store, registry, &mut status, &entity_key, &remote[0])?;
                    continue;
                }
                Err(error) => return Err(error),
            }
        }
        if known.is_none() && current.is_none() && remote.len() == 1 {
            let incoming = if let Some(entity) = verified
                .get(&(entity_key.clone(), remote[0].id.clone()))
                .cloned()
            {
                apply_entity(db, store, registry, &entity_key, entity, &current_digest)
            } else {
                apply_remote(
                    db,
                    store,
                    registry,
                    &dav,
                    &key,
                    &manifest.space_id,
                    &entity_key,
                    &remote[0],
                    &current_digest,
                )
            };
            if let Err(error) = incoming {
                if error.starts_with("本机资料已变化") {
                    record_local_race(db, store, registry, &mut status, &entity_key, &remote[0])?;
                    continue;
                }
                return Err(error);
            }
            save_state(
                db,
                &entity_key,
                &remote[0].digest,
                &[remote[0].id.clone()],
                remote[0].deleted,
            )?;
            status.downloaded += 1;
            continue;
        }
        if local_changed {
            let parents = known.map(|state| state.heads.clone()).unwrap_or_default();
            let version = Version {
                id: Uuid::new_v4().to_string(),
                parents,
                digest: if current.is_none() {
                    "0".repeat(64)
                } else {
                    current_digest.clone()
                },
                deleted: current.is_none(),
            };
            dav.mkdir_versions()?;
            write_version(
                &dav,
                &key,
                &manifest.space_id,
                &entity_key,
                &version,
                current.cloned(),
            )?;
            let heads = manifest.heads.entry(entity_key.clone()).or_default();
            let previous = heads.clone();
            merge_head(heads, version.clone())?;
            let removed: Vec<_> = previous
                .into_iter()
                .filter(|old| !heads.iter().any(|head| head.id == old.id))
                .collect();
            manifest
                .history
                .entry(entity_key.clone())
                .or_default()
                .extend(removed);
            pending_states.push((
                entity_key.clone(),
                current_digest.clone(),
                vec![version.id],
                current.is_none(),
            ));
            changed_manifest = true;
            status.uploaded += 1;
        }
        let heads = manifest.heads.get(&entity_key).cloned().unwrap_or_default();
        if heads.len() > 1
            || !safe_remote_lineage
            || (heads.len() == 1 && heads[0].deleted && current.is_some())
        {
            status.conflicts.push(SyncConflict {
                key: entity_key,
                label: current
                    .map(PortableEntity::label)
                    .unwrap_or_else(|| "远端资料".into()),
                local_present: current.is_some(),
                local_digest: current_digest,
                remote_versions: heads.len(),
                remote_deleted: heads.iter().any(|head| head.deleted),
                versions: heads
                    .iter()
                    .map(|head| SyncConflictVersion {
                        id: head.id.clone(),
                        digest: head.digest.clone(),
                        deleted: head.deleted,
                    })
                    .collect(),
            });
        }
    }
    if changed_manifest && !save_manifest(&dav, &manifest, &key, Some(&etag))? {
        return Err("远端在同步期间被其他设备更新，请稍后重试；本机资料未覆盖".into());
    }
    for (entity_key, digest, heads, deleted) in pending_states {
        save_state(db, &entity_key, &digest, &heads, deleted)?;
    }
    let all_head_ids: Vec<String> = manifest
        .heads
        .values()
        .flat_map(|heads| heads.iter().map(|head| head.id.clone()))
        .collect();
    mark_seen(db, &all_head_ids)?;
    for conflict in &status.conflicts {
        processed_keys.remove(&conflict.key);
    }
    clear_outbox(db, &processed_keys, &pending_tokens)?;
    status.pending_changes = self::status(db)?.pending_changes;
    Ok(status)
}

pub fn run(
    db: &Database,
    store: &dyn CredentialStore,
    registry: &Registry,
    background: bool,
) -> Result<SyncStatus, String> {
    #[cfg(test)]
    let fixture_lock = fixture_sync_lock(db)?;
    #[cfg(test)]
    let _guard = fixture_lock.try_lock().map_err(|_| "同步正在进行，请稍后查看".to_string())?;
    #[cfg(not(test))]
    let _guard = SYNC_LOCK
        .try_lock()
        .map_err(|_| "同步正在进行，请稍后查看".to_string())?;
    let config = read_config(db)?.ok_or("请先配置 WebDAV".to_string())?;
    if background && (!config.enabled || config.retry_after > now()) {
        return status(db);
    }
    match run_once(db, store, registry, &config) {
        Ok(mut result) => {
            let complete = result.conflicts.is_empty();
            let previous_success = config.last_success;
            db.with_connection(|conn| {
                let tx = conn.transaction().map_err(|error| error.to_string())?;
                tx.execute("UPDATE sync_config SET last_success=CASE WHEN ?1 THEN ?2 ELSE last_success END,last_error=NULL,retry_after=0,failure_count=0 WHERE id=1",
                    params![complete,now()])
                    .map_err(|error| error.to_string())?;
                tx.execute("INSERT INTO app_settings (key,value) VALUES ('sync_conflicts',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    [serde_json::to_string(&result.conflicts).map_err(|error| error.to_string())?])
                    .map_err(|error| error.to_string())?;
                tx.commit().map_err(|error| error.to_string())
            })?;
            result.last_success = if complete {
                Some(now())
            } else {
                previous_success
            };
            result.last_error = status(db)?.last_error;
            result.retry_after = Some(0);
            Ok(result)
        }
        Err(error) => {
            let failures = config.failure_count.saturating_add(1);
            let delay = (30_i64.saturating_mul(1_i64 << failures.min(7))).min(3600);
            let retry_after = now() + delay;
            let _ = db.with_connection(|conn| {
                conn.execute("UPDATE sync_config SET last_error=?1,retry_after=?2,failure_count=?3 WHERE id=1",
                    params![error,retry_after,failures as i64]).map_err(|failure| failure.to_string())?; Ok(())
            });
            Err(error)
        }
    }
}

pub fn resolve(
    db: &Database,
    store: &dyn CredentialStore,
    registry: &Registry,
    entity_key: &str,
    chosen_version_id: Option<&str>,
) -> Result<SyncStatus, String> {
    #[cfg(test)]
    let fixture_lock = fixture_sync_lock(db)?;
    #[cfg(test)]
    let _guard = fixture_lock.try_lock().map_err(|_| "同步正在进行，请稍后处理冲突".to_string())?;
    #[cfg(not(test))]
    let _guard = SYNC_LOCK
        .try_lock()
        .map_err(|_| "同步正在进行，请稍后处理冲突".to_string())?;
    let config = read_config(db)?.ok_or("请先配置 WebDAV".to_string())?;
    let dav = Dav::new(
        endpoint(&config.endpoint)?,
        &config.username,
        &store.get(&config.auth_secret_id)?,
    )?;
    let password = store.get(&config.space_secret_id)?;
    let (space_id, key) = read_space(&dav, &password)?.ok_or("远端同步空间缺失")?;
    if space_id != config.space_id {
        return Err("远端同步空间已更换".into());
    }
    let (mut manifest, etag) = read_manifest(&dav, &space_id, &key)?.ok_or("远端同步清单缺失")?;
    if manifest.space_id != config.space_id {
        return Err("远端同步空间已更换".into());
    }
    let heads = manifest
        .heads
        .get(entity_key)
        .cloned()
        .ok_or("远端冲突已变化，请重新同步")?;
    let previewed = status(db)?
        .conflicts
        .into_iter()
        .find(|item| item.key == entity_key)
        .ok_or("冲突预览已失效，请重新同步")?;
    let previewed_ids: BTreeSet<_> = previewed.versions.iter().map(|item| &item.id).collect();
    let current_ids: BTreeSet<_> = heads.iter().map(|item| &item.id).collect();
    if previewed_ids != current_ids {
        return Err("远端冲突版本已变化，请重新同步".into());
    }
    let pending_tokens = outbox_tokens(db)?;
    let local = collect_snapshot(db, store, registry)?
        .entities
        .into_iter()
        .find(|item| item.key() == entity_key);
    let digest = local
        .as_ref()
        .map(PortableEntity::digest)
        .transpose()?
        .unwrap_or_default();
    if previewed.local_digest != digest {
        return Err("本机资料已变化，请重新同步后处理冲突".into());
    }
    let chosen = if let Some(id) = chosen_version_id {
        let head = heads
            .iter()
            .find(|item| item.id == id)
            .ok_or("远端版本已变化，请重新同步")?;
        let entity = read_version(&dav, &key, &config.space_id, entity_key, head)?;
        if entity.is_none() && entity_key.starts_with("profile:") {
            let profile_id = entity_key.trim_start_matches("profile:");
            let active: i64 = db.with_connection(|conn| {
                conn.query_row(
                    "SELECT count(*) FROM applied_bindings WHERE profile_id=?1",
                    [profile_id],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())
            })?;
            if active > 0 {
                return Err("活动配置仍在使用，先切换后才能接受远端删除".into());
            }
        }
        if entity.is_none() && entity_key.starts_with("project:") {
            let project_id = entity_key.trim_start_matches("project:");
            let (local_path, links): (Option<String>, i64) = db.with_connection(|conn| {
                let local_path: Option<String> = conn
                    .query_row(
                        "SELECT path FROM projects WHERE id=?1",
                        [project_id],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|error| error.to_string())?
                    .flatten();
                let links = conn
                    .query_row(
                        "SELECT count(*) FROM library_items WHERE project_id=?1",
                        [project_id],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                Ok((local_path, links))
            })?;
            if local_path.is_some() || links > 0 {
                return Err("项目仍关联本机目录或资料，请先解除关联后处理删除冲突".into());
            }
        }
        entity
    } else {
        local.clone()
    };
    let resolved_digest = chosen
        .as_ref()
        .map(PortableEntity::digest)
        .transpose()?
        .unwrap_or_else(|| "0".repeat(64));
    let version = Version {
        id: Uuid::new_v4().to_string(),
        parents: heads.iter().map(|head| head.id.clone()).collect(),
        digest: resolved_digest.clone(),
        deleted: chosen.is_none(),
    };
    dav.mkdir_versions()?;
    write_version(
        &dav,
        &key,
        &config.space_id,
        entity_key,
        &version,
        chosen.clone(),
    )?;
    manifest
        .history
        .entry(entity_key.into())
        .or_default()
        .extend(heads);
    manifest
        .heads
        .insert(entity_key.into(), vec![version.clone()]);
    if !save_manifest(&dav, &manifest, &key, Some(&etag))? {
        return Err("远端在处理冲突时变化，请重新同步；本机资料未覆盖".into());
    }
    if chosen_version_id.is_some() {
        apply_remote(
            db,
            store,
            registry,
            &dav,
            &key,
            &config.space_id,
            entity_key,
            &version,
            &digest,
        )?;
    }
    save_state(
        db,
        entity_key,
        &resolved_digest,
        &[version.id],
        chosen.is_none(),
    )?;
    clear_outbox(
        db,
        &BTreeSet::from([entity_key.to_owned()]),
        &pending_tokens,
    )?;
    db.with_connection(|conn| {
        let text: Option<String> = conn.query_row("SELECT value FROM app_settings WHERE key='sync_conflicts'",[],|row| row.get(0))
            .optional().map_err(|error| error.to_string())?;
        let mut conflicts: Vec<SyncConflict> = text.map(|text| serde_json::from_str(&text)
            .map_err(|_| "同步冲突记录损坏".to_string())).transpose()?.unwrap_or_default();
        conflicts.retain(|item| item.key != entity_key);
        conn.execute("INSERT INTO app_settings (key,value) VALUES ('sync_conflicts',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [serde_json::to_string(&conflicts).map_err(|error| error.to_string())?]).map_err(|error| error.to_string())?;
        Ok(())
    })?;
    status(db)
}

fn summary(entity: Option<&PortableEntity>) -> String {
    let Some(entity) = entity else {
        return "此版本已删除".into();
    };
    match &entity.payload {
        PortablePayload::Preferences(value) => format!(
            "主题：{}；管理 {} 个 CLI",
            value.theme,
            value.managed_tools.len()
        ),
        PortablePayload::Profile(value) => format!(
            "{} · {} · {} · {}",
            value.profile.name,
            value.profile.tool,
            value
                .profile
                .connection
                .as_ref()
                .map(|item| item.interface_format.as_str())
                .unwrap_or("原生配置"),
            value
                .profile
                .connection
                .as_ref()
                .map(|item| item.model.as_str())
                .unwrap_or("默认模型")
        ),
        PortablePayload::Common(value) => {
            format!("{} · {} 个原生文件", value.tool, value.files.len())
        }
        PortablePayload::Project(value) => format!(
            "{} · {} 个模型偏好",
            value.name,
            value.model_overrides.len()
        ),
        PortablePayload::Library(value) => format!(
            "{} · {}",
            value.title,
            value.body.chars().take(180).collect::<String>()
        ),
        PortablePayload::Mcp(value) => format!(
            "{} · {:?}",
            value.definition.name, value.definition.transport
        ),
        PortablePayload::Skill(value) => format!(
            "{} · {} · {} 个文件",
            value.name,
            value.description,
            value.files.len()
        ),
    }
}

pub fn preview_conflict(
    db: &Database,
    store: &dyn CredentialStore,
    registry: &Registry,
    entity_key: &str,
) -> Result<ConflictPreview, String> {
    let config = read_config(db)?.ok_or("请先配置 WebDAV".to_string())?;
    let recorded = status(db)?
        .conflicts
        .into_iter()
        .find(|item| item.key == entity_key)
        .ok_or("冲突预览已失效，请重新同步")?;
    let dav = Dav::new(
        endpoint(&config.endpoint)?,
        &config.username,
        &store.get(&config.auth_secret_id)?,
    )?;
    let password = store.get(&config.space_secret_id)?;
    let (space_id, key) = read_space(&dav, &password)?.ok_or("远端同步空间缺失")?;
    if space_id != config.space_id {
        return Err("远端同步空间已更换".into());
    }
    let (manifest, _) = read_manifest(&dav, &space_id, &key)?.ok_or("远端同步清单缺失")?;
    let heads = manifest.heads.get(entity_key).ok_or("远端冲突已变化")?;
    let recorded_ids: BTreeSet<_> = recorded.versions.iter().map(|item| &item.id).collect();
    if heads.iter().map(|item| &item.id).collect::<BTreeSet<_>>() != recorded_ids {
        return Err("远端冲突已变化，请重新同步".into());
    }
    let local = collect_snapshot(db, store, registry)?
        .entities
        .into_iter()
        .find(|item| item.key() == entity_key);
    if local
        .as_ref()
        .map(PortableEntity::digest)
        .transpose()?
        .unwrap_or_default()
        != recorded.local_digest
    {
        return Err("本机资料已变化，请重新同步".into());
    }
    let mut versions = Vec::new();
    for head in heads {
        let value = read_version(&dav, &key, &space_id, entity_key, head)?;
        versions.push(ConflictVersionPreview {
            id: head.id.clone(),
            summary: summary(value.as_ref()),
            deleted: head.deleted,
        });
    }
    Ok(ConflictPreview {
        key: entity_key.into(),
        local_summary: summary(local.as_ref()),
        versions,
    })
}

#[cfg(test)]
#[path = "../../tests/sync/sync.rs"]
mod tests;
