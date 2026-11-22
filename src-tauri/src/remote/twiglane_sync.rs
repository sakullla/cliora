//! Cross-application host sync (host-sync v1, R4/R7) on Cliora's side.
//!
//! The same headless contract Twiglane implements lives here: Twiglane and Cliora
//! each expose one "--host-sync-v1" entry point that works with the desktop closed.
//! A jump creates a single-use, short-lived session for exactly one host; the deep
//! link carries only the session reference, and the private helper pipe carries the
//! configuration fingerprint, the password equality proof, and - only when it is
//! really missing or different - the password itself, which goes straight to the
//! local credential store. Private key material is never transferred, only paths.
//!
//! Differences from Twiglane's implementation come from the store: Cliora keeps
//! targets in SQLite, so the cross-application identity lives in its own table and
//! a link edit never rewrites a target row or its revision (updated_at).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::credentials::CredentialStore;
use crate::database::Database;

use super::{password, RemoteTarget};

/// Protocol flag; both applications answer the same name so a peer only has to
/// know the other side's executable path.
pub const FLAG: &str = "--host-sync-v1";
const PROTOCOL: u64 = 1;
const KIND: &str = "host-sync-v1";
const TTL_SECONDS: u64 = 120;
const MAX_CHECKS: u32 = 8;
const MAX_FETCHES: u32 = 2;
const MAX_SESSIONS: usize = 16;
const MAX_FIELD: usize = 4096;

type Result<T> = std::result::Result<T, &'static str>;

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

fn hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Non-secret configuration shared between the two applications. enabled is not
/// part of it: the receiving application decides enablement itself.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostConfig {
    pub display_name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth_method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh_config: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_path: Option<String>,
}

impl HostConfig {
    fn of(target: &RemoteTarget) -> Self {
        Self {
            display_name: target.name.clone(),
            host: target.host.clone(),
            port: target.port,
            user: target.user.clone(),
            auth_method: target.auth_method.clone(),
            identity_file: target.identity_file.clone(),
            ssh_config: target.ssh_config.clone(),
            default_path: target.default_path.clone(),
        }
    }

    /// Canonical fingerprint: fixed field order, None distinguishable from empty.
    fn fingerprint(&self) -> String {
        let canonical = format!(
            "host-sync-config-v1\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}",
            self.display_name,
            self.host,
            self.port,
            self.user,
            self.auth_method,
            self.identity_file.as_deref().unwrap_or("-none"),
            self.ssh_config.as_deref().unwrap_or("-none"),
            self.default_path.as_deref().unwrap_or("-none"),
        );
        let mut digest = Sha256::new();
        digest.update(canonical.as_bytes());
        format!("{:x}", digest.finalize())
    }

    fn valid(&self) -> bool {
        !self.display_name.trim().is_empty()
            && self.display_name.len() <= 64
            && !self.display_name.chars().any(char::is_control)
            && !self.host.trim().is_empty()
            && !self.user.trim().is_empty()
            && self.port > 0
            && matches!(self.auth_method.as_str(), "key" | "password" | "agent")
            && [&self.identity_file, &self.ssh_config, &self.default_path]
                .into_iter()
                .flatten()
                .map(String::as_str)
                .all(|path| !path.is_empty() && path.len() <= MAX_FIELD)
    }

    fn apply_to(&self, target: &RemoteTarget) -> RemoteTarget {
        RemoteTarget {
            name: self.display_name.clone(),
            host: self.host.clone(),
            port: self.port,
            user: self.user.clone(),
            auth_method: self.auth_method.clone(),
            identity_file: self.identity_file.clone(),
            ssh_config: self.ssh_config.clone(),
            default_path: self.default_path.clone(),
            ..target.clone()
        }
    }
}

/// HMAC-SHA256 over the existing sha2 dependency; no new crate for one primitive.
fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut block = [0u8; 64];
    if key.len() > 64 {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(block.map(|byte| byte ^ 0x36));
    inner.update(message);
    let inner = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(block.map(|byte| byte ^ 0x5c));
    outer.update(inner);
    let mut output = [0u8; 32];
    output.copy_from_slice(&outer.finalize());
    output
}

/// Password equality proof. Both sides derive the same digest from the same
/// session reference and challenge; the plaintext password never leaves.
pub fn proof(password: &str, session_ref: &str, challenge: &str) -> String {
    let message = format!("twiglane-host-sync-v1\n{session_ref}\n{challenge}");
    let digest = hmac_sha256(password.as_bytes(), message.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn random_hex() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

/// Data directory holding the desktop database; the helper resolves it the same
/// way so a sync works while the desktop is closed.
fn data_dir() -> Result<PathBuf> {
    if let Some(dir) = std::env::var_os("CLIORA_HOST_SYNC_DATA_DIR") {
        let dir = PathBuf::from(dir);
        if dir.is_absolute() {
            return Ok(dir);
        }
        return Err("host_sync_request");
    }
    dirs::data_dir()
        .map(|dir| dir.join("com.cliora.desktop"))
        .ok_or("host_sync_unavailable")
}

fn database_path() -> Result<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("CLIORA_TWIGLANE_TEST_DB") {
        let path = PathBuf::from(path);
        return path
            .is_absolute()
            .then_some(path)
            .ok_or("host_sync_unavailable");
    }
    Ok(data_dir()?.join("cliora.db"))
}

fn sessions_dir(db: &Path) -> Result<PathBuf> {
    if let Some(dir) = std::env::var_os("CLIORA_HOST_SYNC_DIR") {
        let dir = PathBuf::from(dir);
        return dir.is_absolute().then_some(dir).ok_or("host_sync_request");
    }
    db.parent()
        .map(|parent| parent.join("host-sync"))
        .ok_or("host_sync_unavailable")
}

fn prepare_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path).map_err(|_| "host_sync_unavailable")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|_| "host_sync_unavailable")?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "host_sync_unavailable")
}

/// One session. Only non-secret facts: host id, begin-time configuration, link id
/// and counters.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    protocol: u64,
    session_ref: String,
    host_id: String,
    host_config: HostConfig,
    config_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    shared_host_id: Option<String>,
    created_at: u64,
    expires_at: u64,
    checks: u32,
    fetches: u32,
}

impl Session {
    fn alive(&self, reference: &str) -> bool {
        self.protocol == PROTOCOL && self.session_ref == reference && now() < self.expires_at
    }
}

