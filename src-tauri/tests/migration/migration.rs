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
    let profile = RegisteredProfile {
        editing: None,
        authentication: crate::native::profile::ProfileAuthentication::Native,
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
            model_records: Vec::new(),
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
            assert_eq!(path.as_deref(), Some("C:/old/device/work"));
            let bindings: i64 = conn
                .query_row("SELECT count(*) FROM applied_bindings", [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(bindings, 1);
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
        payload: PortablePayload::Preferences(PortablePreferences {
            tool_icons: Default::default(),
            managed_tools: vec!["codex".into()],
            theme: "system".into(),
            language: None,
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
    let profile = RegisteredProfile {
        editing: None,
        authentication: crate::native::profile::ProfileAuthentication::Native,
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
        payload: PortablePayload::Profile(Box::new(PortableProfile {
            profile: RegisteredProfile {
                editing: None,
                authentication: crate::native::profile::ProfileAuthentication::Native,
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
                    model_records: Vec::new(),
                }),
                native_credentials: BTreeMap::new(),
            },
            connection_secret: Some("private-api-key".into()),
            native_secrets: BTreeMap::new(),
            pending_fields: Vec::new(),
        })),
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
    assert!(collect_snapshot(&db, &credentials, &registry)
        .unwrap()
        .entities
        .is_empty());
    let incoming = PortableSnapshot {
        schema_version: 1,
        entities: vec![PortableEntity {
            id: "managed".into(),
            payload: PortablePayload::Preferences(PortablePreferences {
                tool_icons: Default::default(),
                managed_tools: vec!["pi".into()],
                theme: "dark".into(),
                language: None,
            }),
        }],
    };
    let draft = preview_import(&db, &credentials, &registry, incoming.clone()).unwrap();
    assert_eq!(draft.items[0].status, "new");
    assert_eq!(draft.baseline["preferences:managed"], None);
    db.update_preferences(|preferences| preferences.theme = crate::domain::Theme::Light)
        .unwrap();
    assert!(apply_import(
        &db,
        &credentials,
        &registry,
        &draft,
        &BTreeSet::from(["preferences:managed".into()])
    )
    .unwrap_err()
    .starts_with("本机资料已变化"));
    assert_eq!(db.preferences().unwrap().theme, crate::domain::Theme::Light);
    let draft = preview_import(&db, &credentials, &registry, incoming).unwrap();
    apply_import(
        &db,
        &credentials,
        &registry,
        &draft,
        &BTreeSet::from(["preferences:managed".into()]),
    )
    .unwrap();
    assert_eq!(db.preferences().unwrap().theme, crate::domain::Theme::Dark);
}

#[test]
fn same_portable_version_replaces_local_revision_and_rejects_stale_saves_and_deletes() {
    use crate::native::profile::{self, RegisteredCommon};
    let temp = tempfile::tempdir().unwrap();
    let db = database(temp.path());
    let credentials = MemoryCredentials::default();
    let registry = Registry::builtins();
    let old_profile = profile::save_registered_profile(
        &db,
        &registry,
        RegisteredProfile {
            editing: None,
            authentication: crate::native::profile::ProfileAuthentication::Native,
            id: String::new(),
            tool: "codex".into(),
            name: "local".into(),
            version: 0,
            revision: String::new(),
            inherit_common: true,
            files: BTreeMap::new(),
            suppressed: BTreeMap::new(),
            connection: None,
            native_credentials: BTreeMap::new(),
        },
        None,
    )
    .unwrap();
    let old_common = profile::save_registered_common(
        &db,
        &registry,
        RegisteredCommon {
            tool: "codex".into(),
            version: 0,
            revision: String::new(),
            files: BTreeMap::from([("settings".into(), "model_reasoning_effort = \"low\"".into())]),
        },
        None,
    )
    .unwrap();
    let mut snapshot = collect_snapshot(&db, &credentials, &registry).unwrap();
    let json = serde_json::to_string(&snapshot).unwrap();
    assert!(!json.contains(&old_profile.revision));
    assert!(!json.contains(&old_common.revision));
    for entity in &mut snapshot.entities {
        match &mut entity.payload {
            PortablePayload::Profile(value) => value.profile.name = "remote".into(),
            PortablePayload::Common(value) => value
                .files
                .insert(
                    "settings".into(),
                    "model_reasoning_effort = \"high\"\n".into(),
                )
                .map(|_| ())
                .unwrap_or(()),
            _ => {}
        }
    }
    let draft = preview_import(&db, &credentials, &registry, snapshot.clone()).unwrap();
    let keys = draft.items.iter().map(|item| item.key.clone()).collect();
    assert_eq!(
        apply_import(&db, &credentials, &registry, &draft, &keys).unwrap(),
        2
    );
    let new_profile = profile::get_registered_profile(&db, &old_profile.id).unwrap();
    let new_common = profile::get_registered_common(&db, "codex")
        .unwrap()
        .unwrap();
    assert_eq!(new_profile.version, old_profile.version);
    assert_ne!(new_profile.revision, old_profile.revision);
    assert_eq!(new_common.version, old_common.version);
    assert_ne!(new_common.revision, old_common.revision);
    assert!(profile::save_registered_profile(
        &db,
        &registry,
        old_profile.clone(),
        Some(old_profile.version)
    )
    .unwrap_err()
    .contains("其他操作修改"));
    assert!(profile::delete_registered_profile(
        &db,
        &registry,
        &old_profile.id,
        old_profile.version,
        &old_profile.revision
    )
    .unwrap_err()
    .contains("版本已变化"));
    assert!(profile::save_registered_common(
        &db,
        &registry,
        old_common.clone(),
        Some(old_common.version)
    )
    .unwrap_err()
    .contains("其他操作修改"));
    let again = preview_import(&db, &credentials, &registry, snapshot).unwrap();
    assert_eq!(
        apply_import(&db, &credentials, &registry, &again, &keys).unwrap(),
        0
    );
    assert_eq!(
        profile::get_registered_profile(&db, &old_profile.id)
            .unwrap()
            .revision,
        new_profile.revision
    );
    assert_eq!(
        profile::get_registered_common(&db, "codex")
            .unwrap()
            .unwrap()
            .revision,
        new_common.revision
    );
    profile::save_registered_common(&db, &registry, new_common.clone(), Some(new_common.version))
        .unwrap();
    profile::delete_registered_profile(
        &db,
        &registry,
        &new_profile.id,
        new_profile.version,
        &new_profile.revision,
    )
    .unwrap();
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
        let profile = profile::save_registered_profile(
            &db,
            &registry,
            RegisteredProfile {
                editing: None,
                authentication: crate::native::profile::ProfileAuthentication::Native,
                id: String::new(),
                tool: "codex".into(),
                name: inherit.to_string(),
                version: 0,
                revision: String::new(),
                inherit_common: inherit,
                files: BTreeMap::new(),
                suppressed: BTreeMap::new(),
                connection: None,
                native_credentials: BTreeMap::new(),
            },
            None,
        )
        .unwrap();
        db.with_connection(|conn| {
            for scope in ["global", "project:local"] {
                conn.execute("INSERT INTO applied_bindings (scope_key,tool,profile_id,profile_version,managed) VALUES (?1,?2,?3,1,'{}')",
                    params![format!("{scope}-{inherit}"), "codex", profile.id]).unwrap();
            }
            Ok(())
        }).unwrap();
    }
    let common = PortableEntity {
        id: "codex".into(),
        payload: PortablePayload::Common(RegisteredCommon {
            tool: "codex".into(),
            version: 1,
            revision: String::new(),
            files: BTreeMap::from([("settings".into(), "model = \"remote\"\n".into())]),
        }),
    };
    let draft = preview_import(
        &db,
        &credentials,
        &registry,
        PortableSnapshot {
            schema_version: 1,
            entities: vec![common],
        },
    )
    .unwrap();
    let events = Cell::new(0);
    let result: Result<(), &str> = with_change_notification(
        &db,
        || events.set(events.get() + 1),
        || {
            apply_import(
                &db,
                &credentials,
                &registry,
                &draft,
                &BTreeSet::from(["common:codex".into()]),
            )
            .unwrap();
            Err("later target failed")
        },
    );
    assert!(result.is_err());
    assert_eq!(events.get(), 1);
    db.with_connection(|conn| {
        for inherit in [true, false] {
            let version: i64 = conn
                .query_row(
                    "SELECT profile_version FROM applied_bindings WHERE scope_key=?1",
                    [format!("global-{inherit}")],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(version, if inherit { -1 } else { 1 });
        }
        Ok(())
    })
    .unwrap();
    let again = preview_import(&db, &credentials, &registry, draft.snapshot).unwrap();
    with_change_notification(
        &db,
        || events.set(events.get() + 1),
        || {
            apply_import(
                &db,
                &credentials,
                &registry,
                &again,
                &BTreeSet::from(["common:codex".into()]),
            )
        },
    )
    .unwrap();
    assert_eq!(events.get(), 1);
    let _: Result<(), &str> =
        with_change_notification(&db, || events.set(events.get() + 1), || Err("no changes"));
    assert_eq!(events.get(), 1);
}

#[test]
fn incoming_content_never_becomes_automatic_project_directory_recovery() {
    use crate::native::profile;
    use crate::projects;
    let temp = tempfile::tempdir().unwrap();
    let db = database(temp.path());
    let credentials = MemoryCredentials::default();
    let registry = Registry::builtins();
    let directory = temp.path().join("project");
    let moved = temp.path().join("moved");
    fs::create_dir(&directory).unwrap();
    let project = projects::add(
        &db,
        &registry,
        directory.to_str().unwrap(),
        None,
        Some("codex"),
    )
    .unwrap();
    let profile = profile::save_registered_profile(
        &db,
        &registry,
        RegisteredProfile {
            editing: None,
            authentication: crate::native::profile::ProfileAuthentication::Native,
            id: String::new(),
            tool: "codex".into(),
            name: "Work".into(),
            version: 0,
            revision: String::new(),
            inherit_common: false,
            files: BTreeMap::new(),
            suppressed: BTreeMap::new(),
            connection: None,
            native_credentials: BTreeMap::new(),
        },
        None,
    )
    .unwrap();
    projects::record_applied_profile(&db, &directory, "codex", &profile.id).unwrap();
    db.with_connection(|conn| {
        conn.execute("INSERT INTO applied_bindings (scope_key,tool,profile_id,profile_version,managed) VALUES (?1,'codex',?2,1,'{}')", params![format!("project:{}", project.path.as_ref().unwrap()), profile.id]).unwrap();
        Ok(())
    }).unwrap();
    let native_file = directory.join("config.toml");
    fs::write(&native_file, "model = \"already-applied\"").unwrap();
    let mut snapshot = collect_snapshot(&db, &credentials, &registry).unwrap();
    snapshot
        .entities
        .retain(|entity| entity.kind() == "profile");
    let PortablePayload::Profile(value) = &mut snapshot.entities[0].payload else {
        panic!()
    };
    value
        .profile
        .files
        .insert("settings".into(), "model = \"remote\"\n".into());
    let draft = preview_import(&db, &credentials, &registry, snapshot).unwrap();
    apply_import(
        &db,
        &credentials,
        &registry,
        &draft,
        &BTreeSet::from([format!("profile:{}", profile.id)]),
    )
    .unwrap();
    let received = projects::get(&db, &project.id).unwrap();
    assert!(received.applied_profiles.is_empty());
    assert!(received.reapply_profiles.is_empty());
    assert_eq!(
        fs::read_to_string(&native_file).unwrap(),
        "model = \"already-applied\""
    );
    fs::rename(&directory, &moved).unwrap();
    let moved_project = projects::relink(&db, &project.id, moved.to_str().unwrap()).unwrap();
    assert!(moved_project.reapply_profiles.is_empty());
    // After explicit content acceptance, ordinary directory recovery retains its behavior.
    db.with_connection(|conn| {
        conn.execute("UPDATE applied_bindings SET profile_version=1", [])
            .unwrap();
        Ok(())
    })
    .unwrap();
    assert_eq!(
        projects::get(&db, &project.id).unwrap().reapply_profiles["codex"],
        profile.id
    );
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
    db.update_preferences(|p| {
        p.tool_icons.insert("future_cli".into(), png.into());
        p.theme = crate::domain::Theme::Dark;
    })
    .unwrap();
    let selected = BTreeSet::from(["preferences:managed".into()]);
    let bytes = old.path().join("icons.cliora");
    export_bundle(
        &db,
        &credentials,
        &registry,
        "correct-password",
        Some(&selected),
        &bytes,
    )
    .unwrap();
    let snapshot = unlock_bundle(&bytes, "correct-password").unwrap();
    let draft = preview_import(&destination, &credentials, &registry, snapshot).unwrap();
    apply_import(&destination, &credentials, &registry, &draft, &selected).unwrap();
    assert_eq!(
        destination.preferences().unwrap().tool_icons["future_cli"],
        png
    );
    assert_eq!(
        destination.preferences().unwrap().theme,
        crate::domain::Theme::Dark
    );
    let again = preview_import(
        &destination,
        &credentials,
        &registry,
        unlock_bundle(&bytes, "correct-password").unwrap(),
    )
    .unwrap();
    assert_eq!(again.items[0].status, "same");
    destination
        .update_preferences(|p| {
            p.tool_icons.remove("future_cli");
        })
        .unwrap();
    assert!(
        apply_import(&destination, &credentials, &registry, &again, &selected)
            .unwrap_err()
            .contains("本机资料已变化")
    );
    // Older packages omit icon fields; an empty map preserves their canonical digest.
    let old: PortablePreferences =
        serde_json::from_str(r#"{"managedTools":["codex"],"theme":"light"}"#).unwrap();
    assert!(old.tool_icons.is_empty());
    assert!(old.language.is_none());
    assert!(!serde_json::to_string(&old).unwrap().contains("toolIcons"));
}

fn bare_profile(
    id: &str,
    tool: &str,
    name: &str,
    files: BTreeMap<String, String>,
) -> RegisteredProfile {
    RegisteredProfile {
        editing: None,
        authentication: crate::native::profile::ProfileAuthentication::Native,
        revision: String::new(),
        id: id.into(),
        tool: tool.into(),
        name: name.into(),
        version: 1,
        inherit_common: false,
        files,
        suppressed: BTreeMap::new(),
        connection: None,
        native_credentials: BTreeMap::new(),
    }
}

struct RestoreRootsGuard;
impl Drop for RestoreRootsGuard {
    fn drop(&mut self) {
        set_restore_roots_for_test(None);
    }
}

#[test]
fn schema3_snapshot_restores_login_material_paths_and_reports_each_cli_failure() {
    let _roots = RestoreRootsGuard;
    let temp = tempfile::tempdir().unwrap();
    let source = database(&temp.path().join("old"));
    let credentials = MemoryCredentials::default();
    credentials.put("auth-secret", "oauth-token-value").unwrap();
    credentials
        .put("session-secret", "session-token-value")
        .unwrap();
    credentials
        .put("minimax-secret", "sk-minimax-plain")
        .unwrap();
    let auth_dir = temp.path().join("source-auth");
    fs::create_dir_all(&auth_dir).unwrap();
    fs::write(auth_dir.join("auth.json"), r#"{"token":"auth-file-token"}"#).unwrap();
    let sessions = temp.path().join("sessions");
    fs::create_dir_all(&sessions).unwrap();
    fs::write(sessions.join("note.txt"), "session-body-must-stay").unwrap();
    let kept = temp.path().join("kept-project");
    fs::create_dir_all(&kept).unwrap();
    let pi_project = temp.path().join("pi-project");
    fs::create_dir_all(&pi_project).unwrap();
    let codex_project = temp.path().join("codex-project");
    fs::create_dir_all(&codex_project).unwrap();
    fs::write(codex_project.join(".codex"), "not-a-directory").unwrap();
    let executable = temp.path().join("mcode.exe");
    fs::write(&executable, "").unwrap();
    let context = crate::accounts::NativeContext {
        id: "ctx-1".into(),
        tool_id: "codex".into(),
        root: auth_dir.clone(),
        config_root: auth_dir.clone(),
        auth_files: vec![auth_dir.join("auth.json")],
        history_roots: vec![sessions],
        resource_root: auth_dir,
        environment: BTreeMap::new(),
        remove_environment: Vec::new(),
        cli_args: Vec::new(),
    };
    let account = crate::accounts::AuthAccount {
        id: "acct-1".into(),
        tool_id: "codex".into(),
        provider: "chatgpt".into(),
        label: "Work account".into(),
        version: 4,
        state: crate::accounts::AccountState::SignedIn,
        identity: Some(crate::accounts::AccountIdentity {
            subject: "user-1".into(),
            email: None,
            plan: None,
            source: "test".into(),
        }),
        context: Some(context.clone()),
        retired_contexts: Vec::new(),
        pending_login: Some(crate::accounts::PendingLogin {
            id: "pending-should-not-travel".into(),
            expires_at: 9,
            context: context.clone(),
            previous_state: crate::accounts::AccountState::SignedOut,
            external_terminal: false,
            operation: "login".into(),
        }),
        checked_at: Some(9),
        detail: None,
    };
    let mut minimax_context = context.clone();
    minimax_context.id = "ctx-m".into();
    minimax_context.tool_id = "minimax_code".into();
    minimax_context.auth_files = vec![temp.path().join("auth-state.json")];
    fs::write(&minimax_context.auth_files[0], "login-material-kept").unwrap();
    let minimax_account = crate::accounts::AuthAccount {
        id: "acct-m".into(),
        tool_id: "minimax_code".into(),
        provider: "minimax".into(),
        label: "MiniMax".into(),
        version: 2,
        state: crate::accounts::AccountState::SignedIn,
        identity: None,
        context: Some(minimax_context),
        retired_contexts: Vec::new(),
        pending_login: None,
        checked_at: None,
        detail: None,
    };
    let mut oauth = bare_profile("oauth-profile", "codex", "OAuth", BTreeMap::new());
    oauth.authentication = crate::native::profile::ProfileAuthentication::OAuth {
        account_id: "acct-1".into(),
    };
    let mut secret = bare_profile("secret-profile", "codex", "Secret", BTreeMap::new());
    secret.native_credentials.insert(
        "auth".into(),
        BTreeMap::from([("access_token".into(), "auth-secret".into())]),
    );
    secret.native_credentials.insert(
        "config".into(),
        BTreeMap::from([("session_token".into(), "session-secret".into())]),
    );
    let mut minimax = bare_profile(
        "minimax-profile",
        "minimax_code",
        "MiniMax",
        BTreeMap::new(),
    );
    minimax.connection = Some(crate::native::profile::Connection {
        provider_id: "minimax".into(),
        interface_format: "anthropic_messages".into(),
        base_url: "https://api.minimaxi.com/anthropic".into(),
        model: "MiniMax-M2".into(),
        secret_ref: Some("minimax-secret".into()),
        auth_env_var: None,
        model_records: Vec::new(),
    });
    let pi = bare_profile(
        "pi-profile",
        "pi",
        "Pi",
        BTreeMap::from([(
            "settings".into(),
            r#"{"defaultProvider":"restore-marker"}"#.into(),
        )]),
    );
    let codex = bare_profile(
        "codex-profile",
        "codex",
        "Codex",
        BTreeMap::from([("settings".into(), "model = \"gpt-6\"\n".into())]),
    );
    let missing = bare_profile("missing-profile", "missing-cli", "Missing", BTreeMap::new());
    let pi_scope = format!("project:{}", pi_project.display());
    let codex_scope = format!("project:{}", codex_project.display());
    source.with_connection(|conn| {
        for profile in [&oauth, &secret, &minimax, &pi, &codex, &missing] {
            conn.execute("INSERT INTO native_profiles (id,tool,version,data) VALUES (?1,?2,1,?3)", rusqlite::params![profile.id, profile.tool, serde_json::to_string(profile).unwrap()]).unwrap();
        }
        for (scope, tool, id) in [(pi_scope.as_str(), "pi", "pi-profile"), (codex_scope.as_str(), "codex", "codex-profile"), ("global", "missing-cli", "missing-profile")] {
            conn.execute("INSERT INTO applied_bindings (scope_key,tool,profile_id,profile_version,managed) VALUES (?1,?2,?3,1,'{}')", rusqlite::params![scope, tool, id]).unwrap();
        }
        conn.execute("INSERT INTO projects (id,name,path,preferred_tool,last_opened) VALUES ('kept','Kept',?1,NULL,0)", [kept.to_str().unwrap()]).unwrap();
        conn.execute("INSERT INTO projects (id,name,path,preferred_tool,last_opened) VALUES ('missing','Missing','C:/missing/restore-project',NULL,0)", []).unwrap();
        for item in [&account, &minimax_account] {
            conn.execute("INSERT INTO auth_accounts (id,tool,version,data) VALUES (?1,?2,1,?3)", rusqlite::params![item.id, item.tool_id, serde_json::to_string(item).unwrap()]).unwrap();
        }
        Ok(())
    }).unwrap();
    let registry = Registry::builtins()
        .with_fixture_installation("pi", "1.0.0")
        .with_fixture_installation("codex", "0.160.0");
    let bundle = temp.path().join("full.cliora");
    let exported = export_bundle(
        &source,
        &credentials,
        &registry,
        "correct-password",
        None,
        &bundle,
    )
    .unwrap();
    assert!(exported >= 8);
    let snapshot = unlock_bundle(&bundle, "correct-password").unwrap();
    assert_eq!(snapshot.schema_version, 3);
    let rendered = serde_json::to_string(&snapshot).unwrap();
    assert!(!rendered.contains("session-body-must-stay"));
    assert!(!rendered.contains("pending-should-not-travel"));
    assert!(rendered.contains("sk-minimax-plain"));
    assert!(rendered.contains("oauth-token-value"));
    assert!(rendered.contains("session-token-value"));
    let PortablePayload::Account(exported_account) = &snapshot
        .entities
        .iter()
        .find(|entity| entity.key() == "account:acct-1")
        .unwrap()
        .payload
    else {
        panic!("account")
    };
    assert!(exported_account.account.pending_login.is_none());
    assert!(exported_account
        .account
        .context
        .as_ref()
        .unwrap()
        .history_roots
        .is_empty());
    assert!(exported_account
        .auth_files
        .iter()
        .any(|file| file.name == "auth.json" && !file.contents.is_empty()));
    let minimax_entity = snapshot
        .entities
        .iter()
        .find(|entity| entity.key() == "profile:minimax-profile")
        .unwrap();
    let PortablePayload::Profile(minimax_payload) = &minimax_entity.payload else {
        panic!("minimax profile")
    };
    assert!(!matches!(
        minimax_payload.profile.authentication,
        crate::native::profile::ProfileAuthentication::RebindRequired
    ));
    assert_eq!(
        minimax_payload.connection_secret.as_deref(),
        Some("sk-minimax-plain")
    );
    let fresh = database(&temp.path().join("new"));
    let received = MemoryCredentials::default();
    let home = temp.path().join("home");
    let base = temp.path().join("base");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&base).unwrap();
    set_restore_roots_for_test(Some((home, base.clone())));
    fresh
        .with_connection(|conn| {
            conn.execute(
                "INSERT INTO installation_choices (tool,path) VALUES ('minimax_code',?1)",
                [executable.to_str().unwrap()],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
    let draft = preview_import(&fresh, &received, &registry, snapshot).unwrap();
    assert!(draft
        .items
        .iter()
        .any(|item| item.key == "project:kept" && item.pending_fields.is_empty()));
    assert!(draft.items.iter().any(|item| item.key == "project:missing"
        && item.pending_fields.contains(&"项目本机目录".into())));
    let keys: BTreeSet<_> = draft.baseline.keys().cloned().collect();
    assert_eq!(
        apply_import(&fresh, &received, &registry, &draft, &keys).unwrap(),
        keys.len()
    );
    let restored = collect_snapshot(&fresh, &received, &registry).unwrap();
    let oauth_entity = restored
        .entities
        .iter()
        .find(|entity| entity.key() == "profile:oauth-profile")
        .unwrap();
    let PortablePayload::Profile(oauth_payload) = &oauth_entity.payload else {
        panic!("oauth profile")
    };
    assert!(
        matches!(&oauth_payload.profile.authentication, crate::native::profile::ProfileAuthentication::OAuth { account_id } if account_id == "acct-1")
    );
    let secret_entity = restored
        .entities
        .iter()
        .find(|entity| entity.key() == "profile:secret-profile")
        .unwrap();
    let PortablePayload::Profile(secret_payload) = &secret_entity.payload else {
        panic!("secret profile")
    };
    assert_eq!(
        secret_payload
            .native_secrets
            .get("auth")
            .and_then(|values| values.get("access_token"))
            .map(String::as_str),
        Some("oauth-token-value")
    );
    assert_eq!(
        secret_payload
            .native_secrets
            .get("config")
            .and_then(|values| values.get("session_token"))
            .map(String::as_str),
        Some("session-token-value")
    );
    assert!(!matches!(
        secret_payload.profile.authentication,
        crate::native::profile::ProfileAuthentication::RebindRequired
    ));
    fresh
        .with_connection(|conn| {
            let kept_path: String = conn
                .query_row("SELECT path FROM projects WHERE id='kept'", [], |row| {
                    row.get(0)
                })
                .unwrap();
            let missing_path: String = conn
                .query_row("SELECT path FROM projects WHERE id='missing'", [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(kept_path, kept.to_str().unwrap());
            assert_eq!(missing_path, "C:/missing/restore-project");
            Ok(())
        })
        .unwrap();
    let auth_file = base.join("accounts").join("ctx-1").join("auth.json");
    assert_eq!(
        fs::read_to_string(&auth_file).unwrap(),
        r#"{"token":"auth-file-token"}"#
    );
    assert!(
        fs::read_to_string(pi_project.join(".pi").join("settings.json"))
            .unwrap()
            .contains("restore-marker")
    );
    assert_eq!(
        fs::read_to_string(codex_project.join(".codex")).unwrap(),
        "not-a-directory"
    );
    let blockers = load_blockers(&fresh).unwrap();
    assert!(
        blockers
            .iter()
            .any(|item| item.key.contains("missing-cli") && item.action == "install"),
        "{blockers:?}"
    );
    assert!(
        blockers
            .iter()
            .any(|item| item.key.starts_with("binding:") && item.key.contains("codex")),
        "{blockers:?}"
    );
    assert!(
        blockers
            .iter()
            .any(|item| item.key == "account:acct-m" && item.action == "relogin"),
        "{blockers:?}"
    );
    assert!(
        fs::read_to_string(
            base.join("accounts")
                .join("ctx-m")
                .join("auth")
                .join("auth-state.json")
        )
        .is_ok()
            || walk_contains(&base.join("accounts").join("ctx-m"), "login-material-kept")
    );
    let again = preview_import(
        &fresh,
        &received,
        &registry,
        unlock_bundle(&bundle, "correct-password").unwrap(),
    )
    .unwrap();
    assert!(
        again.items.iter().all(|item| item.status == "same"),
        "{:?}",
        again
            .items
            .iter()
            .filter(|item| item.status != "same")
            .map(|item| item.key.clone())
            .collect::<Vec<_>>()
    );
}

fn walk_contains(root: &Path, needle: &str) -> bool {
    let mut pending = vec![root.to_path_buf()];
    while let Some(path) = pending.pop() {
        let Ok(entries) = fs::read_dir(&path) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            } else if fs::read_to_string(&path)
                .ok()
                .is_some_and(|text| text.contains(needle))
            {
                return true;
            }
        }
    }
    false
}

#[test]
fn schema_two_project_import_omits_path_and_short_password_writes_nothing() {
    let temp = tempfile::tempdir().unwrap();
    let db = database(temp.path());
    let credentials = MemoryCredentials::default();
    let registry = Registry::builtins();
    let snapshot = PortableSnapshot {
        schema_version: 2,
        entities: vec![PortableEntity {
            id: "project-old".into(),
            payload: PortablePayload::Project(PortableProject {
                id: "project-old".into(),
                name: "Old".into(),
                path: Some("C:/should-not-apply".into()),
                model_overrides: BTreeMap::new(),
            }),
        }],
    };
    validate_snapshot(&snapshot).unwrap();
    validate_snapshot(&PortableSnapshot {
        schema_version: 1,
        entities: snapshot.entities.clone(),
    })
    .unwrap();
    let draft = preview_import(&db, &credentials, &registry, snapshot).unwrap();
    apply_import(
        &db,
        &credentials,
        &registry,
        &draft,
        &draft.baseline.keys().cloned().collect(),
    )
    .unwrap();
    let path: Option<String> = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT path FROM projects WHERE id='project-old'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(path, None);
    let destination = temp.path().join("short.cliora");
    assert!(export_bundle(
        &db,
        &credentials,
        &registry,
        "too-short",
        None,
        &destination
    )
    .unwrap_err()
    .contains("12"));
    assert!(!destination.exists());
}

#[test]
fn bundle_restore_keeps_conflict_local_and_applies_other_items() {
    let temp = tempfile::tempdir().unwrap();
    let db = database(&temp.path().join("local"));
    let credentials = MemoryCredentials::default();
    credentials.put("local-secret", "sk-local-plain").unwrap();
    let registry = Registry::builtins();
    let mut profile = bare_profile("profile-1", "codex", "Local", BTreeMap::new());
    profile.connection = Some(crate::native::profile::Connection {
        provider_id: "openai".into(),
        interface_format: "openai_responses".into(),
        base_url: "https://api.example.test/v1".into(),
        model: "gpt-6".into(),
        secret_ref: Some("local-secret".into()),
        auth_env_var: None,
        model_records: Vec::new(),
    });
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO native_profiles (id,tool,version,data) VALUES (?1,?2,1,?3)",
            rusqlite::params![
                profile.id,
                profile.tool,
                serde_json::to_string(&profile).unwrap()
            ],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    let mut snapshot = collect_snapshot(&db, &credentials, &registry).unwrap();
    let entity = snapshot
        .entities
        .iter_mut()
        .find(|entity| entity.key() == "profile:profile-1")
        .unwrap();
    let PortablePayload::Profile(value) = &mut entity.payload else {
        panic!("profile")
    };
    value.profile.name = "Remote".into();
    snapshot.entities.push(PortableEntity {
        id: "project-new".into(),
        payload: PortablePayload::Project(PortableProject {
            id: "project-new".into(),
            name: "Added".into(),
            path: None,
            model_overrides: BTreeMap::new(),
        }),
    });
    let draft = preview_import(&db, &credentials, &registry, snapshot).unwrap();
    assert!(draft
        .items
        .iter()
        .any(|item| item.key == "profile:profile-1" && item.status == "conflict"));
    assert!(draft
        .items
        .iter()
        .any(|item| item.key == "project:project-new" && item.status == "new"));
    restore_preview(&db, &credentials, &registry, &draft).unwrap();
    let saved: String = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT data FROM native_profiles WHERE id='profile-1'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert!(saved.contains("Local"), "{saved}");
    assert!(!saved.contains("Remote"));
    let name: String = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT name FROM projects WHERE id='project-new'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(name, "Added");
    let raw: String = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT value FROM app_settings WHERE key='bundle_conflicts'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert!(!raw.contains("sk-local-plain"), "{raw}");
    let records: Vec<sync::BundleHold> = serde_json::from_str(&raw).unwrap();
    let conflict = records
        .iter()
        .find(|item| item.key == "profile:profile-1")
        .unwrap();
    assert!(conflict.local_present);
    assert!(conflict.version_id.starts_with("bundle:"));
    let PortablePayload::Profile(held) = &conflict.entity.payload else {
        panic!("held profile")
    };
    assert_eq!(held.profile.name, "Remote");
    assert!(held.connection_secret.is_none());
    let id = held
        .profile
        .connection
        .as_ref()
        .unwrap()
        .secret_ref
        .as_deref()
        .unwrap();
    assert_eq!(credentials.get(id).unwrap(), "sk-local-plain");
    let visible = sync::status(&db).unwrap();
    assert!(visible
        .conflicts
        .iter()
        .any(|item| item.key == "profile:profile-1"
            && item
                .versions
                .iter()
                .all(|version| version.entity.is_none() && version.id == conflict.version_id)));
}

#[test]
fn binding_update_keeps_existing_managed_until_apply_rewrites_it() {
    let temp = tempfile::tempdir().unwrap();
    let db = database(temp.path());
    let credentials = MemoryCredentials::default();
    let registry = Registry::builtins();
    let managed = r#"{"settings":{"/keep":true}}"#;
    db.with_connection(|conn| {
        conn.execute("INSERT INTO applied_bindings (scope_key,tool,profile_id,profile_version,managed) VALUES ('global','codex','profile-old',4,?1)", [managed]).unwrap();
        Ok(())
    }).unwrap();
    let snapshot = PortableSnapshot {
        schema_version: 3,
        entities: vec![PortableEntity {
            id: binding_id("codex", "global"),
            payload: PortablePayload::Binding(PortableBinding {
                scope_key: "global".into(),
                tool: "codex".into(),
                profile_id: "profile-new".into(),
                context_id: None,
            }),
        }],
    };
    let draft = preview_import(&db, &credentials, &registry, snapshot).unwrap();
    let key = format!("binding:{}", binding_id("codex", "global"));
    assert_eq!(
        draft
            .items
            .iter()
            .find(|item| item.key == key)
            .unwrap()
            .status,
        "conflict"
    );
    apply_import(&db, &credentials, &registry, &draft, &BTreeSet::from([key])).unwrap();
    let (saved, version, profile_id): (String, i64, String) = db.with_connection(|conn| {
        conn.query_row("SELECT managed, profile_version, profile_id FROM applied_bindings WHERE tool='codex' AND scope_key='global'", [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).map_err(|error| error.to_string())
    }).unwrap();
    assert!(saved.contains("/keep"), "{saved}");
    assert_eq!(version, -1);
    assert_eq!(profile_id, "profile-new");
}

#[test]
fn schema3_language_round_trips_and_older_packages_do_not_clear_it() {
    let temp = tempfile::tempdir().unwrap();
    let source = database(&temp.path().join("source"));
    source
        .update_preferences(|preferences| preferences.language = Some("en".into()))
        .unwrap();
    let credentials = MemoryCredentials::default();
    let registry = Registry::builtins();
    let bundle = temp.path().join("language.cliora");
    export_bundle(
        &source,
        &credentials,
        &registry,
        "correct-password",
        None,
        &bundle,
    )
    .unwrap();
    let snapshot = unlock_bundle(&bundle, "correct-password").unwrap();
    let PortablePayload::Preferences(preferences) = &snapshot
        .entities
        .iter()
        .find(|entity| entity.key() == "preferences:managed")
        .unwrap()
        .payload
    else {
        panic!("preferences")
    };
    assert_eq!(preferences.language.as_deref(), Some("en"));
    let fresh = database(&temp.path().join("fresh"));
    let draft = preview_import(&fresh, &credentials, &registry, snapshot.clone()).unwrap();
    restore_preview(&fresh, &credentials, &registry, &draft).unwrap();
    assert_eq!(fresh.preferences().unwrap().language.as_deref(), Some("en"));
    let local = database(&temp.path().join("local"));
    local
        .update_preferences(|preferences| preferences.language = Some("zh".into()))
        .unwrap();
    let conflict = preview_import(&local, &credentials, &registry, snapshot).unwrap();
    assert!(conflict
        .items
        .iter()
        .any(|item| item.key == "preferences:managed" && item.status == "conflict"));
    restore_preview(&local, &credentials, &registry, &conflict).unwrap();
    assert_eq!(local.preferences().unwrap().language.as_deref(), Some("zh"));
    let older = PortableSnapshot {
        schema_version: 2,
        entities: vec![PortableEntity {
            id: "managed".into(),
            payload: PortablePayload::Preferences(PortablePreferences {
                managed_tools: vec!["pi".into()],
                theme: "dark".into(),
                tool_icons: BTreeMap::new(),
                language: None,
            }),
        }],
    };
    let draft = preview_import(&local, &credentials, &registry, older).unwrap();
    apply_import(
        &local,
        &credentials,
        &registry,
        &draft,
        &draft.baseline.keys().cloned().collect(),
    )
    .unwrap();
    let saved = local.preferences().unwrap();
    assert_eq!(saved.theme, crate::domain::Theme::Dark);
    assert_eq!(saved.language.as_deref(), Some("zh"));
}

fn insert_account(db: &Database, account: &crate::accounts::AuthAccount) {
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO auth_accounts (id,tool,version,data) VALUES (?1,?2,1,?3) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
            rusqlite::params![account.id, account.tool_id, serde_json::to_string(account).unwrap()],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
}

fn sample_account(
    id: &str,
    context: crate::accounts::NativeContext,
) -> crate::accounts::AuthAccount {
    crate::accounts::AuthAccount {
        id: id.into(),
        tool_id: "codex".into(),
        provider: "test".into(),
        label: format!("Work {id}"),
        version: 1,
        state: crate::accounts::AccountState::SignedIn,
        identity: None,
        context: Some(context),
        retired_contexts: Vec::new(),
        pending_login: None,
        checked_at: None,
        detail: None,
    }
}

#[test]
fn unreadable_auth_file_blocks_only_that_account() {
    let temp = tempfile::tempdir().unwrap();
    let db = database(temp.path());
    let credentials = MemoryCredentials::default();
    let registry = Registry::builtins();
    db.with_connection(|conn| {
        conn.execute("INSERT INTO projects (id,name,path,preferred_tool,last_opened) VALUES ('kept','Kept',NULL,NULL,0)", []).unwrap();
        Ok(())
    })
    .unwrap();
    let root = temp.path().join("auth");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("history.txt"), "session-body").unwrap();
    let context = crate::accounts::NativeContext {
        id: "ctx".into(),
        tool_id: "codex".into(),
        root: root.clone(),
        config_root: root.clone(),
        auth_files: vec![root.join("missing.json")],
        history_roots: vec![root.clone()],
        resource_root: root.clone(),
        environment: BTreeMap::new(),
        remove_environment: Vec::new(),
        cli_args: Vec::new(),
    };
    let account = sample_account("acct", context.clone());
    insert_account(&db, &account);
    let destination = temp.path().join("partial.cliora");
    let exported = export_bundle(
        &db,
        &credentials,
        &registry,
        "correct-password",
        None,
        &destination,
    )
    .unwrap();
    assert!(exported >= 1);
    let snapshot = unlock_bundle(&destination, "correct-password").unwrap();
    let rendered = serde_json::to_string(&snapshot).unwrap();
    assert!(rendered.contains("Kept"), "{rendered}");
    assert!(
        !rendered.contains("account:acct") && !rendered.contains("\"acct\""),
        "{rendered}"
    );
    let blockers = load_blockers(&db).unwrap();
    assert!(
        blockers
            .iter()
            .any(|item| item.key == "account:acct" && item.detail.contains("无法读取")),
        "{blockers:?}"
    );
    let row_still_there: bool = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM auth_accounts WHERE id='acct')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert!(row_still_there);

    let mut invalid = context.clone();
    invalid.auth_files = vec![PathBuf::from("bad:name")];
    insert_account(&db, &sample_account("acct", invalid));
    let named = collect_snapshot(&db, &credentials, &registry).unwrap();
    assert!(named
        .entities
        .iter()
        .any(|entity| entity.key() == "project:kept"));
    assert!(named
        .entities
        .iter()
        .all(|entity| entity.key() != "account:acct"));
    assert!(load_blockers(&db)
        .unwrap()
        .iter()
        .any(|item| item.detail.contains("文件名无效")));

    let huge = root.join("huge.bin");
    fs::File::create(&huge)
        .unwrap()
        .set_len(4 * 1024 * 1024 + 1)
        .unwrap();
    let mut oversized = context;
    oversized.auth_files = vec![huge];
    insert_account(&db, &sample_account("acct", oversized));
    let limited = collect_snapshot(&db, &credentials, &registry).unwrap();
    assert!(limited
        .entities
        .iter()
        .any(|entity| entity.key() == "project:kept"));
    assert!(limited
        .entities
        .iter()
        .all(|entity| entity.key() != "account:acct"));
    assert!(load_blockers(&db)
        .unwrap()
        .iter()
        .any(|item| item.key == "account:acct" && item.detail.contains("4MiB")));

    let incoming = PortableSnapshot {
        schema_version: 3,
        entities: vec![PortableEntity {
            id: "project-new".into(),
            payload: PortablePayload::Project(PortableProject {
                id: "project-new".into(),
                name: "Added".into(),
                path: None,
                model_overrides: BTreeMap::new(),
            }),
        }],
    };
    let draft = preview_import(&db, &credentials, &registry, incoming).unwrap();
    restore_preview(&db, &credentials, &registry, &draft).unwrap();
    let name: String = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT name FROM projects WHERE id='project-new'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(name, "Added");
    assert!(collect_snapshot(&db, &credentials, &registry)
        .unwrap()
        .entities
        .iter()
        .any(|entity| entity.key() == "project:project-new"));
}

#[test]
fn missing_auth_candidate_exports_the_login_file_that_exists() {
    let _roots = RestoreRootsGuard;
    let temp = tempfile::tempdir().unwrap();
    let db = database(temp.path());
    let credentials = MemoryCredentials::default();
    let registry = Registry::builtins();
    let root = temp.path().join("minimax-home");
    let present = root
        .join("auth")
        .join("prod")
        .join("cn")
        .join("mcode-public")
        .join("auth-state.json");
    let missing = root
        .join("auth")
        .join("dev")
        .join("cn")
        .join("mcode-public")
        .join("auth-state.json");
    fs::create_dir_all(present.parent().unwrap()).unwrap();
    fs::write(&present, "login-material-kept").unwrap();
    let account = sample_account(
        "acct-m",
        crate::accounts::NativeContext {
            id: "ctx-m".into(),
            tool_id: "minimax_code".into(),
            root: root.clone(),
            config_root: root.clone(),
            auth_files: vec![missing.clone(), present.clone()],
            history_roots: Vec::new(),
            resource_root: root,
            environment: BTreeMap::new(),
            remove_environment: Vec::new(),
            cli_args: Vec::new(),
        },
    );
    let mut account = account;
    account.tool_id = "minimax_code".into();
    account.label = "MiniMax".into();
    insert_account(&db, &account);
    let snapshot = collect_snapshot(&db, &credentials, &registry).unwrap();
    let PortablePayload::Account(exported) = &snapshot
        .entities
        .iter()
        .find(|entity| entity.key() == "account:acct-m")
        .unwrap()
        .payload
    else {
        panic!("account");
    };
    assert_eq!(exported.auth_files.len(), 1);
    assert_eq!(exported.auth_files[0].name, "auth-state.json");
    assert_eq!(
        exported.auth_files[0].relative,
        "auth/prod/cn/mcode-public/auth-state.json"
    );
    assert!(load_blockers(&db)
        .unwrap()
        .iter()
        .all(|item| item.key != "account:acct-m"));
    record_blocker(
        &db,
        RestoreBlocker {
            key: "account:acct-m".into(),
            label: "MiniMax".into(),
            action: "relogin".into(),
            detail: "账号 MiniMax 的认证文件无法读取，不能当作已导出".into(),
        },
    );
    retry_native_blocker(&db, &credentials, &registry, "account:acct-m").unwrap();
    assert!(load_blockers(&db)
        .unwrap()
        .iter()
        .all(|item| item.key != "account:acct-m"));

    let fresh = database(&temp.path().join("restored"));
    let home = temp.path().join("home");
    let base = temp.path().join("base");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&base).unwrap();
    set_restore_roots_for_test(Some((home, base.clone())));
    let draft = preview_import(&fresh, &credentials, &registry, snapshot).unwrap();
    let keys: BTreeSet<_> = draft.baseline.keys().cloned().collect();
    apply_import(&fresh, &credentials, &registry, &draft, &keys).unwrap();
    let restored = base
        .join("accounts")
        .join("ctx-m")
        .join("auth")
        .join("prod")
        .join("cn")
        .join("mcode-public")
        .join("auth-state.json");
    assert_eq!(
        fs::read_to_string(&restored).unwrap(),
        "login-material-kept"
    );
    assert!(!base
        .join("accounts")
        .join("ctx-m")
        .join("auth")
        .join("dev")
        .exists());
}

#[test]
fn unreadable_auth_account_is_held_instead_of_replaced() {
    let temp = tempfile::tempdir().unwrap();
    let db = database(temp.path());
    let credentials = MemoryCredentials::default();
    let registry = Registry::builtins();
    let root = temp.path().join("auth");
    fs::create_dir_all(&root).unwrap();
    let missing = root.join("missing.json");
    let mut local = sample_account(
        "acct",
        crate::accounts::NativeContext {
            id: "ctx".into(),
            tool_id: "codex".into(),
            root: root.clone(),
            config_root: root.clone(),
            auth_files: vec![missing.clone()],
            history_roots: Vec::new(),
            resource_root: root,
            environment: BTreeMap::new(),
            remove_environment: Vec::new(),
            cli_args: Vec::new(),
        },
    );
    local.label = "Local Label".into();
    local.identity = Some(crate::accounts::AccountIdentity {
        subject: "local-subject".into(),
        email: None,
        plan: None,
        source: "native".into(),
    });
    insert_account(&db, &local);
    let mut remote = local.clone();
    remote.label = "Remote Label".into();
    remote.identity = Some(crate::accounts::AccountIdentity {
        subject: "remote-subject".into(),
        email: None,
        plan: None,
        source: "bundle".into(),
    });
    if let Some(context) = remote.context.as_mut() {
        context.auth_files = vec![PathBuf::from("auth.json")];
    }
    let snapshot = PortableSnapshot {
        schema_version: 3,
        entities: vec![
            PortableEntity {
                id: "acct".into(),
                payload: PortablePayload::Account(Box::new(PortableAccount {
                    account: remote,
                    auth_files: vec![PortableAuthFile {
                        context_id: "ctx".into(),
                        name: "auth.json".into(),
                        relative: String::new(),
                        contents: STANDARD.encode("remote-login"),
                    }],
                })),
            },
            PortableEntity {
                id: "acct-new".into(),
                payload: PortablePayload::Account(Box::new(PortableAccount {
                    account: sample_account(
                        "acct-new",
                        crate::accounts::NativeContext {
                            id: "ctx-new".into(),
                            tool_id: "codex".into(),
                            root: PathBuf::from("/source"),
                            config_root: PathBuf::from("/source"),
                            auth_files: vec![PathBuf::from("fresh.json")],
                            history_roots: Vec::new(),
                            resource_root: PathBuf::from("/source"),
                            environment: BTreeMap::new(),
                            remove_environment: Vec::new(),
                            cli_args: Vec::new(),
                        },
                    ),
                    auth_files: vec![PortableAuthFile {
                        context_id: "ctx-new".into(),
                        name: "fresh.json".into(),
                        relative: String::new(),
                        contents: STANDARD.encode("fresh-login"),
                    }],
                })),
            },
            PortableEntity {
                id: "project-new".into(),
                payload: PortablePayload::Project(PortableProject {
                    id: "project-new".into(),
                    name: "Added".into(),
                    path: None,
                    model_overrides: BTreeMap::new(),
                }),
            },
        ],
    };
    let draft = preview_import(&db, &credentials, &registry, snapshot).unwrap();
    assert_eq!(
        draft
            .items
            .iter()
            .find(|item| item.key == "account:acct")
            .unwrap()
            .status,
        "conflict"
    );
    assert_eq!(
        draft
            .items
            .iter()
            .find(|item| item.key == "account:acct-new")
            .unwrap()
            .status,
        "new"
    );
    assert_eq!(
        draft
            .items
            .iter()
            .find(|item| item.key == "project:project-new")
            .unwrap()
            .status,
        "new"
    );
    restore_preview(&db, &credentials, &registry, &draft).unwrap();
    let saved: String = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT data FROM auth_accounts WHERE id='acct'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert!(
        saved.contains("Local Label")
            && saved.contains("local-subject")
            && saved.contains("missing.json"),
        "{saved}"
    );
    assert!(
        !saved.contains("Remote Label") && !saved.contains("remote-subject"),
        "{saved}"
    );
    let fresh: String = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT data FROM auth_accounts WHERE id='acct-new'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert!(fresh.contains("Work acct-new"), "{fresh}");
    let project: String = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT name FROM projects WHERE id='project-new'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(project, "Added");
    let raw: String = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT value FROM app_settings WHERE key='bundle_conflicts'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    let holds: Vec<sync::BundleHold> = serde_json::from_str(&raw).unwrap();
    let hold = holds
        .iter()
        .find(|item| item.key == "account:acct")
        .unwrap();
    let PortablePayload::Account(held) = &hold.entity.payload else {
        panic!("held account")
    };
    assert_eq!(held.account.label, "Remote Label");
    assert!(held.auth_files.iter().any(|file| file.name == "auth.json"));
    assert!(holds.iter().all(|item| item.key != "account:acct-new"));
    let blockers = load_blockers(&db).unwrap();
    assert!(
        blockers.iter().any(|item| item.key == "account:acct"
            && item.detail.contains("无法读取")
            && item.detail.contains("不能当作已导出")),
        "{blockers:?}"
    );
}

#[test]
fn bundle_conflict_can_be_chosen_without_webdav() {
    let temp = tempfile::tempdir().unwrap();
    let db = database(temp.path());
    let credentials = MemoryCredentials::default();
    let registry = Registry::builtins();
    credentials.put("local-secret", "sk-local-plain").unwrap();
    let mut profile = bare_profile("profile-1", "codex", "Local", BTreeMap::new());
    profile.connection = Some(crate::native::profile::Connection {
        provider_id: "openai".into(),
        interface_format: "openai_responses".into(),
        base_url: "https://api.example.test/v1".into(),
        model: "gpt-6".into(),
        secret_ref: Some("local-secret".into()),
        auth_env_var: None,
        model_records: Vec::new(),
    });
    profile.native_credentials.insert(
        "auth".into(),
        BTreeMap::from([("access_token".into(), "local-secret".into())]),
    );
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO native_profiles (id,tool,version,data) VALUES (?1,?2,1,?3)",
            rusqlite::params![
                profile.id,
                profile.tool,
                serde_json::to_string(&profile).unwrap()
            ],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    let mut snapshot = collect_snapshot(&db, &credentials, &registry).unwrap();
    let entity = snapshot
        .entities
        .iter_mut()
        .find(|entity| entity.key() == "profile:profile-1")
        .unwrap();
    let PortablePayload::Profile(value) = &mut entity.payload else {
        panic!("profile")
    };
    value.profile.name = "Remote".into();
    value.connection_secret = Some("sk-remote-plain".into());
    value
        .native_secrets
        .get_mut("auth")
        .unwrap()
        .insert("access_token".into(), "native-remote-plain".into());
    let draft = preview_import(&db, &credentials, &registry, snapshot).unwrap();
    assert!(draft
        .items
        .iter()
        .any(|item| item.key == "profile:profile-1" && item.status == "conflict"));
    restore_preview(&db, &credentials, &registry, &draft).unwrap();
    let before: String = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT data FROM native_profiles WHERE id='profile-1'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert!(
        before.contains("Local") && !before.contains("Remote"),
        "{before}"
    );
    let visible = sync::status(&db).unwrap();
    let version_id = visible
        .conflicts
        .iter()
        .find(|item| item.key == "profile:profile-1")
        .unwrap()
        .versions[0]
        .id
        .clone();
    assert!(version_id.starts_with("bundle:"));
    let preview =
        sync::preview_conflict(&db, &credentials, &registry, "profile:profile-1").unwrap();
    assert!(preview
        .versions
        .iter()
        .any(|version| version.id == version_id && version.summary.contains("Remote")));
    assert!(sync::resolve(
        &db,
        &credentials,
        &registry,
        "profile:profile-1",
        Some(&version_id)
    )
    .is_ok());
    let saved = collect_snapshot(&db, &credentials, &registry).unwrap();
    let PortablePayload::Profile(applied) = &saved
        .entities
        .iter()
        .find(|entity| entity.key() == "profile:profile-1")
        .unwrap()
        .payload
    else {
        panic!("profile")
    };
    assert_eq!(applied.profile.name, "Remote");
    assert_eq!(
        applied.connection_secret.as_deref(),
        Some("sk-remote-plain")
    );
    assert_eq!(
        applied
            .native_secrets
            .get("auth")
            .and_then(|values| values.get("access_token"))
            .map(String::as_str),
        Some("native-remote-plain")
    );
    assert!(sync::status(&db)
        .unwrap()
        .conflicts
        .iter()
        .all(|item| item.key != "profile:profile-1"));
    let stored: Option<String> = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT value FROM app_settings WHERE key='bundle_conflicts'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())
        })
        .unwrap();
    let stored = stored.unwrap_or_else(|| "[]".into());
    assert!(
        stored == "[]" || !stored.contains("profile:profile-1"),
        "{stored}"
    );
}

#[test]
fn auth_write_failure_drops_the_path_and_keeps_other_items() {
    let _roots = RestoreRootsGuard;
    let temp = tempfile::tempdir().unwrap();
    let db = database(temp.path());
    let credentials = MemoryCredentials::default();
    let registry = Registry::builtins();
    let profile = bare_profile("profile-1", "codex", "Local", BTreeMap::new());
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO native_profiles (id,tool,version,data) VALUES (?1,?2,1,?3)",
            rusqlite::params![profile.id, profile.tool, serde_json::to_string(&profile).unwrap()],
        )
        .unwrap();
        conn.execute("INSERT INTO projects (id,name,path,preferred_tool,last_opened) VALUES ('old','Old',NULL,NULL,0)", []).unwrap();
        Ok(())
    })
    .unwrap();
    let mut snapshot = collect_snapshot(&db, &credentials, &registry).unwrap();
    let entity = snapshot
        .entities
        .iter_mut()
        .find(|entity| entity.key() == "profile:profile-1")
        .unwrap();
    let PortablePayload::Profile(value) = &mut entity.payload else {
        panic!("profile")
    };
    value.profile.name = "Remote".into();
    let home = temp.path().join("home");
    let base = temp.path().join("base");
    fs::create_dir_all(&home).unwrap();
    let blocked_root = base.join("accounts").join("ctx-write");
    fs::create_dir_all(&blocked_root).unwrap();
    fs::create_dir(blocked_root.join("auth.json")).unwrap();
    set_restore_roots_for_test(Some((home, base.clone())));
    snapshot.entities.push(PortableEntity {
        id: "project-new".into(),
        payload: PortablePayload::Project(PortableProject {
            id: "project-new".into(),
            name: "Added".into(),
            path: None,
            model_overrides: BTreeMap::new(),
        }),
    });
    snapshot.entities.push(PortableEntity {
        id: "acct-write".into(),
        payload: PortablePayload::Account(Box::new(PortableAccount {
            account: sample_account(
                "acct-write",
                crate::accounts::NativeContext {
                    id: "ctx-write".into(),
                    tool_id: "codex".into(),
                    root: PathBuf::from("/source"),
                    config_root: PathBuf::from("/source"),
                    auth_files: vec![PathBuf::from("auth.json")],
                    history_roots: Vec::new(),
                    resource_root: PathBuf::from("/source"),
                    environment: BTreeMap::new(),
                    remove_environment: Vec::new(),
                    cli_args: Vec::new(),
                },
            ),
            auth_files: vec![PortableAuthFile {
                context_id: "ctx-write".into(),
                name: "auth.json".into(),
                relative: String::new(),
                contents: STANDARD.encode("login-bytes"),
            }],
        })),
    });
    let draft = preview_import(&db, &credentials, &registry, snapshot).unwrap();
    assert!(draft
        .items
        .iter()
        .any(|item| item.key == "profile:profile-1" && item.status == "conflict"));
    let imported = restore_preview(&db, &credentials, &registry, &draft).unwrap();
    assert!(imported >= 2, "{imported}");
    let project: String = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT name FROM projects WHERE id='project-new'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(project, "Added");
    let saved: String = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT data FROM native_profiles WHERE id='profile-1'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert!(
        saved.contains("Local") && !saved.contains("Remote"),
        "{saved}"
    );
    let account_json: String = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT data FROM auth_accounts WHERE id='acct-write'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert!(!account_json.contains("auth.json"), "{account_json}");
    let blockers = load_blockers(&db).unwrap();
    assert!(
        blockers
            .iter()
            .any(|item| item.key == "account:acct-write" && item.detail.contains("无法写入")),
        "{blockers:?}"
    );
    assert!(collect_snapshot(&db, &credentials, &registry).is_ok());
    assert!(sync::status(&db)
        .unwrap()
        .conflicts
        .iter()
        .any(|item| item.key == "profile:profile-1"));
}

