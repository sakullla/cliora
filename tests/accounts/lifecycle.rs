use super::*;
use serde_json::json;

#[test]
fn deletion_checks_version_and_preserves_native_files_and_other_accounts() {
    let (temp, db) = fixture();
    let a = create(&db, "codex", "Delete").unwrap();
    let a = login(&db, temp.path(), &a.id, a.version, "synthetic-user");
    let b = create(&db, "codex", "Keep").unwrap();
    let path = &a.context.as_ref().unwrap().auth_files[0];
    std::fs::write(path, "synthetic-native-file").unwrap();
    assert!(delete(&db, &a.id, a.version - 1).unwrap_err().contains("变化"));
    delete(&db, &a.id, a.version).unwrap();
    assert!(get(&db, &a.id).is_err());
    assert_eq!(get(&db, &b.id).unwrap().label, "Keep");
    assert_eq!(std::fs::read_to_string(path).unwrap(), "synthetic-native-file");
}

#[test]
fn pending_account_requires_cancellation_before_deletion() {
    let (temp, db) = fixture();
    let a = create(&db, "codex", "Delete").unwrap();
    let pending = prepare_login(&db, temp.path(), &a.id, a.version).unwrap();
    assert!(delete(&db, &a.id, pending.version).unwrap_err().contains("先取消"));
    let cancelled = cancel(&db, &a.id, &pending.pending_login.unwrap().id, false).unwrap();
    delete(&db, &a.id, cancelled.version).unwrap();
}

#[test]
fn profile_query_and_active_context_references_block_deletion() {
    for reference in ["profile", "query_account", "query_context", "binding"] {
        let (temp, db) = fixture();
        let a = create(&db, "codex", "Delete").unwrap();
        let a = login(&db, temp.path(), &a.id, a.version, "synthetic-user");
        db.with_connection(|conn| {
            match reference {
                "profile" => { conn.execute("INSERT INTO native_profiles(id,tool,version,data) VALUES('p','codex',1,?1)", [json!({"name":"Work","authentication":{"kind":"oauth","accountId":a.id}}).to_string()]).unwrap(); }
                "binding" => { conn.execute("INSERT INTO applied_bindings(scope_key,tool,profile_id,profile_version,managed,context_id) VALUES('global','codex','p',1,'{}',?1)", [&a.context.as_ref().unwrap().id]).unwrap(); }
                _ => { let identity = if reference == "query_account" { json!({"accountId":a.id}) } else { json!({"contextId":a.context.as_ref().unwrap().id}) }; conn.execute("INSERT INTO usage_queries(id,version,generation,data) VALUES('q',1,1,?1)", [json!({"config":{"identity":identity}}).to_string()]).unwrap(); }
            }
            Ok(())
        }).unwrap();
        assert!(delete(&db, &a.id, a.version).is_err(), "{reference}");
        assert!(get(&db, &a.id).is_ok());
    }
}

#[test]
fn interactive_login_does_not_accept_a_forced_provider_browser_link() {
    let (temp, db) = fixture();
    let a = create(&db, "open_code", "Browser").unwrap();
    let a = prepare_login(&db, temp.path(), &a.id, a.version).unwrap();
    let pending = a.pending_login.as_ref().unwrap();
    let link = "https://auth.openai.com/oauth/authorize?state=synthetic&code_challenge=synthetic";
    std::fs::write(pending.context.root.join(".cliora-auth-url"), format!("\u{feff}{link}\n")).unwrap();
    assert!(native::login_url(&db, &a.id, &pending.id).is_err());
    let adapter = crate::adapters::accounts::get("open_code").unwrap();
    assert!(!adapter.capability().browser_link);
    assert!(adapter.browser_login_endpoint().is_none());
    assert!(native::login_url(&db, &a.id, "old-attempt").is_err());
    for invalid in ["https://auth.openai.com.evil.test/oauth/authorize", "https://auth.openai.com/other", "https://secret@auth.openai.com/oauth/authorize", "http://auth.openai.com/oauth/authorize", "https://auth.openai.com/oauth/authorize#fragment"] {
        assert!(native::validated_login_url("open_code", invalid).is_err());
    }
    cancel(&db, &a.id, &pending.id, false).unwrap();
    assert!(native::login_url(&db, &a.id, &pending.id).is_err());
}

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

