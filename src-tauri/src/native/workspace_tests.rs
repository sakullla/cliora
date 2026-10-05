use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
#[derive(Default)]
struct Store {
    values: Mutex<BTreeMap<String, String>>,
    fail_put: AtomicBool,
}
impl CredentialStore for Store {
    fn put(&self, id: &str, secret: &str) -> Result<(), String> {
        if self.fail_put.load(Ordering::SeqCst) {
            return Err("synthetic store failure".into());
        }
        self.values.lock().unwrap().insert(id.into(), secret.into());
        Ok(())
    }
    fn get(&self, id: &str) -> Result<String, String> {
        self.values
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or("missing synthetic credential".into())
    }
    fn delete(&self, id: &str) -> Result<(), String> {
        self.values.lock().unwrap().remove(id);
        Ok(())
    }
}
fn fixture() -> RegisteredProfile {
    serde_json::from_value(json!({"id":"","tool":"open_code","name":"workspace","version":0,"inheritCommon":false,"files":{"settings":json!({"model":"alpha/safe","provider":{"alpha":{"npm":"@ai-sdk/openai-compatible","options":{"baseURL":"https://alpha.example/v1"},"models":{"safe":{"name":"safe","limit":{"context":64000,"output":1000}}}}}}).to_string()},"connection":null,"nativeCredentials":{}})).unwrap()
}
fn begin(
    sessions: &DraftSessions,
    registry: &Registry,
    db: &Database,
    profile: RegisteredProfile,
    id: &str,
) -> ConfigurationDraft {
    sessions
        .begin(
            registry,
            db,
            ConfigurationBeginRequest {
                tool_id: profile.tool.clone(),
                scope: Scope::Global,
                project_path: None,
                session_id: id.into(),
                subject: ConfigurationSubject::Profile,
                profile: Some(profile),
            },
            None,
            Vec::new(),
        )
        .unwrap()
}
fn api(
    sessions: &DraftSessions,
    registry: &Registry,
    db: &Database,
    draft: ConfigurationDraft,
) -> ConfigurationDraft {
    sessions
        .select_credential(
            registry,
            db,
            draft,
            ConfigurationCredential::ApiKey {
                secret_ref: None,
                remove: false,
            },
        )
        .unwrap()
}
fn action(value: Value) -> ConfigurationAction {
    ConfigurationAction {
        version: 1,
        target: json!({"kind":"model","provider":"alpha","id":"safe"}),
        operation: "set".into(),
        field: Some("limit.context".into()),
        value: Some(value),
    }
}
fn native(temp: &std::path::Path) -> Vec<NativeFile> {
    vec![crate::adapters::file(
        "settings",
        temp.join("opencode.jsonc"),
        format::FileKind::Jsonc,
        true,
        None,
        false,
    )]
}

