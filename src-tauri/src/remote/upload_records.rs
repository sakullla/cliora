//! Durable per-session upload records. One row exists per remote name this
//! application landed in a project's `.cliora/uploads/` — claimed final names
//! and failed-attempt leftovers (temporary `.cliora-upload-*` names included)
//! alike — so session-end recovery deletes exactly the recorded paths and
//! never sweeps anything else. No credentials or file contents are stored.

use rusqlite::params;

use super::uploads::LandedUpload;
use crate::database::Database;

/// One recorded landing, scoped to the remote session it belongs to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UploadRecord {
    pub target_id: String,
    pub remote_session_id: String,
    pub remote_path: String,
    pub local_name: String,
    pub created_at: i64,
}

fn valid(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && !value.chars().any(|ch| ch == '\0' || ch.is_control())
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

/// Insert one row per landed remote name, for both successful claims and
/// failure residue. The same (session, path) landing twice is the same file,
/// not a conflict; rows survive until their session is confirmed ended.
pub fn record(
    database: &Database,
    target_id: &str,
    remote_session_id: &str,
    landed: &[LandedUpload],
) -> Result<(), String> {
    if landed.is_empty() {
        return Ok(());
    }
    if !valid(target_id, 128) || !valid(remote_session_id, 256) {
        return Err("上传记录归属无效".into());
    }
    if landed.len() > 512 {
        return Err("单次上传记录条数超出上限".into());
    }
    for file in landed {
        if !valid(&file.remote_path, 8192)
            || !valid(&file.local_name, 255)
            || file.local_name.contains('/')
        {
            return Err("上传记录路径无效".into());
        }
    }
    database.with_connection(|connection| {
        for file in landed {
            connection
                .execute(
                    "INSERT INTO remote_session_uploads
                       (target_id, remote_session_id, remote_path, local_name, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT(target_id, remote_session_id, remote_path) DO NOTHING",
                    params![target_id, remote_session_id, file.remote_path, file.local_name, now()],
                )
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    })
}

fn query(
    database: &Database,
    where_clause: &str,
    params: &[&dyn rusqlite::ToSql],
) -> Result<Vec<UploadRecord>, String> {
    database.with_connection(|connection| {
        let mut statement = connection
            .prepare(&format!(
                "SELECT target_id, remote_session_id, remote_path, local_name, created_at
                 FROM remote_session_uploads {where_clause}
                 ORDER BY created_at, remote_path"
            ))
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params, |row| {
                Ok(UploadRecord {
                    target_id: row.get(0)?,
                    remote_session_id: row.get(1)?,
                    remote_path: row.get(2)?,
                    local_name: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    })
}

/// Records belonging to one remote session of one target.
pub fn list_for_session(
    database: &Database,
    target_id: &str,
    remote_session_id: &str,
) -> Result<Vec<UploadRecord>, String> {
    query(
        database,
        "WHERE target_id = ?1 AND remote_session_id = ?2",
        &[&target_id, &remote_session_id],
    )
}

/// Every pending record of a target. Used to decide whether any session of
/// that target still awaits upload recovery after a reconnect or restart.
pub fn list_for_target(database: &Database, target_id: &str) -> Result<Vec<UploadRecord>, String> {
    query(database, "WHERE target_id = ?1", &[&target_id])
}

/// Remove one session's records after its remote files were recovered (or its
/// landing is otherwise settled). Returns the number of rows removed.
pub fn delete_for_session(
    database: &Database,
    target_id: &str,
    remote_session_id: &str,
) -> Result<usize, String> {
    database.with_connection(|connection| {
        connection
            .execute(
                "DELETE FROM remote_session_uploads WHERE target_id = ?1 AND remote_session_id = ?2",
                params![target_id, remote_session_id],
            )
            .map_err(|error| error.to_string())
    })
}

#[cfg(test)]
#[path = "../../../src-tauri/tests/uploads/upload_records.rs"]
mod tests;
