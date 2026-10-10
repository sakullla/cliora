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
            reference_source: None,
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

#[cfg(windows)]
#[test]
fn cursor_a3_reference_provenance_covers_drafts_library_and_distribution() {
    let temp = tempfile::tempdir().unwrap();
    installation(temp.path());
    let db = Database::open(&temp.path().join("db")).unwrap();
    let registry = Registry::builtins();
    let store = Store::default();
    let source = target();
    let mut other = target();
    other.tool_id = "claude_code".into();
    let text = r#"{"mcpServers":{"remote":{"url":"https://example.invalid/mcp","headers":{"Authorization":"Bearer ${env:DEMO_TOKEN}"}}}}"#;
    let path = temp.path().join(".cursor/mcp.json");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, text).unwrap();
    let entries = mcp::list_native(&db, &registry, temp.path(), &source).unwrap();
    assert_eq!(entries[0].reference_source.as_deref(), Some("cursor_ide"));
    let mut draft = documents::parse_paste(&db, &registry, temp.path(), &source, None, text)
        .unwrap().remove(0).draft.unwrap();
    assert_eq!(draft.reference_source.as_deref(), Some("cursor_ide"));
    // Exact formDirty route: caller changes a field before switching the target.
    draft.url = "https://example.invalid/edited".into();
    assert!(documents::render_draft(&db, &registry, temp.path(), &other, draft.clone())
        .unwrap_err().contains("环境变量引用语义"));
    assert!(documents::render_draft(&db, &registry, temp.path(), &source, draft.clone()).is_ok());
    let saved = mcp::save_definition(&db, draft.clone()).unwrap();
    assert_eq!(mcp::get_definition(&db, &saved.id).unwrap().reference_source, draft.reference_source);
    let snapshot = crate::portable::collect_snapshot(&db, &store, &registry).unwrap();
    let mut portable_json = serde_json::to_value(&snapshot).unwrap();
    let entity = portable_json["entities"].as_array_mut().unwrap().iter_mut()
        .find(|entity| entity["id"] == saved.id).unwrap();
    assert_eq!(entity["payload"]["value"]["definition"]["referenceSource"], "cursor_ide");
    entity["payload"]["value"]["definition"].as_object_mut().unwrap().remove("referenceSource");
    let old_snapshot: crate::portable::PortableSnapshot = serde_json::from_value(portable_json.clone()).unwrap();
    crate::portable::validate_snapshot(&old_snapshot).unwrap();
    assert_eq!(serde_json::to_value(&old_snapshot).unwrap(), portable_json);
    for target in [&source, &other] {
        let result = documents::read(&db, &registry, temp.path(), &documents::McpDocumentRequest {
            target: target.clone(), definition_id: Some(saved.id.clone()), name: saved.name.clone(), reveal: false,
        });
        if target.tool_id == source.tool_id { assert!(!result.unwrap().protected_values); }
        else { assert!(result.unwrap_err().contains("环境变量引用语义")); }
    }
    assert!(mcp::preview_targets(&db, &registry, temp.path(), &saved.id, vec![other.clone()])[0]
        .detail.contains("环境变量引用语义"));
    // Actual distribution enforces the rule independently of UI and preview.
    let rejected = mcp::distribute(&db, &store, &registry, temp.path(), &saved.id, vec![other.clone()]);
    assert_eq!(rejected[0].status, "failed");
    assert!(rejected[0].detail.contains("环境变量引用语义"));
    assert!(!temp.path().join(".claude.json").exists());
    let preview = mcp::preview_targets(&db, &registry, temp.path(), &saved.id, vec![source.clone()]).remove(0);
    let mut approved = source.clone();
    approved.baseline_hash = preview.baseline_hash;
    approved.preview_token = preview.preview_token;
    approved.allow_replace = true;
    assert_eq!(mcp::distribute(&db, &store, &registry, temp.path(), &saved.id, vec![approved])[0].status, "written");
    assert!(fs::read_to_string(&path).unwrap().contains("Bearer ${env:DEMO_TOKEN}"));
    // Older editors do not erase existing provenance; copies retain it too.
    draft.id = Some(saved.id.clone());
    draft.expected_version = Some(saved.version);
    draft.reference_source = None;
    let edited = mcp::save_definition(&db, draft).unwrap();
    assert_eq!(edited.reference_source.as_deref(), Some("cursor_ide"));
    let mut copy: mcp::McpDraft = serde_json::from_value(serde_json::to_value(&edited).unwrap()).unwrap();
    copy.id = None;
    copy.expected_version = None;
    copy.name = "remote-copy".into();
    assert_eq!(mcp::save_definition(&db, copy).unwrap().reference_source, edited.reference_source);
    // Old snapshots omit the new optional field. Their serialization stays the
    // same, and known reference syntax still cannot silently become a literal.
    let mut legacy = serde_json::to_value(&edited).unwrap();
    legacy.as_object_mut().unwrap().remove("referenceSource");
    let old: McpDefinition = serde_json::from_value(legacy.clone()).unwrap();
    assert!(old.reference_source.is_none());
    assert_eq!(serde_json::to_value(&old).unwrap(), legacy);
    let legacy_draft: mcp::McpDraft = serde_json::from_value(legacy).unwrap();
    assert!(documents::render_draft(&db, &registry, temp.path(), &other, legacy_draft).is_err());
    // Embedded references are checked too, separately from secret redaction.
    let mut embedded: mcp::McpDraft = serde_json::from_value(serde_json::to_value(&edited).unwrap()).unwrap();
    embedded.headers.clear();
    embedded.url = "https://example.invalid/${env:TOKEN}".into();
    assert!(documents::render_draft(&db, &registry, temp.path(), &other, embedded).is_err());
    let mut arguments: mcp::McpDraft = serde_json::from_value(serde_json::to_value(&edited).unwrap()).unwrap();
    arguments.transport = McpTransport::Stdio;
    arguments.command = "node".into();
    arguments.url.clear();
    arguments.headers.clear();
    arguments.args = vec!["--token=${env:TOKEN}".into()];
    assert!(documents::render_draft(&db, &registry, temp.path(), &other, arguments.clone()).is_err());
    assert!(documents::render_draft(&db, &registry, temp.path(), &source, arguments).is_ok());
    // Literal values which another grammar would expand are equally unsafe.
    let mut literal: mcp::McpDraft = serde_json::from_value(serde_json::to_value(&edited).unwrap()).unwrap();
    literal.headers.insert("Authorization".into(), "Bearer ${TOKEN}".into());
    assert!(documents::render_draft(&db, &registry, temp.path(), &other, literal.clone()).is_err());
    literal.headers.insert("Authorization".into(), "Bearer fixture-secret".into());
    literal.id = None;
    literal.expected_version = None;
    literal.name = "literal".into();
    let secret = mcp::save_definition(&db, literal).unwrap();
    let doc = documents::read(&db, &registry, temp.path(), &documents::McpDocumentRequest {
        target: other, definition_id: Some(secret.id), name: secret.name, reveal: false,
    }).unwrap();
    assert!(doc.protected_values);
    assert!(!doc.text.contains("fixture-secret"));
}

