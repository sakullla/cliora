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
                remote_target_id: None,
                remote_common: None, remote_files: std::collections::BTreeMap::new(),
            },
            None,
            Vec::new(),
            None,
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
    // Directory lookups get a best-effort anonymous attempt for native sources:
    // no credential is copied, and providers that require auth answer 401/403.
    let (anonymous_connection, anonymous_credential) =
        sessions.request_directory(&native, &store).unwrap();
    assert!(anonymous_connection.secret_ref.is_none());
    assert!(anonymous_credential.get("any-ref").is_err());
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
    assert!(store.get(&old_ref).is_err());
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
        remote_target_id: None,
        remote_common: None, remote_files: std::collections::BTreeMap::new(),
    };
    let draft = sessions
        .begin(&registry, &db, request, None, files.clone(), None)
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

#[test]
fn common_save_locks_on_document_version_when_column_is_stale() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("db")).unwrap();
    let registry = Registry::builtins();
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
    let mut drifted = common.clone();
    drifted.version = 2;
    db.with_connection(|conn| {
        conn.execute(
            "UPDATE common_configs SET data=?1 WHERE tool=?2",
            rusqlite::params![serde_json::to_string(&drifted).unwrap(), drifted.tool],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
    })
    .unwrap();
    let column = |db: &Database| {
        db.with_connection(|conn| {
            conn.query_row(
                "SELECT version FROM common_configs WHERE tool='open_code'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap()
    };
    assert_eq!(column(&db), 1);
    assert_eq!(
        profile::get_registered_common(&db, "open_code")
            .unwrap()
            .unwrap()
            .version,
        2
    );
    let rejected = profile::save_registered_common(&db, &registry, drifted.clone(), Some(1)).unwrap_err();
    assert_eq!(rejected, "通用配置已由其他操作修改，请重新读取");
    assert_eq!(column(&db), 1);
    let saved = profile::save_registered_common(&db, &registry, drifted.clone(), Some(2)).unwrap();
    assert_eq!(saved.version, 3);
    assert_ne!(saved.revision, drifted.revision);
    assert_eq!(column(&db), 3);
    assert_eq!(
        profile::get_registered_common(&db, "open_code").unwrap().unwrap().files,
        saved.files
    );
    let stale = profile::save_registered_common(&db, &registry, saved.clone(), Some(2)).unwrap_err();
    assert_eq!(stale, "通用配置已由其他操作修改，请重新读取");
    let mut wrong_revision = saved.clone();
    wrong_revision.revision = "other-revision".into();
    let conflict = profile::save_registered_common(&db, &registry, wrong_revision, Some(saved.version)).unwrap_err();
    assert_eq!(conflict, "通用配置已由其他操作修改，请重新读取");
    assert_eq!(column(&db), 3);
    assert_eq!(
        profile::get_registered_common(&db, "open_code")
            .unwrap()
            .unwrap()
            .version,
        3
    );
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
                    remote_target_id: None,
                    remote_common: None, remote_files: std::collections::BTreeMap::new(),
                },
                Some(a.id.clone()),
                fp.clone(),
                None,
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
                remote_target_id: None,
                remote_common: None, remote_files: std::collections::BTreeMap::new(),
            },
            None,
            files.clone(),
            None,
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
    let server_draft = d.clone();
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
        let cancelled = server_sessions.cancel_requests(server_draft).unwrap();
        let body = r#"{"data":[{"id":"synthetic-request-secret"},{"id":"safe"}],"has_more":true,"last_id":"safe"}"#;
        write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
        (cancelled, listener)
    });
    let (c, credential) = sessions.request(&d, &store).unwrap();
    let result = super::super::models::list_models_guarded(&db, &credential, &c, true, "", || {
        !sessions.is_current(&d)
    });
    assert!(result.is_err());
    let (cancelled, listener) = server.join().unwrap();
    listener.set_nonblocking(true).unwrap();
    assert_eq!(listener.accept().unwrap_err().kind(), std::io::ErrorKind::WouldBlock);
    assert_eq!(cancelled.revision, d.revision);
    assert_eq!(cancelled.request_generation, d.request_generation + 1);
    assert_eq!(cancelled.profile.files, d.profile.files);
    assert_eq!(cancelled.credential, d.credential);
    assert!(sessions.is_current(&cancelled));
    assert!(sessions.request(&cancelled, &store).is_ok());
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

#[test]
fn workspace_request_only_cancel_between_get_and_confirmed_post_retains_editable_lease() {
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
        begin(&sessions, &registry, &db, p, "post-cancel"),
    );
    let d = sessions
        .set_secret(&registry, d, "synthetic-confirmed-key".into())
        .unwrap();
    let server_sessions = sessions.clone();
    let server_draft = d.clone();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert!(line.starts_with("GET /v1/models"));
        loop {
            line.clear();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" {
                break;
            }
        }
        let cancelled = server_sessions.cancel_requests(server_draft).unwrap();
        let body = r#"{"data":[{"id":"safe"}]}"#;
        write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
        (cancelled, listener)
    });
    let (connection, credential) = sessions.request(&d, &store).unwrap();
    let result = super::super::models::test_registered_connection_guarded(
        &registry,
        "open_code",
        &connection,
        &credential,
        true,
        || !sessions.is_current(&d),
    );
    assert_eq!(result.model_request.state, "skipped");
    assert!(result.model_request.message.contains("取消"));
    assert!(sessions.finish_request(&d).is_err());
    let (cancelled, listener) = server.join().unwrap();
    listener.set_nonblocking(true).unwrap();
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    assert_eq!(cancelled.revision, d.revision);
    assert_eq!(cancelled.credential, d.credential);
    let next = sessions
        .edit(&registry, cancelled, action(json!(70000)))
        .unwrap();
    assert_eq!(next.revision, d.revision + 1);
    assert_eq!(
        sessions.reveal_secret(&next, &store).unwrap(),
        "synthetic-confirmed-key"
    );
    let saved = sessions
        .save_database(&registry, &db, &store, next)
        .unwrap();
    assert!(saved
        .profile
        .unwrap()
        .connection
        .unwrap()
        .secret_ref
        .is_some());
}

