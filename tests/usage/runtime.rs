use super::*;
use std::{
    io::Write,
    net::TcpListener,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
};

fn input(source: &str) -> HelperInput {
    let mut config = super::super::tests::config();
    config.program = QueryProgram::JavaScript {
        source: source.into(),
    };
    HelperInput {
        config,
        secrets: Vec::new(),
    }
}
fn success() -> String {
    include_str!("../fixtures/usage/contract-v1.json").into()
}
fn returns() -> String {
    format!("return {};", success())
}
fn script(body: &str) -> String {
    format!("async function query(ctx) {{{body}}}")
}
fn server(
    count: usize,
    reply: impl Fn(String) -> String + Send + Sync + 'static,
) -> (String, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let reply = Arc::new(reply);
    let handle = std::thread::spawn(move || {
        let mut children = Vec::new();
        for stream in listener.incoming().take(count) {
            let mut stream = stream.unwrap();
            let reply = reply.clone();
            children.push(std::thread::spawn(move || {
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buf = [0; 4096];
                loop {
                    let n = stream.read(&mut buf).unwrap();
                    if n == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&bytes);
                    if let Some(end) = text.find("\r\n\r\n") {
                        let len = text[..end]
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length: ")
                                    .and_then(|n| n.parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if bytes.len() >= end + 4 + len {
                            break;
                        }
                    }
                }
                let response = reply(String::from_utf8_lossy(&bytes).into());
                let _ = stream.write_all(response.as_bytes());
            }));
        }
        for child in children {
            child.join().unwrap();
        }
    });
    (origin, handle)
}
fn response(body: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}
fn local(input: &mut HelperInput, origin: &str) {
    input.config.targets = vec![QueryTarget {
        origin: origin.into(),
        allow_private_network: true,
    }];
}
#[test]
fn quickjs_msvc_probe_and_contract() {
    let report = execute(input(&script(&returns())));
    assert!(report.error.is_none(), "{:?}", report.error);
    assert_eq!(report.result.unwrap().metrics.len(), 4);
    for body in [
        "return {};",
        "throw new Error('private diagnostic');",
        "return {schemaVersion:1,status:'success',metrics:[],errors:[]};",
        "return {x:NaN};",
    ] {
        let report = execute(input(&script(body)));
        assert!(report.error.is_some());
        assert!(report.result.is_none());
        assert!(!report.error.unwrap().message.contains("private diagnostic"));
    }
}
#[test]
fn sequential_and_bounded_parallel_requests_with_secret_as_data() {
    let active = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let records = Arc::new(Mutex::new(Vec::new()));
    let (a, p, r) = (active.clone(), peak.clone(), records.clone());
    let (origin, handle) = server(5, move |request| {
        let current = a.fetch_add(1, Ordering::SeqCst) + 1;
        p.fetch_max(current, Ordering::SeqCst);
        r.lock().unwrap().push(request);
        std::thread::sleep(Duration::from_millis(40));
        a.fetch_sub(1, Ordering::SeqCst);
        response("{\"value\":7}")
    });
    let body = format!(
        r#"
      if (ctx.version !== 1 || typeof process !== 'undefined' || typeof fetch !== 'undefined' || typeof require !== 'undefined') throw Error('ambient API');
      const url = '{origin}/quota';
      const first = await ctx.http({{url,auth:{{credential:ctx.credentials.token,prefix:'Bearer '}}}});
      if (first.json().value !== 7) throw Error('parse');
      await ctx.http({{url,method:'POST',json:{{special:"'$`\\"}}}});
      await Promise.all([1,2,3].map(i=>ctx.http({{url,method:'POST',form:{{i:String(i)}}}})));
      {}
    "#,
        returns()
    );
    let mut value = input(&script(&body));
    local(&mut value, &origin);
    value.secrets.push(BoundSecret {
        name: "token".into(),
        allowed_origins: vec![origin],
        value: "fixture-'$`\\\"".into(),
    });
    let report = execute(value);
    assert!(report.error.is_none(), "{:?}", report.error);
    handle.join().unwrap();
    assert_eq!(peak.load(Ordering::SeqCst), 2);
    let records = records.lock().unwrap();
    assert!(records[0].contains("Bearer fixture-'$`\\\""));
    assert!(records.iter().any(|r| r.contains("application/json")));
    assert!(records
        .iter()
        .any(|r| r.contains("application/x-www-form-urlencoded")));
}
#[test]
fn target_authentication_redirect_and_dns_boundaries() {
    let mut value = input(&script(
        "await ctx.http({url:'https://not-declared.example/'});",
    ));
    assert_eq!(
        execute(value.clone()).error.unwrap().code,
        UsageErrorCode::Permission
    );
    let (origin, handle) = server(1, |_| {
        "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:9/stolen\r\nContent-Length: 0\r\n\r\n"
            .into()
    });
    local(&mut value, &origin);
    value.config.program = QueryProgram::JavaScript {
        source: script(&format!("await ctx.http({{url:'{origin}/'}});")),
    };
    assert_eq!(
        execute(value.clone()).error.unwrap().code,
        UsageErrorCode::Permission
    );
    handle.join().unwrap();
    value.secrets.push(BoundSecret {
        name: "token".into(),
        allowed_origins: vec!["https://other.example".into()],
        value: "secret".into(),
    });
    value.config.program = QueryProgram::JavaScript {
        source: script(&format!(
            "await ctx.http({{url:'{origin}/',auth:{{credential:'token'}}}});"
        )),
    };
    assert_eq!(
        execute(value).error.unwrap().code,
        UsageErrorCode::Permission
    );
    for ip in [
        "127.0.0.1",
        "10.0.0.1",
        "100.64.1.1",
        "::1",
        "::ffff:127.0.0.1",
        "2001:db8::1",
    ] {
        assert!(!public_ip(ip.parse().unwrap()));
    }
    assert!(public_ip("8.8.8.8".parse().unwrap()));
}
#[test]
fn compute_stack_memory_output_and_request_limits() {
    for body in ["while(true){}", "function f(){return f()} f();", "const a=[];while(true)a.push(new Array(10000).fill(1));", "return {a:'x'.repeat(300000)};", "for(let i=0;i<9;i++)ctx.http({url:'https://quota.example.com/'}); await new Promise(()=>{});"] {
        let start=Instant::now(); let report=execute_with_budgets(input(&script(body)), RuntimeBudgets { compute: Duration::from_millis(100), ..RuntimeBudgets::default() });
        assert!(report.error.is_some(),"{body}"); assert!(start.elapsed()<Duration::from_secs(8));
    }
}
#[test]
fn response_limit_and_network_timeout() {
    let (origin, handle) = server(1, |_| response(&"x".repeat(MAX_RESPONSE_BYTES + 1)));
    let mut value = input(&script(&format!("await ctx.http({{url:'{origin}/'}});")));
    local(&mut value, &origin);
    assert_eq!(
        execute(value).error.unwrap().code,
        UsageErrorCode::ResourceLimit
    );
    handle.join().unwrap();
    let (origin, handle) = server(1, |_| {
        std::thread::sleep(Duration::from_millis(300));
        response("ok")
    });
    let mut value = input(&script(&format!("await ctx.http({{url:'{origin}/'}});")));
    local(&mut value, &origin);
    assert_eq!(RuntimeBudgets::default().http, Duration::from_secs(10));
    let report = execute_with_budgets(value, RuntimeBudgets { http: Duration::from_millis(100), ..RuntimeBudgets::default() });
    assert_eq!(report.error.unwrap().code, UsageErrorCode::Timeout);
    assert_eq!(report.stage, UsageStage::Http);
    handle.join().unwrap();
}
#[test]
fn redaction_handles_json_escaped_secrets() {
    let secret = "fixture-'$`\n秘密";
    let mut value = input(&script(&format!(
        "const result={};result.metrics[0].label=ctx.parameters.label;return result;",
        success()
    )));
    value
        .config
        .parameters
        .insert("label".into(), serde_json::json!(secret));
    value.secrets.push(BoundSecret {
        name: "token".into(),
        allowed_origins: vec![],
        value: secret.into(),
    });
    let report = execute(value);
    assert!(report.error.is_none());
    assert_eq!(report.result.unwrap().metrics[0].label, "[redacted]");
    assert!(!report.preview.contains("fixture"));
}

