use super::*;
use crate::{
    adapters::{
        configuration::{ConfigurationAction, ConfigurationAdapter, EditingState},
        Registry,
    },
    database::Database,
    resources::{
        documents,
        mcp::{self, McpDraft, McpTargetRequest},
        skills,
    },
};
use std::{fs, sync::Mutex};

#[derive(Default)]
struct Store(Mutex<BTreeMap<String, String>>);
impl CredentialStore for Store {
    fn put(&self, key: &str, value: &str) -> Result<(), String> {
        self.0.lock().unwrap().insert(key.into(), value.into());
        Ok(())
    }
    fn get(&self, key: &str) -> Result<String, String> {
        self.0
            .lock()
            .unwrap()
            .get(key)
            .cloned()
            .ok_or("missing".into())
    }
    fn delete(&self, key: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(key);
        Ok(())
    }
}
fn registry() -> Registry {
    Registry::builtins().with_fixture_installation("minimax_code", "0.6.7")
}
fn target(project: Option<&Path>) -> McpTargetRequest {
    McpTargetRequest {
        context_id: None,
        tool_id: "minimax_code".into(),
        scope: if project.is_some() {
            Scope::Project
        } else {
            Scope::Global
        },
        project_path: project.map(|p| p.display().to_string()),
        enabled: true,
        baseline_hash: None,
        allow_replace: false,
        preview_token: None,
    }
}
fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}
fn config(text: &str) -> Value {
    format::parse(FileKind::Yaml, text).unwrap()
}
fn draft(name: &str) -> McpDraft {
    serde_json::from_value(json!({"name":name,"transport":"stdio","command":"node","args":["fixture.mjs"],"env":{},"headers":{},"url":"","inLibrary":true})).unwrap()
}

#[test]
fn minimax_registry_identity_capabilities_and_launch() {
    let registry = Registry::builtins();
    let adapter = registry.get("minimax_code").unwrap();
    assert!(registry.get("minimax").is_none());
    assert!(crate::domain::CliId::from_stable_id("minimax_code").is_none());
    assert!(crate::domain::Preferences::default()
        .unknown_managed_tools()
        .is_empty());
    assert_eq!(adapter.command(), "mcode");
    assert_eq!(adapter.npm_package(), "@minimax-ai/code");
    assert!(adapter.version_identity("mcode", "0.6.7"));
    assert!(!adapter.version_identity("minimax", "0.6.7"));
    assert!(!adapter.version_identity("mcode", "MiniMax quota 0.6.7"));
    assert!(!adapter.explicitly_incompatible_native_version("0.7.3"));
    assert!(adapter.explicitly_incompatible_native_version("0.4.12"));
    assert!(adapter.explicitly_incompatible_native_version("1.0.0"));
    assert_eq!(
        adapter
            .launch_args(Some("fixture-session"), LaunchMode::Normal)
            .unwrap(),
        vec!["--session", "fixture-session"]
    );
    assert!(adapter.launch_args(None, LaunchMode::Yolo).is_err());
    assert!(!adapter.session_env_markers().contains(&"MINIMAX_DATA_DIR"));
    assert!(!adapter
        .session_env_markers()
        .contains(&"__MAVIS_RUNTIME_PROFILE"));
    let descriptor = adapter.descriptor();
    assert!(descriptor.management.mcp && descriptor.management.skills);
    assert!(
        !descriptor.management.accounts
            && !descriptor.management.agents
            && !descriptor.management.plugins
    );
    assert!(adapter.accounts().is_none() && adapter.official_usage().is_none());
    assert!(adapter
        .mcp_location_for_version(Scope::Global, Path::new("."), None, None)
        .is_none());
}

