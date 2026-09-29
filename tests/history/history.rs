use super::*;
use crate::native::adapters::{LaunchMode, CODEX};

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/history")
}
fn file(name: &str) -> HistorySource {
    HistorySource {
        path: fixtures().join(name),
        native_id: None,
        fingerprint: "fixture".into(),
    }
}

#[test]
fn five_versioned_sources_extract_visible_messages_and_distinct_usage() {
    let codex = codex::parse(&file("codex-0.158.jsonl")).unwrap();
    assert_eq!(
        codex.native_id.as_deref(),
        Some("11111111-1111-4111-8111-111111111111")
    );
    assert_eq!(codex.messages.len(), 2);
    assert!(
        codex.partial,
        "a damaged line must not hide readable messages"
    );
    assert_eq!(
        codex
            .usage
            .iter()
            .map(|item| item.input.unwrap())
            .sum::<u64>(),
        150
    );
    assert_eq!(
        codex
            .usage
            .iter()
            .map(|item| item.cache_read.unwrap())
            .sum::<u64>(),
        60
    );
    assert!(codex.usage.iter().all(|item| item.input_includes_cache));

    let claude = claude::parse(&file("claude-2.1.jsonl")).unwrap();
    assert_eq!(
        claude.usage.len(),
        1,
        "streamed snapshots share one request ID"
    );
    assert_eq!(claude.usage[0].output, Some(12));
    assert_eq!(claude.usage[0].cache_read, Some(20));
    assert!(!claude.usage[0].input_includes_cache);

    let pi = pi::parse(&file("pi-0.87-v3.jsonl")).unwrap();
    assert_eq!(
        pi.native_id.as_deref(),
        Some("33333333-3333-4333-8333-333333333333")
    );
    assert_eq!(
        pi.usage.len(),
        2,
        "standalone usage entries contribute once"
    );
    assert_eq!(
        pi.usage
            .iter()
            .map(|item| item.cache_read.unwrap())
            .sum::<u64>(),
        28
    );

    let grok = grok::parse(&HistorySource {
        path: fixtures().join("grok-1.0"),
        native_id: Some("44444444-4444-4444-8444-444444444444".into()),
        fingerprint: "fixture".into(),
    })
    .unwrap();
    assert_eq!(grok.messages.len(), 2);
    assert_eq!(
        grok.usage.len(),
        1,
        "model usage replaces, rather than adds to, session total"
    );
    assert_eq!(grok.usage[0].input, Some(40));

    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join(".local/share/opencode");
    fs::create_dir_all(&root).unwrap();
    let db = rusqlite::Connection::open(root.join("opencode.db")).unwrap();
    db.execute_batch("CREATE TABLE session (id TEXT, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER, version TEXT, model TEXT);
        CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, time_created INTEGER);
        CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, data TEXT, time_created INTEGER);
        INSERT INTO session VALUES ('ses_fixture','OpenCode fixture','/fixture/project',1790668800000,1790668860000,'1.18.33',NULL);").unwrap();
    db.execute(
        "INSERT INTO message VALUES (?1,?2,?3,?4)",
        params![
            "msg_user",
            "ses_fixture",
            r#"{"role":"user"}"#,
            1790668800000_i64
        ],
    )
    .unwrap();
    db.execute("INSERT INTO message VALUES (?1,?2,?3,?4)",params!["msg_assistant","ses_fixture",r#"{"role":"assistant","modelID":"gpt-5","tokens":{"input":12,"output":8,"cache":{"read":3,"write":1}}}"#,1790668801000_i64]).unwrap();
    db.execute(
        "INSERT INTO part VALUES (?1,?2,?3,?4,?5)",
        params![
            "part_user",
            "msg_user",
            "ses_fixture",
            r#"{"type":"text","text":"Hello"}"#,
            1790668800000_i64
        ],
    )
    .unwrap();
    db.execute(
        "INSERT INTO part VALUES (?1,?2,?3,?4,?5)",
        params![
            "part_assistant",
            "msg_assistant",
            "ses_fixture",
            r#"{"type":"text","text":"Welcome"}"#,
            1790668801000_i64
        ],
    )
    .unwrap();
    drop(db);
    let source = opencode::sources(temp.path()).unwrap().pop().unwrap();
    let open = opencode::parse(&source).unwrap();
    assert_eq!(open.native_id.as_deref(), Some("ses_fixture"));
    assert_eq!(open.messages.len(), 2);
    assert_eq!(open.usage[0].input, Some(12));
    let db = rusqlite::Connection::open(root.join("opencode.db")).unwrap();
    db.execute(
        "UPDATE session SET version = NULL WHERE id = 'ses_fixture'",
        [],
    )
    .unwrap();
    assert!(opencode::parse(&source).unwrap_err().contains("版本"));
}

#[test]
fn refresh_is_stable_updates_deletes_and_keeps_favorites_and_failed_sources() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let root = home.join(".codex/sessions/2026/09/29");
    fs::create_dir_all(&root).unwrap();
    let source = root.join("rollout-good.jsonl");
    fs::copy(fixtures().join("codex-0.158.jsonl"), &source).unwrap();
    let broken = root.join("rollout-broken.jsonl");
    fs::write(&broken, "not json\n").unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let registry = Registry::with_adapters(vec![&CODEX]).unwrap();
    let first = refresh(&db, &registry, &home).unwrap();
    assert_eq!(first[0].source_count, 2);
    assert_eq!(first[0].failed_count, 1);
    let sessions = list(&db, &HistoryFilter::default()).unwrap();
    assert_eq!(sessions.len(), 1);
    let id = sessions[0].id.clone();
    set_favorite(&db, &id, true).unwrap();
    refresh(&db, &registry, &home).unwrap();
    assert_eq!(list(&db, &HistoryFilter::default()).unwrap().len(), 1);
    assert!(detail(&db, &id).unwrap().session.favorite);
    fs::write(
        &source,
        fs::read_to_string(&source)
            .unwrap()
            .replace("Looks good.", "Updated reply."),
    )
    .unwrap();
    refresh(&db, &registry, &home).unwrap();
    assert!(detail(&db, &id)
        .unwrap()
        .messages
        .iter()
        .any(|message| message.text == "Updated reply."));
    fs::remove_file(source).unwrap();
    refresh(&db, &registry, &home).unwrap();
    assert!(list(&db, &HistoryFilter::default()).unwrap().is_empty());
}

