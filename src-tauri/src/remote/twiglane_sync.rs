//! Cross-application host sync (host-sync v2, R4/R7) on Cliora's side.
//!
//! The same headless contract Twiglane implements lives here: Twiglane and Cliora
//! each expose one "--host-sync-v1" entry point that works with the desktop closed.
//! A jump creates a single-use, short-lived session for exactly one host; the deep
//! link carries only the session reference, and the private helper pipe carries the
//! configuration fingerprint, the password equality proof, and - only when it is
//! really missing or different - the password itself, which goes straight to the
//! local credential store. Private key material is never transferred, only paths.
//!
//! The wire format is v2 and has exactly one shape: the action name lives in argv,
//! every parameter and every secret travels on one stdin JSON line, so a session
//! reference never shows up in `ps` or a process audit. An argv carrying more than
//! the action name (plus the peer program path for `receive`) is rejected with
//! `host_sync_argv_rejected`. Versioning is used to *refuse* a mismatched peer, not
//! to adapt to it: a caller reads `version` first and, if the peer lacks
//! `stdinArgs`, answers `host_sync_peer_protocol_unsupported` without ever issuing
//! a parameterised call.
//!
//! This version has no confirmation-ticket gate: a password leaves this side only
//! on the private `fetch` pipe, and the one-shot `confirm` ticket flow is
//! Twiglane's own implementation. `version` therefore advertises `stdinArgs` only,
//! because the capability list must never name a guarantee this side does not
//! honour.
//!
//! Differences from Twiglane's implementation come from the store: Cliora keeps
//! targets in SQLite, so the cross-application identity lives in its own table and
//! a link edit never rewrites a target row or its revision (updated_at).

use std::fs;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
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
/// Wire protocol version.
///
/// v2 has exactly one wire shape: the action name is in argv, parameters and
/// secrets only on stdin, and any extra argv entry is `host_sync_argv_rejected`.
/// The version exists to *refuse* a mismatched peer rather than accommodate it:
/// a caller reads `version` first and, when the peer does not advertise
/// `stdinArgs`, answers `host_sync_peer_protocol_unsupported`. Until both sides
/// speak v2, bidirectional sync stays unavailable.
const PROTOCOL: u64 = 2;
const KIND: &str = "host-sync-v1";
const TTL_SECONDS: u64 = 120;
const MAX_CHECKS: u32 = 8;
const MAX_FETCHES: u32 = 2;
const MAX_SESSIONS: usize = 16;
const MAX_FIELD: usize = 4096;
/// Upper bound for the one parameter line on stdin: only identifiers and a
/// one-shot challenge travel there, far below the session file size.
const MAX_REQUEST_LINE: usize = 8192;

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
    /// Whether the peer speaks host-sync v2. Probed with a read-only `version`
    /// call before the first action and cached: a v1 peer only parses positional
    /// argv parameters, and this side now only sends parameters on stdin.
    probe: OnceLock<bool>,
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