#[test]
fn minimax_a2_mcp_project_state_ignores_global_product_flags() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let project = home.join("project");
    fs::create_dir(&project).unwrap();
    let db = Database::open(&home.join("db")).unwrap();
    let registry = registry();
    let text = r#"{"mcpServers":{"scope-state":{"type":"stdio","command":"node","enabled":true,"configured":false}}}"#;
    for (request, expected) in [(target(None), false), (target(Some(&project)), true)] {
        let location = resources::location(request.scope, home, request.project_path.as_deref().map(Path::new)).unwrap();
        write(&location.path, text);
        let entries = mcp::list_native(&db, &registry, home, &request).unwrap();
        assert_eq!(entries[0].enabled, expected, "list: {:?}", request.scope);
        let doc = documents::read(&db, &registry, home, &documents::McpDocumentRequest { target: request.clone(), definition_id: None, name: "scope-state".into(), reveal: false }).unwrap();
        assert_eq!(doc.enabled, Some(expected), "document: {:?}", request.scope);
        let pasted = documents::parse_paste(&db, &registry, home, &request, None, text).unwrap();
        assert_eq!(pasted[0].enabled, Some(expected));
        assert_eq!(pasted[0].draft.is_some(), request.scope == Scope::Project);
        let equivalent = documents::equivalent(&db, &registry, home, &request, "scope-state", &target(None));
        if request.scope == Scope::Project {
            assert_eq!(equivalent.unwrap().enabled, Some(true));
        } else {
            assert!(equivalent.is_err());
        }
    }
}

#[test]
fn minimax_a2_project_product_flags_allow_raw_toggle_distribution_and_delete() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let project = home.join("project");
    fs::create_dir(&project).unwrap();
    let db = Database::open(&home.join("db")).unwrap();
    let registry = registry();
    let store = Store::default();
    let name = "scope-state";
    let original = json!({"mcpServers":{name:{"type":"stdio","command":"node","enabled":true,"configured":false,"builtin":true,"unknown":{"keep":1}}},"keepRoot":true});
    let def = mcp::save_definition(&db, draft(name)).unwrap();
    for request in [target(None), target(Some(&project))] {
        let location = resources::location(request.scope, home, request.project_path.as_deref().map(Path::new)).unwrap();
        write(&location.path, &original.to_string());
        let read = || documents::read(&db, &registry, home, &documents::McpDocumentRequest { target: request.clone(), definition_id: None, name: name.into(), reveal: false }).unwrap();
        for enabled in [false, true] {
            let doc = read();
            let mut edited: Value = serde_json::from_str(&doc.text).unwrap();
            edited["mcpServers"][name]["enabled"] = json!(enabled);
            let saved = documents::save(&db, &store, &registry, home, &request, name, &doc.baseline, &edited.to_string());
            if request.scope == Scope::Global { assert!(saved.is_err()); }
            else {
                assert_eq!(saved.unwrap().enabled, Some(enabled));
                assert_eq!(mcp::list_native(&db, &registry, home, &request).unwrap()[0].enabled, enabled);
            }
            let mut toggle = request.clone();
            toggle.enabled = enabled;
            toggle.allow_replace = true;
            let preview = mcp::preview_targets(&db, &registry, home, &def.id, vec![toggle.clone()]).remove(0);
            toggle.baseline_hash = preview.baseline_hash;
            toggle.preview_token = preview.preview_token;
            let result = mcp::distribute(&db, &store, &registry, home, &def.id, vec![toggle]).remove(0);
            if request.scope == Scope::Global { assert_ne!(result.status, "written"); }
            else {
                assert_eq!(result.status, "written", "{}", result.detail);
                assert_eq!(read().enabled, Some(enabled));
                assert_eq!(mcp::list_native(&db, &registry, home, &request).unwrap()[0].enabled, enabled);
                let after: Value = serde_json::from_str(&fs::read_to_string(&location.path).unwrap()).unwrap();
                assert_eq!(after["keepRoot"], true);
                for field in ["configured", "builtin", "unknown"] { assert_eq!(after["mcpServers"][name][field], original["mcpServers"][name][field]); }
            }
        }
        let removed = mcp::remove_native(&db, &store, &registry, home, &request, name);
        if request.scope == Scope::Global { assert!(removed.is_err()); assert_eq!(serde_json::from_str::<Value>(&fs::read_to_string(&location.path).unwrap()).unwrap(), original); }
        else { removed.unwrap(); assert!(mcp::list_native(&db, &registry, home, &request).unwrap().is_empty()); }
    }
    // Project loader ignores even non-boolean product properties; semantic
    // conversion may omit them while raw edits keep the original JSON.
    let ignored = json!({"command":"node","configured":"ignored","builtin":{"ignored":true}});
    assert!(MiniMaxCode.mcp_decode_at(name, &ignored, Scope::Global).is_err());
    let decoded = MiniMaxCode.mcp_decode_at(name, &ignored, Scope::Project).unwrap();
    assert!(decoded.enabled && decoded.unmapped_fields.is_empty());
    for scope in [Scope::Global, Scope::Project] {
        let location = resources::location(scope, home, Some(&project)).unwrap();
        assert!(MiniMaxCode.mcp_change_in_scope(&json!({}), &location, "matrix", Some(json!({"command":"node"})), scope).is_err());
    }
}

