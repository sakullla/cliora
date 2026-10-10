use super::*;
use std::collections::HashMap;
use std::sync::Mutex;

#[test]
fn disabled_state_survives_documents_paste_and_equivalent_and_can_be_explicitly_enabled() {
    use crate::resources::documents::{self, McpDocumentRequest};
    // Antigravity/Claude/DeepSeek disable by deleting the native entry; these codecs
    // retain a disabled entry and therefore support a document roundtrip.
    for tool in ["codex", "pi"] {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("db")).unwrap();
        let registry = fixture_registry();
        let keys = MemoryStore::default();
        let definition = sample(&db);
        let source = target(tool, false);
        let result = distribute(&db, &keys, &registry, temp.path(), &definition.id, previewed(&db, &registry, temp.path(), &definition.id, vec![source.clone()]));
        assert_eq!(result[0].status, "written", "{tool}: {}", result[0].detail);
        let document = documents::read(&db, &registry, temp.path(), &McpDocumentRequest { target: source.clone(), definition_id: None, name: definition.name.clone(), reveal: false }).unwrap();
        assert_eq!(document.enabled, Some(false), "{tool}");
        assert!(document.unmapped_fields.is_empty());
        let generated = documents::read(&db, &registry, temp.path(), &McpDocumentRequest { target: source.clone(), definition_id: Some(definition.id.clone()), name: definition.name.clone(), reveal: false }).unwrap();
        assert_eq!(generated.enabled, Some(false));
        let pasted = documents::parse_paste(&db, &registry, temp.path(), &source, None, &document.text).unwrap();
        assert_eq!(pasted[0].enabled, Some(false));
        let rendered = documents::render_draft(&db, &registry, temp.path(), &source, pasted[0].draft.clone().unwrap()).unwrap();
        assert_eq!(rendered.enabled, Some(false));
        assert_eq!(documents::parse_paste(&db, &registry, temp.path(), &source, None, &rendered.text).unwrap()[0].enabled, Some(false));
        let equivalent = documents::equivalent(&db, &registry, temp.path(), &source, &definition.name, &target("codex", true)).unwrap();
        assert_eq!(equivalent.enabled, Some(false));
        assert_eq!(documents::parse_paste(&db, &registry, temp.path(), &target("codex", true), None, &equivalent.text).unwrap()[0].enabled, Some(false));
        assert!(documents::equivalent(&db, &registry, temp.path(), &source, &definition.name, &target("claude_code", true)).is_err());
        assert!(documents::equivalent(&db, &registry, temp.path(), &source, &definition.name, &target("antigravity", true)).is_err());
        assert!(documents::equivalent(&db, &registry, temp.path(), &source, &definition.name, &target("deepseek", true)).is_err());
        assert!(documents::render_draft(&db, &registry, temp.path(), &target("claude_code", false), pasted[0].draft.clone().unwrap()).is_err());
        let enabled = target(tool, true);
        let result = distribute(&db, &keys, &registry, temp.path(), &definition.id, previewed(&db, &registry, temp.path(), &definition.id, vec![enabled.clone()]));
        assert_eq!(result[0].status, "written", "{tool}: {}", result[0].detail);
        assert!(list_native(&db, &registry, temp.path(), &enabled).unwrap()[0].enabled);
    }
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("db")).unwrap();
    let registry = fixture_registry();
    let adapter = registry.get("deepseek").unwrap();
    let definition = sample(&db);
    let mut external = adapter.mcp_document(&definition, true, None).unwrap().unwrap();
    external["disabled"] = serde_json::json!(true);
    let decoded = adapter.mcp_decode(&definition.name, &external).unwrap();
    assert!(!decoded.enabled);
    assert!(decoded.unmapped_fields.is_empty());
    external["futureField"] = serde_json::json!("preserve me");
    assert!(!adapter.mcp_decode(&definition.name, &external).unwrap().unmapped_fields.is_empty());
}

#[test]
fn unsaved_draft_render_roundtrips_without_persisting_or_reading_native_text() {
    use crate::resources::documents;
    for tool in ["codex", "claude_code", "antigravity", "deepseek"] {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("db")).unwrap();
        let registry = fixture_registry();
        let target = target(tool, true);
        let (location, _) = target_location(&db, &registry, &target, temp.path()).unwrap();
        std::fs::create_dir_all(location.path.parent().unwrap()).unwrap();
        // Deliberately invalid text: a caller-owned draft never depends on parsing it.
        let original = "unrelated external document; leave these bytes alone";
        std::fs::write(&location.path, original).unwrap();
        let draft: McpDraft = serde_json::from_value(serde_json::json!({"id":"not-persisted","expectedVersion":41,"name":"unsaved","transport":"stdio","command":"node","args":["one","two words"],"url":"","env":{"API_TOKEN":"${API_TOKEN}"},"headers":{},"inLibrary":true})).unwrap();
        let output = documents::render_draft(&db, &registry, temp.path(), &target, draft.clone()).unwrap();
        assert_eq!(output.source, "equivalent");
        assert!(output.raw_text.is_none());
        assert!(output.baseline.is_empty());
        assert!(!output.protected_values);
        let items = documents::parse_paste(&db, &registry, temp.path(), &target, None, &output.text).unwrap();
        let parsed = items[0].draft.as_ref().unwrap();
        assert_eq!(parsed.args, draft.args);
        assert_eq!(parsed.env, draft.env);
        assert_eq!(parsed.command, draft.command);
        assert!(list_definitions(&db).unwrap().is_empty());
        assert_eq!(std::fs::read_to_string(&location.path).unwrap(), original);
        let mut masked = draft;
        masked.env.insert("API_TOKEN".into(), "__CLIORA_REDACTED__".into());
        assert!(documents::render_draft(&db, &registry, temp.path(), &target, masked).is_err());
        assert!(list_definitions(&db).unwrap().is_empty());
    }
}

