use super::*;
use crate::adapters::accounts::AccountAdapter;
use serde_json::json;
use std::collections::BTreeMap;

fn fixture() -> (tempfile::TempDir, Database) {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("test.db")).unwrap();
    (temp, db)
}

#[test]
fn opencode_default_and_independent_xdg_paths_follow_native_layout() {
    let (temp, _) = fixture();
    let adapter = &crate::adapters::OPENCODE;
    let empty = BTreeMap::new();
    let context = adapter
        .native_context(temp.path(), &empty)
        .unwrap()
        .unwrap();
    assert_eq!(
        context.auth_files[0],
        temp.path().join(".local/share/opencode/auth.json")
    );
    assert_eq!(context.config_root, temp.path().join(".config/opencode"));
    let env = BTreeMap::from([
        (
            "XDG_DATA_HOME".into(),
            temp.path()
                .join("custom-data")
                .to_string_lossy()
                .into_owned(),
        ),
        (
            "XDG_CONFIG_HOME".into(),
            temp.path()
                .join("custom-config")
                .to_string_lossy()
                .into_owned(),
        ),
    ]);
    let context = adapter.native_context(temp.path(), &env).unwrap().unwrap();
    assert_eq!(
        context.auth_files[0],
        temp.path().join("custom-data/opencode/auth.json")
    );
    assert_eq!(
        context.config_root,
        temp.path().join("custom-config/opencode")
    );
    assert!(adapter
        .native_context(
            temp.path(),
            &BTreeMap::from([("XDG_DATA_HOME".into(), "relative".into())])
        )
        .is_err());
    let test_home = BTreeMap::from([(
        "OPENCODE_TEST_HOME".into(),
        temp.path().join("other").to_string_lossy().into_owned(),
    )]);
    assert_eq!(
        adapter
            .native_context(temp.path(), &test_home)
            .unwrap()
            .unwrap()
            .auth_files[0],
        temp.path().join(".local/share/opencode/auth.json")
    );
}

#[test]
fn opencode_auth_content_override_is_bounded_sanitized_and_not_matched_to_file_ownership() {
    let (temp, db) = fixture();
    let env = BTreeMap::from([("OPENCODE_AUTH_CONTENT".into(), json!({"custom-provider":{"type":"oauth","access":"secret-env-access","refresh":"secret-env-refresh","expires":(now()+3600)*1000}}).to_string())]);
    let snapshot = discovery::discover_with(
        &db,
        temp.path(),
        "open_code",
        &crate::adapters::OPENCODE,
        &env,
    )
    .unwrap();
    assert_eq!(snapshot.logins[0].state, AccountState::SignedIn);
    assert!(snapshot.logins[0].managed_account_id.is_none());
    assert!(!serde_json::to_string(&snapshot)
        .unwrap()
        .contains("secret-env"));
    assert!(crate::adapters::OPENCODE
        .native_context(temp.path(), &env)
        .unwrap()
        .unwrap()
        .auth_files
        .is_empty());
    assert!(discovery::discover_with(
        &db,
        temp.path(),
        "open_code",
        &crate::adapters::OPENCODE,
        &BTreeMap::from([("OPENCODE_AUTH_CONTENT".into(), " ".repeat(65537))])
    )
    .is_err());
}

#[test]
fn native_discovery_finds_oauth_without_identity_and_api_keys_without_adopting_or_leaking_secrets()
{
    let (temp, db) = fixture();
    let root = temp.path().join(".local/share/opencode");
    std::fs::create_dir_all(&root).unwrap();
    let auth = json!({"openai":{"type":"oauth","access":"secret-access","refresh":"secret-refresh","expires":(now()+3600)*1000},"anthropic":{"type":"api","key":"secret-key"},"expired":{"type":"oauth","access":"secret-expired","refresh":"secret-refresh","expires":1},"incomplete":{"type":"oauth","access":"secret-access"}}).to_string();
    std::fs::write(root.join("auth.json"), &auth).unwrap();
    let snapshot = discovery::discover_with(
        &db,
        temp.path(),
        "open_code",
        &crate::adapters::OPENCODE,
        &BTreeMap::new(),
    )
    .unwrap();
    let oauth = snapshot
        .logins
        .iter()
        .find(|login| login.provider == "openai")
        .unwrap();
    assert_eq!(oauth.state, AccountState::SignedIn);
    assert!(oauth.identity.is_none());
    assert_eq!(
        snapshot
            .logins
            .iter()
            .find(|login| login.provider == "anthropic")
            .unwrap()
            .auth_kind,
        "api_key"
    );
    assert_eq!(
        snapshot
            .logins
            .iter()
            .find(|login| login.provider == "expired")
            .unwrap()
            .state,
        AccountState::Expired
    );
    assert_eq!(
        snapshot
            .logins
            .iter()
            .find(|login| login.provider == "incomplete")
            .unwrap()
            .state,
        AccountState::Unknown
    );
    let output = serde_json::to_string(&snapshot).unwrap();
    for secret in [
        "secret-access",
        "secret-refresh",
        "secret-key",
        "secret-expired",
        "auth.json",
    ] {
        assert!(!output.contains(secret));
    }
    assert!(list(&db).unwrap().is_empty());
    assert_eq!(
        std::fs::read_to_string(root.join("auth.json")).unwrap(),
        auth
    );
}