#[test]
fn minimax_a2_global_incomplete_can_be_explicitly_enabled() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let db = Database::open(&home.join("db")).unwrap();
    let registry = registry();
    let store = Store::default();
    write(&home.join(".minimax/mcp.json"), r#"{"mcpServers":{"incomplete":{"command":"node","configured":false,"enabled":true}}}"#);
    let def = mcp::save_definition(&db, draft("incomplete")).unwrap();
    for enabled in [true, false, true] {
        let mut request = target(None);
        request.enabled = enabled;
        request.allow_replace = true;
        let preview = mcp::preview_targets(&db, &registry, home, &def.id, vec![request.clone()]).remove(0);
        request.baseline_hash = preview.baseline_hash;
        request.preview_token = preview.preview_token;
        let result = mcp::distribute(&db, &store, &registry, home, &def.id, vec![request.clone()]).remove(0);
        assert_eq!(result.status, "written", "{}", result.detail);
        assert_eq!(mcp::list_native(&db, &registry, home, &request).unwrap()[0].enabled, enabled);
        let doc = documents::read(&db, &registry, home, &documents::McpDocumentRequest { target: request, definition_id: None, name: "incomplete".into(), reveal: false }).unwrap();
        assert_eq!(doc.enabled, Some(enabled));
        assert_eq!(serde_json::from_str::<Value>(&doc.text).unwrap()["mcpServers"]["incomplete"]["configured"], true);
    }
}

#[test]
fn minimax_data_root_overrides_profile_legacy_and_install_are_distinct() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path();
    assert_eq!(
        paths::resolve(home, &|_| None).unwrap(),
        home.join(".minimax")
    );
    fs::create_dir(home.join(".mavis")).unwrap();
    assert_eq!(
        paths::resolve(home, &|_| None).unwrap(),
        home.join(".mavis")
    );
    assert!(
        !home.join(".minimax").exists(),
        "inspection must not migrate legacy data"
    );
    fs::create_dir(home.join(".minimax")).unwrap();
    assert_eq!(
        paths::resolve(home, &|_| None).unwrap(),
        home.join(".minimax")
    );
    let mut vars = BTreeMap::from([
        (
            "MINIMAX_DATA_DIR",
            home.join("explicit").display().to_string(),
        ),
        (
            "MAVIS_DATA_DIR",
            home.join("old-explicit").display().to_string(),
        ),
        ("MAVIS_PROFILE", "ignored".into()),
    ]);
    assert_eq!(
        paths::resolve(home, &|k| vars.get(k).cloned()).unwrap(),
        home.join("explicit")
    );
    vars.remove("MINIMAX_DATA_DIR");
    assert_eq!(
        paths::resolve(home, &|k| vars.get(k).cloned()).unwrap(),
        home.join("old-explicit")
    );
    vars.remove("MAVIS_DATA_DIR");
    vars.insert("__MAVIS_RUNTIME_PROFILE", "work".into());
    assert_eq!(
        paths::resolve(home, &|k| vars.get(k).cloned()).unwrap(),
        home.join(".minimax")
    );
    vars.insert("__MAVIS_ALLOW_LEGACY_RUNTIME_ENV", "1".into());
    assert_eq!(
        paths::resolve(home, &|k| vars.get(k).cloned()).unwrap(),
        home.join(".minimax-work")
    );
    vars.insert("MINIMAX_DATA_DIR", "relative".into());
    assert!(paths::resolve(home, &|k| vars.get(k).cloned()).is_err());
    let files = MiniMaxCode.native_files(Scope::Global, home, None, true);
    assert!(Path::new(&files[0].path).ends_with(".minimax/config.yaml"));
    assert_eq!(
        MiniMaxCode.native_binary_directories(home),
        vec![home.join(".minimax-code/bin")]
    );
    assert!(MiniMaxCode
        .native_files(Scope::Project, home, Some(home), true)
        .is_empty());
}

