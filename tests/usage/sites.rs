use super::*;
use crate::usage::runtime::{self, BoundSecret, HelperInput};
use serde_json::{json, Value};

fn preset(id: &str) -> UsagePreset {
    usage_presets().into_iter().find(|p| p.id == id).unwrap()
}
fn fixture(provider: &str) -> Value {
    serde_json::from_str(
        &std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
                "../tests/fixtures/usage/providers/{provider}-site.json"
            )),
        )
        .unwrap(),
    )
    .unwrap()
}
fn input(config: QueryConfig) -> HelperInput {
    let name = if config.parameters.get("mode").and_then(Value::as_str) == Some("key") {
        "api_key"
    } else {
        "user_token"
    };
    let origin = config.site.clone();
    HelperInput {
        config,
        secrets: vec![BoundSecret {
            name: name.into(),
            allowed_origins: vec![origin],
            value: "fixture-site-secret".into(),
        }],
    }
}
fn parse_config(mut config: QueryConfig, responses: Value) -> RuntimeReport {
    let source = builtin_script(&config).unwrap();
    config.program = QueryProgram::JavaScript {
        source: format!(
            r#"
{source}
const original = query;
query = async ctx => original({{parameters: ctx.parameters, credentials: ctx.credentials, http: async request => {{
  if (!request.url.startsWith(site + '/') || request.method !== 'GET' || request.auth.credential !== (mode === 'key' ? 'api_key' : 'user_token')) throw new Error('wrong request');
  const responses = {responses};
  const response = responses[request.url.slice(site.length)];
  if (response && response.testError) throw response.testError;
  return {{json: () => response}};
}}}});
"#
        ),
    };
    runtime::execute(input(config))
}
fn parse(id: &str, responses: Value) -> UsageResult {
    let report = parse_config(preset(id).config, responses);
    assert!(report.error.is_none(), "{:?}", report.error);
    let result = report.result.unwrap();
    result.validate().unwrap();
    result
}

#[test]
fn site_catalog_versions_subjects_and_credentials_are_explicit() {
    assert_eq!(usage_presets().len(), 20);
    for p in presets().into_iter().filter(|p| is_site(&p.config)) {
        p.config.validate().unwrap();
        assert_eq!(p.config.refresh_interval_seconds, 0);
        validate_credentials(&input(p.config.clone())).unwrap();
        let mut wrong = input(p.config.clone());
        wrong.secrets[0].name = if wrong.secrets[0].name == "api_key" {
            "user_token"
        } else {
            "api_key"
        }
        .into();
        assert!(validate_credentials(&wrong).is_err());
        let mut wrong = input(p.config.clone());
        wrong.secrets[0]
            .allowed_origins
            .push("https://other.example".into());
        assert!(validate_credentials(&wrong).is_err());
        let mut other = p.config.clone();
        other.site = "https://other.example".into();
        assert!(builtin_script(&other).is_err());
        other.targets[0].origin = other.site.clone();
        let copy = builtin_script(&other).unwrap();
        assert!(copy.contains("https://other.example"));
        assert!(!copy.contains("fixture-site-secret"));
        other.program = QueryProgram::JavaScript {
            source: copy.clone(),
        };
        // Copy is stored source, independent of all later catalog calls/versions.
        let _ = usage_presets();
        assert_eq!(other.program, QueryProgram::JavaScript { source: copy });
    }
}

#[test]
fn sub2api_wallet_and_multiple_plans_keep_windows_expiry_and_overage() {
    let result = parse("sub2api-account-plans", fixture("sub2api"));
    assert_eq!(result.status, UsageStatus::Success);
    assert_eq!(result.metrics.len(), 5);
    assert_eq!(result.metrics[0].subject, UsageSubject::Account);
    assert_eq!(result.metrics[0].remaining, Some(18.75));
    assert_eq!(result.metrics[1].subject_id.as_deref(), Some("21"));
    assert_eq!(
        result.metrics[1].window.as_ref().unwrap().duration_seconds,
        Some(86400)
    );
    assert_eq!(
        result.metrics[3].window.as_ref().unwrap().duration_seconds,
        None
    );
    assert_ne!(
        result.metrics[1].expires_at,
        result.metrics[1].window.as_ref().unwrap().resets_at
    );
    assert_eq!(result.metrics[4].percent(), Some(120.0));
}

