use crate::adapters::{codex::history as codex,claude::history as claude,grok::history as grok,pi::history as pi,opencode::history as opencode};
use super::*;
use crate::adapters::{LaunchMode, CODEX, GROK};

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/history")
}

fn file(name: &str) -> HistorySource {
    HistorySource { native_title: None,
        path: fixtures().join(name),
        native_id: None,
        fingerprint: "fixture".into(),
        fingerprint_error: None,
    }
}

#[test]
#[ignore = "manual performance measurement; prints aggregate timings only"]
fn history_performance_probe() {
    use std::time::Instant;
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join(".codex/sessions");
    fs::create_dir_all(&root).unwrap();
    for session in 0..240 {
        let mut rows = vec![serde_json::json!({"type":"session_meta","payload":{"id":format!("bench-{session}"),"cwd":"/fixture"}}).to_string()];
        for message in 0..40 {
            rows.push(serde_json::json!({"type":"response_item","payload":{"type":"message","role":if message % 2 == 0 {"user"} else {"assistant"},"content":[{"type":"input_text","text":format!("Question {message}\n{}", "x".repeat(4096))}]}}).to_string());
            rows.push(serde_json::json!({"type":"token_usage_record","payload":{"response_id":format!("response-{session}-{message}"),"usage":{"input_tokens":100,"output_tokens":20}}}).to_string());
        }
        fs::write(root.join(format!("rollout-{session}.jsonl")), rows.join("\n") + "\n").unwrap();
    }
    let db = Database::open(&temp.path().join("index.db")).unwrap();
    let registry = Registry::with_adapters(vec![&CODEX]).unwrap();
    for phase in ["cold", "unchanged", "unchanged-repeat"] {
        let start = Instant::now();
        let report = refresh(&db, &registry, temp.path()).unwrap();
        let refresh_ms = start.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(report[0].failed_count, 0);
        let start = Instant::now();
        let sessions = list(&db, &HistoryFilter::default()).unwrap();
        let list_ms = start.elapsed().as_secs_f64() * 1000.0;
        let start = Instant::now();
        let detail = detail(&db, &sessions[0].id).unwrap();
        assert_eq!(detail.messages.len(), 40);
        println!("BENCH {phase}: sources={} refresh_ms={refresh_ms:.2} list_ms={list_ms:.2} detail_ms={:.2}", sessions.len(), start.elapsed().as_secs_f64() * 1000.0);
    }
}

fn indexed_id(db: &Database, source: &Path) -> String {
    let canonical = source.canonicalize().unwrap();
    db.with_connection(|conn| {
        let mut statement = conn
            .prepare("SELECT id, source_path FROM history_sessions")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
            .into_iter()
            .find(|(_, path)| Path::new(path).canonicalize().ok().as_ref() == Some(&canonical))
            .map(|(id, _)| id)
            .ok_or_else(|| "源尚未建立索引".into())
    })
    .unwrap()
}

#[test]
fn codex_request_usage_survives_a_reset_cumulative_counter() {
    let session = codex::parse(&file("codex-last-usage.jsonl")).unwrap();
    assert_eq!(session.usage.iter().map(|item| item.input.unwrap()).sum::<u64>(), 200);
    assert_eq!(session.usage.iter().map(|item| item.output.unwrap()).sum::<u64>(), 12);
    assert_eq!(session.usage.iter().map(|item| item.cache_read.unwrap()).sum::<u64>(), 110);
    assert_eq!(session.usage.len(), 3);
}