#[test]
fn native_discovery_marks_an_already_owned_directory_and_handles_missing_files() {
    let (temp, db) = fixture();
    let adapter = &crate::adapters::OPENCODE;
    let environment = BTreeMap::new();
    let absent =
        discovery::discover_with(&db, temp.path(), "open_code", adapter, &environment).unwrap();
    assert_eq!(absent.logins[0].state, AccountState::SignedOut);
    let context = adapter
        .native_context(temp.path(), &environment)
        .unwrap()
        .unwrap();
    std::fs::create_dir_all(&context.root).unwrap();
    std::fs::write(&context.auth_files[0], json!({"openai":{"type":"oauth","accountId":"native-subject","access":"a","refresh":"r","expires":(now()+3600)*1000}}).to_string()).unwrap();
    let mut account = create(&db, "open_code", "Native owner").unwrap();
    account.context = Some(context);
    account.state = AccountState::SignedIn;
    store::replace(&db, &mut account).unwrap();
    let snapshot =
        discovery::discover_with(&db, temp.path(), "open_code", adapter, &environment).unwrap();
    assert_eq!(snapshot.logins[0].managed_account_id, Some(account.id));
    assert_eq!(
        snapshot.logins[0].identity.as_ref().unwrap().subject,
        "native-subject"
    );
    assert_eq!(list(&db).unwrap().len(), 1);
}

#[test]
fn native_contexts_do_not_force_managed_storage_and_respect_each_adapters_directory() {
    let (temp, _) = fixture();
    for (adapter, key, fallback) in [
        (
            &crate::adapters::CODEX as &dyn AccountAdapter,
            "CODEX_HOME",
            ".codex",
        ),
        (
            &crate::adapters::CLAUDE as &dyn AccountAdapter,
            "CLAUDE_CONFIG_DIR",
            ".claude",
        ),
        (
            &crate::adapters::PI as &dyn AccountAdapter,
            "PI_CODING_AGENT_DIR",
            ".pi/agent",
        ),
    ] {
        let default = adapter
            .native_context(temp.path(), &BTreeMap::new())
            .unwrap()
            .unwrap();
        assert_eq!(default.root, temp.path().join(fallback));
        assert!(default.cli_args.is_empty());
        let custom = temp.path().join("custom");
        let context = adapter
            .native_context(
                temp.path(),
                &BTreeMap::from([(key.into(), custom.to_string_lossy().into_owned())]),
            )
            .unwrap()
            .unwrap();
        assert_eq!(context.root, custom);
    }
}

#[test]
fn minimax_authenticated_state_is_discovered_without_a_cli_binary() {
    let (temp, db) = fixture();
    let state = temp
        .path()
        .join(".minimax")
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
    let snapshot = discovery::discover_with(
        &db,
        temp.path(),
        "minimax_code",
        &crate::adapters::MINIMAX_CODE,
        &BTreeMap::new(),
    )
    .unwrap();
    assert_eq!(snapshot.logins.len(), 1);
    assert_eq!(snapshot.logins[0].state, AccountState::SignedIn);
    assert!(snapshot.logins[0].identity.is_none());
    assert!(!serde_json::to_string(&snapshot)
        .unwrap()
        .contains("未找到可核验的 CLI 安装"));
}

#[test]
fn opencode_account_policy_accepts_both_verified_major_lines() {
    let adapter = &crate::adapters::OPENCODE;
    let policy = adapter.version_policy();
    for version in [
        "1.18.34",
        "1.19.0",
        "1.99.9",
        "2.0.29",
        "2.1.0",
        "v2.0.29",
        "2.0.29+build.1",
    ] {
        assert!(policy.accepts(version), "{version}");
    }
    for version in ["0.99.9", "3.0.0", "2.0.29-beta.1", "unknown", "2.0"] {
        assert!(!policy.accepts(version), "{version}");
    }
    assert_eq!(
        policy.accepted_text(),
        ">=1.0.0, <2.0.0 或 >=2.0.0, <3.0.0"
    );
    let capability = adapter.capability();
    assert!(
        capability.version.contains("1.18.34") && capability.version.contains("2.0.29"),
        "{}",
        capability.version
    );
}