/// Cross-application identity. Kept outside the target table so linking never
/// rewrites a host record or its revision.
fn shared_id(db: &Database, target_id: &str) -> Result<Option<String>> {
    db.with_connection(|conn| {
        conn.query_row(
            "SELECT shared_host_id FROM remote_host_links WHERE target_id=?1",
            [target_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())
    })
    .map_err(|_| "host_sync_unavailable")
}

fn target_for_shared(db: &Database, shared: &str) -> Result<Option<String>> {
    db.with_connection(|conn| {
        conn.query_row(
            "SELECT target_id FROM remote_host_links WHERE shared_host_id=?1",
            [shared],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())
    })
    .map_err(|_| "host_sync_unavailable")
}

fn bind_identity(conn: &rusqlite::Connection, target_id: &str, shared: &str) -> std::result::Result<bool, String> {
    conn.execute(
        "INSERT INTO remote_host_links(target_id,shared_host_id,updated_at) VALUES(?1,?2,?3) ON CONFLICT DO NOTHING",
        rusqlite::params![target_id, shared, now() as i64],
    ).map_err(|e| e.to_string())?;
    conn.query_row("SELECT EXISTS(SELECT 1 FROM remote_host_links WHERE target_id=?1 AND shared_host_id=?2)",
        [target_id,shared], |r| r.get(0)).map_err(|e| e.to_string())
}

fn set_shared(db: &Database, target_id: &str, shared: &str) -> Result<()> {
    let bound = db.with_connection(|conn| bind_identity(conn, target_id, shared)).map_err(|_| "host_sync_unavailable")?;
    if bound { Ok(()) } else { Err("association_conflict") }
}

fn matching_unlinked(db: &Database, host: &str) -> Result<Vec<Value>> {
    db.with_read_connection(|conn| {
        let mut stmt = conn.prepare(
            "SELECT t.id,t.name,t.host,t.port,t.user_name FROM remote_targets t
             WHERE t.host=?1 COLLATE NOCASE AND NOT EXISTS
               (SELECT 1 FROM remote_host_links l WHERE l.target_id=t.id)
             ORDER BY t.name COLLATE NOCASE,t.id"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([host], |r| Ok(json!({
            "hostId": r.get::<_,String>(0)?, "displayName": r.get::<_,String>(1)?,
            "host": r.get::<_,String>(2)?, "port": r.get::<_,u16>(3)?, "user": r.get::<_,String>(4)?,
        }))).map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())
    }).map_err(|_| "host_sync_unavailable")
}

fn target_by_id(db: &Database, id: &str) -> Result<RemoteTarget> {
    super::target(db, id).map_err(|e| match e {
        super::RemoteError::NotFound => "target_unavailable",
        _ => "host_sync_unavailable",
    })
}

fn local_password(
    secrets: &dyn CredentialStore,
    target_id: &str,
) -> std::result::Result<Option<String>, String> {
    secrets.lookup(&password::credential_id(target_id))
}

/// Source side: answers check/fetch from this application's own store.
struct Source<'a> {
    db: &'a Database,
    secrets: &'a dyn CredentialStore,
    dir: PathBuf,
}

impl<'a> Source<'a> {
    fn path(&self, reference: &str) -> PathBuf {
        self.dir.join(format!("{reference}.json"))
    }

    fn prune(&self) {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let session = fs::read_to_string(&path)
                .ok()
                .and_then(|raw| serde_json::from_str::<Session>(&raw).ok());
            if session.is_none_or(|session| now() >= session.expires_at) {
                let _ = fs::remove_file(&path);
            }
        }
    }

    fn load(&self, reference: &str) -> Result<Session> {
        if !hex64(reference) {
            return Err("host_sync_request");
        }
        let path = self.path(reference);
        let raw = fs::read_to_string(&path).map_err(|_| "session_expired")?;
        let session: Session = serde_json::from_str(&raw).map_err(|_| "session_expired")?;
        if !session.alive(reference) {
            let _ = fs::remove_file(&path);
            return Err("session_expired");
        }
        Ok(session)
    }

    fn store_session(&self, session: &Session) -> Result<()> {
        prepare_dir(&self.dir)?;
        let raw = serde_json::to_vec(session).map_err(|_| "host_sync_request")?;
        write_private(&self.path(&session.session_ref), &raw)
    }

    /// The session froze one host at begin time; a later edit invalidates it so an
    /// outdated configuration is never handed to the other application.
    fn current(&self, session: &Session) -> Result<RemoteTarget> {
        let target = target_by_id(self.db, &session.host_id)?;
        if target.updated_at != session.config_revision
            || HostConfig::of(&target).fingerprint() != session.host_config.fingerprint()
        {
            let _ = fs::remove_file(self.path(&session.session_ref));
            return Err("session_stale");
        }
        Ok(target)
    }

    fn begin(&self, host_id: &str) -> Result<Value> {
        if host_id.trim().is_empty() || host_id.len() > 64 {
            return Err("host_sync_request");
        }
        let target = target_by_id(self.db, host_id)?;
        let shared = match shared_id(self.db, &target.id)? {
            Some(shared) => shared,
            None => {
                let shared = Uuid::new_v4().to_string();
                set_shared(self.db, &target.id, &shared)?;
                shared
            }
        };
        self.prune();
        prepare_dir(&self.dir)?;
        if fs::read_dir(&self.dir)
            .map(|entries| entries.flatten().count())
            .unwrap_or(0)
            >= MAX_SESSIONS
        {
            return Err("host_sync_busy");
        }
        let created = now();
        let session = Session {
            protocol: PROTOCOL,
            session_ref: random_hex(),
            host_id: target.id.clone(),
            host_config: HostConfig::of(&target),
            config_revision: target.updated_at,
            shared_host_id: Some(shared.clone()),
            created_at: created,
            expires_at: created + TTL_SECONDS,
            checks: 0,
            fetches: 0,
        };
        self.store_session(&session)?;
        Ok(json!({
            "protocol": PROTOCOL,
            "kind": KIND,
            "role": "source",
            "sessionRef": session.session_ref,
            "hostId": session.host_id,
            "sharedHostId": shared,
            "configFingerprint": session.host_config.fingerprint(),
            "configRevision": session.config_revision,
            "expiresAt": session.expires_at,
            "ttlSeconds": TTL_SECONDS,
        }))
    }

    fn check(&self, reference: &str, challenge: &str) -> Result<Value> {
        if !hex64(challenge) {
            return Err("host_sync_request");
        }
        let mut session = self.load(reference)?;
        if session.checks >= MAX_CHECKS {
            let _ = fs::remove_file(self.path(reference));
            return Err("session_expired");
        }
        self.current(&session)?;
        // An unreadable credential store reports unavailable, never absent, so the
        // receiver cannot mistake a broken read for "no password".
        let (state, proof_value) = match local_password(self.secrets, &session.host_id) {
            Ok(Some(value)) if !value.is_empty() => {
                ("available", Some(proof(&value, reference, challenge)))
            }
            Ok(_) => ("absent", None),
            Err(_) => ("unavailable", None),
        };
        session.checks += 1;
        self.store_session(&session)?;
        Ok(json!({
            "protocol": PROTOCOL,
            "kind": KIND,
            "role": "source",
            "hostId": session.host_id,
            "sharedHostId": session.shared_host_id,
            "configFingerprint": session.host_config.fingerprint(),
            "configRevision": session.config_revision,
            "password": { "state": state, "proof": proof_value },
            "expiresAt": session.expires_at,
        }))
    }

    fn fetch(&self, reference: &str, challenge: &str, scope: &str) -> Result<Value> {
        if !hex64(challenge) || !matches!(scope, "config" | "password" | "all") {
            return Err("host_sync_request");
        }
        let mut session = self.load(reference)?;
        if session.fetches >= MAX_FETCHES {
            let _ = fs::remove_file(self.path(reference));
            return Err("session_expired");
        }
        self.current(&session)?;
        let want_config = matches!(scope, "config" | "all");
        let (password, password_state) = if matches!(scope, "password" | "all") {
            match local_password(self.secrets, &session.host_id) {
                Ok(Some(secret)) if !secret.is_empty() => (Some(secret), "available"),
                Ok(_) => (None, "absent"),
                Err(_) => (None, "unavailable"),
            }
        } else {
            (None, "not_requested")
        };
        session.fetches += 1;
        self.store_session(&session)?;
        Ok(json!({
            "protocol": PROTOCOL,
            "kind": KIND,
            "role": "source",
            "hostId": session.host_id,
            "sharedHostId": session.shared_host_id,
            "configRevision": session.config_revision,
            "configFingerprint": session.host_config.fingerprint(),
            "config": want_config.then(|| session.host_config.clone()),
            "password": password,
            "passwordState": password_state,
        }))
    }

    fn settle(&self, reference: &str) -> Result<Value> {
        if !hex64(reference) {
            return Err("host_sync_request");
        }
        let _ = self.load(reference)?;
        fs::remove_file(self.path(reference)).map_err(|_| "session_expired")?;
        Ok(json!({ "protocol": PROTOCOL, "kind": KIND, "settled": true }))
    }
}

