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