#[test]
fn adapter_text_roundtrips_known_aliases_structure_and_bearer_references() {
    use crate::resources::documents::{self, McpDocumentRequest};
    for tool in ["antigravity", "deepseek"] {
        for transport in [McpTransport::Stdio, McpTransport::Http] {
            let temp = tempfile::tempdir().unwrap();
            let db = Database::open(&temp.path().join("db")).unwrap();
            let registry = fixture_registry();
            let mut draft: McpDraft = serde_json::from_value(serde_json::json!({"id":null,"name":"roundtrip","transport":"stdio","command":"node","args":["one","two"],"url":"","env":{},"headers":{},"expectedVersion":null})).unwrap();
            draft.transport = transport;
            if transport == McpTransport::Http {
                draft.command.clear(); draft.args.clear(); draft.url = "https://example.com/mcp".into();
                draft.headers.insert("Authorization".into(), "Bearer ${API_TOKEN}".into());
                draft.headers.insert("X-Api-Key".into(), "Bearer {env:OTHER_TOKEN}".into());
            }
            let definition = save_definition(&db, draft).unwrap();
            let source = target(tool, true);
            let generated = documents::read(&db, &registry, temp.path(), &McpDocumentRequest { target: source.clone(), definition_id: Some(definition.id.clone()), name: definition.name.clone(), reveal: false }).unwrap();
            assert!(!generated.protected_values, "{tool}");
            let pasted = documents::parse_paste(&db, &registry, temp.path(), &source, None, &generated.text).unwrap();
            assert!(pasted[0].draft.is_some(), "{tool}: {:?}", pasted[0]);
            let result = distribute(&db, &MemoryStore::default(), &registry, temp.path(), &definition.id, previewed(&db, &registry, temp.path(), &definition.id, vec![source.clone()]));
            assert_eq!(result[0].status, "written", "{tool}: {}", result[0].detail);
            let native = documents::read(&db, &registry, temp.path(), &McpDocumentRequest { target: source.clone(), definition_id: None, name: definition.name.clone(), reveal: false }).unwrap();
            assert!(!native.protected_values);
            if transport == McpTransport::Http { assert!(native.raw_text.unwrap().contains("Bearer ${API_TOKEN}")); }
            let equivalent = documents::equivalent(&db, &registry, temp.path(), &source, &definition.name, &target("codex", true)).unwrap();
            let pasted = documents::parse_paste(&db, &registry, temp.path(), &target("codex", true), None, &equivalent.text).unwrap();
            let draft = pasted[0].draft.as_ref().unwrap();
            assert_eq!(draft.args, definition.args); assert_eq!(draft.headers, definition.headers); assert_eq!(draft.url, definition.url);
            let (location, _) = target_location(&db, &registry, &source, temp.path()).unwrap();
            let (_, parsed) = parse_native(&location).unwrap();
            let adapter = registry.get(tool).unwrap();
            let mut entry = adapter.mcp_entries(&parsed, &location).unwrap()[&definition.name].clone();
            entry.as_object_mut().unwrap().insert("futureSetting".into(), serde_json::json!({"keep":true}));
            assert!(!adapter.mcp_decode(&definition.name, &entry).unwrap().unmapped_fields.is_empty());
        }
    }
}

#[test]
fn native_text_rejects_invalid_known_types_but_keeps_valid_unknown_fields() {
    use crate::resources::documents::{self, McpDocumentRequest};
    let temp = tempfile::tempdir().unwrap(); let db = Database::open(&temp.path().join("db")).unwrap();
    let registry = fixture_registry(); let target = target("codex", true);
    let (location, _) = target_location(&db, &registry, &target, temp.path()).unwrap();
    std::fs::create_dir_all(location.path.parent().unwrap()).unwrap();
    let original = "[mcp_servers.demo]\ncommand = 'node'\nenabled = true\n";
    std::fs::write(&location.path, original).unwrap();
    let read = documents::read(&db, &registry, temp.path(), &McpDocumentRequest { target: target.clone(), definition_id: None, name: "demo".into(), reveal: false }).unwrap();
    for (key, value) in [("enabled", serde_json::json!("invalid")), ("disabled", serde_json::json!(1)), ("type", serde_json::json!(123)), ("type", serde_json::json!("http")), ("transport", serde_json::json!("invalid")), ("args", serde_json::json!([1])), ("env", serde_json::json!({"PORT":5}))] {
        let text = format::set_path(location.kind, &read.text, &["mcp_servers".into(),"demo".into(),key.into()], Some(&value)).unwrap();
        assert!(documents::save(&db, &MemoryStore::default(), &registry, temp.path(), &target, "demo", &read.baseline, &text).is_err(), "{key}: {value}");
        assert_eq!(std::fs::read_to_string(&location.path).unwrap(), original);
    }
    let text = format::set_path(location.kind, &read.text, &["mcp_servers".into(),"demo".into(),"future".into()], Some(&serde_json::json!({"keep":true}))).unwrap();
    documents::save(&db, &MemoryStore::default(), &registry, temp.path(), &target, "demo", &read.baseline, &text).unwrap();
    assert_eq!(parse_native(&location).unwrap().1["mcp_servers"]["demo"]["future"]["keep"], true);
}

#[test]
fn native_toml_inline_tables_support_redaction_and_leaf_edits() {
    use crate::resources::documents::{self, McpDocumentRequest};
    let temp = tempfile::tempdir().unwrap(); let db = Database::open(&temp.path().join("db")).unwrap();
    let registry = fixture_registry(); let target = target("codex", true);
    let (location, _) = target_location(&db, &registry, &target, temp.path()).unwrap();
    std::fs::create_dir_all(location.path.parent().unwrap()).unwrap();
    let original = "# keep header\n[mcp_servers.demo]\ncommand='node'\nenv = { API_KEY = 'fixture-private', PORT = '1000' } # keep env comment\n[mcp_servers.other]\ncommand='other'\nenv = { PASSWORD = 'other-private' }\n";
    std::fs::write(&location.path, original).unwrap();
    let read = documents::read(&db, &registry, temp.path(), &McpDocumentRequest { target: target.clone(), definition_id: None, name: "demo".into(), reveal: false }).unwrap();
    assert!(!read.raw_text.as_ref().unwrap().contains("fixture-private"));
    assert!(!read.raw_text.as_ref().unwrap().contains("other-private"));
    assert!(read.raw_text.as_ref().unwrap().contains("# keep env comment"));
    let edited = read.text.replace("1000", "2000");
    documents::save(&db, &MemoryStore::default(), &registry, temp.path(), &target, "demo", &read.baseline, &edited).unwrap();
    let text = std::fs::read_to_string(&location.path).unwrap();
    let value = format::parse(location.kind, &text).unwrap();
    assert_eq!(value["mcp_servers"]["demo"]["env"]["API_KEY"], "fixture-private");
    assert_eq!(value["mcp_servers"]["demo"]["env"]["PORT"], "2000");
    assert!(text.contains("# keep header") && text.contains("# keep env comment"));
    assert!(text.contains("env = { PASSWORD = 'other-private' }"));
}

