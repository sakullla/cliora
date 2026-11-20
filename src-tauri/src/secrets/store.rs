//! Prompt secret metadata and lifecycle.
//!
//! SQLite stores only the secret id, display alias, credential id, version and
//! timestamps. The value itself is written through `CredentialStore`; no read in
//! this module returns it. Updating the alias keeps the same reference, deleting a
//! secret invalidates the reference, and a new secret with the same alias gets a
//! new id so old references never resolve to it.
use crate::credentials::CredentialStore;
use crate::database::Database;
use crate::prompts::timestamp;
use crate::secrets::reference;
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::Serialize;

const MAX_ALIAS: usize = 80;
const MAX_VALUE: usize = 16_384;

/// Reference status shown next to prompt text. The alias is never the authority:
/// only the metadata row plus the credential id determine availability.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SecretStatus {
    /// Metadata exists and the credential store returned a value.
    Available,
    /// Metadata exists but the credential store confirms the value is absent.
    Missing,
    /// No local secret uses this id (deleted, or created on another device).
    Unknown,
    /// The credential store failed; a read error is not reported as absence.
    Unreadable,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptSecret {
    pub id: String,
    pub alias: String,
    pub reference: String,
    pub version: u64,
    pub created_at: u64,
    pub updated_at: u64,
    pub status: SecretStatus,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptSecretReference {
    pub id: String,
    pub reference: String,
    pub alias: Option<String>,
    pub status: SecretStatus,
}

#[derive(Clone, Debug)]
struct Row {
    id: String,
    alias: String,
    credential_id: String,
    version: u64,
    created_at: u64,
    updated_at: u64,
}

fn sql(error: rusqlite::Error) -> String {
    error.to_string()
}

fn normalize_alias(alias: &str) -> Result<String, String> {
    let alias = alias.trim();
    if alias.is_empty() || alias.chars().count() > MAX_ALIAS || alias.chars().any(char::is_control) {
        return Err("秘密别名需为 1 至 80 个字符，且不能包含控制字符".into());
    }
    Ok(alias.to_owned())
}

fn validate_value(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > MAX_VALUE {
        return Err("秘密原值不能为空或超过 16 KiB".into());
    }
    Ok(())
}

fn validate_version(expected_version: u64) -> Result<(), String> {
    if expected_version == 0 || expected_version >= 9_007_199_254_740_991 {
        return Err("秘密版本无效".into());
    }
    Ok(())
}

fn row_from(id: String, alias: String, credential_id: String, version: i64, created_at: i64, updated_at: i64) -> Row {
    Row {
        id,
        alias,
        credential_id,
        version: version.max(0) as u64,
        created_at: created_at.max(0) as u64,
        updated_at: updated_at.max(0) as u64,
    }
}

fn read_row(conn: &rusqlite::Connection, id: &str) -> Result<Option<Row>, String> {
    conn.query_row(
        "SELECT id,alias,credential_id,version,created_at,updated_at FROM prompt_secrets WHERE id=?1",
        [id],
        |row| Ok(row_from(row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
    )
    .optional()
    .map_err(sql)
}

fn status_of(store: &dyn CredentialStore, credential_id: &str) -> SecretStatus {
    match store.lookup(credential_id) {
        Ok(Some(_)) => SecretStatus::Available,
        Ok(None) => SecretStatus::Missing,
        Err(_) => SecretStatus::Unreadable,
    }
}

fn describe(row: Row, store: &dyn CredentialStore) -> PromptSecret {
    PromptSecret {
        reference: reference::format(&row.id),
        status: status_of(store, &row.credential_id),
        id: row.id,
        alias: row.alias,
        version: row.version,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

fn read_one(db: &Database, store: &dyn CredentialStore, id: &str) -> Result<PromptSecret, String> {
    db.with_read_connection(|conn| read_row(conn, id))?
        .map(|row| describe(row, store))
        .ok_or_else(|| "秘密已不存在，请重新选择引用".to_string())
}

/// Local secrets with their reference status. Only aliases and reference ids cross
/// this boundary; values stay in the credential store.
pub fn list(db: &Database, store: &dyn CredentialStore) -> Result<Vec<PromptSecret>, String> {
    let rows = db.with_read_connection(|conn| {
        let mut statement = conn
            .prepare("SELECT id,alias,credential_id,version,created_at,updated_at FROM prompt_secrets ORDER BY alias COLLATE NOCASE, id")
            .map_err(sql)?;
        let rows = statement
            .query_map([], |row| Ok(row_from(row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)))
            .map_err(sql)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(sql)
    })?;
    Ok(rows.into_iter().map(|row| describe(row, store)).collect())
}

/// Create the value first, then the metadata row. A metadata failure removes the
/// new value so a failed save never leaves an unreferenced secret behind.
pub fn create(
    db: &Database,
    store: &dyn CredentialStore,
    alias: &str,
    value: &str,
) -> Result<PromptSecret, String> {
    let alias = normalize_alias(alias)?;
    validate_value(value)?;
    let id = uuid::Uuid::new_v4().to_string();
    let credential_id = reference::credential_id(&id)?;
    store
        .put(&credential_id, value)
        .map_err(|error| format!("无法保存秘密原值：{error}"))?;
    let now = timestamp() as i64;
    let inserted = db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO prompt_secrets(id,alias,credential_id,version,created_at,updated_at) VALUES(?1,?2,?3,1,?4,?4)",
            params![id, alias, credential_id, now],
        )
        .map_err(|error| {
            if error.to_string().contains("UNIQUE constraint failed: prompt_secrets.alias") {
                "已存在同名秘密，请换一个别名".to_string()
            } else {
                error.to_string()
            }
        })
    });
    if let Err(error) = inserted {
        let _ = store.delete(&credential_id);
        return Err(error);
    }
    Ok(PromptSecret {
        reference: reference::format(&id),
        id,
        alias,
        version: 1,
        created_at: now as u64,
        updated_at: now as u64,
        status: SecretStatus::Available,
    })
}

/// Rename keeps the same secret id, so existing references keep resolving here.
pub fn rename(
    db: &Database,
    store: &dyn CredentialStore,
    id: &str,
    expected_version: u64,
    alias: &str,
) -> Result<PromptSecret, String> {
    validate_version(expected_version)?;
    let alias = normalize_alias(alias)?;
    let now = timestamp() as i64;
    let changed = db.with_connection(|conn| {
        conn.execute(
            "UPDATE prompt_secrets SET alias=?3,version=version+1,updated_at=?4 WHERE id=?1 AND version=?2",
            params![id, expected_version as i64, alias, now],
        )
        .map_err(|error| {
            if error.to_string().contains("UNIQUE constraint failed: prompt_secrets.alias") {
                "已存在同名秘密，请换一个别名".to_string()
            } else {
                error.to_string()
            }
        })
    })?;
    if changed != 1 {
        return Err("秘密已更新，请重新读取后再修改".into());
    }
    read_one(db, store, id)
}

/// Replace the value behind the same credential id. The previous value is restored
/// when metadata cannot commit, so a failed update keeps the old value usable.
pub fn update_value(
    db: &Database,
    store: &dyn CredentialStore,
    id: &str,
    expected_version: u64,
    value: &str,
) -> Result<PromptSecret, String> {
    validate_version(expected_version)?;
    validate_value(value)?;
    db.with_connection(|conn| {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql)?;
        let current: Option<(String, i64)> = tx
            .query_row("SELECT credential_id,version FROM prompt_secrets WHERE id=?1", [id], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .optional()
            .map_err(sql)?;
        let Some((credential_id, version)) = current else {
            return Err("秘密已不存在，请重新选择引用".to_string());
        };
        if version.max(0) as u64 != expected_version {
            return Err("秘密已更新，请重新读取后再修改".to_string());
        }
        let previous = store
            .lookup(&credential_id)
            .map_err(|_| "无法读取当前秘密原值，未修改".to_string())?;
        store
            .put(&credential_id, value)
            .map_err(|error| format!("无法保存秘密原值：{error}"))?;
        if let Err(error) = tx.execute(
            "UPDATE prompt_secrets SET version=version+1,updated_at=?2 WHERE id=?1",
            params![id, timestamp() as i64],
        ) {
            restore(store, &credential_id, previous.as_deref());
            return Err(error.to_string());
        }
        if let Err(error) = tx.commit() {
            restore(store, &credential_id, previous.as_deref());
            return Err(error.to_string());
        }
        Ok(())
    })?;
    read_one(db, store, id)
}

fn restore(store: &dyn CredentialStore, credential_id: &str, previous: Option<&str>) {
    let _ = match previous {
        Some(value) => store.put(credential_id, value),
        None => store.delete(credential_id),
    };
}

/// Delete value and metadata. The value goes first so a failed cleanup changes
/// nothing and the user can retry; once the row is gone every reference is unknown.
pub fn delete(
    db: &Database,
    store: &dyn CredentialStore,
    id: &str,
    expected_version: u64,
) -> Result<(), String> {
    validate_version(expected_version)?;
    db.with_connection(|conn| {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql)?;
        let current: Option<(String, i64)> = tx
            .query_row("SELECT credential_id,version FROM prompt_secrets WHERE id=?1", [id], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .optional()
            .map_err(sql)?;
        let Some((credential_id, version)) = current else {
            return Err("秘密已不存在，请重新选择引用".to_string());
        };
        if version.max(0) as u64 != expected_version {
            return Err("秘密已更新，请重新读取后再修改".to_string());
        }
        store
            .delete(&credential_id)
            .map_err(|error| format!("无法从本机凭据库删除秘密原值：{error}"))?;
        tx.execute("DELETE FROM prompt_secrets WHERE id=?1 AND version=?2", params![id, expected_version as i64])
            .map_err(sql)?;
        tx.commit().map_err(sql)
    })
}

/// Resolve the canonical references in a prompt body. Unknown, missing and
/// unreadable secrets are reported separately; none of them falls back to another
/// secret or to plain text expansion.
pub fn resolve(
    db: &Database,
    store: &dyn CredentialStore,
    body: &str,
) -> Result<Vec<PromptSecretReference>, String> {
    let ids = reference::references(body);
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    db.with_read_connection(|conn| {
        let mut found = Vec::with_capacity(ids.len());
        for id in ids {
            let row = read_row(conn, &id)?;
            found.push(match row {
                Some(row) => PromptSecretReference {
                    reference: reference::format(&row.id),
                    alias: Some(row.alias),
                    status: status_of(store, &row.credential_id),
                    id: row.id,
                },
                None => PromptSecretReference {
                    reference: reference::format(&id),
                    alias: None,
                    status: SecretStatus::Unknown,
                    id,
                },
            });
        }
        Ok(found)
    })
}

#[cfg(test)]
#[path = "../../../tests/resources/prompt_secrets.rs"]
mod tests;