#[test]
fn workspace_leases_are_memory_owned_source_buffers_and_never_persistent_before_adoption() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("db")).unwrap();
    let registry = Registry::builtins();
    let sessions = DraftSessions::default();
    let store = Store::default();
    let draft = api(
        &sessions,
        &registry,
        &db,
        begin(&sessions, &registry, &db, fixture(), "lease"),
    );
    let draft = sessions
        .set_secret(&registry, draft, "synthetic-lease-a".into())
        .unwrap();
    assert_eq!(draft.credential_status.as_deref(), Some("draft"));
    assert!(!serde_json::to_string(&draft)
        .unwrap()
        .contains("synthetic-lease-a"));
    assert!(store.values.lock().unwrap().is_empty());
    let id = match &draft.credential {
        Some(ConfigurationCredential::ApiKey {
            secret_ref: Some(id),
            ..
        }) => id.clone(),
        _ => panic!("no lease"),
    };
    assert_eq!(
        sessions.reveal_secret(&draft, &store).unwrap(),
        "synthetic-lease-a"
    );
    let native = sessions
        .select_credential(&registry, &db, draft, ConfigurationCredential::Native)
        .unwrap();
    assert!(sessions.request(&native, &store).is_err());
    let returned = sessions
        .select_credential(
            &registry,
            &db,
            native,
            ConfigurationCredential::ApiKey {
                secret_ref: Some(id.clone()),
                remove: false,
            },
        )
        .unwrap();
    assert_eq!(
        sessions.reveal_secret(&returned, &store).unwrap(),
        "synthetic-lease-a"
    );
    let preserved = sessions
        .set_secret(&registry, returned, String::new())
        .unwrap();
    assert_eq!(
        sessions.reveal_secret(&preserved, &store).unwrap(),
        "synthetic-lease-a"
    );
    let replaced = sessions
        .set_secret(&registry, preserved, "synthetic-lease-b".into())
        .unwrap();
    assert!(sessions
        .select_credential(
            &registry,
            &db,
            replaced.clone(),
            ConfigurationCredential::ApiKey {
                secret_ref: Some(id),
                remove: false
            }
        )
        .is_err());
    sessions.cancel(&replaced.session_id).unwrap();
    assert!(sessions.request(&replaced, &store).is_err());
    assert!(store.values.lock().unwrap().is_empty());
}
#[test]
fn workspace_save_only_pins_last_success_key_and_explicit_remove_does_not_fallback() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("db")).unwrap();
    let registry = Registry::builtins();
    let sessions = DraftSessions::default();
    let store = Store::default();
    let draft = api(
        &sessions,
        &registry,
        &db,
        begin(&sessions, &registry, &db, fixture(), "save"),
    );
    let draft = sessions
        .set_secret(&registry, draft, "synthetic-old-key".into())
        .unwrap();
    let saved = sessions
        .save_database(&registry, &db, &store, draft)
        .unwrap();
    assert_eq!(saved.draft.credential_status.as_deref(), Some("stored"));
    let files = native(temp.path());
    assert!(!std::path::Path::new(&files[0].path).exists());
    super::super::apply::apply_registered_validated(
        &registry,
        &db,
        &store,
        saved.profile.as_ref().unwrap(),
        None,
        &files,
        "global",
        Scope::Global,
        false,
    )
    .unwrap();
    let before = std::fs::read_to_string(&files[0].path).unwrap();
    let original = super::super::apply::get_registered_binding(&db, "open_code", "global")
        .unwrap()
        .unwrap();
    let old_ref = original
        .applied_profile
        .as_ref()
        .unwrap()
        .runtime_profile
        .connection
        .as_ref()
        .unwrap()
        .secret_ref
        .clone()
        .unwrap();
    let draft = sessions
        .set_secret(&registry, saved.draft, "synthetic-new-key".into())
        .unwrap();
    store.fail_put.store(true, Ordering::SeqCst);
    assert!(sessions
        .save_database(&registry, &db, &store, draft.clone())
        .is_err());
    store.fail_put.store(false, Ordering::SeqCst);
    assert_eq!(store.get(&old_ref).unwrap(), "synthetic-old-key");
    assert_eq!(std::fs::read_to_string(&files[0].path).unwrap(), before);
    let saved = sessions
        .save_database(&registry, &db, &store, draft)
        .unwrap();
    let pending = super::super::apply::get_registered_binding(&db, "open_code", "global")
        .unwrap()
        .unwrap();
    assert_eq!(pending.profile_version, 1);
    assert_eq!(
        pending
            .applied_profile
            .as_ref()
            .unwrap()
            .runtime_profile
            .connection
            .as_ref()
            .unwrap()
            .secret_ref
            .as_deref(),
        Some(old_ref.as_str())
    );
    assert_eq!(std::fs::read_to_string(&files[0].path).unwrap(), before);
    super::super::apply::apply_registered_validated(
        &registry,
        &db,
        &store,
        saved.profile.as_ref().unwrap(),
        None,
        &files,
        "global",
        Scope::Global,
        false,
    )
    .unwrap();
    assert!(std::fs::read_to_string(&files[0].path)
        .unwrap()
        .contains("synthetic-new-key"));
    let null = sessions
        .select_credential(
            &registry,
            &db,
            saved.draft,
            ConfigurationCredential::ApiKey {
                secret_ref: None,
                remove: false,
            },
        )
        .unwrap();
    assert!(sessions
        .save_database(&registry, &db, &store, null.clone())
        .is_err());
    let removed = sessions.remove_secret(&registry, null).unwrap();
    assert_eq!(removed.credential_status.as_deref(), Some("removed"));
    let removed = sessions
        .save_database(&registry, &db, &store, removed)
        .unwrap();
    assert!(removed
        .profile
        .as_ref()
        .unwrap()
        .connection
        .as_ref()
        .unwrap()
        .secret_ref
        .is_none());
    super::super::apply::apply_registered_validated(
        &registry,
        &db,
        &store,
        removed.profile.as_ref().unwrap(),
        None,
        &files,
        "global",
        Scope::Global,
        false,
    )
    .unwrap();
    let actual = format::parse(
        format::FileKind::Jsonc,
        &std::fs::read_to_string(&files[0].path).unwrap(),
    )
    .unwrap();
    assert!(actual["provider"]["alpha"]["options"]
        .get("apiKey")
        .is_none());
}
#[test]
fn workspace_current_comparison_is_redacted_cas_bound_and_preserves_private_native_credentials() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("db")).unwrap();
    let registry = Registry::builtins();
    let sessions = DraftSessions::default();
    let store = Store::default();
    let files = native(temp.path());
    let mut value: Value = serde_json::from_str(&fixture().files["settings"]).unwrap();
    value["provider"]["alpha"]["options"]["apiKey"] = json!("synthetic-private-current-key");
    std::fs::write(&files[0].path, value.to_string()).unwrap();
    let request = ConfigurationBeginRequest {
        tool_id: "open_code".into(),
        scope: Scope::Global,
        project_path: None,
        session_id: "current".into(),
        subject: ConfigurationSubject::Current,
        profile: None,
    };
    let draft = sessions
        .begin(&registry, &db, request, None, files.clone())
        .unwrap();
    assert!(!serde_json::to_string(&draft)
        .unwrap()
        .contains("synthetic-private-current-key"));
    assert!(store.values.lock().unwrap().is_empty());
    let draft = sessions
        .edit(&registry, draft, action(json!(128000)))
        .unwrap();
    value["provider"]["alpha"]["models"]["safe"]["limit"]["context"] = json!(32000);
    std::fs::write(&files[0].path, value.to_string()).unwrap();
    assert!(sessions
        .save_current(&registry, &db, &store, draft.clone(), &files)
        .is_err());
    let comparison = sessions.compare_current(&registry, draft.clone()).unwrap();
    assert!(!serde_json::to_string(&comparison)
        .unwrap()
        .contains("synthetic-private-current-key"));
    let mut changed = value.clone();
    changed["external"] = json!(true);
    std::fs::write(&files[0].path, changed.to_string()).unwrap();
    let chosen = comparison
        .files
        .iter()
        .map(|file| (file.role.clone(), file.edited.clone()))
        .collect();
    assert!(sessions
        .rebase_current(&registry, draft.clone(), comparison.comparison_id, chosen)
        .is_err());
    let comparison = sessions.compare_current(&registry, draft.clone()).unwrap();
    let chosen = comparison
        .files
        .iter()
        .map(|file| (file.role.clone(), file.edited.clone()))
        .collect();
    let draft = sessions
        .rebase_current(&registry, draft, comparison.comparison_id, chosen)
        .unwrap();
    let saved = sessions
        .save_current(&registry, &db, &store, draft, &files)
        .unwrap();
    let actual = format::parse(
        format::FileKind::Jsonc,
        &std::fs::read_to_string(&files[0].path).unwrap(),
    )
    .unwrap();
    assert_eq!(
        actual["provider"]["alpha"]["options"]["apiKey"],
        "synthetic-private-current-key"
    );
    assert_eq!(
        actual["provider"]["alpha"]["models"]["safe"]["limit"]["context"],
        128000
    );
    assert!(!serde_json::to_string(&saved.draft)
        .unwrap()
        .contains("synthetic-private-current-key"));
    assert!(profile::list_registered_profiles(&db, "open_code")
        .unwrap()
        .is_empty());
    let id = saved.application.unwrap().transaction_id;
    let preview = sessions
        .preview_backup(
            &registry,
            &db,
            &store,
            saved.draft.clone(),
            "settings".into(),
            id.clone(),
        )
        .unwrap();
    assert!(!serde_json::to_string(&preview)
        .unwrap()
        .contains("synthetic-private-current-key"));
    sessions
        .restore_backup(&registry, &db, &store, saved.draft, "settings".into(), id)
        .unwrap();
    let restored = format::parse(
        format::FileKind::Jsonc,
        &std::fs::read_to_string(&files[0].path).unwrap(),
    )
    .unwrap();
    assert_eq!(
        restored["provider"]["alpha"]["options"]["apiKey"],
        "synthetic-private-current-key"
    );
    assert_eq!(
        restored["provider"]["alpha"]["models"]["safe"]["limit"]["context"],
        32000
    );
}
#[test]
fn workspace_common_save_retains_versions_and_apply_rejects_pending_named_changes() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("db")).unwrap();
    let registry = Registry::builtins();
    let store = Store::default();
    let invalid = RegisteredCommon {
        tool: "open_code".into(),
        version: 0,
        revision: String::new(),
        files: BTreeMap::from([("settings".into(), json!({"model":"alpha/safe"}).to_string())]),
    };
    assert!(profile::save_registered_common(&db, &registry, invalid, None).is_err());
    let common = profile::save_registered_common(
        &db,
        &registry,
        RegisteredCommon {
            tool: "open_code".into(),
            version: 0,
            revision: String::new(),
            files: BTreeMap::from([("settings".into(), json!({"theme":"system"}).to_string())]),
        },
        None,
    )
    .unwrap();
    let mut p = fixture();
    p.inherit_common = true;
    let p = profile::save_registered_profile(&db, &registry, p, None).unwrap();
    let files = native(temp.path());
    super::super::apply::apply_registered_validated(
        &registry,
        &db,
        &store,
        &p,
        Some(&common),
        &files,
        "global",
        Scope::Global,
        false,
    )
    .unwrap();
    let original = std::fs::read_to_string(&files[0].path).unwrap();
    let binding = super::super::apply::get_registered_binding(&db, "open_code", "global")
        .unwrap()
        .unwrap();
    assert_eq!(binding.common_version, Some(1));
    let same = profile::save_registered_common(&db, &registry, common.clone(), Some(1)).unwrap();
    assert_eq!(same.version, 2);
    assert_eq!(
        super::super::apply::get_registered_binding(&db, "open_code", "global")
            .unwrap()
            .unwrap()
            .common_version,
        Some(1)
    );
    assert_eq!(std::fs::read_to_string(&files[0].path).unwrap(), original);
    let targets = common_influence(&db, "open_code").unwrap().targets;
    let results = apply_common(
        &registry,
        &db,
        &same,
        &targets,
        |target, profile, binding| {
            super::super::apply::apply_registered_validated_expected(
                &registry,
                &db,
                &store,
                profile,
                Some(&same),
                &files,
                &target.scope_key,
                target.scope,
                binding,
            )
        },
    )
    .unwrap();
    assert!(results.iter().all(|result| result.status != "failed"));
    assert_eq!(
        super::super::apply::get_registered_binding(&db, "open_code", "global")
            .unwrap()
            .unwrap()
            .common_version,
        Some(2)
    );
    let mut pending = p;
    pending.name = "pending new name".into();
    let pending = profile::save_registered_profile(&db, &registry, pending, Some(1)).unwrap();
    assert_eq!(pending.version, 2);
    let targets = common_influence(&db, "open_code").unwrap().targets;
    let mut called = false;
    let results = apply_common(&registry, &db, &same, &targets, |_, _, _| {
        called = true;
        Err("should not dispatch".into())
    })
    .unwrap();
    assert!(!called);
    assert!(results.iter().all(|result| result.status == "failed"));
}