#[test]
fn a_native_directory_cannot_be_adopted_by_a_second_account_with_a_new_context_id() {
    let (temp, db) = fixture();
    let account = create(&db, "codex", "Original").unwrap();
    let owner = login(&db, temp.path(), &account.id, account.version, "same-user");
    let mut duplicate = owner.clone();
    duplicate.id = uuid::Uuid::new_v4().to_string();
    duplicate.context.as_mut().unwrap().id = "adopted-other-id".into();
    assert!(store::insert(&db, &duplicate).is_err());
    assert_eq!(list(&db).unwrap().len(), 1);
    assert_eq!(
        serde_json::to_value(get(&db, &owner.id).unwrap()).unwrap(),
        serde_json::to_value(owner).unwrap()
    );
}

#[test]
fn concurrent_native_directory_adoption_has_only_one_owner_across_database_handles() {
    let (temp, db) = fixture();
    let template = create(&db, "codex", "Template").unwrap();
    let root = temp.path().join("native");
    std::fs::create_dir(&root).unwrap();
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let handles: Vec<_> = (0..2)
        .map(|i| {
            let db = Database::open(&temp.path().join("test.db")).unwrap();
            let mut candidate = template.clone();
            candidate.id = uuid::Uuid::new_v4().to_string();
            candidate.context =
                Some(context::context_at(root.clone(), "codex", format!("adopted-{i}")).unwrap());
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                store::insert(&db, &candidate).is_ok()
            })
        })
        .collect();
    assert_eq!(
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .filter(|inserted| *inserted)
            .count(),
        1
    );
    assert_eq!(
        list(&db)
            .unwrap()
            .iter()
            .filter(|account| account.context.is_some())
            .count(),
        1
    );
}

#[test]
fn retired_and_pending_native_directories_keep_their_account_ownership() {
    for pending in [false, true] {
        let (temp, db) = fixture();
        let account = create(&db, "codex", "Original").unwrap();
        let mut owner = login(&db, temp.path(), &account.id, account.version, "same-user");
        let context = owner.context.take().unwrap();
        if pending {
            owner.pending_login = Some(PendingLogin {
                id: "pending-owner".into(),
                expires_at: now() + 600,
                context: context.clone(),
                previous_state: AccountState::SignedOut,
                external_terminal: true,
                operation: "login".into(),
            });
        } else {
            owner.retired_contexts.push(context.clone());
        }
        store::replace(&db, &mut owner).unwrap();
        let mut duplicate = owner.clone();
        duplicate.id = uuid::Uuid::new_v4().to_string();
        duplicate.retired_contexts.clear();
        duplicate.pending_login = None;
        duplicate.context = Some(NativeContext {
            id: "new-context-id".into(),
            ..context
        });
        assert!(store::insert(&db, &duplicate)
            .unwrap_err()
            .contains("另一账号"));
        assert_eq!(list(&db).unwrap().len(), 1);
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
    let a = create(&db, "codex", "A").unwrap();
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
    assert_eq!(
        crate::adapters::codex::accounts::parse_codex(&json!({})).state,
        AccountState::Unknown
    );
    assert_eq!(
        crate::adapters::codex::accounts::parse_codex(&json!({"account":null})).state,
        AccountState::SignedOut
    );
    assert_eq!(
        crate::adapters::codex::accounts::parse_codex(&json!({"account":{"type":"apiKey"}})).state,
        AccountState::Unknown
    );
    let codex = crate::adapters::codex::accounts::parse_codex(
        &json!({"account":{"type":"chatgpt","email":"a@example.test","planType":"plus","access_token":"test-secret"}}),
    );
    assert_eq!(codex.state, AccountState::SignedIn);
    assert!(!serde_json::to_string(&codex.identity)
        .unwrap()
        .contains("test-secret"));
    assert_eq!(
        crate::adapters::claude::accounts::parse_claude(
            &json!({"loggedIn":true,"authMethod":"claude.ai"})
        )
        .state,
        AccountState::Unknown
    );
    assert_eq!(
        crate::adapters::claude::accounts::parse_claude(
            &json!({"loggedIn":true,"authMethod":"claude.ai","email":"a@example.test"})
        )
        .state,
        AccountState::SignedIn
    );
    let record = json!({"openai":{"type":"oauth","access":"test-secret","refresh":"test-refresh","expires":2000000,"accountId":"account-a"}});
    let parsed = crate::adapters::accounts::parse_oauth_record(&record, "openai", 1000);
    assert_eq!(parsed.state, AccountState::SignedIn);
    assert!(!serde_json::to_string(&parsed.identity)
        .unwrap()
        .contains("test-secret"));
    assert_eq!(
        crate::adapters::accounts::parse_oauth_record(&record, "openai", 2000).state,
        AccountState::Expired
    );
    assert_eq!(
        crate::adapters::accounts::parse_oauth_record(&record, "other", 1000).state,
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
                context.auth_files,
                vec![
                    context.root.join("data/opencode/auth.json"),
                    context.root.join("data/opencode/opencode.db"),
                ]
            );
        }
    }
}

