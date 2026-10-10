use super::*;
use crate::{
    adapters::{
        configuration::{ConfigurationAction, ConfigurationAdapter, EditingState},
        Registry,
    },
    database::Database,
    resources::{
        documents,
        mcp::{McpDraft, McpTargetRequest},
        skills,
    },
};
use serde_json::json;
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
fn installation(home: &Path) -> PathBuf {
    let root = home.join("AppData/Local/Programs/cursor");
    fs::create_dir_all(root.join("resources/app")).unwrap();
    fs::write(root.join("Cursor.exe"), "synthetic marker, never executed").unwrap();
    fs::write(
        root.join("resources/app/product.json"),
        include_str!("../fixtures/native/cursor-ide/product.json"),
    )
    .unwrap();
    fs::write(
        root.join("resources/app/package.json"),
        include_str!("../fixtures/native/cursor-ide/package.json"),
    )
    .unwrap();
    root.join("Cursor.exe")
}
fn target() -> McpTargetRequest {
    McpTargetRequest {
        context_id: None,
        tool_id: "cursor_ide".into(),
        scope: Scope::Global,
        project_path: None,
        enabled: true,
        baseline_hash: None,
        allow_replace: false,
        preview_token: None,
    }
}
#[test]
fn cursor_marker_rejects_agent_and_inconsistent_installations() {
    let temp = tempfile::tempdir().unwrap();
    let exe = installation(temp.path());
    assert_eq!(install::marker(&exe).unwrap(), "3.24.9");
    fs::write(exe.with_file_name("agent.exe"), "agent").unwrap();
    assert!(install::marker(&exe.with_file_name("agent.exe")).is_err());
    fs::write(
        exe.parent().unwrap().join("resources/app/package.json"),
        r#"{"name":"Cursor","version":"3.25.0"}"#,
    )
    .unwrap();
    assert!(install::marker(&exe).is_err());
    assert!(!CursorIde.explicitly_incompatible_native_version("3.99.123"));
    assert!(CursorIde.explicitly_incompatible_native_version("4.0.0"));
    assert!(!CursorIde.version_identity("agent", "3.24.9"));
    assert!(CursorIde
        .launch_args(None, LaunchMode::Normal)
        .unwrap()
        .is_empty());
    assert!(CursorIde
        .launch_args(Some("session"), LaunchMode::Normal)
        .is_err());
    assert_eq!(
        CursorIde.launch_directory(),
        super::super::LaunchDirectory::Unsupported
    );
}
#[test]
fn cursor_registry_is_default_off_and_has_only_ide_capabilities() {
    let registry = Registry::builtins();
    let port = registry.get("cursor_ide").unwrap();
    assert!(registry.get("cursor_agent").is_none());
    assert!(registry.get("agent").is_none());
    assert!(crate::domain::CliId::from_stable_id("cursor_ide").is_none());
    assert!(crate::domain::Preferences::default()
        .unknown_managed_tools()
        .is_empty());
    let d = port.descriptor();
    assert!(d.management.mcp && d.management.skills);
    assert!(!d.management.accounts && !d.management.agents && !d.management.plugins);
}
#[test]
fn cursor_settings_paths_and_form_preserve_unknown_native_fields() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let portable = home.join("portable");
    assert_eq!(
        paths::user_data(home, &|key| if key == "VSCODE_PORTABLE" {
            Some(portable.clone())
        } else {
            None
        })
        .unwrap(),
        portable.join("user-data")
    );
    assert!(paths::user_data(home, &|_| Some(PathBuf::from("relative"))).is_err());
    let project = home.join("project");
    assert_eq!(
        paths::settings(home, Scope::Project, Some(&project)).unwrap(),
        project.join(".vscode/settings.json")
    );
    let original = include_str!("../fixtures/native/cursor-ide/settings.jsonc");
    let parsed = crate::native::format::parse(FileKind::Jsonc, original).unwrap();
    let mut docs = BTreeMap::from([("settings".into(), parsed)]);
    let mut state = EditingState::default();
    let mut action = ConfigurationAction {
        version: 1,
        target: json!({"kind":"settings"}),
        operation: "set".into(),
        field: Some("editor.fontSize".into()),
        value: Some(json!(19)),
    };
    CursorIde.edit(&mut docs, &mut state, &action).unwrap();
    assert_eq!(docs["settings"]["extensions.example"]["keep"], true);
    let patched = crate::native::format::set_path(
        FileKind::Jsonc,
        original,
        &["editor.fontSize".into()],
        Some(&json!(19)),
    )
    .unwrap();
    assert!(patched.contains("// IDE preferences"));
    action.operation = "reset".into();
    CursorIde.edit(&mut docs, &mut state, &action).unwrap();
    assert!(docs["settings"].get("editor.fontSize").is_none());
    assert_eq!(state.intents.len(), 1);
    assert_eq!(state.intents[0].operation, "reset");
    let profile:RegisteredProfile=serde_json::from_value(json!({"id":"fixture","tool":"cursor_ide","name":"fixture","version":1,"inheritCommon":false,"files":{},"editing":state})).unwrap();
    let managed = CursorIde
        .managed_fields("settings", &json!({}), &docs["settings"], &profile)
        .unwrap();
    assert!(managed.released.contains(&"/editor.fontSize".into()));
    assert!(managed.fields.contains_key("/extensions.example/keep"));
    let common = CursorIde
        .read_subject(
            &docs,
            &state,
            Scope::Global,
            crate::adapters::configuration::ConfigurationSubject::Common,
        )
        .unwrap();
    assert_eq!(common["commonFields"].as_array().unwrap().len(), 5);

    action.operation = "set".into();
    action.value = Some(json!("invalid"));
    assert!(CursorIde.edit(&mut docs, &mut state, &action).is_err());
    assert!(CursorIde
        .validate_draft("settings", &json!({"mcpServers":{}}))
        .is_err());
    assert!(CursorIde.file_kind("cli-config").is_err());
    assert!(CursorIde
        .validate_draft("settings", &json!({"extension.apiKey":"synthetic-key"}))
        .is_err());
    assert!(CursorIde.has_native_secret("settings", &json!({"extension.apiKey":"synthetic-key"})));
}
#[test]
fn cursor_mcp_native_codec_preserves_unmapped_fields_and_rejects_ignored_switches() {
    let root: Value =
        serde_json::from_str(include_str!("../fixtures/native/cursor-ide/mcp.json")).unwrap();
    let decoded = CursorIde
        .mcp_decode("stdio-demo", &root["mcpServers"]["stdio-demo"])
        .unwrap();
    assert_eq!(decoded.draft.command, "node");
    assert_eq!(decoded.unmapped_fields, vec!["envFile"]);
    assert!(CursorIde
        .mcp_decode("remote-demo", &root["mcpServers"]["remote-demo"])
        .unwrap()
        .unmapped_fields
        .is_empty());
    for entry in [
        json!({"command":["node"]}),
        json!({"command":"node","enabled":false}),
        json!({"command":"node","disabled":true}),
        json!({"url":"https://example.invalid","transport":"http"}),
    ] {
        assert!(CursorIde.mcp_decode("bad", &entry).is_err());
    }
}
#[cfg(windows)]
#[test]
fn cursor_mcp_service_cas_scope_and_disable_restore() {
    let temp = tempfile::tempdir().unwrap();
    installation(temp.path());
    let db = Database::open(&temp.path().join("db")).unwrap();
    let registry = Registry::builtins();
    let store = Store::default();
    let draft:McpDraft=serde_json::from_value(json!({"name":"sample","transport":"stdio","command":"node","args":["fixture.mjs"],"env":{},"headers":{},"url":"","inLibrary":true})).unwrap();
    let def = mcp::save_definition(&db, draft).unwrap();
    let apply = |mut t: McpTargetRequest| {
        let preview =
            mcp::preview_targets(&db, &registry, temp.path(), &def.id, vec![t.clone()]).remove(0);
        t.baseline_hash = preview.baseline_hash;
        t.preview_token = preview.preview_token;
        mcp::distribute(&db, &store, &registry, temp.path(), &def.id, vec![t]).remove(0)
    };
    let first = apply(target());
    assert_eq!(first.status, "written", "{}", first.detail);
    let request = documents::McpDocumentRequest {
        target: target(),
        definition_id: None,
        name: "sample".into(),
        reveal: false,
    };
    let doc = documents::read(&db, &registry, temp.path(), &request).unwrap();
    let edited = doc.text.replace("fixture.mjs", "next.mjs");
    documents::save(
        &db,
        &store,
        &registry,
        temp.path(),
        &target(),
        "sample",
        &doc.baseline,
        &edited,
    )
    .unwrap();
    assert!(documents::save(
        &db,
        &store,
        &registry,
        temp.path(),
        &target(),
        "sample",
        &doc.baseline,
        &edited
    )
    .is_err());
    // Restore the managed definition before exercising its guarded switch.
    let mut overwrite = target();
    overwrite.allow_replace = true;
    assert_eq!(apply(overwrite).status, "written");
    let mut disabled = target();
    disabled.enabled = false;
    assert_eq!(apply(disabled).status, "written");
    assert!(mcp::list_native(&db, &registry, temp.path(), &target())
        .unwrap()
        .is_empty());
    assert_eq!(apply(target()).status, "written");
    let project = temp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let mut scoped = target();
    scoped.scope = Scope::Project;
    scoped.project_path = Some(project.display().to_string());
    assert!(mcp::list_native(&db, &registry, temp.path(), &scoped)
        .unwrap()
        .is_empty());
}
#[cfg(windows)]
#[test]
fn cursor_skills_keep_sources_separate_and_enforce_read_only_on_server() {
    let temp = tempfile::tempdir().unwrap();
    installation(temp.path());
    let db = Database::open(&temp.path().join("db")).unwrap();
    let registry = Registry::builtins();
    let store = Store::default();
    for root in [
        ".cursor/skills/same",
        ".agents/skills/same",
        ".claude/skills/nested/same",
    ] {
        let p = temp.path().join(root);
        fs::create_dir_all(p.join("references")).unwrap();
        fs::write(
            p.join("SKILL.md"),
            format!("---\nname: mismatch\ndescription: \n---\n{root}"),
        )
        .unwrap();
        fs::write(p.join("references/data.bin"), [1, 2, 255]).unwrap();
    }
    let entries = skills::native_metadata(&db, &registry, temp.path(), &target()).unwrap();
    assert_eq!(entries.len(), 3);
    assert_eq!(entries.iter().filter(|e| e.read_only).count(), 2);
    for entry in &entries {
        let doc = skills::read_document(
            &db,
            &registry,
            temp.path(),
            "cursor_ide",
            Scope::Global,
            None,
            &entry.path,
        )
        .unwrap();
        let result = skills::save_document(
            &db,
            &store,
            &registry,
            temp.path(),
            "cursor_ide",
            Scope::Global,
            None,
            &entry.path,
            &doc.content,
            "updated",
        );
        assert_eq!(result.is_err(), entry.read_only);
    }
    let readonly = entries.iter().find(|e| e.source == "agents").unwrap();
    let results = crate::resources::batch::states(
        &db,
        &registry,
        temp.path(),
        vec![crate::resources::batch::StateRequest::NativeSkill {
            target: target(),
            name: "same".into(),
            directory: Some(readonly.path.clone()),
        }],
    )
    .unwrap();
    assert_eq!(results[0].status, "ready");
    let outside = temp.path().join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("SKILL.md"), "outside").unwrap();
    assert!(skills::read_document(
        &db,
        &registry,
        temp.path(),
        "cursor_ide",
        Scope::Global,
        None,
        outside.to_str().unwrap()
    )
    .is_err());
    let project = temp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    assert!(skills::read_document(
        &db,
        &registry,
        temp.path(),
        "cursor_ide",
        Scope::Project,
        project.to_str(),
        &readonly.path
    )
    .is_err());
    let source = temp.path().join("full-package");
    fs::create_dir_all(source.join("references")).unwrap();
    fs::write(source.join("SKILL.md"), "fixture").unwrap();
    fs::write(source.join("references/data.bin"), [1, 2, 255]).unwrap();
    let package = skills::import_local(&db, source.to_str().unwrap(), None, None).unwrap();
    let installed = skills::install(
        &db,
        &registry,
        temp.path(),
        &package.id,
        "cursor_ide",
        Scope::Global,
        None,
    );
    assert_eq!(installed.status, "installed", "{}", installed.detail);
    assert_eq!(
        fs::read(
            temp.path()
                .join(".cursor/skills/full-package/references/data.bin")
        )
        .unwrap(),
        [1, 2, 255]
    );
    fs::remove_file(temp.path().join("AppData/Local/Programs/cursor/Cursor.exe")).unwrap();
    assert!(skills::set_enabled(
        &db,
        &store,
        &registry,
        temp.path(),
        &package.id,
        "cursor_ide",
        Scope::Global,
        None,
        false
    )
    .is_err());
}

