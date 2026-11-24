//! The central secret broker.
//!
//! One process handles every entry point: the local CLI helper, and later the MCP
//! stdio helper. It resolves installations and grants, runs a registered executor
//! with a fixed argv, checks one-time or session approval for raw reads, masks the
//! value out of any text it returns and writes one audit row per decision. A
//! failed check never falls back to another secret.
use crate::credentials::CredentialStore;
use crate::database::Database;
use crate::secrets::{approval, audit, executor, ipc, reference, session, store};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::atomic::AtomicBool;

/// The label a CLI helper reports as its request source. The MCP helper (a later
/// task) uses the same broker and reports its own source.
pub const SOURCE_CLI: &str = "CLI";
// A separate installation prevents a fixed-script grant from keeping a revoked
// direct-read command usable. This built-in operation never launches a process.
const DIRECT_TARGET: &str = "cliora-direct";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectRead {
    secret_id: String,
    installation_id: String,
    alias: String,
}

pub fn direct_reads(db: &Database, secret_id: Option<&str>) -> Result<Vec<DirectRead>, String> {
    db.with_read_connection(|conn| {
        let mut stmt = conn.prepare(
            "SELECT d.secret_id,d.installation_id,s.alias FROM secret_direct_reads d
             JOIN prompt_secrets s ON s.id=d.secret_id
             JOIN secret_installations i ON i.id=d.installation_id AND i.revoked=0
             WHERE ?1 IS NULL OR d.secret_id=?1"
        ).map_err(sql)?;
        let rows = stmt.query_map([secret_id], |r| Ok(DirectRead {
            secret_id: r.get(0)?, installation_id: r.get(1)?, alias: r.get(2)?,
        })).map_err(sql)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(sql)
    })
}

/// Desktop opt-in permits the broker to *ask* for this reference. The original
/// value still requires a desktop decision on the read path.
pub fn set_direct_read(db: &Database, secret_id: &str, enabled: bool) -> Result<(), String> {
    db.with_connection(|conn| {
        let tx = conn.transaction().map_err(sql)?;
        if enabled {
            let current: Option<String> = tx.query_row(
                "SELECT id FROM secret_installations WHERE kind='cli' AND target_id=?1 AND revoked=0
                 ORDER BY created_at DESC,id LIMIT 1", [DIRECT_TARGET], |r| r.get(0),
            ).optional().map_err(sql)?;
            let installation = match current {
                Some(id) => id,
                None => {
                    let id = uuid::Uuid::new_v4().to_string();
                    tx.execute("INSERT INTO secret_installations(id,label,kind,target_id,revoked,created_at)
                                VALUES(?1,'Local AI','cli',?2,0,?3)",
                               params![id, DIRECT_TARGET, crate::prompts::timestamp() as i64]).map_err(sql)?;
                    id
                }
            };
            tx.execute("INSERT INTO secret_direct_reads(secret_id,installation_id) VALUES(?1,?2)
                        ON CONFLICT(secret_id) DO NOTHING", params![secret_id, installation]).map_err(sql)?;
            tx.commit().map_err(sql)
        } else {
            let installation: Option<String> = tx.query_row("DELETE FROM secret_direct_reads WHERE secret_id=?1 RETURNING installation_id",
                [secret_id], |r| r.get(0)).optional().map_err(sql)?;
            tx.commit().map_err(sql)?;
            if let Some(id) = installation { session::invalidate(Some(&id), Some(secret_id)); }
            Ok(())
        }
    })
}

fn sql(error: rusqlite::Error) -> String {
    error.to_string()
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Cli,
    Mcp,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Cli => "cli",
            Self::Mcp => "mcp",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        match text {
            "cli" => Some(Self::Cli),
            "mcp" => Some(Self::Mcp),
            _ => None,
        }
    }
}

/// An installation is the identity a helper authenticates with. Revoking it stops
/// every later request from that helper; it is a random opaque id, not a secret.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installation {
    pub id: String,
    pub direct_read_only: bool,
    pub label: String,
    pub kind: Kind,
    pub target_id: Option<String>,
    pub revoked: bool,
    pub created_at: u64,
    pub revoked_at: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    pub installation_id: String,
    pub secret_id: String,
    pub alias: String,
    pub executor_id: String,
    pub executor_label: String,
    pub created_at: u64,
}