/// Builds the verified 2.x credential shape (real @opencode/cli 2.0.29 store)
/// with synthetic material for regression only.
fn synthetic_v2_store(path: &Path, rows: &[(&str, &str, &str)]) {
    use rusqlite::Connection;
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.to_string_lossy()));
    }
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let connection = Connection::open(path).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE credential (
                id TEXT PRIMARY KEY,
                integration_id TEXT NOT NULL,
                label TEXT NOT NULL,
                value TEXT NOT NULL,
                connector_id TEXT,
                method_id TEXT,
                active INTEGER,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL
            );",
        )
        .unwrap();
    for (id, integration_id, value) in rows {
        connection
            .execute(
                "INSERT INTO credential (id, integration_id, label, value, connector_id, method_id, active, time_created, time_updated)
                 VALUES (?1, ?2, 'OAuth', ?3, NULL, NULL, 1, 0, 0)",
                rusqlite::params![id, integration_id, value],
            )
            .unwrap();
    }
}

#[test]
fn opencode_v2_credential_store_is_discovered_sanitized_and_authoritative_over_the_v1_file() {
    let (temp, db) = fixture();
    let adapter = &crate::adapters::OPENCODE;
    let context = adapter
        .native_context(temp.path(), &BTreeMap::new())
        .unwrap()
        .unwrap();
    synthetic_v2_store(
        &context.auth_files[1],
        &[
            (
                "v2-openai",
                "openai",
                &json!({
                    "type": "oauth",
                    "methodID": "chatgpt-browser",
                    "access": "secret-v2-access",
                    "refresh": "secret-v2-refresh",
                    "expires": (now() + 3600) * 1000,
                    "metadata": {"accountID": "native-v2-subject"}
                })
                .to_string(),
            ),
            (
                "v2-anthropic",
                "anthropic",
                &json!({"type": "api", "key": "secret-v2-key"}).to_string(),
            ),
            (
                "v2-labs",
                "openai-labs",
                &json!({
                    "type": "oauth",
                    "access": "secret-expired",
                    "refresh": "secret-refresh",
                    "expires": 1000
                })
                .to_string(),
            ),
        ],
    );
    let stale_v1 = json!({"openai":{"type":"oauth","access":"stale-access","refresh":"stale-refresh","expires":(now()+3600)*1000,"accountId":"stale-v1-subject"}}).to_string();
    std::fs::write(&context.auth_files[0], &stale_v1).unwrap();
    let snapshot = discovery::discover_with(
        &db,
        temp.path(),
        "open_code",
        adapter,
        &BTreeMap::new(),
    )
    .unwrap();
    let openai = snapshot
        .logins
        .iter()
        .find(|login| login.provider == "openai")
        .unwrap();
    assert_eq!(openai.state, AccountState::SignedIn);
    assert_eq!(
        openai.identity.as_ref().unwrap().subject,
        "native-v2-subject"
    );
    assert_eq!(
        snapshot
            .logins
            .iter()
            .find(|login| login.provider == "anthropic")
            .unwrap()
            .auth_kind,
        "api_key"
    );
    assert_eq!(
        snapshot
            .logins
            .iter()
            .find(|login| login.provider == "openai-labs")
            .unwrap()
            .state,
        AccountState::Expired
    );
    let output = serde_json::to_string(&snapshot).unwrap();
    for secret in [
        "secret-v2-access",
        "secret-v2-refresh",
        "secret-v2-key",
        "secret-expired",
        "stale-access",
        "opencode.db",
        "auth.json",
    ] {
        assert!(!output.contains(secret), "{secret}");
    }
    assert_eq!(
        std::fs::read_to_string(&context.auth_files[0]).unwrap(),
        stale_v1
    );
}

#[test]
fn opencode_native_context_tracks_the_v2_credential_database_and_its_override() {
    let (temp, _) = fixture();
    let adapter = &crate::adapters::OPENCODE;
    let empty = BTreeMap::new();
    let context = adapter
        .native_context(temp.path(), &empty)
        .unwrap()
        .unwrap();
    assert_eq!(
        context.auth_files,
        vec![
            temp.path().join(".local/share/opencode/auth.json"),
            temp.path().join(".local/share/opencode/opencode.db")
        ]
    );
    let custom = temp.path().join("custom-store.db");
    let context = adapter
        .native_context(
            temp.path(),
            &BTreeMap::from([("OPENCODE_DB".into(), custom.to_string_lossy().into_owned())]),
        )
        .unwrap()
        .unwrap();
    assert_eq!(context.auth_files[1], custom);
    assert!(adapter
        .native_context(
            temp.path(),
            &BTreeMap::from([("OPENCODE_DB".into(), "relative.db".into())])
        )
        .is_err());
    assert!(adapter
        .native_environment_keys()
        .contains(&"OPENCODE_DB"));
    assert!(adapter.remove_environment().contains(&"OPENCODE_DB"));
    let managed = adapter
        .context(temp.path().join("account"), "managed".into())
        .unwrap();
    assert_eq!(
        managed.auth_files,
        vec![
            temp.path().join("account/data/opencode/auth.json"),
            temp.path().join("account/data/opencode/opencode.db")
        ]
    );
}

