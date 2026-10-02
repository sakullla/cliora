use super::*;
use serde_json::json;

fn observed(subject: &str) -> Observation {
    Observation {
        state: AccountState::SignedIn,
        identity: Some(AccountIdentity {
            subject: subject.into(),
            email: None,
            plan: None,
            source: "synthetic_native".into(),
        }),
        detail: None,
    }
}
fn fixture() -> (tempfile::TempDir, Database) {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("test.db")).unwrap();
    (temp, db)
}
fn login(db: &Database, base: &Path, id: &str, version: u32, subject: &str) -> AuthAccount {
    let account = prepare_login(db, base, id, version).unwrap();
    complete(
        db,
        id,
        &account.pending_login.unwrap().id,
        observed(subject),
        now(),
    )
    .unwrap()
}

#[test]
fn accounts_a_and_b_persist_distinct_native_contexts_without_secrets() {
    let (temp, db) = fixture();
    let a = create(&db, "codex", "Work").unwrap();
    let b = create(&db, "codex", "Personal").unwrap();
    let a = login(&db, temp.path(), &a.id, a.version, "user-a");
    let b = login(&db, temp.path(), &b.id, b.version, "user-b");
    assert_ne!(
        a.context.as_ref().unwrap().root,
        b.context.as_ref().unwrap().root
    );
    assert_ne!(
        a.context.as_ref().unwrap().environment["CODEX_HOME"],
        b.context.as_ref().unwrap().environment["CODEX_HOME"]
    );
    drop(db);
    let db = Database::open(&temp.path().join("test.db")).unwrap();
    assert_eq!(get(&db, &a.id).unwrap().identity.unwrap().subject, "user-a");
    assert_eq!(get(&db, &b.id).unwrap().identity.unwrap().subject, "user-b");
}

#[test]
fn cancellation_and_timeout_never_promote_late_login() {
    let (temp, db) = fixture();
    let a = create(&db, "codex", "A").unwrap();
    let pending = prepare_login(&db, temp.path(), &a.id, a.version).unwrap();
    let attempt = pending.pending_login.unwrap();
    let cancelled = cancel(&db, &a.id, &attempt.id, false).unwrap();
    assert_eq!(cancelled.state, AccountState::SignedOut);
    assert!(complete(&db, &a.id, &attempt.id, observed("late-a"), now()).is_err());
    let pending = prepare_login(&db, temp.path(), &a.id, cancelled.version).unwrap();
    let next = pending.pending_login.unwrap();
    assert_ne!(attempt.context.root, next.context.root);
    assert_eq!(
        complete(&db, &a.id, &next.id, observed("late-b"), next.expires_at)
            .unwrap()
            .state,
        AccountState::SignedOut
    );
}

#[test]
fn reauthentication_must_preserve_identity_and_old_context_on_failure() {
    let (temp, db) = fixture();
    let a = create(&db, "claude_code", "A").unwrap();
    let a = login(&db, temp.path(), &a.id, a.version, "same-account");
    let before = a.context.clone();
    let rejected = login(&db, temp.path(), &a.id, a.version, "different-account");
    assert_eq!(rejected.context, before);
    assert_eq!(rejected.state, AccountState::SignedIn);
    let refreshed = login(&db, temp.path(), &a.id, rejected.version, "same-account");
    assert_ne!(refreshed.context, before);
    assert_eq!(refreshed.retired_contexts, vec![before.unwrap()]);
}

#[test]
fn logout_a_waits_for_native_confirmation_and_leaves_b_unchanged() {
    let (temp, db) = fixture();
    let a = create(&db, "codex", "A").unwrap();
    let b = create(&db, "codex", "B").unwrap();
    let mut a = login(&db, temp.path(), &a.id, a.version, "a");
    let b = login(&db, temp.path(), &b.id, b.version, "b");
    let b_before = serde_json::to_value(&b).unwrap();
    a.pending_login = Some(PendingLogin {
        id: "logout-a".into(),
        expires_at: now() + 100,
        context: a.context.clone().unwrap(),
        previous_state: AccountState::SignedIn,
        external_terminal: true,
        operation: "logout".into(),
    });
    a.state = AccountState::Pending;
    store::replace(&db, &mut a).unwrap();
    assert_eq!(
        complete(&db, &a.id, "logout-a", observed("a"), now())
            .unwrap()
            .state,
        AccountState::Pending
    );
    let result = complete(
        &db,
        &a.id,
        "logout-a",
        Observation {
            state: AccountState::SignedOut,
            identity: None,
            detail: None,
        },
        now(),
    )
    .unwrap();
    assert_eq!(result.state, AccountState::SignedOut);
    assert_eq!(
        serde_json::to_value(get(&db, &b.id).unwrap()).unwrap(),
        b_before
    );
}