#[test]
fn codex_context_is_classified_in_adapter_and_old_indexes_are_rebuilt() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join(".codex/sessions");
    fs::create_dir_all(&root).unwrap();
    let path = root.join("rollout-context.jsonl");
    let context = "# AGENTS.md instructions for /fixture\n\n<INSTRUCTIONS>\nProject rules\n</INSTRUCTIONS>";
    let environment = "<environment_context>\n<cwd>/fixture</cwd>\n</environment_context>";
    let question = "请优化 AGENTS.md 的说明";
    let texts = [context.to_owned(), environment.to_owned(), question.to_owned(), format!("{context}\nDo not hide this question")];
    let rows: Vec<String> = texts.iter().map(|text| serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":text}]}}).to_string()).collect();
    fs::write(&path, rows.join("\n") + "\n").unwrap();
    let db = Database::open(&temp.path().join("index.db")).unwrap();
    let registry = Registry::with_adapters(vec![&CODEX]).unwrap();
    refresh(&db, &registry, temp.path()).unwrap();
    let id = indexed_id(&db, &path);
    let parsed = detail(&db, &id).unwrap();
    assert_eq!(parsed.session.title, question);
    assert_eq!(parsed.messages.iter().map(|item| item.kind).collect::<Vec<_>>(), vec![HistoryMessageKind::ProjectContext, HistoryMessageKind::EnvironmentContext, HistoryMessageKind::Conversation, HistoryMessageKind::Conversation]);
    assert_eq!(parsed.messages[0].text, context);
    let legacy: HistoryMessage = serde_json::from_value(serde_json::json!({"id":"old","role":"user","text":context,"timestamp":null})).unwrap();
    assert_eq!(legacy.kind, HistoryMessageKind::Conversation);
    db.with_connection(|conn| {
        conn.execute("UPDATE history_sessions SET title = 'old injected title', favorite = 1, source_fingerprint = ?1", [source_fingerprint(&path)?]).map_err(|e| e.to_string())?;
        Ok(())
    }).unwrap();
    refresh(&db, &registry, temp.path()).unwrap();
    let refreshed = detail(&db, &id).unwrap();
    assert_eq!(refreshed.session.title, question);
    assert!(refreshed.session.favorite);
    // A common/other adapter's ordinary text must not inherit Codex heuristics.
    let mut generic = ParsedSession::new();
    generic.add_message("normal".into(), "user", context.into(), None);
    assert_eq!(generic.messages[0].kind, HistoryMessageKind::Conversation);
    assert!(generic.title.starts_with("# AGENTS.md"));
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

    let grok = grok::parse(&HistorySource { native_title: None,
        path: fixtures().join("grok-1.0"),
        native_id: Some("44444444-4444-4444-8444-444444444444".into()),
        fingerprint: "fixture".into(),
        fingerprint_error: None,
    })
    .unwrap();
    assert_eq!(grok.messages.len(), 2);
    assert_eq!(grok.messages[0].timestamp, None);
    assert_eq!(grok.messages[1].timestamp, None);
    assert!(grok.started_at.is_some());
    assert_eq!(
        grok.usage.len(),
        1,
        "model usage replaces, rather than adds to, session total"
    );
    assert_eq!(grok.usage[0].input, Some(18));
    assert!(!grok.usage[0].input_includes_cache);
    assert_eq!(grok.usage[0].request_count, Some(7));

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
    db.execute("INSERT INTO message VALUES (?1,?2,?3,?4)",params!["msg_assistant","ses_fixture",r#"{"role":"assistant","modelID":"gpt-5","tokens":{"input":12,"output":8,"reasoning":4,"cache":{"read":3,"write":1}}}"#,1790668801000_i64]).unwrap();
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
    db.execute(
        "INSERT INTO part VALUES (?1,?2,?3,?4,?5)",
        params![
            "part_step",
            "msg_assistant",
            "ses_fixture",
            r#"{"type":"step-finish","tokens":{"input":12,"output":8,"reasoning":4,"cache":{"read":3,"write":1}}}"#,
            1790668801000_i64
        ],
    )
    .unwrap();
    drop(db);
    let source = opencode::sources(temp.path()).unwrap().pop().unwrap();
    let open = opencode::parse(&source).unwrap();
    assert_eq!(open.native_id.as_deref(), Some("ses_fixture"));
    assert_eq!(open.messages.len(), 2);
    assert_eq!(open.usage.len(), 1);
    assert_eq!(open.usage[0].input, Some(12));
    assert_eq!(open.usage[0].output, Some(12));
    let db = rusqlite::Connection::open(root.join("opencode.db")).unwrap();
    db.execute(
        "UPDATE session SET version = NULL WHERE id = 'ses_fixture'",
        [],
    )
    .unwrap();
    assert!(opencode::parse(&source).unwrap_err().contains("版本"));
}

#[test]
fn claude_counts_subagent_calls_without_replaying_snapshots() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("project");
    let id = "22222222-2222-4222-8222-222222222222";
    fs::create_dir_all(root.join(id).join("subagents")).unwrap();
    fs::write(
        root.join(format!("{id}.jsonl")),
        "\
{\"type\":\"assistant\",\"uuid\":\"a1\",\"requestId\":\"req-main\",\"sessionId\":\"22222222-2222-4222-8222-222222222222\",\"timestamp\":\"2026-09-29T08:00:01Z\",\"message\":{\"id\":\"msg-main\",\"model\":\"claude-opus\",\"usage\":{\"input_tokens\":5,\"output_tokens\":1,\"cache_read_input_tokens\":20,\"cache_creation_input_tokens\":10}}}
{\"type\":\"assistant\",\"uuid\":\"a2\",\"requestId\":\"req-main\",\"timestamp\":\"2026-09-29T08:00:02Z\",\"message\":{\"id\":\"msg-main\",\"model\":\"claude-opus\",\"usage\":{\"input_tokens\":5,\"output_tokens\":12,\"cache_read_input_tokens\":20,\"cache_creation_input_tokens\":10,\"iterations\":[{\"type\":\"message\",\"input_tokens\":5,\"output_tokens\":12,\"cache_read_input_tokens\":20,\"cache_creation_input_tokens\":10},{\"type\":\"advisor_message\",\"model\":\"claude-haiku\",\"input_tokens\":6,\"output_tokens\":2,\"cache_read_input_tokens\":0,\"cache_creation_input_tokens\":0}]}}}
{\"type\":\"assistant\",\"uuid\":\"a3\",\"timestamp\":\"2026-09-29T08:00:03Z\",\"message\":{\"id\":\"msg-skip\",\"model\":\"<synthetic>\",\"usage\":{\"input_tokens\":999,\"output_tokens\":999}}}
",
    )
    .unwrap();
    fs::write(
        root.join(id).join("subagents").join("agent-1.jsonl"),
        "\
{\"type\":\"assistant\",\"uuid\":\"s1\",\"requestId\":\"req-sub\",\"timestamp\":\"2026-09-29T08:00:04Z\",\"message\":{\"id\":\"msg-sub\",\"model\":\"claude-sonnet\",\"usage\":{\"input_tokens\":3,\"output_tokens\":1,\"cache_read_input_tokens\":100,\"cache_creation_input_tokens\":0}}}
{\"type\":\"assistant\",\"uuid\":\"s2\",\"requestId\":\"req-sub\",\"timestamp\":\"2026-09-29T08:00:05Z\",\"message\":{\"id\":\"msg-sub\",\"model\":\"claude-sonnet\",\"usage\":{\"input_tokens\":3,\"output_tokens\":7,\"cache_read_input_tokens\":100,\"cache_creation_input_tokens\":0}}}
",
    )
    .unwrap();
    let session = claude::parse(&HistorySource { native_title: None,
        path: root.join(format!("{id}.jsonl")),
        native_id: None,
        fingerprint: "fixture".into(),
        fingerprint_error: None,
    })
    .unwrap();
    assert_eq!(session.usage.len(), 3);
    assert_eq!(
        session.usage.iter().map(|item| item.input.unwrap()).sum::<u64>(),
        14
    );
    assert_eq!(
        session.usage.iter().map(|item| item.output.unwrap()).sum::<u64>(),
        21
    );
    assert_eq!(
        session
            .usage
            .iter()
            .map(|item| item.cache_read.unwrap())
            .sum::<u64>(),
        120
    );
    assert!(session.usage.iter().any(|item| {
        item.model.as_deref() == Some("claude-haiku") && item.id.contains("advisor")
    }));
    assert!(session.usage.iter().all(|item| !item.input_includes_cache));
    assert!(session.usage.iter().all(|item| item.input != Some(999)));
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
    assert!(usage_report(&db, &HistoryFilter::default()).unwrap().totals.input > 0);
    fs::remove_file(source).unwrap();
    refresh(&db, &registry, &home).unwrap();
    assert!(list(&db, &HistoryFilter::default()).unwrap().is_empty());
    let totals = usage_report(&db, &HistoryFilter::default()).unwrap().totals;
    assert_eq!((totals.sessions, totals.input, totals.output, totals.cache_read, totals.cache_write), (0, 0, 0, 0, 0));

}

#[test]
fn jsonl_fingerprint_failure_isolated_then_recovered_without_losing_old_index() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let root = home.join(".codex/sessions");
    fs::create_dir_all(&root).unwrap();
    let failed = root.join("rollout-failed.jsonl");
    let healthy = root.join("rollout-healthy.jsonl");
    for path in [&failed, &healthy] {
        fs::copy(fixtures().join("codex-0.158.jsonl"), path).unwrap();
    }
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let registry = Registry::with_adapters(vec![&CODEX]).unwrap();
    refresh(&db, &registry, &home).unwrap();
    let failed_id = indexed_id(&db, &failed);
    let healthy_id = indexed_id(&db, &healthy);
    fs::write(
        &failed,
        fs::read_to_string(&failed)
            .unwrap()
            .replace("Looks good.", "Failed source changed."),
    )
    .unwrap();
    fs::write(
        &healthy,
        fs::read_to_string(&healthy)
            .unwrap()
            .replace("Looks good.", "Healthy source changed."),
    )
    .unwrap();
    // Stop during discovery, rather than waiting until the whole directory has
    // been fingerprinted. An incomplete discovery must not delete old entries.
    let stop = AtomicBool::new(false);
    let discovered = discover_jsonl_with_control(&root, |_| true, |path| {
        let fingerprint = source_fingerprint(path);
        stop.store(true, Ordering::SeqCst);
        fingerprint
    }, &|| stop.load(Ordering::SeqCst), &|_| true);
    assert!(discovered.as_ref().unwrap_err().contains("已取消"));
    let cancelled = scan_adapter_sources_controlled(&db, &CODEX, discovered, &|| stop.load(Ordering::SeqCst));
    assert!(cancelled.incomplete);
    assert_eq!(list(&db, &HistoryFilter::default()).unwrap().len(), 2);
    // Cancel after the first parsed JSONL row. Neither a partial replacement
    // nor a stale marker may be written, and the unseen second entry remains.
    let calls = AtomicUsize::new(0);
    let cancelled = scan_adapter_sources_controlled(&db, &CODEX, CODEX.history_sources(&home), &|| {
        calls.fetch_add(1, Ordering::SeqCst) + 1 > 3
    });
    assert!(calls.load(Ordering::SeqCst) > 3);
    assert!(cancelled.incomplete && cancelled.detail.contains("已取消"));
    assert_eq!(cancelled.failed_count, 0);
    for id in [&failed_id, &healthy_id] {
        let original = detail(&db, id).unwrap();
        assert!(!original.session.stale);
        assert!(original.messages.iter().any(|item| item.text == "Looks good."));
    }
    assert_eq!(list(&db, &HistoryFilter::default()).unwrap().len(), 2);
    let discovered = discover_jsonl_with(
        &root,
        |path| path.extension().is_some_and(|value| value == "jsonl"),
        |path| {
            if path == failed {
                Err("simulated read failure".into())
            } else {
                source_fingerprint(path)
            }
        },
    );
    let report = scan_adapter_sources(&db, &CODEX, discovered);
    assert_eq!(
        (report.source_count, report.failed_count, report.incomplete),
        (2, 1, true)
    );
    assert!(report.detail.contains("simulated read failure"));
    let old = detail(&db, &failed_id).unwrap();
    assert!(old.session.stale);
    assert!(old
        .messages
        .iter()
        .any(|message| message.text == "Looks good."));
    let updated = detail(&db, &healthy_id).unwrap();
    assert!(!updated.session.stale);
    assert!(updated
        .messages
        .iter()
        .any(|message| message.text == "Healthy source changed."));
    let recovered = refresh(&db, &registry, &home).unwrap();
    assert_eq!(recovered[0].failed_count, 0);
    let restored = detail(&db, &failed_id).unwrap();
    assert!(!restored.session.stale);
    assert!(restored
        .messages
        .iter()
        .any(|message| message.text == "Failed source changed."));
}

#[test]
fn grok_chat_without_row_times_follows_turn_starts() {
    let temp = tempfile::tempdir().unwrap();
    let session = temp.path().join("session");
    fs::create_dir_all(&session).unwrap();
    fs::write(session.join("summary.json"), r#"{"info":{"id":"44444444-4444-4444-8444-444444444444","cwd":"/fixture"},"generated_title":"Turns","created_at":"2026-09-29T08:00:00Z","updated_at":"2026-09-29T10:00:00Z"}"#).unwrap();
    fs::write(session.join("chat_history.jsonl"), [
        r#"{"type":"user","synthetic_reason":"project_instructions","content":"preamble"}"#,
        r#"{"type":"user","content":"first question"}"#,
        r#"{"type":"assistant","content":"first answer","timestamp":"2026-09-29T08:12:00Z"}"#,
        r#"{"type":"user","synthetic_reason":"system_reminder","content":"note"}"#,
        r#"{"type":"user","content":"second question"}"#,
        r#"{"type":"assistant","content":"second answer"}"#,
    ].join("\n")).unwrap();
    fs::write(session.join("events.jsonl"), [
        r#"{"ts":"2026-09-29T08:00:01Z","type":"phase_changed","phase":"waiting"}"#,
        r#"{"ts":"2026-09-29T08:10:00Z","type":"turn_started","turn_number":0}"#,
        r#"{"ts":"2026-09-29T09:10:00Z","type":"turn_started","turn_number":1}"#,
    ].join("\n")).unwrap();
    let parsed = grok::parse(&HistorySource { native_title: None,
        path: session.clone(),
        native_id: None,
        fingerprint: "fixture".into(),
        fingerprint_error: None,
    }).unwrap();
    assert_eq!(parsed.messages.len(), 6);
    let first = parsed.messages[1].timestamp;
    let second = parsed.messages[4].timestamp;
    assert!(first.is_some() && second.is_some() && first < second);
    assert_eq!(parsed.messages[1].timestamp, first);
    assert_eq!(parsed.messages[0].timestamp, None);
    assert_eq!(parsed.messages[3].timestamp, None);
    assert_eq!(parsed.messages[1].timestamp_source, MessageTimeSource::Turn);
    assert_eq!(parsed.messages[2].timestamp_source, MessageTimeSource::Native);
    assert_ne!(parsed.messages[2].timestamp, first);
    assert_eq!(parsed.messages[5].timestamp, second);
    assert_ne!(first, parsed.started_at);

    let compacted = temp.path().join("compacted");
    fs::create_dir_all(&compacted).unwrap();
    fs::write(compacted.join("summary.json"), r#"{"info":{"id":"55555555-5555-4555-8555-555555555555","cwd":"/fixture"},"generated_title":"Compacted","created_at":"2026-09-29T08:00:00Z","updated_at":"2026-09-29T10:00:00Z"}"#).unwrap();
    fs::write(compacted.join("chat_history.jsonl"), [
        r#"{"type":"user","synthetic_reason":"compaction_meta","content":"earlier context"}"#,
        r#"{"type":"user","content":"latest question"}"#,
        r#"{"type":"assistant","content":"latest answer"}"#,
    ].join("\n")).unwrap();
    fs::write(compacted.join("events.jsonl"), [
        r#"{"ts":"2026-09-29T08:10:00Z","type":"turn_started"}"#,
        r#"{"ts":"2026-09-29T09:10:00Z","type":"turn_started"}"#,
        r#"{"ts":"2026-09-29T10:10:00Z","type":"turn_started"}"#,
    ].join("\n")).unwrap();
    let parsed = grok::parse(&HistorySource { native_title: None,
        path: compacted,
        native_id: None,
        fingerprint: "fixture".into(),
        fingerprint_error: None,
    }).unwrap();
    assert!(parsed.messages.iter().all(|message| message.timestamp.is_none()));
    assert_ne!(parsed.messages[0].timestamp, parsed.started_at);
    assert_ne!(parsed.messages[0].timestamp, first);
}

#[test]
fn grok_fingerprint_failure_isolated_then_recovered_without_losing_old_index() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let root = home.join(".grok").join("sessions").join("project");
    let failed = root.join("failed");
    let healthy = root.join("healthy");
    for (id, path) in [("failed", &failed), ("healthy", &healthy)] {
        fs::create_dir_all(path).unwrap();
        let mut summary: serde_json::Value =
            serde_json::from_slice(&fs::read(fixtures().join("grok-1.0/summary.json")).unwrap())
                .unwrap();
        summary["info"]["id"] = id.into();
        fs::write(
            path.join("summary.json"),
            serde_json::to_vec(&summary).unwrap(),
        )
        .unwrap();
        for name in ["chat_history.jsonl", "usage.json"] {
            fs::copy(fixtures().join("grok-1.0").join(name), path.join(name)).unwrap();
        }
    }
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let registry = Registry::with_adapters(vec![&GROK]).unwrap();
    let initial = refresh(&db, &registry, &home).unwrap();
    assert_eq!(initial[0].failed_count, 0, "{initial:?}");
    assert_eq!(
        list(&db, &HistoryFilter::default()).unwrap().len(),
        2,
        "{initial:?}"
    );
    let failed_id = indexed_id(&db, &failed);
    let healthy_id = indexed_id(&db, &healthy);
    let failed_chat = failed.join("chat_history.jsonl");
    let healthy_chat = healthy.join("chat_history.jsonl");
    fs::write(
        &failed_chat,
        fs::read_to_string(&failed_chat)
            .unwrap()
            .replace("The project is ready.", "Failed Grok changed."),
    )
    .unwrap();
    fs::write(
        &healthy_chat,
        fs::read_to_string(&healthy_chat)
            .unwrap()
            .replace("The project is ready.", "Healthy Grok changed."),
    )
    .unwrap();
    let discovered = grok::sources_with_fingerprint(&home, |path| {
        if path == failed_chat {
            Err("simulated Grok read failure".into())
        } else {
            source_fingerprint(path)
        }
    });
    let report = scan_adapter_sources(&db, &GROK, discovered);
    assert_eq!(
        (report.source_count, report.failed_count, report.incomplete),
        (2, 1, true)
    );
    assert!(report.detail.contains("simulated Grok read failure"));
    let old = detail(&db, &failed_id).unwrap();
    assert!(old.session.stale);
    assert!(old
        .messages
        .iter()
        .any(|message| message.text == "The project is ready."));
    assert!(detail(&db, &healthy_id)
        .unwrap()
        .messages
        .iter()
        .any(|message| message.text == "Healthy Grok changed."));
    let recovered = refresh(&db, &registry, &home).unwrap();
    assert_eq!(recovered[0].failed_count, 0);
    let restored = detail(&db, &failed_id).unwrap();
    assert!(!restored.session.stale);
    assert!(restored
        .messages
        .iter()
        .any(|message| message.text == "Failed Grok changed."));
}

#[test]
fn same_length_and_restored_mtime_still_refreshes_changed_content() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let root = home.join(".codex/sessions");
    fs::create_dir_all(&root).unwrap();
    let source = root.join("rollout-preserved-time.jsonl");
    fs::copy(fixtures().join("codex-0.158.jsonl"), &source).unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let registry = Registry::with_adapters(vec![&CODEX]).unwrap();
    refresh(&db, &registry, &home).unwrap();
    let id = list(&db, &HistoryFilter::default()).unwrap()[0].id.clone();
    let before = fs::metadata(&source).unwrap();
    let modified = before.modified().unwrap();
    let original = fs::read_to_string(&source).unwrap();
    let changed = original.replace("Looks good.", "Looks fine.");
    assert_ne!(original, changed);
    assert_eq!(original.len(), changed.len());
    fs::write(&source, changed).unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(&source)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(modified))
        .unwrap();
    assert_eq!(fs::metadata(&source).unwrap().len(), before.len());
    assert_eq!(fs::metadata(&source).unwrap().modified().unwrap(), modified);
    refresh(&db, &registry, &home).unwrap();
    assert!(detail(&db, &id)
        .unwrap()
        .messages
        .iter()
        .any(|message| message.text == "Looks fine."));
}

/// `counts` is (input, output, cache read, cache write).
fn event(id: &str, model: Option<&str>, timestamp: i64, counts: (u64, u64, Option<u64>, Option<u64>), includes_cache: bool) -> UsageEvent {
    let (input, output, read, write) = counts;
    UsageEvent { native_usage: None, request_count: Some(1), id: id.into(), model: model.map(str::to_owned), timestamp: Some(timestamp), input: Some(input), output: Some(output), cache_read: read, cache_write: write, input_includes_cache: includes_cache, attributions: Vec::new() }
}

/// Stores a synthetic session through the same path a scan uses.
fn store_events(db: &Database, tool: &str, key: &str, model: Option<&str>, usage: Vec<UsageEvent>) -> String {
    let source = HistorySource { native_title: None, path: PathBuf::from(key), native_id: None, fingerprint: "fixture".into(), fingerprint_error: None };
    let mut parsed = ParsedSession::new();
    parsed.title = key.into();
    parsed.model = model.map(str::to_owned);
    parsed.updated_at = usage.iter().filter_map(|item| item.timestamp).max();
    parsed.usage = usage;
    db.with_connection(|conn| store_session(conn, tool, &source, &parsed, &HashMap::new())).unwrap();
    stable_id(tool, &source.key())
}

const DAY: i64 = 86_400_000;
const FIXTURE_DAY: i64 = 1790668800000;

#[test]
fn native_units_roundtrip_filter_group_deduplicate_and_export_without_token_prices() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("native.db")).unwrap();
    // An unregistered implementation label exercises the shared contract without
    // adding any tool-specific dispatch or model pricing exceptions.
    let unit_event = |id: &str, at, value, original, billable| UsageEvent {
        native_usage: Some(NativeUsage { unit: "work_units".into(), value, original_value: original, billable }),
        id: id.into(), model: Some("synthetic-priced-model".into()), timestamp: Some(at), request_count: Some(1),
        input: None, output: None, cache_read: None, cache_write: None, input_includes_cache: false, attributions: Vec::new(),
    };
    let first = unit_event("request-a", FIXTURE_DAY, 1.25, Some(2.5), Some(false));
    let id = store_events(&db, "future_native_units", "native-session", Some("synthetic-priced-model"), vec![first.clone(),
        unit_event("request-b", FIXTURE_DAY + DAY, 0.75, Some(1.5), Some(true)),
        unit_event("request-c", FIXTURE_DAY + DAY, 0.5, None, None)]);
    store_events(&db, "future_native_units", "copied-session", None, vec![first]);
    let extension = Box::leak(Box::new(crate::adapters::qoder_cn::QoderAdapter { id: "future_native_units", ..crate::adapters::qoder_cn::QODER_CN }));
    let registry = Registry::with_adapters(vec![extension]).unwrap();
    save_price(&db, &registry, HistoryPrice { tool_id: "future_native_units".into(), model: "synthetic-priced-model".into(), currency: "USD".into(),
        input_per_million: 1.0, output_per_million: 1.0, cache_read_per_million: 1.0, cache_write_per_million: 1.0, source: "manual".into(), updated_at: 0 }).unwrap();
    let report = usage_report(&db, &HistoryFilter::default()).unwrap();
    assert_eq!(report.totals.requests, 3);
    assert_eq!(report.duplicate_requests, 1);
    assert_eq!(report.totals.unknown_token_records, 3);
    assert_eq!(report.totals.cost, None, "known model prices must not fabricate zero cost from unknown tokens");
    assert_eq!(report.totals.native_usage.len(), 3);
    assert_eq!(report.totals.native_usage.iter().map(|usage| usage.value).sum::<f64>(), 2.5);
    assert_eq!(report.by_model[0].totals.native_usage, report.totals.native_usage);
    assert_eq!(report.by_tool[0].totals.native_usage, report.totals.native_usage);
    assert_eq!(report.by_project[0].totals.native_usage, report.totals.native_usage);
    let filtered = usage_report(&db, &HistoryFilter { tool_id: Some("future_native_units".into()), model: Some("synthetic-priced-model".into()), from_ms: Some(FIXTURE_DAY + DAY), to_ms: Some(FIXTURE_DAY + 2 * DAY), ..Default::default() }).unwrap();
    assert_eq!(filtered.totals.requests, 2);
    assert_eq!(filtered.totals.native_usage.iter().map(|usage| usage.value).sum::<f64>(), 1.25);
    assert_eq!(filtered.timeline.iter().map(|bucket| bucket.totals.native_usage.iter().map(|usage| usage.value).sum::<f64>()).sum::<f64>(), 1.25);
    let detail = detail(&db, &id).unwrap();
    assert_eq!(detail.usage[0].native_usage.as_ref().unwrap().billable, Some(false));
    assert_eq!(detail.totals.native_usage, report.totals.native_usage);
    let json_path = temp.path().join("export.json");
    export(&db, &id, "json", &json_path).unwrap();
    let json: Value = serde_json::from_str(&fs::read_to_string(json_path).unwrap()).unwrap();
    assert_eq!(json["usage"][0]["nativeUsage"]["originalValue"], 2.5);
    assert_eq!(json["totals"]["unknownTokenRecords"], 3);
    let md_path = temp.path().join("export.md");
    export(&db, &id, "markdown", &md_path).unwrap();
    let md = fs::read_to_string(md_path).unwrap();
    assert!(md.contains("Token：未知"));
    assert!(md.contains("work_units：1.25；原始值：2.5；原生标记未计费"));
}