fn installation_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Installation> {
    let kind: String = row.get(2)?;
    let target_id: Option<String> = row.get(3)?;
    Ok(Installation {
        direct_read_only: kind == "cli" && target_id.as_deref() == Some(DIRECT_TARGET),
        id: row.get(0)?,
        label: row.get(1)?,
        kind: Kind::parse(&kind).unwrap_or(Kind::Cli),
        target_id,
        revoked: row.get::<_, i64>(4)? != 0,
        created_at: row.get::<_, i64>(5)?.max(0) as u64,
        revoked_at: row.get::<_, Option<i64>>(6)?.map(|value| value.max(0) as u64),
    })
}

pub fn create_installation(db: &Database, label: &str, kind: Kind, target_id: Option<&str>) -> Result<Installation, String> {
    let label = label.trim();
    if label.is_empty() || label.chars().count() > 80 || label.chars().any(char::is_control) {
        return Err("安装标识需为 1 至 80 个字符，且不能包含控制字符".into());
    }
    let target = target_id.map(str::trim).filter(|value| !value.is_empty());
    let id = uuid::Uuid::new_v4().to_string();
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO secret_installations(id,label,kind,target_id,revoked,created_at,revoked_at)
             VALUES(?1,?2,?3,?4,0,?5,NULL)",
            params![id, label, kind.as_str(), target, crate::prompts::timestamp() as i64],
        )
        .map(|_| ())
        .map_err(sql)
    })?;
    load_installation(db, &id)?.ok_or_else(|| "安装标识保存失败".to_string())
}

pub fn list_installations(db: &Database) -> Result<Vec<Installation>, String> {
    db.with_read_connection(|conn| {
        let mut statement = conn
            .prepare("SELECT id,label,kind,target_id,revoked,created_at,revoked_at FROM secret_installations ORDER BY created_at DESC, id")
            .map_err(sql)?;
        let rows = statement.query_map([], installation_row).map_err(sql)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(sql)
    })
}

pub fn load_installation(db: &Database, id: &str) -> Result<Option<Installation>, String> {
    if uuid::Uuid::parse_str(id).is_err() {
        return Ok(None);
    }
    db.with_read_connection(|conn| {
        conn.query_row(
            "SELECT id,label,kind,target_id,revoked,created_at,revoked_at FROM secret_installations WHERE id=?1",
            [id],
            installation_row,
        )
        .optional()
        .map_err(sql)
    })
}

/// The live installations of one kind for one target, newest first. A revoked
/// installation keeps its audit trail and is never returned here, so a reconnect
/// starts a fresh identity instead of reviving the old grants.
pub fn installations_for(db: &Database, kind: Kind, target_id: &str) -> Result<Vec<Installation>, String> {
    db.with_read_connection(|conn| {
        let mut statement = conn
            .prepare(
                "SELECT id,label,kind,target_id,revoked,created_at,revoked_at FROM secret_installations
                 WHERE kind=?1 AND target_id=?2 AND revoked=0 ORDER BY created_at DESC, id",
            )
            .map_err(sql)?;
        let rows = statement.query_map(params![kind.as_str(), target_id], installation_row).map_err(sql)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(sql)
    })
}

/// Revocation removes every grant of this installation in the same transaction, so
/// reconnecting with the same label later starts without authorization.
pub fn revoke_installation(db: &Database, id: &str) -> Result<(), String> {
    db.with_connection(|conn| {
        let tx = conn.transaction().map_err(sql)?;
        let changed = tx
            .execute(
                "UPDATE secret_installations SET revoked=1,revoked_at=?2 WHERE id=?1 AND revoked=0",
                params![id, crate::prompts::timestamp() as i64],
            )
            .map_err(sql)?;
        if changed == 0 {
            let existing: Option<i64> = tx
                .query_row("SELECT revoked FROM secret_installations WHERE id=?1", [id], |row| row.get(0))
                .optional()
                .map_err(sql)?;
            return match existing {
                Some(_) => Err("安装标识已撤销".to_string()),
                None => Err("安装标识已不存在".to_string()),
            };
        }
        tx.execute("DELETE FROM secret_grants WHERE installation_id=?1", [id]).map_err(sql)?;
        tx.execute("DELETE FROM secret_direct_reads WHERE installation_id=?1", [id]).map_err(sql)?;
        tx.commit().map_err(sql)?;
        session::invalidate(Some(id), None);
        Ok(())
    })
}

