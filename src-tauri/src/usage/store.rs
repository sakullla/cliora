use rusqlite::{params, Connection, OptionalExtension};

use super::*;
use crate::{credentials::CredentialStore, database::Database};

fn with_db<T>(
    db: &Database,
    action: impl FnOnce(&mut Connection) -> Result<T, UsageError>,
) -> Result<T, UsageError> {
    db.with_connection(|conn| Ok(action(conn)))
        .map_err(|_| UsageError::storage())?
}

fn read(conn: &Connection, id: &str) -> Result<Option<UsageQuery>, UsageError> {
    let data: Option<String> = conn
        .query_row(
            "SELECT data FROM usage_queries WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| UsageError::storage())?;
    data.map(|data| serde_json::from_str(&data).map_err(|_| UsageError::storage()))
        .transpose()
}

pub fn get_query(db: &Database, id: &str) -> Result<UsageQuery, UsageError> {
    with_db(db, |conn| read(conn, id)?.ok_or_else(not_found))
}

pub fn list_queries(db: &Database) -> Result<Vec<UsageQuery>, UsageError> {
    with_db(db, |conn| {
        let mut statement = conn
            .prepare("SELECT data FROM usage_queries ORDER BY id")
            .map_err(|_| UsageError::storage())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|_| UsageError::storage())?;
        rows.map(|row| {
            serde_json::from_str(&row.map_err(|_| UsageError::storage())?)
                .map_err(|_| UsageError::storage())
        })
        .collect()
    })
}

fn not_found() -> UsageError {
    UsageError::new(
        UsageErrorCode::NotFound,
        UsageStage::Storage,
        "额度查询不存在",
    )
}
fn conflict() -> UsageError {
    UsageError::new(
        UsageErrorCode::VersionConflict,
        UsageStage::Storage,
        "额度查询已变更，请重新读取后保存",
    )
}
fn credential_error() -> UsageError {
    UsageError::new(
        UsageErrorCode::Credential,
        UsageStage::Credential,
        "系统凭据保存失败；原查询未更改",
    )
}

/// Only replaced/deleted, never live references enter this durable retry queue.
/// Deletion failures are retained and reported, without undoing a committed save.
fn collect_credentials(db: &Database, secrets: &dyn CredentialStore) -> bool {
    with_db(db, |conn| {
        let refs: Vec<String> = {
            let mut statement = conn
                .prepare("SELECT secret_ref FROM usage_credential_gc")
                .map_err(|_| UsageError::storage())?;
            let rows = statement
                .query_map([], |row| row.get(0))
                .map_err(|_| UsageError::storage())?;
            rows.collect::<Result<_, _>>()
                .map_err(|_| UsageError::storage())?
        };
        let mut pending = false;
        for id in refs {
            if secrets.delete(&id).is_ok() {
                conn.execute(
                    "DELETE FROM usage_credential_gc WHERE secret_ref = ?1",
                    [id],
                )
                .map_err(|_| UsageError::storage())?;
            } else {
                pending = true;
            }
        }
        Ok(pending)
    })
    .unwrap_or(true)
}

pub(super) fn validate_draft(draft: &UsageQueryDraft) -> Result<(), UsageError> {
    draft.config.validate()?;
    if draft.id.is_some() != draft.expected_version.is_some()
        || draft.expected_version == Some(0)
        || draft
            .id
            .as_ref()
            .is_some_and(|id| !super::contract::valid_name(id))
        || draft.credentials.len() > 16
    {
        return Err(UsageError::configuration(
            "新查询不接受版本，已有查询必须携带有效版本",
        ));
    }
    let mut names = std::collections::BTreeSet::new();
    for credential in &draft.credentials {
        let origins: std::collections::BTreeSet<_> = credential.allowed_origins.iter().collect();
        if !super::contract::valid_name(&credential.name)
            || !names.insert(&credential.name)
            || origins.is_empty()
            || origins.len() != credential.allowed_origins.len()
            || origins.iter().any(|origin| {
                !draft
                    .config
                    .targets
                    .iter()
                    .any(|target| &target.origin == *origin)
            })
        {
            return Err(UsageError::configuration(
                "凭据名称须唯一，授权 origin 必须来自查询声明目标",
            ));
        }
        if let CredentialUpdate::Replace { secret } = &credential.value {
            if secret.is_empty() || secret.len() > 16_384 {
                return Err(UsageError::configuration("查询凭据不能为空或超过长度限制"));
            }
        }
    }
    Ok(())
}