#[test]
fn minimax_configuration_sources_and_explicit_key_import() {
    let registry = registry();
    let store = Store::default();
    let official = include_str!("../fixtures/native/minimax-code/official.yaml");
    assert!(configuration::read_connection(&config(official))
        .unwrap()
        .is_none());
    let imported = crate::native::intake::prepare_registered_import(
        &registry,
        "minimax_code",
        BTreeMap::from([("settings".into(), official.into())]),
        &store,
    )
    .unwrap();
    assert!(imported.inspection.connection.is_none());
    assert!(store.0.lock().unwrap().is_empty());
    assert!(config(&imported.files["settings"])
        .get("provider")
        .is_none());
    for (text, id, api) in [
        (
            include_str!("../fixtures/native/minimax-code/api.yaml"),
            "minimax_api",
            "anthropic_messages",
        ),
        (
            include_str!("../fixtures/native/minimax-code/custom.yaml"),
            "fixture",
            "openai_responses",
        ),
    ] {
        let result = crate::native::intake::prepare_registered_import(
            &registry,
            "minimax_code",
            BTreeMap::from([("settings".into(), text.into())]),
            &store,
        )
        .unwrap();
        let connection = result.inspection.connection.unwrap();
        assert_eq!(connection.provider_id, id);
        assert_eq!(connection.interface_format, api);
        assert_eq!(
            store.get(connection.secret_ref.as_ref().unwrap()).unwrap(),
            "synthetic-fixture-key"
        );
        assert!(!result.files["settings"].contains("synthetic-fixture-key"));
        let doc = configuration::connection_document(&connection).unwrap();
        assert!(doc.get("provider").is_none());
        if id == "fixture" {
            assert_eq!(doc["custom_provider"]["fixture"]["api"], "openai-responses");
            assert_eq!(doc["defaultModel"], "custom_provider:fixture/model/example");
        }
    }
    let mut inactive = config(include_str!("../fixtures/native/minimax-code/api.yaml"));
    inactive["defaultModel"] = json!("minimax/MiniMax-M2.7");
    inactive["minimaxModelSource"] = json!("token_plan");
    assert!(crate::native::intake::prepare_registered_import(
        &registry,
        "minimax_code",
        BTreeMap::from([(
            "settings".into(),
            format::render(FileKind::Yaml, &inactive).unwrap()
        )]),
        &store
    )
    .is_err());
    assert!(!MiniMaxCode
        .validate_changes(
            None,
            &BTreeMap::from([("settings".into(), json!({"provider":{"minimax_api":{}}}))]),
            &EditingState::default(),
            Scope::Global
        )
        .is_empty());
    assert!(MiniMaxCode
        .validate_draft("settings", &json!({"minimax_api":{"apiKey":"literal"}}))
        .is_err());
}