/// Run one helper child. `stdin_line` of `None` keeps stdin on null: that is only
/// used for the read-only `version` probe, because a peer that never reads stdin
/// would otherwise just see a broken pipe.
async fn bounded_reply(
    command: Command,
    deadline: std::time::Duration,
    stdin_line: Option<&str>,
) -> Result<(std::process::ExitStatus, Vec<u8>, Vec<u8>)> {
    let mut child = tokio::process::Command::from(command).kill_on_drop(true)
        .stdin(if stdin_line.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|_| "host_sync_unavailable")?;
    if let Some(line) = stdin_line {
        use tokio::io::AsyncWriteExt;
        let mut stdin = child.stdin.take().ok_or("host_sync_unavailable")?;
        let written = stdin.write_all(line.as_bytes()).await;
        // Close the pipe explicitly so the peer sees EOF even when it exits early.
        drop(stdin);
        if written.is_err() {
            let _ = child.wait().await;
            return Err("host_sync_unavailable");
        }
    }
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
    fn new(program: PathBuf) -> Self {
        Self { program, probe: OnceLock::new() }
    }

    /// One helper invocation. Only the error code comes back: diagnostics may
    /// name hosts or paths, so they never reach this application's UI.
    fn run_child(&self, args: &[&str], stdin_line: Option<&str>) -> Result<Value> {
        let mut command = Command::new(&self.program);
        command.arg(FLAG).args(args);
        super::hide_console_window(&mut command);
        let (status, stdout, stderr) = tauri::async_runtime::block_on(bounded_reply(
            command,
            std::time::Duration::from_secs(10),
            stdin_line,
        ))?;
        if !status.success() {
            let code = first_json_line(&stderr)
                .ok()
                .and_then(|value| value["error"].as_str().map(str::to_string))
                .unwrap_or_else(|| "host_sync_failed".to_string());
            return Err(match code.as_str() {
                "session_expired" => "session_expired",
                "session_stale" => "session_stale",
                "target_unavailable" => "target_unavailable",
                "host_sync_busy" => "host_sync_busy",
                // A missing one-shot confirmation ticket must keep its own code so
                // the UI can report it instead of collapsing into a generic failure.
                "sync_confirmation_required" => "sync_confirmation_required",
                _ => "host_sync_failed",
            });
        }
        first_json_line(&stdout)
    }

    /// The peer must be host-sync v2: `version` has to report `protocol >= 2` and
    /// advertise `stdinArgs`. A probe failure (an old helper without `version`)
    /// counts as unsupported, and the verdict is cached once.
    fn peer_supports_v2(&self) -> bool {
        *self.probe.get_or_init(|| {
            self.run_child(&["version"], None).is_ok_and(|value| {
                value["protocol"]
                    .as_u64()
                    .is_some_and(|protocol| protocol >= PROTOCOL)
                    && value["capabilities"].as_array().is_some_and(|caps| {
                        caps.iter().any(|cap| cap.as_str() == Some("stdinArgs"))
                    })
            })
        })
    }

    /// Action name in argv, parameters only as one stdin JSON line: a session
    /// reference never shows up in `ps` or a process audit.
    fn call(&self, action: &str, params: Value) -> Result<Value> {
        if !self.peer_supports_v2() {
            // Both sides have to move to host-sync v2 together. A v1 peer only
            // parses positional argv parameters while this side only sends stdin,
            // so this is an explicit refusal rather than a half-working fallback.
            return Err("host_sync_peer_protocol_unsupported");
        }
        let line = format!("{params}\n");
        self.run_child(&[action], Some(&line))
    }
}

impl Peer for HelperPeer {
    fn check(&self, reference: &str, challenge: &str) -> Result<PeerCheck> {
        let value = self.call(
            "check",
            json!({ "sessionRef": reference, "challenge": challenge }),
        )?;
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
        let value = self.call(
            "fetch",
            json!({ "sessionRef": reference, "challenge": challenge, "scope": scope }),
        )?;
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
        self.call("settle", json!({ "sessionRef": reference }))
            .map(|_| ())
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
            config_state = "applied";
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
                                    state: "applied",
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
        let wrote = receipts.iter().any(|receipt| receipt.state == "applied");
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

/// Parameters of one helper call. Everything except the action name arrives on
/// stdin, never in argv.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Params {
    Begin {
        host_id: String,
    },
    Check {
        session_ref: String,
        challenge: String,
    },
    Fetch {
        session_ref: String,
        challenge: String,
        scope: String,
    },
    Settle {
        session_ref: String,
    },
    Receive {
        session_ref: String,
        resolve_to: Option<String>,
    },
}

/// Read one parameter line from stdin. EOF or an over-long line is an invalid
/// request, never a default.
fn request_line() -> Result<String> {
    let mut line = String::new();
    let read = std::io::stdin()
        .lock()
        .read_line(&mut line)
        .map_err(|_| "host_sync_request")?;
    if read == 0 || line.len() > MAX_REQUEST_LINE {
        return Err("host_sync_request");
    }
    Ok(line)
}

/// argv may only hold the action name (`receive` also gets the peer program path).
/// A session reference or host id in argv is refused so it never reaches `ps` or
/// a process audit.
fn verify_argv(rest: &[String], allowed: usize) -> Result<()> {
    if rest.len() != allowed {
        return Err("host_sync_argv_rejected");
    }
    Ok(())
}

/// One JSON parameter line: field names are fixed, extra or missing fields are
/// refused.
fn json_params(action: &str, line: &str) -> Result<Params> {
    let value: Value = serde_json::from_str(line).map_err(|_| "host_sync_request")?;
    let object = value.as_object().ok_or("host_sync_request")?;
    let allowed: &[&str] = match action {
        "begin" => &["hostId"],
        "check" => &["sessionRef", "challenge"],
        "fetch" => &["sessionRef", "challenge", "scope"],
        "settle" => &["sessionRef"],
        "receive" => &["sessionRef", "resolveTo"],
        _ => return Err("host_sync_request"),
    };
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("host_sync_request");
    }
    let text = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or("host_sync_request")
    };
    Ok(match action {
        "begin" => Params::Begin {
            host_id: text("hostId")?,
        },
        "check" => Params::Check {
            session_ref: text("sessionRef")?,
            challenge: text("challenge")?,
        },
        "fetch" => Params::Fetch {
            session_ref: text("sessionRef")?,
            challenge: text("challenge")?,
            scope: text("scope")?,
        },
        "settle" => Params::Settle {
            session_ref: text("sessionRef")?,
        },
        _ => Params::Receive {
            session_ref: text("sessionRef")?,
            resolve_to: match object.get("resolveTo") {
                None | Some(Value::Null) => None,
                Some(Value::String(chosen)) => Some(chosen.clone()),
                Some(_) => return Err("host_sync_request"),
            },
        },
    })
}

