//! Local durable intent/outcome records for directory creation. No credentials
//! or remote content are stored, and recovery never executes mkdir.
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::database::Database;
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

fn active() -> &'static Mutex<HashSet<String>> {
    static ACTIVE: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    ACTIVE.get_or_init(Mutex::default)
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub updated_at: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome { Pending, Created, Failed, Unknown }

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InspectionState { Checking, Exists, Missing, Failed }

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Inspection {
    pub state: InspectionState,
    pub detail: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Receipt {
    pub id: String,
    pub target: Target,
    pub path: String,
    pub outcome: Outcome,
    pub detail: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inspection: Option<Inspection>,
    #[serde(default)]
    pub active: bool,
}

pub struct Guard { id: String }
impl Drop for Guard {
    fn drop(&mut self) {
        active().lock().unwrap_or_else(|error| error.into_inner()).remove(&self.id);
    }
}

/// Claim before queueing native work. A refreshed WebView cannot inspect a live
/// mutation as missing and release its duplicate protection.
pub fn claim(database: &Database, id: Option<&str>, target: &super::RemoteTarget, path: &str) -> Result<Guard, String> {
    let id = match id {
        Some(id) => id.to_owned(),
        None => {
            let receipt = Receipt { id: uuid::Uuid::new_v4().to_string(), target: Target {
                id: target.id.clone(), name: target.name.clone(), host: target.host.clone(), port: target.port,
                user: target.user.clone(), updated_at: target.updated_at,
            }, path: path.into(), outcome: Outcome::Pending, detail: String::new(), inspection: None, active: false };
            save(database, &receipt)?;
            receipt.id
        }
    };
    let mut running = active().lock().map_err(|_| "目录创建状态暂时不可用")?;
    if running.contains(&id) { return Err("目录创建仍在执行，请勿重复提交".into()); }
    database.with_connection(|connection| {
        let data: String = connection.query_row("SELECT data FROM remote_directory_receipts WHERE id = ?1", [&id], |row| row.get(0)).map_err(|error| error.to_string())?;
        let receipt: Receipt = serde_json::from_str(&data).map_err(|error| error.to_string())?;
        if receipt.outcome != Outcome::Pending || receipt.path != path || receipt.target.id != target.id
            || receipt.target.updated_at != target.updated_at || receipt.target.host != target.host
            || receipt.target.port != target.port || receipt.target.user != target.user {
            return Err("目录创建回执与原主机或路径不匹配，请先核查".into());
        }
        Ok(())
    })?;
    running.insert(id.clone());
    Ok(Guard { id })
}

impl Guard {
    /// Called inside the blocking operation, before releasing its live claim.
    pub fn finish(&self, database: &Database, outcome: Outcome, detail: String) -> Result<(), String> {
        let _running = active().lock().map_err(|_| "目录创建状态暂时不可用")?;
        database.with_connection(|connection| {
            let data: String = connection.query_row("SELECT data FROM remote_directory_receipts WHERE id = ?1", [&self.id], |row| row.get(0)).map_err(|error| error.to_string())?;
            let mut receipt: Receipt = serde_json::from_str(&data).map_err(|error| error.to_string())?;
            receipt.outcome = outcome; receipt.detail = detail; receipt.inspection = None; receipt.active = false;
            let data = serde_json::to_string(&receipt).map_err(|error| error.to_string())?;
            connection.execute("UPDATE remote_directory_receipts SET data = ?2 WHERE id = ?1", params![self.id, data]).map_err(|error| error.to_string())?;
            Ok(())
        })
    }
}

fn unresolved(receipt: &Receipt) -> bool {
    receipt.outcome == Outcome::Pending || (receipt.outcome == Outcome::Unknown
        && !matches!(receipt.inspection.as_ref().map(|item| &item.state), Some(InspectionState::Missing)))
}

pub fn list(database: &Database) -> Result<Vec<Receipt>, String> {
    let running = active().lock().map_err(|_| "目录创建状态暂时不可用")?;
    database.with_connection(|connection| {
        let mut statement = connection.prepare("SELECT data FROM remote_directory_receipts ORDER BY rowid")
            .map_err(|error| error.to_string())?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0)).map_err(|error| error.to_string())?;
        rows.map(|row| {
            let mut receipt: Receipt = serde_json::from_str(&row.map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
            receipt.active = running.contains(&receipt.id);
            if !receipt.active {
                if receipt.outcome == Outcome::Pending { receipt.outcome = Outcome::Unknown; }
                if matches!(receipt.inspection.as_ref().map(|item| &item.state), Some(InspectionState::Checking)) { receipt.inspection = None; }
            }
            Ok(receipt)
        }).collect()
    })
}