#[test]
fn minimax_settings_and_connection_apply_preserve_official_auth_and_unknown_fields() {
    use crate::native::{apply, profile};
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let db = Database::open(&home.join("db")).unwrap();
    let registry = registry();
    let store = Store::default();
    let path = home.join(".minimax/config.yaml");
    let original = include_str!("../fixtures/native/minimax-code/official.yaml");
    write(&path, original);
    let auth = home.join(".minimax/auth.json");
    write(&auth, "synthetic-native-login-owned-by-client");
    let mut docs = BTreeMap::from([("settings".into(), json!({}))]);
    let mut state = EditingState::default();
    MiniMaxCode
        .edit(
            &mut docs,
            &mut state,
            &ConfigurationAction {
                version: 1,
                target: json!({"kind":"settings"}),
                operation: "set".into(),
                field: Some("permissionMode".into()),
                value: Some(json!("default")),
            },
        )
        .unwrap();
    let p:RegisteredProfile=serde_json::from_value(json!({"id":"","tool":"minimax_code","name":"Preferences","version":1,"inheritCommon":false,"files":{"settings":format::render(FileKind::Yaml,&docs["settings"]).unwrap()},"editing":state,"authentication":{"kind":"native"}})).unwrap();
    let p = profile::save_registered_profile(&db, &registry, p, None).unwrap();
    apply::apply_registered_profile(
        &registry,
        &db,
        &store,
        "minimax_code",
        &p.id,
        Scope::Global,
        home,
        None,
        None,
        true,
    )
    .unwrap();
    let after = config(&fs::read_to_string(&path).unwrap());
    assert_eq!(after["permissionMode"], "default");
    assert_eq!(after["provider"], config(original)["provider"]);
    assert_eq!(after["customUnknown"]["keep"], true);
    let imported = crate::native::intake::prepare_registered_import(
        &registry,
        "minimax_code",
        BTreeMap::from([(
            "settings".into(),
            include_str!("../fixtures/native/minimax-code/api.yaml").into(),
        )]),
        &store,
    )
    .unwrap();
    let p:RegisteredProfile=serde_json::from_value(json!({"id":"","tool":"minimax_code","name":"API","version":1,"inheritCommon":false,"files":imported.files,"authentication":{"kind":"api_key"},"connection":imported.inspection.connection})).unwrap();
    let p = profile::save_registered_profile(&db, &registry, p, None).unwrap();
    apply::apply_registered_profile(
        &registry,
        &db,
        &store,
        "minimax_code",
        &p.id,
        Scope::Global,
        home,
        None,
        None,
        true,
    )
    .unwrap();
    let after = config(&fs::read_to_string(&path).unwrap());
    assert_eq!(after["minimax_api"]["apiKey"], "synthetic-fixture-key");
    assert_eq!(after["provider"], config(original)["provider"]);
    assert_eq!(
        fs::read_to_string(auth).unwrap(),
        "synthetic-native-login-owned-by-client"
    );
    assert!(apply::apply_registered_profile(
        &registry,
        &db,
        &store,
        "minimax_code",
        &p.id,
        Scope::Project,
        home,
        Some(home),
        None,
        true
    )
    .is_err());
}

#[test]
fn minimax_current_settings_allow_edits_but_keep_official_provider_readonly() {
    use crate::{
        adapters::configuration::ConfigurationSubject,
        native::workspace::{ConfigurationBeginRequest, DraftSessions},
    };
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let db = Database::open(&home.join("db")).unwrap();
    let registry = registry();
    let store = Store::default();
    let sessions = DraftSessions::default();
    let original = include_str!("../fixtures/native/minimax-code/official.yaml");
    let path = home.join(".minimax/config.yaml");
    write(&path, original);
    let files = MiniMaxCode.native_files(Scope::Global, home, None, true);
    let draft = sessions
        .begin(
            &registry,
            &db,
            ConfigurationBeginRequest {
                tool_id: "minimax_code".into(),
                scope: Scope::Global,
                project_path: None,
                session_id: "current".into(),
                subject: ConfigurationSubject::Current,
                profile: None,
            },
            None,
            files.clone(),
        )
        .unwrap();
    assert!(draft.issues.is_empty(), "{:?}", draft.issues);
    let draft = sessions
        .edit(
            &registry,
            draft,
            ConfigurationAction {
                version: 1,
                target: json!({"kind":"settings"}),
                operation: "set".into(),
                field: Some("permissionMode".into()),
                value: Some(json!("default")),
            },
        )
        .unwrap();
    assert!(draft.issues.is_empty(), "{:?}", draft.issues);
    let mut changed = draft.profile.files.clone();
    changed.insert(
        "settings".into(),
        changed["settings"].replace("managed-login", "api-key"),
    );
    let rejected = crate::native::configuration::replace_text(&registry, draft.clone(), changed);
    assert!(!rejected.issues.is_empty());
    sessions
        .save_current(&registry, &db, &store, draft, &files)
        .unwrap();
    let value = config(&fs::read_to_string(&path).unwrap());
    assert_eq!(value["permissionMode"], "default");
    assert_eq!(value["provider"], config(original)["provider"]);
    let mut docs = BTreeMap::from([("settings".into(), json!({"unknown":{"keep":true}}))]);
    let mut state = EditingState::default();
    MiniMaxCode.edit(&mut docs,&mut state,&ConfigurationAction{version:1,target:json!({"kind":"connection"}),operation:"configure_connection".into(),field:None,value:Some(json!({"providerId":"fixture","interfaceFormat":"openai_responses","baseUrl":"https://example.invalid/v1","model":"model/example","secretRef":null,"authEnvVar":null,"modelRecords":[]}))}).unwrap();
    assert_eq!(
        docs["settings"]["defaultModel"],
        "custom_provider:fixture/model/example"
    );
    assert_eq!(docs["settings"]["unknown"]["keep"], true);
    assert_eq!(
        MiniMaxCode
            .connection(&docs, &state)
            .unwrap()
            .unwrap()
            .provider_id,
        "fixture"
    );
}

