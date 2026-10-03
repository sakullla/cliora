use super::*;
use serde_json::{json,Value};

fn fixture() -> Value {
    serde_json::from_str(include_str!("../fixtures/usage/codex-rate-limits.json")).unwrap()
}

#[test]
fn official_windows_preserve_multiple_buckets_overage_and_unknowns() {
    let result = parse_codex(&fixture()).unwrap();
    assert_eq!(result.status, UsageStatus::Partial);
    assert_eq!(result.metrics.len(), 7); // legacy view is not counted again
    assert_eq!(result.metrics[0].source_percent, Some(125.));
    assert_eq!(result.metrics[0].total, None); // no fabricated token limit
    assert_eq!(
        result.metrics[0].window.as_ref().unwrap().duration_seconds,
        Some(18000)
    );
    assert_eq!(
        result.metrics[1].window.as_ref().unwrap().duration_seconds,
        Some(604800)
    );
    assert_eq!(result.metrics[2].remaining, Some(10.5));
    assert!(result.metrics[4].missing_reason.is_some());
    assert!(result.metrics[5].unlimited);
    assert_eq!(result.metrics[6].remaining, Some(2.));
    assert_eq!(result.metrics[0].expires_at, None);
}

#[test]
fn official_legacy_zero_is_data_missing_is_not_zero_and_bad_time_is_partial() {
    let mut value = json!({"rateLimits":{"primary":{"usedPercent":0,"resetsAt":1800000000},"secondary":{"usedPercent":100}}});
    assert_eq!(parse_codex(&value).unwrap().status, UsageStatus::Success);
    value["rateLimits"]["primary"]["resetsAt"] = json!(1800000000000i64);
    let result = parse_codex(&value).unwrap();
    assert_eq!(result.status, UsageStatus::Partial);
    assert_eq!(result.metrics[0].window.as_ref().unwrap().resets_at, None);
    for invalid in [
        json!({}),
        json!({"rateLimits":{}}),
        json!({"rateLimitsByLimitId":[]}),
        json!({"rateLimitsByLimitId":{}}),
        json!({"rateLimits":{"primary":{"usedPercent":-1}}}),
    ] {
        assert!(parse_codex(&invalid).is_err(), "{invalid}");
    }
}

#[test]
fn official_credit_flags_never_invent_balances_or_permission() {
    let value = json!({"ordinaryUsageAllowed":false,"rateLimits":{"primary":{"usedPercent":0},"credits":{"hasCredits":false,"unlimited":false}}});
    let result = parse_codex(&value).unwrap();
    assert_eq!(result.status, UsageStatus::Partial);
    assert_eq!(result.metrics[2].remaining, None);
    assert_eq!(result.errors[0].code, UsageErrorCode::Permission);
}

#[test]
fn official_sources_reject_override_and_report_precise_limitations() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("db")).unwrap();
    let cancel = AtomicBool::new(false);
    for preset in presets() {
        preset.config.validate().unwrap();
        let error = query(&db, &preset.config, &cancel).unwrap_err();
        if preset.id == "official-codex" {
            assert_eq!(error.code, UsageErrorCode::Authentication);
        } else {
            assert!(error.message.contains("非") || error.message.contains("本地会话"));
        }
        let mut config = preset.config.clone();
        config.site = "https://evil.example".into();
        assert!(config.validate().is_err());
        let mut config = preset.config.clone();
        config.targets.push(QueryTarget {
            origin: config.site.clone(),
            allow_private_network: false,
        });
        assert!(config.validate().is_err());
    }
}

struct NoSecrets;
impl crate::credentials::CredentialStore for NoSecrets {
    fn get(&self, _: &str) -> Result<String, String> {
        panic!("official must not read secrets")
    }
    fn put(&self, _: &str, _: &str) -> Result<(), String> {
        panic!("official must not store secrets")
    }
    fn delete(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
}

#[test]
fn official_draft_uses_native_route_and_never_credential_or_script_broker() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("db")).unwrap();
    let draft = UsageQueryDraft {
        id: None,
        expected_version: None,
        config: presets()[1].config.clone(),
        credentials: vec![],
    };
    let saved = save_query(&db, &NoSecrets, draft).unwrap().query;
    let draft = UsageQueryDraft {
        id: Some(saved.id),
        expected_version: Some(saved.version),
        config: saved.config,
        credentials: vec![],
    };
    let report = test_draft(&db, &NoSecrets, create_test_execution().unwrap(), 5, draft).unwrap();
    assert_eq!(
        report.runtime.error.unwrap().code,
        UsageErrorCode::InvalidConfiguration
    );
    assert!(report.runtime.request_origins.is_empty());
}

