use super::{model_provider_id, Codex, RESERVED_MODEL_PROVIDERS};
use crate::adapters::configuration::*;
use crate::native::{
    adapter::Scope,
    profile::{Connection, RegisteredProfile},
};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const PARAMETERS: &[&str] = &[
    "model",
    "model_provider",
    "model_reasoning_effort",
    "model_context_window",
    "model_reasoning_summary",
    "model_verbosity",
];
// Codex 0.160.0 ModelProviderInfo::to_api_provider uses this default for API-key
// and unauthenticated requests. It is a read-only projection, never an overlay.
const DEFAULT_API_BASE_URL: &str = "https://api.openai.com/v1";

fn effective_api_base<'a>(provider: &str, definition: &'a Value) -> Option<&'a str> {
    if let Some(base) = definition.get("base_url") {
        return base.as_str();
    }
    if !definition.is_object()
        || RESERVED_MODEL_PROVIDERS.contains(&provider)
        || definition["requires_openai_auth"] == true
        || ["auth", "aws", "gateway_oauth"]
            .iter()
            .any(|field| definition.get(*field).is_some())
    {
        return None;
    }
    Some(DEFAULT_API_BASE_URL)
}
fn valid_environment_reference(value: &Value) -> bool {
    value.as_str().is_some_and(|name| {
        let mut bytes = name.bytes();
        bytes
            .next()
            .is_some_and(|first| first.is_ascii_alphabetic() || first == b'_')
            && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    })
}