#[test]
fn minimax_mcp_native_documents_cas_switches_and_product_fields() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let db = Database::open(&home.join("db")).unwrap();
    let registry = registry();
    let store = Store::default();
    let path = home.join(".minimax/mcp.json");
    write(
        &path,
        include_str!("../fixtures/native/minimax-code/mcp.json"),
    );
    let root: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert!(
        !MiniMaxCode
            .mcp_decode("incomplete", &root["mcpServers"]["incomplete"])
            .unwrap()
            .enabled
    );
    for name in ["builtin-demo", "oauth-demo", "incomplete"] {
        assert!(!MiniMaxCode
            .mcp_decode(name, &root["mcpServers"][name])
            .unwrap()
            .unmapped_fields
            .is_empty());
    }
    for name in ["builtin-demo", "oauth-demo"] {
        let doc = documents::read(
            &db,
            &registry,
            home,
            &documents::McpDocumentRequest {
                target: target(None),
                definition_id: None,
                name: name.into(),
                reveal: false,
            },
        )
        .unwrap();
        assert!(doc.text.contains(name));
        assert!(
            documents::save(
                &db,
                &store,
                &registry,
                home,
                &target(None),
                name,
                &doc.baseline,
                &doc.text
                    .replace("example.invalid/oauth", "example.invalid/updated")
            )
            .is_err()
                || name == "oauth-demo"
        );
    }
    assert!(MiniMaxCode
        .mcp_change(
            &root,
            &resources::location(Scope::Global, home, None).unwrap(),
            "oauth-demo",
            Some(json!({"url":"https://example.invalid","auth":{"type":"changed"}}))
        )
        .is_err());
    let def = mcp::save_definition(&db, draft("new-demo")).unwrap();
    let apply = |enabled| {
        let mut request = target(None);
        request.enabled = enabled;
        let preview =
            mcp::preview_targets(&db, &registry, home, &def.id, vec![request.clone()]).remove(0);
        request.baseline_hash = preview.baseline_hash;
        request.preview_token = preview.preview_token;
        mcp::distribute(&db, &store, &registry, home, &def.id, vec![request]).remove(0)
    };
    assert_eq!(apply(true).status, "written");
    assert_eq!(apply(false).status, "written");
    let entries = mcp::list_native(&db, &registry, home, &target(None)).unwrap();
    assert!(
        !entries
            .iter()
            .find(|e| e.name == "new-demo")
            .unwrap()
            .enabled
    );
    let doc = documents::read(
        &db,
        &registry,
        home,
        &documents::McpDocumentRequest {
            target: target(None),
            definition_id: None,
            name: "new-demo".into(),
            reveal: false,
        },
    )
    .unwrap();
    let edited = doc.text.replace("fixture.mjs", "updated.mjs");
    documents::save(
        &db,
        &store,
        &registry,
        home,
        &target(None),
        "new-demo",
        &doc.baseline,
        &edited,
    )
    .unwrap();
    assert!(documents::save(
        &db,
        &store,
        &registry,
        home,
        &target(None),
        "new-demo",
        &doc.baseline,
        &edited
    )
    .is_err());
    let after: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(after["unknownRoot"], root["unknownRoot"]);
    assert_eq!(
        after["mcpServers"]["stdio-demo"],
        root["mcpServers"]["stdio-demo"]
    );
}