/// Parse the one stdin parameter line: a JSON object is preferred, the same
/// positional text fields stay accepted for a hand-typed helper call.
fn parse_params(action: &str, line: &str) -> Result<Params> {
    let line = line.trim();
    if line.is_empty() || line.len() > MAX_REQUEST_LINE {
        return Err("host_sync_request");
    }
    if line.starts_with('{') {
        return json_params(action, line);
    }
    let fields: Vec<&str> = line.split_whitespace().collect();
    let expected = match action {
        "begin" | "settle" | "receive" => 1,
        "check" => 2,
        "fetch" => 3,
        _ => return Err("host_sync_request"),
    };
    if fields.len() != expected {
        return Err("host_sync_request");
    }
    Ok(match action {
        "begin" => Params::Begin {
            host_id: fields[0].to_string(),
        },
        "check" => Params::Check {
            session_ref: fields[0].to_string(),
            challenge: fields[1].to_string(),
        },
        "fetch" => Params::Fetch {
            session_ref: fields[0].to_string(),
            challenge: fields[1].to_string(),
            scope: fields[2].to_string(),
        },
        "settle" => Params::Settle {
            session_ref: fields[0].to_string(),
        },
        _ => Params::Receive {
            session_ref: fields[0].to_string(),
            resolve_to: None,
        },
    })
}

