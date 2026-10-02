use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;

use super::*;
use crate::{credentials::CredentialStore, database::Database};

#[derive(Default)]
struct Secrets {
    values: RefCell<BTreeMap<String, String>>,
    puts: Cell<usize>,
    gets: Cell<usize>,
    fail_put: Cell<bool>,
    fail_delete: Cell<bool>,
}

impl CredentialStore for Secrets {
    fn put(&self, id: &str, value: &str) -> Result<(), String> {
        self.puts.set(self.puts.get() + 1);
        if self.fail_put.get() {
            return Err(format!("OS failure containing {value}"));
        }
        self.values.borrow_mut().insert(id.into(), value.into());
        Ok(())
    }
    fn get(&self, id: &str) -> Result<String, String> {
        self.gets.set(self.gets.get() + 1);
        self.values
            .borrow()
            .get(id)
            .cloned()
            .ok_or_else(|| "missing".into())
    }
    fn delete(&self, id: &str) -> Result<(), String> {
        if self.fail_delete.get() {
            return Err("locked".into());
        }
        self.values.borrow_mut().remove(id);
        Ok(())
    }
}

pub(super) fn config() -> QueryConfig {
    QueryConfig {
        schema_version: 1,
        label: "Query".into(),
        site: "site-a".into(),
        identity: QueryIdentity {
            account_id: Some("account-a".into()),
            context_id: None,
            profile_id: None,
            subject: UsageSubject::Plan,
            subject_id: Some("plan-a".into()),
        },
        program: QueryProgram::JavaScript {
            source: "async function query(ctx) { throw new Error('MUST NOT EXECUTE ON SAVE'); }"
                .into(),
        },
        parameters: BTreeMap::new(),
        targets: vec![QueryTarget {
            origin: "https://quota.example.com".into(),
            allow_private_network: false,
        }],
        enabled: false,
        refresh_interval_seconds: 0,
    }
}

fn draft(old: Option<&UsageQuery>) -> UsageQueryDraft {
    UsageQueryDraft {
        id: old.map(|query| query.id.clone()),
        expected_version: old.map(|query| query.version),
        config: old.map_or_else(config, |query| query.config.clone()),
        credentials: vec![CredentialDraft {
            name: "token".into(),
            allowed_origins: vec!["https://quota.example.com".into()],
            value: if old.is_some() {
                CredentialUpdate::Keep
            } else {
                CredentialUpdate::Replace {
                    secret: "fixture-only-秘密-'$`\n".into(),
                }
            },
        }],
    }
}

fn result() -> UsageResult {
    serde_json::from_str(include_str!("../fixtures/usage/contract-v1.json")).unwrap()
}