#[test]
fn sub2api_progress_omissions_and_permission_failures_preserve_wallet() {
    let mut responses = fixture("sub2api");
    responses["/api/v1/subscriptions/progress"]["data"]
        .as_array_mut()
        .unwrap()
        .pop();
    let result = parse("sub2api-account-plans", responses);
    assert_eq!(result.status, UsageStatus::Partial);
    assert_eq!(result.metrics.len(), 4);
    let mut responses = fixture("sub2api");
    responses["/api/v1/subscriptions/progress"] =
        json!({"testError":{"code":"permission","stage":"http"}});
    let result = parse("sub2api-account-plans", responses);
    assert_eq!(result.status, UsageStatus::Partial);
    assert_eq!(result.metrics.len(), 1);
    assert_eq!(result.errors[0].code, UsageErrorCode::Permission);
    let result = parse("sub2api-plans", json!({}));
    assert_eq!(result.status, UsageStatus::Failed);
}

#[test]
fn sub2api_gateway_does_not_call_billing_or_invent_unlimited() {
    let result = parse("sub2api-key", fixture("sub2api"));
    assert_eq!(result.metrics.len(), 2);
    assert!(result
        .metrics
        .iter()
        .all(|m| m.subject == UsageSubject::Key));
    for value in [
        json!({"mode":"unrestricted","isValid":true}),
        json!({"mode":"unrestricted","subscription":{}}),
    ] {
        let result = parse("sub2api-key", json!({"/v1/usage":value}));
        assert_eq!(result.status, UsageStatus::Failed);
        assert!(result.metrics.is_empty());
    }
    let result = parse(
        "sub2api-key",
        json!({"/v1/usage":{"mode":"unrestricted","balance":8,"unit":"USD"}}),
    );
    assert_eq!(result.metrics[0].subject, UsageSubject::Account);
    let result = parse(
        "sub2api-key",
        json!({"/v1/usage":{"mode":"unrestricted","subscription":{"daily_limit_usd":10,"daily_usage_usd":2,"weekly_limit_usd":0,"monthly_limit_usd":null}}}),
    );
    assert_eq!(result.metrics.len(), 1);
    assert_eq!(result.metrics[0].subject, UsageSubject::Plan);
}

#[test]
fn newapi_raw_units_never_derive_currency_from_plan_price() {
    let result = parse("newapi-account-plans", fixture("newapi"));
    assert_eq!(result.status, UsageStatus::Success);
    assert_eq!(result.metrics.len(), 3);
    assert!(result
        .metrics
        .iter()
        .all(|m| matches!(m.unit, UsageUnit::Custom { .. })));
    assert_eq!(result.metrics[0].remaining, Some(600000.0));
    assert_eq!(result.metrics[0].used, None);
    assert_eq!(result.metrics[1].remaining, Some(75000.0));
    assert!(result.metrics[2].unlimited);
    assert_eq!(result.metrics[2].total, None);
    assert_eq!(
        result.metrics[2].window.as_ref().unwrap().duration_seconds,
        None
    );
    assert_ne!(
        result.metrics[1].expires_at,
        result.metrics[1].window.as_ref().unwrap().resets_at
    );
}