#[test]
fn cursor_a4_nested_reference_scanner_checks_each_candidate() {
    let registry = Registry::builtins();
    let cursor = registry.get("cursor_ide").unwrap();
    let default = registry.get("claude_code").unwrap();
    for (value, expected) in [
        (r#"{"token":"${env:TOKEN}"}"#, vec!["${env:TOKEN}"]),
        (r#"{"nested":{"a":"${env:A}","b":"${env:B}"}}"#, vec!["${env:A}", "${env:B}"]),
        (r#"中文 { "token":"${env:TOKEN}" "#, vec!["${env:TOKEN}"]),
        ("中文 ${env:UNCLOSED", vec![]),
    ] {
        assert_eq!(cursor.mcp_reference_fragments(value), expected, "{value}");
        assert!(default.mcp_reference_fragments(value).is_empty());
    }
    let reverse = r#"{"token":"${TOKEN}"}"#;
    assert_eq!(default.mcp_reference_fragments(reverse), vec!["${TOKEN}"]);
    assert!(cursor.mcp_reference_fragments(reverse).is_empty());
}

#[cfg(windows)]
#[test]
fn cursor_a4_json_argument_conversion_and_distribution_keep_reference_semantics() {
    for (source_id, target_id, reference) in [
        ("cursor_ide", "claude_code", "${env:TOKEN}"),
        ("claude_code", "cursor_ide", "${TOKEN}"),
    ] {
        let temp = tempfile::tempdir().unwrap();
        installation(temp.path());
        let db = Database::open(&temp.path().join("db")).unwrap();
        let registry = Registry::builtins();
        let store = Store::default();
        let mut source = target(); source.tool_id = source_id.into();
        let mut destination = target(); destination.tool_id = target_id.into();
        let argument = serde_json::to_string(&json!({"token": reference})).unwrap();
        let text = serde_json::to_string(&json!({"mcpServers":{"nested":{
            "command":"node", "args":[argument]
        }}})).unwrap();
        let draft = documents::parse_paste(&db, &registry, temp.path(), &source, None, &text)
            .unwrap().remove(0).draft.unwrap();
        assert!(documents::render_draft(&db, &registry, temp.path(), &source, draft.clone()).is_ok());
        let rejected = documents::render_draft(&db, &registry, temp.path(), &destination, draft.clone());
        assert!(rejected.is_err(), "{source_id} -> {target_id} incorrectly rendered {argument}");
        assert!(rejected.unwrap_err().contains("环境变量引用语义"));
        let definition = mcp::save_definition(&db, draft).unwrap();
        let rejected = mcp::distribute(&db, &store, &registry, temp.path(), &definition.id, vec![destination]);
        assert_eq!(rejected[0].status, "failed");
        assert!(rejected[0].detail.contains("环境变量引用语义"));
        let preview = mcp::preview_targets(&db, &registry, temp.path(), &definition.id, vec![source.clone()]).remove(0);
        source.baseline_hash = preview.baseline_hash;
        source.preview_token = preview.preview_token;
        assert_eq!(mcp::distribute(&db, &store, &registry, temp.path(), &definition.id, vec![source.clone()])[0].status, "written");
        let native = mcp::list_native(&db, &registry, temp.path(), &source).unwrap();
        assert_eq!(native[0].args, vec![argument]);
        // Fragment recognition must not make a mixed literal secret public.
        let mixed = serde_json::to_string(&json!({"token":reference, "secret":"literal-fixture-secret"})).unwrap();
        let mut protected: mcp::McpDraft = serde_json::from_value(serde_json::to_value(&definition).unwrap()).unwrap();
        protected.id = None; protected.name = "mixed-secret".into();
        protected.env.insert("API_TOKEN".into(), mixed);
        let secret = mcp::save_definition(&db, protected).unwrap();
        let document = documents::read(&db, &registry, temp.path(), &documents::McpDocumentRequest {
            target: source, definition_id: Some(secret.id), name: secret.name, reveal: false,
        }).unwrap();
        assert!(document.protected_values);
        assert!(document.text.contains("__CLIORA_REDACTED__"));
        assert!(!document.text.contains("literal-fixture-secret"));
    }
}