#[test]
fn usage_dates_and_manual_price_keep_cache_out_of_double_counting() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let root = home.join(".codex/sessions");
    fs::create_dir_all(&root).unwrap();
    fs::copy(
        fixtures().join("codex-0.158.jsonl"),
        root.join("rollout-price.jsonl"),
    )
    .unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let registry = Registry::with_adapters(vec![&CODEX]).unwrap();
    refresh(&db, &registry, &home).unwrap();
    let filter = HistoryFilter {
        tool_id: Some("codex".into()),
        model: Some("gpt-6-astra".into()),
        from_ms: Some(1790668800000),
        to_ms: Some(1790755200000),
        ..Default::default()
    };
    let unknown = usage_summary(&db, &filter).unwrap();
    assert_eq!(unknown.input, Some(150));
    assert_eq!(unknown.cache_read, Some(60));
    assert_eq!(unknown.estimated_cost, None);
    save_price(
        &db,
        &registry,
        HistoryPrice {
            tool_id: "codex".into(),
            model: "gpt-6-astra".into(),
            currency: "USD".into(),
            input_per_million: 1.0,
            output_per_million: 2.0,
            cache_read_per_million: 0.1,
            cache_write_per_million: 0.0,
            source: "Manual fixture rate".into(),
            updated_at: 0,
        },
    )
    .unwrap();
    let priced = usage_summary(&db, &filter).unwrap();
    assert!((priced.estimated_cost.unwrap() - 0.000156).abs() < 0.0000001);
    assert_eq!(priced.price_sources.len(), 1);
    let outside = usage_summary(
        &db,
        &HistoryFilter {
            from_ms: Some(1800000000000),
            ..filter
        },
    )
    .unwrap();
    assert_eq!(outside.session_count, 0);
}

