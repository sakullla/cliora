use super::*;

#[test]
fn draft_resolution_reads_only_bound_secrets_and_never_saves() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("db")).unwrap();
    struct Secrets;
    impl CredentialStore for Secrets {
        fn get(&self, _: &str) -> Result<String, String> {
            Err("not bound".into())
        }
        fn put(&self, _: &str, _: &str) -> Result<(), String> {
            panic!("test must not save")
        }
        fn delete(&self, _: &str) -> Result<(), String> {
            panic!("test must not delete")
        }
    }
    let draft = UsageQueryDraft {
        id: None,
        expected_version: None,
        config: super::super::tests::config(),
        credentials: vec![CredentialDraft {
            name: "token".into(),
            allowed_origins: vec!["https://quota.example.com".into()],
            value: CredentialUpdate::Replace {
                secret: "fixture-only".into(),
            },
        }],
    };
    assert_eq!(
        resolve_draft(&db, &Secrets, &draft).unwrap().secrets[0].value,
        "fixture-only"
    );
    assert!(list_queries(&db).unwrap().is_empty());
}

#[test]
fn reservations_are_bounded_and_cancellation_precedes_spawn() {
    let _serial = REGISTRY_TEST_LOCK.lock().unwrap();
    let ids: Vec<_> = (0..MAX_ENTRIES)
        .map(|_| create_test_execution().unwrap())
        .collect();
    assert!(create_test_execution().is_err());
    for id in ids {
        cancel_test_execution(&id).unwrap();
        assert!(claim(&id).is_err());
    }
    assert!(registry().lock().unwrap().entries.is_empty());
    let mut guards = Vec::new();
    for _ in 0..MAX_ACTIVE {
        let id = create_test_execution().unwrap();
        let (mut guard, cancel, start) = claim(&id).unwrap();
        acquire(&mut guard, &cancel, start).unwrap();
        guards.push(guard);
    }
    let id = create_test_execution().unwrap();
    let (mut guard, cancel, _) = claim(&id).unwrap();
    assert_eq!(
        acquire(&mut guard, &cancel, Instant::now() - WALL_BUDGET)
            .unwrap_err()
            .code,
        UsageErrorCode::Timeout
    );
    assert_eq!(registry().lock().unwrap().active, MAX_ACTIVE);
    guards.pop();
    acquire(&mut guard, &cancel, Instant::now()).unwrap();
}

#[test]
#[ignore = "requires cargo build --bin cliora; run with --include-ignored for real helper acceptance"]
fn actual_helper_process_cancellation_reaping_and_recovery() {
    // Built by the focused command documented in docs/verification/quota-runtime.md.
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
        "build the application binary before this native process test"
    );
    let mut config = super::super::tests::config();
    config.program = QueryProgram::JavaScript {
        source: "async function query(){while(true){}}".into(),
    };
    let input = HelperInput {
        config: config.clone(),
        secrets: vec![],
    };
    let cancel = Arc::new(AtomicBool::new(false));
    let signal = cancel.clone();
    let start = Instant::now();
    let thread = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(150));
        signal.store(true, Ordering::SeqCst);
    });
    assert_eq!(
        run_child(&exe, input, &cancel, start).err().unwrap().code,
        UsageErrorCode::Cancelled
    );
    thread.join().unwrap();
    assert!(start.elapsed() < Duration::from_secs(3));
    config.program = QueryProgram::JavaScript {
        source: "async function query(){await new Promise(()=>{});}".into(),
    };
    let deadline_start = Instant::now() - WALL_BUDGET + Duration::from_millis(200);
    assert_eq!(
        run_child(
            &exe,
            HelperInput {
                config: config.clone(),
                secrets: vec![]
            },
            &AtomicBool::new(false),
            deadline_start
        )
        .err()
        .unwrap()
        .code,
        UsageErrorCode::Timeout
    );
    for body in [
        "function f(){return f()} f();",
        "const a=[];while(true)a.push(new Array(10000).fill(1));",
    ] {
        config.program = QueryProgram::JavaScript {
            source: format!("async function query(){{{body}}}"),
        };
        let report = run_child(
            &exe,
            HelperInput {
                config: config.clone(),
                secrets: vec![],
            },
            &AtomicBool::new(false),
            Instant::now(),
        )
        .unwrap();
        assert!(report.error.is_some());
    }
    config.program = QueryProgram::JavaScript {
        source: format!(
            "async function query(){{return {};}}",
            include_str!("../fixtures/usage/contract-v1.json")
        ),
    };
    let report = run_child(
        &exe,
        HelperInput {
            config,
            secrets: vec![],
        },
        &AtomicBool::new(false),
        Instant::now(),
    )
    .unwrap();
    assert!(report.result.is_some(), "{:?}", report.error);
}

#[test]
#[ignore = "requires cargo build --bin cliora; run with --include-ignored for real helper acceptance"]
fn actual_helper_preserves_retry_after_metadata() {
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
        "build the application binary before this native process test"
    );
    let future = (chrono::Utc::now() + chrono::Duration::minutes(5))
        .format("%a, %d %b %Y %H:%M:%S GMT")
        .to_string();
    for (status, header, expected) in [
        (429, "300".to_string(), Some(295..=300)),
        (429, future.clone(), Some(295..=300)),
        (503, future, Some(295..=300)),
        (
            429,
            "Sun, 06 Nov 1994 08:49:37 GMT".to_string(),
            Some(0..=0),
        ),
        (429, "invalid".to_string(), None),
        (
            429,
            "999999999999999999999999".to_string(),
            Some(u32::MAX..=u32::MAX),
        ),
    ] {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut buffer = [0; 4096];
            stream.read(&mut buffer).unwrap();
            let response = format!("HTTP/1.1 {status} Unavailable\r\nRetry-After: {header}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            stream.write_all(response.as_bytes()).unwrap();
        });
        let mut config = super::super::tests::config();
        config.targets = vec![QueryTarget {
            origin: origin.clone(),
            allow_private_network: true,
        }];
        config.program = QueryProgram::JavaScript {
            source: format!("async function query(ctx){{await ctx.http({{url:'{origin}/'}});}}"),
        };
        let report = run_child(
            &exe,
            HelperInput {
                config,
                secrets: vec![],
            },
            &AtomicBool::new(false),
            Instant::now(),
        )
        .unwrap();
        server.join().unwrap();
        assert!(report.result.is_none());
        let error = report.error.unwrap();
        assert_eq!(
            error.code,
            if status == 429 {
                UsageErrorCode::RateLimit
            } else {
                UsageErrorCode::Network
            }
        );
        match expected {
            Some(range) => assert!(
                error
                    .retry_after_seconds
                    .is_some_and(|seconds| range.contains(&seconds)),
                "{:?}",
                error
            ),
            None => assert_eq!(error.retry_after_seconds, None),
        }
    }
}