#[test]
fn opencode_v2_observation_verifies_identity_expiry_and_never_fabricates() {
    let (temp, _) = fixture();
    let adapter = &crate::adapters::OPENCODE;
    let empty = BTreeMap::new();
    let context = adapter
        .native_context(temp.path(), &empty)
        .unwrap()
        .unwrap();
    let db_path = context.auth_files[1].clone();
    let observe = |version: Option<&str>| {
        adapter.observe_for_version(Path::new(""), &context, version)
    };
    // No storage at all: both lines report signed out.
    assert_eq!(observe(Some("2.0.29")).unwrap().state, AccountState::SignedOut);
    // Complete 2.x credential with a native account id.
    synthetic_v2_store(
        &db_path,
        &[(
            "v2-openai",
            "openai",
            &json!({
                "type": "oauth",
                "methodID": "chatgpt-browser",
                "access": "secret-v2-access",
                "refresh": "secret-v2-refresh",
                "expires": (now() + 3600) * 1000,
                "metadata": {"accountID": "native-v2-subject"}
            })
            .to_string(),
        )],
    );
    let observation = observe(Some("2.0.29")).unwrap();
    assert_eq!(observation.state, AccountState::SignedIn);
    assert_eq!(
        observation.identity.as_ref().unwrap().subject,
        "native-v2-subject"
    );
    assert!(!format!("{observation:?}").contains("secret-v2"));
    // Unknown version prefers the verified 2.x store over a stale 1.x file.
    std::fs::write(
        &context.auth_files[0],
        json!({"openai":{"type":"oauth","access":"stale-access","refresh":"stale-refresh","expires":(now()+3600)*1000,"accountId":"stale-v1-subject"}})
            .to_string(),
    )
    .unwrap();
    assert_eq!(
        observe(None).unwrap().identity.unwrap().subject,
        "native-v2-subject"
    );
    // The 1.x line keeps reading auth.json even with the 2.x store present.
    assert_eq!(
        observe(Some("1.18.34")).unwrap().identity.unwrap().subject,
        "stale-v1-subject"
    );
    // Without a native account id the identity stays unverified, never guessed.
    synthetic_v2_store(
        &db_path,
        &[(
            "v2-openai",
            "openai",
            &json!({
                "type": "oauth",
                "access": "secret-v2-access",
                "refresh": "secret-v2-refresh",
                "expires": (now() + 3600) * 1000
            })
            .to_string(),
        )],
    );
    let observation = observe(Some("2.0.29")).unwrap();
    assert_eq!(observation.state, AccountState::Unknown);
    assert!(observation.identity.is_none());
    assert!(observation.detail.unwrap().contains("不能猜测身份"));
    // Expired and non-OAuth records keep the 1.x semantics.
    synthetic_v2_store(
        &db_path,
        &[(
            "v2-openai",
            "openai",
            &json!({
                "type": "oauth",
                "access": "a",
                "refresh": "r",
                "expires": 1000,
                "metadata": {"accountID": "native-v2-subject"}
            })
            .to_string(),
        )],
    );
    assert_eq!(observe(Some("2.0.29")).unwrap().state, AccountState::Expired);
    synthetic_v2_store(
        &db_path,
        &[(
            "v2-openai",
            "openai",
            &json!({"type": "api", "key": "secret-key"}).to_string(),
        )],
    );
    let observation = observe(Some("2.0.29")).unwrap();
    assert_eq!(observation.state, AccountState::Unknown);
    assert!(observation.identity.is_none());
    // Multiple saved accounts cannot be resolved without fabrication.
    synthetic_v2_store(
        &db_path,
        &[
            (
                "v2-openai-a",
                "openai",
                &json!({
                    "type": "oauth",
                    "access": "a",
                    "refresh": "r",
                    "expires": (now() + 3600) * 1000,
                    "metadata": {"accountID": "subject-a"}
                })
                .to_string(),
            ),
            (
                "v2-openai-b",
                "openai",
                &json!({
                    "type": "oauth",
                    "access": "b",
                    "refresh": "r",
                    "expires": (now() + 3600) * 1000,
                    "metadata": {"accountID": "subject-b"}
                })
                .to_string(),
            ),
        ],
    );
    let observation = observe(Some("2.0.29")).unwrap();
    assert_eq!(observation.state, AccountState::Unknown);
    assert!(observation.identity.is_none());
    assert!(observation.detail.unwrap().contains("多个原生凭据"));
}


