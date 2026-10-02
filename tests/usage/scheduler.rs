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
fn draft(q: Option<&UsageQuery>) -> UsageQueryDraft {
    let mut config = super::super::tests::config();
    config.enabled = true;
    config.refresh_interval_seconds = 60;
    UsageQueryDraft {
        id: q.map(|q| q.id.clone()),
        expected_version: q.map(|q| q.version),
        config,
        credentials: vec![],
    }
}
fn result() -> UsageResult {
    let mut value: UsageResult =
        serde_json::from_str(include_str!("../fixtures/usage/contract-v1.json")).unwrap();
    value.metrics.retain(|m| m.missing_reason.is_none());
    value.errors.clear();
    value.status = UsageStatus::Success;
    value
}
fn failure(code: UsageErrorCode, delay: Option<u32>) -> UsageResult {
    let mut e = UsageError::new(code, UsageStage::Http, "fixture failure");
    e.retry_after_seconds = delay;
    UsageResult {
        schema_version: 1,
        status: UsageStatus::Failed,
        metrics: vec![],
        errors: vec![e],
    }
}
#[test]
fn failures_preserve_success_and_retry_after_cannot_be_bypassed() {
    let q = UsageQuery {
        id: "a".into(),
        version: 1,
        generation: 1,
        config: draft(None).config,
        credentials: vec![],
    };
    let mut cache = UsageCache::empty(&q, 100);
    assert!(!due(&cache, &q, false, 101));
    update(&mut cache, &q, result(), 101);
    let saved = cache.success.clone().unwrap();
    update(
        &mut cache,
        &q,
        failure(UsageErrorCode::RateLimit, Some(600)),
        200,
    );
    assert_eq!(cache.success, Some(saved));
    assert!(!due(&cache, &q, true, 799));
    assert!(due(&cache, &q, true, 800));
    update(
        &mut cache,
        &q,
        failure(UsageErrorCode::Authentication, None),
        900,
    );
    assert!(!due(&cache, &q, false, 100000));
    assert!(due(&cache, &q, true, 901));
    assert!(cache.auth_paused);
    update(&mut cache, &q, result(), 1000);
    assert!(!cache.auth_paused);
    assert_eq!(cache.failures, 0);
}
#[test]
fn persisted_cache_isolated_and_old_generation_cannot_publish() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("usage.db");
    let db = Database::open(&path).unwrap();
    let q = save_query(&db, &NoSecrets, draft(None)).unwrap().query;
    let other = save_query(&db, &NoSecrets, draft(None)).unwrap().query;
    publish(&db, &q, result()).unwrap();
    drop(db);
    let db = Database::open(&path).unwrap();
    let cache = list_cache(&db).unwrap();
    assert!(cache
        .iter()
        .find(|c| c.query_id == q.id)
        .unwrap()
        .success
        .is_some());
    assert!(cache
        .iter()
        .find(|c| c.query_id == other.id)
        .unwrap()
        .success
        .is_none());
    let updated = save_query(&db, &NoSecrets, draft(Some(&q))).unwrap().query;
    publish(&db, &q, result()).unwrap();
    let cache = list_cache(&db).unwrap();
    let current = cache.iter().find(|c| c.query_id == q.id).unwrap();
    assert_eq!(current.generation, updated.generation);
    assert!(current.success.is_none());
    delete_query(&db, &NoSecrets, &updated.id, updated.version).unwrap();
    publish(&db, &q, result()).unwrap();
    assert_eq!(list_cache(&db).unwrap().len(), 1);
}
#[test]
fn cancellation_does_not_add_backoff_and_disabled_does_not_refresh() {
    let mut q = UsageQuery {
        id: "b".into(),
        version: 1,
        generation: 1,
        config: draft(None).config,
        credentials: vec![],
    };
    let mut cache = UsageCache::empty(&q, 100);
    update(&mut cache, &q, failure(UsageErrorCode::Network, None), 200);
    let first = cache.next_auto_at;
    update(&mut cache, &q, failure(UsageErrorCode::Network, None), 200);
    assert!(cache.next_auto_at > first);
    update(
        &mut cache,
        &q,
        failure(UsageErrorCode::Cancelled, None),
        200,
    );
    assert_eq!(cache.failures, 0);
    q.config.enabled = false;
    assert!(!due(&cache, &q, true, 10000));
}