#[test]
fn minimax_mcp_reference_scope_all_conversion_routes_and_legacy_roundtrip() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let project = home.join("project");
    fs::create_dir(&project).unwrap();
    let db = Database::open(&home.join("db")).unwrap();
    let registry = registry();
    let store = Store::default();
    for source in [target(None), target(Some(&project))] {
        let mut destination = source.clone();
        destination.scope = if source.scope == Scope::Global {
            Scope::Project
        } else {
            Scope::Global
        };
        destination.project_path = if destination.scope == Scope::Project {
            Some(project.display().to_string())
        } else {
            None
        };
        let text = r#"{"mcpServers":{"reference":{"command":"node","args":["{\"token\":\"${TOKEN:-fallback}\"}"],"env":{"TOKEN":"${TOKEN}"}}}}"#;
        let location = resources::location(
            source.scope,
            home,
            source.project_path.as_deref().map(Path::new),
        )
        .unwrap();
        write(&location.path, text);
        let entries = mcp::list_native(&db, &registry, home, &source).unwrap();
        assert_eq!(entries[0].reference_scope, Some(source.scope));
        let mut pasted = documents::parse_paste(&db, &registry, home, &source, None, text)
            .unwrap()
            .remove(0)
            .draft
            .unwrap();
        assert_eq!(pasted.reference_scope, Some(source.scope));
        pasted.command = "node-edited".into();
        assert!(documents::render_draft(&db, &registry, home, &source, pasted.clone()).is_ok());
        assert!(
            documents::render_draft(&db, &registry, home, &destination, pasted.clone())
                .unwrap_err()
                .contains("环境变量引用语义")
        );
        assert!(
            documents::equivalent(&db, &registry, home, &source, "reference", &destination)
                .is_err()
        );
        pasted.name = format!("reference-{:?}", source.scope);
        let saved = mcp::save_definition(&db, pasted.clone()).unwrap();
        assert_eq!(
            mcp::get_definition(&db, &saved.id).unwrap().reference_scope,
            Some(source.scope)
        );
        let doc = documents::read(
            &db,
            &registry,
            home,
            &documents::McpDocumentRequest {
                target: source.clone(),
                definition_id: Some(saved.id.clone()),
                name: saved.name.clone(),
                reveal: false,
            },
        )
        .unwrap();
        assert_eq!(doc.protected_values, source.scope == Scope::Global);
        assert!(documents::read(
            &db,
            &registry,
            home,
            &documents::McpDocumentRequest {
                target: destination.clone(),
                definition_id: Some(saved.id.clone()),
                name: saved.name.clone(),
                reveal: false
            }
        )
        .is_err());
        assert!(
            mcp::preview_targets(&db, &registry, home, &saved.id, vec![destination.clone()])[0]
                .detail
                .contains("环境变量引用语义")
        );
        assert_eq!(
            mcp::distribute(
                &db,
                &store,
                &registry,
                home,
                &saved.id,
                vec![destination.clone()]
            )[0]
            .status,
            "failed"
        );
        let preview =
            mcp::preview_targets(&db, &registry, home, &saved.id, vec![source.clone()]).remove(0);
        let mut approved = source.clone();
        approved.baseline_hash = preview.baseline_hash;
        approved.preview_token = preview.preview_token;
        approved.allow_replace = true;
        assert_eq!(
            mcp::distribute(&db, &store, &registry, home, &saved.id, vec![approved])[0].status,
            "written"
        );
        // An older editor must preserve both provenance fields when saving.
        pasted.id = Some(saved.id.clone());
        pasted.expected_version = Some(saved.version);
        pasted.reference_source = None;
        pasted.reference_scope = None;
        let edited = mcp::save_definition(&db, pasted).unwrap();
        assert_eq!(edited.reference_scope, Some(source.scope));
        let mut copy: McpDraft =
            serde_json::from_value(serde_json::to_value(&edited).unwrap()).unwrap();
        copy.id = None;
        copy.expected_version = None;
        copy.name = format!("copy-{:?}", source.scope);
        assert_eq!(
            mcp::save_definition(&db, copy).unwrap().reference_scope,
            Some(source.scope)
        );
        let mut legacy = serde_json::to_value(&edited).unwrap();
        legacy.as_object_mut().unwrap().remove("referenceScope");
        let old: McpDraft = serde_json::from_value(legacy.clone()).unwrap();
        assert!(documents::render_draft(&db, &registry, home, &source, old).is_err());
        legacy.as_object_mut().unwrap().remove("referenceSource");
        let old: mcp::McpDefinition = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(serde_json::to_value(old).unwrap(), legacy);
        let mut other = source.clone();
        other.tool_id = "claude_code".into();
        let portable = documents::parse_paste(&db, &registry, home, &source, None, text)
            .unwrap()
            .remove(0)
            .draft
            .unwrap();
        // The default adapter grammar cannot retain MiniMax's fallback syntax.
        assert!(documents::render_draft(&db, &registry, home, &other, portable.clone()).is_err());
        let mut simple = portable;
        simple.args = vec!["${TOKEN}".into()];
        assert_eq!(
            documents::render_draft(&db, &registry, home, &other, simple).is_ok(),
            source.scope == Scope::Project
        );
        fs::remove_file(location.path).unwrap();
    }
}