#[test]
fn workspace_legacy_oauth_migration_opens_saved_draft_and_recovers_only_on_explicit_apply() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("db");
    let registry = Registry::builtins();
    let (saved, context) = {
        let db = Database::open(&path).unwrap();
        let context = account(&db, &registry, temp.path(), "legacy");
        let p: RegisteredProfile = serde_json::from_value(json!({"id":"","tool":"codex","name":"legacy","version":0,"inheritCommon":false,"authentication":{"kind":"oauth","accountId":"legacy"},"files":{"settings":"model = \"old-model\"\n"},"connection":null,"nativeCredentials":{}})).unwrap();
        let p = profile::save_registered_profile(&db, &registry, p, None).unwrap();
        db.with_connection(|conn| {
            conn.execute("INSERT INTO applied_bindings(scope_key,tool,profile_id,profile_version,managed,context_id) VALUES('global','codex',?1,?2,'{}',?3)", rusqlite::params![p.id, p.version as i64, context.id]).map_err(|error|error.to_string())?;
            conn.execute_batch("ALTER TABLE applied_bindings DROP COLUMN common_version;ALTER TABLE applied_bindings DROP COLUMN common_revision;ALTER TABLE applied_bindings DROP COLUMN applied_profile;PRAGMA user_version=19;").map_err(|error|error.to_string())
        }).unwrap();
        (p, context)
    };
    let db = Database::open(&path).unwrap();
    let saved_workspace = saved_workspace(&registry, &db, "codex", "global").unwrap();
    assert_eq!(saved_workspace.profiles[0].revision, saved.revision);
    assert!(!saved_workspace.binding.unwrap().applied_profile_available);
    let impact = crate::accounts::impact(&db, "legacy").unwrap();
    assert!(impact.scopes[0].needs_reapply);
    assert!(impact.scopes[0].can_reapply);
    assert!(impact.scopes[0].reapply_request.is_some());
    let sessions = DraftSessions::default();
    let request = ConfigurationBeginRequest {
        tool_id: "codex".into(),
        scope: Scope::Global,
        project_path: None,
        session_id: "legacy-saved".into(),
        subject: ConfigurationSubject::Profile,
        profile: Some(saved.clone()),
        remote_target_id: None,
        remote_common: None, remote_files: std::collections::BTreeMap::new(),
    };
    let draft = sessions
        .begin_registered(&registry, &db, request, temp.path(), None)
        .unwrap();
    assert!(draft.issues.is_empty());
    assert!(draft.context_id.is_none());
    let current = ConfigurationBeginRequest {
        tool_id: "codex".into(),
        scope: Scope::Global,
        project_path: None,
        session_id: "legacy-current".into(),
        subject: ConfigurationSubject::Current,
        profile: None,
        remote_target_id: None,
        remote_common: None, remote_files: std::collections::BTreeMap::new(),
    };
    assert!(sessions
        .begin_registered(&registry, &db, current, temp.path(), None)
        .unwrap_err()
        .contains("不会退回默认目录"));
    assert!(crate::accounts::selection::bound(
        &db,
        temp.path(),
        "codex",
        Scope::Global,
        None,
        false
    )
    .is_err());
    let files = vec![crate::adapters::file(
        "settings",
        context.config_root.join("config.toml"),
        format::FileKind::Toml,
        true,
        None,
        false,
    )];
    let store = Store::default();
    {
        let _context = crate::accounts::selection::enter(Some(context.clone()));
        super::super::apply::apply_registered_validated(
            &registry,
            &db,
            &store,
            &saved,
            None,
            &files,
            "global",
            Scope::Global,
            false,
        )
        .unwrap();
    }
    let recovered =
        crate::accounts::selection::bound(&db, temp.path(), "codex", Scope::Global, None, false)
            .unwrap()
            .unwrap();
    assert_eq!(recovered.1.id, context.id);
    assert!(!crate::accounts::impact(&db, "legacy").unwrap().scopes[0].needs_reapply);
    assert!(
        super::super::apply::get_registered_binding(&db, "codex", "global")
            .unwrap()
            .unwrap()
            .applied_profile_available
    );
}

#[test]
fn workspace_new_profile_defaults_to_api_key_when_tool_has_no_accounts() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("db")).unwrap();
    let registry = Registry::builtins();
    let sessions = DraftSessions::default();
    let draft = sessions
        .begin(
            &registry,
            &db,
            ConfigurationBeginRequest {
                tool_id: "claude_code".into(),
                scope: Scope::Global,
                project_path: None,
                session_id: "api-key-default".into(),
                subject: ConfigurationSubject::Profile,
                profile: Some(profile_from_files("claude_code", BTreeMap::new())),
                remote_target_id: None,
                remote_common: None, remote_files: std::collections::BTreeMap::new(),
            },
            None,
            Vec::new(),
            None,
        )
        .unwrap();
    assert!(
        matches!(
            draft.credential,
            Some(ConfigurationCredential::ApiKey { secret_ref: None, .. })
        ),
        "无账号工具的新建配置应默认 API 密钥来源：{:?}",
        draft.credential
    );
}