#[derive(Clone, Debug)]
struct PeerCheck {
    fingerprint: String,
    revision: i64,
    shared_host_id: Option<String>,
    password_state: String,
    password_proof: Option<String>,
}

#[derive(Clone, Debug)]
struct PeerFetch {
    config: Option<HostConfig>,
    password: Option<String>,
    password_state: String,
}

/// The peer helper's call surface. The real implementation is a child process;
/// tests replay it.
trait Peer {
    fn check(&self, reference: &str, challenge: &str) -> Result<PeerCheck>;
    fn fetch(&self, reference: &str, challenge: &str, scope: &str) -> Result<PeerFetch>;
    fn settle(&self, reference: &str) -> Result<()>;
}

struct HelperPeer {
    program: PathBuf,
}

fn first_json_line(bytes: &[u8]) -> Result<Value> {
    serde_json::from_slice(bytes.split(|b| *b == b'\n').next().unwrap_or_default()).map_err(|_| "host_sync_protocol")
}

async fn read_reply(pipe: impl tokio::io::AsyncRead + Unpin) -> Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    const LIMIT: u64 = 256 * 1024;
    let mut bytes = Vec::new();
    pipe.take(LIMIT + 1).read_to_end(&mut bytes).await.map_err(|_| "host_sync_unavailable")?;
    if bytes.len() as u64 > LIMIT { return Err("host_sync_protocol"); }
    Ok(bytes)
}

async fn bounded_reply(command: Command, deadline: std::time::Duration) -> Result<(std::process::ExitStatus, Vec<u8>, Vec<u8>)> {
    let mut child = tokio::process::Command::from(command).kill_on_drop(true)
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|_| "host_sync_unavailable")?;
    let stdout = child.stdout.take().ok_or("host_sync_unavailable")?;
    let stderr = child.stderr.take().ok_or("host_sync_unavailable")?;
    tokio::time::timeout(deadline, async {
        tokio::try_join!(
            async { child.wait().await.map_err(|_| "host_sync_unavailable") },
            read_reply(stdout), read_reply(stderr),
        )
    }).await.map_err(|_| "host_sync_timeout")?
}

impl HelperPeer {
    fn call(&self, args: &[&str]) -> Result<Value> {
        let mut command = Command::new(&self.program);
        command.arg(FLAG).args(args);
        super::hide_console_window(&mut command);
        let (status, stdout, stderr) = tauri::async_runtime::block_on(bounded_reply(command, std::time::Duration::from_secs(10)))?;
        if !status.success() {
            // Only the error code travels back: diagnostics may name hosts or paths.
            let code = first_json_line(&stderr)
                .ok()
                .and_then(|value| value["error"].as_str().map(str::to_string))
                .unwrap_or_else(|| "host_sync_failed".to_string());
            return Err(match code.as_str() {
                "session_expired" => "session_expired",
                "session_stale" => "session_stale",
                "target_unavailable" => "target_unavailable",
                "host_sync_busy" => "host_sync_busy",
                _ => "host_sync_failed",
            });
        }
        first_json_line(&stdout)
    }
}

impl Peer for HelperPeer {
    fn check(&self, reference: &str, challenge: &str) -> Result<PeerCheck> {
        let value = self.call(&["check", reference, challenge])?;
        Ok(PeerCheck {
            fingerprint: value["configFingerprint"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            revision: value["configRevision"].as_i64().unwrap_or_default(),
            shared_host_id: value["sharedHostId"].as_str().map(str::to_string),
            password_state: value["password"]["state"]
                .as_str()
                .unwrap_or("unavailable")
                .to_string(),
            password_proof: value["password"]["proof"].as_str().map(str::to_string),
        })
    }

    fn fetch(&self, reference: &str, challenge: &str, scope: &str) -> Result<PeerFetch> {
        let value = self.call(&["fetch", reference, challenge, scope])?;
        let config = value
            .get("config")
            .filter(|config| !config.is_null())
            .map(|config| serde_json::from_value::<HostConfig>(config.clone()))
            .transpose()
            .map_err(|_| "host_sync_protocol")?;
        Ok(PeerFetch {
            config,
            password: value["password"].as_str().map(str::to_string),
            password_state: value["passwordState"]
                .as_str()
                .unwrap_or("absent")
                .to_string(),
        })
    }

    fn settle(&self, reference: &str) -> Result<()> {
        self.call(&["settle", reference]).map(|_| ())
    }
}

/// Receiver's verdict on the password. unknown is never equality.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PasswordState {
    Equal,
    Differs,
    Absent,
    Unknown,
}

impl PasswordState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Equal => "equal",
            Self::Differs => "differs",
            Self::Absent => "absent",
            Self::Unknown => "unknown",
        }
    }
}

fn compare_password(
    local: std::result::Result<Option<String>, String>,
    checked: &PeerCheck,
    reference: &str,
    challenge: &str,
) -> PasswordState {
    let Ok(local) = local else {
        return PasswordState::Unknown;
    };
    let local = local.filter(|value| !value.is_empty());
    match (local, checked.password_state.as_str()) {
        (_, "unavailable") => PasswordState::Unknown,
        (None, "available") | (Some(_), "absent") => PasswordState::Differs,
        (None, _) => PasswordState::Absent,
        (Some(password_value), "available") => match checked.password_proof.as_deref() {
            Some(remote) if remote == proof(&password_value, reference, challenge) => {
                PasswordState::Equal
            }
            Some(_) => PasswordState::Differs,
            None => PasswordState::Unknown,
        },
        _ => PasswordState::Unknown,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    kind: &'static str,
    state: &'static str,
}

/// Receiver side: align the source host with a local record, then write only what
/// is really missing and report configuration and password separately.
struct Receiver<'a> {
    db: &'a Database,
    secrets: &'a dyn CredentialStore,
}