#[cfg(windows)]
#[test]
fn cursor_a2_plain_settings_apply_through_shared_service() {
    use crate::native::{apply, profile};
    let temp = tempfile::tempdir().unwrap();
    installation(temp.path());
    let db = Database::open(&temp.path().join("db")).unwrap();
    let registry = Registry::builtins();
    let store = Store::default();
    let project = temp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let draft: RegisteredProfile = serde_json::from_value(json!({
        "id":"", "tool":"cursor_ide", "name":"IDE preferences", "version":1,
        "inheritCommon":false, "files":{"settings":"{\"editor.fontSize\":19}"},
        "editing":{"version":1,"selectedProvider":null,"intents":[]},
        "authentication":{"kind":"native"}, "connection":null, "nativeCredentials":{}
    }))
    .unwrap();
    let saved = profile::save_registered_profile(&db, &registry, draft, None).unwrap();
    for (scope, project) in [
        (Scope::Global, None),
        (Scope::Project, Some(project.as_path())),
    ] {
        let path = paths::settings(temp.path(), scope, project).unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let original = include_str!("../fixtures/native/cursor-ide/settings.jsonc");
        fs::write(&path, original).unwrap();
        apply::preview_registered(&registry, &saved, None, scope).unwrap();
        let result = apply::apply_registered_profile(
            &registry,
            &db,
            &store,
            "cursor_ide",
            &saved.id,
            scope,
            temp.path(),
            project,
            None,
            true,
        )
        .unwrap();
        assert_eq!(result.status, "written_for_next_session");
        let text = fs::read_to_string(&path).unwrap();
        let value = crate::native::format::parse(FileKind::Jsonc, &text).unwrap();
        assert_eq!(value["editor.fontSize"], 19);
        assert_eq!(value["extensions.example"]["keep"], true);
        assert!(text.contains("// IDE preferences"));
    }
    let mut unsupported = saved;
    unsupported.authentication = profile::ProfileAuthentication::ApiKey;
    assert!(CursorIde
        .write_connection_secret(
            &unsupported,
            Scope::Global,
            &store,
            &mut NativeSecrets::default()
        )
        .is_err());
    unsupported.authentication = profile::ProfileAuthentication::Native;
    unsupported.native_credentials.insert(
        "settings".into(),
        BTreeMap::from([("apiKey".into(), "synthetic-reference".into())]),
    );
    assert!(CursorIde
        .write_connection_secret(
            &unsupported,
            Scope::Global,
            &store,
            &mut NativeSecrets::default()
        )
        .is_err());
}