#[test]
fn percent_gauge_units_aggregate_by_maximum_instead_of_summing() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("gauges.db")).unwrap();
    // context-usage-percent rows are instantaneous samples of one session's
    // context occupancy; adding them would exceed 100% and misreport usage.
    let sample = |id: &str, at, value| UsageEvent {
        native_usage: Some(NativeUsage { unit: "context-usage-percent".into(), value, original_value: None, billable: None }),
        id: id.into(), model: None, timestamp: Some(at), request_count: Some(1),
        input: None, output: None, cache_read: None, cache_write: None, input_includes_cache: false, attributions: Vec::new(),
    };
    let day = FIXTURE_DAY;
    store_events(&db, "kiro", "gauge-session", None, vec![
        sample("gauge-a", day, 3.25),
        sample("gauge-b", day + 1_000, 97.5),
        sample("gauge-c", day + 2_000, 12.0),
    ]);
    // Additive native units in the same report keep summing.
    let credit = UsageEvent {
        native_usage: Some(NativeUsage { unit: "credits".into(), value: 2.0, original_value: None, billable: Some(true) }),
        id: "credit-a".into(), model: None, timestamp: Some(day), request_count: Some(1),
        input: None, output: None, cache_read: None, cache_write: None, input_includes_cache: false, attributions: Vec::new(),
    };
    let credit_again = UsageEvent {
        native_usage: Some(NativeUsage { unit: "credits".into(), value: 3.0, original_value: None, billable: Some(true) }),
        id: "credit-b".into(),
        timestamp: Some(day + 3_000),
        ..credit.clone()
    };
    store_events(&db, "kiro", "credit-session", None, vec![credit, credit_again]);
    let report = usage_report(&db, &HistoryFilter::default()).unwrap();
    let gauge = report.totals.native_usage.iter()
        .find(|usage| usage.unit == "context-usage-percent")
        .expect("gauge 单位进入报表");
    assert_eq!(gauge.value, 97.5, "多采样取最大值");
    assert_eq!(gauge.records, 3, "采样条数仍逐一计数");
    let credits = report.totals.native_usage.iter()
        .find(|usage| usage.unit == "credits")
        .expect("加性单位进入报表");
    assert_eq!(credits.value, 5.0, "credits 等加性单位仍求和");
    // Per-bucket timelines take the maximum inside each bucket.
    let bucketed = usage_report(&db, &HistoryFilter { from_ms: Some(day), to_ms: Some(day + DAY), ..Default::default() }).unwrap();
    let gauge_buckets: Vec<f64> = bucketed.timeline.iter()
        .filter_map(|bucket| bucket.totals.native_usage.iter().find(|usage| usage.unit == "context-usage-percent").map(|usage| usage.value))
        .collect();
    assert_eq!(gauge_buckets.len(), 1);
    assert_eq!(gauge_buckets[0], 97.5);
}

#[test]
fn database_v22_native_usage_migration_preserves_legacy_tokens_and_json() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("legacy.db");
    let db = Database::open(&path).unwrap();
    let id = store_events(&db, "codex", "legacy", Some("gpt-5"), vec![event("legacy-request", Some("gpt-5"), FIXTURE_DAY, (10, 2, None, None), false)]);
    db.with_connection(|conn| {
        conn.execute_batch("ALTER TABLE history_usage DROP COLUMN native_usage_json; PRAGMA user_version = 22;").map_err(|error| error.to_string())?;
        // Old payloads have no optional nativeUsage field.
        conn.execute("UPDATE history_sessions SET usage_json = json_remove(usage_json, '$[0].nativeUsage')", []).map_err(|error| error.to_string())?;
        Ok(())
    }).unwrap();
    drop(db);
    let db = Database::open(&path).unwrap();
    let report = usage_report(&db, &HistoryFilter::default()).unwrap();
    assert_eq!(report.totals.total, 12);
    assert_eq!(report.totals.unknown_token_records, 0);
    assert!(report.totals.native_usage.is_empty());
    assert!(detail(&db, &id).unwrap().usage[0].native_usage.is_none());
}

#[test]
fn qoder_registered_scan_resumes_original_project_and_retains_failed_parent() {
    use crate::adapters::qoder_cn::QODER_CN;
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("workspace");
    fs::create_dir_all(&project).unwrap();
    let logs = temp.path().join(".qoder-cn/projects/synthetic");
    let native = "11111111-2222-4333-8444-555555555555";
    fs::create_dir_all(logs.join(format!("{native}/subagents"))).unwrap();
    let path = logs.join(format!("{native}.jsonl"));
    let fixture = fs::read_to_string(fixtures().join("qoder-cn-1.1.74-session.jsonl")).unwrap();
    let text = fixture.lines().map(|line| {
        let mut row: Value = serde_json::from_str(line).unwrap();
        if row.get("cwd").is_some() { row["cwd"] = project.to_string_lossy().as_ref().into(); }
        row.to_string()
    }).collect::<Vec<_>>().join("\n");
    fs::write(&path, text).unwrap();
    let db = Database::open(&temp.path().join("index.db")).unwrap();
    // Command generation needs a terminal selection, but never launches it.
    // Keep the test independent of desktop terminals installed on the host.
    let terminal = temp.path().join("fixture-terminal");
    fs::write(&terminal, "").unwrap();
    crate::launch::set_custom_terminal(
        &db, terminal.display().to_string(), vec!["{script}".into()],
    ).unwrap();
    let registry = Registry::with_adapters(vec![&QODER_CN]).unwrap().with_fixture_installation("qoder_cn", "1.2.0");
    let scan = refresh_controlled(&db, &registry, temp.path(), &["qoder_cn".into()], &|| false).unwrap();
    assert_eq!(scan[0].failed_count, 0);
    let sessions = list(&db, &HistoryFilter::default()).unwrap();
    assert_eq!(sessions.len(), 1);
    let command = copy_resume_command(&db, &registry, temp.path(), &sessions[0].id, LaunchMode::Normal).unwrap();
    assert!(command.contains(&format!("'-r' '{native}'")), "{command}");
    assert!(command.contains(&project.to_string_lossy().to_string()));
    fs::copy(fixtures().join("qoder-cn-1.1.74-subagent.jsonl"), logs.join(format!("{native}/subagents/agent-new.jsonl"))).unwrap();
    refresh_controlled(&db, &registry, temp.path(), &["qoder_cn".into()], &|| false).unwrap();
    assert_eq!(detail(&db, &sessions[0].id).unwrap().totals.requests, 3);
    fs::write(&path, "{\"future_schema\":true}\n").unwrap();
    let failed = refresh_controlled(&db, &registry, temp.path(), &["qoder_cn".into()], &|| false).unwrap();
    assert_eq!(failed[0].failed_count, 1, "valid subagent usage must not mask an incompatible parent schema");
    let preserved = detail(&db, &sessions[0].id).unwrap();
    assert!(preserved.session.stale);
    assert_eq!(preserved.messages.len(), 2);
    assert_eq!(preserved.totals.requests, 3);
}

#[test]
fn qoder_unknown_amount_calls_persist_report_and_export_and_invalid_shapes_stale_index() {
    use crate::adapters::qoder_cn::QODER_CN;
    let temp = tempfile::tempdir().unwrap();
    let logs = temp.path().join(".qoder-cn/projects/synthetic");
    fs::create_dir_all(&logs).unwrap();
    let path = logs.join("11111111-2222-4333-8444-555555555555.jsonl");
    let db = Database::open(&temp.path().join("index.db")).unwrap();
    let registry = Registry::with_adapters(vec![&QODER_CN]).unwrap();
    let refresh = || refresh_controlled(&db, &registry, temp.path(), &["qoder_cn".into()], &|| false).unwrap();
    fs::write(&path, "{\"type\":\"assistant\"}\n").unwrap();
    assert_eq!(refresh()[0].failed_count, 1, "invalid shape fails on the initial scan");
    assert!(list(&db, &HistoryFilter::default()).unwrap().is_empty());
    let row = serde_json::json!({"type":"assistant","uuid":"a","parentUuid":null,"timestamp":"2026-10-20T08:00:00Z","message":{"id":"response","content":"answer","model":"qfmodel","usage":{"request_id":"known-call","input_tokens":0,"output_tokens":0,"credits":null}}});
    fs::write(&path, row.to_string()).unwrap();
    assert_eq!(refresh()[0].failed_count, 0);
    let id = list(&db, &HistoryFilter::default()).unwrap().remove(0).id;
    let saved = detail(&db, &id).unwrap();
    assert_eq!(saved.usage.len(), 1);
    assert_eq!(saved.usage[0].request_count, Some(1));
    assert!(saved.usage[0].native_usage.is_none() && saved.usage[0].input.is_none());
    let report = usage_report(&db, &HistoryFilter { tool_id: Some("qoder_cn".into()), model: Some("qfmodel".into()), ..Default::default() }).unwrap();
    assert_eq!(report.totals.requests, 1);
    assert_eq!(report.totals.usage_records, 1);
    assert_eq!(report.totals.unknown_token_records, 1);
    assert!(report.totals.native_usage.is_empty());
    assert_eq!(report.totals.cost, None);
    assert_eq!(report.by_model[0].totals.requests, 1);
    assert_eq!(report.timeline.iter().map(|bucket| bucket.totals.requests).sum::<u64>(), 1);
    let json_path = temp.path().join("export.json");
    export(&db, &id, "json", &json_path).unwrap();
    let json: Value = serde_json::from_str(&fs::read_to_string(json_path).unwrap()).unwrap();
    assert_eq!(json["totals"]["requests"], 1);
    assert_eq!(json["totals"]["unknownTokenRecords"], 1);
    assert_eq!(json["usage"][0]["nativeUsage"], Value::Null);
    let md_path = temp.path().join("export.md");
    export(&db, &id, "markdown", &md_path).unwrap();
    assert!(fs::read_to_string(md_path).unwrap().contains("Token：未知"));
    fs::write(&path, format!("{row}\n{{\"type\":\"assistant\"}}\n")).unwrap();
    assert_eq!(refresh()[0].failed_count, 0);
    assert!(detail(&db, &id).unwrap().session.partial, "mixed valid and invalid shapes are partial");
    fs::write(&path, "{\"type\":\"assistant\"}\n").unwrap();
    assert_eq!(refresh()[0].failed_count, 1);
    let preserved = detail(&db, &id).unwrap();
    assert!(preserved.session.stale);
    assert_eq!(preserved.messages[0].text, "answer");
    assert_eq!(preserved.totals.requests, 1);
}

#[test]
fn qoder_duplicate_main_subagent_requests_preserve_billing_groups_and_exports() {
    use crate::adapters::qoder_cn::QODER_CN;
    let temp = tempfile::tempdir().unwrap();
    let logs = temp.path().join(".qoder-cn/projects/synthetic");
    let native_id = "11111111-2222-4333-8444-555555555555";
    let wires = logs.join(format!("{native_id}/subagents"));
    fs::create_dir_all(&wires).unwrap();
    let main = [
        serde_json::json!({"request_id":"r1","credits":1,"original_credits":2,"billable":false}),
        serde_json::json!({"request_id":"r2","credits":0.1}),
        serde_json::json!({"request_id":"r3","credits":1,"original_credits":2,"billable":true}),
        serde_json::json!({"request_id":"r4","credits":0.25,"original_credits":0.5,"billable":false}),
    ];
    let child = [
        serde_json::json!({"request_id":"r1","credits":1.5}),
        serde_json::json!({"request_id":"r2","credits":0.5,"original_credits":1,"billable":true}),
        serde_json::json!({"request_id":"r3","original_credits":0,"billable":false}),
        serde_json::json!({"request_id":"r4","credits":0,"original_credits":0,"billable":true}),
    ];
    let rows = |usages: &[Value]| usages.iter().enumerate().map(|(index, usage)| serde_json::json!({
        "type":"assistant","uuid":format!("a{index}"),"parentUuid":index.checked_sub(1).map(|index| format!("a{index}")),
        "sessionId":native_id,"timestamp":"2026-10-20T08:00:00Z","message":{"content":"answer","model":"qfmodel","usage":usage}
    }).to_string()).collect::<Vec<_>>().join("\n");
    fs::write(logs.join(format!("{native_id}.jsonl")), rows(&main)).unwrap();
    let db = Database::open(&temp.path().join("index.db")).unwrap();
    let registry = Registry::with_adapters(vec![&QODER_CN]).unwrap();
    let refresh = || refresh_controlled(&db, &registry, temp.path(), &["qoder_cn".into()], &|| false).unwrap();
    assert_eq!(refresh()[0].failed_count, 0);
    let id = list(&db, &HistoryFilter::default()).unwrap().remove(0).id;
    fs::write(wires.join("agent-duplicate.jsonl"), rows(&child)).unwrap();
    assert_eq!(refresh()[0].failed_count, 0);
    let saved = detail(&db, &id).unwrap();
    assert_eq!(saved.usage.len(), 4);
    assert_eq!(saved.totals.requests, 4);
    assert_eq!(saved.usage[3].native_usage.as_ref().unwrap().value, 0.0);
    let report = usage_report(&db, &HistoryFilter { tool_id: Some("qoder_cn".into()), model: Some("qfmodel".into()), ..Default::default() }).unwrap();
    let totals = &report.totals;
    assert_eq!(totals.requests, 4);
    assert_eq!(totals.native_usage.len(), 2, "no request moves to unknown billing because a duplicate omits metadata");
    for (billable, value, original) in [(false, 2.5, 2.0), (true, 0.5, 1.0)] {
        let group = totals.native_usage.iter().find(|group| group.billable == Some(billable)).unwrap();
        assert_eq!((group.value, group.original_value, group.records, group.unknown_original_records), (value, Some(original), 2, 0));
    }
    assert_eq!(saved.totals.native_usage, totals.native_usage);
    assert_eq!(report.by_model[0].totals.native_usage, totals.native_usage);
    assert_eq!(report.timeline[0].totals.native_usage, totals.native_usage);
    let json_path = temp.path().join("export.json");
    export(&db, &id, "json", &json_path).unwrap();
    let json: Value = serde_json::from_str(&fs::read_to_string(json_path).unwrap()).unwrap();
    assert_eq!(json["usage"][0]["nativeUsage"]["originalValue"], 2.0);
    assert_eq!(json["usage"][0]["nativeUsage"]["billable"], false);
    assert_eq!(json["usage"][3]["nativeUsage"]["value"], 0.0);
    assert_eq!(json["usage"][3]["nativeUsage"]["originalValue"], 0.0);
    let md_path = temp.path().join("export.md");
    export(&db, &id, "markdown", &md_path).unwrap();
    let markdown = fs::read_to_string(md_path).unwrap();
    assert!(markdown.contains("credits：2.5；原始值：2；原生标记未计费"));
    assert!(markdown.contains("credits：0.5；原始值：1；原生标记可计费"));
}