impl<'a> Receiver<'a> {
    /// Bind an existing local record after an explicit choice. A record already
    /// linked to another shared identity is refused, never rebound.
    fn link(&self, target_id: &str, shared: &str) -> Result<RemoteTarget> {
        let target = target_by_id(self.db, target_id)?;
        if let Some(current) = shared_id(self.db, target_id)? {
            if current != shared {
                return Err("association_conflict");
            }
        }
        set_shared(self.db, &target.id, shared)?;
        Ok(target)
    }

    fn receive(&self, peer: &dyn Peer, reference: &str, resolve_to: Option<&str>) -> Result<Value> {
        if !hex64(reference) {
            return Err("host_sync_request");
        }
        let challenge = random_hex();
        let checked = peer.check(reference, &challenge)?;
        if !hex64(&checked.fingerprint) || checked.revision == 0 {
            return Err("host_sync_protocol");
        }
        let shared = checked.shared_host_id.clone();
        let mut discovery = None;
        let local: Option<RemoteTarget> = match (&shared, resolve_to) {
            (Some(shared_value), Some(chosen)) => Some(self.link(chosen, shared_value)?),
            (Some(shared_value), None) => match target_for_shared(self.db, shared_value)? {
                Some(id) => Some(target_by_id(self.db, &id)?),
                None => {
                    // Unlinked candidates must be resolved explicitly; nothing is
                    // merged by name or address.
                    let reply = peer.fetch(reference, &challenge, "config")?;
                    let config = reply.config.as_ref().ok_or("host_sync_protocol")?;
                    if !config.valid() || config.fingerprint() != checked.fingerprint { return Err("session_stale"); }
                    let same_host = matching_unlinked(self.db, &config.host)?;
                    discovery = Some(reply);
                    if same_host.is_empty() {
                        None
                    } else {
                        return Ok(json!({
                            "protocol": PROTOCOL,
                            "kind": KIND,
                            "role": "receiver",
                            "result": "association_required",
                            "sharedHostId": shared_value,
                            "candidates": same_host,
                            "receipts": Vec::<Value>::new(),
                            "sessionClosed": false,
                        }));
                    }
                }
            },
            _ => {
                return Ok(json!({
                    "protocol": PROTOCOL,
                    "kind": KIND,
                    "role": "receiver",
                    "result": "association_required",
                    "sharedHostId": Value::Null,
                    "candidates": Vec::<Value>::new(),
                    "receipts": Vec::<Value>::new(),
                    "sessionClosed": false,
                }))
            }
        };

        let config_equal = local.as_ref().map(|target| HostConfig::of(target).fingerprint())
            == Some(checked.fingerprint.clone());
        let previous_password = match &local {
            Some(target) => local_password(self.secrets, &target.id),
            None => Ok(None),
        };
        let previous_proof = previous_password.as_ref().ok().map(|value| {
            value.as_deref().map(|secret| proof(secret, reference, &challenge))
        });
        let password = compare_password(
            previous_password,
            &checked,
            reference,
            &challenge,
        );
        if config_equal && matches!(password, PasswordState::Equal | PasswordState::Absent) {
            peer.settle(reference)?;
            return Ok(json!({
                "protocol": PROTOCOL,
                "kind": KIND,
                "role": "receiver",
                "result": "consistent",
                "hostId": local.as_ref().map(|target| target.id.clone()),
                "sharedHostId": shared,
                "password": password.as_str(),
                "receipts": [
                    { "kind": "config", "state": "unchanged" },
                    { "kind": "password", "state": "unchanged" },
                ],
                "revision": local.as_ref().map(|target| target.updated_at),
                "sessionClosed": true,
            }));
        }

        let need_config = !config_equal;
        let need_password = checked.password_state == "available"
            && matches!(
                password,
                PasswordState::Differs | PasswordState::Unknown | PasswordState::Absent
            );
        let scope = match (need_config, need_password) {
            (true, true) => "all",
            (true, false) => "config",
            (false, true) => "password",
            (false, false) => "config",
        };
        let mut fetched = match discovery {
            Some(reply) if !need_password => reply,
            Some(reply) => {
                let mut fetched = peer.fetch(reference, &challenge, "password")?;
                fetched.config = reply.config;
                fetched
            }
            None => peer.fetch(reference, &challenge, scope)?,
        };

        let mut receipts: Vec<Receipt> = Vec::new();
        let mut host_id = local.as_ref().map(|target| target.id.clone());
        let mut expected_target = local.clone();
        let mut revision = local.as_ref().map(|target| target.updated_at);
        let mut config_state = "unchanged";
        if need_config {
            let Some(config) = fetched.config.take() else {
                return Err("host_sync_protocol");
            };
            if config.fingerprint() != checked.fingerprint { return Err("session_stale"); }
            if !config.valid() {
                return Err("host_sync_protocol");
            }
            let mut candidate = match &local {
                Some(current) => config.apply_to(current),
                None => RemoteTarget {
                    id: Uuid::new_v4().to_string(),
                    name: config.display_name.clone(),
                    host: config.host.clone(),
                    port: config.port,
                    user: config.user.clone(),
                    auth_method: config.auth_method.clone(),
                    identity_file: config.identity_file.clone(),
                    ssh_config: config.ssh_config.clone(),
                    default_path: config.default_path.clone(),
                    // A sync never enables a host; the receiving user confirms.
                    enabled: false,
                    created_at: 0,
                    updated_at: 0,
                },
            };
            super::validate_target(&candidate).map_err(|_| "host_sync_protocol")?;
            let stored = self.db.with_connection(|conn| {
                let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
                let previous = super::lookup_target(&tx, &candidate.id).map_err(|e| e.to_string())?;
                if previous.as_ref() != local.as_ref() { return Ok(false); }
                super::write_target(&tx, &mut candidate, previous.as_ref(), false)?;
                if let Some(shared) = &shared {
                    if !bind_identity(&tx, &candidate.id, shared)? { return Ok(false); }
                }
                tx.commit().map_err(|e| e.to_string())?;
                Ok(true)
            }).map_err(|_| "host_sync_unavailable")?;
            if !stored {
                return Ok(json!({
                    "protocol": PROTOCOL, "kind": KIND, "role": "receiver", "result": "conflict",
                    "hostId": host_id, "sharedHostId": shared, "password": password.as_str(),
                    "receipts": [Receipt { kind: "config", state: "conflict" }], "sessionClosed": false,
                }));
            }
            host_id = Some(candidate.id.clone());
            revision = Some(candidate.updated_at);
            expected_target = Some(candidate);
            config_state = "saved";
        }
        receipts.push(Receipt {
            kind: "config",
            state: config_state,
        });

        let mut password_state = password;
        if need_password {
            match fetched.password_state.as_str() {
                "available" => match fetched.password.as_deref() {
                    Some(secret) if !secret.is_empty() => {
                        let expected = expected_target.as_ref().ok_or("host_sync_protocol")?;
                        let saved = self.db.with_connection(|conn| {
                            // Hold the host's revision stable during the credential write. Nothing
                            // from the credential store is written to SQLite.
                            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
                            if super::lookup_target(&tx, &expected.id).map_err(|e| e.to_string())?.as_ref() != Some(expected) {
                                return Ok(false);
                            }
                            let current = local_password(self.secrets, &expected.id)?
                                .as_deref().map(|value| proof(value, reference, &challenge));
                            if previous_proof.as_ref() != Some(&current) { return Ok(false); }
                            password::save(self.secrets, &expected.id, secret).map_err(|_| "credential_write_failed".to_string())?;
                            Ok(true)
                        });
                        match saved {
                            Ok(false) => {
                                receipts.push(Receipt { kind: "password", state: "conflict" });
                                return Ok(json!({
                                    "protocol": PROTOCOL, "kind": KIND, "role": "receiver", "result": "conflict",
                                    "hostId": host_id, "sharedHostId": shared, "password": password.as_str(),
                                    "receipts": receipts, "sessionClosed": false,
                                }));
                            }
                            Ok(true) => {
                                password_state = PasswordState::Equal;
                                receipts.push(Receipt {
                                    kind: "password",
                                    state: "saved",
                                });
                            }
                            Err(_) => {
                                receipts.push(Receipt {
                                    kind: "password",
                                    state: "failed",
                                });
                            }
                        }
                    }
                    _ => {
                        password_state = PasswordState::Unknown;
                        receipts.push(Receipt {
                            kind: "password",
                            state: "unavailable",
                        });
                    }
                },
                "absent" => {
                    password_state = PasswordState::Absent;
                    receipts.push(Receipt {
                        kind: "password",
                        state: "absent",
                    });
                }
                _ => {
                    password_state = PasswordState::Unknown;
                    receipts.push(Receipt {
                        kind: "password",
                        state: "unavailable",
                    });
                }
            }
        } else {
            receipts.push(Receipt {
                kind: "password",
                state: "unchanged",
            });
        }

        let partial = receipts.iter().any(|receipt| receipt.state == "failed");
        let wrote = receipts.iter().any(|receipt| receipt.state == "saved");
        let result = if partial {
            "partial"
        } else if wrote {
            "applied"
        } else if password_state == PasswordState::Unknown {
            "unknown"
        } else {
            "unchanged"
        };
        let settled = matches!(result, "applied" | "consistent") && peer.settle(reference).is_ok();
        Ok(json!({
            "protocol": PROTOCOL,
            "kind": KIND,
            "role": "receiver",
            "result": result,
            "hostId": host_id,
            "sharedHostId": shared,
            "password": password_state.as_str(),
            "receipts": receipts,
            "revision": revision,
            "sessionClosed": settled,
        }))
    }


}

