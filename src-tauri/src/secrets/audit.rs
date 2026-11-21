//! Secret broker audit trail.
//!
//! A row records which identifier was involved, which operation ran, whether it
//! was allowed and one result code. Operations, decisions and codes are closed
//! sets: free text could carry a value, a script body or a response, and R6
//! requires diagnostics that never need the original value.
use crate::database::Database;
use crate::prompts::timestamp;
use rusqlite::params;
use serde::Serialize;

/// The operations a user can audit. `Approve`/`Decline` are the answers to a
/// read approval, `Error` marks a failure that produced no result.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    List,
    Use,
    Read,
    Approve,
    Decline,
    Error,
}

impl Operation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::List => "list",
            Self::Use => "use",
            Self::Read => "read",
            Self::Approve => "approve",
            Self::Decline => "decline",
            Self::Error => "error",
        }
    }
}

/// A decision never says what the value was, only what the broker did.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    Allowed,
    Denied,
}

impl Decision {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Allowed => "allowed",
            Self::Denied => "denied",
        }
    }
}

/// Result codes are stable strings so a stored row stays readable after an
/// upgrade. They describe the outcome, never the request body.
pub mod code {
    pub const OK: &str = "ok";
    pub const DECLINED: &str = "declined";
    pub const EXPIRED: &str = "expired";
    pub const APPROVAL_UNAVAILABLE: &str = "approval_unavailable";
    pub const INSTALLATION_UNKNOWN: &str = "installation_unknown";
    pub const INSTALLATION_REVOKED: &str = "installation_revoked";
    pub const INVALID_REQUEST: &str = "invalid_request";
    pub const GRANT_MISSING: &str = "grant_missing";
    pub const SCRIPT_CHANGED: &str = "script_changed";
    pub const EXECUTOR_UNKNOWN: &str = "executor_unknown";
    pub const SECRET_UNKNOWN: &str = "secret_unknown";
    pub const CREDENTIAL_MISSING: &str = "credential_missing";
    pub const CREDENTIAL_UNREADABLE: &str = "credential_unreadable";
    pub const SPAWN_FAILED: &str = "spawn_failed";
    pub const TIMEOUT: &str = "timeout";
    pub const CANCELLED: &str = "cancelled";
    pub const OUTPUT_LIMIT: &str = "output_limit";
    pub const EXIT_FAILURE: &str = "exit_failure";
    pub const STORAGE_FAILED: &str = "storage_failed";
}

/// One auditable event. Every optional field is an opaque identifier.
#[derive(Clone, Copy, Debug)]
pub struct Event<'a> {
    pub operation: Operation,
    pub decision: Decision,
    pub code: &'a str,
    pub secret_id: Option<&'a str>,
    pub installation_id: Option<&'a str>,
    pub executor_id: Option<&'a str>,
}

/// Identifiers are opaque UUIDs. A caller-supplied string that does not parse as
/// one is stored as null instead: free text could carry a value or a script body,
/// and a row never holds either.
fn opaque_id(value: Option<&str>) -> Option<&str> {
    value.filter(|candidate| uuid::Uuid::parse_str(candidate).is_ok())
}

/// Appends one row. Audit writes never carry a value and never fail the caller's
/// decision: a storage failure is reported so the caller can surface it.
pub fn record(db: &Database, event: Event<'_>) -> Result<(), String> {
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO secret_audit(at,operation,decision,result_code,secret_id,installation_id,executor_id)
             VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![
                timestamp() as i64,
                event.operation.as_str(),
                event.decision.as_str(),
                event.code,
                opaque_id(event.secret_id),
                opaque_id(event.installation_id),
                opaque_id(event.executor_id),
            ],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
    })
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: u64,
    pub at: u64,
    pub operation: String,
    pub decision: String,
    pub code: String,
    pub secret_id: Option<String>,
    pub installation_id: Option<String>,
    pub executor_id: Option<String>,
}

/// Newest rows first. The audit view only needs the recent history, so the query
/// is bounded instead of loading the whole table into the UI process.
pub fn list(db: &Database, limit: u32) -> Result<Vec<Entry>, String> {
    let limit = limit.clamp(1, 500) as i64;
    db.with_read_connection(|conn| {
        let mut statement = conn
            .prepare(
                "SELECT id,at,operation,decision,result_code,secret_id,installation_id,executor_id
                 FROM secret_audit ORDER BY at DESC, id DESC LIMIT ?1",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([limit], |row| {
                Ok(Entry {
                    id: row.get::<_, i64>(0)?.max(0) as u64,
                    at: row.get::<_, i64>(1)?.max(0) as u64,
                    operation: row.get(2)?,
                    decision: row.get(3)?,
                    code: row.get(4)?,
                    secret_id: row.get(5)?,
                    installation_id: row.get(6)?,
                    executor_id: row.get(7)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
    })
}