#[test]
fn deletion_based_toggle_preserves_legacy_unknown_and_existing_native_order() {
    let temp = tempfile::tempdir().unwrap(); let db = Database::open(&temp.path().join("db")).unwrap();
    let registry = fixture_registry(); let definition = sample(&db); let store = MemoryStore::default();
    for tool in ["claude_code", "antigravity", "deepseek"] {
        let apply = |enabled| {
            let result = distribute(&db, &store, &registry, temp.path(), &definition.id, previewed(&db, &registry, temp.path(), &definition.id, vec![target(tool, enabled)]));
            assert_eq!(result[0].status, "written", "{tool}: {}", result[0].detail);
        };
        let (location, _) = target_location(&db, &registry, &target(tool, true), temp.path()).unwrap();
        let id = native_order_id(&location, &definition.name);
        let rank = || db.with_connection(|conn| conn.query_row("SELECT sequence FROM resource_order WHERE kind='native_mcp' AND resource_id=?1", [&id], |r| r.get::<_,i64>(0)).optional().map_err(|e| e.to_string())).unwrap();
        apply(true); let initial = rank(); assert!(initial.is_some());
        apply(false); apply(true); assert_eq!(rank(), initial);
        // v21 placements intentionally have no insertion fact after migration.
        db.with_connection(|conn| conn.execute("DELETE FROM resource_order WHERE kind='native_mcp' AND resource_id=?1", [&id]).map(|_|()).map_err(|e| e.to_string())).unwrap();
        apply(false); apply(true); assert_eq!(rank(), None);
        remove_native(&db, &store, &registry, temp.path(), &target(tool, true), &definition.name).unwrap();
        apply(true); assert!(rank().is_some());
    }
}

#[test]
fn v21_migration_does_not_invent_existing_resource_insertion_dates() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("db");
    let db = Database::open(&path).unwrap();
    let old = sample(&db);
    let registry = fixture_registry();
    let store = MemoryStore::default();
    assert_eq!(distribute(&db, &store, &registry, temp.path(), &old.id, previewed(&db, &registry, temp.path(), &old.id, vec![target("claude_code", true)]))[0].status, "written");
    db.with_connection(|conn| conn.execute_batch("DROP TRIGGER resource_mcp_added; DROP TRIGGER resource_mcp_deleted; DROP TRIGGER resource_skill_added; DROP TRIGGER resource_skill_deleted; DROP TRIGGER resource_skill_metadata_added; DROP TRIGGER resource_skill_metadata_changed; DROP TABLE resource_order; DROP TABLE resource_preferences; DROP TABLE skill_package_metadata; DROP TABLE launch_directories; PRAGMA user_version=21;").map_err(|e| e.to_string())).unwrap();
    drop(db);
    let db = Database::open(&path).unwrap();
    assert_eq!(list_definitions(&db).unwrap()[0].id, old.id);
    for enabled in [false, true] {
        assert_eq!(distribute(&db, &store, &registry, temp.path(), &old.id, previewed(&db, &registry, temp.path(), &old.id, vec![target("claude_code", enabled)]))[0].status, "written");
    }
    db.with_connection(|conn| {
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM resource_order", [], |row| row.get::<_,i64>(0)).unwrap(), 0);
        assert_eq!(conn.query_row("PRAGMA user_version", [], |row| row.get::<_,i64>(0)).unwrap(), 23);
        Ok(())
    }).unwrap();
}

#[test]
fn resource_documents_preserve_raw_comments_secrets_unknown_fields_and_reject_stale_edits() {
    use crate::resources::documents::{self, McpDocumentRequest};
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("db")).unwrap();
    let registry = fixture_registry();
    let target = target("codex", true);
    let (location, _) = target_location(&db, &registry, &target, temp.path()).unwrap();
    std::fs::create_dir_all(location.path.parent().unwrap()).unwrap();
    let original = "# retained comment\nother = 42\n[mcp_servers.demo]\ncommand = 'node'\nargs = ['a', 'b']\ncustom = 7\n[mcp_servers.demo.env]\nAPI_KEY = 'fixture-private'\n";
    std::fs::write(&location.path, original).unwrap();
    let request = McpDocumentRequest { target: target.clone(), definition_id: None, name: "demo".into(), reveal: false };
    let read = documents::read(&db, &registry, temp.path(), &request).unwrap();
    assert!(read.protected_values);
    assert!(!read.text.contains("fixture-private"));
    assert!(read.raw_text.as_ref().unwrap().contains("# retained comment"));
    assert!(!read.raw_text.as_ref().unwrap().contains("fixture-private"));
    assert!(read.unmapped_fields.contains(&"custom".into()));
    assert!(documents::equivalent(&db, &registry, temp.path(), &target, "demo", &target).is_err());
    let revealed = documents::read(&db, &registry, temp.path(), &McpDocumentRequest { reveal: true, ..request }).unwrap();
    assert_eq!(revealed.raw_text.as_deref(), Some(original));
    let edited = read.text.replace("node", "new-command");
    documents::save(&db, &MemoryStore::default(), &registry, temp.path(), &target, "demo", &read.baseline, &edited).unwrap();
    let after = std::fs::read_to_string(&location.path).unwrap();
    assert!(after.contains("# retained comment"));
    assert!(after.contains("fixture-private"));
    assert!(after.contains("other = 42"));
    assert!(after.contains("custom = 7"));
    assert!(documents::save(&db, &MemoryStore::default(), &registry, temp.path(), &target, "demo", &read.baseline, &edited).is_err());
}

#[test]
fn paste_reports_each_invalid_or_lossy_item_and_sort_changes_only_on_insert() {
    use crate::resources::{documents, batch};
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("db")).unwrap();
    let registry = fixture_registry();
    let items = documents::parse_paste(&db, &registry, temp.path(), &target("claude_code", true), None,
        r#"{"mcpServers":{"valid":{"command":"node","args":["one","two"]},"bad":{"command":7},"lossy":{"command":"node","timeout":100},"mask":{"command":"node","env":{"TOKEN":"__CLIORA_REDACTED__"}}}}"#).unwrap();
    assert_eq!(items.len(), 4);
    assert!(items.iter().find(|i| i.name == "valid").unwrap().draft.is_some());
    assert!(items.iter().filter(|i| i.name != "valid").all(|i| i.draft.is_none()));
    let first = sample(&db);
    let draft = items.into_iter().find(|i| i.name == "valid").unwrap().draft.unwrap();
    let second = save_definition(&db, draft).unwrap();
    assert_eq!(list_definitions(&db).unwrap()[0].id, second.id);
    let mut edited = serde_json::from_value::<McpDraft>(serde_json::json!({"id":first.id,"name":first.name,"transport":"stdio","command":"updated","args":[],"url":"","env":{},"headers":{},"expectedVersion":first.version})).unwrap();
    edited.in_library = true;
    save_definition(&db, edited).unwrap();
    assert_eq!(list_definitions(&db).unwrap()[0].id, second.id);
    assert_eq!(batch::sort_preference(&db, "library:mcp", Some("name")).unwrap(), "name");
    assert_eq!(batch::sort_preference(&db, "library:mcp", None).unwrap(), "name");
    let snapshot = crate::portable::collect_snapshot(&db, &MemoryStore::default(), &registry).unwrap();
    let before = serde_json::to_value(&snapshot).unwrap();
    batch::sort_preference(&db, "library:mcp", Some("added")).unwrap();
    let after = serde_json::to_value(crate::portable::collect_snapshot(&db, &MemoryStore::default(), &registry).unwrap()).unwrap();
    assert!(before["entities"].is_array());
    assert_eq!(before["entities"], after["entities"]);
    let encoded = serde_json::to_string(&snapshot).unwrap();
    assert!(!encoded.contains("resource_order"));
    assert!(!encoded.contains("library:mcp"));
    crate::portable::validate_snapshot(&serde_json::from_str(&encoded).unwrap()).unwrap();
}