#[test]
fn choosing_a_missing_directory_clears_its_relink_blocker_and_applies_the_saved_binding() {
    let _roots = RestoreRootsGuard;
    let temp = tempfile::tempdir().unwrap();
    let db = database(temp.path());
    let credentials = MemoryCredentials::default();
    let missing = "C:/missing/restore-project";
    let profile = bare_profile(
        "pi-profile",
        "pi",
        "Pi",
        BTreeMap::from([(
            "settings".into(),
            r#"{"defaultProvider":"restore-marker"}"#.into(),
        )]),
    );
    let old_scope = format!("project:{missing}");
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO native_profiles (id,tool,version,data) VALUES (?1,?2,1,?3)",
            rusqlite::params![profile.id, profile.tool, serde_json::to_string(&profile).unwrap()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO projects (id,name,path,preferred_tool,last_opened) VALUES ('missing','Missing',?1,NULL,0)",
            [missing],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO applied_bindings (scope_key,tool,profile_id,profile_version,managed) VALUES (?1,'pi',?2,-1,'{}')",
            rusqlite::params![old_scope, profile.id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO applied_bindings (scope_key,tool,profile_id,profile_version,managed) VALUES ('global','codex','other',1,'{}')",
            [],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    record_blocker(
        &db,
        RestoreBlocker {
            key: format!("binding:{}", binding_id("pi", &old_scope)),
            label: "pi 活动配置".into(),
            action: "relink".into(),
            detail: format!("目录不存在：{missing}"),
        },
    );
    record_blocker(
        &db,
        RestoreBlocker {
            key: "binding:install".into(),
            label: "其它 CLI".into(),
            action: "install".into(),
            detail: "未发现可执行文件".into(),
        },
    );
    record_blocker(
        &db,
        RestoreBlocker {
            key: "binding:other-path".into(),
            label: "其它目录".into(),
            action: "relink".into(),
            detail: "目录不存在：C:/other-missing".into(),
        },
    );
    let moved = temp.path().join("chosen");
    fs::create_dir(&moved).unwrap();
    let home = temp.path().join("home");
    fs::create_dir_all(&home).unwrap();
    set_restore_roots_for_test(Some((home, temp.path().to_path_buf())));
    let registry = Registry::builtins().with_fixture_installation("pi", "1.0.0");
    let linked = crate::projects::relink(&db, "missing", moved.to_str().unwrap()).unwrap();
    apply_relinked_directory(
        &db,
        &credentials,
        &registry,
        missing,
        linked.path.as_deref().unwrap(),
    )
    .unwrap();
    let blockers = load_blockers(&db).unwrap();
    assert!(
        blockers
            .iter()
            .all(|item| item.detail != format!("目录不存在：{missing}")),
        "{blockers:?}"
    );
    assert!(
        blockers
            .iter()
            .any(|item| item.key == "binding:install" && item.action == "install"),
        "{blockers:?}"
    );
    assert!(
        blockers
            .iter()
            .any(|item| item.key == "binding:other-path" && item.action == "relink"),
        "{blockers:?}"
    );
    let again = sync::status(&db).unwrap();
    assert!(
        again
            .blockers
            .iter()
            .all(|item| item.detail != format!("目录不存在：{missing}")),
        "{:?}",
        again.blockers
    );
    let scope: String = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT scope_key FROM applied_bindings WHERE tool='pi'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(
        scope,
        format!("project:{}", linked.path.as_deref().unwrap())
    );
    let global: String = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT scope_key FROM applied_bindings WHERE tool='codex'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(global, "global");
    let written = fs::read_to_string(moved.join(".pi").join("settings.json")).unwrap();
    assert!(written.contains("restore-marker"), "{written}");
    let reloaded = load_blockers(&db).unwrap();
    assert!(reloaded
        .iter()
        .all(|item| item.detail != format!("目录不存在：{missing}")));
}

#[test]
fn occupied_directory_write_failure_keeps_source_binding_and_relink_blocker() {
    let _roots = RestoreRootsGuard;
    let temp = tempfile::tempdir().unwrap();
    let db = database(temp.path());
    let credentials = MemoryCredentials::default();
    let missing = "C:/missing/restore-project";
    let profile = bare_profile(
        "pi-profile",
        "pi",
        "Pi",
        BTreeMap::from([(
            "settings".into(),
            r#"{"defaultProvider":"restore-marker"}"#.into(),
        )]),
    );
    let occupied_profile = bare_profile("occupied-profile", "pi", "Occupied", BTreeMap::new());
    let old_scope = format!("project:{missing}");
    let source_key = format!("binding:{}", binding_id("pi", &old_scope));
    let managed = r#"{"settings":{"/defaultProvider":"occupied-marker"}}"#;
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO native_profiles (id,tool,version,data) VALUES (?1,?2,1,?3)",
            rusqlite::params![profile.id, profile.tool, serde_json::to_string(&profile).unwrap()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO native_profiles (id,tool,version,data) VALUES (?1,?2,1,?3)",
            rusqlite::params![occupied_profile.id, occupied_profile.tool, serde_json::to_string(&occupied_profile).unwrap()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO projects (id,name,path,preferred_tool,last_opened) VALUES ('missing','Missing',?1,NULL,0)",
            [missing],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO applied_bindings (scope_key,tool,profile_id,profile_version,managed) VALUES (?1,'pi',?2,-1,'{}')",
            rusqlite::params![old_scope, profile.id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO applied_bindings (scope_key,tool,profile_id,profile_version,managed) VALUES ('global','codex','other',1,'{}')",
            [],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    record_blocker(
        &db,
        RestoreBlocker {
            key: source_key.clone(),
            label: "pi 活动配置".into(),
            action: "relink".into(),
            detail: format!("目录不存在：{missing}"),
        },
    );
    record_blocker(
        &db,
        RestoreBlocker {
            key: "binding:install".into(),
            label: "其它 CLI".into(),
            action: "install".into(),
            detail: "未发现可执行文件".into(),
        },
    );
    record_blocker(
        &db,
        RestoreBlocker {
            key: "binding:other-path".into(),
            label: "其它目录".into(),
            action: "relink".into(),
            detail: "目录不存在：C:/other-missing".into(),
        },
    );
    let before = collect_snapshot(&db, &credentials, &Registry::builtins()).unwrap();
    let source_entity = before
        .entities
        .iter()
        .find(|entity| entity.key() == source_key)
        .unwrap();
    let before_digest = source_entity.digest().unwrap();
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO sync_entity_state (entity_key,local_digest,heads_json,deleted) VALUES (?1,?2,'[\"head-1\"]',0)",
            rusqlite::params![source_key, before_digest],
        )
        .map_err(|error| error.to_string())
    })
    .unwrap();
    let moved = temp.path().join("chosen");
    fs::create_dir(&moved).unwrap();
    let home = temp.path().join("home");
    fs::create_dir_all(&home).unwrap();
    set_restore_roots_for_test(Some((home, temp.path().to_path_buf())));
    let registry = Registry::builtins().with_fixture_installation("pi", "1.0.0");
    let linked = crate::projects::relink(&db, "missing", moved.to_str().unwrap()).unwrap();
    let new_path = linked.path.as_deref().unwrap();
    let occupied_scope = crate::native::apply::scope_key(
        crate::native::adapter::Scope::Project,
        Some(Path::new(new_path)),
    )
    .unwrap();
    let occupied_dir = occupied_scope.strip_prefix("project:").unwrap();
    fs::create_dir_all(Path::new(occupied_dir).join(".pi")).unwrap();
    fs::write(
        Path::new(occupied_dir).join(".pi").join("settings.json"),
        r#"{"defaultProvider":"external-marker"}"#,
    )
    .unwrap();
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO applied_bindings (scope_key,tool,profile_id,profile_version,managed) VALUES (?1,'pi','occupied-profile',4,?2)",
            rusqlite::params![occupied_scope, managed],
        )
        .map_err(|error| error.to_string())
    })
    .unwrap();
    let error =
        apply_relinked_directory(&db, &credentials, &registry, missing, new_path).unwrap_err();
    assert!(error.contains("外部修改"), "{error}");
    let project_path: String = db
        .with_connection(|conn| {
            conn.query_row("SELECT path FROM projects WHERE id='missing'", [], |row| {
                row.get(0)
            })
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(project_path, missing);
    let source: (String, i64, String) = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT profile_id, profile_version, managed FROM applied_bindings WHERE scope_key=?1 AND tool='pi'",
                [&old_scope],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(source.0, profile.id);
    assert_eq!(source.1, -1);
    assert_eq!(source.2, "{}");
    let occupied: (String, i64, String) = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT profile_id, profile_version, managed FROM applied_bindings WHERE scope_key=?1 AND tool='pi'",
                [&occupied_scope],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(occupied.0, "occupied-profile");
    assert_eq!(occupied.1, 4);
    assert_eq!(occupied.2, managed);
    let global: String = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT scope_key FROM applied_bindings WHERE tool='codex'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(global, "global");
    let blockers = load_blockers(&db).unwrap();
    assert!(
        blockers.iter().any(|item| item.key == source_key
            && item.action == "relink"
            && item.detail == format!("目录不存在：{missing}")),
        "{blockers:?}"
    );
    assert!(
        blockers.iter().all(|item| item.action != "retry"),
        "{blockers:?}"
    );
    assert!(
        blockers
            .iter()
            .any(|item| item.key == "binding:install" && item.action == "install"),
        "{blockers:?}"
    );
    assert!(
        blockers
            .iter()
            .any(|item| item.key == "binding:other-path" && item.action == "relink"),
        "{blockers:?}"
    );
    let saved: String = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT data FROM native_profiles WHERE id=?1",
                [&profile.id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert!(saved.contains("restore-marker"), "{saved}");
    let native =
        fs::read_to_string(Path::new(occupied_dir).join(".pi").join("settings.json")).unwrap();
    assert!(
        native.contains("external-marker") && !native.contains("restore-marker"),
        "{native}"
    );
    // A known sync row whose binding disappeared would be uploaded as a local deletion.
    let snapshot = collect_snapshot(&db, &credentials, &registry).unwrap();
    let entity = snapshot
        .entities
        .iter()
        .find(|entity| entity.key() == source_key)
        .unwrap();
    let PortablePayload::Binding(binding) = &entity.payload else {
        panic!("binding")
    };
    assert_eq!(binding.scope_key, old_scope);
    assert_eq!(binding.profile_id, profile.id);
    assert_eq!(entity.digest().unwrap(), before_digest);
    let deleted: i64 = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT deleted FROM sync_entity_state WHERE entity_key=?1",
                [&source_key],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(deleted, 0);
    let deleted_rows: i64 = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT count(*) FROM sync_entity_state WHERE deleted!=0",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(deleted_rows, 0);
}

#[test]
fn partial_directory_write_keeps_committed_cli_and_retries_the_failed_binding() {
    let _roots = RestoreRootsGuard;
    let temp = tempfile::tempdir().unwrap();
    let db = database(temp.path());
    let credentials = MemoryCredentials::default();
    let missing = "C:/missing/restore-project";
    let pi = bare_profile(
        "pi-profile",
        "pi",
        "Pi",
        BTreeMap::from([(
            "settings".into(),
            r#"{"defaultProvider":"restore-marker"}"#.into(),
        )]),
    );
    let codex = bare_profile(
        "codex-profile",
        "codex",
        "Codex",
        BTreeMap::from([("settings".into(), "model = \"gpt-6\"\n".into())]),
    );
    let old_scope = format!("project:{missing}");
    let pi_key = format!("binding:{}", binding_id("pi", &old_scope));
    let codex_key = format!("binding:{}", binding_id("codex", &old_scope));
    db.with_connection(|conn| {
        for profile in [&pi, &codex] {
            conn.execute(
                "INSERT INTO native_profiles (id,tool,version,data) VALUES (?1,?2,1,?3)",
                rusqlite::params![profile.id, profile.tool, serde_json::to_string(profile).unwrap()],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO projects (id,name,path,preferred_tool,last_opened) VALUES ('missing','Missing',?1,NULL,0)",
            [missing],
        )
        .unwrap();
        for (tool, profile_id) in [("pi", pi.id.as_str()), ("codex", codex.id.as_str())] {
            conn.execute(
                "INSERT INTO applied_bindings (scope_key,tool,profile_id,profile_version,managed) VALUES (?1,?2,?3,-1,'{}')",
                rusqlite::params![old_scope, tool, profile_id],
            )
            .unwrap();
        }
        Ok(())
    })
    .unwrap();
    record_blocker(
        &db,
        RestoreBlocker {
            key: pi_key.clone(),
            label: "pi 活动配置".into(),
            action: "relink".into(),
            detail: format!("目录不存在：{missing}"),
        },
    );
    record_blocker(
        &db,
        RestoreBlocker {
            key: codex_key.clone(),
            label: "codex 活动配置".into(),
            action: "relink".into(),
            detail: format!("目录不存在：{missing}"),
        },
    );
    record_blocker(
        &db,
        RestoreBlocker {
            key: "binding:install".into(),
            label: "其它 CLI".into(),
            action: "install".into(),
            detail: "未发现可执行文件".into(),
        },
    );
    record_blocker(
        &db,
        RestoreBlocker {
            key: "binding:other-path".into(),
            label: "其它目录".into(),
            action: "relink".into(),
            detail: "目录不存在：C:/other-missing".into(),
        },
    );
    let before = collect_snapshot(&db, &credentials, &Registry::builtins()).unwrap();
    let source_entity = before
        .entities
        .iter()
        .find(|entity| entity.key() == codex_key)
        .unwrap();
    let before_digest = source_entity.digest().unwrap();
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO sync_entity_state (entity_key,local_digest,heads_json,deleted) VALUES (?1,?2,'[\"head-1\"]',0)",
            rusqlite::params![codex_key, before_digest],
        )
        .map_err(|error| error.to_string())
    })
    .unwrap();
    let moved = temp.path().join("chosen");
    fs::create_dir(&moved).unwrap();
    let home = temp.path().join("home");
    fs::create_dir_all(&home).unwrap();
    set_restore_roots_for_test(Some((home, temp.path().to_path_buf())));
    let registry = Registry::builtins()
        .with_fixture_installation("pi", "1.0.0")
        .with_fixture_installation("codex", "0.160.0");
    let linked = crate::projects::relink(&db, "missing", moved.to_str().unwrap()).unwrap();
    let new_path = linked.path.as_deref().unwrap().to_string();
    let chosen_scope = crate::native::apply::scope_key(
        crate::native::adapter::Scope::Project,
        Some(Path::new(&new_path)),
    )
    .unwrap();
    let chosen_dir = chosen_scope.strip_prefix("project:").unwrap();
    fs::write(Path::new(chosen_dir).join(".codex"), "not-a-directory").unwrap();
    apply_relinked_directory(&db, &credentials, &registry, missing, &new_path).unwrap();
    let project_path: String = db
        .with_connection(|conn| {
            conn.query_row("SELECT path FROM projects WHERE id='missing'", [], |row| {
                row.get(0)
            })
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(project_path, new_path);
    let pi_scope: String = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT scope_key FROM applied_bindings WHERE tool='pi'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(pi_scope, chosen_scope);
    let pi_written =
        fs::read_to_string(Path::new(chosen_dir).join(".pi").join("settings.json")).unwrap();
    assert!(pi_written.contains("restore-marker"), "{pi_written}");
    let codex_scope: String = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT scope_key FROM applied_bindings WHERE tool='codex'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(codex_scope, old_scope);
    let codex_rows: i64 = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT count(*) FROM applied_bindings WHERE scope_key=?1 AND tool='codex'",
                [&chosen_scope],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(codex_rows, 0);
    let blockers = load_blockers(&db).unwrap();
    assert!(
        blockers
            .iter()
            .all(|item| item.action != "relink" || !item.detail.contains(missing)),
        "{blockers:?}"
    );
    let failed = blockers
        .iter()
        .find(|item| item.key == codex_key)
        .unwrap_or_else(|| panic!("{blockers:?}"));
    assert_ne!(failed.action, "relink");
    assert!(
        failed.action == "retry" || failed.action == "install",
        "{failed:?}"
    );
    let target = failed
        .detail
        .split_once("写入已选目录：")
        .unwrap_or_else(|| panic!("{}", failed.detail))
        .1
        .trim();
    assert_eq!(target, new_path);
    assert!(
        !failed.detail.contains(&format!("目录不存在：{missing}")),
        "{}",
        failed.detail
    );
    assert!(
        blockers
            .iter()
            .any(|item| item.key == "binding:install" && item.action == "install"),
        "{blockers:?}"
    );
    assert!(
        blockers
            .iter()
            .any(|item| item.key == "binding:other-path" && item.action == "relink"),
        "{blockers:?}"
    );
    let snapshot = collect_snapshot(&db, &credentials, &registry).unwrap();
    let entity = snapshot
        .entities
        .iter()
        .find(|entity| entity.key() == codex_key)
        .unwrap();
    let PortablePayload::Binding(binding) = &entity.payload else {
        panic!("binding")
    };
    assert_eq!(binding.scope_key, old_scope);
    assert_eq!(binding.profile_id, codex.id);
    assert_eq!(entity.digest().unwrap(), before_digest);
    let deleted: i64 = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT deleted FROM sync_entity_state WHERE entity_key=?1",
                [&codex_key],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(deleted, 0);
    fs::remove_file(Path::new(chosen_dir).join(".codex")).unwrap();
    apply_relinked_directory(&db, &credentials, &registry, &new_path, target).unwrap();
    let retried: String = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT scope_key FROM applied_bindings WHERE tool='codex'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(retried, chosen_scope);
    let written =
        fs::read_to_string(Path::new(chosen_dir).join(".codex").join("config.toml")).unwrap();
    assert!(written.contains("gpt-6"), "{written}");
    let pi_still: String = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT scope_key FROM applied_bindings WHERE tool='pi'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(pi_still, chosen_scope);
    let kept_path: String = db
        .with_connection(|conn| {
            conn.query_row("SELECT path FROM projects WHERE id='missing'", [], |row| {
                row.get(0)
            })
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(kept_path, new_path);
    let after = load_blockers(&db).unwrap();
    assert!(after.iter().all(|item| item.key != codex_key), "{after:?}");
    assert!(
        after
            .iter()
            .all(|item| item.action != "relink" || !item.detail.contains(missing)),
        "{after:?}"
    );
    assert!(
        after
            .iter()
            .any(|item| item.key == "binding:install" && item.action == "install"),
        "{after:?}"
    );
    assert!(
        after
            .iter()
            .any(|item| item.key == "binding:other-path" && item.action == "relink"),
        "{after:?}"
    );
    let deleted_after: i64 = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT count(*) FROM sync_entity_state WHERE deleted!=0",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(deleted_after, 0);
}

fn sync_config_count(db: &Database) -> i64 {
    db.with_connection(|conn| {
        conn.query_row("SELECT count(*) FROM sync_config", [], |row| row.get(0))
            .map_err(|error| error.to_string())
    })
    .unwrap()
}

fn insert_codex_binding(db: &Database, scope: &str) -> String {
    let profile = bare_profile(
        "codex-profile",
        "codex",
        "Codex",
        BTreeMap::from([("settings".into(), "model = \"gpt-6\"\n".into())]),
    );
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO native_profiles (id,tool,version,data) VALUES (?1,'codex',1,?2)",
            rusqlite::params![profile.id, serde_json::to_string(&profile).unwrap()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO applied_bindings (scope_key,tool,profile_id,profile_version,managed) VALUES (?1,'codex',?2,-1,'{}')",
            rusqlite::params![scope, profile.id],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    format!("binding:{}", binding_id("codex", scope))
}

fn project_scope(path: &Path) -> String {
    crate::native::apply::scope_key(crate::native::adapter::Scope::Project, Some(path)).unwrap()
}

#[test]
fn retry_rewrites_a_failed_active_binding_without_webdav() {
    let _roots = RestoreRootsGuard;
    let temp = tempfile::tempdir().unwrap();
    let db = database(temp.path());
    let credentials = MemoryCredentials::default();
    let project = temp.path().join("project");
    fs::create_dir(&project).unwrap();
    let scope = project_scope(&project);
    let key = insert_codex_binding(&db, &scope);
    let home = temp.path().join("home");
    fs::create_dir(&home).unwrap();
    set_restore_roots_for_test(Some((home, temp.path().to_path_buf())));
    let canonical = scope.strip_prefix("project:").unwrap();
    let config = Path::new(canonical).join(".codex").join("config.toml");
    fs::create_dir_all(config.parent().unwrap()).unwrap();
    fs::write(&config, "model = \"old\"\n").unwrap();
    let mut blocked = fs::metadata(&config).unwrap().permissions();
    blocked.set_readonly(true);
    fs::set_permissions(&config, blocked).unwrap();
    record_blocker(
        &db,
        RestoreBlocker {
            key: key.clone(),
            label: "codex 活动配置".into(),
            action: "retry".into(),
            detail: "上次写入失败".into(),
        },
    );
    let registry = Registry::builtins().with_fixture_installation("codex", "0.160.0");
    let failed = retry_native_blocker(&db, &credentials, &registry, &key).unwrap_err();
    assert!(!failed.contains("请先配置 WebDAV"), "{failed}");
    assert_eq!(sync_config_count(&db), 0);
    let blocker = load_blockers(&db)
        .unwrap()
        .into_iter()
        .find(|item| item.key == key)
        .expect("blocker");
    assert!(
        blocker.action == "retry" || blocker.action == "install",
        "{blocker:?}"
    );
    assert!(
        !blocker.detail.contains("写入已选目录"),
        "{}",
        blocker.detail
    );
    assert_ne!(blocker.detail, "上次写入失败");
    crate::test_support::make_writable(&config).unwrap();
    retry_native_blocker(&db, &credentials, &registry, &key).unwrap();
    let written = fs::read_to_string(&config).unwrap();
    assert!(written.contains("gpt-6"), "{written}");
    assert!(load_blockers(&db)
        .unwrap()
        .iter()
        .all(|item| item.key != key));
    assert_eq!(sync_config_count(&db), 0);
}

#[test]
fn retry_releases_a_failed_native_binding_without_webdav() {
    let _roots = RestoreRootsGuard;
    let temp = tempfile::tempdir().unwrap();
    let db = database(temp.path());
    let credentials = MemoryCredentials::default();
    let project = temp.path().join("project");
    fs::create_dir(&project).unwrap();
    let scope = project_scope(&project);
    let key = insert_codex_binding(&db, &scope);
    let home = temp.path().join("home");
    fs::create_dir(&home).unwrap();
    set_restore_roots_for_test(Some((home, temp.path().to_path_buf())));
    let registry = Registry::builtins().with_fixture_installation("codex", "0.160.0");
    record_blocker(
        &db,
        RestoreBlocker {
            key: key.clone(),
            label: "codex 活动配置".into(),
            action: "retry".into(),
            detail: "准备写入".into(),
        },
    );
    retry_native_blocker(&db, &credentials, &registry, &key).unwrap();
    let managed: String = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT managed FROM applied_bindings WHERE tool='codex'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert!(managed.contains("model"), "{managed}");
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO applied_bindings (scope_key,tool,profile_id,profile_version,managed) VALUES ('global','pi','pi-profile',1,'{}')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO library_items (id,kind,title,body,category,project_id,version,updated_at) VALUES ('library-1','prompt','Example','kept-body','',NULL,1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_entity_state (entity_key,local_digest,heads_json,deleted) VALUES ('library:library-1','digest','[]',0)",
            [],
        )
        .unwrap();
        conn.execute("DELETE FROM applied_bindings WHERE tool='codex'", []).unwrap();
        Ok(())
    })
    .unwrap();
    let canonical = scope.strip_prefix("project:").unwrap();
    let config = Path::new(canonical).join(".codex").join("config.toml");
    fs::write(&config, ":::not toml").unwrap();
    let error = note_failed_release(&db, &registry, &key, "codex", &scope, &managed).unwrap_err();
    assert!(!error.contains("请先配置 WebDAV"), "{error}");
    let blocker = load_blockers(&db)
        .unwrap()
        .into_iter()
        .find(|item| item.key == key)
        .expect("blocker");
    assert_eq!(blocker.action, "retry", "{blocker:?}");
    assert!(
        !blocker.detail.contains("写入已选目录"),
        "{}",
        blocker.detail
    );
    fs::write(&config, "model = \"gpt-6\"\nkeep = \"yes\"\n").unwrap();
    retry_native_blocker(&db, &credentials, &registry, &key).unwrap();
    let released = fs::read_to_string(&config).unwrap();
    assert!(!released.contains("gpt-6"), "{released}");
    assert!(released.contains("keep"), "{released}");
    assert!(load_blockers(&db)
        .unwrap()
        .iter()
        .all(|item| item.key != key));
    assert_eq!(sync_config_count(&db), 0);
    let kept_body: String = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT body FROM library_items WHERE id='library-1'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(kept_body, "kept-body");
    let pi_rows: i64 = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT count(*) FROM applied_bindings WHERE tool='pi'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(pi_rows, 1);
    let codex_rows: i64 = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT count(*) FROM applied_bindings WHERE tool='codex'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(codex_rows, 0);
    let deleted: i64 = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT count(*) FROM sync_entity_state WHERE deleted!=0",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(deleted, 0);
}

#[test]
fn restored_binding_is_applied_ahead_of_a_pending_release() {
    let _roots = RestoreRootsGuard;
    let temp = tempfile::tempdir().unwrap();
    let db = database(temp.path());
    let credentials = MemoryCredentials::default();
    let project = temp.path().join("project");
    fs::create_dir(&project).unwrap();
    let scope = project_scope(&project);
    let key = insert_codex_binding(&db, &scope);
    let home = temp.path().join("home");
    fs::create_dir(&home).unwrap();
    set_restore_roots_for_test(Some((home, temp.path().to_path_buf())));
    let registry = Registry::builtins().with_fixture_installation("codex", "0.160.0");
    let canonical = scope.strip_prefix("project:").unwrap();
    let config = Path::new(canonical).join(".codex").join("config.toml");
    fs::create_dir_all(config.parent().unwrap()).unwrap();
    fs::write(&config, ":::not toml").unwrap();
    db.with_connection(|conn| {
        conn.execute("DELETE FROM applied_bindings WHERE tool='codex'", [])
            .unwrap();
        Ok(())
    })
    .unwrap();
    let release_managed = r#"{"settings":{"/model":"gpt-6","/sandbox_mode":"workspace-write"}}"#;
    let error =
        note_failed_release(&db, &registry, &key, "codex", &scope, release_managed).unwrap_err();
    assert!(!error.contains("请先配置 WebDAV"), "{error}");
    assert!(
        load_pending_releases(&db)
            .unwrap()
            .iter()
            .any(|item| item.key == key && item.managed.contains("sandbox_mode")),
        "{:?}",
        load_pending_releases(&db).unwrap()
    );
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO applied_bindings (scope_key,tool,profile_id,profile_version,managed) VALUES (?1,'codex','codex-profile',-1,?2)",
            rusqlite::params![scope, r#"{"settings":{"/model":"gpt-6"}}"#],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO applied_bindings (scope_key,tool,profile_id,profile_version,managed) VALUES ('global','pi','pi-profile',1,'{}')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO library_items (id,kind,title,body,category,project_id,version,updated_at) VALUES ('library-1','prompt','Example','kept-body','',NULL,1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_entity_state (entity_key,local_digest,heads_json,deleted) VALUES ('library:library-1','digest','[]',0)",
            [],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    fs::write(
        &config,
        "model = \"external\"\nsandbox_mode = \"workspace-write\"\nkeep = \"yes\"\n",
    )
    .unwrap();
    record_blocker(
        &db,
        RestoreBlocker {
            key: key.clone(),
            label: "codex 活动配置".into(),
            action: "install".into(),
            detail: "未发现可执行文件".into(),
        },
    );
    let failed = retry_native_blocker(&db, &credentials, &registry, &key).unwrap_err();
    assert!(
        failed.contains("外部修改") || failed.contains("上次管理的字段"),
        "{failed}"
    );
    finish_pending_native(&db, &credentials, &registry).unwrap();
    let during = fs::read_to_string(&config).unwrap();
    assert!(during.contains("external"), "{during}");
    assert!(during.contains("sandbox_mode"), "{during}");
    assert!(during.contains("keep"), "{during}");
    let blocker = load_blockers(&db)
        .unwrap()
        .into_iter()
        .find(|item| item.key == key)
        .expect("write blocker");
    assert_eq!(blocker.action, "retry", "{blocker:?}");
    assert!(
        blocker.detail.contains("外部修改") || blocker.detail.contains("上次管理的字段"),
        "{blocker:?}"
    );
    assert!(
        load_pending_releases(&db)
            .unwrap()
            .iter()
            .any(|item| item.key == key),
        "a failed write must keep the old release"
    );
    assert_unchanged_neighbors(&db);
    db.with_connection(|conn| {
        conn.execute(
            "UPDATE applied_bindings SET managed='{}' WHERE tool='codex'",
            [],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    retry_native_blocker(&db, &credentials, &registry, &key).unwrap();
    let written = fs::read_to_string(&config).unwrap();
    assert!(written.contains("gpt-6"), "{written}");
    assert!(written.contains("sandbox_mode"), "{written}");
    assert!(written.contains("keep"), "{written}");
    assert!(!written.contains("external"), "{written}");
    assert!(load_blockers(&db)
        .unwrap()
        .iter()
        .all(|item| item.key != key));
    assert!(
        load_pending_releases(&db)
            .unwrap()
            .iter()
            .all(|item| item.key != key),
        "{:?}",
        load_pending_releases(&db).unwrap()
    );
    assert_unchanged_neighbors(&db);
    assert_eq!(sync_config_count(&db), 0);
}

fn assert_unchanged_neighbors(db: &Database) {
    let kept_body: String = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT body FROM library_items WHERE id='library-1'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(kept_body, "kept-body");
    let pi_rows: i64 = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT count(*) FROM applied_bindings WHERE tool='pi'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(pi_rows, 1);
    let codex_rows: i64 = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT count(*) FROM applied_bindings WHERE tool='codex'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(codex_rows, 1);
    let deleted: i64 = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT count(*) FROM sync_entity_state WHERE deleted!=0",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(deleted, 0);
}

#[test]
fn successful_release_clears_a_stale_write_blocker_when_nothing_is_pending() {
    let _roots = RestoreRootsGuard;
    let temp = tempfile::tempdir().unwrap();
    let db = database(temp.path());
    let credentials = MemoryCredentials::default();
    let project = temp.path().join("project");
    fs::create_dir(&project).unwrap();
    let scope = project_scope(&project);
    let key = insert_codex_binding(&db, &scope);
    let home = temp.path().join("home");
    fs::create_dir(&home).unwrap();
    set_restore_roots_for_test(Some((home, temp.path().to_path_buf())));
    let registry = Registry::builtins().with_fixture_installation("codex", "0.160.0");
    let canonical = scope.strip_prefix("project:").unwrap();
    let config = Path::new(canonical).join(".codex").join("config.toml");
    fs::create_dir_all(config.parent().unwrap()).unwrap();
    fs::write(&config, "model = \"gpt-6\"\nkeep = \"yes\"\n").unwrap();
    let managed = r#"{"settings":{"/model":"gpt-6"}}"#;
    db.with_connection(|conn| {
        conn.execute("UPDATE applied_bindings SET managed=?1 WHERE tool='codex'", [managed]).unwrap();
        conn.execute(
            "INSERT INTO applied_bindings (scope_key,tool,profile_id,profile_version,managed) VALUES ('global','pi','pi-profile',1,'{}')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO library_items (id,kind,title,body,category,project_id,version,updated_at) VALUES ('library-1','prompt','Example','kept-body','',NULL,1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_entity_state (entity_key,local_digest,heads_json,deleted) VALUES ('library:library-1','digest','[]',0)",
            [],
        )
        .unwrap();
        conn.execute("DELETE FROM applied_bindings WHERE tool='codex'", []).unwrap();
        Ok(())
    })
    .unwrap();
    record_blocker(
        &db,
        RestoreBlocker {
            key: key.clone(),
            label: "codex 活动配置".into(),
            action: "retry".into(),
            detail: "上次写入失败".into(),
        },
    );
    note_failed_release(&db, &registry, &key, "codex", &scope, managed).unwrap();
    let released = fs::read_to_string(&config).unwrap();
    assert!(!released.contains("gpt-6"), "{released}");
    assert!(released.contains("keep"), "{released}");
    assert!(
        load_blockers(&db)
            .unwrap()
            .iter()
            .all(|item| item.key != key),
        "{:?}",
        load_blockers(&db).unwrap()
    );
    assert!(load_pending_releases(&db)
        .unwrap()
        .iter()
        .all(|item| item.key != key));
    retry_native_blocker(&db, &credentials, &registry, &key).unwrap();
    finish_pending_native(&db, &credentials, &registry).unwrap();
    assert!(load_blockers(&db)
        .unwrap()
        .iter()
        .all(|item| item.key != key));
    let kept_body: String = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT body FROM library_items WHERE id='library-1'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(kept_body, "kept-body");
    let pi_rows: i64 = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT count(*) FROM applied_bindings WHERE tool='pi'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(pi_rows, 1);
    let codex_rows: i64 = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT count(*) FROM applied_bindings WHERE tool='codex'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(codex_rows, 0);
    assert_eq!(sync_config_count(&db), 0);
}

#[test]
fn release_keeps_the_blocker_until_every_pending_release_for_the_key_is_done() {
    let _roots = RestoreRootsGuard;
    let temp = tempfile::tempdir().unwrap();
    let db = database(temp.path());
    let project_a = temp.path().join("project-a");
    let project_b = temp.path().join("project-b");
    fs::create_dir(&project_a).unwrap();
    fs::create_dir(&project_b).unwrap();
    let scope_a = project_scope(&project_a);
    let scope_b = project_scope(&project_b);
    let home = temp.path().join("home");
    fs::create_dir(&home).unwrap();
    set_restore_roots_for_test(Some((home, temp.path().to_path_buf())));
    let registry = Registry::builtins().with_fixture_installation("codex", "0.160.0");
    let key = "binding:shared-release";
    let config_a = Path::new(scope_a.strip_prefix("project:").unwrap())
        .join(".codex")
        .join("config.toml");
    let config_b = Path::new(scope_b.strip_prefix("project:").unwrap())
        .join(".codex")
        .join("config.toml");
    fs::create_dir_all(config_a.parent().unwrap()).unwrap();
    fs::create_dir_all(config_b.parent().unwrap()).unwrap();
    fs::write(&config_a, ":::not toml").unwrap();
    fs::write(&config_b, "model = \"gpt-6\"\nkeep = \"yes\"\n").unwrap();
    record_blocker(
        &db,
        RestoreBlocker {
            key: key.into(),
            label: "codex 活动配置".into(),
            action: "retry".into(),
            detail: "上次写入失败".into(),
        },
    );
    let managed = r#"{"settings":{"/model":"gpt-6"}}"#;
    let error = note_failed_release(&db, &registry, key, "codex", &scope_a, managed).unwrap_err();
    assert!(!error.contains("请先配置 WebDAV"), "{error}");
    note_failed_release(&db, &registry, key, "codex", &scope_b, managed).unwrap();
    let during = fs::read_to_string(&config_b).unwrap();
    assert!(!during.contains("gpt-6"), "{during}");
    assert!(during.contains("keep"), "{during}");
    assert!(
        load_pending_releases(&db)
            .unwrap()
            .iter()
            .any(|item| item.key == key && item.scope_key == scope_a),
        "{:?}",
        load_pending_releases(&db).unwrap()
    );
    let blocker = load_blockers(&db)
        .unwrap()
        .into_iter()
        .find(|item| item.key == key)
        .expect("pending release");
    assert_eq!(blocker.action, "retry", "{blocker:?}");
    fs::write(&config_a, "model = \"gpt-6\"\nkeep = \"yes\"\n").unwrap();
    note_failed_release(&db, &registry, key, "codex", &scope_a, managed).unwrap();
    let released = fs::read_to_string(&config_a).unwrap();
    assert!(!released.contains("gpt-6"), "{released}");
    assert!(released.contains("keep"), "{released}");
    assert!(
        load_blockers(&db)
            .unwrap()
            .iter()
            .all(|item| item.key != key),
        "{:?}",
        load_blockers(&db).unwrap()
    );
    assert!(
        load_pending_releases(&db).unwrap().is_empty(),
        "{:?}",
        load_pending_releases(&db).unwrap()
    );
}

#[test]
fn restored_binding_write_failure_is_not_cleared_by_release() {
    let _roots = RestoreRootsGuard;
    let temp = tempfile::tempdir().unwrap();
    let db = database(temp.path());
    let credentials = MemoryCredentials::default();
    let project = temp.path().join("project");
    fs::create_dir(&project).unwrap();
    let scope = project_scope(&project);
    let key = insert_codex_binding(&db, &scope);
    let home = temp.path().join("home");
    fs::create_dir(&home).unwrap();
    set_restore_roots_for_test(Some((home, temp.path().to_path_buf())));
    let registry = Registry::builtins().with_fixture_installation("codex", "0.160.0");
    let canonical = scope.strip_prefix("project:").unwrap();
    let config = Path::new(canonical).join(".codex").join("config.toml");
    fs::create_dir_all(config.parent().unwrap()).unwrap();
    fs::write(&config, ":::not toml").unwrap();
    db.with_connection(|conn| {
        conn.execute("DELETE FROM applied_bindings WHERE tool='codex'", [])
            .unwrap();
        Ok(())
    })
    .unwrap();
    let release_managed = r#"{"settings":{"/model":"gpt-6","/sandbox_mode":"workspace-write"}}"#;
    note_failed_release(&db, &registry, &key, "codex", &scope, release_managed).unwrap_err();
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO applied_bindings (scope_key,tool,profile_id,profile_version,managed) VALUES (?1,'codex','codex-profile',-1,?2)",
            rusqlite::params![scope, r#"{"settings":{"/model":"gpt-6"}}"#],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    fs::write(
        &config,
        "model = \"external\"\nsandbox_mode = \"workspace-write\"\nkeep = \"yes\"\n",
    )
    .unwrap();
    record_blocker(
        &db,
        RestoreBlocker {
            key: key.clone(),
            label: "codex 活动配置".into(),
            action: "retry".into(),
            detail: "上次写入失败".into(),
        },
    );
    note_failed_release(&db, &registry, &key, "codex", &scope, release_managed).unwrap();
    let during = fs::read_to_string(&config).unwrap();
    assert!(during.contains("external"), "{during}");
    assert!(during.contains("sandbox_mode"), "{during}");
    assert!(during.contains("keep"), "{during}");
    let blocker = load_blockers(&db)
        .unwrap()
        .into_iter()
        .find(|item| item.key == key)
        .expect("write blocker");
    assert_eq!(blocker.detail, "上次写入失败", "{blocker:?}");
    assert!(
        load_pending_releases(&db)
            .unwrap()
            .iter()
            .any(|item| item.key == key && item.managed.contains("sandbox_mode")),
        "{:?}",
        load_pending_releases(&db).unwrap()
    );
    let failed = retry_native_blocker(&db, &credentials, &registry, &key).unwrap_err();
    assert!(
        failed.contains("外部修改") || failed.contains("上次管理的字段"),
        "{failed}"
    );
    assert!(!failed.contains("请先配置 WebDAV"), "{failed}");
    let after = load_blockers(&db)
        .unwrap()
        .into_iter()
        .find(|item| item.key == key)
        .expect("still blocked");
    assert_eq!(after.action, "retry", "{after:?}");
    assert_ne!(after.detail, "");
    let still = fs::read_to_string(&config).unwrap();
    assert!(still.contains("sandbox_mode"), "{still}");
    assert!(still.contains("external"), "{still}");
    assert!(
        load_pending_releases(&db)
            .unwrap()
            .iter()
            .any(|item| item.key == key),
        "a failed write must keep the old release"
    );
    let codex_rows: i64 = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT count(*) FROM applied_bindings WHERE tool='codex'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(codex_rows, 1);
}

#[test]
fn install_retry_rewrites_and_clears_the_blocker_once_the_cli_is_present() {
    let _roots = RestoreRootsGuard;
    let temp = tempfile::tempdir().unwrap();
    let db = database(temp.path());
    let credentials = MemoryCredentials::default();
    let project = temp.path().join("project");
    fs::create_dir(&project).unwrap();
    let scope = project_scope(&project);
    let key = insert_codex_binding(&db, &scope);
    let home = temp.path().join("home");
    fs::create_dir(&home).unwrap();
    set_restore_roots_for_test(Some((home, temp.path().to_path_buf())));
    record_blocker(
        &db,
        RestoreBlocker {
            key: key.clone(),
            label: "codex 活动配置".into(),
            action: "install".into(),
            detail: "未发现可执行文件".into(),
        },
    );
    let missing = Registry::builtins().with_fixture_not_installed("codex");
    let error = retry_native_blocker(&db, &credentials, &missing, &key).unwrap_err();
    assert!(!error.contains("请先配置 WebDAV"), "{error}");
    assert!(
        error.contains("未发现") || error.contains("未注册") || error.contains("不能探测"),
        "{error}"
    );
    let blocker = load_blockers(&db)
        .unwrap()
        .into_iter()
        .find(|item| item.key == key)
        .expect("blocker");
    assert_eq!(blocker.action, "install", "{blocker:?}");
    let ready = Registry::builtins().with_fixture_installation("codex", "0.160.0");
    retry_native_blocker(&db, &credentials, &ready, &key).unwrap();
    let canonical = scope.strip_prefix("project:").unwrap();
    let written =
        fs::read_to_string(Path::new(canonical).join(".codex").join("config.toml")).unwrap();
    assert!(written.contains("gpt-6"), "{written}");
    assert!(load_blockers(&db)
        .unwrap()
        .iter()
        .all(|item| item.key != key));
}

#[test]
fn relogin_recheck_clears_the_blocker_only_after_sign_in_is_accepted() {
    let _roots = RestoreRootsGuard;
    let temp = tempfile::tempdir().unwrap();
    let db = database(temp.path());
    let credentials = MemoryCredentials::default();
    let root = temp.path().join("account");
    let state = root
        .join("auth")
        .join("prod")
        .join("cn")
        .join("mcode-public")
        .join("auth-state.json");
    fs::create_dir_all(state.parent().unwrap()).unwrap();
    let authenticated = r#"{"schemaVersion":2,"status":"authenticated","storeKind":"file","clientId":"mcode-public","scopes":["agent.default"],"audience":"agent-backend","buildEnv":"prod","region":"cn","generation":1}"#;
    fs::write(&state, authenticated).unwrap();
    let executable = temp.path().join("mcode.exe");
    fs::write(&executable, "").unwrap();
    let home = temp.path().join("home");
    fs::create_dir(&home).unwrap();
    set_restore_roots_for_test(Some((home, temp.path().to_path_buf())));
    let context = crate::accounts::NativeContext {
        id: "ctx-m".into(),
        tool_id: "minimax_code".into(),
        root: root.clone(),
        config_root: root.clone(),
        auth_files: vec![state.clone()],
        history_roots: Vec::new(),
        resource_root: root.clone(),
        environment: BTreeMap::from([
            (
                "MINIMAX_DATA_DIR".into(),
                root.to_string_lossy().into_owned(),
            ),
            ("MAVIS_DATA_DIR".into(), root.to_string_lossy().into_owned()),
        ]),
        remove_environment: Vec::new(),
        cli_args: Vec::new(),
    };
    let account = crate::accounts::AuthAccount {
        id: "acct-m".into(),
        tool_id: "minimax_code".into(),
        provider: "minimax".into(),
        label: "MiniMax".into(),
        version: 2,
        state: crate::accounts::AccountState::SignedIn,
        identity: None,
        context: Some(context),
        retired_contexts: Vec::new(),
        pending_login: None,
        checked_at: None,
        detail: None,
    };
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO auth_accounts (id,tool,version,data) VALUES ('acct-m','minimax_code',1,?1)",
            [serde_json::to_string(&account).unwrap()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO installation_choices (tool,path) VALUES ('minimax_code',?1)",
            [executable.to_str().unwrap()],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    record_blocker(
        &db,
        RestoreBlocker {
            key: "account:acct-m".into(),
            label: "MiniMax".into(),
            action: "relogin".into(),
            detail: "登录被拒绝，材料已保留".into(),
        },
    );
    fs::write(&state, authenticated.replace("authenticated", "expired")).unwrap();
    let registry = Registry::builtins();
    let rejected =
        retry_native_blocker(&db, &credentials, &registry, "account:acct-m").unwrap_err();
    assert!(!rejected.contains("请先配置 WebDAV"), "{rejected}");
    assert!(load_blockers(&db)
        .unwrap()
        .iter()
        .any(|item| item.key == "account:acct-m" && item.action == "relogin"));
    fs::write(&state, authenticated).unwrap();
    retry_native_blocker(&db, &credentials, &registry, "account:acct-m").unwrap();
    assert!(load_blockers(&db)
        .unwrap()
        .iter()
        .all(|item| item.key != "account:acct-m"));
}