#[test]
fn missing_native_request_ids_are_scoped_to_the_source() {
    use crate::adapters::{codebuddy::history as buddy, command_code::history as command};
    for (tool, name) in [("codebuddy", "codebuddy-2.161.1-session.jsonl"), ("command_code", "command-code-1.73-session.jsonl")] {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("index.db")).unwrap();
        let text = fs::read_to_string(fixtures().join(name)).unwrap().lines().map(|line| {
            let mut row: serde_json::Value = serde_json::from_str(line).unwrap();
            row.as_object_mut().unwrap().remove("id");
            row.to_string()
        }).collect::<Vec<_>>().join("\n") + "\n";
        let mut expected = 0;
        for name in ["one.jsonl", "two.jsonl"] {
            let source = HistorySource { path: temp.path().join(name), ..file("unused") };
            fs::write(&source.path, &text).unwrap();
            let parsed = if tool == "codebuddy" { buddy::parse(&source) } else { command::parse(&source) }.unwrap();
            assert!(!parsed.usage.is_empty());
            expected += parsed.usage.len() as u64;
            db.with_connection(|conn| store_session(conn, tool, &source, &parsed, &HashMap::new())).unwrap();
        }
        let report = usage_report(&db, &HistoryFilter::default()).unwrap();
        assert_eq!(report.totals.requests, expected, "{tool}");
        assert_eq!(report.duplicate_requests, 0, "{tool}");
    }
}

#[test]
fn session_local_usage_ids_survive_multi_session_reports_and_copies() {
    use crate::adapters::{deepseek::history as dsh, devin::history as devin};
    for tool in ["deepseek", "devin"] {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("index.db")).unwrap();
        let (fixture, native_id) = if tool == "deepseek" {
            let bytes = fs::read(fixtures().join("dsh-0.2.1-v4.session.jsonl.zstd")).unwrap();
            (String::from_utf8(zstd::stream::decode_all(&bytes[..]).unwrap()).unwrap(),
                "session-00000000-0000-4000-8000-000000000001")
        } else {
            (fs::read_to_string(fixtures().join("devin-3000-transcript.json")).unwrap(), "serene-example")
        };
        let mut expected = [0u64; 4];
        let mut requests = 0;
        for (name, session_id) in [("first", native_id), ("second", "independent-session"), ("copy", native_id)] {
            let text = fixture.replace(native_id, session_id);
            let path = temp.path().join(name);
            fs::write(&path, if tool == "deepseek" {
                zstd::stream::encode_all(text.as_bytes(), 1).unwrap()
            } else { text.into_bytes() }).unwrap();
            let source = HistorySource { path, ..file("unused") };
            let parsed = if tool == "deepseek" { dsh::parse(&source) } else { devin::parse(&source) }.unwrap();
            if name != "copy" {
                for event in &parsed.usage {
                    let read = event.cache_read.unwrap_or(0);
                    let write = event.cache_write.unwrap_or(0);
                    expected[0] += event.input.unwrap_or(0).saturating_sub(if event.input_includes_cache { read + write } else { 0 });
                    expected[1] += event.output.unwrap_or(0);
                    expected[2] += read;
                    expected[3] += write;
                    requests += 1;
                }
            }
            db.with_connection(|conn| store_session(conn, tool, &source, &parsed, &HashMap::new())).unwrap();
        }
        let report = usage_report(&db, &HistoryFilter::default()).unwrap();
        assert_eq!(report.totals.requests, requests, "{tool}");
        assert_eq!(report.duplicate_requests, requests / 2, "only the copied session is duplicate: {tool}");
        assert_eq!([report.totals.input, report.totals.output, report.totals.cache_read, report.totals.cache_write], expected, "{tool}");
        assert_eq!(report.totals.total, expected.iter().sum::<u64>());
        assert_eq!(report.top_sessions.iter().map(|s| s.totals.total).sum::<u64>(), report.totals.total);
        assert_eq!(report.by_model.iter().map(|s| s.totals.total).sum::<u64>(), report.totals.total);
    }
}

#[test]
fn report_counts_disjoint_tokens_groups_models_and_filters() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let root = home.join(".codex/sessions");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("rollout-no-usage.jsonl"),
        r#"{"timestamp":"2026-09-29T08:00:00Z","type":"session_meta","payload":{"id":"55555555-5555-4555-8555-555555555555"}}"#).unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let registry = Registry::with_adapters(vec![&CODEX]).unwrap();
    refresh(&db, &registry, &home).unwrap();
    let empty = usage_report(&db, &HistoryFilter::default()).unwrap();
    assert_eq!(empty.totals.requests, 0);
    assert_eq!(empty.totals.cost, None);
    assert!(empty.timeline.is_empty());

    fs::copy(fixtures().join("codex-0.158.jsonl"), root.join("rollout-with-usage.jsonl")).unwrap();
    refresh(&db, &registry, &home).unwrap();
    let report = usage_report(&db, &HistoryFilter::default()).unwrap();
    // 150 prompt tokens of which 60 were cache reads: 90 fresh + 60 cached + 30 output.
    assert_eq!((report.totals.input, report.totals.cache_read, report.totals.cache_write, report.totals.output), (90, 60, 0, 30));
    assert_eq!(report.totals.total, 180);
    assert_eq!((report.totals.requests, report.totals.sessions, report.totals.unknown_request_records), (0, 1, 2));
    assert!(report.totals.cost.is_some());
    assert_eq!(report.totals.unpriced_tokens, 0);
    assert_eq!(report.by_model.len(), 1);
    assert_eq!(report.by_tool[0].tool_id.as_deref(), Some("codex"));
    assert_eq!(report.timeline.iter().map(|bucket| bucket.totals.total).sum::<u64>(), 180);

    store_events(&db, "codex", "split", None, vec![
        event("request-a", Some("model-a"), FIXTURE_DAY + 1000, (10, 2, Some(0), Some(0)), true),
        event("request-b", Some("model-b"), FIXTURE_DAY + 2000, (30, 5, Some(10), Some(0)), true),
    ]);
    let grouped = usage_report(&db, &HistoryFilter::default()).unwrap();
    for (model, total) in [("model-a", 12), ("model-b", 35)] {
        let row = grouped.by_model.iter().find(|row| row.model.as_deref() == Some(model)).unwrap();
        assert_eq!((row.totals.total, row.totals.sessions, row.priced), (total, 1, false));
        assert_eq!(row.totals.unpriced_tokens, total);
        let selected = usage_report(&db, &HistoryFilter { model: Some(model.into()), ..Default::default() }).unwrap();
        assert_eq!(selected.totals.total, total);
        assert_eq!(selected.by_model.len(), 1);
        assert!(selected.models.len() >= 3, "the model menu keeps every model while one is selected");
    }
    assert_eq!(grouped.totals.unpriced_tokens, 47);
    let unknown = usage_report(&db, &HistoryFilter { model: Some("__unknown__".into()), ..Default::default() }).unwrap();
    assert_eq!(unknown.totals.requests, 0);
}

#[test]
fn report_dates_follow_each_call_and_compare_the_same_elapsed_window() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let root = home.join(".codex/sessions");
    fs::create_dir_all(&root).unwrap();
    fs::copy(fixtures().join("codex-0.158.jsonl"), root.join("rollout-price.jsonl")).unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let registry = Registry::with_adapters(vec![&CODEX]).unwrap();
    refresh(&db, &registry, &home).unwrap();
    let filter = HistoryFilter {
        tool_id: Some("codex".into()),
        model: Some("gpt-6-astra".into()),
        from_ms: Some(FIXTURE_DAY),
        to_ms: Some(FIXTURE_DAY + DAY),
        ..Default::default()
    };
    let published = usage_report(&db, &filter).unwrap();
    assert_eq!((published.totals.input, published.totals.cache_read), (90, 60));
    assert!((published.totals.cost.unwrap() - 0.00246).abs() < 1e-9);
    assert!(published.price_sources.iter().any(|source| source.contains("OpenAI 公开价")));
    assert_eq!(published.bucket, "hour");
    assert_eq!(published.timeline.iter().map(|bucket| bucket.totals.usage_records).sum::<u64>(), 2);
    let previous = published.previous.as_ref().unwrap();
    assert_eq!((previous.from, previous.to), (FIXTURE_DAY - DAY, FIXTURE_DAY));
    assert_eq!(previous.totals.requests, 0);
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
    let priced = usage_report(&db, &filter).unwrap();
    assert!((priced.totals.cost.unwrap() - 0.000156).abs() < 1e-9);
    assert_eq!(priced.price_sources.len(), 1);
    let next_day = usage_report(&db, &HistoryFilter { from_ms: Some(FIXTURE_DAY + DAY), to_ms: Some(FIXTURE_DAY + 2 * DAY), ..filter.clone() }).unwrap();
    assert_eq!(next_day.totals.requests, 0);
    assert_eq!(next_day.previous.unwrap().totals.usage_records, 2, "the previous day holds the calls");

    // A long session last touched today must not move yesterday's calls onto today.
    store_events(&db, "codex", "long-session", Some("gpt-6-astra"), vec![
        event("old", Some("gpt-6-astra"), FIXTURE_DAY - DAY + 5_000, (999, 1, Some(0), Some(0)), true),
        event("today", Some("gpt-6-astra"), FIXTURE_DAY + 5_000, (10, 1, Some(0), Some(0)), true),
    ]);
    let today = usage_report(&db, &filter).unwrap();
    assert_eq!(today.totals.requests, 1);
    assert_eq!(today.totals.unknown_request_records, 2);
    assert_eq!(today.totals.input, 90 + 10);
    assert_eq!(today.previous.unwrap().totals.input, 999);
    let sessions = list(&db, &HistoryFilter { from_ms: Some(FIXTURE_DAY - DAY), to_ms: Some(FIXTURE_DAY), ..Default::default() }).unwrap();
    assert_eq!(sessions.len(), 1, "sessions with calls on a day are listed for that day");
}

#[test]
fn report_drops_placeholders_dedupes_copied_calls_and_keeps_known_cache() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    store_events(&db, "claude_code", "main", Some("<synthetic>"), vec![
        event("placeholder", Some("<synthetic>"), FIXTURE_DAY + 1000, (0, 0, Some(0), Some(0)), false),
        event("msg-1:req-1", Some("glm-5.3"), FIXTURE_DAY + 2000, (10, 2, Some(0), Some(0)), false),
    ]);
    // A resumed session copies earlier calls; the same request is billed once.
    store_events(&db, "claude_code", "resumed", Some("glm-5.3"), vec![
        event("msg-1:req-1", Some("glm-5.3"), FIXTURE_DAY + 2000, (10, 2, Some(0), Some(0)), false),
        event("msg-2:req-2", Some("glm-5.3"), FIXTURE_DAY + 3000, (4, 1, Some(9), None), false),
    ]);
    let report = usage_report(&db, &HistoryFilter::default()).unwrap();
    assert!(report.models.iter().all(|model| model != "<synthetic>"));
    assert!(report.by_model.iter().all(|row| row.model.as_deref() != Some("<synthetic>")));
    assert_eq!(report.totals.requests, 2);
    assert_eq!(report.duplicate_requests, 1);
    assert_eq!((report.totals.input, report.totals.cache_read, report.totals.cache_write), (14, 9, 0));
    assert!(!report.top_sessions.is_empty());

    store_events(&db, "open_code", "pickle", Some("{\"id\":\"big-pickle\",\"providerID\":\"opencode\"}"), vec![
        event("msg_open", Some("{\"id\":\"big-pickle\",\"providerID\":\"opencode\"}"), FIXTURE_DAY + 4000, (4, 1, Some(9), Some(2)), false),
    ]);
    let open = usage_report(&db, &HistoryFilter { tool_id: Some("open_code".into()), ..Default::default() }).unwrap();
    assert!(open.models.iter().any(|model| model == "big-pickle"));
    assert!(open.models.iter().all(|model| !model.starts_with('{')));
    assert_eq!((open.totals.cache_read, open.totals.cache_write), (9, 2));
    assert_eq!(open.totals.cost, Some(0.0), "a free published model is priced at zero, not unknown");
}

#[test]
fn models_dev_parse_drops_entries_without_cost_and_rejects_garbage() {
    let body = serde_json::json!({
        "fixture": {"id": "fixture", "models": {
            "alpha": {"id": "alpha", "cost": {"input": 1.5, "output": 6}},
            "free": {"id": "free"},
            "broken": {"id": "broken", "cost": {"input": "lots"}}
        }},
        "empty": {"id": "empty"}
    })
    .to_string();
    let prices = models_dev::parse_prices(&body, 42).unwrap();
    assert_eq!(prices.len(), 1);
    let alpha = &prices[0];
    assert_eq!((alpha.tool_id.as_str(), alpha.model.as_str()), ("fixture", "alpha"));
    assert_eq!((alpha.input_per_million, alpha.output_per_million), (1.5, 6.0));
    assert_eq!((alpha.cache_read_per_million, alpha.cache_write_per_million), (0.0, 0.0));
    assert_eq!((alpha.source.as_str(), alpha.updated_at), ("models.dev", 42));
    assert_eq!(alpha.currency, "USD");
    assert!(models_dev::parse_prices("not json", 0).is_err());
    assert!(models_dev::parse_prices("[]", 0).is_err());
    assert!(models_dev::parse_prices("{}", 0).is_err(), "a response without prices must not replace the cache");
}