#[test]
fn quota_crud_is_isolated_versioned_secret_free_and_does_not_execute() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let db = Database::open(&path).unwrap();
    let secrets = Secrets::default();
    let first = save_query(&db, &secrets, draft(None)).unwrap().query;
    let mut second_draft = draft(None);
    second_draft.config.site = "site-b".into();
    second_draft.config.identity.account_id = Some("account-b".into());
    let second = save_query(&db, &secrets, second_draft).unwrap().query;
    let same_site = save_query(&db, &secrets, draft(None)).unwrap().query;
    assert_ne!(first.id, same_site.id);
    assert_ne!(first.id, second.id);
    assert_ne!(
        first.credentials[0].secret_ref,
        second.credentials[0].secret_ref
    );
    assert_eq!(first.version, 1);
    assert_eq!(first.generation, 1);
    let mut edit = draft(Some(&first));
    edit.config.enabled = true;
    edit.config.refresh_interval_seconds = 60;
    let saved = save_query(&db, &secrets, edit).unwrap().query;
    assert_eq!(saved.version, 2);
    assert_eq!(saved.generation, 2);
    assert_eq!(saved.credentials, first.credentials);
    assert_eq!(secrets.puts.get(), 3);
    let stale = save_query(&db, &secrets, draft(Some(&first)))
        .err()
        .unwrap();
    assert_eq!(stale.code, UsageErrorCode::VersionConflict);
    assert_eq!(secrets.puts.get(), 3);
    assert_eq!(
        delete_query(&db, &secrets, &saved.id, 1)
            .err()
            .unwrap()
            .code,
        UsageErrorCode::VersionConflict
    );
    drop(db);
    let db = Database::open(&path).unwrap();
    assert_eq!(get_query(&db, &saved.id).unwrap(), saved);
    let queries = list_queries(&db).unwrap();
    assert_eq!(queries.len(), 3);
    let json = serde_json::to_string(&queries).unwrap();
    assert!(!json.contains("fixture-only"));
    assert_eq!(secrets.gets.get(), 0);
    db.with_connection(|conn| {
        let raw: String = conn
            .query_row(
                "SELECT data FROM usage_queries WHERE id = ?1",
                [&saved.id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!raw.contains("fixture-only"));
        let count: i64 = conn
            .query_row("SELECT count(*) FROM history_usage", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
        Ok(())
    })
    .unwrap();
    delete_query(&db, &secrets, &saved.id, saved.version).unwrap();
    assert_eq!(
        get_query(&db, &saved.id).unwrap_err().code,
        UsageErrorCode::NotFound
    );
    assert_eq!(get_query(&db, &second.id).unwrap(), second);
    assert!(!secrets
        .values
        .borrow()
        .contains_key(&saved.credentials[0].secret_ref));
}

#[test]
fn failed_credential_or_sql_save_preserves_old_configuration_and_secret() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("db")).unwrap();
    let secrets = Secrets::default();
    let original = save_query(&db, &secrets, draft(None)).unwrap().query;
    let values = secrets.values.borrow().clone();
    let replacement = || {
        let mut edit = draft(Some(&original));
        edit.credentials[0].value = CredentialUpdate::Replace {
            secret: "new-secret-never-in-errors".into(),
        };
        edit
    };
    secrets.fail_put.set(true);
    let error = save_query(&db, &secrets, replacement()).err().unwrap();
    assert_eq!(error.code, UsageErrorCode::Credential);
    assert!(!serde_json::to_string(&error)
        .unwrap()
        .contains("new-secret"));
    assert_eq!(get_query(&db, &original.id).unwrap(), original);
    assert_eq!(*secrets.values.borrow(), values);
    secrets.fail_put.set(false);
    db.with_connection(|conn| {
        conn.execute_batch("CREATE TRIGGER fail_usage_save BEFORE UPDATE ON usage_queries BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;").unwrap();
        Ok(())
    }).unwrap();
    assert_eq!(
        save_query(&db, &secrets, replacement()).err().unwrap().code,
        UsageErrorCode::Storage
    );
    assert_eq!(get_query(&db, &original.id).unwrap(), original);
    assert_eq!(*secrets.values.borrow(), values);
    db.with_connection(|conn| {
        conn.execute_batch("DROP TRIGGER fail_usage_save;").unwrap();
        Ok(())
    })
    .unwrap();
    let replaced = save_query(&db, &secrets, replacement()).unwrap().query;
    assert_eq!(replaced.credentials[0].revision, 2);
    assert_ne!(
        replaced.credentials[0].secret_ref,
        original.credentials[0].secret_ref
    );
    assert_eq!(secrets.values.borrow().len(), 1);
    assert_eq!(
        secrets.values.borrow()[&replaced.credentials[0].secret_ref],
        "new-secret-never-in-errors"
    );
}

#[test]
fn old_credential_cleanup_failure_is_reported_and_retried() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("db")).unwrap();
    let secrets = Secrets::default();
    let original = save_query(&db, &secrets, draft(None)).unwrap().query;
    let mut edit = draft(Some(&original));
    edit.credentials[0].value = CredentialUpdate::Replace {
        secret: "replacement".into(),
    };
    secrets.fail_delete.set(true);
    let saved = save_query(&db, &secrets, edit).unwrap();
    assert!(saved.credential_cleanup_pending);
    assert_eq!(get_query(&db, &original.id).unwrap(), saved.query);
    assert_eq!(secrets.values.borrow().len(), 2);
    secrets.fail_delete.set(false);
    let saved = save_query(&db, &secrets, draft(Some(&saved.query))).unwrap();
    assert!(!saved.credential_cleanup_pending);
    assert_eq!(secrets.values.borrow().len(), 1);
}