/// One helper invocation: read one action, print one JSON line.
pub fn run(args: &[String]) -> Result<()> {
    if args == ["version"] {
        println!(
            "{}",
            json!({
                "protocol": PROTOCOL,
                "kind": KIND,
                "app": "cliora",
                "capabilities": ["begin", "check", "fetch", "settle", "receive"],
                "ttlSeconds": TTL_SECONDS,
            })
        );
        return Ok(());
    }
    let db_path = database_path()?;
    let dir = sessions_dir(&db_path)?;
    let db = Database::open(&db_path).map_err(|_| "host_sync_unavailable")?;
    let secrets = crate::credentials::AppCredentialStore;
    let source = Source {
        db: &db,
        secrets: &secrets,
        dir,
    };
    let value = match args {
        [action, host_id] if action == "begin" => source.begin(host_id)?,
        [action, reference, challenge] if action == "check" => source.check(reference, challenge)?,
        [action, reference] if action == "settle" => source.settle(reference)?,
        [action, reference, challenge, scope] if action == "fetch" => {
            source.fetch(reference, challenge, scope)?
        }
        [action, program, reference] if action == "receive" => {
            let receiver = Receiver {
                db: &db,
                secrets: &secrets,
            };
            receiver.receive(
                &HelperPeer {
                    program: PathBuf::from(program),
                },
                reference,
                None,
            )?
        }
        [action, program, reference, chosen] if action == "receive" => {
            let receiver = Receiver {
                db: &db,
                secrets: &secrets,
            };
            receiver.receive(
                &HelperPeer {
                    program: PathBuf::from(program),
                },
                reference,
                Some(chosen),
            )?
        }
        _ => return Err("unsupported_action"),
    };
    println!("{value}");
    Ok(())
}

/// Called before the desktop starts: a helper invocation must not take the
/// single-instance lock or open a window.
pub fn helper_entry() -> bool {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some(FLAG) {
        return false;
    }
    let args: Vec<String> = args.collect();
    if let Err(code) = run(&args) {
        eprintln!("{}", json!({ "error": code }));
        std::process::exit(2);
    }
    true
}