#[test]
fn resource_batch_rejects_duplicate_physical_targets_and_isolates_failures() {
    use crate::resources::batch::{self, Operation, StateRequest};
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("db")).unwrap();
    let registry = fixture_registry();
    let definition = sample(&db);
    let op = || Operation::McpApply { definition_id: definition.id.clone(), target: target("claude_code", true) };
    let results = batch::run(&db, &MemoryStore::default(), &registry, temp.path(), &Uuid::new_v4().to_string(), vec![op(), op()]).unwrap();
    assert!(results.items.iter().all(|i| i.status == "conflict"));
    let mut valid_target = target("claude_code", true);
    let preview = preview_targets(&db, &registry, temp.path(), &definition.id, vec![valid_target.clone()]).remove(0);
    valid_target.baseline_hash = preview.baseline_hash;
    valid_target.preview_token = preview.preview_token;
    let results = batch::run(&db, &MemoryStore::default(), &registry, temp.path(), &Uuid::new_v4().to_string(), vec![Operation::McpApply { definition_id: "missing".into(), target: target("codex", true) }, Operation::McpApply { definition_id: definition.id.clone(), target: valid_target }]).unwrap();
    assert_eq!(results.items[0].status, "failed");
    assert_eq!(results.items[1].status, "written");
    let states = batch::states(&db, &registry, temp.path(), vec![StateRequest::Skill { package_id: "missing".into() }, StateRequest::Mcp { definition_id: definition.id, target: target("claude_code", true) }]).unwrap();
    assert_eq!(states[0].status, "failed");
    assert_eq!(states[1].status, "ready");
    assert!(batch::states(&db, &registry, temp.path(), (0..51).map(|_| StateRequest::Skill { package_id: "missing".into() }).collect()).is_err());
}

#[test]
fn batch_cancellation_keeps_committed_item_and_marks_unstarted_item() {
    use crate::resources::batch::{self, Operation};
    struct CancelStore { id: String, inner: MemoryStore }
    impl CredentialStore for CancelStore {
        fn put(&self, key: &str, value: &str) -> Result<(), String> { self.inner.put(key,value)?; batch::cancel(&self.id)?; Ok(()) }
        fn get(&self, key: &str) -> Result<String, String> { self.inner.get(key) }
        fn delete(&self, key: &str) -> Result<(), String> { self.inner.delete(key) }
    }
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("db")).unwrap();
    let registry = fixture_registry();
    let definition = sample(&db);
    let operations = ["claude_code", "codex"].into_iter().map(|tool| {
        let mut target = target(tool, true);
        let preview = preview_targets(&db, &registry, temp.path(), &definition.id, vec![target.clone()]).remove(0);
        target.baseline_hash = preview.baseline_hash;
        target.preview_token = preview.preview_token;
        Operation::McpApply { definition_id: definition.id.clone(), target }
    }).collect();
    let store = CancelStore { id: Uuid::new_v4().to_string(), inner: MemoryStore::default() };
    let result = batch::run(&db, &store, &registry, temp.path(), &store.id, operations).unwrap();
    assert!(result.cancelled);
    assert_eq!(result.items[0].status, "written");
    assert_eq!(result.items[1].status, "not_executed");
    assert_eq!(list_native(&db, &registry, temp.path(), &target("claude_code", true)).unwrap().len(), 1);
    assert!(list_native(&db, &registry, temp.path(), &target("codex", true)).unwrap().is_empty());
}

fn fixture_registry() -> Registry {
    Registry::builtins()
        .with_fixture_installation("codex", "0.158.0")
        .with_fixture_installation("claude_code", "2.1.284")
        .with_fixture_installation("grok", "1.0.41")
        .with_fixture_installation("open_code", "1.18.33")
}

#[derive(Default)]
struct MemoryStore(Mutex<HashMap<String, String>>);
impl CredentialStore for MemoryStore {
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
            .ok_or("missing key".into())
    }
    fn delete(&self, id: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(id);
        Ok(())
    }
}

fn sample(db: &Database) -> McpDefinition {
    save_definition(
        db,
        McpDraft {
            reference_source: None, reference_scope: None,
            id: None,
            name: "example".into(),
            transport: McpTransport::Stdio,
            command: "npx".into(),
            args: vec!["-y".into(), "example-mcp".into()],
            url: String::new(),
            env: BTreeMap::from([("API_KEY".into(), "${EXAMPLE_KEY}".into())]),
            headers: BTreeMap::new(),
            in_library: true,
            expected_version: None,
        },
    )
    .unwrap()
}

fn target(tool: &str, enabled: bool) -> McpTargetRequest {
    McpTargetRequest { context_id: None,
        tool_id: tool.into(),
        scope: Scope::Global,
        project_path: None,
        enabled,
        baseline_hash: None,
        allow_replace: false,
        preview_token: None,
    }
}

#[test]
fn deepseek_sequence_preview_write_remove_preserves_native_patches() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let registry = Registry::builtins();
    let keys = MemoryStore::default();
    let path = temp.path().join(".dsh/profiles/desktop/cordis.patch.yml");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let original = include_str!("../fixtures/native/dsh-0.2.0-rc.2.yml");
    std::fs::write(&path, original).unwrap();
    let definition = sample(&db);
    let targets = previewed(&db, &registry, temp.path(), &definition.id, vec![target("deepseek", true)]);
    let result = distribute(&db, &keys, &registry, temp.path(), &definition.id, targets);
    assert_eq!(result[0].status, "written", "{:?}", result[0]);
    let entries = list_native(&db, &registry, temp.path(), &target("deepseek", true)).unwrap();
    assert!(entries.iter().any(|entry| entry.name == "example" && entry.command == "npx"));
    let parsed = format::parse(format::FileKind::Yaml, &std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(parsed[0], format::parse(format::FileKind::Yaml, original).unwrap()[0]);
    remove_native(&db, &keys, &registry, temp.path(), &target("deepseek", true), "example").unwrap();
    let remaining = list_native(&db, &registry, temp.path(), &target("deepseek", true)).unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].name, "memory");
}

