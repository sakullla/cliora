use super::*;
use crate::native::profile::Connection;
use std::cell::RefCell;

#[derive(Default)]
struct Keys {
    reads: RefCell<Vec<String>>,
}
impl CredentialStore for Keys {
    fn get(&self, id: &str) -> Result<String, String> {
        self.reads.borrow_mut().push(id.into());
        Ok("sanitized-profile-key".into())
    }
    fn put(&self, _: &str, _: &str) -> Result<(), String> {
        panic!("must not copy the profile key")
    }
    fn delete(&self, _: &str) -> Result<(), String> {
        panic!("must not delete the profile key")
    }
}

fn profile(base: &str) -> RegisteredProfile {
    RegisteredProfile {
        id: "quota-profile".into(),
        tool: "claude_code".into(),
        name: "自定义显示名称".into(),
        version: 1,
        revision: "r1".into(),
        inherit_common: false,
        files: Default::default(),
        suppressed: Default::default(),
        authentication: ProfileAuthentication::ApiKey,
        native_credentials: Default::default(),
        connection: Some(Connection {
            provider_id: "custom-name".into(),
            interface_format: "anthropic_messages".into(),
            base_url: base.into(),
            model: "model".into(),
            secret_ref: Some("profile-key-1".into()),
            auth_env_var: None,
        }),
    }
}
fn write(db: &Database, profile: &RegisteredProfile) {
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO native_profiles(id,tool,version,data) VALUES(?1,?2,?3,?4)
            ON CONFLICT(id) DO UPDATE SET version=excluded.version,data=excluded.data",
            rusqlite::params![
                profile.id,
                profile.tool,
                profile.version as i64,
                serde_json::to_string(profile).unwrap()
            ],
        )
        .map_err(|error| error.to_string())?;
        Ok(())
    })
    .unwrap();
}

#[test]
fn supplier_recognition_uses_verified_origin_and_api_path_not_display_names() {
    for (base, provider, region) in [
        ("https://open.bigmodel.cn/api/anthropic", "glm", "cn"),
        ("https://api.z.ai/api/coding/paas/v4/", "glm", "global"),
        ("https://api.kimi.com/coding/v1", "kimi", "cn"),
        ("https://api.kimi.ai/coding", "kimi", "global"),
        ("https://api.minimaxi.com/anthropic/v1", "minimax", "cn"),
        ("https://api.minimax.io/anthropic", "minimax", "global"),
    ] {
        let selected = preset(&profile(base)).unwrap();
        assert!(
            matches!(&selected.config.program, QueryProgram::Builtin { provider: actual, .. } if actual == provider)
        );
        assert_eq!(selected.config.parameters["region"], region);
    }
    for base in [
        "https://open.bigmodel.cn.evil.example/api/anthropic",
        "http://open.bigmodel.cn/api/anthropic",
        "https://open.bigmodel.cn:9443/api/anthropic",
        "https://open.bigmodel.cn/api/anthropic-malicious",
        "https://open.bigmodel.cn/api/paas/v4",
        "https://api.moonshot.cn/v1",
        "https://token@api.kimi.com/coding",
        "https://api.kimi.com/coding?override=true",
    ] {
        assert!(preset(&profile(base)).is_none(), "{base}");
    }
}

#[test]
fn profile_link_is_idempotent_and_resolves_only_its_current_key_without_copying() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("db")).unwrap();
    let keys = Keys::default();
    let mut owner = profile("https://open.bigmodel.cn/api/anthropic");
    write(&db, &owner);
    let original = ensure_profile_query(&db, &keys, &owner.id, 1)
        .unwrap()
        .unwrap();
    assert_eq!(
        original,
        ensure_profile_query(&db, &keys, &owner.id, 1)
            .unwrap()
            .unwrap()
    );
    assert!(keys.reads.borrow().is_empty());
    assert!(original.credentials.is_empty());
    let input = resolve(&db, &keys, &original.config).unwrap();
    assert_eq!(*keys.reads.borrow(), ["profile-key-1"]);
    assert_eq!(
        input.secrets[0].allowed_origins,
        ["https://open.bigmodel.cn"]
    );
    assert!(matches!(input.config.program, QueryProgram::Builtin { .. }));
    assert!(!serde_json::to_string(&original)
        .unwrap()
        .contains("sanitized-profile-key"));
    owner.version = 2;
    owner.connection.as_mut().unwrap().secret_ref = Some("profile-key-2".into());
    write(&db, &owner);
    assert!(resolve(&db, &keys, &original.config).is_err());
    assert!(list_cache(&db).unwrap()[0].auth_paused);
    let changed = ensure_profile_query(&db, &keys, &owner.id, 2)
        .unwrap()
        .unwrap();
    assert_eq!(original.id, changed.id);
    assert!(changed.generation > original.generation);
    resolve(&db, &keys, &changed.config).unwrap();
    assert_eq!(*keys.reads.borrow(), ["profile-key-1", "profile-key-2"]);
    delete_query(&db, &keys, &changed.id, changed.version).unwrap();
}

#[test]
fn changed_targets_or_identity_cannot_reuse_profile_credentials() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("db")).unwrap();
    let keys = Keys::default();
    let owner = profile("https://api.kimi.com/coding");
    write(&db, &owner);
    let query = ensure_profile_query(&db, &keys, &owner.id, 1)
        .unwrap()
        .unwrap();
    let mut changed = query.config.clone();
    changed.site = "https://evil.example".into();
    changed.targets[0].origin = changed.site.clone();
    assert!(resolve(&db, &keys, &changed).is_err());
    changed = query.config.clone();
    changed.identity.account_id = Some("different-account".into());
    assert!(resolve(&db, &keys, &changed).is_err());
    assert!(keys.reads.borrow().is_empty());
    let mut oauth = owner.clone();
    oauth.authentication = ProfileAuthentication::OAuth {
        account_id: "account".into(),
    };
    assert!(preset(&oauth).is_none());
}

#[test]
fn independent_queries_are_kept_and_missing_keys_are_explicit() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("db")).unwrap();
    let keys = Keys::default();
    let mut owner = profile("https://api.minimaxi.com/anthropic");
    owner.connection.as_mut().unwrap().secret_ref = None;
    write(&db, &owner);
    let linked = ensure_profile_query(&db, &keys, &owner.id, 1)
        .unwrap()
        .unwrap();
    assert_eq!(
        resolve(&db, &keys, &linked.config).err().unwrap().code,
        UsageErrorCode::Credential
    );
    delete_query(&db, &keys, &linked.id, linked.version).unwrap();
    let mut custom = crate::usage::tests::config();
    custom.identity.profile_id = Some(owner.id.clone());
    let saved = save_query(
        &db,
        &keys,
        UsageQueryDraft {
            id: None,
            expected_version: None,
            config: custom,
            credentials: vec![],
        },
    )
    .unwrap();
    assert!(ensure_profile_query(&db, &keys, &owner.id, 1)
        .unwrap()
        .is_none());
    assert_eq!(list_queries(&db).unwrap(), [saved.query]);
}