pub fn save(database: &Database, receipt: &Receipt) -> Result<(), String> {
    let running = active().lock().map_err(|_| "目录创建状态暂时不可用")?;
    if running.contains(&receipt.id) { return Err("目录创建仍在执行，请等待结果".into()); }
    if !super::valid_text(&receipt.id, 128) || !super::valid_text(&receipt.target.id, 128)
        || !super::valid_text(&receipt.path, 4096) || !super::valid_text(&receipt.target.host, 1024)
        || !super::valid_text(&receipt.target.user, 1024) || receipt.target.port == 0
        || receipt.detail.len() > 65536 || receipt.inspection.as_ref().is_some_and(|item| item.detail.len() > 65536) {
        return Err("目录创建回执无效".into());
    }
    let mut stored = receipt.clone(); stored.active = false;
    let data = serde_json::to_string(&stored).map_err(|error| error.to_string())?;
    database.with_connection(|connection| {
        let tx = connection.transaction().map_err(|error| error.to_string())?;
        let existing: Option<String> = tx.query_row("SELECT data FROM remote_directory_receipts WHERE id = ?1", [&receipt.id], |row| row.get(0))
            .optional().map_err(|error| error.to_string())?;
        if let Some(existing) = existing {
            let original: Receipt = serde_json::from_str(&existing).map_err(|error| error.to_string())?;
            if original.target != receipt.target || original.path != receipt.path {
                return Err("不能更改目录创建回执的原主机或路径".into());
            }
            if (matches!(original.outcome, Outcome::Created | Outcome::Failed) && original.outcome != receipt.outcome)
                || (original.outcome != Outcome::Pending && receipt.outcome == Outcome::Pending) {
                return Err("目录创建已有最终结果，请刷新原回执".into());
            }
        } else {
            if receipt.outcome != Outcome::Pending { return Err("新目录创建回执必须先保存待处理状态".into()); }
            let entries = {
                let mut statement = tx.prepare("SELECT data FROM remote_directory_receipts ORDER BY rowid").map_err(|error| error.to_string())?;
                let rows = statement.query_map([], |row| row.get::<_, String>(0)).map_err(|error| error.to_string())?;
                rows.map(|row| serde_json::from_str::<Receipt>(&row.map_err(|error| error.to_string())?)
                    .map_err(|error| error.to_string())).collect::<Result<Vec<_>, _>>()?
            };
            if entries.iter().any(|item| item.target.id == receipt.target.id
                && item.target.updated_at == receipt.target.updated_at && item.path == receipt.path && unresolved(item)) {
                return Err("请先核查原路径的目录创建结果".into());
            }
            if entries.len() >= 32 {
                let resolved = entries.iter().find(|item| !unresolved(item)).ok_or("待核查的目录创建结果过多")?;
                tx.execute("DELETE FROM remote_directory_receipts WHERE id = ?1", [&resolved.id]).map_err(|error| error.to_string())?;
            }
        }
        tx.execute("INSERT INTO remote_directory_receipts (id, data) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET data = excluded.data", params![receipt.id, data])
            .map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn receipt(id: &str) -> Receipt {
        Receipt { id: id.into(), target: Target { id: "fixture".into(), name: "fixture".into(), host: "fixture.invalid".into(), port: 22, user: "fixture".into(), updated_at: 7 },
            path: "/fixture/new".into(), outcome: Outcome::Pending, detail: String::new(), inspection: None, active: false }
    }

    #[test]
    fn directory_receipts_migrate_reopen_and_preserve_fault_identity() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("receipts.db");
        let database = Database::open(&path).unwrap();
        database.with_connection(|connection| {
            connection.execute_batch("DROP TABLE remote_directory_receipts; PRAGMA user_version = 28;").unwrap();
            connection.execute("INSERT INTO app_settings VALUES ('directory-fixture', 'keep')", []).unwrap();
            Ok(())
        }).unwrap();
        drop(database);
        let database = Database::open(&path).unwrap();
        let mut pending = receipt("first");
        save(&database, &pending).unwrap();
        assert!(save(&database, &receipt("duplicate")).is_err());
        drop(database);
        let database = Database::open(&path).unwrap();
        let restored = list(&database).unwrap().remove(0);
        assert_eq!(restored.outcome, Outcome::Unknown);
        assert_eq!(restored.target, pending.target);
        assert_eq!(restored.path, pending.path);
        pending.outcome = Outcome::Unknown;
        pending.inspection = Some(Inspection { state: InspectionState::Checking, detail: String::new() });
        save(&database, &pending).unwrap();
        drop(database);
        let database = Database::open(&path).unwrap();
        assert!(list(&database).unwrap()[0].inspection.is_none());
        let mut changed = pending.clone();
        changed.target.updated_at += 1;
        assert!(save(&database, &changed).is_err());
        changed = pending.clone(); changed.path.push_str("-other");
        assert!(save(&database, &changed).is_err());
        assert!(save(&database, &receipt("still-blocked")).is_err());
        pending.inspection = Some(Inspection { state: InspectionState::Missing, detail: "confirmed missing".into() });
        save(&database, &pending).unwrap();
        save(&database, &receipt("explicit-next")).unwrap();
        database.with_connection(|connection| {
            let value: String = connection.query_row("SELECT value FROM app_settings WHERE key = 'directory-fixture'", [], |row| row.get(0)).unwrap();
            assert_eq!(value, "keep");
            let version: u32 = connection.query_row("PRAGMA user_version", [], |row| row.get(0)).unwrap();
            assert_eq!(version, 29);
            Ok(())
        }).unwrap();
    }

    #[test]
    fn directory_receipts_failed_transaction_keeps_original_fault() {
        let database = Database::open(std::path::Path::new(":memory:")).unwrap();
        let pending = receipt("first");
        save(&database, &pending).unwrap();
        database.with_connection(|connection| {
            connection.execute_batch("CREATE TRIGGER reject_receipt BEFORE UPDATE ON remote_directory_receipts BEGIN SELECT RAISE(ABORT, 'fixture full'); END;").unwrap();
            Ok(())
        }).unwrap();
        let mut updated = pending;
        updated.outcome = Outcome::Created;
        assert!(save(&database, &updated).is_err());
        assert_eq!(list(&database).unwrap()[0].outcome, Outcome::Unknown);
        assert!(save(&database, &receipt("duplicate")).is_err());
    }

    #[test]
    fn directory_receipts_active_native_claim_survives_view_reload_and_rejects_stale_inspection() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("active.db");
        let database = Database::open(&path).unwrap();
        let mut pending = receipt("active-native");
        save(&database, &pending).unwrap();
        let target: super::super::RemoteTarget = serde_json::from_value(serde_json::json!({
            "id": "fixture", "name": "fixture", "host": "fixture.invalid", "port": 22, "user": "fixture",
            "authMethod": "key", "enabled": true, "createdAt": 1, "updatedAt": 7
        })).unwrap();
        let guard = claim(&database, Some(&pending.id), &target, &pending.path).unwrap();
        let reopened = Database::open(&path).unwrap();
        let live = list(&reopened).unwrap().remove(0);
        assert_eq!(live.outcome, Outcome::Pending);
        assert!(live.active);
        pending.outcome = Outcome::Unknown;
        pending.inspection = Some(Inspection { state: InspectionState::Missing, detail: "stale read".into() });
        assert!(save(&reopened, &pending).is_err());
        assert!(save(&reopened, &receipt("active-duplicate")).is_err());
        assert!(claim(&reopened, Some(&pending.id), &target, &pending.path).is_err());
        guard.finish(&database, Outcome::Created, String::new()).unwrap();
        drop(guard);
        assert!(save(&reopened, &pending).is_err(), "late unknown/missing cannot replace native success");
        let completed = list(&reopened).unwrap().remove(0);
        assert_eq!(completed.outcome, Outcome::Created);
        assert!(!completed.active);
        assert!(completed.inspection.is_none());
    }

    #[test]
    fn directory_receipts_failed_persistence_never_enters_dispatch_and_recovers() {
        let database = Database::open(std::path::Path::new(":memory:")).unwrap();
        database.with_connection(|connection| {
            connection.execute_batch("CREATE TRIGGER reject_intent BEFORE INSERT ON remote_directory_receipts BEGIN SELECT RAISE(ABORT, 'fixture full'); END;").unwrap();
            Ok(())
        }).unwrap();
        let target: super::super::RemoteTarget = serde_json::from_value(serde_json::json!({
            "id": "fixture", "name": "fixture", "host": "fixture.invalid", "port": 22, "user": "fixture",
            "authMethod": "key", "enabled": true, "createdAt": 1, "updatedAt": 7
        })).unwrap();
        let mut dispatched = 0;
        if let Ok(_guard) = claim(&database, None, &target, "/fixture/new") { dispatched += 1; }
        assert_eq!(dispatched, 0);
        assert!(list(&database).unwrap().is_empty());
        database.with_connection(|connection| { connection.execute_batch("DROP TRIGGER reject_intent;").unwrap(); Ok(()) }).unwrap();
        let guard = claim(&database, None, &target, "/fixture/new").unwrap();
        assert!(list(&database).unwrap()[0].active);
        drop(guard); // Simulate local interruption before a final result.
        let interrupted = list(&database).unwrap().remove(0);
        assert_eq!(interrupted.outcome, Outcome::Unknown);
        assert!(!interrupted.active);
    }
}