fn account(
    db: &Database,
    registry: &Registry,
    temp: &std::path::Path,
    id: &str,
) -> crate::accounts::NativeContext {
    let root = temp.join(id);
    std::fs::create_dir_all(&root).unwrap();
    let context = registry
        .get("codex")
        .unwrap()
        .accounts()
        .unwrap()
        .context(root, format!("ctx-{id}"))
        .unwrap();
    let value = json!({"id":id,"toolId":"codex","provider":"openai","label":id,"version":1,"state":"signed_in","identity":{"subject":id,"email":null,"plan":null,"source":"synthetic-native"},"context":context,"retiredContexts":[],"pendingLogin":null,"checkedAt":null,"detail":null});
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO auth_accounts(id,tool,version,data) VALUES(?1,'codex',1,?2)",
            rusqlite::params![id, value.to_string()],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
    })
    .unwrap();
    context
}
#[test]
fn workspace_save_only_account_switch_uses_frozen_applied_identity_and_current_project_keeps_it() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("db")).unwrap();
    let registry = Registry::builtins();
    let store = Store::default();
    let a = account(&db, &registry, temp.path(), "a");
    let b = account(&db, &registry, temp.path(), "b");
    let p:RegisteredProfile=serde_json::from_value(json!({"id":"","tool":"codex","name":"account a","version":0,"inheritCommon":false,"authentication":{"kind":"oauth","accountId":"a"},"files":{"settings":"model = \"gpt-5\"\nmodel_provider = \"openai\"\n"},"connection":null,"nativeCredentials":{}})).unwrap();
    let p = profile::save_registered_profile(&db, &registry, p, None).unwrap();
    let fa = vec![crate::adapters::file(
        "settings",
        a.config_root.join("config.toml"),
        format::FileKind::Toml,
        true,
        None,
        false,
    )];
    {
        let _context = crate::accounts::selection::enter(Some(a.clone()));
        super::super::apply::apply_registered_validated(
            &registry,
            &db,
            &store,
            &p,
            None,
            &fa,
            "global",
            Scope::Global,
            false,
        )
        .unwrap();
    }
    let mut pending = p;
    pending.authentication = ProfileAuthentication::OAuth {
        account_id: "b".into(),
    };
    let pending = profile::save_registered_profile(&db, &registry, pending, Some(1)).unwrap();
    let selected =
        crate::accounts::selection::bound(&db, temp.path(), "codex", Scope::Global, None, false)
            .unwrap()
            .unwrap();
    assert_eq!(selected.0, "a");
    assert_eq!(selected.1.id, a.id);
    let impact = crate::accounts::impact(&db, "a").unwrap();
    assert!(impact
        .profiles
        .iter()
        .any(|profile| profile.id == pending.id));
    let project = temp.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    assert_eq!(
        crate::accounts::selection::bound(
            &db,
            temp.path(),
            "codex",
            Scope::Project,
            Some(&project),
            false
        )
        .unwrap()
        .unwrap()
        .1
        .id,
        a.id
    );
    let fp = vec![crate::adapters::file(
        "settings",
        project.join("config.toml"),
        format::FileKind::Toml,
        true,
        None,
        false,
    )];
    std::fs::write(&fp[0].path, "model = \"gpt-5\"\n").unwrap();
    let sessions = DraftSessions::default();
    {
        let _context = crate::accounts::selection::enter(Some(a.clone()));
        let d = sessions
            .begin(
                &registry,
                &db,
                ConfigurationBeginRequest {
                    tool_id: "codex".into(),
                    scope: Scope::Project,
                    project_path: Some(project.to_string_lossy().into()),
                    session_id: "project-current".into(),
                    subject: ConfigurationSubject::Current,
                    profile: None,
                },
                Some(a.id.clone()),
                fp.clone(),
            )
            .unwrap();
        let raw = BTreeMap::from([(
            "settings".into(),
            "model = \"gpt-5\"\nmodel_reasoning_effort = \"high\"\n".into(),
        )]);
        let d = sessions.raw(&registry, d, raw).unwrap();
        sessions
            .save_current(&registry, &db, &store, d, &fp)
            .unwrap();
    }
    let fb = vec![crate::adapters::file(
        "settings",
        b.config_root.join("config.toml"),
        format::FileKind::Toml,
        true,
        None,
        false,
    )];
    {
        let _context = crate::accounts::selection::enter(Some(b.clone()));
        super::super::apply::apply_registered_validated(
            &registry,
            &db,
            &store,
            &pending,
            None,
            &fb,
            "global",
            Scope::Global,
            false,
        )
        .unwrap();
    }
    assert_eq!(
        crate::accounts::selection::bound(&db, temp.path(), "codex", Scope::Global, None, false)
            .unwrap()
            .unwrap()
            .1
            .id,
        b.id
    );
    assert_eq!(
        crate::accounts::selection::bound(
            &db,
            temp.path(),
            "codex",
            Scope::Project,
            Some(&project),
            false
        )
        .unwrap()
        .unwrap()
        .1
        .id,
        a.id
    );
    // A same-version replacement does not overwrite the last applied snapshot.
    db.with_connection(|conn| {
        let mut replaced = pending.clone();
        replaced.authentication = ProfileAuthentication::Native;
        replaced.revision = "same-version-replaced".into();
        conn.execute(
            "UPDATE native_profiles SET data=?1 WHERE id=?2",
            rusqlite::params![serde_json::to_string(&replaced).unwrap(), pending.id],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
    })
    .unwrap();
    assert_eq!(
        crate::accounts::selection::bound(&db, temp.path(), "codex", Scope::Global, None, false)
            .unwrap()
            .unwrap()
            .1
            .id,
        b.id
    );
    db.with_connection(|conn|conn.execute("UPDATE applied_bindings SET applied_profile=NULL WHERE tool='codex' AND scope_key='global'",[]).map(|_|()).map_err(|error|error.to_string())).unwrap();
    assert!(crate::accounts::selection::bound(
        &db,
        temp.path(),
        "codex",
        Scope::Global,
        None,
        false
    )
    .is_err());
}
#[test]
fn workspace_binding_metadata_cas_and_db20_migration_keep_unknown_old_rows() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("db");
    {
        let db = Database::open(&path).unwrap();
        let registry = Registry::builtins();
        let p = profile::save_registered_profile(&db, &registry, fixture(), None).unwrap();
        db.with_connection(|conn|conn.execute("INSERT INTO applied_bindings(scope_key,tool,profile_id,profile_version,managed) VALUES('global','open_code',?1,1,'{}')",[p.id]).map(|_|()).map_err(|error|error.to_string())).unwrap();
        db.with_connection(|conn|conn.execute_batch("ALTER TABLE applied_bindings DROP COLUMN common_version;ALTER TABLE applied_bindings DROP COLUMN common_revision;ALTER TABLE applied_bindings DROP COLUMN applied_profile;PRAGMA user_version=19;").map_err(|error|error.to_string())).unwrap();
    }
    let db = Database::open(&path).unwrap();
    let old = super::super::apply::get_registered_binding(&db, "open_code", "global")
        .unwrap()
        .unwrap();
    assert_eq!(old.profile_version, 1);
    assert!(old.applied_profile.is_none());
    assert!(old.common_version.is_none());
    let registry = Registry::builtins();
    let store = Store::default();
    let p = profile::get_registered_profile(&db, &old.profile_id).unwrap();
    let files = native(temp.path());
    super::super::apply::apply_registered_validated(
        &registry,
        &db,
        &store,
        &p,
        None,
        &files,
        "global",
        Scope::Global,
        false,
    )
    .unwrap();
    let expected = super::super::apply::get_registered_binding(&db, "open_code", "global")
        .unwrap()
        .unwrap();
    let bytes = std::fs::read_to_string(&files[0].path).unwrap();
    db.with_connection(|conn|conn.execute("UPDATE applied_bindings SET common_version=999 WHERE tool='open_code' AND scope_key='global'",[]).map(|_|()).map_err(|error|error.to_string())).unwrap();
    assert!(super::super::apply::apply_registered_validated_expected(
        &registry,
        &db,
        &store,
        &p,
        None,
        &files,
        "global",
        Scope::Global,
        &expected
    )
    .is_err());
    assert_eq!(std::fs::read_to_string(&files[0].path).unwrap(), bytes);
}
#[test]
fn workspace_catalog_mapping_and_legacy_connection_do_not_invent_native_fields() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("db")).unwrap();
    let registry = Registry::builtins();
    let sessions = DraftSessions::default();
    let mut p = fixture();
    p.tool = "kimi_code".into();
    p.files = BTreeMap::from([(
        "settings".into(),
        "[providers.alpha]\ntype='openai'\nbase_url='https://alpha.example/v1'\n".into(),
    )]);
    let mut d = begin(&sessions, &registry, &db, p, "catalog");
    d = sessions
        .edit(
            &registry,
            d,
            ConfigurationAction {
                version: 1,
                target: json!({"kind":"provider","provider":"alpha"}),
                operation: "select_provider".into(),
                field: None,
                value: None,
            },
        )
        .unwrap();
    let d = sessions
        .add_models(&registry, d, vec!["request/x".into(), "request/y".into()])
        .unwrap();
    assert_eq!(d.view["models"].as_array().unwrap().len(), 2);
    assert!(d
        .issues
        .iter()
        .any(|issue| issue.field.as_deref() == Some("max_context_size")));
    let records = sessions.records.lock().unwrap();
    assert!(records["catalog"].draft.profile.files["settings"].contains("model = \"request/x\""));
    drop(records);
    let mut legacy = fixture();
    legacy.tool = "grok".into();
    legacy.files = BTreeMap::new();
    legacy.connection = Some(Connection {
        provider_id: "xai".into(),
        interface_format: "openai_completions".into(),
        base_url: "https://api.x.ai/v1".into(),
        model: "grok-3".into(),
        secret_ref: None,
        auth_env_var: None,
        model_records: Vec::new(),
    });
    let d = begin(&sessions, &registry, &db, legacy, "legacy");
    assert!(d.descriptor.is_none());
    assert!(d.draft_connection.is_some());
    let d = api(&sessions, &registry, &db, d);
    let d = sessions
        .set_secret(&registry, d, "synthetic-generic-key".into())
        .unwrap();
    assert_eq!(d.credential_status.as_deref(), Some("draft"));
    assert!(sessions
        .add_models(&registry, d.clone(), vec!["a".into(), "b".into()])
        .is_err());
    let d = sessions
        .add_models(&registry, d, vec!["grok-4".into()])
        .unwrap();
    assert_eq!(d.draft_connection.as_ref().unwrap().model, "grok-4");
    let store = Store::default();
    let saved = sessions.save_database(&registry, &db, &store, d).unwrap();
    assert_eq!(saved.draft.credential_status.as_deref(), Some("stored"));
    assert_eq!(
        saved
            .profile
            .as_ref()
            .unwrap()
            .connection
            .as_ref()
            .unwrap()
            .model,
        "grok-4"
    );
    let mut changed = saved.draft.profile.clone();
    let mut connection = changed.connection.clone().unwrap();
    connection.model = "grok-raw".into();
    let adapter = registry.get("grok").unwrap();
    let docs = configuration::documents(&registry, &changed).unwrap();
    let overlays = adapter
        .connection_documents_for_existing(&connection, Scope::Global, &docs)
        .unwrap();
    for (role, value) in overlays {
        changed.files.insert(
            role.clone(),
            format::render(adapter.file_kind(&role).unwrap(), &value).unwrap(),
        );
    }
    let edited = sessions.raw(&registry, saved.draft, changed.files).unwrap();
    assert_eq!(edited.draft_connection.as_ref().unwrap().model, "grok-raw");
}