#[test]
fn bindings_cannot_keep_another_querys_secret_or_exceed_target_authority() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("db")).unwrap();
    let secrets = Secrets::default();
    let original = save_query(&db, &secrets, draft(None)).unwrap().query;
    let mut fresh = draft(None);
    fresh.credentials[0].value = CredentialUpdate::Keep;
    assert_eq!(
        save_query(&db, &secrets, fresh).err().unwrap().code,
        UsageErrorCode::InvalidConfiguration
    );
    let mut edit = draft(Some(&original));
    edit.credentials[0]
        .allowed_origins
        .push("https://untrusted.example.com".into());
    assert_eq!(
        save_query(&db, &secrets, edit).err().unwrap().code,
        UsageErrorCode::InvalidConfiguration
    );
    assert_eq!(get_query(&db, &original.id).unwrap(), original);
    assert_eq!(secrets.puts.get(), 1);
    let mut edit = draft(Some(&original));
    edit.config.targets.push(QueryTarget {
        origin: "https://second.example.com".into(),
        allow_private_network: false,
    });
    edit.credentials[0]
        .allowed_origins
        .push("https://second.example.com".into());
    let saved = save_query(&db, &secrets, edit).unwrap().query;
    assert_eq!(saved.credentials[0].revision, 2);
    assert_eq!(
        saved.credentials[0].secret_ref,
        original.credentials[0].secret_ref
    );
}

#[test]
fn v13_upgrade_keeps_existing_preferences_and_profiles() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("legacy.db");
    let db = Database::open(&path).unwrap();
    db.update_preferences(|preferences| preferences.theme = crate::domain::Theme::Dark)
        .unwrap();
    db.with_connection(|conn| {
        conn.execute_batch("INSERT INTO native_profiles (id, tool, version, data) VALUES ('legacy', 'codex', 1, '{}');
            DROP TABLE usage_queries; DROP TABLE usage_credential_gc; PRAGMA user_version = 13;").unwrap();
        Ok(())
    }).unwrap();
    drop(db);
    let db = Database::open(&path).unwrap();
    assert_eq!(db.preferences().unwrap().theme, crate::domain::Theme::Dark);
    assert!(list_queries(&db).unwrap().is_empty());
    db.with_connection(|conn| {
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 14);
        let data: String = conn
            .query_row(
                "SELECT data FROM native_profiles WHERE id = 'legacy'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(data, "{}");
        Ok(())
    })
    .unwrap();
}

#[test]
fn result_round_trip_preserves_missing_unlimited_overage_units_and_windows() {
    let fixture = result();
    fixture.validate().unwrap();
    assert_eq!(fixture.metrics[0].percent(), Some(125.0));
    assert_eq!(fixture.metrics[1].percent(), Some(20.0));
    assert_eq!(fixture.metrics[2].percent(), None);
    assert_eq!(fixture.metrics[3].remaining, None);
    let json = serde_json::to_value(&fixture).unwrap();
    assert_eq!(json["schemaVersion"], 1);
    assert_eq!(json["metrics"][0]["window"]["recovery"], "fixed");
    assert_eq!(json["errors"][0]["metricId"], "account.balance");
    assert_eq!(
        serde_json::from_value::<UsageResult>(json).unwrap(),
        fixture
    );
    let mut metric = fixture.metrics[0].clone();
    metric.total = Some(0.0);
    assert_eq!(metric.percent(), None);
    metric.used = None;
    metric.total = Some(100.0);
    metric.remaining = Some(20.0);
    assert_eq!(metric.percent(), Some(80.0));
}