#[test]
fn newapi_conversion_requires_explicit_complete_parameters() {
    let mut config = preset("newapi-account").config;
    config.parameters.insert("currency".into(), "CNY".into());
    assert!(builtin_script(&config).is_err());
    config
        .parameters
        .insert("unitsPerCurrency".into(), json!(10000));
    let result = parse_config(config.clone(), fixture("newapi"))
        .result
        .unwrap();
    assert_eq!(result.metrics[0].remaining, Some(60.0));
    assert_eq!(
        result.metrics[0].unit,
        UsageUnit::Currency { code: "CNY".into() }
    );
    for invalid in [json!(0), json!(-1), json!("500000"), json!(null)] {
        config.parameters.insert("unitsPerCurrency".into(), invalid);
        assert!(builtin_script(&config).is_err());
    }
}

#[test]
fn newapi_key_unlimited_expired_and_unknown_dates_remain_distinct() {
    let result = parse("newapi-key", fixture("newapi"));
    assert_eq!(result.metrics[0].subject, UsageSubject::Key);
    assert_eq!(result.metrics[0].remaining, Some(150000.0));
    assert!(result.metrics[0].expires_at.is_some());
    assert!(result.metrics[0].window.is_none());
    let mut responses = fixture("newapi");
    responses["/api/usage/token/"]["data"]["unlimited_quota"] = true.into();
    responses["/api/usage/token/"]["data"]["expires_at"] = 0.into();
    let result = parse("newapi-key", responses.clone());
    assert!(result.metrics[0].unlimited);
    assert!(result.metrics[0].never_expires);
    assert_eq!(result.metrics[0].total, None);
    responses["/api/usage/token/"]["data"]["expires_at"] = Value::Null;
    assert!(!parse("newapi-key", responses.clone()).metrics[0].never_expires);
    responses["/api/usage/token/"]["data"]["expires_at"] = "invalid".into();
    assert_eq!(parse("newapi-key", responses).status, UsageStatus::Partial);
}

#[test]
fn newapi_optional_failure_missing_empty_and_auth_are_not_zero_success() {
    let mut responses = fixture("newapi");
    responses["/api/subscription/plans"] =
        json!({"success":false,"code":"ACCESS_TOKEN_SCOPE_DENIED"});
    let result = parse("newapi-account-plans", responses);
    assert_eq!(result.status, UsageStatus::Partial);
    assert_eq!(result.metrics.len(), 3);
    assert_eq!(result.errors[0].code, UsageErrorCode::Permission);
    assert_eq!(
        parse(
            "newapi-account",
            json!({"/api/user/self":{"success":true,"data":{}}})
        )
        .status,
        UsageStatus::Failed
    );
    assert_eq!(parse("newapi-plans", json!({"/api/subscription/plans":{"success":true,"data":[]},"/api/subscription/self":{"success":true,"data":{"subscriptions":[]}}})).status, UsageStatus::Failed);
    let report = parse_config(
        preset("newapi-key").config,
        json!({"/api/usage/token/":{"testError":{"code":"authentication","stage":"http","message":"fixture denied","retryAfterSeconds":null,"metricId":null}}}),
    );
    assert_eq!(report.error.unwrap().code, UsageErrorCode::Authentication);
}

#[test]
fn expiry_contract_rejects_ambiguous_or_contradictory_dates() {
    let mut result = parse("newapi-key", fixture("newapi"));
    result.metrics[0].never_expires = true;
    assert!(result.validate().is_err());
    result.metrics[0].never_expires = false;
    result.metrics[0].expires_at = Some("2026-10-01".into());
    assert!(result.validate().is_err());
}