#[test]
fn workspace_claude_catalog_and_common_execute_real_edit_save_reopen_apply_chain() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("db")).unwrap();
    let registry = Registry::builtins();
    let sessions = DraftSessions::default();
    let store = Store::default();
    for local in [false, true] {
        let mut p = profile_from_files(
            "claude_code",
            BTreeMap::from([("settings".into(), json!({"model":"global-old"}).to_string())]),
        );
        if local {
            p.files.insert(
                "local_settings".into(),
                json!({"model":"local-old"}).to_string(),
            );
        }
        let d = sessions
            .begin(
                &registry,
                &db,
                ConfigurationBeginRequest {
                    tool_id: p.tool.clone(),
                    scope: if local { Scope::Project } else { Scope::Global },
                    project_path: None,
                    session_id: format!("claude-catalog-{local}"),
                    subject: ConfigurationSubject::Profile,
                    profile: Some(p),
                    remote_target_id: None,
                    remote_common: None, remote_files: std::collections::BTreeMap::new(),
                },
                None,
                Vec::new(),
                None,
            )
            .unwrap();
        let d = sessions
            .add_models(&registry, d, vec!["claude-sonnet-4-6".into()])
            .unwrap();
        assert!(d.issues.is_empty(), "{:?}", d.issues);
        assert_eq!(d.view["values"]["default.model"], "claude-sonnet-4-6");
        // This chain predates the api_key default for account-less tools; keep
        // it on the native source so it exercises catalog/save, not credentials.
        let d = sessions
            .select_credential(&registry, &db, d, ConfigurationCredential::Native)
            .unwrap();
        let role = if local { "local_settings" } else { "settings" };
        assert_eq!(
            serde_json::from_str::<Value>(&d.profile.files[role]).unwrap()["model"],
            "claude-sonnet-4-6"
        );
        let saved = sessions
            .save_database(&registry, &db, &store, d)
            .unwrap()
            .profile
            .unwrap();
        let reopened = begin(
            &sessions,
            &registry,
            &db,
            saved.clone(),
            &format!("claude-reopen-{local}"),
        );
        assert_eq!(
            reopened.view["values"]["default.model"],
            "claude-sonnet-4-6"
        );
        let files = saved
            .files
            .keys()
            .map(|role| {
                crate::adapters::file(
                    if role == "settings" {
                        "settings"
                    } else {
                        "local_settings"
                    },
                    temp.path().join(format!("claude-{local}-{role}.json")),
                    format::FileKind::Json,
                    true,
                    None,
                    false,
                )
            })
            .collect::<Vec<_>>();
        super::super::apply::apply_registered_validated(
            &registry,
            &db,
            &store,
            &saved,
            None,
            &files,
            &format!("catalog-{local}"),
            if local { Scope::Project } else { Scope::Global },
            false,
        )
        .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(
                &std::fs::read_to_string(
                    &files.iter().find(|file| file.role == role).unwrap().path
                )
                .unwrap()
            )
            .unwrap()["model"],
            "claude-sonnet-4-6"
        );
    }
    let common = sessions
        .begin(
            &registry,
            &db,
            ConfigurationBeginRequest {
                tool_id: "claude_code".into(),
                scope: Scope::Project,
                project_path: None,
                session_id: "claude-common".into(),
                subject: ConfigurationSubject::Common,
                profile: None,
                remote_target_id: None,
                remote_common: None, remote_files: std::collections::BTreeMap::new(),
            },
            None,
            Vec::new(),
            None,
        )
        .unwrap();
    assert!(common
        .descriptor
        .as_ref()
        .unwrap()
        .fields
        .iter()
        .any(|field| field.id == "effortLevel"));
    assert_eq!(common.view["commonFields"][0]["id"], "effortLevel");
    let common = sessions
        .edit(
            &registry,
            common,
            ConfigurationAction {
                version: 1,
                target: json!("configuration"),
                operation: "set".into(),
                field: Some("effortLevel".into()),
                value: Some(json!("high")),
            },
        )
        .unwrap();
    let mut legal_files = common.profile.files.clone();
    legal_files.insert(
        "local_settings".into(),
        json!({"effortLevel":"medium","permissions":{"allow":["Read"]}}).to_string(),
    );
    let common = sessions.raw(&registry, common, legal_files).unwrap();
    assert!(common.issues.is_empty(), "{:?}", common.issues);
    let saved_common = sessions
        .save_database(&registry, &db, &store, common)
        .unwrap()
        .common
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&saved_common.files["settings"]).unwrap()["effortLevel"],
        "high"
    );
    let reopened_common = sessions.begin(&registry, &db, ConfigurationBeginRequest {
        tool_id: "claude_code".into(), scope: Scope::Global, project_path: None,
        session_id: "claude-common-reopen".into(), subject: ConfigurationSubject::Common, profile: None,
        remote_target_id: None, remote_common: None, remote_files: std::collections::BTreeMap::new(),
    }, None, Vec::new(), None).unwrap();
    assert_eq!(reopened_common.view["commonFields"][0]["value"], "high");
    assert_eq!(reopened_common.profile.revision, saved_common.revision);
    let mut p = profile_from_files(
        "claude_code",
        BTreeMap::from([("settings".into(), json!({"model":"own-model"}).to_string())]),
    );
    p.inherit_common = true;
    let saved = sessions
        .save_database(
            &registry,
            &db,
            &store,
            sessions
                .select_credential(
                    &registry,
                    &db,
                    begin(&sessions, &registry, &db, p, "claude-inherited"),
                    ConfigurationCredential::Native,
                )
                .unwrap(),
        )
        .unwrap()
        .profile
        .unwrap();
    let reopened = begin(
        &sessions,
        &registry,
        &db,
        saved.clone(),
        "claude-inherited-reopen",
    );
    assert_eq!(reopened.view["values"]["effortLevel"], "medium");
    let files = vec![
        crate::adapters::file(
            "settings",
            temp.path().join("inherited-settings.json"),
            format::FileKind::Json,
            true,
            None,
            false,
        ),
        crate::adapters::file(
            "local_settings",
            temp.path().join("inherited-local-settings.json"),
            format::FileKind::Json,
            true,
            None,
            false,
        ),
    ];
    super::super::apply::apply_registered_validated(
        &registry,
        &db,
        &store,
        &saved,
        Some(&saved_common),
        &files,
        "inherited",
        Scope::Project,
        false,
    )
    .unwrap();
    let applied: Value =
        serde_json::from_str(&std::fs::read_to_string(&files[0].path).unwrap()).unwrap();
    assert_eq!(applied["effortLevel"], "high");
    assert_eq!(applied["model"], "own-model");
    let local: Value =
        serde_json::from_str(&std::fs::read_to_string(&files[1].path).unwrap()).unwrap();
    assert_eq!(local["effortLevel"], "medium");
    assert_eq!(local["permissions"]["allow"], json!(["Read"]));
    assert!(local.get("model").is_none());
    for role in ["settings", "local_settings"] {
        for reference in [
            json!({"model":"sonnet"}),
            json!({"env":{"ANTHROPIC_MODEL":"sonnet"}}),
        ] {
            let d = sessions
                .begin(
                    &registry,
                    &db,
                    ConfigurationBeginRequest {
                        tool_id: "claude_code".into(),
                        scope: Scope::Project,
                        project_path: None,
                        session_id: format!("invalid-{role}-{}", reference.get("env").is_some()),
                        subject: ConfigurationSubject::Common,
                        profile: None,
                        remote_target_id: None,
                        remote_common: None, remote_files: std::collections::BTreeMap::new(),
                    },
                    None,
                    Vec::new(),
                    None,
                )
                .unwrap();
            let d = sessions
                .raw(
                    &registry,
                    d,
                    BTreeMap::from([(role.into(), reference.to_string())]),
                )
                .unwrap();
            assert!(d.issues.iter().any(|issue| issue.code == "common_scope"));
            assert!(sessions.save_database(&registry, &db, &store, d).is_err());
        }
    }
    assert_eq!(
        profile::get_registered_common(&db, "claude_code")
            .unwrap()
            .unwrap()
            .revision,
        saved_common.revision
    );
}