#[test]
fn concurrent_clicks_coalesce_and_edit_discards_late_completion() {
    let _serial = super::super::helper::REGISTRY_TEST_LOCK.lock().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(Database::open(&dir.path().join("db")).unwrap());
    let q = save_query(&db, &NoSecrets, draft(None)).unwrap().query;
    let (send, receive) = std::sync::mpsc::channel();
    let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let count = hits.clone();
    refresh_with(db.clone(), &q.id, true, move |_, _, _| {
        count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        receive.recv().unwrap();
        result()
    })
    .unwrap();
    let threads: Vec<_> = (0..12)
        .map(|_| {
            let db = db.clone();
            let id = q.id.clone();
            std::thread::spawn(move || {
                refresh_with(db, &id, true, |_, _, _| panic!("duplicate refresh"))
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap().unwrap();
    }
    assert!(list_cache(&db).unwrap()[0].refreshing);
    let next = save_query(&db, &NoSecrets, draft(Some(&q))).unwrap().query;
    send.send(()).unwrap();
    for _ in 0..100 {
        if !list_cache(&db).unwrap()[0].refreshing {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let cache = list_cache(&db).unwrap();
    assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert!(!cache[0].refreshing);
    assert!(cache[0].success.is_none());
    assert_eq!(cache[0].generation, next.generation);
    let execution = create_test_execution().unwrap();
    cancel_test_execution(&execution).unwrap();
}
#[test]
fn v14_queries_without_cache_are_due_but_new_saves_wait_for_interval() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("old.db");
    let db = Database::open(&path).unwrap();
    let q = save_query(&db, &NoSecrets, draft(None)).unwrap().query;
    let cache = list_cache(&db).unwrap();
    assert!(!due(&cache[0], &q, false, now()));
    db.with_connection(|c| {
        c.execute_batch("DROP TABLE usage_cache; PRAGMA user_version=14;")
            .map_err(|e| e.to_string())
    })
    .unwrap();
    drop(db);
    let db = Database::open(&path).unwrap();
    let cache = list_cache(&db).unwrap();
    assert!(due(&cache[0], &q, false, now()));
    assert!(cache[0].success.is_none());
}

#[test]
fn saved_jobs_share_draft_capacity_and_have_bounded_worker_count() {
    let _serial = super::super::helper::REGISTRY_TEST_LOCK.lock().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(Database::open(&dir.path().join("db")).unwrap());
    let queries: Vec<_> = (0..5)
        .map(|_| save_query(&db, &NoSecrets, draft(None)).unwrap().query)
        .collect();
    let reservations: Vec<_> = (0..20).map(|_| create_test_execution().unwrap()).collect();
    assert_eq!(
        refresh_with(db.clone(), &queries[0].id, true, |_, _, _| panic!(
            "full draft queue"
        ))
        .unwrap_err()
        .code,
        UsageErrorCode::ResourceLimit
    );
    for id in reservations {
        cancel_test_execution(&id).unwrap();
    }
    let mut releases = Vec::new();
    for q in &queries[..4] {
        let (send, receive) = std::sync::mpsc::channel();
        releases.push(send);
        refresh_with(db.clone(), &q.id, true, move |_, _, _| {
            receive.recv().unwrap();
            result()
        })
        .unwrap();
    }
    assert_eq!(
        refresh_with(db.clone(), &queries[4].id, true, |_, _, _| panic!(
            "worker capacity"
        ))
        .unwrap_err()
        .code,
        UsageErrorCode::ResourceLimit
    );
    assert_eq!(
        list_cache(&db)
            .unwrap()
            .iter()
            .filter(|c| c.refreshing)
            .count(),
        4
    );
    for send in releases {
        send.send(()).unwrap();
    }
    for _ in 0..100 {
        if list_cache(&db).unwrap().iter().all(|c| !c.refreshing) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert_eq!(
        list_cache(&db)
            .unwrap()
            .iter()
            .filter(|c| c.success.is_some())
            .count(),
        4
    );
}

#[test]
fn explicit_cancel_between_execution_and_publication_never_publishes_success() {
    let _serial = super::super::helper::REGISTRY_TEST_LOCK.lock().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(Database::open(&dir.path().join("db")).unwrap());
    let q = save_query(&db, &NoSecrets, draft(None)).unwrap().query;
    publish(&db, &q, result()).unwrap();
    let previous = list_cache(&db).unwrap()[0].success.clone();
    let (send, receive) = std::sync::mpsc::channel();
    refresh_with(db.clone(), &q.id, true, move |_, _, _| {
        receive.recv().unwrap();
        result()
    })
    .unwrap();
    cancel_refresh(&q.id).unwrap();
    send.send(()).unwrap();
    for _ in 0..100 {
        if !list_cache(&db).unwrap()[0].refreshing {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let cache = list_cache(&db).unwrap();
    assert_eq!(cache[0].success, previous);
    assert_eq!(cache[0].errors[0].code, UsageErrorCode::Cancelled);
    assert_eq!(cache[0].failures, 0);
}
