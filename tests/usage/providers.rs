use super::*;
use crate::usage::runtime::{self, BoundSecret, HelperInput};
use serde_json::{json, Value};

fn preset(id: &str) -> UsagePreset {
    usage_presets().into_iter().find(|p| p.id == id).unwrap()
}
fn fixture(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/fixtures/usage/providers")
        .join(format!("{name}.json"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}
fn input(config: QueryConfig) -> HelperInput {
    let origin = config.targets[0].origin.clone();
    HelperInput {
        config,
        secrets: vec![BoundSecret {
            name: "api_key".into(),
            allowed_origins: vec![origin],
            value: "fixture-secret-not-a-real-key".into(),
        }],
    }
}

/// Execute the unmodified bundled parser in QuickJS; intercept only its ctx.http boundary.
fn parse_value(id: &str, value: Value) -> RuntimeReport {
    let mut config = preset(id).config;
    let source = builtin_script(&config).unwrap();
    config.program = QueryProgram::JavaScript {
        source: format!(
            r#"
{source}
const providerQuery = query;
query = async function(ctx) {{
  let requests = 0;
  const result = await providerQuery({{
    parameters: ctx.parameters, credentials: ctx.credentials,
    http: async request => {{
      requests++;
      if (request.url !== endpoint || request.method !== 'GET' || request.auth.credential !== 'api_key'
          || request.auth.prefix !== 'Bearer ' || request.auth.header !== 'Authorization') throw new Error('bad request');
      return {{json: () => ({value})}};
    }}
  }});
  if (requests !== 1) throw new Error('unexpected request count');
  return result;
}};
"#
        ),
    };
    runtime::execute(input(config))
}
fn parse(id: &str, name: &str) -> UsageResult {
    let report = parse_value(id, fixture(name));
    assert!(report.error.is_none(), "{:?}", report.error);
    let result = report.result.unwrap();
    result.validate().unwrap();
    result
}

#[test]
fn catalog_is_region_bound_versioned_manual_and_copyable() {
    let presets: Vec<_> = usage_presets().into_iter().filter(|p| matches!(&p.config.program, QueryProgram::Builtin { provider, .. } if matches!(provider.as_str(), "glm" | "kimi" | "minimax"))).collect();
    assert_eq!(presets.len(), 8);
    for preset in presets {
        assert_eq!(preset.config.refresh_interval_seconds, 0);
        assert_eq!(preset.config.identity.subject, UsageSubject::Plan);
        assert_eq!(
            preset.credentials[0].allowed_origins,
            [preset.config.site.clone()]
        );
        let source = builtin_script(&preset.config).unwrap();
        assert!(source.contains(&preset.config.site));
        assert!(!source.contains("fixture-secret"));
        let input = input(preset.config.clone());
        validate_builtin_credentials(&input).unwrap();
        let mut wrong = preset.config.clone();
        wrong.targets[0].origin = "https://attacker.invalid".into();
        assert!(builtin_script(&wrong).is_err());
        wrong = preset.config;
        if let QueryProgram::Builtin {
            template_version, ..
        } = &mut wrong.program
        {
            *template_version = 99;
        }
        assert!(builtin_script(&wrong).is_err());
    }
}

#[test]
fn builtin_dispatch_rejects_wrong_region_or_credential_before_http() {
    let mut request = input(preset("kimi-cn").config);
    request.secrets[0]
        .allowed_origins
        .push("https://api.kimi.ai".into());
    assert_eq!(
        runtime::execute(request).error.unwrap().code,
        UsageErrorCode::InvalidConfiguration
    );
    let mut request = input(preset("glm-cn").config);
    request
        .config
        .parameters
        .insert("region".into(), "global".into());
    assert_eq!(
        runtime::execute(request).error.unwrap().code,
        UsageErrorCode::InvalidConfiguration
    );
    let mut request = input(preset("minimax-cn-token-plan").config);
    request.secrets.clear();
    assert_eq!(
        runtime::execute(request).error.unwrap().code,
        UsageErrorCode::InvalidConfiguration
    );
}

#[test]
fn glm_preserves_overage_and_distinct_credit_mcp_and_rolling_windows() {
    let result = parse("glm-cn", "glm-counts");
    assert_eq!(result.status, UsageStatus::Success);
    assert_eq!(result.metrics.len(), 3);
    assert_eq!(result.metrics[0].percent(), Some(120.0));
    assert_eq!(result.metrics[0].remaining, Some(-20.0));
    assert_eq!(
        result.metrics[0].window.as_ref().unwrap().recovery,
        RecoveryKind::Rolling
    );
    assert_eq!(result.metrics[1].unit, UsageUnit::Credits);
    assert_eq!(
        result.metrics[1].window.as_ref().unwrap().duration_seconds,
        Some(604800)
    );
    assert_eq!(
        result.metrics[2].window.as_ref().unwrap().duration_seconds,
        None
    );
    let partial = parse("glm-global", "glm-partial");
    assert_eq!(partial.status, UsageStatus::Partial);
    assert_eq!(partial.metrics.len(), 2);
    assert_eq!(
        partial.metrics[1].window.as_ref().unwrap().duration_seconds,
        None
    );
}

#[test]
fn kimi_counts_and_ratio_pools_do_not_invent_weekly_or_monthly_counts() {
    let old = parse("kimi-cn", "kimi-counts");
    assert_eq!(old.metrics.len(), 2);
    assert_eq!(old.metrics[0].used, Some(214.0));
    assert_eq!(
        old.metrics[0].window.as_ref().unwrap().duration_seconds,
        Some(604800)
    );
    let new = parse("kimi-global", "kimi-ratios");
    assert_eq!(new.status, UsageStatus::Success);
    assert_eq!(new.metrics.len(), 2);
    assert_eq!(new.metrics[0].source_percent, Some(0.0));
    assert_eq!(new.metrics[0].used, None);
    assert!((new.metrics[1].source_percent.unwrap() - 105.6).abs() < 1e-9);
    assert_eq!(new.metrics[1].total, None);
    assert_eq!(
        new.metrics[1].window.as_ref().unwrap().duration_seconds,
        None
    );
    assert_eq!(new.metrics[1].id, "kimi-monthly");
    assert_eq!(
        parse("kimi-cn", "kimi-partial").status,
        UsageStatus::Partial
    );
}

#[test]
fn kimi_placeholder_fallback_requires_same_period_and_no_monthly_pool() {
    let mixed = parse("kimi-global", "kimi-mixed");
    assert_eq!(mixed.metrics[0].used, Some(19.0));
    let mut raw = fixture("kimi-mixed");
    raw["usages"]["limit_7d"]["reset_time"] = "2026-10-16T16:45:58Z".into();
    let result = parse_value("kimi-global", raw).result.unwrap();
    assert_eq!(result.metrics[0].source_percent, Some(0.0));
    assert_eq!(result.metrics[0].used, None);
    let mut raw = fixture("kimi-mixed");
    raw["usages"]["limit_month_total"] = json!({"used_ratio": 0.0313});
    let result = parse_value("kimi-global", raw).result.unwrap();
    assert_eq!(result.metrics[0].source_percent, Some(0.0));
    assert_eq!(result.metrics[0].used, None);
}

#[test]
fn minimax_remaining_counts_ratios_boost_unlimited_and_points_stay_distinct() {
    let old = parse("minimax-cn-coding-plan", "minimax-counts");
    assert_eq!(old.status, UsageStatus::Success);
    assert_eq!(old.metrics[0].used, Some(750.0));
    assert_eq!(old.metrics[0].remaining, Some(250.0));
    assert_eq!(old.metrics[0].percent(), Some(75.0));
    assert_eq!(old.metrics[1].percent(), Some(20.0));
    let new = parse("minimax-global-token-plan", "minimax-ratios");
    assert_eq!(new.status, UsageStatus::Success);
    assert_eq!(new.metrics.len(), 3); // video placeholder excluded, points separate
    assert_eq!(new.metrics[0].source_percent, Some(4.0));
    assert!(new.metrics[0].label.starts_with("文本套餐"));
    assert_eq!(new.metrics[0].used, None);
    assert_eq!(new.metrics[1].source_percent, Some(30.0));
    assert!(new.metrics[1].label.contains("1.5"));
    assert_eq!(new.metrics[2].subject, UsageSubject::Extra);
    assert_eq!(new.metrics[2].remaining, Some(18.5));
    let unlimited = parse("minimax-cn-token-plan", "minimax-unlimited");
    assert!(unlimited.metrics[1].unlimited);
    assert_eq!(unlimited.metrics[1].source_percent, None);
    assert_eq!(
        parse("minimax-cn-token-plan", "minimax-partial").status,
        UsageStatus::Partial
    );
}

#[test]
fn minimax_source_seconds_fixture_keeps_five_hour_window() {
    let result = parse("minimax-cn-coding-plan", "minimax-epoch-seconds");
    assert_eq!(result.status, UsageStatus::Success);
    let window = result.metrics[0].window.as_ref().unwrap();
    assert_eq!(window.duration_seconds, Some(18000));
    assert_eq!(
        window.resets_at.as_deref(),
        Some("2026-05-17T17:00:00.000Z")
    );
    assert_eq!(result.metrics[0].used, Some(2.0));
}

#[test]
fn minimax_interval_and_weekly_accept_seconds_milliseconds_and_numeric_strings() {
    for id in ["minimax-cn-coding-plan", "minimax-global-token-plan"] {
        for scale in [1i64, 1000] {
            for strings in [false, true] {
                let mut raw = fixture("minimax-epoch-seconds");
                let item = &mut raw["data"]["model_remains"][0];
                item["current_weekly_total_count"] = 100.into();
                item["current_weekly_usage_count"] = 80.into();
                for (key, stamp) in [
                    ("start_time", 1779019200i64),
                    ("end_time", 1779037200),
                    ("weekly_start_time", 1779019200),
                    ("weekly_end_time", 1779624000),
                ] {
                    item[key] = if strings {
                        (stamp * scale).to_string().into()
                    } else {
                        (stamp * scale).into()
                    };
                }
                let report = parse_value(id, raw);
                assert!(report.error.is_none(), "{:?}", report.error);
                let result = report.result.unwrap();
                assert_eq!(result.status, UsageStatus::Success);
                for (index, duration, reset) in [
                    (0, 18000, "2026-05-17T17:00:00.000Z"),
                    (1, 604800, "2026-05-24T12:00:00.000Z"),
                ] {
                    let window = result.metrics[index].window.as_ref().unwrap();
                    assert_eq!(window.duration_seconds, Some(duration));
                    assert_eq!(window.resets_at.as_deref(), Some(reset));
                }
            }
        }
    }
}

#[test]
fn minimax_ambiguous_invalid_and_reversed_times_preserve_only_reliable_fields() {
    for invalid in [
        json!(0),
        json!(-1),
        json!(17790372000i64),
        json!(177903720000i64),
        json!(17790372000000i64),
        json!(1779037200.25),
        json!(""),
        json!("bad"),
        json!(true),
        json!({}),
    ] {
        let mut raw = fixture("minimax-epoch-seconds");
        raw["data"]["model_remains"][0]["end_time"] = invalid.clone();
        let report = parse_value("minimax-cn-coding-plan", raw);
        assert!(
            report.error.is_none(),
            "invalid={invalid}: {:?}",
            report.error
        );
        let result = report.result.unwrap();
        assert_eq!(result.status, UsageStatus::Partial, "invalid={invalid}");
        let metric = &result.metrics[0];
        assert_eq!(metric.used, Some(2.0));
        assert!(metric.missing_reason.is_some());
        assert_eq!(metric.window.as_ref().unwrap().duration_seconds, None);
        assert_eq!(metric.window.as_ref().unwrap().resets_at, None);
        assert_eq!(result.errors[0].code, UsageErrorCode::Parse);
    }
    let mut raw = fixture("minimax-epoch-seconds");
    raw["data"]["model_remains"][0]["start_time"] = 1779037201i64.into();
    let result = parse_value("minimax-cn-coding-plan", raw).result.unwrap();
    assert_eq!(result.status, UsageStatus::Partial);
    assert_eq!(result.metrics[0].window.as_ref().unwrap().resets_at, None);

    let mut raw = fixture("minimax-epoch-seconds");
    raw["data"]["model_remains"][0]["start_time"] = json!("ambiguous");
    let result = parse_value("minimax-cn-coding-plan", raw).result.unwrap();
    assert_eq!(result.status, UsageStatus::Partial);
    assert_eq!(
        result.metrics[0].window.as_ref().unwrap().duration_seconds,
        None
    );
    assert_eq!(
        result.metrics[0]
            .window
            .as_ref()
            .unwrap()
            .resets_at
            .as_deref(),
        Some("2026-05-17T17:00:00.000Z")
    );

    let mut raw = fixture("minimax-epoch-seconds");
    raw["data"]["model_remains"][0]["start_time"] = Value::Null;
    raw["data"]["model_remains"][0]["end_time"] = Value::Null;
    let result = parse_value("minimax-cn-coding-plan", raw).result.unwrap();
    assert_eq!(result.status, UsageStatus::Success); // Optional absent dates are unknown, never fabricated.
    assert_eq!(
        result.metrics[0].window.as_ref().unwrap().duration_seconds,
        None
    );
    assert_eq!(result.metrics[0].window.as_ref().unwrap().resets_at, None);
}

#[test]
fn missing_authentication_business_and_invalid_json_are_not_zero_success() {
    for (id, provider) in [
        ("glm-cn", "glm"),
        ("kimi-cn", "kimi"),
        ("minimax-cn-token-plan", "minimax"),
    ] {
        assert_eq!(
            parse(id, &format!("{provider}-missing")).status,
            UsageStatus::Failed
        );
        assert_eq!(
            parse_value(id, fixture(&format!("{provider}-auth")))
                .error
                .unwrap()
                .code,
            UsageErrorCode::Authentication
        );
        assert_eq!(
            parse_value(id, fixture(&format!("{provider}-business")))
                .error
                .unwrap()
                .code,
            UsageErrorCode::Business
        );
        assert!(parse_value(id, json!(null)).error.is_some());
    }
    let mut raw = fixture("minimax-ratios");
    raw["data"]["base_resp"] = json!({"status_code": 1004});
    assert_eq!(
        parse_value("minimax-cn-token-plan", raw)
            .error
            .unwrap()
            .code,
        UsageErrorCode::Authentication
    );
}

#[test]
fn builtin_source_uses_real_broker_get_bearer_and_http_failures() {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    for (id, fixture_name, path, status, expected) in [
        (
            "glm-cn",
            "glm-counts",
            "/api/monitor/usage/quota/limit",
            200,
            None,
        ),
        ("kimi-global", "kimi-ratios", "/coding/v1/usages", 200, None),
        (
            "minimax-cn-token-plan",
            "minimax-ratios",
            "/v1/token_plan/remains",
            200,
            None,
        ),
        (
            "minimax-global-coding-plan",
            "minimax-counts",
            "/v1/api/openplatform/coding_plan/remains",
            200,
            None,
        ),
        (
            "kimi-cn",
            "kimi-auth",
            "/coding/v1/usages",
            401,
            Some(UsageErrorCode::Authentication),
        ),
        (
            "glm-cn",
            "glm-business",
            "/api/monitor/usage/quota/limit",
            429,
            Some(UsageErrorCode::RateLimit),
        ),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let body = fixture(fixture_name).to_string();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            loop {
                let mut buf = [0; 4096];
                let size = stream.read(&mut buf).unwrap();
                request.extend_from_slice(&buf[..size]);
                if size == 0 || request.windows(4).any(|part| part == b"\r\n\r\n") {
                    break;
                }
            }
            let request = String::from_utf8(request).unwrap();
            assert!(request.starts_with(&format!("GET {path} HTTP/1.1")));
            assert!(request
                .to_lowercase()
                .contains("authorization: bearer fixture-secret-not-a-real-key"));
            write!(stream, "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nRetry-After: 37\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        });
        let mut config = preset(id).config;
        // Test-only source copy directs production parser/request code to a loopback fixture server.
        let source = builtin_script(&config)
            .unwrap()
            .replacen(&config.site, &origin, 1);
        config.program = QueryProgram::JavaScript { source };
        config.site = origin.clone();
        config.targets = vec![QueryTarget {
            origin,
            allow_private_network: true,
        }];
        let report = runtime::execute(input(config));
        server.join().unwrap();
        match expected {
            Some(code) => {
                let error = report.error.unwrap();
                assert_eq!(error.code, code);
                assert_eq!(error.retry_after_seconds, Some(37));
            }
            None => {
                assert!(report.error.is_none(), "{:?}", report.error);
                assert!(report.result.is_some());
            }
        }
    }
}