fn previewed(
    db: &Database,
    registry: &Registry,
    home: &Path,
    id: &str,
    targets: Vec<McpTargetRequest>,
) -> Vec<McpTargetRequest> {
    let preview = preview_targets(db, registry, home, id, targets.clone());
    targets
        .into_iter()
        .zip(preview)
        .map(|(mut request, inspected)| {
            request.baseline_hash = inspected.baseline_hash;
            request.preview_token = inspected.preview_token;
            request
        })
        .collect()
}

#[test]
fn pi_native_mcp_writes_mcp_json_and_keeps_a_disabled_entry() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let keys = MemoryStore::default();
    let registry = fixture_registry();
    let user_file = temp.path().join(".pi/agent/mcp.json");
    std::fs::create_dir_all(user_file.parent().unwrap()).unwrap();
    std::fs::write(&user_file, "{\"theme\":\"quiet\",\"mcpServers\":{\"other\":{\"command\":\"echo\",\"args\":[]}}}").unwrap();
    let definition = sample(&db);
    let preview = preview_targets(&db, &registry, temp.path(), &definition.id, vec![target("pi", true)]);
    assert_eq!(preview[0].status, "ready", "{preview:?}");
    let preview_path = std::path::PathBuf::from(preview[0].path.clone().unwrap());
    assert_eq!(preview_path, user_file, "Pi 全局 MCP 应写到 ~/.pi/agent/mcp.json");
    let written = distribute(
        &db,
        &keys,
        &registry,
        temp.path(),
        &definition.id,
        previewed(&db, &registry, temp.path(), &definition.id, vec![target("pi", true)]),
    );
    assert_eq!(written[0].status, "written", "{written:?}");
    let text = std::fs::read_to_string(&user_file).unwrap();
    assert!(text.contains("\"mcpServers\""));
    assert!(text.contains("\"other\""));
    assert!(text.contains("\"theme\""));
    assert!(text.contains("\"command\": \"npx\""));
    assert!(text.contains("\"type\": \"stdio\""));
    assert!(text.contains("\"enabled\": true"));
    let listed = list_native(&db, &registry, temp.path(), &target("pi", true)).unwrap();
    let example = listed.iter().find(|entry| entry.name == "example").unwrap();
    assert!(example.enabled);
    assert_eq!(example.command, "npx");
    assert!(listed.iter().any(|entry| entry.name == "other"));

    let project = temp.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    let mut project_target = target("pi", true);
    project_target.scope = Scope::Project;
    project_target.project_path = Some(project.display().to_string());
    let project_written = distribute(
        &db,
        &keys,
        &registry,
        temp.path(),
        &definition.id,
        previewed(&db, &registry, temp.path(), &definition.id, vec![project_target]),
    );
    assert_eq!(project_written[0].status, "written", "{project_written:?}");
    assert!(std::fs::read_to_string(project.join(".pi/mcp.json")).unwrap().contains("\"mcpServers\""));

    let disabled = distribute(
        &db,
        &keys,
        &registry,
        temp.path(),
        &definition.id,
        previewed(&db, &registry, temp.path(), &definition.id, vec![target("pi", false)]),
    );
    assert_eq!(disabled[0].status, "written", "{disabled:?}");
    let after = std::fs::read_to_string(&user_file).unwrap();
    assert!(after.contains("\"enabled\": false"));
    assert!(after.contains("\"example\""));
    assert!(!list_native(&db, &registry, temp.path(), &target("pi", true)).unwrap().iter().find(|entry| entry.name == "example").unwrap().enabled);
}

#[test]
fn per_cli_mcp_writes_preserve_other_fields_and_claude_disable_removes_native_entry() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let keys = MemoryStore::default();
    let registry = fixture_registry();
    let codex_path = temp.path().join(".codex/config.toml");
    std::fs::create_dir_all(codex_path.parent().unwrap()).unwrap();
    std::fs::write(
        &codex_path,
        "model = 'gpt-6'\n[mcp_servers.example]\ncommand = 'old'\ncustom = 7\n[mcp_servers.example.env]\nLOG_LEVEL = 'debug'\nAPI_TOKEN = 'literal-fixture'\n",
    )
    .unwrap();
    let opencode_path = temp.path().join(".config/opencode/opencode.json");
    std::fs::create_dir_all(opencode_path.parent().unwrap()).unwrap();
    std::fs::write(
        &opencode_path,
        "{\"mcp\":{\"other\":{\"type\":\"local\",\"command\":[\"echo\"]}}}",
    )
    .unwrap();
    let definition = sample(&db);
    let preview = preview_targets(
        &db,
        &registry,
        temp.path(),
        &definition.id,
        vec![target("codex", true)],
    );
    assert_eq!(preview[0].status, "conflict");
    let mut codex_target = target("codex", true);
    codex_target.baseline_hash = preview[0].baseline_hash.clone();
    codex_target.preview_token = preview[0].preview_token.clone();
    codex_target.allow_replace = true;
    let result = distribute(
        &db,
        &keys,
        &registry,
        temp.path(),
        &definition.id,
        vec![
            codex_target,
            previewed(
                &db,
                &registry,
                temp.path(),
                &definition.id,
                vec![target("claude_code", true)],
            )[0]
            .clone(),
            previewed(
                &db,
                &registry,
                temp.path(),
                &definition.id,
                vec![target("open_code", true)],
            )[0]
            .clone(),
            previewed(
                &db,
                &registry,
                temp.path(),
                &definition.id,
                vec![target("grok", true)],
            )[0]
            .clone(),
        ],
    );
    assert!(
        result.iter().all(|item| item.status == "written"),
        "{result:?}"
    );
    let codex = std::fs::read_to_string(&codex_path).unwrap();
    assert!(codex.contains("model = 'gpt-6'"));
    assert!(codex.contains("custom = 7"));
    assert!(!codex.contains("LOG_LEVEL"));
    assert!(codex.contains("literal-fixture"));
    assert!(codex.contains("enabled = true"));
    let claude = std::fs::read_to_string(temp.path().join(".claude.json")).unwrap();
    assert!(claude.contains("\"mcpServers\""));
    assert!(claude.contains("\"command\": \"npx\""));
    let open_code = std::fs::read_to_string(&opencode_path).unwrap();
    assert!(open_code.contains("\"command\": ["));
    assert!(open_code.contains("\"type\": \"local\""));
    assert!(
        std::fs::read_to_string(temp.path().join(".grok/config.toml"))
            .unwrap()
            .contains("[mcp_servers.example]")
    );
    let entries = list_native(&db, &registry, temp.path(), &target("codex", true)).unwrap();
    assert_eq!(entries[0].name, "example");
    assert_eq!(entries[0].env["API_KEY"], "${EXAMPLE_KEY}");

    let disabled = distribute(
        &db,
        &keys,
        &registry,
        temp.path(),
        &definition.id,
        previewed(
            &db,
            &registry,
            temp.path(),
            &definition.id,
            vec![target("codex", false), target("claude_code", false)],
        ),
    );
    assert!(
        disabled.iter().all(|item| item.status == "written"),
        "{disabled:?}"
    );
    assert!(std::fs::read_to_string(&codex_path)
        .unwrap()
        .contains("enabled = false"));
    assert!(
        list_native(&db, &registry, temp.path(), &target("claude_code", true))
            .unwrap()
            .is_empty()
    );
    assert_eq!(managed_enabled(&db,&definition.id,&target("claude_code",true)).unwrap(),Some(false));
    assert_eq!(
        distribute(
            &db,
            &keys,
            &registry,
            temp.path(),
            &definition.id,
            previewed(
                &db,
                &registry,
                temp.path(),
                &definition.id,
                vec![target("claude_code", true)]
            )
        )[0]
        .status,
        "written"
    );
    assert_eq!(
        list_native(&db, &registry, temp.path(), &target("claude_code", true))
            .unwrap()
            .len(),
        1
    );
    assert_eq!(managed_enabled(&db,&definition.id,&target("claude_code",true)).unwrap(),Some(true));
}