#[test]
fn models_dev_model_matching_is_exact_then_normalized() {
    assert_eq!(models_dev::normalize_model("OpenAI/GPT-4O"), "gpt-4o");
    assert_eq!(models_dev::normalize_model(" claude-Sonnet-4-5 "), "claude-sonnet-4-5");
    assert_eq!(models_dev::normalize_model("custom/x"), "custom/x", "unknown prefixes are kept");
    let imported = models_dev::ImportedPrices::index(vec![
        HistoryPrice { tool_id: "fixture".into(), model: "vendor-nine".into(), currency: "USD".into(),
            input_per_million: 1.0, output_per_million: 2.0, cache_read_per_million: 0.1, cache_write_per_million: 0.0,
            source: "models.dev".into(), updated_at: 1 },
        HistoryPrice { tool_id: "fixture".into(), model: "Vendor-Ten".into(), currency: "USD".into(),
            input_per_million: 3.0, output_per_million: 4.0, cache_read_per_million: 0.0, cache_write_per_million: 0.0,
            source: "models.dev".into(), updated_at: 1 },
    ]);
    assert_eq!(imported.resolve("vendor-nine").unwrap().input_per_million, 1.0, "exact match wins");
    assert_eq!(imported.resolve("VENDOR-NINE").unwrap().output_per_million, 2.0, "case is normalized");
    assert_eq!(imported.resolve("openai/vendor-ten").unwrap().input_per_million, 3.0, "provider prefix is stripped");
    assert!(imported.resolve("vendor-eleven").is_none());
}

#[test]
fn models_dev_prices_fill_the_gap_between_custom_and_published_rates() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let registry = Registry::with_adapters(vec![&CODEX]).unwrap();
    let fetched = now_ms();
    let cache = models_dev::PriceCache {
        fetched_at: fetched,
        prices: vec![
            HistoryPrice { tool_id: "fixture".into(), model: "vendor-nine".into(), currency: "USD".into(),
                input_per_million: 2.0, output_per_million: 8.0, cache_read_per_million: 0.2, cache_write_per_million: 2.5,
                source: "models.dev".into(), updated_at: fetched },
        ],
    };
    fs::write(models_dev::cache_path(temp.path()), serde_json::to_string(&cache).unwrap()).unwrap();
    store_events(&db, "codex", "imported", None, vec![
        // 100 input includes 40 cache read + 5 cache write: 55 fresh.
        event("call-nine", Some("vendor-nine"), FIXTURE_DAY + 1000, (100, 10, Some(40), Some(5)), true),
        event("call-prefixed", Some("openai/vendor-nine"), FIXTURE_DAY + 2000, (10, 2, Some(0), Some(0)), false),
        event("call-unknown", Some("never-priced"), FIXTURE_DAY + 3000, (30, 3, Some(0), Some(0)), false),
    ]);
    let report = usage_report(&db, &HistoryFilter::default()).unwrap();
    // call-nine: 55*2 + 40*0.2 + 5*2.5 + 10*8 = 210.5; call-prefixed: 10*2 + 2*8 = 36 (per million).
    assert!((report.totals.cost.unwrap() - 0.0002465).abs() < 1e-9);
    assert_eq!(report.totals.unpriced_tokens, 33, "models the table lacks stay unpriced");
    let source = report.price_sources.iter().find(|source| source.contains("models.dev")).expect("the imported source is labeled");
    assert!(source.contains("vendor-nine"));

    // A custom price still wins over the imported rate for the same model string.
    save_price(&db, &registry, HistoryPrice {
        tool_id: "codex".into(), model: "vendor-nine".into(), currency: "USD".into(),
        input_per_million: 100.0, output_per_million: 100.0, cache_read_per_million: 100.0, cache_write_per_million: 100.0,
        source: "Manual fixture rate".into(), updated_at: 0,
    }).unwrap();
    let overridden = usage_report(&db, &HistoryFilter { model: Some("vendor-nine".into()), ..Default::default() }).unwrap();
    assert!((overridden.totals.cost.unwrap() - 0.011).abs() < 1e-9);
    assert_eq!(overridden.price_sources.len(), 1);
    assert!(overridden.price_sources[0].contains("Manual fixture rate"));

    // The published fallback still applies to models absent from the cache.
    store_events(&db, "codex", "fallback", None, vec![
        event("call-astra", Some("gpt-6-astra"), FIXTURE_DAY + 4000, (100, 10, Some(0), Some(0)), false),
    ]);
    let fallback = usage_report(&db, &HistoryFilter { model: Some("gpt-6-astra".into()), ..Default::default() }).unwrap();
    assert!(fallback.price_sources.iter().any(|source| source.contains("OpenAI 公开价")));
}

#[test]
fn codex_prefers_per_response_records_and_reads_past_old_row_limits() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("rollout-records.jsonl");
    let mut text = String::from(
        "{\"timestamp\":\"2026-09-29T08:00:00Z\",\"ordinal\":1,\"type\":\"session_meta\",\"payload\":{\"id\":\"66666666-6666-4666-8666-666666666666\",\"cwd\":\"/fixture\"}}\n\
         {\"timestamp\":\"2026-09-29T08:00:01Z\",\"ordinal\":2,\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-6-astra\"}}\n\
         {\"timestamp\":\"2026-09-29T08:00:02Z\",\"ordinal\":3,\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"Ship it\"}]}}\n",
    );
    let filler = format!(
        "{{\"timestamp\":\"2026-09-29T08:00:03Z\",\"ordinal\":4,\"type\":\"response_item\",\"payload\":{{\"type\":\"custom_tool_call_output\",\"output\":\"{}\"}}}}\n",
        "x".repeat(600)
    );
    for _ in 0..31_000 {
        text.push_str(&filler);
    }
    text.push_str(&format!("{{\"timestamp\":\"2026-09-29T08:00:04Z\",\"ordinal\":5,\"type\":\"compacted\",\"payload\":{{\"message\":\"{}\"}}}}\n", "y".repeat(5000)));
    for (ordinal, response) in [(6, "resp-1"), (8, "resp-1"), (10, "resp-2")] {
        text.push_str(&format!(
            "{{\"timestamp\":\"2026-09-30T09:00:0{}Z\",\"ordinal\":{ordinal},\"type\":\"token_usage_record\",\"payload\":{{\"response_id\":\"{response}\",\"usage\":{{\"input_tokens\":100,\"cached_input_tokens\":80,\"cache_write_input_tokens\":0,\"output_tokens\":5}}}}}}\n",
            ordinal % 10
        ));
        text.push_str("{\"timestamp\":\"2026-09-30T09:00:09Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"last_token_usage\":{\"input_tokens\":100,\"cached_input_tokens\":80,\"output_tokens\":5},\"total_token_usage\":{\"input_tokens\":500,\"cached_input_tokens\":80,\"output_tokens\":5}}}}\n");
    }
    fs::write(&path, text).unwrap();
    assert!(fs::metadata(&path).unwrap().len() > 16 * 1024 * 1024);
    let session = codex::parse(&HistorySource { native_title: None, path, native_id: None, fingerprint: "fixture".into(), fingerprint_error: None }).unwrap();
    assert_eq!(session.usage.len(), 2, "records replace token_count and repeat ids collapse");
    assert!(session.usage.iter().all(|item| item.id.starts_with("codex:response:")));
    assert_eq!(session.usage.iter().map(|item| item.input.unwrap()).sum::<u64>(), 200);
    assert_eq!(session.usage.iter().map(|item| item.cache_read.unwrap()).sum::<u64>(), 160);
    assert_eq!(session.messages.len(), 1);
    assert!(!session.partial);
}

#[test]
fn pi_usage_ids_are_unique_per_file() {
    let temp = tempfile::tempdir().unwrap();
    let mut ids = HashSet::new();
    for name in ["a.jsonl", "b.jsonl"] {
        let path = temp.path().join(name);
        fs::copy(fixtures().join("pi-0.87-v3.jsonl"), &path).unwrap();
        let session = pi::parse(&HistorySource { native_title: None, path, native_id: None, fingerprint: "fixture".into(), fingerprint_error: None }).unwrap();
        for item in session.usage {
            assert!(ids.insert(item.id), "Pi row ids repeat across files and must not be merged");
        }
    }
    assert_eq!(ids.len(), 4);
}

#[test]
fn clean_files_without_content_are_skipped_not_failed() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let root = home.join(".claude/projects/demo");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("summary-only.jsonl"), "{\"type\":\"summary\",\"summary\":\"Earlier work\"}\n").unwrap();
    fs::copy(fixtures().join("claude-2.1.jsonl"), root.join("22222222-2222-4222-8222-222222222222.jsonl")).unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let registry = Registry::with_adapters(vec![&crate::adapters::CLAUDE]).unwrap();
    let reports = refresh(&db, &registry, &home).unwrap();
    assert_eq!((reports[0].source_count, reports[0].failed_count, reports[0].incomplete), (2, 0, false));
    assert_eq!(list(&db, &HistoryFilter::default()).unwrap().len(), 1);
}

#[test]
fn exports_are_separate_read_only_files_and_resume_arguments_are_native() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let root = home.join(".codex/sessions");
    fs::create_dir_all(&root).unwrap();
    let source = root.join("rollout-export.jsonl");
    fs::copy(fixtures().join("codex-0.158.jsonl"), &source).unwrap();
    let second = root.join("rollout-other.jsonl");
    fs::copy(fixtures().join("codex-0.158.jsonl"), &second).unwrap();
    let unindexed = root.join("other-native-file.jsonl");
    fs::write(&unindexed, "existing original\n").unwrap();
    let unrelated = temp.path().join("notes.txt");
    fs::write(&unrelated, "keep me\n").unwrap();
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
    assert!(export(&db, &id, "json", &second).is_err());
    assert_eq!(fs::read(&second).unwrap(), original);
    assert!(export(&db, &id, "json", &unindexed).is_err());
    assert_eq!(
        fs::read_to_string(&unindexed).unwrap(),
        "existing original\n"
    );
    assert!(export(&db, &id, "json", &unrelated).is_err());
    assert_eq!(fs::read_to_string(&unrelated).unwrap(), "keep me\n");
    assert!(export(&db, &id, "json", &temp.path().join("session.md")).is_err());

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
        (
            "open_code",
            "2.0.29",
            vec!["--standalone", "--session", "session_123"],
            Some("--auto"),
        ),
    ];
    for (tool, version, ordinary, yolo) in cases {
        assert_eq!(
            crate::adapters::plan_launch(
                &all,
                tool,
                version,
                Some("session_123"),
                false,
                LaunchMode::Normal
            )
            .unwrap(),
            ordinary
        );
        match yolo {
            Some(flag) => assert!(crate::adapters::plan_launch(
                &all,
                tool,
                version,
                Some("session_123"),
                false,
                LaunchMode::Yolo
            )
            .unwrap()
            .contains(&flag.to_owned())),
            None => assert!(crate::adapters::plan_launch(
                &all,
                tool,
                version,
                Some("session_123"),
                false,
                LaunchMode::Yolo
            )
            .is_err()),
        }
    }
    let open_code = all.get("open_code").unwrap();
    assert!(open_code.history_resume_version_supported("1.18.33"));
    assert!(open_code.history_resume_version_supported("2.0.0"));
    assert!(open_code.history_resume_version_supported("2.0.29"));
    assert!(!open_code.history_resume_version_supported("3.0.0"));
    assert!(!open_code.history_resume_version_supported(""));
}

#[test]
fn opencode_v2_storage_lists_parses_usage_and_variant_model() {
    // Column and row shapes verified against a real @opencode/cli 2.0.29
    // database (session_v2 + session_message, model with `variant`, tokens
    // with input excluding cache and output excluding reasoning).
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join(".local/share/opencode");
    fs::create_dir_all(&root).unwrap();
    let db = rusqlite::Connection::open(root.join("opencode.db")).unwrap();
    db.execute_batch(
        "CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, title TEXT, version TEXT, model TEXT, time_created INTEGER, time_updated INTEGER);
        CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, data TEXT, time_created INTEGER, time_updated INTEGER);
        INSERT INTO session_v2 VALUES ('ses_v2_fixture','C:/verify/project','T8 verify session','2.0.29','{\"id\":\"my-model\",\"providerID\":\"mock\",\"variant\":\"reasoning\"}',1792026275706,1792026341382);
        INSERT INTO session_message VALUES ('msg_v2_u1','ses_v2_fixture','user',5,'{\"time\":{\"created\":1792026275826},\"text\":\"say hi\",\"files\":[]}',1792026275826,1792026275826);
        INSERT INTO session_message VALUES ('msg_v2_a1','ses_v2_fixture','assistant',6,'{\"time\":{\"created\":1792026275849},\"model\":{\"id\":\"my-model\",\"providerID\":\"mock\",\"variant\":\"reasoning\"},\"content\":[{\"type\":\"reasoning\",\"text\":\"thinking\"},{\"type\":\"text\",\"text\":\"Hello from mock model.\"}],\"finish\":\"stop\",\"tokens\":{\"input\":32,\"output\":12,\"reasoning\":5,\"cache\":{\"read\":10,\"write\":0}}}',1792026275849,1792026275887);
        INSERT INTO session_message VALUES ('msg_v2_i1','ses_v2_fixture','idle',13,'{\"time\":{\"created\":1792026275890},\"outcome\":\"succeeded\"}',1792026275890,1792026275890);
        INSERT INTO session_message VALUES ('msg_v2_bad','ses_v2_fixture','assistant',14,'{not json}',1792026275900,1792026275900);",
    )
    .unwrap();
    drop(db);
    let sources = opencode::sources(temp.path()).unwrap();
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0].native_id.as_deref(), Some("ses_v2_fixture"));
    assert_eq!(sources[0].fingerprint, "opencode-session-v3|v2|1792026341382");
    let session = opencode::parse(&sources[0]).unwrap();
    assert_eq!(session.title, "T8 verify session");
    assert_eq!(session.cwd.as_deref(), Some("C:/verify/project"));
    assert_eq!(session.started_at, Some(1792026275706));
    assert_eq!(session.updated_at, Some(1792026341382));
    assert_eq!(
        session.model.as_deref(),
        Some("my-model#reasoning"),
        "the #variant reference is displayed as stored"
    );
    assert_eq!(session.messages.len(), 2);
    assert_eq!(session.messages[0].role, "user");
    assert_eq!(session.messages[0].text, "say hi");
    assert_eq!(session.messages[0].timestamp, Some(1792026275826));
    assert_eq!(session.messages[1].role, "assistant");
    assert_eq!(session.messages[1].text, "Hello from mock model.");
    assert_eq!(session.messages[1].timestamp, Some(1792026275849));
    assert_eq!(session.usage.len(), 1);
    assert_eq!(
        session.usage[0].model.as_deref(),
        Some("my-model#reasoning")
    );
    assert_eq!(session.usage[0].input, Some(32));
    assert_eq!(
        session.usage[0].output,
        Some(17),
        "output keeps the 1.x accounting: generated output includes reasoning"
    );
    assert_eq!(session.usage[0].cache_read, Some(10));
    assert_eq!(session.usage[0].cache_write, Some(0));
    assert!(!session.usage[0].input_includes_cache);
    assert_eq!(session.usage[0].request_count, Some(1));
    assert!(session.partial, "one unparsable message marks the session partial without failing it");
}