#[test]
fn workspace_generic_current_protects_parent_and_owns_explicit_native_key_target() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("db")).unwrap();
    let registry = Registry::builtins();
    let sessions = DraftSessions::default();
    let store = Store::default();
    let files = vec![crate::adapters::file(
        "settings",
        temp.path().join("codebuddy-settings.json"),
        format::FileKind::Json,
        true,
        None,
        false,
    )];
    let original=json!({"model":"m","apiKeyHelper":"keep-helper","env":{"CODEBUDDY_API_KEY":"synthetic-key","USER_OPTION":"x"}}).to_string();
    std::fs::write(&files[0].path, &original).unwrap();
    let d = sessions
        .begin(
            &registry,
            &db,
            ConfigurationBeginRequest {
                tool_id: "codebuddy".into(),
                scope: Scope::Global,
                project_path: None,
                session_id: "codebuddy-current".into(),
                subject: ConfigurationSubject::Current,
                profile: None,
                remote_target_id: None,
                remote_common: None, remote_files: std::collections::BTreeMap::new(),
            },
            None,
            files.clone(),
            None,
        )
        .unwrap();
    assert!(!serde_json::to_string(&d).unwrap().contains("synthetic-key"));
    assert!(d.native_credential_target.is_some());
    assert!(d.draft_connection.is_none());
    assert!(!d.catalog_support.as_ref().unwrap().available);
    assert!(store.values.lock().unwrap().is_empty());
    let original_public = d.profile.files.clone();
    let mut next = d;
    for edited in [
        json!({"model":"m","apiKeyHelper":"keep-helper"}),
        json!({"model":"m","apiKeyHelper":"keep-helper","env":"overwrite"}),
    ] {
        next = sessions
            .raw(
                &registry,
                next,
                BTreeMap::from([("settings".into(), edited.to_string())]),
            )
            .unwrap();
        assert!(sessions
            .save_current(&registry, &db, &store, next.clone(), &files)
            .unwrap_err()
            .contains("受保护"));
        assert_eq!(std::fs::read_to_string(&files[0].path).unwrap(), original);
    }
    next = sessions.raw(&registry, next, original_public).unwrap();
    let mut public: Value = serde_json::from_str(&next.profile.files["settings"]).unwrap();
    public["env"]["USER_OPTION"] = json!("edited");
    next = sessions
        .raw(
            &registry,
            next,
            BTreeMap::from([("settings".into(), public.to_string())]),
        )
        .unwrap();
    let saved = sessions
        .save_current(&registry, &db, &store, next, &files)
        .unwrap();
    let file: Value =
        serde_json::from_str(&std::fs::read_to_string(&files[0].path).unwrap()).unwrap();
    assert_eq!(file["env"]["CODEBUDDY_API_KEY"], "synthetic-key");
    assert_eq!(file["env"]["USER_OPTION"], "edited");
    let d = api(&sessions, &registry, &db, saved.draft);
    assert!(sessions
        .request(&d, &store)
        .err()
        .unwrap()
        .contains("不授权 HTTP"));
    let mut forged = d.clone();
    forged.native_credential_target.as_mut().unwrap().identity = "foreign-native-target".into();
    assert!(sessions.set_secret(&registry, forged, "synthetic-forged-key".into()).is_err());
    let replaced = sessions.set_secret(&registry, d, "synthetic-replacement-key".into()).unwrap();
    let replaced = sessions.save_current(&registry, &db, &store, replaced, &files).unwrap();
    let file: Value = serde_json::from_str(&std::fs::read_to_string(&files[0].path).unwrap()).unwrap();
    assert_eq!(file["env"]["CODEBUDDY_AUTH_TOKEN"], "synthetic-replacement-key");
    assert!(file["env"].get("CODEBUDDY_API_KEY").is_none());
    assert_eq!(file["env"]["USER_OPTION"], "edited");
    assert!(!serde_json::to_string(&replaced).unwrap().contains("synthetic-replacement-key"));
    let d = sessions.remove_secret(&registry, replaced.draft).unwrap();
    let saved = sessions
        .save_current(&registry, &db, &store, d, &files)
        .unwrap();
    let file: Value =
        serde_json::from_str(&std::fs::read_to_string(&files[0].path).unwrap()).unwrap();
    assert!(file["env"].get("CODEBUDDY_API_KEY").is_none());
    assert_eq!(file["apiKeyHelper"], "keep-helper");
    let d = sessions
        .set_secret(&registry, saved.draft, "synthetic-new-native-key".into())
        .unwrap();
    assert_eq!(
        sessions.reveal_secret(&d, &store).unwrap(),
        "synthetic-new-native-key"
    );
    assert!(!store
        .values
        .lock()
        .unwrap()
        .values()
        .any(|secret| secret == "synthetic-new-native-key"));
    let saved = sessions
        .save_current(&registry, &db, &store, d, &files)
        .unwrap();
    assert!(!serde_json::to_string(&saved)
        .unwrap()
        .contains("synthetic-new-native-key"));
    let file: Value =
        serde_json::from_str(&std::fs::read_to_string(&files[0].path).unwrap()).unwrap();
    assert_eq!(
        file["env"]["CODEBUDDY_AUTH_TOKEN"],
        "synthetic-new-native-key"
    );
    assert_eq!(file["env"]["USER_OPTION"], "edited");
    let reopened = sessions
        .begin(
            &registry,
            &db,
            ConfigurationBeginRequest {
                tool_id: "codebuddy".into(),
                scope: Scope::Global,
                project_path: None,
                session_id: "codebuddy-reopen".into(),
                subject: ConfigurationSubject::Current,
                profile: None,
                remote_target_id: None,
                remote_common: None, remote_files: std::collections::BTreeMap::new(),
            },
            None,
            files,
            None,
        )
        .unwrap();
    assert!(!serde_json::to_string(&reopened)
        .unwrap()
        .contains("synthetic-new-native-key"));
    assert_eq!(reopened.credential, Some(ConfigurationCredential::Native));
    assert!(sessions.request(&reopened, &store).is_err());
}