/// Explicit recovery re-enables the id embedded in existing local CLI instructions.
pub fn restore_cli_installation(db: &Database, id: &str) -> Result<(), String> {
    db.with_connection(|conn| {
        let tx = conn.transaction().map_err(sql)?;
        let changed = tx.execute(
            "UPDATE secret_installations SET revoked=0, revoked_at=NULL
             WHERE id=?1 AND kind='cli' AND target_id IS NULL AND revoked=1",
            [id],
        ).map_err(sql)?;
        if changed == 0 {
            return Err("只能恢复已撤销的本地 CLI 身份".into());
        }
        // Older versions could write a grant concurrently with revocation.
        tx.execute("DELETE FROM secret_grants WHERE installation_id=?1", [id]).map_err(sql)?;
        tx.commit().map_err(sql)
    })
}

pub fn delete_cli_installation(db: &Database, id: &str) -> Result<(), String> {
    db.with_connection(|conn| {
        let changed = conn.execute(
            "DELETE FROM secret_installations WHERE id=?1 AND kind='cli' AND target_id IS NULL AND revoked=1",
            [id],
        ).map_err(sql)?;
        if changed == 0 {
            return Err("只能删除已撤销的本地 CLI 身份".into());
        }
        Ok(())
    })
}

/// A grant binds one installation, one local secret and one registered executor.
/// There is no wildcard: widening the scope is another explicit user action.
pub fn grant(db: &Database, installation_id: &str, secret_id: &str, executor_id: &str) -> Result<(), String> {
    if !store::exists(db, secret_id)? {
        return Err("秘密已不存在，请重新选择引用".into());
    }
    executor::load(db, executor_id)?;
    db.with_connection(|conn| {
        let tx = conn.transaction().map_err(sql)?;
        let live: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM secret_installations WHERE id=?1 AND revoked=0 AND (kind!='cli' OR target_id IS NOT ?2))",
            params![installation_id, DIRECT_TARGET], |row| row.get(0),
        ).map_err(sql)?;
        if !live {
            return Err("安装标识已失效，不能新增绑定".into());
        }
        tx.execute(
            "INSERT INTO secret_grants(installation_id,secret_id,executor_id,created_at) VALUES(?1,?2,?3,?4)
             ON CONFLICT(installation_id,secret_id,executor_id) DO NOTHING",
            params![installation_id, secret_id, executor_id, crate::prompts::timestamp() as i64],
        ).map_err(sql)?;
        tx.commit().map_err(sql)
    })
}

pub fn revoke_grant(db: &Database, installation_id: &str, secret_id: &str, executor_id: &str) -> Result<(), String> {
    let changed = db.with_connection(|conn| {
        let count = conn.execute(
            "DELETE FROM secret_grants WHERE installation_id=?1 AND secret_id=?2 AND executor_id=?3",
            params![installation_id, secret_id, executor_id],
        ).map_err(sql)?;
        if count != 0 { session::invalidate(Some(installation_id), Some(secret_id)); }
        Ok(count)
    })?;
    if changed != 1 {
        return Err("绑定已不存在".into());
    }
    Ok(())
}

pub fn list_grants(db: &Database) -> Result<Vec<Grant>, String> {
    grants_for_secret(db, None)
}