/// One helper invocation: action name in argv, parameters from stdin, one JSON
/// result line on stdout.
pub fn run(args: &[String]) -> Result<()> {
    let action = args.first().ok_or("host_sync_request")?.clone();
    let rest = &args[1..];
    if action == "version" {
        verify_argv(rest, 0)?;
        println!(
            "{}",
            json!({
                "protocol": PROTOCOL,
                "kind": KIND,
                "app": "cliora",
                // Capability declaration: a caller reads this first and refuses a
                // peer without stdinArgs. Only capabilities this side really
                // implements are listed: this version has no confirmation-ticket
                // gate, so nothing is promised for a `confirm` flow. The ticket
                // subsystem lives on Twiglane's side; here the password is only
                // ever returned on the private fetch pipe.
                "capabilities": ["stdinArgs"],
                "actions": ["begin", "check", "fetch", "settle", "receive"],
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
    let value = match action.as_str() {
        "begin" => {
            verify_argv(rest, 0)?;
            match parse_params("begin", &request_line()?)? {
                Params::Begin { host_id } => source.begin(&host_id)?,
                _ => return Err("host_sync_request"),
            }
        }
        "check" => {
            verify_argv(rest, 0)?;
            match parse_params("check", &request_line()?)? {
                Params::Check { session_ref, challenge } => {
                    source.check(&session_ref, &challenge)?
                }
                _ => return Err("host_sync_request"),
            }
        }
        "settle" => {
            verify_argv(rest, 0)?;
            match parse_params("settle", &request_line()?)? {
                Params::Settle { session_ref } => source.settle(&session_ref)?,
                _ => return Err("host_sync_request"),
            }
        }
        "fetch" => {
            verify_argv(rest, 0)?;
            match parse_params("fetch", &request_line()?)? {
                Params::Fetch { session_ref, challenge, scope } => {
                    source.fetch(&session_ref, &challenge, &scope)?
                }
                _ => return Err("host_sync_request"),
            }
        }
        "receive" => {
            // argv holds only the action name and the peer program path; every
            // other parameter comes from stdin.
            verify_argv(rest, 1)?;
            let program = PathBuf::from(&rest[0]);
            match parse_params("receive", &request_line()?)? {
                Params::Receive { session_ref, resolve_to } => {
                    let receiver = Receiver {
                        db: &db,
                        secrets: &secrets,
                    };
                    receiver.receive(
                        &HelperPeer::new(program),
                        &session_ref,
                        resolve_to.as_deref(),
                    )?
                }
                _ => return Err("host_sync_request"),
            }
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
            &HelperPeer::new(program.to_path_buf()),
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
        assert_eq!(value["receipts"][1]["state"], "applied");
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
        assert_eq!(value["receipts"][0]["state"], "applied");
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
        assert_eq!(value["receipts"][0]["state"], "applied");
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
            assert_eq!(
                bounded_reply(command, std::time::Duration::from_millis(100), None)
                    .await
                    .unwrap_err(),
                "host_sync_timeout"
            );
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

    /// v2 只有一种调用形态：参数走 stdin，argv 里带参数一律拒绝。
    #[test]
    fn parameters_come_from_stdin_and_argv_parameters_are_rejected() {
        let reference = "a".repeat(64);
        let challenge = "b".repeat(64);
        // argv 上只允许动作名（receive 另加对端程序路径）。
        assert!(verify_argv(&[], 0).is_ok());
        assert!(verify_argv(&["/usr/bin/twiglane".to_string()], 1).is_ok());
        for rest in [
            vec!["host-a".to_string()],
            vec![reference.clone(), challenge.clone()],
            vec![reference.clone(), challenge.clone(), "all".to_string()],
            vec![reference.clone()],
        ] {
            assert_eq!(
                verify_argv(&rest, 0).unwrap_err(),
                "host_sync_argv_rejected"
            );
        }
        // receive 只多允许一位对端路径：再多一位仍然拒绝。
        assert_eq!(
            verify_argv(
                &[
                    "/usr/bin/twiglane".to_string(),
                    reference.clone(),
                    "host-a".to_string()
                ],
                1
            )
            .unwrap_err(),
            "host_sync_argv_rejected"
        );

        // 动作参数只从 stdin 读。
        let line = format!(
            "{{\"sessionRef\":\"{reference}\",\"challenge\":\"{challenge}\",\"scope\":\"all\"}}"
        );
        assert_eq!(
            parse_params("fetch", &line).unwrap(),
            Params::Fetch {
                session_ref: reference.clone(),
                challenge: challenge.clone(),
                scope: "all".to_string(),
            }
        );
        assert_eq!(
            parse_params("begin", "host-a\n").unwrap(),
            Params::Begin {
                host_id: "host-a".to_string(),
            }
        );
        // 缺字段与多字段都按无效请求处理，绝不补默认值。
        assert_eq!(
            parse_params(
                "check",
                "{\"sessionRef\":\"x\",\"challenge\":\"y\",\"extra\":1}"
            )
            .unwrap_err(),
            "host_sync_request"
        );
        assert_eq!(
            parse_params("fetch", "{\"sessionRef\":\"x\"}").unwrap_err(),
            "host_sync_request"
        );
    }

    /// version 必须宣告 v2 的线格式，调用方据此判定协议是否兼容。只宣告真实能力：
    /// 本侧没有票据门控，就不宣告 confirmation。
    #[test]
    fn version_declares_the_v2_wire_format() {
        assert_eq!(PROTOCOL, 2);
        let source = include_str!("twiglane_sync.rs");
        assert!(
            source.contains("\"capabilities\": [\"stdinArgs\"]"),
            "version 必须宣告 stdinArgs"
        );
        assert!(
            !source.contains("\"capabilities\": [\"stdinArgs\", \"confirmation\"]"),
            "本侧没有票据门控，不能宣告 confirmation"
        );
        assert!(source.contains("verify_argv(rest, 0)?"));
        assert!(source.contains("host_sync_peer_protocol_unsupported"));
    }

    /// 造一个假 helper 脚本：把收到的 argv 与 stdin 记到文件里，便于断言调用形态。
    #[cfg(unix)]
    fn fake_helper(dir: &Path, script: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("peer-helper.sh");
        fs::write(&path, script).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    /// 对端是 v1（没有 stdinArgs）：给明确错误码，且不向它发出任何带参数的调用。
    #[cfg(unix)]
    #[test]
    fn a_v1_peer_is_refused_with_an_explicit_protocol_error() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("argv.log");
        let script = r##"#!/bin/sh
printf '%s\n' "$*" >> __ARGV_LOG__
case "$2" in
  version) printf '%s\n' '{"protocol":1,"kind":"host-sync-v1","capabilities":["check","fetch","settle"]}' ;;
  *) printf '%s\n' '{"protocol":1,"kind":"host-sync-v1","settled":true}' ;;
esac
"##
        .replace("__ARGV_LOG__", &format!("'{}'", log.display()));
        let peer = HelperPeer::new(fake_helper(dir.path(), &script));
        let reference = "b".repeat(64);
        let challenge = "c".repeat(64);
        assert_eq!(
            peer.check(&reference, &challenge).unwrap_err(),
            "host_sync_peer_protocol_unsupported"
        );
        // 探测过 version 之后就不再调用任何动作：不存在「退回 argv」这条路径。
        let lines: Vec<String> = fs::read_to_string(&log)
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0], "--host-sync-v1 version");
        // 同一个 peer 再调一次也不会重新探测（结论已缓存）。
        assert_eq!(
            peer.settle(&reference).unwrap_err(),
            "host_sync_peer_protocol_unsupported"
        );
        assert_eq!(
            fs::read_to_string(&log).unwrap().lines().count(),
            1,
            "协议结论只探测一次"
        );
    }

    /// 对端宣告 stdinArgs（v2）：参数走 stdin，argv 只留动作名。
    #[cfg(unix)]
    #[test]
    fn a_peer_with_stdin_args_gets_parameters_on_stdin() {
        let dir = tempfile::tempdir().unwrap();
        let argv_log = dir.path().join("argv.log");
        let stdin_log = dir.path().join("stdin.log");
        let script = r##"#!/bin/sh
printf '%s\n' "$*" >> __ARGV_LOG__
case "$2" in
  version) printf '%s\n' '{"protocol":2,"kind":"host-sync-v1","capabilities":["stdinArgs","confirmation"]}' ;;
  check) IFS= read -r line; printf '%s\n' "$line" >> __STDIN_LOG__; printf '%s\n' '{"protocol":2,"kind":"host-sync-v1","hostId":"host-a","sharedHostId":"shared-1","configFingerprint":"__FP__","configRevision":9,"password":{"state":"absent"}}' ;;
  *) printf '%s\n' '{"protocol":2,"kind":"host-sync-v1","settled":true}' ;;
esac
"##
        .replace("__ARGV_LOG__", &format!("'{}'", argv_log.display()))
        .replace("__STDIN_LOG__", &format!("'{}'", stdin_log.display()))
        .replace("__FP__", &"a".repeat(64));
        let peer = HelperPeer::new(fake_helper(dir.path(), &script));
        let reference = "b".repeat(64);
        let challenge = "c".repeat(64);
        let checked = peer.check(&reference, &challenge).unwrap();
        assert_eq!(checked.revision, 9);
        let lines: Vec<String> = fs::read_to_string(&argv_log)
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect();
        assert_eq!(lines[0], "--host-sync-v1 version");
        assert_eq!(
            lines[1], "--host-sync-v1 check",
            "v2 对端的 argv 上不能出现会话引用"
        );
        let stdin = fs::read_to_string(&stdin_log).unwrap();
        assert!(stdin.contains(&reference), "会话引用必须经 stdin 传");
        assert!(stdin.contains(&challenge));
    }
}