#[test]
fn workspace_saved_and_frozen_models_are_independent_of_oauth_or_builtin_http_connection() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("db")).unwrap();
    let registry = Registry::builtins();
    let sessions = DraftSessions::default();
    let store = Store::default();
    let context = account(&db, &registry, temp.path(), "summary-account");
    for oauth in [false, true] {
        let mut p = profile_from_files(
            "codex",
            BTreeMap::from([(
                "settings".into(),
                "model = \"model-first\"\nmodel_provider = \"openai\"\n".into(),
            )]),
        );
        if oauth {
            p.authentication = ProfileAuthentication::OAuth {
                account_id: "summary-account".into(),
            };
        }
        let d = begin(
            &sessions,
            &registry,
            &db,
            p.clone(),
            &format!("summary-first-{oauth}"),
        );
        let saved = sessions
            .save_database(&registry, &db, &store, d)
            .unwrap()
            .profile
            .unwrap();
        assert!(saved.connection.is_none());
        let d = begin(
            &sessions,
            &registry,
            &db,
            saved.clone(),
            &format!("summary-open-{oauth}"),
        );
        let mut twin = p;
        twin.files.insert(
            "settings".into(),
            "model = \"model-twin\"\nmodel_provider = \"openai\"\n".into(),
        );
        let twin = sessions
            .save_database(
                &registry,
                &db,
                &store,
                begin(
                    &sessions,
                    &registry,
                    &db,
                    twin,
                    &format!("summary-twin-{oauth}"),
                ),
            )
            .unwrap()
            .profile
            .unwrap();
        let summaries = saved_workspace(&registry, &db, "codex", "global")
            .unwrap()
            .profile_model_summaries;
        assert_eq!(summaries[&saved.id].as_ref().unwrap().model, "model-first");
        assert_eq!(summaries[&twin.id].as_ref().unwrap().model, "model-twin");
        let files = vec![crate::adapters::file(
            "settings",
            temp.path().join(format!("summary-{oauth}.toml")),
            format::FileKind::Toml,
            true,
            None,
            false,
        )];
        let _context =
            crate::accounts::selection::enter(if oauth { Some(context.clone()) } else { None });
        let key = format!("summary-{oauth}");
        super::super::apply::apply_registered_validated(
            &registry,
            &db,
            &store,
            &saved,
            None,
            &files,
            &key,
            Scope::Global,
            false,
        )
        .unwrap();
        let edited = sessions
            .raw(
                &registry,
                d,
                BTreeMap::from([(
                    "settings".into(),
                    "model = \"model-pending\"\nmodel_provider = \"openai\"\n".into(),
                )]),
            )
            .unwrap();
        let pending = sessions
            .save_database(&registry, &db, &store, edited)
            .unwrap()
            .profile
            .unwrap();
        let binding = super::super::apply::get_registered_binding(&db, "codex", &key)
            .unwrap()
            .unwrap();
        let summary = binding.applied_summary.as_ref().unwrap();
        assert_eq!(summary.model.as_deref(), Some("model-first"));
        assert_eq!(summary.profile_version, saved.version);
        assert_eq!(summary.profile_revision, saved.revision);
        assert_eq!(summary.authentication, saved.authentication);
        assert_eq!(
            summary.context_id,
            if oauth {
                Some(context.id.clone())
            } else {
                None
            }
        );
        assert!(binding.applied_profile_available);
        assert!(binding.common_version.is_none());
        assert!(binding.common_revision.is_none());
        let mut replaced = pending.clone();
        replaced.revision = "same-version-new-model".into();
        replaced.files.insert(
            "settings".into(),
            "model = \"model-replaced\"\nmodel_provider = \"openai\"\n".into(),
        );
        db.with_connection(|conn| {
            conn.execute(
                "UPDATE native_profiles SET data=?1 WHERE id=?2",
                rusqlite::params![serde_json::to_string(&replaced).unwrap(), replaced.id],
            )
            .map(|_| ())
            .map_err(|error| error.to_string())
        })
        .unwrap();
        assert_eq!(
            saved_workspace(&registry, &db, "codex", &key)
                .unwrap()
                .profile_model_summaries[&saved.id]
                .as_ref()
                .unwrap()
                .model,
            "model-replaced"
        );
        assert_eq!(
            super::super::apply::get_registered_binding(&db, "codex", &key)
                .unwrap()
                .unwrap()
                .applied_summary
                .unwrap()
                .model
                .as_deref(),
            Some("model-first")
        );
        assert_eq!(
            format::parse(
                format::FileKind::Toml,
                &std::fs::read_to_string(&files[0].path).unwrap()
            )
            .unwrap()["model"],
            "model-first"
        );
        super::super::apply::apply_registered_validated(
            &registry,
            &db,
            &store,
            &replaced,
            None,
            &files,
            &key,
            Scope::Global,
            false,
        )
        .unwrap();
        assert_eq!(
            super::super::apply::get_registered_binding(&db, "codex", &key)
                .unwrap()
                .unwrap()
                .applied_summary
                .unwrap()
                .model
                .as_deref(),
            Some("model-replaced")
        );
    }
}