#[test]
fn literal_mcp_credential_is_saved_and_visible() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let saved = save_definition(
        &db,
        McpDraft {
            reference_source: None, reference_scope: None,
            id: None,
            name: "remote".into(),
            transport: McpTransport::Http,
            command: String::new(),
            args: Vec::new(),
            url: "https://example.com/mcp".into(),
            env: BTreeMap::new(),
            headers: BTreeMap::from([("Authorization".into(), "Bearer ${API_TOKEN}".into())]),
            in_library: true,
            expected_version: None,
        },
    )
    .unwrap();
    let keys = MemoryStore::default();
    let registry = fixture_registry();
    assert_eq!(
        distribute(
            &db,
            &keys,
            &registry,
            temp.path(),
            &saved.id,
            previewed(
                &db,
                &registry,
                temp.path(),
                &saved.id,
                vec![target("grok", true)]
            )
        )[0]
        .status,
        "written"
    );
    let entries = list_native(&db, &registry, temp.path(), &target("grok", true)).unwrap();
    assert_eq!(entries[0].headers["Authorization"], "Bearer ${API_TOKEN}");
    assert!(!entries[0].protected_values);
    let literal = save_definition(
        &db,
        McpDraft {
            reference_source: None, reference_scope: None,
            id: None,
            name: "literal".into(),
            transport: McpTransport::Http,
            command: String::new(),
            args: Vec::new(),
            url: "https://example.com/mcp".into(),
            env: BTreeMap::from([("MYSQL_PASSWORD".into(), "local-secret".into())]),
            headers: BTreeMap::from([("Authorization".into(), "Bearer plaintext".into())]),
            in_library: true,
            expected_version: None,
        },
    )
    .unwrap();
    assert_eq!(literal.env["MYSQL_PASSWORD"], "local-secret");
    assert_eq!(literal.headers["Authorization"], "Bearer plaintext");
}

#[test]
fn omitted_native_secret_stays_until_an_empty_value_removes_it() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let keys = MemoryStore::default();
    let registry = fixture_registry();
    let path = temp.path().join(".codex/config.toml");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(
        &path,
        "[mcp_servers.db]\ncommand = 'npx'\n[mcp_servers.db.env]\nMYSQL_PASSWORD = 'kept-secret'\n",
    )
    .unwrap();
    let saved = save_definition(
        &db,
        McpDraft {
            reference_source: None, reference_scope: None,
            id: None,
            name: "db".into(),
            transport: McpTransport::Stdio,
            command: "npx".into(),
            args: vec!["server".into()],
            url: String::new(),
            env: BTreeMap::from([("MYSQL_PORT".into(), "3216".into())]),
            headers: BTreeMap::new(),
            in_library: true,
            expected_version: None,
        },
    )
    .unwrap();
    let before = list_native(&db, &registry, temp.path(), &target("codex", true)).unwrap();
    assert_eq!(before[0].env["MYSQL_PASSWORD"], "kept-secret");
    assert!(!before[0].protected_values);
    let preview = preview_targets(&db, &registry, temp.path(), &saved.id, vec![target("codex", true)]);
    let mut request = target("codex", true);
    request.allow_replace = true;
    request.baseline_hash = preview[0].baseline_hash.clone();
    request.preview_token = preview[0].preview_token.clone();
    let written = distribute(&db, &keys, &registry, temp.path(), &saved.id, vec![request]);
    assert_eq!(written[0].status, "written", "{written:?}");
    let kept = std::fs::read_to_string(&path).unwrap();
    assert!(kept.contains("kept-secret"));
    assert!(kept.contains("3216"));
    let cleared = save_definition(
        &db,
        McpDraft {
            reference_source: None, reference_scope: None,
            id: Some(saved.id.clone()),
            name: "db".into(),
            transport: McpTransport::Stdio,
            command: "npx".into(),
            args: vec!["server".into()],
            url: String::new(),
            env: BTreeMap::from([
                ("MYSQL_PORT".into(), "3216".into()),
                ("MYSQL_PASSWORD".into(), String::new()),
            ]),
            headers: BTreeMap::new(),
            in_library: true,
            expected_version: Some(saved.version),
        },
    )
    .unwrap();
    let removed = distribute(
        &db,
        &keys,
        &registry,
        temp.path(),
        &cleared.id,
        previewed(&db, &registry, temp.path(), &cleared.id, vec![target("codex", true)]),
    );
    assert_eq!(removed[0].status, "written", "{removed:?}");
    assert!(!std::fs::read_to_string(&path).unwrap().contains("kept-secret"));
}