#[test]
fn invalid_result_and_false_success_are_rejected() {
    let mut success = result();
    success.status = UsageStatus::Success;
    assert!(success.validate().is_err());
    success.metrics.truncate(1);
    success.errors.clear();
    success.validate().unwrap();
    for number in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -1.0] {
        let mut invalid = success.clone();
        invalid.metrics[0].used = Some(number);
        assert_eq!(
            invalid.validate().unwrap_err().code,
            UsageErrorCode::ResultContract
        );
    }
    let mut empty = success.clone();
    empty.metrics.clear();
    assert!(empty.validate().is_err());
    let mut duplicate = success.clone();
    duplicate.metrics.push(duplicate.metrics[0].clone());
    assert!(duplicate.validate().is_err());
    let mut unknown = success.clone();
    unknown.schema_version = 2;
    assert!(unknown.validate().is_err());
    let mut time = success.clone();
    time.metrics[0].window.as_mut().unwrap().resets_at = Some("2026-10-02T08:00:00".into());
    assert!(time.validate().is_err());
    let mut unlimited = success.clone();
    unlimited.metrics[0].unlimited = true;
    assert!(unlimited.validate().is_err());
    let mut no_value = success.clone();
    let metric = &mut no_value.metrics[0];
    metric.used = None;
    metric.remaining = None;
    metric.total = None;
    assert!(no_value.validate().is_err());
    let mut value = serde_json::to_value(success).unwrap();
    value["queryId"] = "cannot-spoof-host".into();
    assert!(serde_json::from_value::<UsageResult>(value).is_err());
}

#[test]
fn snapshot_host_identity_separates_draft_from_saved_and_failure_from_measurement() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("db")).unwrap();
    let saved = save_query(&db, &Secrets::default(), draft(None))
        .unwrap()
        .query;
    let snapshot = UsageSnapshot::saved(&saved, result()).unwrap();
    match snapshot.execution {
        UsageExecution::Saved {
            query_id,
            generation,
            identity,
        } => {
            assert_eq!(query_id, saved.id);
            assert_eq!(generation, saved.generation);
            assert_eq!(identity, saved.config.identity);
        }
        _ => panic!("wrong host identity"),
    }
    let preview = UsageSnapshot::draft(&saved.config, 7, result()).unwrap();
    assert!(matches!(
        preview.execution,
        UsageExecution::Draft {
            draft_revision: 7,
            ..
        }
    ));
    let other = UsageSnapshot::draft(&saved.config, 7, result()).unwrap();
    assert_ne!(preview.execution, other.execution);
    assert_eq!(get_query(&db, &saved.id).unwrap(), saved);
    let failed = UsageSnapshot::saved(
        &saved,
        UsageResult {
            schema_version: 1,
            status: UsageStatus::Failed,
            metrics: vec![],
            errors: vec![UsageError::new(
                UsageErrorCode::Authentication,
                UsageStage::Http,
                "Credential expired",
            )],
        },
    )
    .unwrap();
    assert!(failed.measured_at.is_none());
    assert!(snapshot.measured_at.is_some());
}

#[test]
fn config_rejects_unsupported_versions_refresh_targets_and_oversized_source() {
    config().validate().unwrap();
    for origin in [
        "https://example.com/path",
        "https://example.com/",
        "https://user:pass@example.com",
        "file:///tmp",
        "http://public.example.com",
        "https://127.0.0.1",
    ] {
        let mut invalid = config();
        invalid.targets[0].origin = origin.into();
        assert!(invalid.validate().is_err(), "{origin}");
    }
    let mut local = config();
    local.targets[0] = QueryTarget {
        origin: "http://127.0.0.1:8080".into(),
        allow_private_network: true,
    };
    local.validate().unwrap();
    let mut invalid = config();
    invalid.schema_version = 2;
    assert!(invalid.validate().is_err());
    let mut invalid = config();
    invalid.refresh_interval_seconds = 1;
    assert!(invalid.validate().is_err());
    let mut invalid = config();
    invalid.program = QueryProgram::JavaScript {
        source: "x".repeat(MAX_SCRIPT_BYTES + 1),
    };
    assert!(invalid.validate().is_err());
}
