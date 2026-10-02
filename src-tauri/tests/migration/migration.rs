use super::*;
use std::sync::Mutex;

#[derive(Default)]
struct MemoryCredentials(Mutex<BTreeMap<String, String>>);

impl CredentialStore for MemoryCredentials {
    fn put(&self, id: &str, secret: &str) -> Result<(), String> {
        self.0.lock().unwrap().insert(id.into(), secret.into());
        Ok(())
    }
    fn get(&self, id: &str) -> Result<String, String> {
        self.0
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or("missing secret".into())
    }
    fn delete(&self, id: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(id);
        Ok(())
    }
}

fn database(directory: &Path) -> Database {
    fs::create_dir_all(directory).unwrap();
    Database::open(&directory.join("cliora.db")).unwrap()
}

#[test]
fn encrypted_bundle_restores_on_fresh_device_without_identity_or_paths_and_is_idempotent() {
    let temp = tempfile::tempdir().unwrap();
    let source = database(&temp.path().join("old"));
    let old_credentials = MemoryCredentials::default();
    old_credentials
        .put("connection-original", "private-api-key")
        .unwrap();
    let profile = RegisteredProfile { authentication: crate::native::profile::ProfileAuthentication::Native,
        revision: String::new(),
        id: "profile-1".into(),
        tool: "codex".into(),
        name: "Work".into(),
        version: 1,
        inherit_common: true,
        files: BTreeMap::from([(
            "settings".into(),
            "model = \"gpt-6\"\nnotify = [\"C:/old/device/notify.exe\"]\n".into(),
        )]),
        suppressed: BTreeMap::new(),
        connection: Some(crate::native::profile::Connection {
            provider_id: "provider".into(),
            interface_format: "openai_responses".into(),
            base_url: "https://api.example.test/v1".into(),
            model: "gpt-6".into(),
            secret_ref: Some("connection-original".into()),
            auth_env_var: None,
        }),
        native_credentials: BTreeMap::new(),
    };
    source.with_connection(|conn| {
        conn.execute("INSERT INTO native_profiles (id,tool,version,data) VALUES (?1,'codex',1,?2)",
            rusqlite::params![profile.id, serde_json::to_string(&profile).unwrap()]).unwrap();
        conn.execute("INSERT INTO projects (id,name,path,preferred_tool,last_opened) VALUES ('project-1','Work','C:/old/device/work','codex',9)", []).unwrap();
        conn.execute("INSERT INTO applied_bindings (scope_key,tool,profile_id,profile_version,managed) VALUES ('global','codex','profile-1',1,'{}')", []).unwrap();
        Ok(())
    }).unwrap();
    let registry = Registry::builtins();
    let bundle = temp.path().join("config.cliora");
    export_bundle(
        &source,
        &old_credentials,
        &registry,
        "correct-password",
        None,
        &bundle,
    )
    .unwrap();
    let raw = fs::read(&bundle).unwrap();
    let raw_text = String::from_utf8_lossy(&raw);
    for value in ["private-api-key", "C:/old/device", "profile-1"] {
        assert!(!raw_text.contains(value));
    }
    assert!(unlock_bundle(&bundle, "incorrect").is_err());
    let mut corrupt = raw;
    let last = corrupt
        .iter_mut()
        .rev()
        .find(|byte| **byte == b'A')
        .unwrap();
    *last = b'B';
    fs::write(temp.path().join("bad.cliora"), corrupt).unwrap();
    assert!(unlock_bundle(&temp.path().join("bad.cliora"), "correct-password").is_err());

    let fresh = database(&temp.path().join("new"));
    let new_credentials = MemoryCredentials::default();
    let draft = preview_import(
        &fresh,
        &new_credentials,
        &registry,
        unlock_bundle(&bundle, "correct-password").unwrap(),
    )
    .unwrap();
    assert!(
        draft
            .items
            .iter()
            .any(|item| item.kind == "project"
                && item.pending_fields.contains(&"项目本机目录".into()))
    );
    assert!(draft.items.iter().any(|item| item.kind == "profile"
        && item
            .pending_fields
            .iter()
            .any(|field| field.contains("notify"))));
    let keys: BTreeSet<String> = draft.items.iter().map(|item| item.key.clone()).collect();
    assert_eq!(
        apply_import(&fresh, &new_credentials, &registry, &draft, &keys).unwrap(),
        draft
            .items
            .iter()
            .filter(|item| item.status != "same")
            .count()
    );
    fresh
        .with_connection(|conn| {
            let path: Option<String> = conn
                .query_row(
                    "SELECT path FROM projects WHERE id='project-1'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(path, None);
            let bindings: i64 = conn
                .query_row("SELECT count(*) FROM applied_bindings", [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(bindings, 0);
            Ok(())
        })
        .unwrap();
    let restored = collect_snapshot(&fresh, &new_credentials, &registry).unwrap();
    let restored_profile = restored
        .entities
        .iter()
        .find(|item| item.kind() == "profile")
        .unwrap();
    let PortablePayload::Profile(portable) = &restored_profile.payload else {
        unreachable!()
    };
    assert_eq!(
        portable.connection_secret.as_deref(),
        Some("private-api-key")
    );
    assert!(!portable.profile.files["settings"].contains("C:/old/device"));
    let again = preview_import(
        &fresh,
        &new_credentials,
        &registry,
        unlock_bundle(&bundle, "correct-password").unwrap(),
    )
    .unwrap();
    assert!(again.items.iter().all(|item| item.status == "same"));
    assert_eq!(
        apply_import(&fresh, &new_credentials, &registry, &again, &keys).unwrap(),
        0
    );
}

#[test]
fn portable_snapshot_rejects_duplicate_entities() {
    let entity = PortableEntity {
        id: "managed".into(),
        payload: PortablePayload::Preferences(PortablePreferences { tool_icons: Default::default(),
            managed_tools: vec!["codex".into()],
            theme: "system".into(),
        }),
    };
    assert!(validate_snapshot(&PortableSnapshot {
        schema_version: 1,
        entities: vec![entity.clone(), entity],
    })
    .is_err());
}

#[test]
fn same_version_profile_import_shows_content_and_marks_native_binding_pending() {
    let temp = tempfile::tempdir().unwrap();
    let db = database(temp.path());
    let credentials = MemoryCredentials::default();
    let registry = Registry::builtins();
    let profile = RegisteredProfile { authentication: crate::native::profile::ProfileAuthentication::Native,
        revision: String::new(),
        id: "profile-1".into(),
        tool: "codex".into(),
        name: "local".into(),
        version: 2,
        inherit_common: false,
        files: BTreeMap::new(),
        suppressed: BTreeMap::new(),
        connection: None,
        native_credentials: BTreeMap::new(),
    };
    db.with_connection(|conn| {
        conn.execute("INSERT INTO native_profiles (id,tool,version,data) VALUES ('profile-1','codex',2,?1)",
            [serde_json::to_string(&profile).unwrap()]).unwrap();
        conn.execute("INSERT INTO applied_bindings (scope_key,tool,profile_id,profile_version,managed) VALUES ('global','codex','profile-1',2,'{}')",[]).unwrap();
        Ok(())
    }).unwrap();
    let mut incoming = collect_snapshot(&db, &credentials, &registry).unwrap();
    let entity = incoming
        .entities
        .iter_mut()
        .find(|entity| entity.key() == "profile:profile-1")
        .unwrap();
    let PortablePayload::Profile(value) = &mut entity.payload else {
        panic!("profile expected")
    };
    value.profile.name = "remote".into();
    let draft = preview_import(&db, &credentials, &registry, incoming).unwrap();
    let preview = draft
        .items
        .iter()
        .find(|item| item.key == "profile:profile-1")
        .unwrap();
    assert_eq!(preview.status, "conflict");
    assert!(preview.local_preview.as_ref().unwrap().contains("local"));
    assert!(preview.incoming_preview.contains("remote"));
    let selected = BTreeSet::from(["profile:profile-1".into()]);
    assert_eq!(
        apply_import(&db, &credentials, &registry, &draft, &selected).unwrap(),
        1
    );
    db.with_connection(|conn| {
        let version: i64 = conn
            .query_row(
                "SELECT profile_version FROM applied_bindings WHERE profile_id='profile-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, -1);
        let saved: String = conn
            .query_row(
                "SELECT data FROM native_profiles WHERE id='profile-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(saved.contains("remote"));
        Ok(())
    })
    .unwrap();
    let binding = crate::native::apply::get_registered_binding(&db, "codex", "global")
        .unwrap()
        .unwrap();
    assert_eq!(binding.profile_version, 0);
    // Once explicitly applied, importing identical content must leave that binding valid.
    db.with_connection(|conn| {
        conn.execute(
            "UPDATE applied_bindings SET profile_version=2 WHERE profile_id='profile-1'",
            [],
        )
        .map_err(|error| error.to_string())?;
        Ok(())
    })
    .unwrap();
    let again = preview_import(&db, &credentials, &registry, draft.snapshot).unwrap();
    assert_eq!(
        apply_import(&db, &credentials, &registry, &again, &selected).unwrap(),
        0
    );
    let binding = crate::native::apply::get_registered_binding(&db, "codex", "global")
        .unwrap()
        .unwrap();
    assert_eq!(binding.profile_version, 2);
}

#[test]
fn import_rechecks_digest_inside_the_write_transaction() {
    struct EditingCredentials<'a> {
        db: &'a Database,
        inner: &'a MemoryCredentials,
    }
    impl CredentialStore for EditingCredentials<'_> {
        fn put(&self, id: &str, secret: &str) -> Result<(), String> {
            // Keyring preparation is after the old pre-transaction check and before the write.
            self.db.with_connection(|conn| {
                conn.execute("UPDATE library_items SET body='edited-during-keyring-write',version=2 WHERE id='one'", [])
                    .map_err(|error| error.to_string())?;
                Ok(())
            })?;
            self.inner.put(id, secret)
        }
        fn get(&self, id: &str) -> Result<String, String> {
            self.inner.get(id)
        }
        fn delete(&self, id: &str) -> Result<(), String> {
            self.inner.delete(id)
        }
    }
    let temp = tempfile::tempdir().unwrap();
    let db = database(temp.path());
    let credentials = MemoryCredentials::default();
    let registry = Registry::builtins();
    db.with_connection(|conn| {
        conn.execute("INSERT INTO library_items (id,kind,title,body,category,project_id,version,updated_at) VALUES ('one','prompt','Example','initial','',NULL,1,1)",[]).unwrap();
        Ok(())
    }).unwrap();
    let mut incoming = collect_snapshot(&db, &credentials, &registry).unwrap();
    let entity = incoming
        .entities
        .iter_mut()
        .find(|entity| entity.key() == "library:one")
        .unwrap();
    let PortablePayload::Library(item) = &mut entity.payload else {
        panic!("library expected")
    };
    item.body = "remote".into();
    incoming.entities.push(PortableEntity {
        id: "secret-profile".into(),
        payload: PortablePayload::Profile(PortableProfile {
            profile: RegisteredProfile { authentication: crate::native::profile::ProfileAuthentication::Native,
                revision: String::new(),
                id: "secret-profile".into(),
                tool: "codex".into(),
                name: "Secret profile".into(),
                version: 1,
                inherit_common: false,
                files: BTreeMap::new(),
                suppressed: BTreeMap::new(),
                connection: Some(crate::native::profile::Connection {
                    provider_id: "provider".into(),
                    interface_format: "openai_responses".into(),
                    base_url: "https://api.example.test/v1".into(),
                    model: "gpt-6".into(),
                    secret_ref: None,
                    auth_env_var: None,
                }),
                native_credentials: BTreeMap::new(),
            },
            connection_secret: Some("private-api-key".into()),
            native_secrets: BTreeMap::new(),
            pending_fields: Vec::new(),
        }),
    });
    let draft = preview_import(&db, &credentials, &registry, incoming).unwrap();
    let secret_preview = &draft
        .items
        .iter()
        .find(|item| item.key == "profile:secret-profile")
        .unwrap()
        .incoming_preview;
    assert!(!secret_preview.contains("private-api-key"));
    assert!(secret_preview.contains("内容隐藏"));
    let editing = EditingCredentials {
        db: &db,
        inner: &credentials,
    };
    assert!(apply_import(
        &db,
        &editing,
        &registry,
        &draft,
        &BTreeSet::from(["library:one".into(), "profile:secret-profile".into()])
    )
    .unwrap_err()
    .contains("本机资料已变化"));
    db.with_connection(|conn| {
        let body: String = conn
            .query_row("SELECT body FROM library_items WHERE id='one'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(body, "edited-during-keyring-write");
        let profiles: i64 = conn
            .query_row("SELECT count(*) FROM native_profiles", [], |row| row.get(0))
            .unwrap();
        assert_eq!(profiles, 0);
        Ok(())
    })
    .unwrap();
    assert!(credentials.0.lock().unwrap().is_empty());
}

#[test]
fn adapter_native_whitelist_keeps_model_settings_but_drops_device_login_and_inline_key() {
    let registry = Registry::builtins();
    let (codex, pending) = portable_files(
        &registry,
        "codex",
        &BTreeMap::from([(
            "settings".into(),
            "model = \"gpt-6\"\nnotify = [\"C:/old/notify.exe\"]\n".into(),
        )]),
    )
    .unwrap();
    assert!(codex["settings"].contains("gpt-6"));
    assert!(!codex["settings"].contains("notify"));
    assert!(pending.iter().any(|field| field.contains("notify")));
    let (pi, pending) = portable_files(&registry,"pi",&BTreeMap::from([("models".into(),
        r#"{"providers":{"custom":{"baseUrl":"https://api.example.test","apiKey":"never-inline"}}}"#.into())])).unwrap();
    assert!(pi["models"].contains("baseUrl"));
    assert!(!pi["models"].contains("never-inline"));
    assert!(pending.iter().any(|field| field.contains("apiKey")));
}

#[test]
fn absent_preferences_are_new_and_actual_edits_after_preview_are_protected() {
    let temp = tempfile::tempdir().unwrap();
    let db = database(temp.path());
    let credentials = MemoryCredentials::default();
    let registry = Registry::builtins();
    assert!(collect_snapshot(&db, &credentials, &registry).unwrap().entities.is_empty());
    let incoming = PortableSnapshot { schema_version: 1, entities: vec![PortableEntity {
        id: "managed".into(), payload: PortablePayload::Preferences(PortablePreferences { tool_icons: Default::default(),
            managed_tools: vec!["pi".into()], theme: "dark".into(),
        }),
    }] };
    let draft = preview_import(&db, &credentials, &registry, incoming.clone()).unwrap();
    assert_eq!(draft.items[0].status, "new");
    assert_eq!(draft.baseline["preferences:managed"], None);
    db.update_preferences(|preferences| preferences.theme = crate::domain::Theme::Light).unwrap();
    assert!(apply_import(&db, &credentials, &registry, &draft, &BTreeSet::from(["preferences:managed".into()])).unwrap_err().starts_with("本机资料已变化"));
    assert_eq!(db.preferences().unwrap().theme, crate::domain::Theme::Light);
    let draft = preview_import(&db, &credentials, &registry, incoming).unwrap();
    apply_import(&db, &credentials, &registry, &draft, &BTreeSet::from(["preferences:managed".into()])).unwrap();
    assert_eq!(db.preferences().unwrap().theme, crate::domain::Theme::Dark);
}

#[test]
fn same_portable_version_replaces_local_revision_and_rejects_stale_saves_and_deletes() {
    use crate::native::profile::{self, RegisteredCommon};
    let temp = tempfile::tempdir().unwrap();
    let db = database(temp.path());
    let credentials = MemoryCredentials::default();
    let registry = Registry::builtins();
    let old_profile = profile::save_registered_profile(&db, &registry, RegisteredProfile { authentication: crate::native::profile::ProfileAuthentication::Native,
        id: String::new(), tool: "codex".into(), name: "local".into(), version: 0, revision: String::new(),
        inherit_common: true, files: BTreeMap::new(), suppressed: BTreeMap::new(), connection: None, native_credentials: BTreeMap::new(),
    }, None).unwrap();
    let old_common = profile::save_registered_common(&db, &registry, RegisteredCommon {
        tool: "codex".into(), version: 0, revision: String::new(), files: BTreeMap::from([("settings".into(), "model = \"local\"".into())]),
    }, None).unwrap();
    let mut snapshot = collect_snapshot(&db, &credentials, &registry).unwrap();
    let json = serde_json::to_string(&snapshot).unwrap();
    assert!(!json.contains(&old_profile.revision));
    assert!(!json.contains(&old_common.revision));
    for entity in &mut snapshot.entities {
        match &mut entity.payload {
            PortablePayload::Profile(value) => value.profile.name = "remote".into(),
            PortablePayload::Common(value) => value.files.insert("settings".into(), "model = \"remote\"\n".into()).map(|_| ()).unwrap_or(()),
            _ => {},
        }
    }
    let draft = preview_import(&db, &credentials, &registry, snapshot.clone()).unwrap();
    let keys = draft.items.iter().map(|item| item.key.clone()).collect();
    assert_eq!(apply_import(&db, &credentials, &registry, &draft, &keys).unwrap(), 2);
    let new_profile = profile::get_registered_profile(&db, &old_profile.id).unwrap();
    let new_common = profile::get_registered_common(&db, "codex").unwrap().unwrap();
    assert_eq!(new_profile.version, old_profile.version);
    assert_ne!(new_profile.revision, old_profile.revision);
    assert_eq!(new_common.version, old_common.version);
    assert_ne!(new_common.revision, old_common.revision);
    assert!(profile::save_registered_profile(&db, &registry, old_profile.clone(), Some(old_profile.version)).unwrap_err().contains("其他操作修改"));
    assert!(profile::delete_registered_profile(&db, &registry, &old_profile.id, old_profile.version, &old_profile.revision).unwrap_err().contains("版本已变化"));
    assert!(profile::save_registered_common(&db, &registry, old_common.clone(), Some(old_common.version)).unwrap_err().contains("其他操作修改"));
    let again = preview_import(&db, &credentials, &registry, snapshot).unwrap();
    assert_eq!(apply_import(&db, &credentials, &registry, &again, &keys).unwrap(), 0);
    assert_eq!(profile::get_registered_profile(&db, &old_profile.id).unwrap().revision, new_profile.revision);
    assert_eq!(profile::get_registered_common(&db, "codex").unwrap().unwrap().revision, new_common.revision);
    profile::save_registered_common(&db, &registry, new_common.clone(), Some(new_common.version)).unwrap();
    profile::delete_registered_profile(&db, &registry, &new_profile.id, new_profile.version, &new_profile.revision).unwrap();
}

#[test]
fn common_only_import_marks_inheriting_bindings_pending_and_notifies_partial_success() {
    use crate::native::profile::{self, RegisteredCommon};
    use std::cell::Cell;
    let temp = tempfile::tempdir().unwrap();
    let db = database(temp.path());
    let credentials = MemoryCredentials::default();
    let registry = Registry::builtins();
    for inherit in [true, false] {
        let profile = profile::save_registered_profile(&db, &registry, RegisteredProfile { authentication: crate::native::profile::ProfileAuthentication::Native,
            id: String::new(), tool: "codex".into(), name: inherit.to_string(), version: 0, revision: String::new(),
            inherit_common: inherit, files: BTreeMap::new(), suppressed: BTreeMap::new(), connection: None, native_credentials: BTreeMap::new(),
        }, None).unwrap();
        db.with_connection(|conn| {
            for scope in ["global", "project:local"] {
                conn.execute("INSERT INTO applied_bindings (scope_key,tool,profile_id,profile_version,managed) VALUES (?1,?2,?3,1,'{}')",
                    params![format!("{scope}-{inherit}"), "codex", profile.id]).unwrap();
            }
            Ok(())
        }).unwrap();
    }
    let common = PortableEntity { id: "codex".into(), payload: PortablePayload::Common(RegisteredCommon {
        tool: "codex".into(), version: 1, revision: String::new(), files: BTreeMap::from([("settings".into(), "model = \"remote\"\n".into())]),
    }) };
    let draft = preview_import(&db, &credentials, &registry, PortableSnapshot { schema_version: 1, entities: vec![common] }).unwrap();
    let events = Cell::new(0);
    let result: Result<(), &str> = with_change_notification(&db, || events.set(events.get()+1), || {
        apply_import(&db, &credentials, &registry, &draft, &BTreeSet::from(["common:codex".into()])).unwrap();
        Err("later target failed")
    });
    assert!(result.is_err());
    assert_eq!(events.get(), 1);
    db.with_connection(|conn| {
        for inherit in [true, false] {
            let version: i64 = conn.query_row("SELECT profile_version FROM applied_bindings WHERE scope_key=?1", [format!("global-{inherit}")], |row| row.get(0)).unwrap();
            assert_eq!(version, if inherit { -1 } else { 1 });
        }
        Ok(())
    }).unwrap();
    let again = preview_import(&db, &credentials, &registry, draft.snapshot).unwrap();
    with_change_notification(&db, || events.set(events.get()+1), || apply_import(&db, &credentials, &registry, &again, &BTreeSet::from(["common:codex".into()]))).unwrap();
    assert_eq!(events.get(), 1);
    let _: Result<(), &str> = with_change_notification(&db, || events.set(events.get()+1), || Err("no changes"));
    assert_eq!(events.get(), 1);
}

#[test]
fn incoming_content_never_becomes_automatic_project_directory_recovery() {
    use crate::projects;
    use crate::native::profile;
    let temp = tempfile::tempdir().unwrap();
    let db = database(temp.path());
    let credentials = MemoryCredentials::default();
    let registry = Registry::builtins();
    let directory = temp.path().join("project");
    let moved = temp.path().join("moved");
    fs::create_dir(&directory).unwrap();
    let project = projects::add(&db, &registry, directory.to_str().unwrap(), None, Some("codex")).unwrap();
    let profile = profile::save_registered_profile(&db, &registry, RegisteredProfile { authentication: crate::native::profile::ProfileAuthentication::Native,
        id: String::new(), tool: "codex".into(), name: "Work".into(), version: 0, revision: String::new(),
        inherit_common: false, files: BTreeMap::new(), suppressed: BTreeMap::new(), connection: None, native_credentials: BTreeMap::new(),
    }, None).unwrap();
    projects::record_applied_profile(&db, &directory, "codex", &profile.id).unwrap();
    db.with_connection(|conn| {
        conn.execute("INSERT INTO applied_bindings (scope_key,tool,profile_id,profile_version,managed) VALUES (?1,'codex',?2,1,'{}')", params![format!("project:{}", project.path.as_ref().unwrap()), profile.id]).unwrap();
        Ok(())
    }).unwrap();
    let native_file = directory.join("config.toml");
    fs::write(&native_file, "model = \"already-applied\"").unwrap();
    let mut snapshot = collect_snapshot(&db, &credentials, &registry).unwrap();
    snapshot.entities.retain(|entity| entity.kind() == "profile");
    let PortablePayload::Profile(value) = &mut snapshot.entities[0].payload else { panic!() };
    value.profile.files.insert("settings".into(), "model = \"remote\"\n".into());
    let draft = preview_import(&db, &credentials, &registry, snapshot).unwrap();
    apply_import(&db, &credentials, &registry, &draft, &BTreeSet::from([format!("profile:{}", profile.id)])).unwrap();
    let received = projects::get(&db, &project.id).unwrap();
    assert!(received.applied_profiles.is_empty());
    assert!(received.reapply_profiles.is_empty());
    assert_eq!(fs::read_to_string(&native_file).unwrap(), "model = \"already-applied\"");
    fs::rename(&directory, &moved).unwrap();
    let moved_project = projects::relink(&db, &project.id, moved.to_str().unwrap()).unwrap();
    assert!(moved_project.reapply_profiles.is_empty());
    // After explicit content acceptance, ordinary directory recovery retains its behavior.
    db.with_connection(|conn| { conn.execute("UPDATE applied_bindings SET profile_version=1", []).unwrap(); Ok(()) }).unwrap();
    assert_eq!(projects::get(&db, &project.id).unwrap().reapply_profiles["codex"], profile.id);
}

#[test]
fn tool_icons_roundtrip_encryption_and_participate_in_import_cas_without_device_paths() {
    let old = tempfile::tempdir().unwrap();
    let fresh = tempfile::tempdir().unwrap();
    let db = database(old.path());
    let destination = database(fresh.path());
    let credentials = MemoryCredentials::default();
    let registry = Registry::builtins();
    let png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR2kAAAAASUVORK5CYII=";
    db.update_preferences(|p| { p.tool_icons.insert("future_cli".into(), png.into()); p.theme = crate::domain::Theme::Dark; }).unwrap();
    let selected = BTreeSet::from(["preferences:managed".into()]);
    let bytes = old.path().join("icons.cliora");
    export_bundle(&db, &credentials, &registry, "correct-password", Some(&selected), &bytes).unwrap();
    let snapshot = unlock_bundle(&bytes, "correct-password").unwrap();
    let draft = preview_import(&destination, &credentials, &registry, snapshot).unwrap();
    apply_import(&destination, &credentials, &registry, &draft, &selected).unwrap();
    assert_eq!(destination.preferences().unwrap().tool_icons["future_cli"], png);
    assert_eq!(destination.preferences().unwrap().theme, crate::domain::Theme::Dark);
    let again = preview_import(&destination, &credentials, &registry, unlock_bundle(&bytes, "correct-password").unwrap()).unwrap();
    assert_eq!(again.items[0].status, "same");
    destination.update_preferences(|p| { p.tool_icons.remove("future_cli"); }).unwrap();
    assert!(apply_import(&destination, &credentials, &registry, &again, &selected).unwrap_err().contains("本机资料已变化"));
    // Older packages omit icon fields; an empty map preserves their canonical digest.
    let old: PortablePreferences = serde_json::from_str(r#"{"managedTools":["codex"],"theme":"light"}"#).unwrap();
    assert!(old.tool_icons.is_empty());
    assert!(!serde_json::to_string(&old).unwrap().contains("toolIcons"));
}