#[test]
fn external_same_name_and_later_modification_require_fresh_explicit_replace() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let keys = MemoryStore::default();
    let registry = fixture_registry();
    let definition = sample(&db);
    let path = temp.path().join(".codex/config.toml");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, "[mcp_servers.example]\ncommand = 'outside'\n").unwrap();
    let denied = distribute(
        &db,
        &keys,
        &registry,
        temp.path(),
        &definition.id,
        vec![target("codex", true)],
    );
    assert_eq!(denied[0].status, "failed");
    assert!(std::fs::read_to_string(&path).unwrap().contains("outside"));
    let preview = preview_targets(
        &db,
        &registry,
        temp.path(),
        &definition.id,
        vec![target("codex", true)],
    );
    let mut confirmed = target("codex", true);
    confirmed.allow_replace = true;
    confirmed.baseline_hash = preview[0].baseline_hash.clone();
    confirmed.preview_token = preview[0].preview_token.clone();
    std::fs::write(&path, "[mcp_servers.example]\ncommand = 'new-outside'\n").unwrap();
    let stale = distribute(
        &db,
        &keys,
        &registry,
        temp.path(),
        &definition.id,
        vec![confirmed.clone()],
    );
    assert_eq!(stale[0].status, "failed");
    assert!(std::fs::read_to_string(&path)
        .unwrap()
        .contains("new-outside"));
    let fresh = preview_targets(
        &db,
        &registry,
        temp.path(),
        &definition.id,
        vec![target("codex", true)],
    );
    confirmed.baseline_hash = fresh[0].baseline_hash.clone();
    confirmed.preview_token = fresh[0].preview_token.clone();
    assert_eq!(
        distribute(
            &db,
            &keys,
            &registry,
            temp.path(),
            &definition.id,
            vec![confirmed]
        )[0]
        .status,
        "written"
    );
    std::fs::write(&path, "[mcp_servers.example]\ncommand = 'changed-again'\n").unwrap();
    assert_eq!(
        distribute(
            &db,
            &keys,
            &registry,
            temp.path(),
            &definition.id,
            vec![target("codex", true)]
        )[0]
        .status,
        "failed"
    );
}

#[test]
fn preview_is_bound_to_definition_version_scope_and_target_content() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let registry = fixture_registry();
    let keys = MemoryStore::default();
    let definition = sample(&db);
    let project = temp.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    let mut request = previewed(
        &db,
        &registry,
        temp.path(),
        &definition.id,
        vec![target("codex", true)],
    )[0]
    .clone();
    request.scope = Scope::Project;
    request.project_path = Some(project.display().to_string());
    assert_eq!(
        distribute(
            &db,
            &keys,
            &registry,
            temp.path(),
            &definition.id,
            vec![request]
        )[0]
        .status,
        "failed"
    );
    let request = previewed(
        &db,
        &registry,
        temp.path(),
        &definition.id,
        vec![target("codex", true)],
    );
    save_definition(
        &db,
        McpDraft {
            reference_source: None, reference_scope: None,
            id: Some(definition.id.clone()),
            expected_version: Some(definition.version),
            name: definition.name.clone(),
            transport: definition.transport,
            command: "different-command".into(),
            args: definition.args.clone(),
            url: definition.url.clone(),
            env: definition.env.clone(),
            headers: definition.headers.clone(),
            in_library: true,
        },
    )
    .unwrap();
    let rejected = distribute(&db, &keys, &registry, temp.path(), &definition.id, request);
    assert_eq!(rejected[0].status, "failed");
    assert!(rejected[0].detail.contains("预览"));
    assert!(!temp.path().join(".codex/config.toml").exists());
    let fresh = previewed(
        &db,
        &registry,
        temp.path(),
        &definition.id,
        vec![target("codex", true)],
    );
    assert_eq!(
        distribute(&db, &keys, &registry, temp.path(), &definition.id, fresh)[0].status,
        "written"
    );
}

#[test]
fn preview_shows_the_native_value_so_a_conflict_can_be_compared() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let registry = fixture_registry();
    let definition = sample(&db);
    let path = temp.path().join(".codex/config.toml");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, "[mcp_servers.example]\ncommand = 'outside'\n[mcp_servers.example.env]\nAPI_KEY = 'private-token'\n").unwrap();
    let preview = preview_targets(
        &db,
        &registry,
        temp.path(),
        &definition.id,
        vec![target("codex", true)],
    );
    assert_eq!(preview[0].status, "conflict");
    let before = preview[0].existing.as_ref().unwrap();
    let after = preview[0].proposed.as_ref().unwrap();
    assert_eq!(before["command"], "outside");
    assert_eq!(after["command"], "npx");
    assert_eq!(before["env"]["API_KEY"], "private-token");
    assert_eq!(after["env"]["API_KEY"], "${EXAMPLE_KEY}");
}

#[test]
fn opencode_v2_probe_writes_nested_servers_and_disabled_flag() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let registry = fixture_registry().with_fixture_installation("open_code", "2.1.0");
    let keys = MemoryStore::default();
    let path = temp.path().join(".config/opencode/opencode.json");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, "{\"mcp\":{\"timeout\":{\"startup\":45000}}}").unwrap();
    let definition = sample(&db);
    let first = distribute(
        &db,
        &keys,
        &registry,
        temp.path(),
        &definition.id,
        previewed(
            &db,
            &registry,
            temp.path(),
            &definition.id,
            vec![target("open_code", true)],
        ),
    );
    assert_eq!(first[0].status, "written", "{first:?}");
    let parsed: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(parsed["mcp"]["timeout"]["startup"], 45000);
    assert_eq!(parsed["mcp"]["servers"]["example"]["disabled"], false);
    assert!(parsed["mcp"]["example"].is_null());
    let second = distribute(
        &db,
        &keys,
        &registry,
        temp.path(),
        &definition.id,
        previewed(
            &db,
            &registry,
            temp.path(),
            &definition.id,
            vec![target("open_code", false)],
        ),
    );
    assert_eq!(second[0].status, "written", "{second:?}");
    let parsed: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(parsed["mcp"]["servers"]["example"]["disabled"], true);
}

#[test]
fn one_invalid_target_does_not_prevent_another_and_can_be_retried() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let keys = MemoryStore::default();
    let registry = fixture_registry();
    let grok_path = temp.path().join(".grok/config.toml");
    std::fs::create_dir_all(grok_path.parent().unwrap()).unwrap();
    std::fs::write(&grok_path, "[broken\n").unwrap();
    let definition = sample(&db);
    let result = distribute(
        &db,
        &keys,
        &registry,
        temp.path(),
        &definition.id,
        previewed(
            &db,
            &registry,
            temp.path(),
            &definition.id,
            vec![target("grok", true), target("codex", true)],
        ),
    );
    assert_eq!(result[0].status, "failed");
    assert_eq!(result[1].status, "written");
    assert_eq!(std::fs::read_to_string(&grok_path).unwrap(), "[broken\n");
    std::fs::write(&grok_path, "[ui]\ncompact_mode = true\n").unwrap();
    let retried = distribute(
        &db,
        &keys,
        &registry,
        temp.path(),
        &definition.id,
        previewed(
            &db,
            &registry,
            temp.path(),
            &definition.id,
            vec![target("grok", true)],
        ),
    );
    assert_eq!(retried[0].status, "written");
    assert!(std::fs::read_to_string(&grok_path)
        .unwrap()
        .contains("compact_mode = true"));
}