#[test]
fn opencode_unknown_storage_reports_unverified_and_single_session_failure_is_isolated() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join(".local/share/opencode");
    fs::create_dir_all(&root).unwrap();
    let db = rusqlite::Connection::open(root.join("opencode.db")).unwrap();
    db.execute_batch("CREATE TABLE kv (key TEXT, value TEXT);")
        .unwrap();
    drop(db);
    let error = opencode::sources(temp.path()).unwrap_err();
    assert!(error.contains("版本尚未验证"), "unexpected error: {error}");

    // An unverified v2 record version fails its own session only.
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join(".local/share/opencode");
    fs::create_dir_all(&root).unwrap();
    let db = rusqlite::Connection::open(root.join("opencode.db")).unwrap();
    db.execute_batch(
        "CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, title TEXT, version TEXT, model TEXT, time_created INTEGER, time_updated INTEGER);
        CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, data TEXT, time_created INTEGER, time_updated INTEGER);
        INSERT INTO session_v2 VALUES ('ses_v2_unknown','C:/verify/project','Future session','3.1.0',NULL,1792026275706,1792026341382);
        INSERT INTO session_v2 VALUES ('ses_v2_known','C:/verify/project','Known session','2.0.29',NULL,1792026275707,1792026341383);",
    )
    .unwrap();
    drop(db);
    let sources = opencode::sources(temp.path()).unwrap();
    assert_eq!(sources.len(), 2);
    let mut results = Vec::new();
    for source in &sources {
        results.push((source.native_id.clone(), opencode::parse(source).is_ok()));
    }
    assert!(results.contains(&(Some("ses_v2_unknown".into()), false)));
    assert!(results.contains(&(Some("ses_v2_known".into()), true)));
    let unknown = sources
        .iter()
        .find(|source| source.native_id.as_deref() == Some("ses_v2_unknown"))
        .unwrap();
    assert!(opencode::parse(unknown)
        .unwrap_err()
        .contains("版本尚未验证"));
}

#[test]
fn opencode_migrated_database_lists_both_generations() {
    // During an in-place 1.x → 2.x migration window both index tables can hold
    // rows; each row parses through its own generation branch.
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join(".local/share/opencode");
    fs::create_dir_all(&root).unwrap();
    let db = rusqlite::Connection::open(root.join("opencode.db")).unwrap();
    db.execute_batch(
        "CREATE TABLE session (id TEXT, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER, version TEXT, model TEXT);
        CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, time_created INTEGER);
        CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, data TEXT, time_created INTEGER);
        CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, title TEXT, version TEXT, model TEXT, time_created INTEGER, time_updated INTEGER);
        CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, data TEXT, time_created INTEGER, time_updated INTEGER);
        INSERT INTO session VALUES ('ses_v1_left','Old session','/old/project',1790668800000,1790668860000,'1.18.33',NULL);
        INSERT INTO session_v2 VALUES ('ses_v2_new','C:/new/project','New session','2.0.29',NULL,1792026275706,1792026341382);
        INSERT INTO session_message VALUES ('msg_mixed','ses_v2_new','user',5,'{\"time\":{\"created\":1792026275826},\"text\":\"v2 hello\"}',1792026275826,1792026275826);",
    )
    .unwrap();
    drop(db);
    let sources = opencode::sources(temp.path()).unwrap();
    assert_eq!(sources.len(), 2);
    for source in &sources {
        let session = opencode::parse(source).unwrap();
        match source.native_id.as_deref() {
            Some("ses_v1_left") => assert_eq!(session.title, "Old session"),
            Some("ses_v2_new") => {
                assert_eq!(session.title, "New session");
                assert_eq!(session.messages[0].text, "v2 hello");
            }
            other => panic!("unexpected session {other:?}"),
        }
    }
}

#[test]
fn opencode_migrated_v1_rows_are_deduplicated_and_long_usage_is_complete() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join(".local/share/opencode");
    fs::create_dir_all(&root).unwrap();
    let mut native_db = rusqlite::Connection::open(root.join("opencode.db")).unwrap();
    native_db.execute_batch(
        "CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER, version TEXT, model TEXT);
         CREATE TABLE session_v2 (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER, version TEXT, model TEXT);
         CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, data TEXT, time_created INTEGER);
         CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER);
         INSERT INTO session VALUES ('migrated', 'old', '/project', 1000, 2000, '1.18.33', NULL);"
    ).unwrap();
    let old = opencode::sources(temp.path()).unwrap();
    native_db.execute_batch("INSERT INTO session_v2 SELECT * FROM session").unwrap();
    let transaction = native_db.transaction().unwrap();
    for index in 0..4002 {
        transaction.execute("INSERT INTO session_message VALUES (?1, 'migrated', 'assistant', ?2, ?3, 2000)",
            params![format!("msg-{index}"), index, r#"{"model":{"id":"example"},"tokens":{"input":10,"output":2,"reasoning":1,"cache":{"read":4,"write":0}},"content":[{"type":"text","text":"ok"}]}"#]).unwrap();
    }
    transaction.commit().unwrap();
    for id in ["msg-0", "legacy-only"] {
        native_db.execute("INSERT INTO message VALUES (?1, 'migrated', ?2, 1500)", params![id,
            r#"{"role":"assistant","modelID":"example","tokens":{"input":11,"output":2,"reasoning":1,"cache":{"read":4,"write":1}}}"#]).unwrap();
    }
    let sources = opencode::sources(temp.path()).unwrap();
    assert_eq!(sources.len(), 1);
    assert_ne!(sources[0].fingerprint, old[0].fingerprint, "migration must invalidate an unchanged timestamp");
    let parsed = opencode::parse(&sources[0]).unwrap();
    assert_eq!(parsed.usage.len(), 4003, "keep every billed call including unmigrated usage, without duplicating converted messages");
    assert_eq!(parsed.usage.iter().filter(|event| event.id == "msg-0").count(), 1);
    let db = Database::open(&temp.path().join("index.db")).unwrap();
    db.with_connection(|conn| {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        store_session(&tx, "open_code", &sources[0], &parsed, &HashMap::new())?;
        tx.commit().map_err(|e| e.to_string())
    }).unwrap();
    let report = usage_report(&db, &HistoryFilter::default()).unwrap();
    assert_eq!(report.totals.total, 4002 * 17 + 19);
    assert_eq!(report.totals.requests, 4003);
    native_db.execute("UPDATE session SET time_updated=3000 WHERE id='migrated'", []).unwrap();
    assert_ne!(opencode::sources(temp.path()).unwrap()[0].fingerprint, sources[0].fingerprint,
        "legacy usage changes must invalidate the merged source");
    native_db.execute_batch(
        "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2502)
         INSERT INTO session SELECT 'copied-'||x, 'old', '/project', 1000, 2000, '1.18.33', NULL FROM n;
         INSERT INTO session_v2 SELECT * FROM session WHERE id <> 'migrated';"
    ).unwrap();
    assert_eq!(opencode::sources(temp.path()).unwrap().len(), 2503, "overlapping migration catalogs must not be truncated to half the limit");
    native_db.execute("UPDATE session_v2 SET time_updated=NULL WHERE id='migrated'", []).unwrap();
    let unknown_stamp = opencode::sources(temp.path()).unwrap().into_iter().find(|s| s.native_id.as_deref()==Some("migrated")).unwrap();
    assert_eq!(unknown_stamp.fingerprint, "0", "unknown revisions must always be reread");
}

#[cfg(windows)]
#[test]
fn copied_and_direct_resume_use_original_directory_after_project_relink() {
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
        original_dir.display()
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
    assert!(next.contains(&format!("'{}'", original_dir.display())));
    assert!(next.contains("'--yolo'"));
    assert!(!next.contains(&format!("'{}'", relinked_dir.display())));
    let direct = crate::launch::plan(&db, &registry, &home, crate::launch::LaunchRequest {
        tool_id: "grok".into(), project_id: None, session_id: Some("44444444-4444-4444-8444-444444444444".into()), directory: Some(relinked_dir.display().to_string()), initial_prompt: None, mode: LaunchMode::Normal, resume_latest: false,
    }).unwrap();
    assert_eq!(direct.directory, original_dir.canonicalize().unwrap());
}

#[test]
fn registered_string_tools_join_the_managed_history_scan() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("app.db")).unwrap();
    let registry = Registry::builtins();
    let reports = refresh_controlled(&db, &registry, temp.path(), &["kimi_code".to_string()], &|| false).unwrap();
    let tools: Vec<&str> = reports.iter().map(|report| report.tool_id.as_str()).collect();
    assert!(tools.contains(&"kimi_code"));
    assert!(!tools.contains(&"codex"));
    assert!(!tools.contains(&"qoder"));
    let scanned = scans(&db).unwrap();
    assert!(scanned.iter().any(|status| status.tool_id == "kimi_code"));
}

#[test]
fn concurrent_discovery_keeps_tool_failures_isolated_and_cancellation_preserves_index() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("app.db")).unwrap();
    for (directory, file_name, fixture) in [
        (".codex/sessions", "rollout-fixture.jsonl", "codex-0.158.jsonl"),
        (".pi/agent/sessions", "fixture.jsonl", "pi-0.87-v3.jsonl"),
    ] {
        let root = temp.path().join(directory);
        fs::create_dir_all(&root).unwrap();
        fs::copy(fixtures().join(fixture), root.join(file_name)).unwrap();
    }
    fs::create_dir_all(temp.path().join(".claude")).unwrap();
    fs::write(temp.path().join(".claude/projects"), "not a directory").unwrap();
    let registry = Registry::with_adapters(vec![&CODEX, &crate::adapters::CLAUDE, &crate::adapters::PI]).unwrap();
    let managed = vec!["codex".into(), "claude_code".into(), "pi".into()];
    let reports = refresh_controlled(&db, &registry, temp.path(), &managed, &|| false).unwrap();
    assert_eq!(reports.iter().map(|report| report.tool_id.as_str()).collect::<Vec<_>>(), ["codex", "claude_code", "pi"]);
    assert!(!reports[0].incomplete && reports[1].incomplete && !reports[2].incomplete);
    let before = list(&db, &HistoryFilter::default()).unwrap();
    assert_eq!(before.len(), 2);
    fs::remove_file(temp.path().join(".codex/sessions/rollout-fixture.jsonl")).unwrap();
    let checks = AtomicUsize::new(0);
    assert!(refresh_controlled(&db, &registry, temp.path(), &managed, &|| checks.fetch_add(1, Ordering::SeqCst) > 2).is_err());
    let after = list(&db, &HistoryFilter::default()).unwrap();
    assert_eq!(before.iter().map(|session| &session.id).collect::<Vec<_>>(), after.iter().map(|session| &session.id).collect::<Vec<_>>());
    assert!(after.iter().all(|session| !session.stale));
}

