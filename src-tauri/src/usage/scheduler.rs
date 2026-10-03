//! Saved-query scheduling is owned by the desktop process, independent of UI lifetime.
use super::*;
use crate::{credentials::SystemCredentialStore, database::Database};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageCache {
    pub query_id: String,
    pub generation: u32,
    pub success: Option<UsageSnapshot>,
    pub attempted_at: Option<String>,
    pub errors: Vec<UsageError>,
    pub next_allowed_at: i64,
    pub next_auto_at: i64,
    pub failures: u32,
    pub auth_paused: bool,
    #[serde(default)]
    pub refreshing: bool,
}
struct Flight {
    generation: u32,
    execution: String,
    cancelled: bool,
}
type Flights = HashMap<String, Flight>;
static FLIGHTS: OnceLock<Mutex<Flights>> = OnceLock::new();
fn flights() -> &'static Mutex<Flights> {
    FLIGHTS.get_or_init(Mutex::default)
}
fn now() -> i64 {
    chrono::Utc::now().timestamp()
}
impl UsageCache {
    fn empty(q: &UsageQuery, time: i64) -> Self {
        Self {
            query_id: q.id.clone(),
            generation: q.generation,
            success: None,
            attempted_at: None,
            errors: vec![],
            next_allowed_at: 0,
            next_auto_at: time + i64::from(q.config.refresh_interval_seconds),
            failures: 0,
            auth_paused: false,
            refreshing: false,
        }
    }
}
fn read(conn: &rusqlite::Connection, q: &UsageQuery) -> Result<UsageCache, String> {
    let data: Option<String> = conn
        .query_row(
            "SELECT data FROM usage_cache WHERE query_id=?1 AND generation=?2",
            params![q.id, q.generation],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    data.map(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
        .unwrap_or_else(|| Ok(UsageCache::empty(q, 0)))
}
fn write(conn: &rusqlite::Connection, cache: &UsageCache) -> Result<(), String> {
    conn.execute("INSERT INTO usage_cache(query_id,generation,data) VALUES(?1,?2,?3) ON CONFLICT(query_id) DO UPDATE SET generation=excluded.generation,data=excluded.data", params![cache.query_id,cache.generation,serde_json::to_string(cache).map_err(|e| e.to_string())?]).map(|_| ()).map_err(|e| e.to_string())
}
pub(super) fn reset(conn: &rusqlite::Connection, q: &UsageQuery) -> Result<(), UsageError> {
    write(conn, &UsageCache::empty(q, now())).map_err(|_| UsageError::storage())
}
pub(super) fn invalidate(id: &str, generation: Option<u32>) {
    if let Ok(state) = flights().lock() {
        if let Some(flight) = state.get(id) {
            if generation.is_none_or(|current| flight.generation < current) {
                let _ = cancel_test_execution(&flight.execution);
            }
        }
    }
}
pub fn cancel_refresh(id: &str) -> Result<(), UsageError> {
    let mut state = flights().lock().map_err(|_| UsageError::storage())?;
    if let Some(flight) = state.get_mut(id) {
        flight.cancelled = true;
        cancel_test_execution(&flight.execution)?;
    }
    Ok(())
}
pub fn list_cache(db: &Database) -> Result<Vec<UsageCache>, UsageError> {
    let state = flights().lock().map_err(|_| UsageError::storage())?;
    let queries = list_queries(db)?;
    // Account/context/profile changes invalidate display immediately, even when
    // refresh is manual. Do not show another account's previous success.
    let invalid: HashMap<_, _> = queries
        .iter()
        .filter_map(|q| {
            if matches!(&q.config.program, QueryProgram::Official { tool, .. } if crate::adapters::official::get(tool).is_ok_and(|a|a.capability().account_required)) {
                super::official::selection(db, &q.config)
                    .err()
                    .map(|error| (q.id.clone(), error))
            } else {
                if matches!(q.config.program, QueryProgram::ProfileBuiltin { .. }) {
                    super::profile::selection(db, &q.config).err().map(|error| (q.id.clone(), error))
                } else { None }
            }
        })
        .collect();
    db.with_connection(|conn| {
        queries
            .iter()
            .map(|q| {
                let mut cache = read(conn, q)?;
                cache.refreshing = state.contains_key(&q.id);
                if let Some(error) = invalid.get(&q.id) {
                    cache.success = None;
                    cache.errors = vec![error.clone()];
                    cache.auth_paused = true;
                }
                Ok(cache)
            })
            .collect()
    })
    .map_err(|_| UsageError::storage())
}
fn due(cache: &UsageCache, q: &UsageQuery, manual: bool, time: i64) -> bool {
    q.config.enabled
        && time >= cache.next_allowed_at
        && (manual
            || (q.config.refresh_interval_seconds >= 60
                && !cache.auth_paused
                && time >= cache.next_auto_at))
}
fn update(cache: &mut UsageCache, q: &UsageQuery, result: UsageResult, time: i64) {
    cache.attempted_at = Some(chrono::Utc::now().to_rfc3339());
    cache.errors = result.errors.clone();
    let errors = &result.errors;
    cache.auth_paused = errors.iter().any(|e| {
        matches!(
            e.code,
            UsageErrorCode::Authentication
                | UsageErrorCode::Permission
                | UsageErrorCode::Credential
        )
    });
    let cancelled = errors.iter().any(|e| e.code == UsageErrorCode::Cancelled);
    let delay = errors
        .iter()
        .filter_map(|e| e.retry_after_seconds)
        .max()
        .unwrap_or(0);
    cache.next_allowed_at = time.saturating_add(i64::from(delay));
    if result.status != UsageStatus::Failed {
        cache.success = UsageSnapshot::saved(q, result.clone()).ok();
    }
    cache.failures = if errors.is_empty() || cancelled {
        0
    } else {
        cache.failures.saturating_add(1)
    };
    let backoff = if cache.failures == 0 {
        0
    } else {
        60i64
            .saturating_mul(1i64 << cache.failures.min(6))
            .min(3600)
    };
    // Stable query jitter avoids synchronized account requests after restart.
    let jitter = q.id.bytes().fold(0u32, |a, b| a.wrapping_add(u32::from(b))) % 17;
    cache.next_auto_at = time
        .saturating_add(
            i64::from(q.config.refresh_interval_seconds).max(backoff) + i64::from(jitter),
        )
        .max(cache.next_allowed_at);
    cache.refreshing = false;
}
fn publish(db: &Database, q: &UsageQuery, result: UsageResult) -> Result<(), UsageError> {
    db.with_connection(|conn| {
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let generation: Option<u32> = tx
            .query_row(
                "SELECT generation FROM usage_queries WHERE id=?1",
                [&q.id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if generation != Some(q.generation) {
            return Ok(());
        }
        let mut cache = read(&tx, q)?;
        update(&mut cache, q, result, now());
        write(&tx, &cache)?;
        tx.commit().map_err(|e| e.to_string())
    })
    .map_err(|_| UsageError::storage())
}
/// Returns immediately; repeated requests coalesce by persisted query identity.
pub fn refresh_query(db: Arc<Database>, id: &str, manual: bool) -> Result<(), UsageError> {
    refresh_with(db, id, manual, run_saved)
}
fn run_saved(db: &Database, q: &UsageQuery, execution: String) -> UsageResult {
    let draft = UsageQueryDraft {
        id: Some(q.id.clone()),
        expected_version: Some(q.version),
        config: q.config.clone(),
        credentials: q
            .credentials
            .iter()
            .map(|c| CredentialDraft {
                name: c.name.clone(),
                allowed_origins: c.allowed_origins.clone(),
                value: CredentialUpdate::Keep,
            })
            .collect(),
    };
    let report = test_draft(db, &SystemCredentialStore, execution, 0, draft);
    match report {
        Ok(report) => report.runtime.result.unwrap_or_else(|| UsageResult {
            schema_version: 1,
            status: UsageStatus::Failed,
            metrics: vec![],
            errors: vec![report.runtime.error.unwrap_or_else(UsageError::storage)],
        }),
        Err(e) => UsageResult {
            schema_version: 1,
            status: UsageStatus::Failed,
            metrics: vec![],
            errors: vec![e],
        },
    }
}
fn refresh_with(
    db: Arc<Database>,
    id: &str,
    manual: bool,
    run: impl FnOnce(&Database, &UsageQuery, String) -> UsageResult + Send + 'static,
) -> Result<(), UsageError> {
    let mut state = flights().lock().map_err(|_| UsageError::storage())?;
    if state.contains_key(id) {
        return Ok(());
    }
    let q = get_query(&db, id)?;
    let cache = db
        .with_connection(|c| read(c, &q))
        .map_err(|_| UsageError::storage())?;
    if !due(&cache, &q, manual, now()) {
        return Ok(());
    }
    // Includes queued saved jobs; helper registry also bounds drafts + saved together.
    if state.len() >= 4 {
        return Err(UsageError::new(
            UsageErrorCode::ResourceLimit,
            UsageStage::Launch,
            "额度查询正在排队，请稍后刷新",
        ));
    }
    let execution = create_test_execution()?;
    state.insert(
        id.into(),
        Flight {
            generation: q.generation,
            execution: execution.clone(),
            cancelled: false,
        },
    );
    let task_id = id.to_owned();
    let spawn = std::thread::Builder::new()
        .name("usage-refresh".into())
        .spawn(move || {
            struct Finish(String);
            impl Drop for Finish {
                fn drop(&mut self) {
                    if let Ok(mut map) = flights().lock() {
                        map.remove(&self.0);
                    }
                }
            }
            let _finish = Finish(task_id);
            let mut result = run(&db, &q, execution.clone());
            let _ = cancel_test_execution(&execution);
            // Serialize cancellation with publication, including after helper EOF.
            if let Ok(state) = flights().lock() {
                if state.get(&q.id).is_some_and(|flight| flight.cancelled) {
                    result = UsageResult {
                        schema_version: 1,
                        status: UsageStatus::Failed,
                        metrics: vec![],
                        errors: vec![UsageError::new(
                            UsageErrorCode::Cancelled,
                            UsageStage::Script,
                            "额度刷新已取消",
                        )],
                    };
                }
                let _ = publish(&db, &q, result);
            }
        });
    if spawn.is_err() {
        if let Some(flight) = state.remove(id) {
            let _ = cancel_test_execution(&flight.execution);
        }
        return Err(UsageError::new(
            UsageErrorCode::ResourceLimit,
            UsageStage::Launch,
            "无法启动额度刷新",
        ));
    }
    Ok(())
}
pub fn scheduler_tick(db: Arc<Database>) -> Result<(), UsageError> {
    for q in list_queries(&db)? {
        if q.config.enabled && q.config.refresh_interval_seconds >= 60 {
            let _ = refresh_query(db.clone(), &q.id, false);
        }
    }
    Ok(())
}
#[cfg(test)]
#[path = "../../../tests/usage/scheduler.rs"]
mod tests;