fn signed_in(db: &Database, base: &std::path::Path) -> accounts::AuthAccount {
    let account = accounts::create(db, "codex", "Test").unwrap();
    let account = accounts::prepare_login(db, base, &account.id, account.version).unwrap();
    accounts::complete(
        db,
        &account.id,
        &account.pending_login.unwrap().id,
        accounts::Observation {
            state: accounts::AccountState::SignedIn,
            identity: Some(accounts::AccountIdentity {
                subject: "test@example.test".into(),
                email: Some("test@example.test".into()),
                plan: None,
                source: "fixture".into(),
            }),
            detail: None,
        },
        accounts::now(),
    )
    .unwrap()
}

#[test]
fn official_selection_and_cached_results_reject_reauthentication_context_change() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("db")).unwrap();
    let a = signed_in(&db, temp.path());
    let mut config = presets()[0].config.clone();
    config.identity.account_id = Some(a.id.clone());
    config.identity.context_id = Some(a.context.as_ref().unwrap().id.clone());
    assert!(selection(&db, &config).is_ok());
    let q = save_query(
        &db,
        &NoSecrets,
        UsageQueryDraft {
            id: None,
            expected_version: None,
            config: config.clone(),
            credentials: vec![],
        },
    )
    .unwrap()
    .query;
    let snapshot = UsageSnapshot::saved(&q, parse_codex(&fixture()).unwrap()).unwrap();
    let mut cache = list_cache(&db).unwrap().remove(0);
    cache.success = Some(snapshot);
    db.with_connection(|conn| {
        conn.execute(
            "UPDATE usage_cache SET data=?1 WHERE query_id=?2",
            rusqlite::params![serde_json::to_string(&cache).unwrap(), q.id],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    })
    .unwrap();
    assert!(list_cache(&db).unwrap()[0].success.is_some());
    let pending = accounts::prepare_login(&db, temp.path(), &a.id, a.version).unwrap();
    accounts::complete(
        &db,
        &a.id,
        &pending.pending_login.unwrap().id,
        accounts::Observation {
            state: accounts::AccountState::SignedIn,
            identity: a.identity,
            detail: None,
        },
        accounts::now(),
    )
    .unwrap();
    assert!(selection(&db, &config).is_err());
    assert!(list_cache(&db).unwrap()[0].success.is_none());
    assert!(list_cache(&db).unwrap()[0].auth_paused);
}

#[test]
fn official_profile_binding_must_match_and_credentials_cannot_be_overridden() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("db")).unwrap();
    let a = signed_in(&db, temp.path());
    let mut config = presets()[0].config.clone();
    config.identity.account_id = Some(a.id.clone());
    config.identity.context_id = Some(a.context.unwrap().id);
    config.identity.profile_id = Some("missing-profile".into());
    assert!(selection(&db, &config).is_err());
    config.identity.profile_id = Some("test-profile".into());
    let mut profile = json!({"id":"test-profile","tool":"codex","name":"Profile","version":1,"inheritCommon":true,"files":{},"authentication":{"kind":"oauth","accountId":a.id},"connection":null});
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO native_profiles(id,tool,version,data) VALUES('test-profile','codex',1,?1)",
            [profile.to_string()],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    })
    .unwrap();
    assert!(selection(&db, &config).is_ok());
    profile["authentication"] = json!({"kind":"api_key"});
    db.with_connection(|conn| {
        conn.execute(
            "UPDATE native_profiles SET data=?1 WHERE id='test-profile'",
            [profile.to_string()],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    })
    .unwrap();
    assert!(selection(&db, &config).is_err());
    let draft = UsageQueryDraft {
        id: None,
        expected_version: None,
        config,
        credentials: vec![CredentialDraft {
            name: "token".into(),
            allowed_origins: vec![],
            value: CredentialUpdate::Replace {
                secret: "synthetic".into(),
            },
        }],
    };
    assert!(save_query(&db, &NoSecrets, draft).is_err());
}