#[test]
fn workspace_request_cancel_without_transport_keeps_lease_blocks_old_guards_and_saves() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("db")).unwrap();
    let registry = Registry::builtins();
    let sessions = DraftSessions::default();
    let store = Store::default();
    let d = api(
        &sessions,
        &registry,
        &db,
        begin(&sessions, &registry, &db, fixture(), "guard-only"),
    );
    let d = sessions
        .set_secret(&registry, d, "synthetic-guard-key".into())
        .unwrap();
    let (connection, credential) = sessions.request(&d, &store).unwrap();
    let cancelled = sessions.cancel_requests(d.clone()).unwrap();
    assert_eq!(cancelled.revision, d.revision);
    assert_eq!(cancelled.profile.files, d.profile.files);
    assert_eq!(cancelled.credential, d.credential);
    assert_eq!(cancelled.request_generation, d.request_generation + 1);
    assert!(super::super::models::list_models_guarded(
        &db,
        &credential,
        &connection,
        true,
        "",
        || !sessions.is_current(&d)
    )
    .unwrap_err()
    .contains("取消"));
    let check = super::super::models::test_registered_connection_guarded(
        &registry,
        "open_code",
        &connection,
        &credential,
        true,
        || !sessions.is_current(&d),
    );
    assert_eq!(check.connectivity.state, "skipped");
    assert_eq!(check.model_request.state, "skipped");
    assert!(sessions.finish_request(&d).is_err());
    assert!(sessions.finish_request(&cancelled).is_ok());
    assert_eq!(
        sessions.reveal_secret(&cancelled, &store).unwrap(),
        "synthetic-guard-key"
    );
    db.with_connection(|conn| {
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM model_cache", [], |row| row
                .get::<_, i64>(0))
                .map_err(|error| error.to_string())?,
            0
        );
        Ok(())
    })
    .unwrap();
    let edited = sessions
        .edit(&registry, cancelled, action(json!(70000)))
        .unwrap();
    let saved = sessions
        .save_database(&registry, &db, &store, edited)
        .unwrap()
        .profile
        .unwrap();
    assert_eq!(
        store
            .get(
                saved
                    .connection
                    .as_ref()
                    .unwrap()
                    .secret_ref
                    .as_deref()
                    .unwrap()
            )
            .unwrap(),
        "synthetic-guard-key"
    );
}

#[test]
fn open_code_drafts_resolve_the_native_form_from_the_selected_installation() {
    // The 1.x line keeps the v1 keys; the 2.x line writes v2 native keys from
    // the same editor actions. Both forms come from the resolved installation.
    for (version, form, providers_key, protocol_key, modality_key) in [
        ("1.18.34", "v1", "provider", "npm", "modalities"),
        ("2.0.29", "v2", "providers", "package", "capabilities"),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("db")).unwrap();
        let store = Store::default();
        let sessions = DraftSessions::default();
        let registry = Registry::builtins().with_fixture_installation("open_code", version);
        let request = ConfigurationBeginRequest {
            tool_id: "open_code".into(),
            scope: Scope::Global,
            project_path: None,
            session_id: format!("form-{form}"),
            subject: ConfigurationSubject::Profile,
            profile: Some(fixture()),
            remote_target_id: None,
            remote_common: None, remote_files: std::collections::BTreeMap::new(),
        };
        let mut draft = sessions
            .begin_registered(&registry, &db, request, temp.path(), None)
            .unwrap();
        assert!(draft.issues.is_empty(), "{form}: {:?}", draft.issues);
        assert_eq!(
            draft.profile.editing.as_ref().unwrap().native_form.as_deref(),
            Some(form)
        );
        draft = sessions
            .edit(
                &registry,
                draft,
                ConfigurationAction {
                    version: 1,
                    target: json!({"kind":"model","provider":"alpha","id":"fresh"}),
                    operation: "create".into(),
                    field: None,
                    value: Some(json!({"name":"Fresh","limit":{"context":1000,"output":10},"modalities":{"input":["text"],"output":["text"]}})),
                },
            )
            .unwrap();
        let saved = crate::native::profile::save_registered_profile(
            &db,
            &registry,
            draft.profile.clone(),
            None,
        )
        .unwrap();
        let files = native(temp.path());
        super::super::apply::apply_registered_validated(
            &registry,
            &db,
            &store,
            &saved,
            None,
            &files,
            "global",
            Scope::Global,
            false,
        )
        .unwrap();
        let parsed = format::parse(
            format::FileKind::Jsonc,
            &std::fs::read_to_string(&files[0].path).unwrap(),
        )
        .unwrap();
        assert_eq!(parsed[providers_key]["alpha"]["models"]["fresh"]["name"], "Fresh", "{form}");
        assert!(parsed[providers_key]["alpha"][protocol_key].is_string(), "{form}");
        assert_eq!(
            parsed[providers_key]["alpha"]["models"]["fresh"][modality_key]["input"],
            json!(["text"]),
            "{form}"
        );
        if form == "v2" {
            assert!(parsed.get("provider").is_none(), "{form}");
        }
    }
}

#[test]
fn remote_codex_draft_keeps_host_text_and_opens_the_dedicated_editor() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("db")).unwrap();
    let registry = Registry::builtins();
    let sessions = DraftSessions::default();
    let settings = "\
model = \"gpt-6-astra\"
model_provider = \"openai-custom\"

[model_providers]

[model_providers.openai-custom]
base_url = \"https://cpa.example.test/v1\"
name = \"openai-custom\"
wire_api = \"responses\"
supports_standalone_web_search = true
experimental_bearer_token = \"synthetic-bearer-token\"