#[test]
fn stale_status_and_rename_cannot_overwrite_newer_cancellation() {
    let (temp, db) = fixture();
    let a = create(&db, "codex", "A").unwrap();
    let mut stale = prepare_login(&db, temp.path(), &a.id, a.version).unwrap();
    let cancelled = cancel(&db, &a.id, &stale.pending_login.as_ref().unwrap().id, false).unwrap();
    stale.state = AccountState::SignedIn;
    assert!(store::replace(&db, &mut stale).is_err());
    assert!(rename(&db, &a.id, a.version, "stale").is_err());
    assert_eq!(get(&db, &a.id).unwrap().version, cancelled.version);
}

#[test]
fn native_failure_and_reopened_expired_attempt_have_explicit_outcomes() {
    let (temp, db) = fixture();
    let a = create(&db, "codex", "A").unwrap();
    let pending = prepare_login(&db, temp.path(), &a.id, a.version).unwrap();
    let failed = fail_login(
        &db,
        &a.id,
        &pending.pending_login.unwrap().id,
        "原生登录失败",
    )
    .unwrap();
    assert_eq!(failed.state, AccountState::Error);
    let mut next = prepare_login(&db, temp.path(), &a.id, failed.version).unwrap();
    next.pending_login.as_mut().unwrap().expires_at = now() - 1;
    store::replace(&db, &mut next).unwrap();
    let list = list(&db).unwrap();
    assert!(list[0].pending_login.is_none());
    assert!(list[0].detail.as_ref().unwrap().contains("超时"));
}

#[test]
fn native_observations_never_infer_identity_from_readiness_or_copy_tokens() {
    assert_eq!(native::parse_codex(&json!({})).state, AccountState::Unknown);
    assert_eq!(
        native::parse_codex(&json!({"account":null})).state,
        AccountState::SignedOut
    );
    assert_eq!(
        native::parse_codex(&json!({"account":{"type":"apiKey"}})).state,
        AccountState::Unknown
    );
    let codex = native::parse_codex(
        &json!({"account":{"type":"chatgpt","email":"a@example.test","planType":"plus","access_token":"test-secret"}}),
    );
    assert_eq!(codex.state, AccountState::SignedIn);
    assert!(!serde_json::to_string(&codex.identity)
        .unwrap()
        .contains("test-secret"));
    assert_eq!(
        native::parse_claude(&json!({"loggedIn":true,"authMethod":"claude.ai"})).state,
        AccountState::Unknown
    );
    assert_eq!(
        native::parse_claude(
            &json!({"loggedIn":true,"authMethod":"claude.ai","email":"a@example.test"})
        )
        .state,
        AccountState::SignedIn
    );
    let record = json!({"openai":{"type":"oauth","access":"test-secret","refresh":"test-refresh","expires":2000000,"accountId":"account-a"}});
    let parsed = native::parse_oauth_record(&record, "openai", 1000);
    assert_eq!(parsed.state, AccountState::SignedIn);
    assert!(!serde_json::to_string(&parsed.identity)
        .unwrap()
        .contains("test-secret"));
    assert_eq!(
        native::parse_oauth_record(&record, "openai", 2000).state,
        AccountState::Expired
    );
    assert_eq!(
        native::parse_oauth_record(&record, "other", 1000).state,
        AccountState::SignedOut
    );
}

#[test]
fn contexts_match_native_paths_and_never_rewrite_generic_home() {
    let temp = tempfile::tempdir().unwrap();
    for tool in ["codex", "claude_code", "pi", "open_code"] {
        let context = context::create_context(temp.path(), tool).unwrap();
        assert!(!context.environment.contains_key("HOME"));
        assert!(!context.environment.contains_key("USERPROFILE"));
        assert!(context
            .auth_files
            .iter()
            .all(|path| path.starts_with(&context.root)));
        let mut command = std::process::Command::new("synthetic");
        context.apply_to_command(&mut command).unwrap();
        assert!(command
            .get_envs()
            .any(|(key, value)| key == "OPENAI_API_KEY" && value.is_none()));
        if tool == "open_code" {
            assert_eq!(
                context.auth_files[0],
                context.root.join("data/opencode/auth.json")
            );
        }
    }
}