#[test]
fn minimax_skills_sources_flags_walkup_readonly_and_complete_package() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let db = Database::open(&home.join("db")).unwrap();
    let registry = registry();
    let store = Store::default();
    for root in [
        ".minimax/skills/primary",
        ".minimax/.builtin-skills/builtin",
        ".minimax/agents/mavis/skills/agent",
        ".claude/skills/external",
    ] {
        write(
            &home.join(root).join("SKILL.md"),
            "---\nname: mismatch\ndescription: \n---\n# fixture",
        );
    }
    let entries = skills::native_metadata(&db, &registry, home, &target(None)).unwrap();
    assert_eq!(entries.len(), 4);
    assert_eq!(entries.iter().filter(|e| e.read_only).count(), 3);
    for entry in &entries {
        let doc = skills::read_document(
            &db,
            &registry,
            home,
            "minimax_code",
            Scope::Global,
            None,
            &entry.path,
        )
        .unwrap();
        let result = skills::save_document(
            &db,
            &store,
            &registry,
            home,
            "minimax_code",
            Scope::Global,
            None,
            &entry.path,
            &doc.content,
            "updated",
        );
        assert_eq!(result.is_err(), entry.read_only);
    }
    let repo = home.join("repo");
    let project = repo.join("nested");
    fs::create_dir_all(repo.join(".git")).unwrap();
    fs::create_dir(&project).unwrap();
    write(&repo.join(".minimax/skills/parent/SKILL.md"), "parent");
    write(&project.join(".claude/skills/compat/SKILL.md"), "compat");
    let entries = skills::native_metadata(&db, &registry, home, &target(Some(&project))).unwrap();
    assert_eq!(entries.len(), 2);
    assert!(entries.iter().all(|e| e.read_only));
    write(&home.join(".minimax/config.yaml"),"skills:\n  external:\n    walkUp: false\n    sources:\n      workspace-claude:\n        enabled: false\n      user-claude:\n        enabled: false\n");
    assert!(
        skills::native_metadata(&db, &registry, home, &target(Some(&project)))
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        skills::native_metadata(&db, &registry, home, &target(None))
            .unwrap()
            .len(),
        3
    );
    let source = home.join("full-package");
    write(&source.join("SKILL.md"), "fixture");
    fs::create_dir(source.join("references")).unwrap();
    fs::write(source.join("references/data.bin"), [0, 1, 255]).unwrap();
    let package = skills::import_local(&db, source.to_str().unwrap(), None, None).unwrap();
    let installed = skills::install(
        &db,
        &registry,
        home,
        &package.id,
        "minimax_code",
        Scope::Project,
        project.to_str(),
    );
    assert_eq!(installed.status, "installed", "{}", installed.detail);
    assert_eq!(
        fs::read(project.join(".minimax/skills/full-package/references/data.bin")).unwrap(),
        [0, 1, 255]
    );
    write(
        &home.join(".minimax/config.yaml"),
        "skills:\n  external:\n    enabled: false\n",
    );
    assert!(MiniMaxCode
        .skill_root(Scope::Project, home, Some(&project))
        .is_none());
    assert_eq!(
        skills::install(
            &db,
            &registry,
            home,
            &package.id,
            "minimax_code",
            Scope::Project,
            project.to_str()
        )
        .status,
        "failed"
    );
}