#[test]
fn native_titles_override_first_prompt_and_title_edits_invalidate_only_the_matching_source() {
    let home = tempfile::tempdir().unwrap();
    let root = home.path().join(".codex");
    std::fs::create_dir_all(root.join("sessions")).unwrap();
    let id = "11111111-2222-4333-8444-555555555555";
    let log = format!("{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{id}\"}}}}\n{{\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"user\",\"content\":[{{\"type\":\"input_text\",\"text\":\"first prompt\"}}]}}}}\n");
    std::fs::write(root.join("sessions").join(format!("rollout-2026-10-04-{id}.jsonl")), log).unwrap();
    let other_id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    std::fs::write(root.join("sessions").join(format!("rollout-2026-10-04-{other_id}.jsonl")), "{\"type\":\"session_meta\",\"payload\":{\"id\":\"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\"}}\n").unwrap();
    let find = |needle: &str| codex::sources(home.path()).unwrap().into_iter().find(|source| source.path.to_string_lossy().contains(needle)).unwrap();
    let other = find(other_id);
    let index = root.join("session_index.jsonl");
    let write_title = |title: &str| std::fs::write(&index, serde_json::json!({"id":id,"thread_name":title,"updated_at":"2026-10-04T00:00:00Z"}).to_string()).unwrap();
    write_title("Native generated title");
    let first = find(id);
    assert_eq!(codex::parse(&first).unwrap().title, "Native generated title");
    write_title("Renamed in CLI");
    let updated = find(id);
    assert_ne!(first.fingerprint, updated.fingerprint);
    assert_eq!(other.fingerprint, find(other_id).fingerprint);
    assert_eq!(codex::parse(&updated).unwrap().title, "Renamed in CLI");
    std::fs::write(&index, "invalid row\n").unwrap();
    let db = rusqlite::Connection::open(root.join("state_5.sqlite")).unwrap();
    db.execute_batch("CREATE TABLE threads (id TEXT, title TEXT)").unwrap();
    db.execute("INSERT INTO threads VALUES (?1, 'Database title')", [id]).unwrap();
    assert_eq!(codex::parse(&find(id)).unwrap().title, "Database title");
    for (tool, text, expected) in [
        ("claude", r#"{"type":"user","message":{"content":"first prompt"}}
{"type":"ai-title","aiTitle":"Generated Claude title"}
"#, "Generated Claude title"),
        ("pi", r#"{"type":"session","id":"native","version":3}
{"type":"message","id":"u","message":{"role":"user","content":"first prompt"}}
{"type":"session_info","name":"Native Pi title"}
"#, "Native Pi title"),
    ] {
        let path = home.path().join(format!("{tool}.jsonl"));
        std::fs::write(&path, text).unwrap();
        let source = HistorySource { native_title: None, path, native_id: None, fingerprint: String::new(), fingerprint_error: None };
        let parsed = if tool == "claude" { claude::parse(&source) } else { pi::parse(&source) }.unwrap();
        assert_eq!(parsed.title, expected);
    }
}

fn grok_fixture(dir: &Path, data: serde_json::Value) -> HistorySource {
    fs::create_dir_all(dir).unwrap();
    fs::write(dir.join("summary.json"), r#"{"info":{"id":"accuracy-fixture"},"current_model_id":"current-model","updated_at":"2026-09-30T00:00:00Z"}"#).unwrap();
    fs::write(dir.join("chat_history.jsonl"), "{\"type\":\"user\",\"content\":\"Fixture question\"}\n").unwrap();
    fs::write(dir.join("usage.json"), data.to_string()).unwrap();
    HistorySource { native_title: None, path: dir.into(), native_id: None, fingerprint: "fixture".into(), fingerprint_error: None }
}

#[test]
fn grok_calls_reconcile_missing_details_duplicates_and_unknown_dates() {
    let temp = tempfile::tempdir().unwrap();
    let model = serde_json::json!({"inputTokens":100,"outputTokens":20,"cachedReadTokens":40,"cacheCreationTokens":10,"reasoningTokens":15,"modelCalls":5});
    let turn = serde_json::json!({"turnNumber":4,"endedAt":"2026-09-29T08:00:00Z","inputTokens":120,"outputTokens":30,"cachedReadTokens":40,"cacheCreationTokens":10,"modelCalls":7,"modelUsage":{"model-a":model,"broken":{"inputTokens":"invalid"}}});
    let source = grok_fixture(temp.path(), serde_json::json!({
        "session":{"inputTokens":150,"outputTokens":40,"cachedReadTokens":40,"cacheCreationTokens":10,"modelCalls":10},
        "turns":[turn.clone(),turn]
    }));
    let parsed = grok::parse(&source).unwrap();
    assert!(parsed.partial);
    assert_eq!(parsed.usage.len(), 3);
    assert_eq!(parsed.usage.iter().filter_map(|item| item.request_count).sum::<u64>(), 10);
    assert!(parsed.usage.iter().any(|item| item.model.is_none() && item.timestamp.is_none()));
    let db = Database::open(&temp.path().join("index.db")).unwrap();
    db.with_connection(|conn| store_session(conn, "grok", &source, &parsed, &HashMap::new())).unwrap();
    let all = usage_report(&db, &HistoryFilter::default()).unwrap();
    assert_eq!((all.totals.input, all.totals.cache_read, all.totals.cache_write, all.totals.output, all.totals.total), (100,40,10,40,190));
    assert_eq!((all.totals.requests, all.totals.usage_records, all.totals.unknown_request_records), (10,3,0));
    assert_eq!(all.by_model.iter().map(|group| group.totals.total).sum::<u64>(), 190);
    assert!(all.by_model.iter().any(|group| group.model.is_none()));
    assert!(!all.models.contains(&"current-model".into()));
    let id = stable_id("grok", &source.key());
    assert_eq!(detail(&db, &id).unwrap().totals, all.totals);
    let day = usage_report(&db, &HistoryFilter { from_ms: Some(FIXTURE_DAY), to_ms: Some(FIXTURE_DAY + DAY), ..Default::default() }).unwrap();
    assert_eq!((day.totals.total, day.totals.requests, day.untimed_requests), (150,7,1));
    assert_eq!(day.timeline.iter().map(|bucket| bucket.totals.total).sum::<u64>(), 150);
}

#[test]
fn grok_unknown_calls_recover_only_unambiguous_native_subtotals() {
    let temp = tempfile::tempdir().unwrap();
    let source = grok_fixture(temp.path(), serde_json::json!({"session":{"inputTokens":50,"outputTokens":10,"modelCalls":8,"modelUsage":{"a":{"inputTokens":50,"outputTokens":10}}}}));
    let parsed = grok::parse(&source).unwrap();
    assert_eq!(parsed.usage[0].request_count, Some(8));
    assert_eq!(parsed.usage[0].timestamp, None);
    let source = grok_fixture(temp.path(), serde_json::json!({"session":{"inputTokens":50,"outputTokens":10,"modelUsage":{"a":{"inputTokens":50,"outputTokens":10}}}}));
    let parsed = grok::parse(&source).unwrap();
    assert_eq!(parsed.usage[0].request_count, None);
    let db = Database::open(&temp.path().join("index.db")).unwrap();
    db.with_connection(|conn| store_session(conn, "grok", &source, &parsed, &HashMap::new())).unwrap();
    let report = usage_report(&db, &HistoryFilter::default()).unwrap();
    assert_eq!((report.totals.total,report.totals.requests,report.totals.unknown_request_records), (60,0,1));
    // Contradictory parent counters cannot subtract valid detail or claim completeness.
    let source = grok_fixture(temp.path(), serde_json::json!({"session":{"inputTokens":10,"outputTokens":1,"modelUsage":{"a":{"inputTokens":50,"outputTokens":10}}}}));
    let parsed = grok::parse(&source).unwrap();
    assert!(parsed.partial);
    assert_eq!(parsed.usage.len(), 1);
    assert_eq!(parsed.usage[0].input, Some(50));
    let source = grok_fixture(temp.path(), serde_json::json!({"session":{"inputTokens":"bad","outputTokens":10,"modelUsage":{"a":{"inputTokens":50,"outputTokens":10}}}}));
    assert!(grok::parse(&source).unwrap().partial);
}

#[test]
fn grok_explicit_prompt_indices_survive_compaction_and_bad_events() {
    let temp = tempfile::tempdir().unwrap();
    let source = grok_fixture(temp.path(), serde_json::json!({}));
    fs::write(temp.path().join("chat_history.jsonl"), [
        r#"{"type":"user","synthetic_reason":"compaction","prompt_index":4,"content":"context"}"#,
        r#"{"type":"user","prompt_index":4,"content":"question"}"#,
        r#"{"type":"assistant","prompt_index":4,"content":"answer"}"#,
        r#"{"type":"user","prompt_index":9,"content":"missing turn"}"#,
        r#"{"type":"assistant","content":"unknown answer"}"#,
        r#"{"type":"assistant","prompt_index":4,"timestamp":"2026-09-29T10:00:00Z","content":"native clock"}"#,
    ].join("\n")).unwrap();
    fs::write(temp.path().join("events.jsonl"), [
        r#"{"type":"turn_started","turn_number":0,"ts":"2026-09-29T08:00:00Z"}"#,
        r#"{"type":"turn_started","turn_number":4,"ts":"2026-09-29T09:00:00Z"}"#,
        r#"{"type":"turn_started","turn_number":4,"ts":"2026-09-29T09:00:00Z"}"#,
        "broken row",
    ].join("\n")).unwrap();
    let parsed = grok::parse(&source).unwrap();
    assert!(parsed.partial);
    assert_eq!(parsed.messages[0].timestamp, None);
    assert_eq!(parsed.messages[1].timestamp, Some(FIXTURE_DAY + 3_600_000));
    assert_eq!(parsed.messages[2].timestamp_source, MessageTimeSource::Turn);
    assert_eq!(parsed.messages[3].timestamp, None);
    assert_eq!(parsed.messages[4].timestamp, None);
    assert_eq!(parsed.messages[5].timestamp_source, MessageTimeSource::Native);
}

#[test]
fn report_search_favorites_catalog_previous_and_untimed_share_filters() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("index.db")).unwrap();
    let mut untimed = event("untimed", Some("included"), 0, (5,1,None,None), false);
    untimed.timestamp = None;
    let id = store_events(&db, "grok", "100%_literal", None, vec![
        event("today", Some("included"), FIXTURE_DAY + 1000, (10,2,None,None), false),
        event("yesterday", Some("included"), FIXTURE_DAY - DAY + 1000, (3,1,None,None), false), untimed,
    ]);
    set_favorite(&db, &id, true).unwrap();
    store_events(&db, "grok", "100XXliteral", None, vec![event("excluded", Some("excluded"), FIXTURE_DAY + 1000, (999,999,None,None), false)]);
    let filter = HistoryFilter { search: Some("100%_".into()), favorite_only: true, from_ms: Some(FIXTURE_DAY), to_ms: Some(FIXTURE_DAY+DAY), ..Default::default() };
    assert_eq!(list(&db, &filter).unwrap().len(), 1);
    let report = usage_report(&db, &filter).unwrap();
    assert_eq!(report.totals.total, 12);
    assert_eq!(report.previous.unwrap().totals.total, 4);
    assert_eq!(report.untimed_requests, 1);
    assert_eq!(report.models, vec!["included"]);
    set_favorite(&db, &id, false).unwrap();
    assert_eq!(usage_report(&db, &filter).unwrap().totals.total, 0);
}

#[test]
fn v17_history_upgrade_rereads_unchanged_sources_and_preserves_associations() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join(".grok/sessions/project/session");
    fs::create_dir_all(&root).unwrap();
    for name in ["summary.json", "chat_history.jsonl", "usage.json"] {
        fs::copy(fixtures().join("grok-1.0").join(name), root.join(name)).unwrap();
    }
    let db_path = temp.path().join("index.db");
    let db = Database::open(&db_path).unwrap();
    let registry = Registry::with_adapters(vec![&GROK]).unwrap();
    refresh(&db, &registry, temp.path()).unwrap();
    let id = list(&db, &HistoryFilter::default()).unwrap()[0].id.clone();
    set_favorite(&db, &id, true).unwrap();
    db.with_connection(|conn| {
        conn.execute_batch("ALTER TABLE history_usage DROP COLUMN request_count;
            UPDATE history_sessions SET project_id='linked-project', usage_json='[]';
            PRAGMA user_version = 17;").map_err(|error| error.to_string())
    }).unwrap();
    drop(db);
    let db = Database::open(&db_path).unwrap();
    let old = detail(&db, &id).unwrap();
    assert_eq!(old.totals.requests, 0);
    assert_eq!(old.totals.unknown_request_records, 1);
    refresh(&db, &registry, temp.path()).unwrap();
    let restored = detail(&db, &id).unwrap();
    assert!(restored.session.favorite);
    assert_eq!(restored.session.project_id.as_deref(), Some("linked-project"));
    assert_eq!(restored.totals.requests, 7);
    refresh(&db, &registry, temp.path()).unwrap();
    assert_eq!(detail(&db, &id).unwrap().totals, restored.totals);
}

#[test]
#[ignore = "manual read-only native Grok audit; temporary index and aggregate output only"]
fn grok_native_accuracy_audit() {
    let home = PathBuf::from(std::env::var_os("HOME").unwrap());
    let sources: Vec<_> = grok::sources(&home).unwrap().into_iter().filter(|source| source.path.join("usage.json").is_file()).collect();
    assert!(!sources.is_empty());
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("audit.db")).unwrap();
    let mut expected = [0u64; 5];
    for source in &sources {
        let data: serde_json::Value = serde_json::from_slice(&fs::read(source.path.join("usage.json")).unwrap()).unwrap();
        let total = &data["session"];
        for (slot, field) in expected.iter_mut().zip(["inputTokens","outputTokens","cachedReadTokens","cacheCreationTokens","modelCalls"]) {
            *slot += total[field].as_u64().unwrap();
        }
        let parsed = grok::parse(source).unwrap();
        db.with_connection(|conn| store_session(conn, "grok", source, &parsed, &HashMap::new())).unwrap();
    }
    let report = usage_report(&db, &HistoryFilter::default()).unwrap();
    assert_eq!([report.totals.input+report.totals.cache_read+report.totals.cache_write,report.totals.output,report.totals.cache_read,report.totals.cache_write,report.totals.requests], expected);
    assert_eq!(report.totals.unknown_request_records, 0);
    println!("Native read-only audit: sessions={} records={} requests={} input={} output={} cache_read={} cache_write={}", sources.len(), report.totals.usage_records, report.totals.requests, expected[0], expected[1], expected[2], expected[3]);
}

#[test]
fn grok_equal_snapshots_keep_known_model_calls_and_dates_in_either_order() {
    let temp = tempfile::tempdir().unwrap();
    let complete = serde_json::json!({
        "turnNumber":1,"endedAt":"2026-09-29T08:00:00Z","inputTokens":200,"outputTokens":20,"modelCalls":12,
        "modelUsage":{"a":{"inputTokens":100,"outputTokens":10,"modelCalls":5},"b":{"inputTokens":100,"outputTokens":10,"modelCalls":7}}
    });
    let incomplete = serde_json::json!({
        "turnNumber":1,"inputTokens":200,"outputTokens":20,"modelCalls":12,
        "modelUsage":{"a":{"inputTokens":100,"outputTokens":10},"b":{"inputTokens":100,"outputTokens":10}}
    });
    let total = serde_json::json!({"inputTokens":200,"outputTokens":20,"modelCalls":12});
    for turns in [[complete.clone(), incomplete.clone()], [incomplete.clone(), complete.clone()]] {
        let source = grok_fixture(temp.path(), serde_json::json!({"session":total,"turns":turns}));
        let parsed = grok::parse(&source).unwrap();
        assert!(!parsed.partial);
        assert_eq!(parsed.usage.len(), 2);
        assert_eq!(parsed.usage.iter().map(|event| event.request_count).collect::<Vec<_>>(), vec![Some(5), Some(7)]);
        assert!(parsed.usage.iter().all(|event| event.timestamp == Some(FIXTURE_DAY)));
        let db = Database::open(Path::new(":memory:")).unwrap();
        db.with_connection(|conn| store_session(conn, "grok", &source, &parsed, &HashMap::new())).unwrap();
        let report = usage_report(&db, &HistoryFilter { from_ms: Some(FIXTURE_DAY), to_ms: Some(FIXTURE_DAY+DAY), ..Default::default() }).unwrap();
        assert_eq!((report.totals.requests, report.totals.unknown_request_records, report.totals.total), (12,0,220));
        assert_eq!(report.untimed_requests, 0);
        assert_eq!(report.by_model.iter().map(|group| group.totals.requests).sum::<u64>(), 12);
        assert_eq!(detail(&db, &stable_id("grok", &source.key())).unwrap().totals, report.totals);
    }

    // Equal tokens with contradictory call counts or dates are not a reliable
    // terminal snapshot. Retain known evidence and make the conflict visible.
    for conflict_field in ["modelCalls", "endedAt"] {
        let mut conflict = complete.clone();
        if conflict_field == "modelCalls" {
            conflict["modelUsage"]["a"]["modelCalls"] = serde_json::json!(6);
            conflict["modelUsage"]["b"]["modelCalls"] = serde_json::json!(6);
        } else {
            conflict["endedAt"] = serde_json::json!("2026-09-30T08:00:00Z");
        }
        let source = grok_fixture(temp.path(), serde_json::json!({"session":total,"turns":[complete.clone(),conflict]}));
        let parsed = grok::parse(&source).unwrap();
        assert!(parsed.partial, "conflicting {conflict_field} must be visible");
        assert_eq!(parsed.usage.iter().map(|event| event.request_count).collect::<Vec<_>>(), vec![Some(5),Some(7)]);
        assert!(parsed.usage.iter().all(|event| event.timestamp == Some(FIXTURE_DAY)));
    }

    // A growing terminal snapshot still replaces earlier counts and timestamps.
    let mut growing = complete.clone();
    growing["endedAt"] = serde_json::json!("2026-09-30T08:00:00Z");
    growing["inputTokens"] = serde_json::json!(220);
    growing["outputTokens"] = serde_json::json!(22);
    growing["modelCalls"] = serde_json::json!(13);
    growing["modelUsage"]["a"] = serde_json::json!({"inputTokens":120,"outputTokens":12,"modelCalls":6});
    let source = grok_fixture(temp.path(), serde_json::json!({"session":{"inputTokens":220,"outputTokens":22,"modelCalls":13},"turns":[complete,growing]}));
    let parsed = grok::parse(&source).unwrap();
    assert!(!parsed.partial);
    assert_eq!(parsed.usage.iter().filter_map(|event| event.request_count).sum::<u64>(), 13);
    assert!(parsed.usage.iter().all(|event| event.timestamp == Some(FIXTURE_DAY+DAY)));
}

