//! The central secret broker.
//!
//! One process handles every entry point: the local CLI helper, and later the MCP
//! stdio helper. It resolves installations and grants, runs a registered executor
//! with a fixed argv, asks for a fresh approval on every value read, masks the
//! value out of any text it returns and writes one audit row per decision. A
//! failed check never falls back to another secret.
use crate::credentials::CredentialStore;
use crate::database::Database;
use crate::secrets::{approval, audit, executor, ipc, reference, store};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::atomic::AtomicBool;

/// The label a CLI helper reports as its request source. The MCP helper (a later
/// task) uses the same broker and reports its own source.
pub const SOURCE_CLI: &str = "CLI";

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
    Ok(Installation {
        id: row.get(0)?,
        label: row.get(1)?,
        kind: Kind::parse(&kind).unwrap_or(Kind::Cli),
        target_id: row.get(3)?,
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
        tx.commit().map_err(sql)
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
            "SELECT EXISTS(SELECT 1 FROM secret_installations WHERE id=?1 AND revoked=0)",
            [installation_id], |row| row.get(0),
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
        conn.execute(
            "DELETE FROM secret_grants WHERE installation_id=?1 AND secret_id=?2 AND executor_id=?3",
            params![installation_id, secret_id, executor_id],
        )
        .map_err(sql)
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

fn installation_checked(
    db: &Database,
    installation_id: &str,
    operation: audit::Operation,
) -> Result<Installation, Box<ipc::Response>> {
    match load_installation(db, installation_id) {
        Ok(Some(installation)) if !installation.revoked => Ok(installation),
        Ok(Some(_)) => {
            record(
                db,
                audit::Event {
                    operation,
                    decision: audit::Decision::Denied,
                    code: audit::code::INSTALLATION_REVOKED,
                    secret_id: None,
                    installation_id: Some(installation_id),
                    executor_id: None,
                },
            );
            Err(Box::new(denied(audit::code::INSTALLATION_REVOKED, "安装标识已撤销；请在资料库重新启用受控使用")))
        }
        Ok(None) => {
            record(
                db,
                audit::Event {
                    operation,
                    decision: audit::Decision::Denied,
                    code: audit::code::INSTALLATION_UNKNOWN,
                    secret_id: None,
                    installation_id: Some(installation_id),
                    executor_id: None,
                },
            );
            Err(Box::new(denied(audit::code::INSTALLATION_UNKNOWN, "安装标识无效；请在资料库查看命令说明")))
        }
        Err(_) => Err(Box::new(denied(audit::code::STORAGE_FAILED, "本机秘密数据暂时不可用"))),
    }
}

/// A failed installation re-check records the response's own closed-set code, so a
/// storage failure is not filed as a revocation and no free text is ever stored.
fn recheck_code(code: &str) -> &'static str {
    match code {
        audit::code::INSTALLATION_UNKNOWN => audit::code::INSTALLATION_UNKNOWN,
        audit::code::INSTALLATION_REVOKED => audit::code::INSTALLATION_REVOKED,
        audit::code::INVALID_REQUEST => audit::code::INVALID_REQUEST,
        audit::code::STORAGE_FAILED => audit::code::STORAGE_FAILED,
        _ => audit::code::INSTALLATION_REVOKED,
    }
}

fn source_label(installation: &Installation) -> String {
    match (&installation.target_id, installation.kind) {
        (Some(target), Kind::Cli) => format!("{SOURCE_CLI} · {} · {target}", installation.label),
        (_, Kind::Cli) => format!("{SOURCE_CLI} · {}", installation.label),
        (Some(target), Kind::Mcp) => format!("MCP · {} · {target}", installation.label),
        (_, Kind::Mcp) => format!("MCP · {}", installation.label),
    }
}

/// Secrets the installation may use, with the executors it may run them through.
pub fn list(db: &Database, store: &dyn CredentialStore, installation_id: &str) -> ipc::Response {
    let installation = match installation_checked(db, installation_id, audit::Operation::List) {
        Ok(installation) => installation,
        Err(response) => return *response,
    };
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
        serde_json::json!(SecretList { installation_label: source_label(&installation), secrets: visible }),
    )
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
    // The grant must match exactly: an unknown secret, an unknown executor or a
    // different pairing is refused before any value is read.
    let Ok(granted) = db.with_read_connection(|conn| {
        conn.query_row(
            "SELECT EXISTS(
               SELECT 1 FROM secret_grants g
               JOIN prompt_secrets s ON s.id = g.secret_id
               JOIN secret_executors e ON e.id = g.executor_id
               WHERE g.installation_id=?1 AND g.secret_id=?2 AND g.executor_id=?3
             )",
            params![installation.id, secret_id, executor_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(sql)
    }) else {
        return fail(audit::code::STORAGE_FAILED, "本机秘密数据暂时不可用");
    };
    if !granted {
        return fail(audit::code::GRANT_MISSING, "该安装标识未获授权使用这个执行入口和秘密");
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

/// Raw read: a fresh approval is required every time, and only this call receives
/// the value. An accepted controlled use is not an accepted read.
pub fn read_secret(
    db: &Database,
    store: &dyn CredentialStore,
    host: &dyn approval::Host,
    installation_id: &str,
    secret_id: &str,
) -> ipc::Response {
    let installation = match installation_checked(db, installation_id, audit::Operation::Read) {
        Ok(installation) => installation,
        Err(response) => return *response,
    };
    let Ok(alias) = store::metadata_alias(db, secret_id) else {
        return denied(audit::code::STORAGE_FAILED, "本机秘密数据暂时不可用");
    };
    let Some(alias) = alias else {
        record(
            db,
            audit::Event {
                operation: audit::Operation::Read,
                decision: audit::Decision::Denied,
                code: audit::code::SECRET_UNKNOWN,
                secret_id: Some(secret_id),
                installation_id: Some(&installation.id),
                executor_id: None,
            },
        );
        return denied(audit::code::SECRET_UNKNOWN, "秘密已不存在，请重新选择引用");
    };
    let source = source_label(&installation);
    let verdict = approval::request(host, &alias, &source);
    let (response, decision, code) = match verdict {
        approval::Verdict::Accepted => {
            record(
                db,
                audit::Event {
                    operation: audit::Operation::Approve,
                    decision: audit::Decision::Allowed,
                    code: audit::code::OK,
                    secret_id: Some(secret_id),
                    installation_id: Some(&installation.id),
                    executor_id: None,
                },
            );
            // The installation may have been revoked while the window was open, and
            // the value may have changed or disappeared: resolve both again.
            match installation_checked(db, installation_id, audit::Operation::Read) {
                Err(response) => {
                    let code = recheck_code(&response.code);
                    (*response, audit::Decision::Denied, code)
                }
                Ok(_) => match read_value(store, secret_id) {
                    Ok(Some(value)) => (
                        ipc::Response::success(
                            audit::code::OK,
                            serde_json::json!(ReadResult { alias, value }),
                        ),
                        audit::Decision::Allowed,
                        audit::code::OK,
                    ),
                    Ok(None) => (
                        denied(audit::code::CREDENTIAL_MISSING, "本机缺少这个秘密的原值，未返回"),
                        audit::Decision::Denied,
                        audit::code::CREDENTIAL_MISSING,
                    ),
                    Err(_) => (
                        denied(audit::code::CREDENTIAL_UNREADABLE, "无法读取秘密原值，未返回"),
                        audit::Decision::Denied,
                        audit::code::CREDENTIAL_UNREADABLE,
                    ),
                },
            }
        }
        approval::Verdict::Declined => {
            record(
                db,
                audit::Event {
                    operation: audit::Operation::Decline,
                    decision: audit::Decision::Denied,
                    code: audit::code::DECLINED,
                    secret_id: Some(secret_id),
                    installation_id: Some(&installation.id),
                    executor_id: None,
                },
            );
            (denied(audit::code::DECLINED, "已拒绝本次原值读取"), audit::Decision::Denied, audit::code::DECLINED)
        }
        approval::Verdict::Expired => (
            denied(audit::code::EXPIRED, "确认请求已过期，未返回原值"),
            audit::Decision::Denied,
            audit::code::EXPIRED,
        ),
        approval::Verdict::Unavailable => (
            denied(audit::code::APPROVAL_UNAVAILABLE, "确认窗口不可用，未返回原值"),
            audit::Decision::Denied,
            audit::code::APPROVAL_UNAVAILABLE,
        ),
    };
    record(
        db,
        audit::Event {
            operation: audit::Operation::Read,
            decision,
            code,
            secret_id: Some(secret_id),
            installation_id: Some(&installation.id),
            executor_id: None,
        },
    );
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