[model_providers.openai-custom.capabilities]
external_web_access = true
";
    let common = RegisteredCommon {
        tool: "codex".into(),
        version: 1,
        revision: String::new(),
        files: BTreeMap::from([("settings".into(), "model_reasoning_effort = \"high\"\n".into())]),
    };
    let profile = serde_json::from_value(json!({
        "editing": {"version": 1, "selectedProvider": "openai-custom", "intents": []},
        "id": "remote-profile",
        "tool": "codex",
        "name": "新配置 2",
        "version": 3,
        "revision": "rev",
        "inheritCommon": false,
        "files": {"settings": settings.replace("experimental_bearer_token = \"synthetic-bearer-token\"\n", "")},
        "authentication": {"kind": "api_key"},
        "connection": {
            "providerId": "openai-custom",
            "interfaceFormat": "openai_responses",
            "baseUrl": "https://cpa.example.test/v1",
            "model": "gpt-6-astra",
            "secretRef": null,
            "authEnvVar": "CLIORA_CODEX_OPENAI_API_KEY"
        },
        "nativeCredentials": {}
    }))
    .unwrap();
    let opened = sessions
        .begin(
            &registry,
            &db,
            ConfigurationBeginRequest {
                tool_id: "codex".into(),
                scope: Scope::Global,
                project_path: None,
                session_id: "remote-profile".into(),
                subject: ConfigurationSubject::Profile,
                profile: Some(profile),
                remote_target_id: Some("remote-host".into()),
                remote_common: Some(common.clone()),
                remote_files: BTreeMap::new(),
            },
            None,
            Vec::new(),
            None,
        )
        .unwrap();
    assert!(
        opened.descriptor.as_ref().is_some_and(|descriptor| !descriptor.fields.is_empty()),
        "{:?}",
        opened.issues
    );
    assert!(opened.profile.files["settings"].contains("gpt-6-astra"));

    let fresh = serde_json::from_value(json!({
        "id": "",
        "tool": "codex",
        "name": "新配置",
        "version": 0,
        "inheritCommon": false,
        "files": {},
        "suppressed": {},
        "connection": null,
        "nativeCredentials": {}
    }))
    .unwrap();
    let created = sessions
        .begin(
            &registry,
            &db,
            ConfigurationBeginRequest {
                tool_id: "codex".into(),
                scope: Scope::Global,
                project_path: None,
                session_id: "remote-new".into(),
                subject: ConfigurationSubject::Profile,
                profile: Some(fresh),
                remote_target_id: Some("remote-host".into()),
                remote_common: Some(common),
                remote_files: BTreeMap::new(),
            },
            None,
            Vec::new(),
            None,
        )
        .unwrap();
    assert!(created.descriptor.is_some(), "{:?}", created.issues);

    let mut secret_profile = created.profile.clone();
    secret_profile.id = "remote-secret".into();
    secret_profile.files.insert("settings".into(), settings.into());
    let secret = sessions
        .begin(
            &registry,
            &db,
            ConfigurationBeginRequest {
                tool_id: "codex".into(),
                scope: Scope::Global,
                project_path: None,
                session_id: "remote-secret".into(),
                subject: ConfigurationSubject::Profile,
                profile: Some(secret_profile),
                remote_target_id: Some("remote-host".into()),
                remote_common: None,
                remote_files: BTreeMap::new(),
            },
            None,
            Vec::new(),
            None,
        )
        .unwrap();
    assert!(secret.descriptor.is_some(), "{:?}", secret.issues);
    assert!(secret.issues.iter().any(|issue| issue.message.contains("明文密钥")));

    let local = temp.path().join("config.toml");
    std::fs::write(&local, "model = \"local-only-marker\"\n").unwrap();
    let native = vec![crate::adapters::file(
        "settings",
        local.clone(),
        format::FileKind::Toml,
        true,
        None,
        false,
    )];
    let current = sessions
        .begin(
            &registry,
            &db,
            ConfigurationBeginRequest {
                tool_id: "codex".into(),
                scope: Scope::Global,
                project_path: None,
                session_id: "remote-current".into(),
                subject: ConfigurationSubject::Current,
                profile: None,
                remote_target_id: Some("remote-host".into()),
                remote_common: None,
                remote_files: BTreeMap::from([("settings".into(), settings.into())]),
            },
            None,
            native,
            None,
        )
        .unwrap();
    let public = current.profile.files.get("settings").map(String::as_str).unwrap_or("");
    assert!(current.descriptor.is_some(), "{:?}", current.issues);
    assert!(public.contains("gpt-6-astra"));
    assert!(public.contains("external_web_access"));
    assert!(!public.contains("synthetic-bearer-token"));
    assert!(!public.contains("local-only-marker"));
    let preserved = sessions
        .remote_current_contents(&registry, &current, &current.profile.files)
        .unwrap();
    let preserved = preserved.get("settings").map(String::as_str).unwrap_or("");
    assert!(preserved.contains("synthetic-bearer-token"));
    assert!(preserved.contains("gpt-6-astra"));
    assert!(!preserved.contains("local-only-marker"));

    let empty = sessions
        .begin(
            &registry,
            &db,
            ConfigurationBeginRequest {
                tool_id: "codex".into(),
                scope: Scope::Global,
                project_path: None,
                session_id: "remote-empty".into(),
                subject: ConfigurationSubject::Current,
                profile: None,
                remote_target_id: Some("remote-host".into()),
                remote_common: None,
                remote_files: BTreeMap::new(),
            },
            None,
            vec![crate::adapters::file(
                "settings",
                local.clone(),
                format::FileKind::Toml,
                true,
                None,
                false,
            )],
            None,
        )
        .unwrap();
    assert!(empty.descriptor.is_some(), "{:?}", empty.issues);
    assert!(!empty.profile.files.values().any(|text| text.contains("local-only-marker")));
}

#[test]
fn remote_codex_draft_lists_provider_models_with_the_unsaved_key() {
    use std::io::{BufRead, BufReader, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let seen = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let header = std::sync::Arc::clone(&seen);
    let server = std::thread::spawn(move || {
        listener.set_nonblocking(true).unwrap();
        let started = std::time::Instant::now();
        let mut stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if started.elapsed() > std::time::Duration::from_secs(5) {
                        return;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                Err(error) => panic!("{error}"),
            }
        };
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(2)))
            .unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut first = String::new();
        reader.read_line(&mut first).unwrap();
        assert!(first.starts_with("GET /v1/models"), "{first}");
        let mut authorization = String::new();
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let done = line == "\r\n" || line.is_empty();
            if line.to_ascii_lowercase().starts_with("authorization:") {
                authorization = line;
            }
            if done {
                break;
            }
        }
        *header.lock().unwrap() = authorization;
        let body = r#"{"data":[{"id":"gpt-6-luna"},{"id":"gpt-6-astra"}],"has_more":false}"#;
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .unwrap();
    });
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("db")).unwrap();
    let registry = Registry::builtins();
    let sessions = DraftSessions::default();
    let store = Store::default();
    let settings = format!(
        "model_provider = \"openai-custom\"\n\n[model_providers.openai-custom]\nbase_url = \"http://{address}/v1\"\nname = \"openai-custom\"\nwire_api = \"responses\"\n"
    );
    let profile = serde_json::from_value(json!({
        "id": "",
        "tool": "codex",
        "name": "新配置",
        "version": 0,
        "inheritCommon": false,
        "files": {"settings": settings},
        "connection": null,
        "nativeCredentials": {}
    }))
    .unwrap();
    let opened = sessions
        .begin(
            &registry,
            &db,
            ConfigurationBeginRequest {
                tool_id: "codex".into(),
                scope: Scope::Global,
                project_path: None,
                session_id: "remote-catalog".into(),
                subject: ConfigurationSubject::Profile,
                profile: Some(profile),
                remote_target_id: Some("remote-host".into()),
                remote_common: None,
                remote_files: BTreeMap::new(),
            },
            None,
            Vec::new(),
            None,
        )
        .unwrap();
    assert!(opened.remote_target_id.is_some());
    assert!(
        opened.draft_connection.as_ref().is_some_and(|connection| connection.model.is_empty()),
        "{:?}",
        opened.issues
    );
    let selected = sessions
        .select_credential(
            &registry,
            &db,
            opened,
            ConfigurationCredential::ApiKey {
                secret_ref: None,
                remove: false,
            },
        )
        .unwrap();
    let draft = sessions
        .set_secret(&registry, selected, "synthetic-catalog-key".into())
        .unwrap();
    assert_eq!(draft.credential_status.as_deref(), Some("draft"));
    let directory = sessions
        .provider_directory(&db, &draft, &store, true, "")
        .unwrap();
    server.join().unwrap();
    assert_eq!(directory.models, vec!["gpt-6-astra", "gpt-6-luna"]);
    assert!(directory.error.is_none(), "{:?}", directory.error);
    let authorization = seen.lock().unwrap().clone();
    assert!(
        authorization.contains("Bearer synthetic-catalog-key"),
        "{authorization}"
    );
    assert!(!serde_json::to_string(&directory).unwrap().contains("synthetic-catalog-key"));
    assert!(store.values.lock().unwrap().is_empty());
}