#[test]
fn gzip_limit_is_applied_after_decompression() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let handle = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut buf = [0; 4096];
        let _ = stream.read(&mut buf);
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder
            .write_all(&vec![b'x'; MAX_RESPONSE_BYTES + 1])
            .unwrap();
        let body = encoder.finish().unwrap();
        let header=format!("HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len());
        stream.write_all(header.as_bytes()).unwrap();
        let _ = stream.write_all(&body);
    });
    let mut value = input(&script(&format!("await ctx.http({{url:'{origin}/'}});")));
    local(&mut value, &origin);
    assert_eq!(
        execute(value).error.unwrap().code,
        UsageErrorCode::ResourceLimit
    );
    handle.join().unwrap();
}

#[test]
fn echoed_secret_is_redacted_before_entering_javascript() {
    let secret = "fixture-'$`\\\"";
    let (origin, handle) = server(1, move |_| {
        response(&serde_json::json!({"echo":secret}).to_string())
    });
    let mut value=input(&script(&format!("const response=await ctx.http({{url:'{origin}/',auth:{{credential:'token'}}}});if(response.json().echo!=='[redacted]')throw Error('leak');{}",returns())));
    local(&mut value, &origin);
    value.secrets.push(BoundSecret {
        name: "token".into(),
        allowed_origins: vec![origin],
        value: secret.into(),
    });
    assert!(execute(value).error.is_none());
    handle.join().unwrap();
}