#[test]
#[ignore = "requires freshly built cliora binary; run with --include-ignored"]
fn actual_helper_runs_multisite_builtins_and_copied_multiple_request_script() {
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::atomic::AtomicBool,
        time::{Duration, Instant},
    };
    let exe = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join(if cfg!(windows) {
            "cliora.exe"
        } else {
            "cliora"
        });
    assert!(
        exe.is_file(),
        "cargo build --manifest-path src-tauri/Cargo.toml --bin cliora first"
    );
    for (index, (id, paths, expected_count, partial)) in [
        (
            "sub2api-account-plans",
            vec![
                "/api/v1/user/profile",
                "/api/v1/subscriptions/active",
                "/api/v1/subscriptions/progress",
            ],
            5,
            false,
        ),
        (
            "newapi-account-plans",
            vec![
                "/api/user/self",
                "/api/subscription/plans",
                "/api/subscription/self",
            ],
            3,
            false,
        ),
        (
            "newapi-account-plans",
            vec![
                "/api/user/self",
                "/api/subscription/plans",
                "/api/subscription/self",
            ],
            3,
            true,
        ),
        ("sub2api-key", vec!["/v1/usage"], 2, false),
        ("newapi-key", vec!["/api/usage/token/"], 1, false),
        (
            "javascript-multiple-plans",
            vec!["/balance", "/plans"],
            3,
            false,
        ),
        (
            "javascript-multiple-plans",
            vec!["/balance", "/plans"],
            1,
            true,
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let generic = id.starts_with("javascript");
        let responses = if generic {
            json!({"/balance":{"remaining":13,"currency":"USD"},"/plans":{"plans":[{"id":"a","used":2,"total":10},{"id":"b","used":8,"total":6}]}})
        } else {
            fixture(if id.starts_with("sub2api") {
                "sub2api"
            } else {
                "newapi"
            })
        };
        let secret = format!("fixture-account-{index}-secret");
        let header_secret = secret.clone();
        let server = std::thread::spawn(move || {
            for path in paths {
                let start = Instant::now();
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(e)
                            if e.kind() == std::io::ErrorKind::WouldBlock
                                && start.elapsed() < Duration::from_secs(15) =>
                        {
                            std::thread::sleep(Duration::from_millis(5))
                        }
                        Err(e) => panic!("fixture request missing: {e}"),
                    }
                };
                // Windows accepted sockets inherit the listener's nonblocking mode.
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                loop {
                    let mut bytes = [0u8; 4096];
                    let len = stream.read(&mut bytes).unwrap();
                    request.extend_from_slice(&bytes[..len]);
                    if len == 0 || request.windows(4).any(|s| s == b"\r\n\r\n") {
                        break;
                    }
                }
                let request = String::from_utf8(request).unwrap().to_lowercase();
                assert!(request.starts_with(&format!("get {path} http/1.1")));
                assert!(request.contains(&format!("authorization: bearer {header_secret}")));
                let status = if partial && (path == "/plans" || path == "/api/subscription/plans") {
                    403
                } else {
                    200
                };
                let body = responses[path].to_string();
                write!(stream, "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        let mut config = preset(id).config;
        config.site = origin.clone();
        config.targets = vec![QueryTarget {
            origin: origin.clone(),
            allow_private_network: true,
        }];
        config.identity.account_id = Some(format!("account-{index}"));
        if generic {
            config
                .parameters
                .insert("site".into(), origin.clone().into());
        }
        let mut request = input(config.clone());
        request.secrets[0].value = secret.clone();
        let report =
            crate::usage::helper::run_child(&exe, request, &AtomicBool::new(false), Instant::now())
                .unwrap();
        server.join().unwrap();
        assert!(report.error.is_none(), "{id}: {:?}", report.error);
        let result = report.result.unwrap();
        assert_eq!(result.metrics.len(), expected_count, "{id}");
        assert_eq!(
            result.status,
            if partial {
                UsageStatus::Partial
            } else {
                UsageStatus::Success
            }
        );
        assert!(!report.preview.contains(&secret));
        let query = UsageQuery {
            id: format!("query-{index}"),
            version: 1,
            generation: 1,
            config,
            credentials: vec![],
        };
        let snapshot = UsageSnapshot::saved(&query, result).unwrap();
        let UsageExecution::Saved {
            query_id, identity, ..
        } = snapshot.execution
        else {
            panic!("wrong execution")
        };
        assert_eq!(query_id, format!("query-{index}"));
        assert_eq!(identity.account_id, Some(format!("account-{index}")));
    }
}