#[test]
fn unsupported_methods_and_grok_do_not_create_pseudo_accounts() {
    let (_temp, db) = fixture();
    assert!(create(&db, "grok", "Grok").is_err());
    assert!(native::login_args("claude_code", "device").is_err());
    assert_eq!(native::login_args("open_code", "browser").unwrap(), ["auth", "login", "--pure"]);
    assert!(native::login_args("open_code", "device").is_err());
    assert!(list(&db).unwrap().is_empty());
}

#[test]
fn opencode_login_and_logout_arguments_follow_the_installed_line() {
    // Verified 2.x surface (real @opencode/cli 2.0.29): the target and method
    // pin the OpenAI ChatGPT OAuth flow and --standalone keeps the isolated
    // context off the shared background-service port.
    let v2 = ["auth", "login", "openai", "--method", "chatgpt-browser", "--standalone"];
    assert_eq!(
        native::login_args_for_version("open_code", Some("2.0.29"), "browser").unwrap(),
        v2
    );
    assert_eq!(
        native::login_args_for_version("open_code", Some("v2.1.0"), "browser").unwrap(),
        v2
    );
    // The 1.x menu flow and an unidentified version keep the current args.
    assert_eq!(
        native::login_args_for_version("open_code", Some("1.19.0"), "browser").unwrap(),
        ["auth", "login", "--pure"]
    );
    assert_eq!(
        native::login_args_for_version("open_code", None, "browser").unwrap(),
        ["auth", "login", "--pure"]
    );
    assert!(native::login_args_for_version("open_code", Some("2.0.29"), "device").is_err());
    assert_eq!(
        crate::adapters::accounts::get("open_code")
            .unwrap()
            .logout_args(),
        ["auth", "logout", "openai", "--pure"]
    );
}

#[test]
fn opencode_v2_logout_without_saved_openai_credentials_never_spawns_native_commands() {
    use crate::adapters::accounts::AccountAdapter;
    let temp = tempfile::tempdir().unwrap();
    let adapter = &crate::adapters::OPENCODE;
    let context = adapter
        .native_context(temp.path(), &std::collections::BTreeMap::new())
        .unwrap()
        .unwrap();
    std::fs::create_dir_all(&context.root).unwrap();
    // A store without OpenAI rows is already signed out; no native command is
    // needed and the missing stores keep the shared SignedOut observation.
    adapter
        .logout_for_version(Path::new("definitely-not-installed"), &context, Some("2.0.29"))
        .unwrap();
    assert_eq!(
        adapter
            .observe_for_version(Path::new(""), &context, Some("2.0.29"))
            .unwrap()
            .state,
        AccountState::SignedOut
    );
}