#[test]
fn unsupported_methods_and_grok_do_not_create_pseudo_accounts() {
    let (_temp, db) = fixture();
    assert!(create(&db, "grok", "Grok").is_err());
    assert!(native::login_args("claude_code", "device").is_err());
    assert!(native::login_args("open_code", "browser")
        .unwrap()
        .contains(&"ChatGPT Pro/Plus (browser)".into()));
    assert!(list(&db).unwrap().is_empty());
}

#[test]
fn authentication_file_output_is_bounded_and_errors_do_not_echo_secrets() {
    let temp = tempfile::tempdir().unwrap();
    let context = context::create_context(temp.path(), "pi").unwrap();
    std::fs::write(&context.auth_files[0], "test-secret".repeat(10000)).unwrap();
    let error = native::read_auth_file(&context).unwrap_err();
    assert!(!error.contains("test-secret"));
}

#[test]
#[ignore = "requires installed fixed CLI versions; only synthetic private contexts, no real login"]
fn installed_native_empty_contexts_and_codex_synthetic_logout_isolation() {
    use base64::Engine;
    let (temp, db) = fixture();
    let home = temp.path().join("synthetic-home");
    std::fs::create_dir(&home).unwrap();
    for tool in ["codex", "claude_code", "pi", "open_code"] {
        let executable = native::executable(&db, &home, tool).unwrap();
        let context = context::create_context(temp.path(), tool).unwrap();
        let observation = native::observe(&executable, &context).unwrap();
        assert_eq!(observation.state, AccountState::SignedOut, "{tool}");
        assert!(observation.identity.is_none());
        if tool == "pi" || tool == "open_code" {
            let provider = if tool == "pi" {
                "openai-codex"
            } else {
                "openai"
            };
            std::fs::create_dir_all(context.auth_files[0].parent().unwrap()).unwrap();
            let synthetic = json!({provider:{"type":"oauth","access":"synthetic-access-never-valid","refresh":"synthetic-refresh-never-valid","expires":(now()+3600)*1000,"accountId":"synthetic-account-a"}});
            std::fs::write(&context.auth_files[0], synthetic.to_string()).unwrap();
            let observation = native::observe(&executable, &context).unwrap();
            assert_eq!(observation.state, AccountState::SignedIn, "{tool}");
            assert_eq!(observation.identity.unwrap().subject, "synthetic-account-a");
            if tool == "open_code" {
                assert_eq!(
                    native::perform_logout(&executable, &context).unwrap().state,
                    AccountState::SignedOut
                );
            }
        }
        if tool == "claude_code" {
            assert_eq!(
                native::perform_logout(&executable, &context).unwrap().state,
                AccountState::SignedOut
            );
        }
        if tool == "codex" {
            let context_b = context::create_context(temp.path(), "codex").unwrap();
            for (ctx, email, account_id) in [
                (&context, "synthetic-a@example.test", "account-a"),
                (&context_b, "synthetic-b@example.test", "account-b"),
            ] {
                let claims = json!({"email":email,"exp":now()+3600,"https://api.openai.com/auth":{"chatgpt_account_id":account_id,"chatgpt_plan_type":"plus"}});
                let jwt = format!(
                    "e30.{}.synthetic",
                    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims.to_string())
                );
                let auth = json!({"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{"id_token":jwt,"access_token":jwt,"refresh_token":"synthetic-refresh-never-use","account_id":account_id},"last_refresh":chrono::Utc::now().to_rfc3339()});
                std::fs::write(&ctx.auth_files[0], auth.to_string()).unwrap();
            }
            // account/read on a synthetic token legitimately fails native server
            // workspace discovery. Never bypass that check to invent live identity.
            // Native local logout can still prove that it only clears context A.
            let b_before = std::fs::read(&context_b.auth_files[0]).unwrap();
            native::codex_read(&executable, &context, "account/logout").unwrap();
            assert_eq!(
                native::observe(&executable, &context).unwrap().state,
                AccountState::SignedOut
            );
            assert_eq!(std::fs::read(&context_b.auth_files[0]).unwrap(), b_before);
        }
    }
}
