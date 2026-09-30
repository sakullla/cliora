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
        payload: PortablePayload::Preferences(PortablePreferences {
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