#[test]
fn timed_out_login_uses_an_authenticated_default_directory_without_an_account_id() {
    let (temp, db) = fixture();
    let root = temp.path().join(".minimax");
    let state = root
        .join("auth")
        .join("prod")
        .join("cn")
        .join("mcode-public")
        .join("auth-state.json");
    std::fs::create_dir_all(state.parent().unwrap()).unwrap();
    std::fs::write(
        &state,
        r#"{"schemaVersion":2,"status":"authenticated","storeKind":"file","clientId":"mcode-public","scopes":["agent.default"],"audience":"agent-backend","buildEnv":"prod","region":"cn","generation":1}"#,
    )
    .unwrap();
    std::fs::write(
        state.parent().unwrap().join("auth.json"),
        r#"{"accessToken":"synthetic-token-must-not-leak"}"#,
    )
    .unwrap();

    let mut timed_out = create(&db, "minimax_code", "MiniMax").unwrap();
    timed_out.detail = Some(LOGIN_TIMEOUT_DETAIL.into());
    store::replace(&db, &mut timed_out).unwrap();
    let mut cancelled = create(&db, "minimax_code", "Cancelled").unwrap();
    cancelled.detail = Some("已取消结果接纳。外部原生终端仍由用户控制，请关闭；迟到授权不会激活候选目录。".into());
    store::replace(&db, &mut cancelled).unwrap();
    let mut codex = create(&db, "codex", "Codex").unwrap();
    codex.detail = Some(LOGIN_TIMEOUT_DETAIL.into());
    store::replace(&db, &mut codex).unwrap();
    let mut second = create(&db, "minimax_code", "Second").unwrap();
    second.detail = Some(LOGIN_TIMEOUT_DETAIL.into());
    store::replace(&db, &mut second).unwrap();

    recover_completed_login(&db, temp.path(), &list(&db).unwrap());

    let recovered = get(&db, &timed_out.id).unwrap();
    assert_eq!(recovered.state, AccountState::SignedIn);
    assert!(recovered.pending_login.is_none());
    assert!(recovered.identity.is_none());
    assert_eq!(recovered.context.as_ref().unwrap().root, root);
    let rendered = serde_json::to_string(&recovered).unwrap();
    assert!(!rendered.contains("synthetic-token"));
    assert!(recovered.detail.as_deref().unwrap().contains("已登录"));
    assert_eq!(get(&db, &cancelled.id).unwrap().state, AccountState::SignedOut);
    assert!(get(&db, &cancelled.id).unwrap().context.is_none());
    assert_eq!(get(&db, &codex.id).unwrap().state, AccountState::SignedOut);
    assert!(get(&db, &codex.id).unwrap().context.is_none());
    let second = get(&db, &second.id).unwrap();
    assert_eq!(second.state, AccountState::SignedOut);
    assert!(second.context.is_none());
    assert_eq!(second.detail.as_deref(), Some(LOGIN_TIMEOUT_DETAIL));
}

#[test]
fn minimax_check_reads_the_status_file_without_an_identity() {
    use crate::adapters::accounts::AccountAdapter;
    let (temp, db) = fixture();
    let root = temp.path().join("account");
    let state = root
        .join("auth")
        .join("prod")
        .join("cn")
        .join("mcode-public")
        .join("auth-state.json");
    std::fs::create_dir_all(state.parent().unwrap()).unwrap();
    std::fs::write(
        &state,
        r#"{"schemaVersion":2,"status":"authenticated","storeKind":"file","clientId":"mcode-public","scopes":["agent.default"],"audience":"agent-backend","buildEnv":"prod","region":"cn","generation":1}"#,
    )
    .unwrap();
    let mut account = create(&db, "minimax_code", "MiniMax").unwrap();
    account.state = AccountState::SignedIn;
    account.context = Some(
        crate::adapters::MINIMAX_CODE
            .context(root, "native-default".into())
            .unwrap(),
    );
    store::replace(&db, &mut account).unwrap();
    let checked = check(&db, temp.path(), &account.id).unwrap();
    assert_eq!(checked.state, AccountState::SignedIn);
    assert!(checked.identity.is_none());
    assert!(!checked.detail.as_deref().unwrap_or("").contains("未找到可核验的 CLI 安装"));
    assert!(!checked.detail.as_deref().unwrap_or("").contains("synthetic"));
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
            crate::adapters::codex::accounts::codex_read(&executable, &context, "account/logout")
                .unwrap();
            assert_eq!(
                native::observe(&executable, &context).unwrap().state,
                AccountState::SignedOut
            );
            assert_eq!(std::fs::read(&context_b.auth_files[0]).unwrap(), b_before);
        }
    }
}

#[test]
fn every_auth_family_contributes_conflicting_environment_removal() {
    let temp = tempfile::tempdir().unwrap();
    let context =
        context::context_at(temp.path().join("isolated"), "codex", "fixture".into()).unwrap();
    for variable in [
        "OPENAI_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CONFIG_DIR",
        "PI_CODING_AGENT_DIR",
        "OPENCODE_AUTH_CONTENT",
        "OPENCODE_DB",
        "XAI_API_KEY",
        "GROK_HOME",
    ] {
        assert!(
            context.remove_environment.iter().any(|v| v == variable),
            "{variable}"
        );
    }
    let mut variables = context.remove_environment.clone();
    variables.sort();
    variables.dedup();
    assert_eq!(variables.len(), context.remove_environment.len());
}