#[test]
fn removing_an_externally_deleted_mcp_clears_placement_and_allows_reinstall() {
    for missing_file in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("cliora.db")).unwrap();
        let registry = fixture_registry();
        let keys = MemoryStore::default();
        let definition = sample(&db);
        let request = target("codex", true);
        let targets = previewed(&db, &registry, temp.path(), &definition.id,
            vec![request.clone(), target("claude_code", true)]);
        let results = distribute(&db, &keys, &registry, temp.path(), &definition.id, targets);
        assert!(results.iter().all(|result| result.status == "written"), "{results:?}");
        let path = temp.path().join(".codex/config.toml");
        let unrelated = "# keep native settings\nmodel = 'gpt-6'\n[mcp_servers.other]\ncommand = 'stay'\n";
        if missing_file {
            std::fs::remove_file(&path).unwrap();
        } else {
            std::fs::write(&path, unrelated).unwrap();
        }
        assert_eq!(list_placements(&db).unwrap().len(), 2);
        for _ in 0..2 {
            remove_native(&db, &keys, &registry, temp.path(), &request, &definition.name).unwrap();
            let remaining = list_placements(&db).unwrap();
            assert_eq!(remaining.len(), 1);
            assert_eq!(remaining[0].tool_id, "claude_code");
            if missing_file {
                assert!(!path.exists(), "reconciling an absent MCP must not create a native file");
            } else {
                assert_eq!(std::fs::read_to_string(&path).unwrap(), unrelated);
            }
        }
        assert_eq!(get_definition(&db, &definition.id).unwrap().name, definition.name);
        let targets = previewed(&db, &registry, temp.path(), &definition.id, vec![request.clone()]);
        let result = distribute(&db, &keys, &registry, temp.path(), &definition.id, targets);
        assert_eq!(result[0].status, "written", "{:?}", result[0]);
        assert!(list_native(&db, &registry, temp.path(), &request).unwrap().iter().any(|entry| entry.name == definition.name));
        assert_eq!(list_placements(&db).unwrap().len(), 2);
    }
}

#[test]
fn deleting_a_definition_checks_version_and_native_removal_keeps_other_entries() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let saved = sample(&db);
    assert!(delete_definition(&db, &saved.id, 0).is_err());
    delete_definition(&db, &saved.id, saved.version).unwrap();
    assert!(get_definition(&db, &saved.id).is_err());

    let registry = fixture_registry();
    let keys = MemoryStore::default();
    let codex_path = temp.path().join(".codex/config.toml");
    std::fs::create_dir_all(codex_path.parent().unwrap()).unwrap();
    std::fs::write(&codex_path, "model = 'gpt-6'\n[mcp_servers.example]\ncommand = 'old'\n[mcp_servers.other]\ncommand = 'stay'\n").unwrap();
    remove_native(&db, &keys, &registry, temp.path(), &target("codex", true), "example").unwrap();
    let text = std::fs::read_to_string(&codex_path).unwrap();
    assert!(!text.contains("[mcp_servers.example]"));
    assert!(text.contains("[mcp_servers.other]"));
    assert!(text.contains("gpt-6"));
}

#[test]
fn pasted_stdio_command_line_is_split_before_a_client_spawns_it() {
    let (command, args) = stdio_command("npx -y chrome-devtools-mcp@latest", &[]);
    assert_eq!(command, "npx");
    assert_eq!(args, ["-y", "chrome-devtools-mcp@latest"]);
    let (command, args) = stdio_command(r#""C:\Program Files\nodejs\npx.cmd" -y pkg"#, &[]);
    assert_eq!(command, r"C:\Program Files\nodejs\npx.cmd");
    assert_eq!(args, ["-y", "pkg"]);
    let (command, args) = stdio_command("npx", &["-y".into(), "pkg".into()]);
    assert_eq!((command.as_str(), args), ("npx", vec!["-y".into(), "pkg".into()]));
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let saved = save_definition(
        &db,
        McpDraft {
            reference_source: None, reference_scope: None,
            id: None,
            name: "chrome-devtools-mcp".into(),
            transport: McpTransport::Stdio,
            command: "npx -y chrome-devtools-mcp@latest".into(),
            args: vec![],
            url: String::new(),
            env: BTreeMap::new(),
            headers: BTreeMap::new(),
            in_library: true,
            expected_version: None,
        },
    )
    .unwrap();
    assert_eq!(saved.command, "npx");
    assert_eq!(saved.args, ["-y", "chrome-devtools-mcp@latest"]);
}

#[test]
fn default_reference_grammar_stays_unchanged_in_document_copy_paste() {
    use crate::resources::documents::{self, McpDocumentRequest};
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("db")).unwrap();
    let registry = fixture_registry();
    let source = target("codex", true);
    let adapter = registry.get("codex").unwrap();
    let (location, _) = target_location(&db, &registry, &source, temp.path()).unwrap();
    std::fs::create_dir_all(location.path.parent().unwrap()).unwrap();
    for value in ["${TOKEN}", "{env:TOKEN}", "Bearer ${TOKEN}", "Bearer {env:TOKEN}"] {
        assert!(adapter.mcp_is_reference(value));
        let entry = serde_json::json!({"url":"https://example.invalid/mcp","http_headers":{"Authorization":value}});
        let text = adapter.mcp_render_entry(&location, "example", entry).unwrap();
        std::fs::write(&location.path, &text).unwrap();
        let doc = documents::read(&db, &registry, temp.path(), &McpDocumentRequest { target:source.clone(),definition_id:None,name:"example".into(),reveal:false }).unwrap();
        assert!(!doc.protected_values);
        let pasted = documents::parse_paste(&db, &registry, temp.path(), &source, None, &doc.text).unwrap();
        assert_eq!(pasted[0].draft.as_ref().unwrap().headers["Authorization"], value);
    }
    assert!(!adapter.mcp_is_reference("${env:TOKEN}"));
    assert!(!adapter.mcp_is_reference("Bearer literal-fixture-secret"));
}