/// Twiglane's helper location. Mirrors Twiglane's own discovery so either side can
/// be the receiver; tests and development override it explicitly.
pub fn twiglane_helper() -> Result<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(path) = std::env::var_os("TWIGLANE_HOST_SYNC_HELPER") {
        candidates.push(PathBuf::from(path));
    }
    #[cfg(target_os = "macos")]
    {
        let bundle = "Twiglane.app/Contents/MacOS/twiglane";
        candidates.push(Path::new("/Applications").join(bundle));
        if let Some(home) = dirs::home_dir() {
            candidates.push(home.join("Applications").join(bundle));
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(local) = dirs::data_local_dir() {
            candidates.push(local.join("Twiglane").join("twiglane.exe"));
            candidates.push(local.join("Programs").join("Twiglane").join("twiglane.exe"));
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        candidates.push(PathBuf::from("/usr/bin/twiglane"));
        candidates.push(PathBuf::from("/usr/local/bin/twiglane"));
        if let Some(home) = dirs::home_dir() {
            candidates.push(home.join(".local/bin/twiglane"));
        }
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or("twiglane_unavailable")
}

/// Session directory the desktop uses, resolved exactly like the helper does.
pub fn desktop_sessions_dir() -> Result<PathBuf> {
    let db = database_path()?;
    sessions_dir(&db)
}

/// Desktop entry: create one session for the host the user is jumping from.
/// Only the returned session reference leaves this process.
pub fn begin_with(db: &Database, dir: PathBuf, target_id: &str) -> std::result::Result<Value, String> {
    let secrets = crate::credentials::AppCredentialStore;
    Source {
        db,
        secrets: &secrets,
        dir,
    }
    .begin(target_id)
    .map_err(str::to_string)
}

/// Desktop entry: receive one jump by driving the peer helper over the private
/// pipe and writing only what this machine really lacks.
pub fn receive_with(
    db: &Database,
    program: &Path,
    session_ref: &str,
    resolve_to: Option<&str>,
) -> std::result::Result<Value, String> {
    let secrets = crate::credentials::AppCredentialStore;
    Receiver { db, secrets: &secrets }
        .receive(
            &HelperPeer {
                program: program.to_path_buf(),
            },
            session_ref,
            resolve_to,
        )
        .map_err(str::to_string)
}


#[cfg(test)]
mod tests {
    use super::super::{list_targets, save_target};
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    struct FakeSecrets {
        entries: Mutex<HashMap<String, String>>,
        fail_save: bool,
        fail_read: bool,
    }

    impl FakeSecrets {
        fn with_password(target_id: &str, value: &str) -> Self {
            let mut entries = HashMap::new();
            entries.insert(password::credential_id(target_id), value.to_string());
            Self {
                entries: Mutex::new(entries),
                ..Self::default()
            }
        }

        fn stored(&self, target_id: &str) -> Option<String> {
            self.entries
                .lock()
                .unwrap()
                .get(&password::credential_id(target_id))
                .cloned()
        }
    }

    impl CredentialStore for FakeSecrets {
        fn put(&self, id: &str, secret: &str) -> std::result::Result<(), String> {
            if self.fail_save {
                return Err("store unavailable".to_string());
            }
            self.entries
                .lock()
                .unwrap()
                .insert(id.to_string(), secret.to_string());
            Ok(())
        }

        fn get(&self, id: &str) -> std::result::Result<String, String> {
            if self.fail_read {
                return Err("store unavailable".to_string());
            }
            self.entries
                .lock()
                .unwrap()
                .get(id)
                .cloned()
                .ok_or_else(|| "missing".to_string())
        }

        fn delete(&self, id: &str) -> std::result::Result<(), String> {
            self.entries.lock().unwrap().remove(id);
            Ok(())
        }
    }

    fn host(id: &str, name: &str, address: &str) -> RemoteTarget {
        RemoteTarget {
            id: id.to_string(),
            name: name.to_string(),
            host: address.to_string(),
            port: 22,
            user: "deploy".to_string(),
            auth_method: "password".to_string(),
            identity_file: None,
            ssh_config: None,
            default_path: Some("/srv/app".to_string()),
            enabled: true,
            created_at: 10,
            updated_at: 10,
        }
    }

    fn fixture(id: &str, address: &str) -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("cliora.db")).unwrap();
        save_target(&db, host(id, "prod", address)).unwrap();
        (dir, db)
    }

    struct FakePeer {
        reference: String,
        config: HostConfig,
        shared: Option<String>,
        revision: i64,
        password: Option<String>,
        password_state: &'static str,
        before_fetch: Option<Box<dyn Fn() + Send + Sync>>,
        settled: Mutex<u32>,
    }

    impl FakePeer {
        fn new(reference: &str, config: HostConfig) -> Self {
            Self {
                reference: reference.to_string(),
                config,
                shared: Some("shared-1".to_string()),
                revision: 10,
                password: None,
                password_state: "absent",
                before_fetch: None,
                settled: Mutex::new(0),
            }
        }

        fn with_password(mut self, value: &str) -> Self {
            self.password = Some(value.to_string());
            self.password_state = "available";
            self
        }
    }

    impl Peer for FakePeer {
        fn check(&self, reference: &str, challenge: &str) -> Result<PeerCheck> {
            assert_eq!(reference, self.reference);
            Ok(PeerCheck {
                fingerprint: self.config.fingerprint(),
                revision: self.revision,
                shared_host_id: self.shared.clone(),
                password_state: self.password_state.to_string(),
                password_proof: self
                    .password
                    .as_deref()
                    .map(|value| proof(value, reference, challenge)),
            })
        }

        fn fetch(&self, _reference: &str, _challenge: &str, scope: &str) -> Result<PeerFetch> {
            if let Some(hook) = self.before_fetch.as_ref() {
                hook();
            }
            Ok(PeerFetch {
                config: matches!(scope, "config" | "all").then(|| self.config.clone()),
                password: self
                    .password
                    .clone()
                    .filter(|_| matches!(scope, "password" | "all")),
                password_state: self.password_state.to_string(),
            })
        }

        fn settle(&self, _reference: &str) -> Result<()> {
            *self.settled.lock().unwrap() += 1;
            Ok(())
        }
    }

    fn sessions(dir: &tempfile::TempDir) -> PathBuf {
        dir.path().join("host-sync")
    }

    fn link_of(db: &Database, target_id: &str) -> Option<String> {
        shared_id(db, target_id).unwrap()
    }

    fn updated_at(db: &Database, target_id: &str) -> i64 {
        target_by_id(db, target_id).unwrap().updated_at
    }

    #[test]
    fn proof_matches_hmac_sha256_rfc4231_case_two() {
        let digest = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
        let rendered: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        assert_eq!(
            rendered,
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        let same = proof("secret", &"a".repeat(64), &"b".repeat(64));
        assert_eq!(same, proof("secret", &"a".repeat(64), &"b".repeat(64)));
        assert_ne!(same, proof("secret", &"a".repeat(64), &"c".repeat(64)));
        assert_ne!(same, proof("other", &"a".repeat(64), &"b".repeat(64)));
        assert_eq!(same.len(), 64);
    }

    #[test]
    fn fingerprint_covers_configuration_but_not_enablement() {
        let base = HostConfig::of(&host("h", "prod", "example.test"));
        let mut renamed = base.clone();
        renamed.display_name = "prod-2".to_string();
        assert_ne!(base.fingerprint(), renamed.fingerprint());
        let mut key = base.clone();
        key.auth_method = "key".to_string();
        assert_ne!(base.fingerprint(), key.fingerprint());
        let with_path = HostConfig {
            identity_file: Some("/Users/me/.ssh/id_ed25519".to_string()),
            ..base.clone()
        };
        assert_ne!(base.fingerprint(), with_path.fingerprint());
        let mut target = host("h", "prod", "example.test");
        let fingerprint = HostConfig::of(&target).fingerprint();
        target.enabled = false;
        assert_eq!(HostConfig::of(&target).fingerprint(), fingerprint);
        assert_eq!(base.fingerprint().len(), 64);
    }

    #[test]
    fn begin_links_the_host_without_touching_its_revision() {
        let (dir, db) = fixture("host-a", "example.test");
        let secrets = FakeSecrets::with_password("host-a", "hunter2");
        let source = Source {
            db: &db,
            secrets: &secrets,
            dir: sessions(&dir),
        };
        let before = updated_at(&db, "host-a");
        let value = source.begin("host-a").unwrap();
        let shared = value["sharedHostId"].as_str().unwrap().to_string();
        assert!(hex64(value["sessionRef"].as_str().unwrap()));
        assert_eq!(link_of(&db, "host-a").as_deref(), Some(shared.as_str()));
        assert_eq!(updated_at(&db, "host-a"), before, "链接不推进目标修订");
        let again = source.begin("host-a").unwrap();
        assert_eq!(again["sharedHostId"].as_str().unwrap(), shared);
        for entry in fs::read_dir(sessions(&dir)).unwrap().flatten() {
            let raw = fs::read_to_string(entry.path()).unwrap();
            assert!(!raw.contains("hunter2"), "会话文件里没有密码");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(entry.metadata().unwrap().permissions().mode() & 0o777, 0o600);
            }
        }
    }

    #[test]
    fn check_returns_the_equality_proof_and_reports_unreadable_secrets() {
        let (dir, db) = fixture("host-a", "example.test");
        let secrets = FakeSecrets::with_password("host-a", "hunter2");
        let source = Source {
            db: &db,
            secrets: &secrets,
            dir: sessions(&dir),
        };
        let reference = source.begin("host-a").unwrap()["sessionRef"]
            .as_str()
            .unwrap()
            .to_string();
        let challenge = random_hex();
        let value = source.check(&reference, &challenge).unwrap();
        assert_eq!(value["password"]["state"], "available");
        assert_eq!(
            value["password"]["proof"].as_str().unwrap(),
            proof("hunter2", &reference, &challenge)
        );
        assert!(!value.to_string().contains("hunter2"));

        let broken = FakeSecrets {
            fail_read: true,
            ..FakeSecrets::default()
        };
        let source = Source {
            db: &db,
            secrets: &broken,
            dir: sessions(&dir),
        };
        let value = source.check(&reference, &random_hex()).unwrap();
        assert_eq!(value["password"]["state"], "unavailable");
        assert!(value["password"]["proof"].is_null());
    }

    #[test]
    fn sessions_are_one_shot_and_bound_to_one_host() {
        let (dir, db) = fixture("host-a", "example.test");
        save_target(&db, host("host-b", "staging", "other.test")).unwrap();
        let secrets = FakeSecrets::with_password("host-a", "one");
        let source = Source {
            db: &db,
            secrets: &secrets,
            dir: sessions(&dir),
        };
        let reference = source.begin("host-a").unwrap()["sessionRef"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(source.check(&reference, &random_hex()).unwrap()["hostId"], "host-a");
        source.settle(&reference).unwrap();
        assert_eq!(
            source.check(&reference, &random_hex()).unwrap_err(),
            "session_expired"
        );
        for bad in ["f".repeat(64), "host-b".to_string(), String::new()] {
            assert!(source.check(&bad, &random_hex()).is_err(), "{bad}");
        }
        // Editing the host after begin invalidates the session.
        let reference = source.begin("host-a").unwrap()["sessionRef"]
            .as_str()
            .unwrap()
            .to_string();
        let mut moved = target_by_id(&db, "host-a").unwrap();
        moved.host = "moved.test".to_string();
        save_target(&db, moved).unwrap();
        assert_eq!(
            source.check(&reference, &random_hex()).unwrap_err(),
            "session_stale"
        );
    }

    #[test]
    fn consistent_host_is_not_written_at_all() {
        let (_dir, db) = fixture("host-a", "example.test");
        set_shared(&db, "host-a", "shared-1").unwrap();
        let before = updated_at(&db, "host-a");
        let secrets = FakeSecrets::with_password("host-a", "hunter2");
        let peer = FakePeer::new(&"a".repeat(64), HostConfig::of(&target_by_id(&db, "host-a").unwrap()))
            .with_password("hunter2");
        let receiver = Receiver {
            db: &db,
            secrets: &secrets,
        };
        let value = receiver.receive(&peer, &peer.reference, None).unwrap();
        assert_eq!(value["result"], "consistent");
        assert_eq!(value["sessionClosed"], true);
        assert_eq!(*peer.settled.lock().unwrap(), 1);
        assert_eq!(updated_at(&db, "host-a"), before);
        assert_eq!(
            list_targets(&db).unwrap().len(),
            1,
            "一致时不新建记录"
        );
    }

    #[test]
    fn only_the_password_is_written_when_configuration_matches() {
        let (_dir, db) = fixture("host-a", "example.test");
        set_shared(&db, "host-a", "shared-1").unwrap();
        let before = updated_at(&db, "host-a");
        let secrets = FakeSecrets::with_password("host-a", "old");
        let peer = FakePeer::new(&"a".repeat(64), HostConfig::of(&target_by_id(&db, "host-a").unwrap()))
            .with_password("new-value");
        let receiver = Receiver {
            db: &db,
            secrets: &secrets,
        };
        let value = receiver.receive(&peer, &peer.reference, None).unwrap();
        assert_eq!(value["result"], "applied");
        assert_eq!(value["receipts"][0]["state"], "unchanged");
        assert_eq!(value["receipts"][1]["state"], "saved");
        assert_eq!(secrets.stored("host-a").as_deref(), Some("new-value"));
        assert_eq!(updated_at(&db, "host-a"), before, "只改密码不动目标行");
        assert!(!value.to_string().contains("new-value"));
    }

    #[test]
    fn configuration_difference_is_applied_once_and_retry_writes_nothing() {
        let (_dir, db) = fixture("host-a", "example.test");
        set_shared(&db, "host-a", "shared-1").unwrap();
        let mut remote = HostConfig::of(&target_by_id(&db, "host-a").unwrap());
        remote.user = "release".to_string();
        remote.default_path = Some("/srv/other".to_string());
        let secrets = FakeSecrets::default();
        let peer = FakePeer::new(&"a".repeat(64), remote.clone());
        let receiver = Receiver {
            db: &db,
            secrets: &secrets,
        };
        let value = receiver.receive(&peer, &peer.reference, None).unwrap();
        assert_eq!(value["result"], "applied");
        assert_eq!(value["receipts"][0]["state"], "saved");
        let saved = target_by_id(&db, "host-a").unwrap();
        assert_eq!(HostConfig::of(&saved), remote);
        assert!(saved.enabled, "同步不改动接收方自己的启用状态");
        assert_eq!(link_of(&db, "host-a").as_deref(), Some("shared-1"));
        let value = receiver.receive(&peer, &peer.reference, None).unwrap();
        assert_eq!(value["result"], "consistent");
        assert_eq!(value["receipts"][0]["state"], "unchanged");
    }

    #[test]
    fn partial_save_keeps_the_old_password_and_two_receipts() {
        let (_dir, db) = fixture("host-a", "example.test");
        set_shared(&db, "host-a", "shared-1").unwrap();
        let mut remote = HostConfig::of(&target_by_id(&db, "host-a").unwrap());
        remote.display_name = "prod-renamed".to_string();
        let secrets = FakeSecrets {
            fail_save: true,
            ..FakeSecrets::with_password("host-a", "old-password")
        };
        let peer = FakePeer::new(&"a".repeat(64), remote).with_password("new-password");
        let receiver = Receiver {
            db: &db,
            secrets: &secrets,
        };
        let value = receiver.receive(&peer, &peer.reference, None).unwrap();
        assert_eq!(value["result"], "partial");
        assert_eq!(value["receipts"][0]["state"], "saved");
        assert_eq!(value["receipts"][1]["state"], "failed");
        assert_eq!(value["sessionClosed"], false);
        assert_eq!(*peer.settled.lock().unwrap(), 0);
        assert_eq!(
            secrets.stored("host-a").as_deref(),
            Some("old-password"),
            "密码写入失败时保留原密码"
        );
    }

    #[test]
    fn unreadable_local_password_is_unknown_not_consistent() {
        let (_dir, db) = fixture("host-a", "example.test");
        set_shared(&db, "host-a", "shared-1").unwrap();
        let before = updated_at(&db, "host-a");
        let secrets = FakeSecrets {
            fail_read: true,
            ..FakeSecrets::default()
        };
        let mut peer = FakePeer::new(&"a".repeat(64), HostConfig::of(&target_by_id(&db, "host-a").unwrap()));
        peer.password_state = "unavailable";
        let receiver = Receiver {
            db: &db,
            secrets: &secrets,
        };
        let value = receiver.receive(&peer, &peer.reference, None).unwrap();
        assert_eq!(value["result"], "unknown");
        assert_eq!(value["password"], "unknown");
        assert_eq!(updated_at(&db, "host-a"), before);
        assert_eq!(*peer.settled.lock().unwrap(), 0);
    }

    #[test]
    fn a_local_edit_after_check_is_a_conflict() {
        let (dir, db) = fixture("host-a", "example.test");
        set_shared(&db, "host-a", "shared-1").unwrap();
        let mut remote = HostConfig::of(&target_by_id(&db, "host-a").unwrap());
        remote.host = "from-source.test".to_string();
        let secrets = FakeSecrets::default();
        let editing = dir.path().join("cliora.db");
        let mut peer = FakePeer::new(&"a".repeat(64), remote);
        peer.before_fetch = Some(Box::new(move || {
            let other = Database::open(&editing).unwrap();
            let mut changed = target_by_id(&other, "host-a").unwrap();
            changed.host = "locally-edited.test".to_string();
            save_target(&other, changed).unwrap();
        }));
        let receiver = Receiver {
            db: &db,
            secrets: &secrets,
        };
        let value = receiver.receive(&peer, &peer.reference, None).unwrap();
        assert_eq!(value["result"], "conflict");
        assert_eq!(value["receipts"][0]["state"], "conflict");
    }

    #[test]
    fn a_host_deleted_during_fetch_is_not_recreated() {
        let (dir, db) = fixture("host-a", "example.test");
        set_shared(&db, "host-a", "shared-1").unwrap();
        let secrets = FakeSecrets::default();
        let mut config = HostConfig::of(&target_by_id(&db, "host-a").unwrap());
        config.host = "updated.test".into();
        let mut peer = FakePeer::new(&"a".repeat(64), config);
        let path = dir.path().join("cliora.db");
        peer.before_fetch = Some(Box::new(move || {
            let other = Database::open(&path).unwrap();
            super::super::delete_target(&other, "host-a").unwrap();
        }));
        let result = Receiver { db: &db, secrets: &secrets }.receive(&peer, &peer.reference, None).unwrap();
        assert_eq!(result["result"], "conflict");
        assert!(list_targets(&db).unwrap().is_empty());
        assert_eq!(link_of(&db, "host-a"), None);
    }

    #[test]
    fn password_only_sync_checks_target_before_touching_credentials() {
        let (dir, db) = fixture("host-a", "example.test");
        set_shared(&db, "host-a", "shared-1").unwrap();
        let secrets = FakeSecrets::with_password("host-a", "old");
        let config = HostConfig::of(&target_by_id(&db, "host-a").unwrap());
        let mut peer = FakePeer::new(&"a".repeat(64), config).with_password("new");
        let path = dir.path().join("cliora.db");
        peer.before_fetch = Some(Box::new(move || {
            let other = Database::open(&path).unwrap();
            super::super::delete_target(&other, "host-a").unwrap();
        }));
        let result = Receiver { db: &db, secrets: &secrets }.receive(&peer, &peer.reference, None).unwrap();
        assert_eq!(result["result"], "conflict");
        assert_eq!(secrets.stored("host-a").as_deref(), Some("old"));
    }

    #[cfg(unix)]
    #[test]
    fn helper_output_and_runtime_are_bounded() {
        tauri::async_runtime::block_on(async {
            assert_eq!(read_reply(&vec![0u8; 256 * 1024 + 1][..]).await.unwrap_err(), "host_sync_protocol");
            let mut command = Command::new("/bin/sleep");
            command.arg("5");
            assert_eq!(bounded_reply(command, std::time::Duration::from_millis(100)).await.unwrap_err(), "host_sync_timeout");
        });
    }

    #[test]
    fn unlinked_candidates_need_an_explicit_choice() {
        let (_dir, db) = fixture("host-a", "example.test");
        let secrets = FakeSecrets::default();
        let peer = FakePeer::new(
            &"a".repeat(64),
            HostConfig::of(&host("remote", "prod", "example.test")),
        );
        let receiver = Receiver {
            db: &db,
            secrets: &secrets,
        };
        let value = receiver.receive(&peer, &peer.reference, None).unwrap();
        assert_eq!(value["result"], "association_required");
        assert_eq!(value["candidates"][0]["hostId"], "host-a");
        let value = receiver
            .receive(&peer, &peer.reference, Some("host-a"))
            .unwrap();
        assert_eq!(value["result"], "consistent");
        assert_eq!(link_of(&db, "host-a").as_deref(), Some("shared-1"));
        assert_eq!(list_targets(&db).unwrap().len(), 1);
    }

    #[test]
    fn linking_a_record_owned_by_another_shared_identity_is_refused() {
        let (_dir, db) = fixture("host-a", "example.test");
        set_shared(&db, "host-a", "other-shared").unwrap();
        let secrets = FakeSecrets::default();
        let peer = FakePeer::new(
            &"a".repeat(64),
            HostConfig::of(&target_by_id(&db, "host-a").unwrap()),
        );
        let receiver = Receiver {
            db: &db,
            secrets: &secrets,
        };
        assert_eq!(
            receiver
                .receive(&peer, &peer.reference, Some("host-a"))
                .unwrap_err(),
            "association_conflict"
        );
        assert_eq!(link_of(&db, "host-a").as_deref(), Some("other-shared"));
    }

    #[test]
    fn first_time_association_creates_one_disabled_record_with_its_own_password() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("cliora.db")).unwrap();
        let secrets = FakeSecrets::with_password("remote-id", "hunter2");
        let peer = FakePeer::new(
            &"a".repeat(64),
            HostConfig::of(&host("remote-id", "prod", "example.test")),
        )
        .with_password("hunter2");
        let receiver = Receiver {
            db: &db,
            secrets: &secrets,
        };
        let value = receiver.receive(&peer, &peer.reference, None).unwrap();
        assert_eq!(value["result"], "applied");
        let targets = list_targets(&db).unwrap();
        assert_eq!(targets.len(), 1);
        assert!(!targets[0].enabled, "新记录由接收方显式启用");
        assert_eq!(link_of(&db, &targets[0].id).as_deref(), Some("shared-1"));
        assert_eq!(
            secrets.stored(&targets[0].id).as_deref(),
            Some("hunter2"),
            "密码写入新记录自己的条目"
        );
        assert!(!value.to_string().contains("hunter2"));
    }
}