#[test]
#[ignore = "requires installed Codex 0.160.0; no real credentials or inference"]
fn official_installed_codex_empty_context_rejects_quota_and_cancels() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("db")).unwrap();
    let context = accounts::context::create_context(temp.path(), "codex").unwrap();
    let executable =
        accounts::native::executable(&db, &dirs::home_dir().unwrap(), "codex").unwrap();
    let error = crate::adapters::codex::accounts::codex_quota(
        &executable,
        &context,
        "test@example.test",
        &AtomicBool::new(false),
    )
    .unwrap_err();
    assert!(error.contains("身份") || error.contains("登录"));
    let error = crate::adapters::codex::accounts::codex_quota(
        &executable,
        &context,
        "test@example.test",
        &AtomicBool::new(true),
    )
    .unwrap_err();
    assert!(error.contains("取消"));
}

#[test]
fn official_native_protocol_checks_identity_both_sides_redacts_errors_and_cancels() {
    use std::{
        fs,
        sync::{atomic::Ordering, Arc},
        time::{Duration, Instant},
    };
    let temp = tempfile::tempdir().unwrap();
    let mut context = accounts::context::create_context(temp.path(), "codex").unwrap();
    let script = context.root.join("protocol.cjs");
    fs::write(&script, r#"
const fs = require('fs');
const readline = require('readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line); if (!request.id) return;
  fs.appendFileSync('calls.jsonl', JSON.stringify({ ...request, home: process.env.CODEX_HOME }) + '\n');
  const mode = process.env.CLIORA_TEST_MODE;
  let result = {};
  if (request.method === 'account/read') result = { account: { type: 'chatgpt', email: (mode === 'before' || mode === 'after' && request.id === 4) ? 'other@example.test' : 'test@example.test' } };
  if (request.method === 'account/rateLimits/read') {
    if (mode === 'hang') { setInterval(() => {}, 1000); return; }
    if (['401','429','business'].includes(mode)) { console.log(JSON.stringify({id:request.id,error:{code:mode === 'business' ? -32000 : Number(mode),message:'synthetic-private-token'}})); return; }
    result = { rateLimits: { primary: { usedPercent: 22 }, secondary: { usedPercent: 0 } } };
  }
  console.log(JSON.stringify({id:request.id,result}));
});
"#).unwrap();
    context.cli_args = vec![script.to_string_lossy().into_owned()];
    let executable = std::path::Path::new("node");
    for mode in ["good", "before", "after", "401", "429", "business"] {
        context
            .environment
            .insert("CLIORA_TEST_MODE".into(), mode.into());
        fs::write(context.root.join("calls.jsonl"), "").unwrap();
        let result = crate::adapters::codex::accounts::codex_quota(
            executable,
            &context,
            "test@example.test",
            &AtomicBool::new(false),
        );
        if mode == "good" {
            assert_eq!(
                parse_codex(&result.unwrap()).unwrap().metrics[0].source_percent,
                Some(22.)
            );
        } else {
            let error = result.unwrap_err();
            assert!(!error.contains("synthetic-private-token"));
            if mode == "401" {
                assert!(error.contains("认证失效"));
            }
            if mode == "429" {
                assert!(error.contains("受限"));
            }
        }
        let calls: Vec<Value> = fs::read_to_string(context.root.join("calls.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        for call in &calls {
            assert_eq!(call["home"], context.environment["CODEX_HOME"]);
            if call["method"] == "account/read" {
                assert_eq!(call["params"]["refreshToken"], false);
            }
            assert!(!call["method"].as_str().unwrap().starts_with("turn/"));
        }
        if mode == "before" {
            assert!(!calls
                .iter()
                .any(|c| c["method"] == "account/rateLimits/read"));
        }
        if mode == "good" || mode == "after" {
            assert_eq!(calls.last().unwrap()["id"], 4);
        }
    }
    context
        .environment
        .insert("CLIORA_TEST_MODE".into(), "hang".into());
    fs::write(context.root.join("calls.jsonl"), "").unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let signal = cancel.clone();
    let log = context.root.join("calls.jsonl");
    let thread = std::thread::spawn(move || {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(5) {
            if fs::read_to_string(&log)
                .unwrap_or_default()
                .contains("account/rateLimits/read")
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        signal.store(true, Ordering::SeqCst);
    });
    let start = Instant::now();
    let error = crate::adapters::codex::accounts::codex_quota(executable, &context, "test@example.test", &cancel)
        .unwrap_err();
    thread.join().unwrap();
    assert!(error.contains("取消"));
    assert!(start.elapsed() < Duration::from_secs(8));
}