struct HistoryContractSecrets;

impl crate::credentials::CredentialStore for HistoryContractSecrets {
    fn put(&self, _id: &str, _secret: &str) -> Result<(), String> { Ok(()) }
    fn get(&self, _id: &str) -> Result<String, String> { Err("missing".into()) }
    fn delete(&self, _id: &str) -> Result<(), String> { Ok(()) }
}

fn transcript(id: &str, role: &str, text: &str) -> HistoryMessage {
    HistoryMessage {
        id: id.into(),
        role: role.into(),
        text: text.into(),
        timestamp: Some(FIXTURE_DAY),
        timestamp_source: MessageTimeSource::Native,
        kind: HistoryMessageKind::Conversation,
    }
}

#[test]
fn parent_detail_keeps_attribution_and_child_bodies_out_of_list_search_report_and_export() {
    use crate::adapters::qoder_cn::QODER_CN;
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("workspace");
    fs::create_dir_all(&project).unwrap();
    let db = Database::open(&temp.path().join("index.db")).unwrap();
    let native = "parent-native-1";
    let source = HistorySource {
        native_title: None,
        path: temp.path().join("parent-log.jsonl"),
        native_id: Some(native.into()),
        fingerprint: "fixture".into(),
        fingerprint_error: None,
    };
    let mut parsed = ParsedSession::new();
    parsed.native_id = Some(native.into());
    parsed.title = "父会话标题".into();
    parsed.cwd = Some(project.display().to_string());
    parsed.model = Some("parent-model".into());
    parsed.updated_at = Some(FIXTURE_DAY);
    parsed.messages.push(transcript("parent-msg", "user", "父会话正文可见"));
    parsed.usage.push(UsageEvent {
        native_usage: None,
        request_count: Some(1),
        id: "shared-call".into(),
        model: Some("parent-model".into()),
        timestamp: Some(FIXTURE_DAY),
        input: Some(3),
        output: Some(1),
        cache_read: None,
        cache_write: None,
        input_includes_cache: false,
        attributions: vec![
            UsageAttribution { kind: AgentKind::Main, name: None, session_key: None },
            UsageAttribution { kind: AgentKind::Subagent, name: Some("reviewer".into()), session_key: Some("child-review".into()) },
        ],
    });
    parsed.children = vec![
        ChildSession {
            key: "child-review".into(),
            name: Some("reviewer".into()),
            readable: true,
            messages: vec![transcript("child-msg", "assistant", "CHILD_ONLY_SENTINEL")],
            children: vec![ChildSession {
                key: "grandchild-node".into(),
                name: None,
                readable: true,
                messages: vec![transcript("grand-msg", "assistant", "GRANDCHILD_ONLY_SENTINEL")],
                children: Vec::new(),
            }],
        },
        ChildSession {
            key: "child-missing".into(),
            name: Some("   ".into()),
            readable: false,
            messages: vec![transcript("missing-msg", "assistant", "UNREADABLE_BODY_SENTINEL")],
            children: Vec::new(),
        },
    ];
    db.with_connection(|conn| store_session(conn, "qoder_cn", &source, &parsed, &HashMap::new())).unwrap();
    let id = stable_id("qoder_cn", &source.key());
    let saved = detail(&db, &id).unwrap();
    assert_eq!(saved.session.native_id.as_deref(), Some(native));
    assert_eq!(saved.session.message_count, 1);
    assert_eq!(saved.messages.len(), 1);
    assert_eq!(saved.messages[0].text, "父会话正文可见");
    assert!(saved.messages.iter().all(|message| !message.text.contains("SENTINEL")));
    assert_eq!(saved.usage.len(), 1);
    assert_eq!(saved.usage[0].attributions.len(), 2);
    assert_eq!(saved.usage[0].attributions[0].kind, AgentKind::Main);
    assert!(saved.usage[0].attributions[0].session_key.is_none());
    assert_eq!(saved.usage[0].attributions[1].kind, AgentKind::Subagent);
    assert_eq!(saved.usage[0].attributions[1].name.as_deref(), Some("reviewer"));
    assert_eq!(saved.usage[0].attributions[1].session_key.as_deref(), Some("child-review"));
    assert_eq!(saved.children.len(), 2);
    assert_eq!(saved.children[0].name.as_deref(), Some("reviewer"));
    assert_eq!(saved.children[0].messages[0].text, "CHILD_ONLY_SENTINEL");
    assert_eq!(saved.children[0].children[0].key, "grandchild-node");
    assert!(saved.children[0].children[0].name.is_none());
    assert_eq!(saved.children[0].children[0].messages[0].text, "GRANDCHILD_ONLY_SENTINEL");
    assert!(!saved.children[1].readable);
    assert!(saved.children[1].messages.is_empty());
    assert!(saved.children[1].name.is_none());
    assert_ne!(saved.children[1].name.as_deref(), Some(saved.children[1].key.as_str()));
    let (sessions, usage_rows, messages_json, children_json): (i64, i64, String, String) = db.with_connection(|conn| {
        let sessions = conn.query_row("SELECT COUNT(*) FROM history_sessions", [], |row| row.get(0)).map_err(|error| error.to_string())?;
        let usage_rows = conn.query_row("SELECT COUNT(*) FROM history_usage", [], |row| row.get(0)).map_err(|error| error.to_string())?;
        let messages_json = conn.query_row("SELECT messages_json FROM history_sessions WHERE id=?1", [&id], |row| row.get(0)).map_err(|error| error.to_string())?;
        let children_json = conn.query_row("SELECT children_json FROM history_sessions WHERE id=?1", [&id], |row| row.get(0)).map_err(|error| error.to_string())?;
        Ok((sessions, usage_rows, messages_json, children_json))
    }).unwrap();
    assert_eq!((sessions, usage_rows), (1, 1));
    assert!(!messages_json.contains("SENTINEL"));
    assert!(children_json.contains("CHILD_ONLY_SENTINEL"));
    assert!(children_json.contains("GRANDCHILD_ONLY_SENTINEL"));
    assert!(!children_json.contains("UNREADABLE_BODY_SENTINEL"));
    let listed = list(&db, &HistoryFilter::default()).unwrap();
    assert_eq!(listed.len(), 1);
    let limited = list(&db, &HistoryFilter { limit: Some(1), ..Default::default() }).unwrap();
    assert_eq!(limited.len(), 1);
    assert_eq!(listed[0].id, id);
    assert_eq!(listed[0].title, "父会话标题");
    for needle in ["CHILD_ONLY_SENTINEL", "GRANDCHILD_ONLY_SENTINEL", "UNREADABLE_BODY_SENTINEL", "reviewer"] {
        assert!(list(&db, &HistoryFilter { search: Some(needle.into()), ..Default::default() }).unwrap().is_empty(), "{needle}");
        let report = usage_report(&db, &HistoryFilter { search: Some(needle.into()), ..Default::default() }).unwrap();
        assert_eq!((report.totals.sessions, report.totals.usage_records, report.totals.requests), (0, 0, 0), "{needle}");
    }
    assert_eq!(list(&db, &HistoryFilter { search: Some("父会话正文可见".into()), ..Default::default() }).unwrap().len(), 1);
    set_favorite(&db, &id, true).unwrap();
    let favorites = list(&db, &HistoryFilter { favorite_only: true, ..Default::default() }).unwrap();
    assert_eq!(favorites.len(), 1);
    assert_eq!(favorites[0].id, id);
    assert!(list(&db, &HistoryFilter { favorite_only: true, search: Some("CHILD_ONLY_SENTINEL".into()), ..Default::default() }).unwrap().is_empty());
    let report = usage_report(&db, &HistoryFilter::default()).unwrap();
    assert_eq!((report.totals.sessions, report.totals.usage_records, report.totals.requests), (1, 1, 1));
    assert_eq!(report.top_sessions.len(), 1);
    assert_eq!(report.top_sessions[0].id, id);
    assert_eq!(report.top_sessions[0].title, "父会话标题");
    assert!(detail(&db, "child-review").is_err());
    let terminal = temp.path().join("fixture-terminal");
    fs::write(&terminal, "").unwrap();
    crate::launch::set_custom_terminal(&db, terminal.display().to_string(), vec!["{script}".into()]).unwrap();
    let registry = Registry::with_adapters(vec![&QODER_CN]).unwrap().with_fixture_installation("qoder_cn", "1.2.0");
    let command = copy_resume_command(&db, &registry, temp.path(), &id, LaunchMode::Normal).unwrap();
    assert!(command.contains(native), "{command}");
    assert!(!command.contains("child-review"), "{command}");
    assert!(!command.contains("grandchild-node"), "{command}");
    let json_path = temp.path().join("parent.json");
    export(&db, &id, "json", &json_path).unwrap();
    let json_text = fs::read_to_string(&json_path).unwrap();
    let json: Value = serde_json::from_str(&json_text).unwrap();
    assert!(json.get("children").is_none());
    assert!(!json_text.contains("SENTINEL"));
    assert_eq!(json["usage"][0]["attributions"][0]["kind"], "main");
    assert_eq!(json["usage"][0]["attributions"][1]["kind"], "subagent");
    assert_eq!(json["usage"][0]["attributions"][1]["name"], "reviewer");
    assert_eq!(json["usage"][0]["attributions"][1]["sessionKey"], "child-review");
    assert_eq!(json["session"]["nativeId"], native);
    let md_path = temp.path().join("parent.md");
    export(&db, &id, "markdown", &md_path).unwrap();
    let md = fs::read_to_string(&md_path).unwrap();
    assert!(md.contains("归属：主代理"));
    assert!(md.contains("归属：子代理：reviewer"));
    assert!(md.contains("父会话正文可见"));
    assert!(md.contains(native));
    assert!(!md.contains("SENTINEL"));
    assert!(!md.contains("child-review"));
    let snapshot = crate::portable::collect_snapshot(&db, &HistoryContractSecrets, &registry).unwrap();
    let encoded = serde_json::to_string(&snapshot).unwrap();
    assert!(!encoded.contains("SENTINEL"));
    assert!(!encoded.contains("reviewer"));
    assert!(!encoded.contains("child-review"));
    for entity in &snapshot.entities {
        assert!(matches!(entity.kind(), "preferences" | "profile" | "common" | "project" | "library" | "mcp" | "skill" | "account" | "binding"), "{}", entity.kind());
    }
    let (history_outbox, triggers): (i64, i64) = db.with_connection(|conn| {
        let history_outbox = conn.query_row("SELECT COUNT(*) FROM sync_outbox WHERE entity_key LIKE 'history%' OR object_json LIKE '%SENTINEL%'", [], |row| row.get(0)).map_err(|error| error.to_string())?;
        let triggers = conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('history_sessions','history_usage')", [], |row| row.get(0)).map_err(|error| error.to_string())?;
        Ok((history_outbox, triggers))
    }).unwrap();
    assert_eq!((history_outbox, triggers), (0, 0));
    let mut duplicated = parsed.clone();
    duplicated.children.push(duplicated.children[0].clone());
    let duplicate = db.with_connection(|conn| store_session(conn, "qoder_cn", &source, &duplicated, &HashMap::new())).unwrap_err();
    assert!(duplicate.contains("子会话内部键重复"), "{duplicate}");
    let mut blank = parsed.clone();
    blank.children[0].key = " ".into();
    let invalid = db.with_connection(|conn| store_session(conn, "qoder_cn", &source, &blank, &HashMap::new())).unwrap_err();
    assert!(invalid.contains("子会话内部键无效"), "{invalid}");
    assert_eq!(detail(&db, &id).unwrap().children.len(), 2);
}

#[test]
fn legacy_rows_without_association_fields_are_unknown_and_have_no_jump() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("legacy.db");
    let db = Database::open(&path).unwrap();
    let id = store_events(&db, "codex", "legacy-parent", Some("gpt-5"), vec![event("legacy-request", Some("gpt-5"), FIXTURE_DAY, (4, 1, None, None), false)]);
    db.with_connection(|conn| {
        let usage: String = conn.query_row("SELECT usage_json FROM history_sessions WHERE id=?1", [&id], |row| row.get(0)).map_err(|error| error.to_string())?;
        assert!(!usage.contains("attributions"), "{usage}");
        conn.execute_batch("ALTER TABLE history_sessions DROP COLUMN children_json; PRAGMA user_version = 23;").map_err(|error| error.to_string())?;
        Ok(())
    }).unwrap();
    drop(db);
    let db = Database::open(&path).unwrap();
    let saved = detail(&db, &id).unwrap();
    assert!(saved.children.is_empty());
    assert_eq!(saved.usage[0].attributions, vec![UsageAttribution { kind: AgentKind::Unknown, name: None, session_key: None }]);
    let (usage_rows, children_json): (i64, String) = db.with_connection(|conn| {
        let usage_rows = conn.query_row("SELECT COUNT(*) FROM history_usage WHERE session_id=?1", [&id], |row| row.get(0)).map_err(|error| error.to_string())?;
        let children_json = conn.query_row("SELECT children_json FROM history_sessions WHERE id=?1", [&id], |row| row.get(0)).map_err(|error| error.to_string())?;
        Ok((usage_rows, children_json))
    }).unwrap();
    assert_eq!(usage_rows, 1);
    assert_eq!(children_json, "[]");
    assert_eq!(list(&db, &HistoryFilter::default()).unwrap().len(), 1);
    let json_path = temp.path().join("legacy.json");
    export(&db, &id, "json", &json_path).unwrap();
    let json: Value = serde_json::from_str(&fs::read_to_string(&json_path).unwrap()).unwrap();
    assert!(json.get("children").is_none());
    assert_eq!(json["usage"][0]["attributions"][0]["kind"], "unknown");
    assert!(json["usage"][0]["attributions"][0].get("sessionKey").is_none());
    assert!(json["usage"][0]["attributions"][0].get("name").is_none());
    let md_path = temp.path().join("legacy.md");
    export(&db, &id, "markdown", &md_path).unwrap();
    assert!(fs::read_to_string(md_path).unwrap().contains("归属：未知"));
}