fn capabilities(model: &str) -> Vec<String> {
    // Evidence is a public native catalog snapshot, not a model-name heuristic.
    let catalog: Value = serde_json::from_str(include_str!("model_capabilities.json"))
        .expect("embedded Codex catalog");
    catalog["models"][model]
        .as_array()
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        adapters::Registry,
        native::{
            configuration,
            format::{self, FileKind},
        },
    };
    #[derive(Default)]
    struct MemoryCredentials(std::sync::Mutex<std::collections::HashMap<String, String>>);
    impl crate::credentials::CredentialStore for MemoryCredentials {
        fn put(&self, id: &str, value: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert(id.into(), value.into());
            Ok(())
        }
        fn get(&self, id: &str) -> Result<String, String> {
            self.0
                .lock()
                .unwrap()
                .get(id)
                .cloned()
                .ok_or("missing fixture credential".into())
        }
        fn delete(&self, id: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(id);
            Ok(())
        }
    }
    fn action(operation: &str, field: &str, value: Value) -> ConfigurationAction {
        ConfigurationAction {
            version: 1,
            target: json!("configuration"),
            operation: operation.into(),
            field: Some(field.into()),
            value: Some(value),
        }
    }
    fn profile() -> RegisteredProfile {
        serde_json::from_value(json!({"id":"","tool":"codex","name":"Native models","version":0,"inheritCommon":false,"files":{"settings":include_str!("../../../../tests/fixtures/native/codex-model-editor.toml")},"connection":null,"nativeCredentials":{}})).unwrap()
    }
    fn default_address_profile() -> RegisteredProfile {
        let mut profile = profile();
        let mut settings = format::parse(FileKind::Toml, &profile.files["settings"]).unwrap();
        settings["model_provider"] = json!("native_default");
        profile.files.insert(
            "settings".into(),
            format::render(FileKind::Toml, &settings).unwrap(),
        );
        profile
    }
    fn native_fixture_file(path: &std::path::Path) -> crate::native::adapter::NativeFile {
        crate::native::adapter::NativeFile {
            role: "settings",
            path: path.display().to_string(),
            format: "toml",
            writable: true,
            reason: None,
            sensitive: false,
        }
    }
    #[test]
    fn codex_native_parameters_round_trip_and_complete_save_rejects_invalid() {
        let registry = Registry::with_adapters(vec![&Codex]).unwrap();
        let mut draft =
            configuration::open(&registry, profile(), Scope::Global, "codex-session".into())
                .unwrap();
        assert!(draft.issues.is_empty());
        assert!(draft.view["effortChoices"]
            .as_array()
            .unwrap()
            .contains(&json!("ultra")));
        draft = configuration::edit(
            &registry,
            draft,
            action("set", "model_context_window", json!(524288)),
        )
        .unwrap();
        let parsed = format::parse(FileKind::Toml, &draft.profile.files["settings"]).unwrap();
        assert_eq!(parsed["model_context_window"], 524288);
        assert_eq!(parsed["features"]["user_defined_feature"], true);
        assert_eq!(
            parsed["model_providers"]["untouched"]["name"],
            "Other provider"
        );
        assert!(parsed.get("models").is_none());
        let bad = configuration::edit(
            &registry,
            draft.clone(),
            action("set", "model_reasoning_effort", json!("minimal")),
        )
        .unwrap();
        assert!(bad
            .issues
            .iter()
            .any(|issue| issue.field.as_deref() == Some("model_reasoning_effort")));
        let temp = tempfile::tempdir().unwrap();
        let db = crate::database::Database::open(&temp.path().join("test.db")).unwrap();
        assert!(
            crate::native::profile::save_registered_profile(&db, &registry, bad.profile, None)
                .is_err()
        );
        let bad = configuration::edit(
            &registry,
            draft.clone(),
            action("set", "model_context_window", json!(0)),
        )
        .unwrap();
        assert!(!bad.issues.is_empty());
        let future = configuration::edit(
            &registry,
            draft.clone(),
            action(
                "set",
                "model_reasoning_effort",
                json!("future_native_effort"),
            ),
        )
        .unwrap();
        assert!(future.issues.is_empty());
        assert_eq!(
            future.view["values"]["model_reasoning_effort"],
            "future_native_effort"
        );
        draft = configuration::edit(
            &registry,
            draft,
            action("set", "model", json!("unknown-合法模型")),
        )
        .unwrap();
        draft = configuration::edit(
            &registry,
            draft,
            action(
                "set",
                "model_reasoning_effort",
                json!("provider_future_effort"),
            ),
        )
        .unwrap();
        assert!(draft.issues.is_empty());
        assert!(draft.view["effortChoices"].as_array().unwrap().is_empty());
    }
    #[test]
    fn codex_reset_releases_field_and_raw_replacement_reclaims_ownership() {
        let registry = Registry::with_adapters(vec![&Codex]).unwrap();
        let draft =
            configuration::open(&registry, profile(), Scope::Global, "codex-session".into())
                .unwrap();
        let reset = configuration::edit(
            &registry,
            draft,
            action("reset", "model_verbosity", Value::Null),
        )
        .unwrap();
        let own = format::parse(FileKind::Toml, &reset.profile.files["settings"]).unwrap();
        assert!(own.get("model_verbosity").is_none());
        let managed = Codex
            .managed_fields("settings", &json!({}), &own, &reset.profile)
            .unwrap();
        assert_eq!(managed.released, vec!["/model_verbosity"]);
        let mut restored = own;
        restored["model_verbosity"] = json!("high");
        let raw = configuration::replace_text(
            &registry,
            reset,
            BTreeMap::from([(
                "settings".into(),
                format::render(FileKind::Toml, &restored).unwrap(),
            )]),
        );
        assert!(raw.profile.editing.unwrap().intents.is_empty());
        assert!(
            Codex
                .validate(
                    &BTreeMap::from([(
                        "settings".into(),
                        json!({"model_reasoning_summary":"invalid"})
                    )]),
                    &EditingState::default(),
                    Scope::Global
                )
                .len()
                == 1
        );
    }
    #[test]
    fn codex_provider_switch_detaches_other_definitions_and_address_reset_keeps_identity() {
        let current = json!({"model_provider":"gateway/a~b","model_providers":{"gateway/a~b":{"name":"Original","base_url":"https://a.example.test/v1","wire_api":"responses"},"next":{"name":"Next","base_url":"https://b.example.test/v1","wire_api":"responses"}}});
        let desired = json!({"model_provider":"next","model_providers":{"next":{"name":"Next","base_url":"https://b.example.test/v1","wire_api":"responses"}}});
        assert_eq!(
            Codex
                .unmanaged_paths("settings", &current, &desired, &profile())
                .unwrap(),
            vec!["/model_providers/gateway~1a~0b"]
        );
        let mut documents = BTreeMap::from([("settings".into(), current)]);
        let mut reset = action("reset", "base_url", Value::Null);
        reset.target = json!("gateway/a~b");
        let mut state = EditingState::default();
        Codex.edit(&mut documents, &mut state, &reset).unwrap();
        state.intents.push(reset.clone());
        Codex
            .edit(
                &mut documents,
                &mut state,
                &action("set", "model_provider", json!("next")),
            )
            .unwrap();
        let mut profile = profile();
        profile.editing = Some(state);
        let managed = Codex
            .managed_fields("settings", &json!({}), &documents["settings"], &profile)
            .unwrap();
        assert_eq!(
            managed.released,
            vec!["/model_providers/gateway~1a~0b/base_url"]
        );
        assert_eq!(
            Codex.suppression_changes(&reset).unwrap()[0].path,
            "/model_providers/gateway~1a~0b/base_url"
        );
    }
    #[test]
    fn codex_apply_switch_preserves_previous_provider_and_unrelated_native_credential() {
        let registry = Registry::with_adapters(vec![&Codex]).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("isolated-config.toml");
        let mut native = format::parse(
            FileKind::Toml,
            include_str!("../../../../tests/fixtures/native/codex-model-editor.toml"),
        )
        .unwrap();
        native["model_providers"]["gateway"]["experimental_bearer_token"] =
            json!("fixture-only-native-token");
        std::fs::write(&path, format::render(FileKind::Toml, &native).unwrap()).unwrap();
        let db = crate::database::Database::open(&temp.path().join("test.db")).unwrap();
        let credentials = MemoryCredentials::default();
        let draft = configuration::open(
            &registry,
            profile(),
            Scope::Global,
            "codex-apply-session".into(),
        )
        .unwrap();
        let first =
            crate::native::profile::save_registered_profile(&db, &registry, draft.profile, None)
                .unwrap();
        let file = crate::native::adapter::NativeFile {
            role: "settings",
            path: path.display().to_string(),
            format: "toml",
            writable: true,
            reason: None,
            sensitive: false,
        };
        crate::native::apply::apply_registered_validated(
            &registry,
            &db,
            &credentials,
            &first,
            None,
            std::slice::from_ref(&file),
            "global",
            Scope::Global,
            true,
        )
        .unwrap();
        let before =
            format::parse(FileKind::Toml, &std::fs::read_to_string(&path).unwrap()).unwrap();
        let draft = configuration::open(
            &registry,
            first.clone(),
            Scope::Global,
            "codex-apply-next".into(),
        )
        .unwrap();
        let draft = configuration::edit(
            &registry,
            draft,
            action("set", "model_provider", json!("untouched")),
        )
        .unwrap();
        let next = crate::native::profile::save_registered_profile(
            &db,
            &registry,
            draft.profile,
            Some(first.version),
        )
        .unwrap();
        crate::native::apply::apply_registered_validated(
            &registry,
            &db,
            &credentials,
            &next,
            None,
            std::slice::from_ref(&file),
            "global",
            Scope::Global,
            true,
        )
        .unwrap();
        let after =
            format::parse(FileKind::Toml, &std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(after["model_provider"], "untouched");
        assert_eq!(
            after["model_providers"]["gateway"],
            before["model_providers"]["gateway"]
        );
        assert_eq!(
            after["model_providers"]["gateway"]["experimental_bearer_token"],
            "fixture-only-native-token"
        );
        assert_eq!(after["features"], before["features"]);
    }
    #[test]
    fn codex_environment_reference_accepts_only_native_variable_names() {
        for name in ["OPENAI_API_KEY", "TEST_GATEWAY_KEY", "_native_key"] {
            assert!(valid_environment_reference(&json!(name)));
        }
        for name in [
            "",
            "literal-key-value",
            "${OPENAI_API_KEY}",
            "/tmp/key",
            "file:/tmp/key",
            "$(read-key)",
            "123KEY",
            "KEY WITH SPACE",
        ] {
            assert!(!valid_environment_reference(&json!(name)));
        }
        assert!(!valid_environment_reference(
            &json!({"key":"TEST_GATEWAY_KEY"})
        ));
    }
    #[test]
    fn codex_lowercase_native_environment_reference_survives_complete_save() {
        let registry = Registry::with_adapters(vec![&Codex]).unwrap();
        let mut profile = profile();
        let mut settings = format::parse(FileKind::Toml, &profile.files["settings"]).unwrap();
        settings["model_providers"]["gateway"]["env_key"] = json!("gateway_api_key");
        profile.files.insert(
            "settings".into(),
            format::render(FileKind::Toml, &settings).unwrap(),
        );
        let draft = configuration::open(
            &registry,
            profile,
            Scope::Global,
            "codex-native-env-session".into(),
        )
        .unwrap();
        assert!(draft.issues.is_empty());
        let temp = tempfile::tempdir().unwrap();
        let db = crate::database::Database::open(&temp.path().join("test.db")).unwrap();
        let saved =
            crate::native::profile::save_registered_profile(&db, &registry, draft.profile, None)
                .unwrap();
        assert_eq!(
            saved.connection.as_ref().unwrap().auth_env_var.as_deref(),
            Some("gateway_api_key")
        );
        let own = format::parse(FileKind::Toml, &saved.files["settings"]).unwrap();
        assert_eq!(
            own["model_providers"]["gateway"]["env_key"],
            "gateway_api_key"
        );
        let snapshot =
            crate::portable::collect_snapshot(&db, &MemoryCredentials::default(), &registry)
                .unwrap();
        let exported = snapshot
            .entities
            .iter()
            .find_map(|entity| match &entity.payload {
                crate::portable::PortablePayload::Profile(value)
                    if value.profile.id == saved.id =>
                {
                    Some(value)
                }
                _ => None,
            })
            .unwrap();
        let files = format::parse(FileKind::Toml, &exported.profile.files["settings"]).unwrap();
        assert_eq!(
            files["model_providers"]["gateway"]["env_key"],
            "gateway_api_key"
        );
        assert!(exported.connection_secret.is_none());
        assert!(exported.native_secrets.is_empty());
    }
    #[test]
    fn codex_portable_rejects_invalid_reference_in_nonselected_provider() {
        let registry = Registry::with_adapters(vec![&Codex]).unwrap();
        let mut profile = profile();
        let mut settings = format::parse(FileKind::Toml, &profile.files["settings"]).unwrap();
        settings["model_providers"]["untouched"]["env_key"] =
            json!("file:/tmp/fixture-private-key");
        profile.files.insert(
            "settings".into(),
            format::render(FileKind::Toml, &settings).unwrap(),
        );
        let draft = configuration::open(
            &registry,
            profile,
            Scope::Global,
            "codex-reference-session".into(),
        )
        .unwrap();
        let temp = tempfile::tempdir().unwrap();
        let db = crate::database::Database::open(&temp.path().join("test.db")).unwrap();
        let saved =
            crate::native::profile::save_registered_profile(&db, &registry, draft.profile, None)
                .unwrap();
        let snapshot =
            crate::portable::collect_snapshot(&db, &MemoryCredentials::default(), &registry)
                .unwrap();
        let exported = snapshot
            .entities
            .iter()
            .find_map(|entity| match &entity.payload {
                crate::portable::PortablePayload::Profile(value)
                    if value.profile.id == saved.id =>
                {
                    Some(value)
                }
                _ => None,
            })
            .unwrap();
        let files = format::parse(FileKind::Toml, &exported.profile.files["settings"]).unwrap();
        assert!(files["model_providers"]["untouched"]
            .get("env_key")
            .is_none());
        assert_eq!(
            files["model_providers"]["untouched"]["name"],
            "Other provider"
        );
        assert!(exported
            .pending_fields
            .iter()
            .any(|field| field.ends_with("untouched.env_key")));
    }
    #[test]
    fn codex_reserved_migration_keeps_owned_cleanup_and_detaches_foreign_tables() {
        let current = json!({"model_provider":"openai","model_providers":{"openai":{"name":"Legacy","base_url":"https://legacy.example.test/v1","wire_api":"responses"},"other":{"name":"Other"}}});
        let desired = json!({"model_provider":"openai-custom","model_providers":{"openai-custom":{"name":"Legacy","base_url":"https://legacy.example.test/v1","wire_api":"responses"}}});
        let mut profile = profile();
        profile.files.insert(
            "settings".into(),
            format::render(FileKind::Toml, &current).unwrap(),
        );
        assert_eq!(
            Codex
                .unmanaged_paths("settings", &current, &desired, &profile)
                .unwrap(),
            vec!["/model_providers/other"]
        );
        // A separately declared custom provider does not authorize deleting a
        // native reserved table that this configuration never owned.
        profile.files.insert(
            "settings".into(),
            format::render(FileKind::Toml, &desired).unwrap(),
        );
        assert_eq!(
            Codex
                .unmanaged_paths("settings", &current, &desired, &profile)
                .unwrap(),
            vec!["/model_providers/openai", "/model_providers/other"]
        );
        // Switching away from the legacy provider retains its old definition.
        profile.files.insert(
            "settings".into(),
            format::render(FileKind::Toml, &current).unwrap(),
        );
        assert_eq!(
            Codex
                .unmanaged_paths(
                    "settings",
                    &current,
                    &json!({"model_provider":"other"}),
                    &profile
                )
                .unwrap(),
            vec!["/model_providers/openai"]
        );
    }
    #[test]
    fn codex_reserved_migration_remains_atomic_when_owned_source_changes() {
        let registry = Registry::with_adapters(vec![&Codex]).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let db = crate::database::Database::open(&temp.path().join("test.db")).unwrap();
        let credentials = MemoryCredentials::default();
        let source = json!({"model":"gpt-6.1-sol","model_provider":"openai","unrelated":7,"model_providers":{"openai":{"name":"Legacy","base_url":"https://legacy.example.test/v1","wire_api":"responses"}}});
        let mut legacy = profile();
        legacy.files.insert(
            "settings".into(),
            format::render(FileKind::Toml, &source).unwrap(),
        );
        let saved =
            crate::native::profile::save_registered_profile(&db, &registry, legacy, None).unwrap();
        let mut fields = BTreeMap::new();
        crate::native::apply::flatten(&source, &mut vec![], &mut fields);
        let previous = json!({"settings":fields});
        db.with_connection(|conn| {conn.execute("INSERT INTO applied_bindings(scope_key,tool,profile_id,profile_version,managed) VALUES(?1,?2,?3,?4,?5)",rusqlite::params!["global","codex",saved.id,saved.version as i64,previous.to_string()]).map_err(|error|error.to_string())?;Ok(())}).unwrap();
        let path = temp.path().join("isolated-reserved-config.toml");
        let file = crate::native::adapter::NativeFile {
            role: "settings",
            path: path.display().to_string(),
            format: "toml",
            writable: true,
            reason: None,
            sensitive: false,
        };
        let mut external = source.clone();
        external["model_providers"]["openai"]["base_url"] =
            json!("https://external.example.test/v1");
        let baseline = format::render(FileKind::Toml, &external).unwrap();
        std::fs::write(&path, &baseline).unwrap();
        let error = crate::native::apply::apply_registered_validated(
            &registry,
            &db,
            &credentials,
            &saved,
            None,
            std::slice::from_ref(&file),
            "global",
            Scope::Global,
            false,
        )
        .unwrap_err();
        assert!(error.contains("上次管理的字段已被外部修改"));
        assert!(error.contains("/model_providers/openai/base_url"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), baseline);
        // Once the fixture's owned baseline matches, the same operation removes
        // the obsolete table and writes its normalized target in one transaction.
        std::fs::write(&path, format::render(FileKind::Toml, &source).unwrap()).unwrap();
        crate::native::apply::apply_registered_validated(
            &registry,
            &db,
            &credentials,
            &saved,
            None,
            std::slice::from_ref(&file),
            "global",
            Scope::Global,
            false,
        )
        .unwrap();
        let applied =
            format::parse(FileKind::Toml, &std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(applied["model_provider"], "openai-custom");
        assert!(applied["model_providers"].get("openai").is_none());
        assert_eq!(
            applied["model_providers"]["openai-custom"]["base_url"],
            source["model_providers"]["openai"]["base_url"]
        );
        assert_eq!(applied["unrelated"], 7);
    }
    #[test]
    fn codex_omitted_address_opens_saves_and_applies_with_native_environment_reference() {
        let registry = Registry::with_adapters(vec![&Codex]).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let db = crate::database::Database::open(&temp.path().join("test.db")).unwrap();
        let draft = configuration::open(
            &registry,
            default_address_profile(),
            Scope::Global,
            "omitted-address".into(),
        )
        .unwrap();
        assert!(draft.issues.is_empty());
        assert!(draft.view["values"].get("base_url").is_none());
        let connection = draft.profile.connection.as_ref().unwrap();
        assert_eq!(connection.base_url, DEFAULT_API_BASE_URL);
        assert_eq!(
            connection.auth_env_var.as_deref(),
            Some("CLIORA_TEST_CODEX_KEY")
        );
        assert!(connection.secret_ref.is_none());
        let saved =
            crate::native::profile::save_registered_profile(&db, &registry, draft.profile, None)
                .unwrap();
        let own = format::parse(FileKind::Toml, &saved.files["settings"]).unwrap();
        assert!(own["model_providers"]["native_default"]
            .get("base_url")
            .is_none());
        let path = temp.path().join("isolated-config.toml");
        let file = native_fixture_file(&path);
        let unrelated = json!({"model_providers":{"foreign":{"name":"Foreign","experimental_bearer_token":"fixture-only-unrelated-key"}},"unrelated":true});
        std::fs::write(&path, format::render(FileKind::Toml, &unrelated).unwrap()).unwrap();
        crate::native::apply::apply_registered_validated(
            &registry,
            &db,
            &MemoryCredentials::default(),
            &saved,
            None,
            std::slice::from_ref(&file),
            "global",
            Scope::Global,
            false,
        )
        .unwrap();
        let applied =
            format::parse(FileKind::Toml, &std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(applied["model_provider"], "native_default");
        assert!(applied["model_providers"]["native_default"]
            .get("base_url")
            .is_none());
        assert_eq!(
            applied["model_providers"]["native_default"]["env_key"],
            "CLIORA_TEST_CODEX_KEY"
        );
        assert_eq!(
            applied["model_providers"]["foreign"],
            unrelated["model_providers"]["foreign"]
        );
        let projected = Codex
            .connection(
                &BTreeMap::from([("settings".into(), applied)]),
                saved.editing.as_ref().unwrap(),
            )
            .unwrap()
            .unwrap();
        assert_eq!(projected.base_url, DEFAULT_API_BASE_URL);
        assert_eq!(
            projected.auth_env_var,
            saved.connection.unwrap().auth_env_var
        );
    }
    #[test]
    fn codex_address_reset_keeps_same_identity_secret_reference_without_writing_default_override() {
        use crate::credentials::CredentialStore;
        let registry = Registry::with_adapters(vec![&Codex]).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let db = crate::database::Database::open(&temp.path().join("test.db")).unwrap();
        let credentials = MemoryCredentials::default();
        let secret_id = "connection-00000000-0000-4000-8000-000000000020";
        credentials
            .put(secret_id, "fixture-only-managed-key")
            .unwrap();
        let mut profile = default_address_profile();
        let mut settings = format::parse(FileKind::Toml, &profile.files["settings"]).unwrap();
        settings["model_providers"]["native_default"]["base_url"] = json!(DEFAULT_API_BASE_URL);
        settings["model_providers"]["native_default"]
            .as_object_mut()
            .unwrap()
            .remove("env_key");
        profile.files.insert(
            "settings".into(),
            format::render(FileKind::Toml, &settings).unwrap(),
        );
        profile.editing = Some(EditingState::default());
        profile.authentication = crate::native::profile::ProfileAuthentication::ApiKey;
        profile.connection = Codex
            .connection(
                &BTreeMap::from([("settings".into(), settings)]),
                profile.editing.as_ref().unwrap(),
            )
            .unwrap();
        profile.connection.as_mut().unwrap().secret_ref = Some(secret_id.into());
        let draft =
            configuration::open(&registry, profile, Scope::Global, "explicit-address".into())
                .unwrap();
        let first =
            crate::native::profile::save_registered_profile(&db, &registry, draft.profile, None)
                .unwrap();
        let path = temp.path().join("isolated-config.toml");
        let file = native_fixture_file(&path);
        crate::native::apply::apply_registered_validated(
            &registry,
            &db,
            &credentials,
            &first,
            None,
            std::slice::from_ref(&file),
            "global",
            Scope::Global,
            false,
        )
        .unwrap();
        let draft = configuration::open(
            &registry,
            first.clone(),
            Scope::Global,
            "reset-address".into(),
        )
        .unwrap();
        let mut reset = action("reset", "base_url", Value::Null);
        reset.target = json!("native_default");
        let draft = configuration::edit(&registry, draft, reset).unwrap();
        assert!(draft.issues.is_empty());
        assert!(draft.view["values"].get("base_url").is_none());
        let projected = draft.profile.connection.as_ref().unwrap();
        assert_eq!(projected.base_url, DEFAULT_API_BASE_URL);
        assert_eq!(projected.secret_ref.as_deref(), Some(secret_id));
        assert!(projected.auth_env_var.is_none());
        let saved = crate::native::profile::save_registered_profile(
            &db,
            &registry,
            draft.profile,
            Some(first.version),
        )
        .unwrap();
        assert_eq!(
            saved.connection.as_ref().unwrap().secret_ref.as_deref(),
            Some(secret_id)
        );
        assert!(
            format::parse(FileKind::Toml, &saved.files["settings"]).unwrap()["model_providers"]
                ["native_default"]
                .get("base_url")
                .is_none()
        );
        crate::native::apply::apply_registered_validated(
            &registry,
            &db,
            &credentials,
            &saved,
            None,
            std::slice::from_ref(&file),
            "global",
            Scope::Global,
            false,
        )
        .unwrap();
        let applied =
            format::parse(FileKind::Toml, &std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(applied["model_providers"]["native_default"]
            .get("base_url")
            .is_none());
        assert_eq!(
            applied["model_providers"]["native_default"]["experimental_bearer_token"],
            "fixture-only-managed-key"
        );
        assert!(applied["model_providers"]["native_default"]
            .get("env_key")
            .is_none());
        assert_eq!(
            credentials.get(secret_id).unwrap(),
            "fixture-only-managed-key"
        );
    }
    #[test]
    fn codex_explicit_invalid_address_is_not_confused_with_absence() {
        let mut settings =
            format::parse(FileKind::Toml, &default_address_profile().files["settings"]).unwrap();
        for invalid in [
            Value::Null,
            json!(7),
            json!(false),
            json!(""),
            json!("not a url"),
            json!("ftp://example.test"),
        ] {
            settings["model_providers"]["native_default"]["base_url"] = invalid;
            assert!(Codex
                .validate(
                    &BTreeMap::from([("settings".into(), settings.clone())]),
                    &EditingState::default(),
                    Scope::Global
                )
                .iter()
                .any(|issue| issue.field.as_deref() == Some("base_url")));
        }
        let registry = Registry::with_adapters(vec![&Codex]).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let db = crate::database::Database::open(&temp.path().join("test.db")).unwrap();
        settings["model_providers"]["native_default"]["base_url"] = json!("not a url");
        let mut profile = default_address_profile();
        profile.files.insert(
            "settings".into(),
            format::render(FileKind::Toml, &settings).unwrap(),
        );
        let draft =
            configuration::open(&registry, profile, Scope::Global, "invalid-address".into())
                .unwrap();
        assert!(draft
            .issues
            .iter()
            .any(|issue| issue.field.as_deref() == Some("base_url")));
        assert!(crate::native::profile::save_registered_profile(
            &db,
            &registry,
            draft.profile,
            None
        )
        .is_err());
        let valid = configuration::open(
            &registry,
            default_address_profile(),
            Scope::Global,
            "valid-address-baseline".into(),
        )
        .unwrap();
        let mut invalid_snapshot =
            crate::native::profile::save_registered_profile(&db, &registry, valid.profile, None)
                .unwrap();
        invalid_snapshot.files.insert(
            "settings".into(),
            format::render(FileKind::Toml, &settings).unwrap(),
        );
        let path = temp.path().join("isolated-invalid-address.toml");
        let baseline = "unrelated = true\n";
        std::fs::write(&path, baseline).unwrap();
        let error = crate::native::apply::apply_registered_validated(
            &registry,
            &db,
            &MemoryCredentials::default(),
            &invalid_snapshot,
            None,
            &[native_fixture_file(&path)],
            "global",
            Scope::Global,
            false,
        )
        .unwrap_err();
        assert!(error.contains("base_url"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), baseline);
    }
    #[test]
    fn codex_native_auth_default_address_remains_legal_without_guessing_connection() {
        let registry = Registry::with_adapters(vec![&Codex]).unwrap();
        let mut profile = default_address_profile();
        let mut settings = format::parse(FileKind::Toml, &profile.files["settings"]).unwrap();
        settings["model_providers"]["native_default"]["requires_openai_auth"] = json!(true);
        settings["model_providers"]["native_default"]
            .as_object_mut()
            .unwrap()
            .remove("env_key");
        profile.files.insert(
            "settings".into(),
            format::render(FileKind::Toml, &settings).unwrap(),
        );
        let draft = configuration::open(
            &registry,
            profile,
            Scope::Global,
            "native-auth-default".into(),
        )
        .unwrap();
        assert!(draft.issues.is_empty());
        assert!(draft.profile.connection.is_none());
        assert!(draft.view["defaultAddressReason"]
            .as_str()
            .unwrap()
            .contains("原生登录"));
        let temp = tempfile::tempdir().unwrap();
        let db = crate::database::Database::open(&temp.path().join("test.db")).unwrap();
        let saved =
            crate::native::profile::save_registered_profile(&db, &registry, draft.profile, None)
                .unwrap();
        let path = temp.path().join("isolated-config.toml");
        crate::native::apply::apply_registered_validated(
            &registry,
            &db,
            &MemoryCredentials::default(),
            &saved,
            None,
            &[native_fixture_file(&path)],
            "global",
            Scope::Global,
            false,
        )
        .unwrap();
        let applied =
            format::parse(FileKind::Toml, &std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(applied["model_providers"]["native_default"]
            .get("base_url")
            .is_none());
        assert_eq!(
            applied["model_providers"]["native_default"]["requires_openai_auth"],
            true
        );
    }
}
fn root(documents: &Documents) -> Value {
    documents
        .get("settings")
        .cloned()
        .unwrap_or_else(|| json!({}))
}
fn path(_root: &Value, action: &ConfigurationAction) -> Result<Vec<String>, String> {
    let field = action.field.as_deref().ok_or("缺少 Codex 字段")?;
    if PARAMETERS.contains(&field) {
        if action.target != json!("configuration") {
            return Err("Codex 参数是配置级设置".into());
        }
        return Ok(vec![field.into()]);
    }
    if field == "base_url" {
        let provider = action
            .target
            .as_str()
            .filter(|id| !id.trim().is_empty() && *id != "configuration")
            .ok_or("缺少供应商身份")?;
        if ["openai", "ollama", "lmstudio"].contains(&provider) {
            return Err("内置供应商地址由 Codex 管理；自定义地址请使用独立供应商 ID".into());
        }
        return Ok(vec![
            "model_providers".into(),
            provider.into(),
            "base_url".into(),
        ]);
    }
    Err("不支持的 Codex 配置字段".into())
}
fn pointer(path: &[String]) -> String {
    format!(
        "/{}",
        path.iter()
            .map(|part| crate::adapters::pointer_token(part))
            .collect::<Vec<_>>()
            .join("/")
    )
}
fn remove(root: &mut Value, path: &[String]) {
    if let Some((last, parents)) = path.split_last() {
        let mut target = root;
        for part in parents {
            let Some(next) = target.get_mut(part) else {
                return;
            };
            target = next;
        }
        if let Some(map) = target.as_object_mut() {
            map.remove(last);
        }
    }
}
fn field(
    id: &str,
    label: &str,
    kind: &str,
    choices: &[&str],
    advanced: bool,
) -> ConfigurationField {
    ConfigurationField {
        id: id.into(),
        label: label.into(),
        kind: kind.into(),
        required: false,
        advanced,
        choices: choices.iter().map(|value| (*value).into()).collect(),
        minimum: (kind == "integer").then_some(1.0),
        default_source: Some("跟随 Codex 原生默认或继承值".into()),
        unavailable_reason: None,
    }
}

impl ConfigurationAdapter for Codex {
    fn credential_paths(&self,connection:&Connection)->Vec<(&'static str,Vec<String>)>{
        ["experimental_bearer_token","env_key"].iter().map(|field|("settings",vec!["model_providers".into(),connection.provider_id.clone(),(*field).into()])).collect()
    }

    fn native_verification_module(&self) -> Option<&'static str> { Some("src-tauri/src/adapters/codex/native_verification.mjs") }
    fn catalog_support(&self) -> CatalogSupport { CatalogSupport { available: true, multiple: false, reason: None } }
    fn common_parameters(&self, scope: Scope) -> Vec<CommonParameter> {
        self.describe(scope).fields.into_iter().filter(|field| ["model_reasoning_effort", "model_context_window", "model_reasoning_summary", "model_verbosity"].contains(&field.id.as_str()))
            .map(|field| CommonParameter { path: field.id.split('.').map(str::to_owned).collect(), field, role: "settings", target: json!("configuration") }).collect()
    }
    fn common_forbidden_paths(&self) -> Vec<(&'static str, &'static str)> { vec![("settings","/model"), ("settings","/model_provider")] }
    fn draft_connection(&self, documents: &Documents, state: &EditingState) -> Result<Option<Connection>, String> {
        let mut documents = documents.clone(); let settings = documents.entry("settings".into()).or_insert_with(|| json!({}));
        let missing = settings.get("model").is_none(); if missing { settings["model"] = json!("__cliora_draft__"); }
        let mut connection = self.connection(&documents, state)?; if missing { if let Some(connection) = &mut connection { connection.model.clear(); } }
        Ok(connection)
    }
    fn catalog_actions(&self, _documents: &Documents, _state: &EditingState, ids: &[String]) -> Result<Vec<ConfigurationAction>, String> {
        if ids.len() != 1 { return Err("Codex 使用配置级单个模型，请选择一个模型".into()) }
        Ok(vec![ConfigurationAction { version: EDITING_VERSION, target: json!("configuration"), operation: "set".into(), field: Some("model".into()), value: Some(json!(ids[0])) }])
    }

    fn portable_reference_valid(&self, path: &[String], value: &Value) -> bool {
        matches!(path,[role,providers,id,field] if role=="settings" && providers=="model_providers" && !id.is_empty() && field=="env_key")
            && valid_environment_reference(value)
    }
    fn unmanaged_paths(
        &self,
        role: &str,
        current: &Value,
        desired: &Value,
        profile: &RegisteredProfile,
    ) -> Result<Vec<String>, String> {
        if role != "settings" {
            return Ok(vec![]);
        }
        let selected = desired["model_provider"].as_str().unwrap_or("openai");
        let source = profile
            .files
            .get("settings")
            .map(|text| crate::native::format::parse(crate::native::format::FileKind::Toml, text))
            .transpose()?
            .unwrap_or_else(|| json!({}));
        Ok(current["model_providers"]
            .as_object()
            .into_iter()
            .flat_map(|providers| providers.keys())
            .filter(|id| {
                // A declared reserved table is normalized to this same selected
                // provider, rather than being an unrelated provider switch.
                // Keep its old owned paths in the shared CAS cleanup; foreign
                // tables remain detached and their native values stay intact.
                let migrated = RESERVED_MODEL_PROVIDERS.contains(&id.as_str())
                    && model_provider_id(id) == selected
                    && source["model_providers"].get(*id).is_some();
                id.as_str() != selected && !migrated
            })
            .map(|id| pointer(&["model_providers".into(), id.clone()]))
            .collect())
    }
    fn portable_field_kind(&self, path: &[String]) -> PortableFieldKind {
        match path.last().map(String::as_str) {
            Some("env_key") => PortableFieldKind::CredentialReference,
            Some("experimental_bearer_token" | "api_key") => PortableFieldKind::Credential,
            Some(value)
                if PARAMETERS.contains(&value)
                    || matches!(value, "base_url" | "wire_api" | "name") =>
            {
                PortableFieldKind::Parameter
            }
            _ => PortableFieldKind::Unknown,
        }
    }
    fn suppression_changes(
        &self,
        action: &ConfigurationAction,
    ) -> Result<Vec<SuppressionChange>, String> {
        let native = if action.field.as_deref() == Some("base_url") {
            path(&json!({}), action)?
        } else {
            let Some(field) = action
                .field
                .as_deref()
                .filter(|field| PARAMETERS.contains(field))
            else {
                return Ok(vec![]);
            };
            vec![field.into()]
        };
        Ok(vec![SuppressionChange {
            role: "settings".into(),
            path: pointer(&native),
            suppressed: false,
        }])
    }
    fn reconcile_text(
        &self,
        _: Option<&Documents>,
        next: &Documents,
        _: &Documents,
        state: &mut EditingState,
    ) -> Result<(), String> {
        let root = root(next);
        state.intents.retain(|action| {
            action.operation == "reset"
                && path(&root, action)
                    .ok()
                    .is_some_and(|path| root.pointer(&pointer(&path)).is_none())
        });
        state.selected_provider = root["model_provider"].as_str().map(str::to_owned);
        Ok(())
    }
    fn describe(&self, scope: Scope) -> ConfigurationDescriptor {
        let mut fields = vec![
            field("model", "当前模型", "string", &[], false),
            field("model_provider", "供应商 ID", "string", &[], false),
            field("base_url", "Responses 地址", "string", &[], false),
            field(
                "model_reasoning_effort",
                "推理强度（Codex 原生）",
                "string",
                &[],
                true,
            ),
            field(
                "model_context_window",
                "上下文窗口（Token）",
                "integer",
                &[],
                true,
            ),
            field(
                "model_reasoning_summary",
                "推理摘要",
                "string",
                &["auto", "concise", "detailed", "none"],
                true,
            ),
            field(
                "model_verbosity",
                "回答详细程度",
                "string",
                &["low", "medium", "high"],
                true,
            ),
        ];
        if scope == Scope::Project {
            for field in fields
                .iter_mut()
                .filter(|field| matches!(field.id.as_str(), "model_provider" | "base_url"))
            {
                field.unavailable_reason = Some("Codex 供应商连接仅在全局配置编辑".into());
            }
        }
        ConfigurationDescriptor {
            version: EDITING_VERSION,
            fields,
            operations: vec!["set".into(), "reset".into()],
        }
    }
    fn read(&self, documents: &Documents, _: &EditingState) -> Result<Value, String> {
        let settings = root(documents);
        if !settings.is_object() {
            return Err("Codex 配置须为对象".into());
        }
        let mut values = BTreeMap::new();
        for key in PARAMETERS {
            if let Some(value) = settings.get(*key) {
                values.insert((*key).to_owned(), value.clone());
            }
        }
        let provider = settings["model_provider"].as_str().unwrap_or("openai");
        if let Some(base) = settings["model_providers"][provider].get("base_url") {
            values.insert("base_url".into(), base.clone());
        }
        let choices = capabilities(settings["model"].as_str().unwrap_or(""));
        let definition = &settings["model_providers"][provider];
        let default_address_reason =
            if definition.is_object() && definition.get("base_url").is_none() {
                Some(if effective_api_base(provider, definition).is_some() {
                    "未设置地址：跟随 Codex 原生 API 默认地址。"
                } else {
                    "未设置地址：由 Codex 原生登录或特殊认证决定，有效连接尚未核验。"
                })
            } else {
                None
            };
        Ok(
            json!({"values":values,"defaultAddressReason":default_address_reason,"effortChoices":choices,"capabilitySource":if choices.is_empty() {"未核验模型能力；允许手动原生值"} else {"Codex 公开原生模型目录（2026-10-05）"}}),
        )
    }
    fn edit(
        &self,
        documents: &mut Documents,
        state: &mut EditingState,
        action: &ConfigurationAction,
    ) -> Result<(), String> {
        let settings = documents
            .entry("settings".into())
            .or_insert_with(|| json!({}));
        if !settings.is_object() {
            return Err("Codex 配置须为对象".into());
        }
        if action.field.as_deref() == Some("base_url")
            && (settings
                .get("model_providers")
                .is_some_and(|providers| !providers.is_object())
                || settings["model_providers"]
                    .get(action.target.as_str().unwrap_or(""))
                    .is_some_and(|provider| !provider.is_object()))
        {
            return Err("供应商定义须为原生 TOML 表；请先修正原文".into());
        }
        let path = path(settings, action)?;
        if action.operation == "set"
            && action.field.as_deref() == Some("base_url")
            && settings["model_provider"] != action.target
        {
            return Err("供应商身份已变化，请重新编辑地址".into());
        }
        match action.operation.as_str() {
            "reset" => remove(settings, &path),
            "set" => {
                let value = action.value.clone().ok_or("缺少字段值")?;
                if value.is_null() {
                    return Err("恢复默认请使用 reset".into());
                }
                crate::native::apply::set_json(
                    settings,
                    &path.iter().map(String::as_str).collect::<Vec<_>>(),
                    value,
                );
                if action.field.as_deref() == Some("base_url") {
                    let provider = settings["model_provider"]
                        .as_str()
                        .ok_or("缺少供应商")?
                        .to_owned();
                    // Responses is the only supported Codex wire protocol.
                    crate::native::apply::set_json(
                        settings,
                        &["model_providers", &provider, "wire_api"],
                        json!("responses"),
                    );
                    if settings["model_providers"][&provider].get("name").is_none() {
                        crate::native::apply::set_json(
                            settings,
                            &["model_providers", &provider, "name"],
                            json!(provider),
                        );
                    }
                }
            }
            _ => return Err("不支持的 Codex 编辑操作".into()),
        }
        state.selected_provider = settings["model_provider"].as_str().map(str::to_owned);
        Ok(())
    }
    fn validate(
        &self,
        documents: &Documents,
        _: &EditingState,
        _: Scope,
    ) -> Vec<ConfigurationIssue> {
        let settings = root(documents);
        if !settings.is_object() {
            return vec![ConfigurationIssue {
                target: json!("configuration"),
                field: None,
                code: "invalid_document".into(),
                message: "Codex 配置须为对象".into(),
            }];
        }
        let mut issues = vec![];
        let mut issue = |field: &str, message: &str| {
            issues.push(ConfigurationIssue {
                target: json!("configuration"),
                field: Some(field.into()),
                code: "invalid_value".into(),
                message: message.into(),
            })
        };
        for key in PARAMETERS {
            let Some(value) = settings.get(*key) else {
                continue;
            };
            if *key == "model_context_window" {
                if !value.as_i64().is_some_and(|value| value > 0) {
                    issue(key, "上下文窗口须为正整数");
                }
            } else if !value
                .as_str()
                .is_some_and(|text| !text.trim().is_empty() && !text.chars().any(char::is_control))
            {
                issue(key, "请输入非空原生字符串值");
            }
        }
        let choices = capabilities(settings["model"].as_str().unwrap_or(""));
        if let Some(effort) = settings["model_reasoning_effort"].as_str() {
            if !choices.is_empty()
                && [
                    "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
                ]
                .contains(&effort)
                && !choices.iter().any(|choice| choice == effort)
            {
                issue(
                    "model_reasoning_effort",
                    "当前模型的原生目录不支持此推理档位",
                );
            }
        }
        for (key, allowed) in [
            (
                "model_reasoning_summary",
                &["auto", "concise", "detailed", "none"][..],
            ),
            ("model_verbosity", &["low", "medium", "high"][..]),
        ] {
            if settings
                .get(key)
                .is_some_and(|value| !value.as_str().is_some_and(|value| allowed.contains(&value)))
            {
                issue(key, "此值不符合 Codex 原生配置 schema");
            }
        }
        if let Some(provider) = settings["model_provider"]
            .as_str()
            .filter(|id| !["openai", "ollama", "lmstudio"].contains(id))
        {
            let definition = &settings["model_providers"][provider];
            if !definition.is_object() {
                issue("model_provider", "自定义供应商没有原生定义");
            }
            if definition.get("base_url").is_some_and(|value| {
                !value.as_str().is_some_and(|base| {
                    url::Url::parse(base).is_ok_and(|url| {
                        matches!(url.scheme(), "http" | "https") && url.host_str().is_some()
                    })
                })
            }) {
                issue("base_url", "请输入有效 HTTP 或 HTTPS 供应商地址");
            }
            if definition
                .get("wire_api")
                .is_some_and(|value| value != "responses")
            {
                issue("base_url", "Codex 仅支持 Responses 接口");
            }
            if definition
                .get("env_key")
                .is_some_and(|value| !valid_environment_reference(value))
            {
                issue(
                    "model_provider",
                    "供应商 env_key 须为合法环境变量名称，不能使用字面密钥、路径或命令",
                );
            }
        }
        issues
    }
    fn connection(
        &self,
        documents: &Documents,
        _: &EditingState,
    ) -> Result<Option<Connection>, String> {
        let settings = root(documents);
        let provider = settings["model_provider"].as_str().unwrap_or("openai");
        let definition = &settings["model_providers"][provider];
        Ok(
            match (
                effective_api_base(provider, definition),
                settings["model"].as_str(),
            ) {
                (Some(base), Some(model)) => Some(Connection {
                    provider_id: provider.into(),
                    interface_format: "openai_responses".into(),
                    base_url: base.into(),
                    model: model.into(),
                    secret_ref: None,
                    auth_env_var: definition["env_key"].as_str().map(str::to_owned),
                    model_records: vec![],
                }),
                _ => None,
            },
        )
    }
    fn managed_documents(
        &self,
        mut documents: Documents,
        _: &RegisteredProfile,
        _: Scope,
    ) -> Result<Documents, String> {
        if let Some(settings) = documents.get_mut("settings") {
            let selected = settings["model_provider"]
                .as_str()
                .unwrap_or("openai")
                .to_owned();
            if let Some(providers) = settings
                .get_mut("model_providers")
                .and_then(Value::as_object_mut)
            {
                providers.retain(|id, _| id == &selected);
            }
            if settings["model_providers"]
                .as_object()
                .is_some_and(|providers| providers.is_empty())
            {
                settings.as_object_mut().unwrap().remove("model_providers");
            }
        }
        Ok(documents)
    }
    fn managed_fields(
        &self,
        role: &str,
        _: &Value,
        desired: &Value,
        profile: &RegisteredProfile,
    ) -> Result<ManagedConfiguration, String> {
        let mut fields = BTreeMap::new();
        crate::native::apply::flatten(desired, &mut vec![], &mut fields);
        let mut managed = ManagedConfiguration {
            fields: fields
                .into_iter()
                .map(|(path, value)| (path, Some(value)))
                .collect(),
            released: vec![],
        };
        if role == "settings" {
            if let Some(state) = &profile.editing {
                for action in &state.intents {
                    if action.operation == "reset" {
                        if let Ok(path) = path(desired, action) {
                            managed.released.push(pointer(&path));
                        }
                    }
                }
            }
        }
        Ok(managed)
    }
}