fn codex_remote_profile(settings: &str, connection: bool) -> RegisteredProfile {
    let connection = if connection {
        json!({
            "providerId": "openai-custom",
            "interfaceFormat": "openai_responses",
            "baseUrl": "https://cpa.example.test/v1",
            "model": "gpt-6-astra",
            "secretRef": null,
            "authEnvVar": "CLIORA_CODEX_OPENAI_API_KEY"
        })
    } else {
        Value::Null
    };
    serde_json::from_value(json!({
        "editing": {"version": 1, "selectedProvider": "openai-custom", "intents": []},
        "id": "remote-profile",
        "tool": "codex",
        "name": "新配置",
        "version": 1,
        "revision": "rev",
        "inheritCommon": false,
        "files": {"settings": settings},
        "authentication": {"kind": "api_key"},
        "connection": connection,
        "nativeCredentials": {}
    }))
    .unwrap()
}

#[test]
fn remote_codex_save_writes_the_key_into_the_file_and_drops_env_key() {
    let registry = Registry::builtins();
    let settings = "\
model = \"gpt-6-astra\"
model_provider = \"openai-custom\"

[model_providers.openai-custom]
name = \"openai-custom\"
base_url = \"https://cpa.example.test/v1\"
wire_api = \"responses\"
env_key = \"CLIORA_CODEX_OPENAI_API_KEY\"
";
    let mut profile = codex_remote_profile(settings, true);
    let secrets = remote_connection_secrets(
        &registry,
        &profile,
        Scope::Global,
        None,
        "connection-11111111-1111-1111-1111-111111111111",
        "synthetic-remote-key",
    )
    .unwrap();
    for (role, text) in &mut profile.files {
        let kind = registry.get("codex").unwrap().file_kind(role).unwrap();
        *text = secrets.apply_text(role, kind, std::mem::take(text)).unwrap();
    }
    let text = profile.files.get("settings").unwrap();
    assert!(text.contains("experimental_bearer_token = \"synthetic-remote-key\""), "{text}");
    assert!(!text.contains("env_key"), "{text}");
    assert!(!text.contains("CLIORA_CODEX_OPENAI_API_KEY"), "{text}");
    assert_eq!(profile.connection.as_ref().unwrap().auth_env_var.as_deref(), Some("CLIORA_CODEX_OPENAI_API_KEY"));
}

#[test]
fn remote_codex_save_uses_the_draft_connection_when_the_profile_has_none() {
    let registry = Registry::builtins();
    let settings = "\
model_provider = \"openai-custom\"

[model_providers.openai-custom]
name = \"openai-custom\"
base_url = \"https://cpa.example.test/v1\"
wire_api = \"responses\"
env_key = \"CLIORA_CODEX_OPENAI_API_KEY\"
";
    let profile = codex_remote_profile(settings, false);
    let draft_connection = Connection {
        provider_id: "openai-custom".into(),
        interface_format: "openai_responses".into(),
        base_url: "https://cpa.example.test/v1".into(),
        model: String::new(),
        secret_ref: None,
        auth_env_var: Some("CLIORA_CODEX_OPENAI_API_KEY".into()),
        model_records: Vec::new(),
    };
    let secrets = remote_connection_secrets(
        &registry,
        &profile,
        Scope::Global,
        Some(&draft_connection),
        "connection-22222222-2222-2222-2222-222222222222",
        "synthetic-remote-key",
    )
    .unwrap();
    let text = secrets
        .apply_text(
            "settings",
            registry.get("codex").unwrap().file_kind("settings").unwrap(),
            settings.into(),
        )
        .unwrap();
    assert!(text.contains("experimental_bearer_token = \"synthetic-remote-key\""), "{text}");
    assert!(!text.contains("env_key"), "{text}");
}

#[test]
fn remote_save_without_a_new_key_keeps_the_bearer_already_in_the_file() {
    let registry = Registry::builtins();
    let original = "\
model = \"gpt-6-astra\"
model_provider = \"openai-custom\"

[model_providers.openai-custom]
name = \"openai-custom\"
base_url = \"https://cpa.example.test/v1\"
wire_api = \"responses\"
experimental_bearer_token = \"synthetic-remote-key\"
";
    let edited = "\
model = \"gpt-6-luna\"
model_provider = \"openai-custom\"

[model_providers.openai-custom]
name = \"openai-custom\"
base_url = \"https://cpa.example.test/v1\"
wire_api = \"responses\"
";
    let files = preserve_withheld_credentials(
        &registry,
        "codex",
        &BTreeMap::from([("settings".into(), edited.into())]),
        &BTreeMap::from([("settings".into(), original.into())]),
    )
    .unwrap();
    let text = files.get("settings").unwrap();
    assert!(text.contains("model = \"gpt-6-luna\""), "{text}");
    assert!(text.contains("experimental_bearer_token = \"synthetic-remote-key\""), "{text}");
}