#[test]
fn workspace_current_key_replace_and_remove_are_explicit_without_adopting_a_profile() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("db")).unwrap();
    let registry = Registry::builtins();
    let sessions = DraftSessions::default();
    let store = Store::default();
    let files = native(temp.path());
    let mut value: Value = serde_json::from_str(&fixture().files["settings"]).unwrap();
    value["provider"]["alpha"]["options"]["apiKey"] = json!("synthetic-native-before");
    std::fs::write(&files[0].path, value.to_string()).unwrap();
    let d = sessions
        .begin(
            &registry,
            &db,
            ConfigurationBeginRequest {
                tool_id: "open_code".into(),
                scope: Scope::Global,
                project_path: None,
                session_id: "current-key".into(),
                subject: ConfigurationSubject::Current,
                profile: None,
            },
            None,
            files.clone(),
        )
        .unwrap();
    let d = api(&sessions, &registry, &db, d);
    let d = sessions
        .set_secret(&registry, d, "synthetic-current-replacement".into())
        .unwrap();
    let id = match &d.credential {
        Some(ConfigurationCredential::ApiKey {
            secret_ref: Some(id),
            ..
        }) => id.clone(),
        _ => panic!("no lease"),
    };
    let saved = sessions
        .save_current(&registry, &db, &store, d, &files)
        .unwrap();
    assert!(store.get(&id).is_err());
    assert!(profile::list_registered_profiles(&db, "open_code")
        .unwrap()
        .is_empty());
    assert!(!serde_json::to_string(&saved.draft)
        .unwrap()
        .contains("synthetic-current-replacement"));
    assert!(std::fs::read_to_string(&files[0].path)
        .unwrap()
        .contains("synthetic-current-replacement"));
    let removed = sessions.remove_secret(&registry, saved.draft).unwrap();
    let removed = sessions
        .save_current(&registry, &db, &store, removed, &files)
        .unwrap();
    assert!(format::parse(
        format::FileKind::Jsonc,
        &std::fs::read_to_string(&files[0].path).unwrap()
    )
    .unwrap()["provider"]["alpha"]["options"]
        .get("apiKey")
        .is_none());
    sessions.cancel(&removed.draft.session_id).unwrap();
    assert!(store.get(&id).is_err());
}
#[test]
fn workspace_nonpaid_request_cancel_stops_pagination_and_secret_echo_never_enters_cache() {
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::Arc;
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("db")).unwrap();
    let registry = Registry::builtins();
    let sessions = Arc::new(DraftSessions::default());
    let store = Store::default();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let mut p = fixture();
    let mut value: Value = serde_json::from_str(&p.files["settings"]).unwrap();
    value["provider"]["alpha"]["options"]["baseURL"] = json!(format!("http://{address}/v1"));
    p.files.insert("settings".into(), value.to_string());
    let d = api(
        &sessions,
        &registry,
        &db,
        begin(&sessions, &registry, &db, p, "http"),
    );
    let d = sessions
        .set_secret(&registry, d, "synthetic-request-secret".into())
        .unwrap();
    let server_sessions = sessions.clone();
    let session_id = d.session_id.clone();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut first = String::new();
        reader.read_line(&mut first).unwrap();
        assert!(first.starts_with("GET /v1/models"));
        let mut headers = String::new();
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" {
                break;
            }
            headers.push_str(&line);
        }
        assert!(headers.contains("synthetic-request-secret"));
        server_sessions.cancel(&session_id).unwrap();
        let body = r#"{"data":[{"id":"synthetic-request-secret"},{"id":"safe"}],"has_more":true,"last_id":"safe"}"#;
        write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
    });
    let (c, credential) = sessions.request(&d, &store).unwrap();
    let result = super::super::models::list_models_guarded(&db, &credential, &c, true, "", || {
        !sessions.is_current(&d)
    });
    assert!(result.is_err());
    server.join().unwrap();
    assert!(sessions.finish_request(&d).is_err());
    assert!(store.values.lock().unwrap().is_empty());
    db.with_connection(|conn| {
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM model_cache", [], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        assert_eq!(count, 0);
        Ok(())
    })
    .unwrap();
}