pub fn grants_for_secret(db: &Database, secret_id: Option<&str>) -> Result<Vec<Grant>, String> {
    db.with_read_connection(|conn| {
        let mut statement = conn
            .prepare(
                "SELECT g.installation_id,g.secret_id,s.alias,g.executor_id,e.label,g.created_at
                 FROM secret_grants g
                 JOIN prompt_secrets s ON s.id = g.secret_id
                 JOIN secret_executors e ON e.id = g.executor_id
                 WHERE ?1 IS NULL OR g.secret_id=?1
                 ORDER BY g.created_at DESC, g.secret_id",
            )
            .map_err(sql)?;
        let rows = statement
            .query_map([secret_id], |row| {
                Ok(Grant {
                    installation_id: row.get(0)?,
                    secret_id: row.get(1)?,
                    alias: row.get(2)?,
                    executor_id: row.get(3)?,
                    executor_label: row.get(4)?,
                    created_at: row.get::<_, i64>(5)?.max(0) as u64,
                })
            })
            .map_err(sql)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(sql)
    })
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableExecutor {
    pub id: String,
    pub label: String,
    /// False when the script content no longer matches the registered digest; such
    /// an entry can be listed but not used.
    pub digest_ok: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableSecret {
    pub id: String,
    pub alias: String,
    pub reference: String,
    pub status: store::SecretStatus,
    pub executors: Vec<AvailableExecutor>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretList {
    pub installation_label: String,
    pub secrets: Vec<AvailableSecret>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UseResult {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub elapsed_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadResult {
    pub alias: String,
    pub value: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerStatus {
    pub running: bool,
    pub transport: String,
    pub error: Option<String>,
}

pub fn status() -> BrokerStatus {
    match ipc::start_status() {
        Ok(()) => BrokerStatus { running: true, transport: ipc::transport().into(), error: None },
        Err(error) => BrokerStatus { running: false, transport: ipc::transport().into(), error: Some(error) },
    }
}

fn denied(code: &'static str, message: &str) -> ipc::Response {
    ipc::Response::failure(code, message)
}

fn record(db: &Database, event: audit::Event<'_>) {
    // Audit storage failures must not turn a refusal into an approval.
    let _ = audit::record(db, event);
}

fn live_installation(db: &Database, id: &str) -> Result<Installation, (&'static str, &'static str)> {
    match load_installation(db, id) {
        Ok(Some(installation)) if !installation.revoked => Ok(installation),
        Ok(Some(_)) => Err((audit::code::INSTALLATION_REVOKED, "安装标识已撤销；请在资料库重新启用受控使用")),
        Ok(None) => Err((audit::code::INSTALLATION_UNKNOWN, "安装标识无效；请在资料库查看命令说明")),
        Err(_) => Err((audit::code::STORAGE_FAILED, "本机秘密数据暂时不可用")),
    }
}

fn installation_checked(
    db: &Database,
    installation_id: &str,
    operation: audit::Operation,
) -> Result<Installation, Box<ipc::Response>> {
    live_installation(db, installation_id).map_err(|(code, message)| {
        record(db, audit::Event {
            operation, decision: audit::Decision::Denied, code, secret_id: None,
            installation_id: Some(installation_id), executor_id: None,
        });
        Box::new(denied(code, message))
    })
}

fn source_label(installation: &Installation, kind: Kind) -> String {
    if installation.direct_read_only { return format!("{SOURCE_CLI} · {}", installation.label); }
    match (&installation.target_id, kind) {
        (Some(target), Kind::Cli) => format!("{SOURCE_CLI} · {} · {target}", installation.label),
        (_, Kind::Cli) => format!("{SOURCE_CLI} · {}", installation.label),
        (_, Kind::Mcp) => format!("MCP · {}", installation.label),
    }
}

/// Secrets the installation may use, with the executors it may run them through.
pub fn list(db: &Database, store: &dyn CredentialStore, installation_id: &str) -> ipc::Response {
    let installation = match installation_checked(db, installation_id, audit::Operation::List) {
        Ok(installation) => installation,
        Err(response) => return *response,
    };
    if installation.direct_read_only {
        let Ok(secrets) = store::list_for_direct_installation(db, store, Some(&installation.id)) else {
            return denied(audit::code::STORAGE_FAILED, "本机秘密数据暂时不可用");
        };
        let visible = secrets.into_iter().map(|secret| AvailableSecret {
            id: secret.id, alias: secret.alias, reference: secret.reference, status: secret.status, executors: vec![],
        }).collect();
        return ipc::Response::success(audit::code::OK, serde_json::json!(SecretList {
            installation_label: source_label(&installation, installation.kind), secrets: visible,
        }));
    }
    let Ok(grants) = list_grants(db) else {
        return denied(audit::code::STORAGE_FAILED, "本机秘密数据暂时不可用");
    };
    let Ok(secrets) = store::list(db, store) else {
        return denied(audit::code::STORAGE_FAILED, "本机秘密数据暂时不可用");
    };
    let Ok(executors) = executor::list(db) else {
        return denied(audit::code::STORAGE_FAILED, "本机秘密数据暂时不可用");
    };
    let mut visible: Vec<AvailableSecret> = Vec::new();
    for grant in grants.iter().filter(|grant| grant.installation_id == installation.id) {
        let Some(secret) = secrets.iter().find(|secret| secret.id == grant.secret_id) else { continue };
        let Some(executor) = executors.iter().find(|executor| executor.id == grant.executor_id) else { continue };
        let entry = AvailableExecutor {
            id: executor.id.clone(),
            label: executor.label.clone(),
            digest_ok: executor.current_digest().map(|digest| digest == executor.digest).unwrap_or(false),
        };
        match visible.iter_mut().find(|visible| visible.id == secret.id) {
            Some(existing) => existing.executors.push(entry),
            None => visible.push(AvailableSecret {
                id: secret.id.clone(),
                alias: secret.alias.clone(),
                reference: secret.reference.clone(),
                status: secret.status,
                executors: vec![entry],
            }),
        }
    }
    ipc::Response::success(
        audit::code::OK,
        serde_json::json!(SecretList { installation_label: source_label(&installation, installation.kind), secrets: visible }),
    )
}

fn check_grant(db: &Database, installation: &str, secret: &str, executor: Option<&str>) -> Result<(), (&'static str, &'static str)> {
    let granted = db.with_read_connection(|conn| {
        conn.query_row(
            "SELECT EXISTS(
               SELECT 1 FROM secret_grants g JOIN secret_installations i ON i.id = g.installation_id
               JOIN prompt_secrets s ON s.id = g.secret_id JOIN secret_executors e ON e.id = g.executor_id
               WHERE i.revoked=0 AND i.id=?1 AND g.secret_id=?2 AND (?3 IS NULL OR g.executor_id=?3)
             )",
            params![installation, secret, executor],
            |row| row.get::<_, bool>(0),
        ).map_err(sql)
    }).map_err(|_| (audit::code::STORAGE_FAILED, "本机秘密数据暂时不可用"))?;
    if granted { Ok(()) } else { Err((audit::code::GRANT_MISSING, "该连接缺少对应的秘密操作授权")) }
}

/// Controlled use: the value only reaches the registered child process, and every
/// text returned to the caller is masked first.
pub fn use_secret(
    db: &Database,
    store: &dyn CredentialStore,
    installation_id: &str,
    secret_id: &str,
    executor_id: &str,
    cancel: &AtomicBool,
) -> ipc::Response {
    let installation = match installation_checked(db, installation_id, audit::Operation::Use) {
        Ok(installation) => installation,
        Err(response) => return *response,
    };
    let fail = |code: &'static str, message: &str| {
        record(
            db,
            audit::Event {
                operation: audit::Operation::Use,
                decision: audit::Decision::Denied,
                code,
                secret_id: Some(secret_id),
                installation_id: Some(&installation.id),
                executor_id: Some(executor_id),
            },
        );
        denied(code, message)
    };
    if let Err((code, message)) = check_grant(db, &installation.id, secret_id, Some(executor_id)) {
        return fail(code, message);
    }
    let Ok(exists) = store::exists(db, secret_id) else {
        return fail(audit::code::STORAGE_FAILED, "本机秘密数据暂时不可用");
    };
    if !exists {
        return fail(audit::code::SECRET_UNKNOWN, "秘密已不存在，请重新选择引用");
    }
    let executor = match executor::load(db, executor_id) {
        Ok(executor) => executor,
        Err(_) => return fail(audit::code::EXECUTOR_UNKNOWN, "执行入口已不存在，请重新登记"),
    };
    let credential_id = match reference::credential_id(secret_id) {
        Ok(credential_id) => credential_id,
        Err(_) => return fail(audit::code::SECRET_UNKNOWN, "秘密标识无效"),
    };
    let value = match store.lookup(&credential_id) {
        Ok(Some(value)) => value,
        Ok(None) => return fail(audit::code::CREDENTIAL_MISSING, "本机缺少这个秘密的原值，未执行"),
        Err(_) => return fail(audit::code::CREDENTIAL_UNREADABLE, "无法读取秘密原值，未执行"),
    };
    match executor::run(&executor, &value, cancel) {
        Ok(outcome) => {
            let code = if outcome.exit_code == Some(0) { audit::code::OK } else { audit::code::EXIT_FAILURE };
            record(
                db,
                audit::Event {
                    operation: audit::Operation::Use,
                    decision: audit::Decision::Allowed,
                    code,
                    secret_id: Some(secret_id),
                    installation_id: Some(&installation.id),
                    executor_id: Some(&executor.id),
                },
            );
            ipc::Response::success(
                code,
                serde_json::json!(UseResult {
                    exit_code: outcome.exit_code,
                    stdout: outcome.stdout,
                    stderr: outcome.stderr,
                    elapsed_ms: outcome.elapsed_ms,
                }),
            )
        }
        Err(failure) => {
            // A failed run stays a failure: no other secret or executor is tried.
            record(
                db,
                audit::Event {
                    operation: audit::Operation::Error,
                    decision: audit::Decision::Denied,
                    code: failure.code,
                    secret_id: Some(secret_id),
                    installation_id: Some(&installation.id),
                    executor_id: Some(&executor.id),
                },
            );
            let message = executor::redact(&failure.message, &value);
            denied(failure.code, &message)
        }
    }
}

/// Single-value entry used by legacy clients and contract tests.
pub fn read_secret(
    db: &Database, store: &dyn CredentialStore, host: &dyn approval::Host, installation: &str, secret: &str,
) -> ipc::Response {
    read_secrets(db, store, host, ReadSelection {
        installation_id: installation, requested: &[secret.to_owned()], batch: false, token: None,
    }, &AtomicBool::new(false))
}

pub fn read_request(
    db: &Database, store: &dyn CredentialStore, host: &dyn approval::Host, request: &ipc::Request, cancel: &AtomicBool,
) -> ipc::Response {
    let (ids, batch) = match (&request.secret_id, &request.secret_ids, &request.executor_id) {
        (Some(id), None, None) => (std::slice::from_ref(id), false),
        (None, Some(ids), None) => (ids.as_slice(), true),
        _ => return denied(audit::code::INVALID_REQUEST, "read 需要 secretId 或 secretIds"),
    };
    read_secrets(db, store, host, ReadSelection {
        installation_id: &request.installation, requested: ids, batch, token: request.session.as_deref(),
    }, cancel)
}

type ReadError = (&'static str, &'static str);

/// Check every member against the same database snapshot before showing aliases.
fn read_aliases(db: &Database, installation: &str, ids: &[String]) -> Result<Vec<String>, ReadError> {
    db.with_read_connection(|conn| {
        let mut query = conn.prepare(
            "SELECT s.alias, EXISTS(
                SELECT 1 FROM secret_grants g JOIN secret_installations i ON i.id=g.installation_id
                JOIN secret_executors e ON e.id=g.executor_id
                WHERE i.id=?1 AND i.revoked=0 AND g.secret_id=s.id
             ) OR EXISTS (
                SELECT 1 FROM secret_direct_reads d JOIN secret_installations i ON i.id=d.installation_id
                WHERE i.id=?1 AND i.revoked=0 AND d.secret_id=s.id
             ) FROM prompt_secrets s WHERE s.id=?2"
        ).map_err(sql)?;
        let mut aliases = Vec::with_capacity(ids.len());
        for id in ids {
            let row = query.query_row(params![installation, id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?))
            }).optional().map_err(sql)?;
            match row {
                None => return Ok(Err((audit::code::SECRET_UNKNOWN, "秘密已不存在，请重新选择引用"))),
                Some((_, false)) => return Ok(Err((audit::code::GRANT_MISSING, "该连接缺少对应的秘密操作授权"))),
                Some((alias, true)) => aliases.push(alias),
            }
        }
        Ok(Ok(aliases))
    }).map_err(|_| (audit::code::STORAGE_FAILED, "本机秘密数据暂时不可用"))?
}

struct ReadSelection<'a> {
    installation_id: &'a str,
    requested: &'a [String],
    batch: bool,
    token: Option<&'a str>,
}