#[test]
fn retry_after_http_preserves_seconds_and_date() {
    for header in [
        "300".to_string(),
        (chrono::Utc::now() + chrono::Duration::minutes(5))
            .format("%a, %d %b %Y %H:%M:%S GMT")
            .to_string(),
    ] {
        let (origin, handle) = server(1, move |_| {
            format!(
            "HTTP/1.1 429 Too Many Requests\r\nRetry-After: {header}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )
        });
        let mut value = input(&script(&format!("await ctx.http({{url:'{origin}/'}});")));
        local(&mut value, &origin);
        let error = execute(value).error.unwrap();
        handle.join().unwrap();
        assert_eq!(error.code, UsageErrorCode::RateLimit);
        assert!(
            matches!(error.retry_after_seconds, Some(295..=300)),
            "{:?}",
            error
        );
    }
}

#[test]
fn retry_after_dates_round_up_and_invalid_or_large_values_are_explicit() {
    let deadline = httpdate::parse_http_date("Sun, 06 Nov 1994 08:49:37 GMT").unwrap();
    let now = deadline - Duration::from_millis(300_250);
    for header in [
        "Sun, 06 Nov 1994 08:49:37 GMT",
        "Sunday, 06-Nov-94 08:49:37 GMT",
        "Sun Nov  6 08:49:37 1994",
    ] {
        assert_eq!(retry_after_seconds(header, now), Some(301));
        assert_eq!(retry_after_seconds(header, deadline), Some(0));
        assert_eq!(
            retry_after_seconds(header, deadline + Duration::from_secs(1)),
            Some(0)
        );
    }
    for (header, expected) in [
        ("0", Some(0)),
        (" 300 ", Some(300)),
        ("4294967295", Some(u32::MAX)),
        ("4294967296", Some(u32::MAX)),
        ("999999999999999999999999999999999999999", Some(u32::MAX)),
        ("", None),
        ("tomorrow", None),
        ("-1", None),
        ("+1", None),
        ("1.5", None),
        ("300, 301", None),
    ] {
        assert_eq!(retry_after_seconds(header, now), expected, "{header}");
    }
    assert_eq!(
        retry_after_seconds("Fri, 31 Dec 9999 23:59:59 GMT", now),
        Some(u32::MAX)
    );
}

#[test]
fn script_error_line_is_numeric_and_diagnostics_do_not_echo_script_text() {
    let report=execute(input("async function query(ctx) {\n  throw new Error('private diagnostic');\n}"));
    let error=report.error.unwrap();
    assert_eq!(error.script_line,Some(2));
    assert!(!error.message.contains("private diagnostic"));
    let report=execute(input("async function query(ctx) {\n  const x = ;\n}"));
    assert_eq!(report.error.unwrap().script_line,Some(2));
}

#[test]
fn draft_request_diagnostics_include_origin_without_path_query_or_userinfo() {
    let (origin,server)=server(1, |_|response("{}"));
    let mut data=input(&script(&format!("await ctx.http({{url:{url}}});{result}",url=serde_json::to_string(&format!("{origin}/private-path?token=private-query")).unwrap(),result=returns())));
    local(&mut data,&origin);
    let report=execute(data);
    server.join().unwrap();
    assert!(report.error.is_none());
    assert_eq!(report.request_origins,vec![origin]);
    let json=serde_json::to_string(&report).unwrap();
    assert!(!json.contains("private-path"));assert!(!json.contains("private-query"));
}