pub fn save_query(
    db: &Database,
    secrets: &dyn CredentialStore,
    draft: UsageQueryDraft,
) -> Result<SaveQueryResult, UsageError> {
    validate_draft(&draft)?;
    let mut created = Vec::new();
    let outcome = with_db(db, |conn| {
        // BEGIN IMMEDIATE serializes independent database handles before checking CAS.
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| UsageError::storage())?;
        let old = match &draft.id {
            Some(id) => Some(read(&tx, id)?.ok_or_else(not_found)?),
            None => None,
        };
        if old.as_ref().map(|query| query.version) != draft.expected_version {
            return Err(conflict());
        }
        let version = old
            .as_ref()
            .map_or(Some(1), |query| query.version.checked_add(1))
            .ok_or_else(conflict)?;
        let generation = old
            .as_ref()
            .map_or(Some(1), |query| query.generation.checked_add(1))
            .ok_or_else(conflict)?;
        // Validate all Keep operations before touching the credential store.
        for credential in &draft.credentials {
            if matches!(credential.value, CredentialUpdate::Keep)
                && !old.as_ref().is_some_and(|query| {
                    query
                        .credentials
                        .iter()
                        .any(|binding| binding.name == credential.name)
                })
            {
                return Err(UsageError::configuration("只能保留此查询已有的命名凭据"));
            }
        }
        let mut bindings = Vec::new();
        for credential in &draft.credentials {
            let previous = old.as_ref().and_then(|query| {
                query
                    .credentials
                    .iter()
                    .find(|binding| binding.name == credential.name)
            });
            let changed = matches!(credential.value, CredentialUpdate::Replace { .. })
                || previous
                    .is_some_and(|binding| binding.allowed_origins != credential.allowed_origins);
            let revision = match previous {
                Some(binding) if changed => binding.revision.checked_add(1).ok_or_else(conflict)?,
                Some(binding) => binding.revision,
                None => 1,
            };
            let secret_ref = match &credential.value {
                CredentialUpdate::Keep => previous.ok_or_else(conflict)?.secret_ref.clone(),
                CredentialUpdate::Replace { secret } => {
                    let id = format!("usage-{}", uuid::Uuid::new_v4());
                    // Register before put: an OS error can occur after creating the entry.
                    created.push(id.clone());
                    secrets.put(&id, secret).map_err(|_| credential_error())?;
                    id
                }
            };
            bindings.push(CredentialBinding {
                name: credential.name.clone(),
                secret_ref,
                revision,
                allowed_origins: credential.allowed_origins.clone(),
            });
        }
        if let Some(old) = &old {
            for binding in &old.credentials {
                if !bindings
                    .iter()
                    .any(|new| new.secret_ref == binding.secret_ref)
                {
                    tx.execute(
                        "INSERT OR IGNORE INTO usage_credential_gc (secret_ref) VALUES (?1)",
                        [&binding.secret_ref],
                    )
                    .map_err(|_| UsageError::storage())?;
                }
            }
        }
        let query = UsageQuery {
            id: draft.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            version,
            generation,
            config: draft.config,
            credentials: bindings,
        };
        let data = serde_json::to_string(&query).map_err(|_| UsageError::storage())?;
        tx.execute("INSERT INTO usage_queries (id, version, generation, data) VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(id) DO UPDATE SET version=excluded.version, generation=excluded.generation, data=excluded.data",
            params![query.id, query.version, query.generation, data]).map_err(|_| UsageError::storage())?;
        tx.commit().map_err(|_| UsageError::storage())?;
        Ok(query)
    });
    if outcome.is_err() {
        // Copy-on-write leaves every old secret usable on validation, OS or SQL failure.
        for id in created {
            if secrets.delete(&id).is_err() {
                let _ = with_db(db, |conn| {
                    conn.execute(
                        "INSERT OR IGNORE INTO usage_credential_gc (secret_ref) VALUES (?1)",
                        [id],
                    )
                    .map(|_| ())
                    .map_err(|_| UsageError::storage())
                });
            }
        }
    }
    let query = outcome?;
    Ok(SaveQueryResult {
        query,
        credential_cleanup_pending: collect_credentials(db, secrets),
    })
}

pub fn delete_query(
    db: &Database,
    secrets: &dyn CredentialStore,
    id: &str,
    expected_version: u32,
) -> Result<DeleteQueryResult, UsageError> {
    with_db(db, |conn| {
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| UsageError::storage())?;
        let old = read(&tx, id)?.ok_or_else(not_found)?;
        if old.version != expected_version {
            return Err(conflict());
        }
        for binding in old.credentials {
            tx.execute(
                "INSERT OR IGNORE INTO usage_credential_gc (secret_ref) VALUES (?1)",
                [binding.secret_ref],
            )
            .map_err(|_| UsageError::storage())?;
        }
        tx.execute("DELETE FROM usage_queries WHERE id = ?1", [id])
            .map_err(|_| UsageError::storage())?;
        tx.commit().map_err(|_| UsageError::storage())?;
        Ok(())
    })?;
    Ok(DeleteQueryResult {
        credential_cleanup_pending: collect_credentials(db, secrets),
    })
}