fn read_secrets(
    db: &Database, store: &dyn CredentialStore, host: &dyn approval::Host,
    selection: ReadSelection<'_>, cancel: &AtomicBool,
) -> ipc::Response {
    let ReadSelection { installation_id, requested, batch, token } = selection;
    if requested.is_empty() || requested.len() > 256 {
        return denied(audit::code::INVALID_REQUEST, "每次可请求 1 至 256 个秘密引用");
    }
    let mut ids = Vec::with_capacity(requested.len());
    for input in requested {
        let Ok(id) = reference::argument_id(input) else {
            return denied(audit::code::INVALID_REQUEST, "秘密引用格式无效");
        };
        if !ids.contains(&id) { ids.push(id); }
    }
    let outcome = (|| {
        let installation = live_installation(db, installation_id)?;
        let aliases = read_aliases(db, installation_id, &ids)?;
        let ended = (ipc::CODE_SESSION_ENDED, "工具会话已结束，请重新请求");
        let changed = (audit::code::EXPIRED, "会话、引用或绑定已变更，请重新请求");
        let scope = session::ReadScope::open(token, installation_id, installation.kind, &ids).ok_or(ended)?;
        let cancelled = (audit::code::CANCELLED, "读取请求已取消");
        if cancel.load(std::sync::atomic::Ordering::SeqCst) { return Err(cancelled); }

        let mut remember = false;
        if !scope.pending.is_empty() {
            let mut source = source_label(&installation, scope.source);
            if let Some(display) = &scope.display { source.push_str(&format!(" · #{display}")); }
            let pending = scope.pending.iter().map(|&index| aliases[index].clone()).collect();
            match approval::request_batch(host, pending, &source, scope.display.is_some(), approval::APPROVAL_TIMEOUT) {
                approval::Verdict::Accepted => {}
                approval::Verdict::Session => remember = true,
                approval::Verdict::Declined => return Err((audit::code::DECLINED, "已拒绝本次原值读取")),
                approval::Verdict::Expired => return Err((audit::code::EXPIRED, "确认请求已过期，未返回原值")),
                approval::Verdict::Unavailable => return Err((audit::code::APPROVAL_UNAVAILABLE, "确认窗口不可用，未返回原值")),
            }
        }
        live_installation(db, installation_id)?;
        let current_aliases = read_aliases(db, installation_id, &ids)?;
        if current_aliases != aliases || !scope.finish(false) { return Err(changed); }
        if cancel.load(std::sync::atomic::Ordering::SeqCst) { return Err(cancelled); }

        let mut results = Vec::with_capacity(ids.len());
        for (id, alias) in ids.iter().zip(aliases) {
            let value = read_value(store, id)
                .map_err(|_| (audit::code::CREDENTIAL_UNREADABLE, "无法读取秘密原值，未返回"))?
                .ok_or((audit::code::CREDENTIAL_MISSING, "本机缺少这个秘密的原值，未返回"))?;
            let mut result = serde_json::json!(ReadResult { alias, value });
            if batch { result["id"] = serde_json::json!(id); }
            results.push(result);
        }
        let data = if batch { serde_json::json!({ "secrets": results }) } else { results.remove(0) };
        let response = ipc::Response::success(audit::code::OK, data);
        if !ipc::fits_response(&response) { return Err((audit::code::OUTPUT_LIMIT, "结果超过上限，请减少本次引用数")); }
        if cancel.load(std::sync::atomic::Ordering::SeqCst) { return Err(cancelled); }
        if !scope.finish(remember) { return Err(changed); }
        Ok(response)
    })();
    let (response, decision, audit_code) = match outcome {
        Ok(response) => (response, audit::Decision::Allowed, audit::code::OK),
        Err((code, message)) => {
            let stored = if code == ipc::CODE_SESSION_ENDED { audit::code::EXPIRED } else { code };
            (denied(code, message), audit::Decision::Denied, stored)
        }
    };
    for id in &ids {
        record(db, audit::Event {
            operation: audit::Operation::Read, decision, code: audit_code,
            secret_id: Some(id), installation_id: Some(installation_id), executor_id: None,
        });
    }
    response
}

fn read_value(store: &dyn CredentialStore, secret_id: &str) -> Result<Option<String>, String> {
    let credential_id = reference::credential_id(secret_id)?;
    match store.lookup(&credential_id) {
        Ok(value) => Ok(value.filter(|value| !value.is_empty())),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
#[path = "../../tests/secrets/broker.rs"]
mod tests;