#[test]
fn exports_are_separate_read_only_files_and_resume_arguments_are_native() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let root = home.join(".codex/sessions");
    fs::create_dir_all(&root).unwrap();
    let source = root.join("rollout-export.jsonl");
    fs::copy(fixtures().join("codex-0.158.jsonl"), &source).unwrap();
    let original = fs::read(&source).unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let registry = Registry::with_adapters(vec![&CODEX]).unwrap();
    refresh(&db, &registry, &home).unwrap();
    let id = list(&db, &HistoryFilter::default()).unwrap()[0].id.clone();
    let markdown = temp.path().join("session.md");
    let json = temp.path().join("session.json");
    export(&db, &id, "markdown", &markdown).unwrap();
    export(&db, &id, "json", &json).unwrap();
    assert!(fs::read_to_string(markdown)
        .unwrap()
        .contains("Looks good."));
    let value: serde_json::Value = serde_json::from_slice(&fs::read(json).unwrap()).unwrap();
    assert_eq!(value["session"]["toolId"], "codex");
    assert_eq!(fs::read(&source).unwrap(), original);
    assert!(export(&db, &id, "json", &source).is_err());

    let all = Registry::builtins();
    let cases = [
        (
            "codex",
            "0.158.0",
            vec!["resume", "session_123"],
            Some("--yolo"),
        ),
        (
            "claude_code",
            "2.1.284",
            vec!["--resume", "session_123"],
            Some("--dangerously-skip-permissions"),
        ),
        (
            "grok",
            "1.0.41",
            vec!["--resume", "session_123"],
            Some("--yolo"),
        ),
        ("pi", "0.87.1", vec!["--session", "session_123"], None),
        (
            "open_code",
            "1.18.33",
            vec!["--session", "session_123"],
            Some("--auto"),
        ),
    ];
    for (tool, version, ordinary, yolo) in cases {
        assert_eq!(
            crate::native::adapters::plan_launch(
                &all,
                tool,
                version,
                Some("session_123"),
                LaunchMode::Normal
            )
            .unwrap(),
            ordinary
        );
        match yolo {
            Some(flag) => assert!(crate::native::adapters::plan_launch(
                &all,
                tool,
                version,
                Some("session_123"),
                LaunchMode::Yolo
            )
            .unwrap()
            .contains(&flag.to_owned())),
            None => assert!(crate::native::adapters::plan_launch(
                &all,
                tool,
                version,
                Some("session_123"),
                LaunchMode::Yolo
            )
            .is_err()),
        }
    }
    assert!(!all
        .get("open_code")
        .unwrap()
        .history_resume_version_supported("2.0.0"));
}

#[cfg(windows)]
#[test]
fn copied_resume_command_uses_indexed_id_and_relinked_project_directory() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let source = home.join(".grok/sessions/project/44444444-4444-4444-8444-444444444444");
    fs::create_dir_all(&source).unwrap();
    let original_dir = temp.path().join("original");
    let relinked_dir = temp.path().join("relinked project");
    fs::create_dir_all(&original_dir).unwrap();
    fs::create_dir_all(&relinked_dir).unwrap();
    let mut summary: serde_json::Value =
        serde_json::from_slice(&fs::read(fixtures().join("grok-1.0/summary.json")).unwrap())
            .unwrap();
    summary["info"]["cwd"] = serde_json::Value::String(original_dir.display().to_string());
    fs::write(
        source.join("summary.json"),
        serde_json::to_vec(&summary).unwrap(),
    )
    .unwrap();
    for name in ["chat_history.jsonl", "usage.json"] {
        fs::copy(fixtures().join("grok-1.0").join(name), source.join(name)).unwrap();
    }
    let cli = temp.path().join("grok.ps1");
    fs::write(&cli, "Write-Output 'grok 1.0.41'\n").unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO installation_choices (tool,path) VALUES ('grok',?1)",
            [cli.display().to_string()],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
    })
    .unwrap();
    let registry = Registry::builtins();
    refresh(&db, &registry, &home).unwrap();
    let id = list(
        &db,
        &HistoryFilter {
            tool_id: Some("grok".into()),
            ..Default::default()
        },
    )
    .unwrap()[0]
        .id
        .clone();
    let first = copy_resume_command(&db, &registry, &home, &id, LaunchMode::Normal).unwrap();
    assert!(first.contains("'--resume' '44444444-4444-4444-8444-444444444444'"));
    assert!(first.contains(&format!(
        "'{}'",
        original_dir.canonicalize().unwrap().display()
    )));
    let project = crate::projects::add(
        &db,
        &registry,
        relinked_dir.to_str().unwrap(),
        None,
        Some("grok"),
    )
    .unwrap();
    set_project(&db, &id, Some(&project.id)).unwrap();
    let next = copy_resume_command(&db, &registry, &home, &id, LaunchMode::Yolo).unwrap();
    assert!(next.contains(&format!(
        "'{}'",
        relinked_dir.canonicalize().unwrap().display()
    )));
    assert!(next.contains("'--yolo'"));
    assert!(!next.contains(&format!(
        "'{}'",
        original_dir.canonicalize().unwrap().display()
    )));
}