#[cfg(windows)]
#[test]
fn cursor_a2_native_reference_document_copy_paste_preserves_semantics() {
    let temp = tempfile::tempdir().unwrap();
    installation(temp.path());
    let db = Database::open(&temp.path().join("db")).unwrap();
    let registry = Registry::builtins();
    let store = Store::default();
    let path = temp.path().join(".cursor/mcp.json");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut root: Value =
        serde_json::from_str(include_str!("../fixtures/native/cursor-ide/mcp.json")).unwrap();
    // Preserve the original unmapped envFile example, plus its portable subset.
    let mut portable = root["mcpServers"]["stdio-demo"].clone();
    portable.as_object_mut().unwrap().remove("envFile");
    root["mcpServers"]["stdio-portable"] = portable;
    fs::write(&path, serde_json::to_string_pretty(&root).unwrap()).unwrap();
    for name in ["stdio-demo", "stdio-portable", "remote-demo"] {
        let request = documents::McpDocumentRequest {
            target: target(),
            definition_id: None,
            name: name.into(),
            reveal: false,
        };
        let doc = documents::read(&db, &registry, temp.path(), &request).unwrap();
        assert!(!doc.protected_values, "{name}: {}", doc.text);
        assert!(doc.text.contains("${env:DEMO_TOKEN}"));
        assert!(doc.raw_text.as_ref().unwrap().contains("${env:DEMO_TOKEN}"));
        assert!(!doc.text.contains("__CLIORA_REDACTED__"));
        let pasted =
            documents::parse_paste(&db, &registry, temp.path(), &target(), None, &doc.text)
                .unwrap()
                .remove(0);
        if name == "stdio-demo" {
            assert_eq!(pasted.unmapped_fields, vec!["envFile"]);
            assert!(pasted.draft.is_none());
            documents::save(
                &db,
                &store,
                &registry,
                temp.path(),
                &target(),
                name,
                &doc.baseline,
                &doc.text.replace("fixture.mjs", "updated.mjs"),
            )
            .unwrap();
        } else {
            let draft = pasted.draft.unwrap();
            let expected = CursorIde
                .mcp_decode(name, &root["mcpServers"][name])
                .unwrap()
                .draft;
            assert_eq!(draft.env, expected.env);
            assert_eq!(draft.headers, expected.headers);
            let rendered =
                documents::render_draft(&db, &registry, temp.path(), &target(), draft.clone())
                    .unwrap();
            let roundtrip = documents::parse_paste(
                &db,
                &registry,
                temp.path(),
                &target(),
                None,
                &rendered.text,
            )
            .unwrap()
            .remove(0)
            .draft
            .unwrap();
            assert_eq!(roundtrip.env, draft.env);
            assert_eq!(roundtrip.headers, draft.headers);
            let equivalent =
                documents::equivalent(&db, &registry, temp.path(), &target(), name, &target())
                    .unwrap();
            assert!(!equivalent.protected_values);
            assert!(equivalent.text.contains("${env:DEMO_TOKEN}"));
            let mut other = target();
            other.tool_id = "claude_code".into();
            assert!(
                documents::equivalent(&db, &registry, temp.path(), &target(), name, &other)
                    .unwrap_err()
                    .contains("环境变量引用语义")
            );
        }
    }
    for (transport, field) in [
        (McpTransport::Stdio, "env"),
        (McpTransport::Http, "headers"),
    ] {
        let definition = McpDefinition {
            id: "fixture".into(),
            name: "merge".into(),
            transport,
            command: "node".into(),
            args: vec![],
            url: "https://example.invalid/mcp".into(),
            env: BTreeMap::new(),
            headers: BTreeMap::new(),
            in_library: false,
            version: 1,
        };
        let existing = json!({field:{"REFERENCE_TOKEN":"${env:DEMO_TOKEN}","LITERAL_TOKEN":"literal-fixture-secret"}});
        let merged = CursorIde
            .mcp_document(&definition, true, Some(&existing))
            .unwrap()
            .unwrap();
        assert!(merged[field].get("REFERENCE_TOKEN").is_none());
        assert_eq!(merged[field]["LITERAL_TOKEN"], "literal-fixture-secret");
    }
    for secret in [
        "literal-fixture-secret",
        "Bearer literal-fixture-secret",
        "${env:}",
        "${env:TOKEN} literal-fixture-secret",
    ] {
        root["mcpServers"]["remote-demo"]["headers"]["Authorization"] = json!(secret);
        fs::write(&path, serde_json::to_string(&root).unwrap()).unwrap();
        let doc = documents::read(
            &db,
            &registry,
            temp.path(),
            &documents::McpDocumentRequest {
                target: target(),
                definition_id: None,
                name: "remote-demo".into(),
                reveal: false,
            },
        )
        .unwrap();
        assert!(doc.protected_values);
        assert!(doc.text.contains("__CLIORA_REDACTED__"));
        assert!(!doc.text.contains(secret));
        assert!(
            documents::parse_paste(&db, &registry, temp.path(), &target(), None, &doc.text)
                .unwrap()[0]
                .draft
                .is_none()
        );
        documents::save(
            &db,
            &store,
            &registry,
            temp.path(),
            &target(),
            "remote-demo",
            &doc.baseline,
            &doc.text
                .replace("example.invalid/mcp", "example.invalid/updated"),
        )
        .unwrap();
        let saved: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            saved["mcpServers"]["remote-demo"]["headers"]["Authorization"],
            secret
        );
    }
}
