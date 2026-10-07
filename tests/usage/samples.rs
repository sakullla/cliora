use super::*;
use crate::credentials::CredentialStore;
struct NoSecrets;
impl CredentialStore for NoSecrets {
    fn get(&self, _: &str) -> Result<String, String> {
        Err("unused".into())
    }
    fn put(&self, _: &str, _: &str) -> Result<(), String> {
        Err("unused".into())
    }
    fn delete(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
}
fn save(db: &Database) -> UsageQuery {
    let mut config = super::super::tests::config();
    config.enabled = true;
    config.refresh_interval_seconds = 60;
    save_query(
        db,
        &NoSecrets,
        UsageQueryDraft {
            id: None,
            expected_version: None,
            config,
            credentials: vec![],
        },
    )
    .unwrap()
    .query
}
fn result() -> UsageResult {
    let mut value: UsageResult =
        serde_json::from_str(include_str!("../fixtures/usage/contract-v1.json")).unwrap();
    value.metrics.retain(|m| m.missing_reason.is_none());
    value.errors.clear();
    value.status = UsageStatus::Success;
    value
}
fn failed() -> UsageResult {
    UsageResult {
        schema_version: 1,
        status: UsageStatus::Failed,
        metrics: vec![],
        errors: vec![UsageError::new(
            UsageErrorCode::Network,
            UsageStage::Http,
            "fixture failure",
        )],
    }
}
fn sample_count(db: &Database, query_id: &str) -> i64 {
    db.with_connection(|conn| {
        conn.query_row(
            "SELECT COUNT(*) FROM usage_samples WHERE query_id=?1",
            [query_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())
    })
    .unwrap()
}

#[test]
fn automatic_success_samples_but_manual_and_failed_do_not() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("usage.db")).unwrap();
    let q = save(&db);
    publish(&db, &q, result(), false).unwrap();
    assert!(list_samples(&db, &q.id).unwrap().is_empty());
    publish(&db, &q, result(), true).unwrap();
    publish(&db, &q, failed(), true).unwrap();
    publish(&db, &q, result(), true).unwrap();
    let samples = list_samples(&db, &q.id).unwrap();
    assert_eq!(samples.len(), 2);
    assert!(samples[0].measured_at <= samples[1].measured_at);
    for sample in &samples {
        assert_eq!(sample.query_id, q.id);
        assert_eq!(sample.snapshot.result.status, UsageStatus::Success);
    }
    // Other queries have no history and return empty rather than an error.
    assert!(list_samples(&db, "missing").unwrap().is_empty());
}

#[test]
fn samples_older_than_ninety_days_are_pruned_on_write_per_query() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("usage.db")).unwrap();
    let q = save(&db);
    let other = save(&db);
    publish(&db, &q, result(), true).unwrap();
    publish(&db, &other, result(), true).unwrap();
    let stale = now() - SAMPLE_RETENTION_SECONDS - 60;
    db.with_connection(|conn| {
        for id in [&q.id, &other.id] {
            conn.execute(
                "INSERT INTO usage_samples(query_id,measured_at,payload)
                   SELECT query_id, ?2, payload FROM usage_samples WHERE query_id=?1",
                rusqlite::params![id, stale],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .unwrap();
    assert_eq!(sample_count(&db, &q.id), 2);
    publish(&db, &q, result(), true).unwrap();
    let samples = list_samples(&db, &q.id).unwrap();
    assert_eq!(samples.len(), 2);
    assert!(samples.iter().all(|s| s.measured_at >= stale + 60));
    // Retention is per query: the untouched query keeps its old sample.
    assert_eq!(sample_count(&db, &other.id), 2);
}

#[test]
fn sample_write_failure_does_not_block_publication() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("usage.db")).unwrap();
    let q = save(&db);
    db.with_connection(|conn| {
        conn.execute_batch("DROP TABLE usage_samples;")
            .map_err(|e| e.to_string())
    })
    .unwrap();
    publish(&db, &q, result(), true).unwrap();
    let cache = list_cache(&db).unwrap();
    assert!(cache
        .iter()
        .find(|c| c.query_id == q.id)
        .unwrap()
        .success
        .is_some());
    assert_eq!(
        list_samples(&db, &q.id).unwrap_err().code,
        UsageErrorCode::Storage
    );
}

#[test]
fn deleting_a_query_removes_its_samples() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("usage.db")).unwrap();
    let q = save(&db);
    publish(&db, &q, result(), true).unwrap();
    assert_eq!(sample_count(&db, &q.id), 1);
    delete_query(&db, &NoSecrets, &q.id, q.version).unwrap();
    assert_eq!(sample_count(&db, &q.id), 0);
}
