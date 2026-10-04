use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::{json, Value};

use super::{
    format::{self},
    profile::{self, Connection, ModelRecord},
};
use crate::credentials::CredentialStore;
use crate::domain::CliId;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeInspection {
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub connection: Option<Connection>,
    pub reasoning_effort: Option<String>,
    pub projected_models: Option<Vec<ModelRecord>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeImport {
    pub files: BTreeMap<String, String>,
    pub inspection: NativeInspection,
    pub migrated_secret: bool,
    pub native_credentials: BTreeMap<String, BTreeMap<String, String>>,
}

/// Import is explicit: literal native keys move to the OS credential store before
/// any file text is returned as a savable draft. The original file is untouched.
pub fn prepare_import(
    tool: CliId,
    files: BTreeMap<String, String>,
    credentials: &dyn CredentialStore,
) -> Result<NativeImport, String> {
    prepare_registered_import(
        &crate::adapters::Registry::builtins(),
        tool.stable_id(),
        files,
        credentials,
    )
}

pub fn prepare_registered_import(
    registry: &crate::adapters::Registry,
    id: &str,
    mut files: BTreeMap<String, String>,
    credentials: &dyn CredentialStore,
) -> Result<NativeImport, String> {
    let adapter = registry
        .get(id)
        .ok_or("未注册的 CLI 适配器，不能接入原生配置")?;
    let mut found = inspect_registered(registry, id, &files)?;
    let mut pending_secrets: Vec<(String, String)> = Vec::new();
    let mut native_credentials: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    adapter.import_literal_secrets(
        &mut files,
        &mut found,
        &mut pending_secrets,
        &mut native_credentials,
    )?;
    profile::validate_registered_files(registry, id, &files)
        .map_err(|error| format!("原生配置不能安全接入：{error}；原文件未更改"))?;
    if let Some(connection) = &found.connection {
        profile::validate_connection(connection)
            .map_err(|error| format!("原生连接不能安全接入：{error}；原文件未更改"))?;
    }
    for (index, (id, secret)) in pending_secrets.iter().enumerate() {
        if credentials.put(id, secret).is_err() {
            let mut rollback_failed = false;
            for (previous, _) in pending_secrets[..index].iter().rev() {
                rollback_failed |= credentials.delete(previous).is_err();
            }
            return Err(if rollback_failed {
                "系统凭据库保存失败，且部分新凭据无法清理；原文件未更改，请检查系统凭据服务".into()
            } else {
                "系统凭据库保存失败；已清理本次新凭据，原文件未更改".into()
            });
        }
    }
    // Re-inspect the sanitized text. The returned draft never includes the key.
    let imported_auth = found.connection.as_ref().map(|connection| {
        (
            connection.secret_ref.clone(),
            connection.auth_env_var.clone(),
        )
    });
    found = inspect_registered(registry, id, &files)?;
    if let (Some(connection), Some((secret_ref, auth_env_var))) =
        (found.connection.as_mut(), imported_auth)
    {
        connection.secret_ref = secret_ref;
        if auth_env_var.is_some() {
            connection.auth_env_var = auth_env_var;
        }
    }
    Ok(NativeImport {
        files,
        inspection: found,
        migrated_secret: !pending_secrets.is_empty(),
        native_credentials,
    })
}

pub(crate) fn pi_env_name(value: &str) -> Option<&str> {
    let name = value.strip_prefix('$')?;
    let name = name
        .strip_prefix('{')
        .and_then(|tail| tail.strip_suffix('}'))
        .unwrap_or(name);
    profile::valid_env_name(name).then_some(name)
}

pub(crate) fn string_at<'a>(root: &'a Value, path: &[&str]) -> Option<&'a str> {
    path.iter()
        .try_fold(root, |value, segment| value.get(*segment))?
        .as_str()
}

pub(crate) fn api_format(value: &str) -> Option<&'static str> {
    match value {
        "responses" | "openai-responses" | "@ai-sdk/openai" => Some("openai_responses"),
        "chat_completions" | "openai-completions" | "@ai-sdk/openai-compatible" => {
            Some("openai_completions")
        }
        "messages" | "anthropic-messages" | "@ai-sdk/anthropic" => Some("anthropic_messages"),
        _ => None,
    }
}

pub fn inspect(tool: CliId, files: &BTreeMap<String, String>) -> Result<NativeInspection, String> {
    inspect_registered(
        &crate::adapters::Registry::builtins(),
        tool.stable_id(),
        files,
    )
}

pub fn inspect_registered(
    registry: &crate::adapters::Registry,
    id: &str,
    files: &BTreeMap<String, String>,
) -> Result<NativeInspection, String> {
    let adapter = registry
        .get(id)
        .ok_or("未注册的 CLI 适配器，不能解析原生配置")?;
    let settings = format::parse(
        adapter.file_kind("settings")?,
        files.get("settings").map(String::as_str).unwrap_or(""),
    )?;
    let local_settings = if let Ok(kind) = adapter.file_kind("local_settings") {
        format::parse(
            kind,
            files
                .get("local_settings")
                .map(String::as_str)
                .unwrap_or(""),
        )?
    } else {
        json!({})
    };
    let models = if let Ok(kind) = adapter.file_kind("models") {
        format::parse(kind, files.get("models").map(String::as_str).unwrap_or(""))?
    } else {
        json!({})
    };
    let fields = adapter.inspect_values(&settings, &local_settings, &models);
    let provider = fields.provider;
    let model = fields.model;
    let base = fields.base;
    let wire = fields.wire;
    let env = fields.env;
    let reasoning_effort = fields.reasoning_effort;
    let projected_models = adapter.projected_models(&settings, &models, provider.as_deref());
    let connection = match (&provider, &model, &base, wire) {
        (Some(provider_id), Some(model), Some(base_url), Some(interface_format))
            if !provider_id.is_empty() && !model.is_empty() && !base_url.is_empty() =>
        {
            Some(Connection {
                provider_id: provider_id.clone(),
                interface_format: interface_format.into(),
                base_url: base_url.clone(),
                model: model.clone(),
                secret_ref: None,
                auth_env_var: env,
                model_records: Vec::new(),
            })
        }
        _ => None,
    };
    Ok(NativeInspection {
        provider_id: provider,
        model,
        connection,
        reasoning_effort,
        projected_models,
    })
}

pub fn set_codex_reasoning_effort(text:&str,effort:Option<&str>)->Result<String,String> { crate::adapters::codex::settings::set_codex_reasoning_effort(text,effort) }

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    struct MemoryStore(Mutex<BTreeMap<String, String>>);
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
                .ok_or("missing".into())
        }
        fn delete(&self, id: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(id);
            Ok(())
        }
    }

    struct FailSecondStore {
        values: Mutex<BTreeMap<String, String>>,
        writes: AtomicUsize,
    }
    impl CredentialStore for FailSecondStore {
        fn put(&self, id: &str, secret: &str) -> Result<(), String> {
            if self.writes.fetch_add(1, Ordering::SeqCst) == 1 {
                return Err("simulated keyring outage".into());
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
                .ok_or("missing".into())
        }
        fn delete(&self, id: &str) -> Result<(), String> {
            self.values.lock().unwrap().remove(id);
            Ok(())
        }
    }

    #[test]
    fn claude_default_only_key_import_preserves_default_model_and_url() {
        let source = include_str!("../../../tests/fixtures/native/claude-key-only-settings.json");
        let files = BTreeMap::from([("settings".into(), source.into())]);
        let original = files.clone();
        let store = MemoryStore(Mutex::new(BTreeMap::new()));
        let imported = prepare_import(CliId::ClaudeCode, files, &store).unwrap();
        assert_eq!(
            imported
                .inspection
                .connection
                .as_ref()
                .map(|value| value.model.as_str()),
            None
        );
        assert!(imported.migrated_secret);
        assert_eq!(original["settings"], source);
        assert!(!serde_json::to_string(&imported)
            .unwrap()
            .contains("test-only-global-secret"));
        let id = imported.native_credentials["settings"]["ANTHROPIC_API_KEY"].clone();
        assert_eq!(store.get(&id).unwrap(), "test-only-global-secret");
        let temp = tempfile::tempdir().unwrap();
        let db = crate::database::Database::open(&temp.path().join("app.db")).unwrap();
        let saved = profile::save_profile(
            &db,
            profile::NativeProfile {
                revision: String::new(),
                id: String::new(),
                tool: CliId::ClaudeCode,
                name: "默认配置".into(),
                version: 0,
                inherit_common: false,
                files: imported.files,
                suppressed: BTreeMap::new(),
                connection: imported.inspection.connection,
                authentication: crate::native::profile::ProfileAuthentication::Native,
                native_credentials: imported.native_credentials,
            },
            None,
        )
        .unwrap();
        let reread = profile::get_profile(&db, &saved.id).unwrap();
        assert_eq!(
            reread.native_credentials["settings"]["ANTHROPIC_API_KEY"],
            id
        );
        let documents = super::super::apply::desired_documents(
            &reread,
            None,
            super::super::adapter::Scope::Global,
        )
        .unwrap();
        assert!(documents["settings"].get("model").is_none());
        assert!(documents["settings"]["env"]
            .get("ANTHROPIC_BASE_URL")
            .is_none());
        assert!(documents["settings"]["env"]
            .get("ANTHROPIC_API_KEY")
            .is_none());
        assert_eq!(
            documents["settings"]["permissions"]["defaultMode"],
            "default"
        );
    }

    #[test]
    fn claude_project_local_key_is_scanned_and_import_failure_rolls_back_all_new_keys() {
        let project = include_str!("../../../tests/fixtures/native/claude-key-only-settings.json");
        let local = include_str!("../../../tests/fixtures/native/claude-key-only-local.json");
        let files = BTreeMap::from([
            ("settings".into(), project.into()),
            ("local_settings".into(), local.into()),
        ]);
        let original = files.clone();
        let store = MemoryStore(Mutex::new(BTreeMap::new()));
        let imported = prepare_import(CliId::ClaudeCode, files.clone(), &store).unwrap();
        assert!(imported.inspection.connection.is_none());
        assert_eq!(imported.native_credentials.len(), 2);
        assert!(!serde_json::to_string(&imported)
            .unwrap()
            .contains("test-only-project-secret"));
        assert_eq!(
            store
                .get(&imported.native_credentials["local_settings"]["ANTHROPIC_API_KEY"])
                .unwrap(),
            "test-only-project-secret"
        );
        assert_eq!(original, files);

        let local_only = BTreeMap::from([("local_settings".into(), local.into())]);
        let local_import = prepare_import(CliId::ClaudeCode, local_only.clone(), &store).unwrap();
        assert!(local_import.inspection.connection.is_none());
        assert!(local_import
            .native_credentials
            .contains_key("local_settings"));
        assert!(!local_import.native_credentials.contains_key("settings"));
        assert_eq!(local_only["local_settings"], local);
        let temp_raw = tempfile::tempdir().unwrap();
        let raw_db = crate::database::Database::open(&temp_raw.path().join("app.db")).unwrap();
        assert!(profile::save_profile(
            &raw_db,
            profile::NativeProfile {
                revision: String::new(),
                id: String::new(),
                tool: CliId::ClaudeCode,
                name: "raw".into(),
                version: 0,
                inherit_common: false,
                files: local_only,
                suppressed: BTreeMap::new(),
                connection: None,
                authentication: crate::native::profile::ProfileAuthentication::Native,
                native_credentials: BTreeMap::new(),
            },
            None
        )
        .is_err());
        let profile = profile::NativeProfile {
            revision: String::new(),
            id: String::new(),
            tool: CliId::ClaudeCode,
            name: "项目".into(),
            version: 0,
            inherit_common: false,
            files: imported.files,
            suppressed: BTreeMap::new(),
            connection: None,
            authentication: crate::native::profile::ProfileAuthentication::Native,
            native_credentials: imported.native_credentials,
        };
        let temp = tempfile::tempdir().unwrap();
        let db = crate::database::Database::open(&temp.path().join("app.db")).unwrap();
        profile::save_profile(&db, profile.clone(), None).unwrap();
        let documents = super::super::apply::desired_documents(
            &profile,
            None,
            super::super::adapter::Scope::Project,
        )
        .unwrap();
        assert!(documents["local_settings"]["env"]
            .get("ANTHROPIC_API_KEY")
            .is_none());
        assert_eq!(
            documents["local_settings"]["enabledPlugins"]["example@local"],
            true
        );
        assert!(documents["local_settings"].get("model").is_none());

        let failing = FailSecondStore {
            values: Mutex::new(BTreeMap::new()),
            writes: AtomicUsize::new(0),
        };
        assert!(prepare_import(CliId::ClaudeCode, files.clone(), &failing)
            .unwrap_err()
            .contains("已清理"));
        assert!(failing.values.lock().unwrap().is_empty());
        assert_eq!(original, files);

        let malformed = BTreeMap::from([
            ("settings".into(), project.into()),
            ("local_settings".into(), "{broken".into()),
        ]);
        let untouched = MemoryStore(Mutex::new(BTreeMap::new()));
        assert!(prepare_import(CliId::ClaudeCode, malformed, &untouched).is_err());
        assert!(untouched.0.lock().unwrap().is_empty());
    }

    #[test]
    fn pi_literal_key_moves_to_keyring_and_savable_draft_uses_native_env_syntax() {
        let store = MemoryStore(Mutex::new(BTreeMap::new()));
        let original = BTreeMap::from([
            ("settings".into(), r#"{"defaultProvider":"mine","defaultModel":"tiny"}"#.into()),
            ("models".into(), r#"// keep comment
{"providers":{"mine":{"api":"openai-responses","baseUrl":"https://example.test/v1","apiKey":"MY_UPPERCASE_LITERAL","models":[{"id":"tiny"}]}}}"#.into()),
        ]);
        let imported = prepare_import(CliId::Pi, original.clone(), &store).unwrap();
        assert!(imported.migrated_secret);
        assert!(original["models"].contains("MY_UPPERCASE_LITERAL"));
        assert!(!serde_json::to_string(&imported)
            .unwrap()
            .contains("MY_UPPERCASE_LITERAL"));
        assert!(imported.files["models"].contains("${CLIORA_PI_MINE_API_KEY}"));
        assert!(imported.files["models"].contains("// keep comment"));
        let connection = imported.inspection.connection.unwrap();
        assert_eq!(
            store
                .get(connection.secret_ref.as_deref().unwrap())
                .unwrap(),
            "MY_UPPERCASE_LITERAL"
        );
        let temp = tempfile::tempdir().unwrap();
        let db = crate::database::Database::open(&temp.path().join("app.db")).unwrap();
        let profile = profile::NativeProfile {
            revision: String::new(),
            id: String::new(),
            tool: CliId::Pi,
            name: "接入".into(),
            version: 0,
            inherit_common: false,
            files: imported.files,
            suppressed: BTreeMap::new(),
            authentication: crate::native::profile::ProfileAuthentication::Native,
            native_credentials: BTreeMap::new(),
            connection: Some(connection),
        };
        let saved = profile::save_profile(&db, profile, None).unwrap();
        assert!(!serde_json::to_string(&saved)
            .unwrap()
            .contains("MY_UPPERCASE_LITERAL"));
    }

    #[test]
    fn opencode_and_claude_literal_keys_are_removed_from_imported_drafts() {
        let cases = [
            (
                CliId::OpenCode,
                r#"{"model":"mine/tiny","provider":{"mine":{"npm":"@ai-sdk/openai","options":{"baseURL":"https://example.test/v1","apiKey":"sk-opencode-literal"}}}}"#,
                "sk-opencode-literal",
                "{env:CLIORA_OPEN_CODE_MINE_API_KEY}",
            ),
            (
                CliId::ClaudeCode,
                r#"{"model":"claude-test","env":{"ANTHROPIC_BASE_URL":"https://api.anthropic.com","ANTHROPIC_API_KEY":"sk-claude-literal"}}"#,
                "sk-claude-literal",
                "ANTHROPIC_API_KEY",
            ),
        ];
        for (tool, source, literal, reference) in cases {
            let store = MemoryStore(Mutex::new(BTreeMap::new()));
            let imported = prepare_import(
                tool,
                BTreeMap::from([("settings".into(), source.into())]),
                &store,
            )
            .unwrap();
            assert!(imported.migrated_secret);
            assert!(!serde_json::to_string(&imported).unwrap().contains(literal));
            let connection = imported.inspection.connection.as_ref().unwrap();
            assert_eq!(
                store
                    .get(connection.secret_ref.as_deref().unwrap())
                    .unwrap(),
                literal
            );
            if tool == CliId::OpenCode {
                assert!(
                    imported.files["settings"].contains(reference),
                    "{}",
                    imported.files["settings"]
                );
            } else {
                assert!(!imported.files["settings"].contains("\"ANTHROPIC_API_KEY\""));
                assert_eq!(connection.auth_env_var.as_deref(), Some(reference));
            }
            profile::validate_files(tool, &imported.files).unwrap();
        }
    }

    #[test]
    fn codex_and_grok_native_keys_migrate_without_losing_model_or_custom_fields() {
        let cases = [
            (CliId::Codex, "model = \"model-a\"\nmodel_provider = \"demo\"\nkeep = 7\n[model_providers.demo]\nbase_url = \"https://example.test/v1\"\nwire_api = \"responses\"\nexperimental_bearer_token = \"codex-test-key\"\n", "codex-test-key"),
            (CliId::Grok, "keep = 7\n[models]\ndefault = \"model-a\"\n[model.model-a]\nmodel = \"model-a\"\nbase_url = \"https://example.test/v1\"\napi_backend = \"responses\"\napi_key = \"grok-test-key\"\n", "grok-test-key"),
        ];
        for (tool, source, key) in cases {
            let store = MemoryStore(Mutex::new(BTreeMap::new()));
            let imported = prepare_import(
                tool,
                BTreeMap::from([("settings".into(), source.into())]),
                &store,
            )
            .unwrap();
            assert!(imported.migrated_secret);
            assert!(!serde_json::to_string(&imported).unwrap().contains(key));
            assert!(imported.files["settings"].contains("keep = 7"));
            let connection = imported.inspection.connection.unwrap();
            assert_eq!(connection.model, "model-a");
            assert_eq!(connection.base_url, "https://example.test/v1");
            assert_eq!(
                store
                    .get(connection.secret_ref.as_deref().unwrap())
                    .unwrap(),
                key
            );
            profile::validate_files(tool, &imported.files).unwrap();
        }
    }

    #[test]
    fn edited_claude_raw_key_and_model_are_reflected_in_safe_import() {
        let source = r#"{"model":"claude-edited","env":{"ANTHROPIC_BASE_URL":"https://example.test","ANTHROPIC_AUTH_TOKEN":"edited-token"},"permissions":{"defaultMode":"default"}}"#;
        let store = MemoryStore(Mutex::new(BTreeMap::new()));
        let imported = prepare_import(
            CliId::ClaudeCode,
            BTreeMap::from([("settings".into(), source.into())]),
            &store,
        )
        .unwrap();
        assert!(!serde_json::to_string(&imported)
            .unwrap()
            .contains("edited-token"));
        assert_eq!(
            imported.inspection.connection.as_ref().unwrap().model,
            "claude-edited"
        );
        assert_eq!(
            imported.inspection.connection.as_ref().unwrap().base_url,
            "https://example.test"
        );
        assert_eq!(
            store
                .get(&imported.native_credentials["settings"]["ANTHROPIC_AUTH_TOKEN"])
                .unwrap(),
            "edited-token"
        );
        assert!(imported.files["settings"].contains("defaultMode"));
    }

    #[test]
    fn import_with_another_literal_provider_fails_before_keyring_write() {
        let store = MemoryStore(Mutex::new(BTreeMap::new()));
        let files = BTreeMap::from([
            ("settings".into(), r#"{"defaultProvider":"mine","defaultModel":"tiny"}"#.into()),
            ("models".into(), r#"{"providers":{"mine":{"api":"openai-responses","baseUrl":"https://example.test/v1","apiKey":"sk-active","models":[{"id":"tiny"}]},"other":{"api":"openai-responses","baseUrl":"https://example.test/v1","apiKey":"sk-other","models":[{"id":"other"}]}}}"#.into()),
        ]);
        assert!(prepare_import(CliId::Pi, files, &store).is_err());
        assert!(store.0.lock().unwrap().is_empty());
    }

    #[test]
    fn invalid_imported_connection_does_not_orphan_keyring_credential() {
        let store = MemoryStore(Mutex::new(BTreeMap::new()));
        let files = BTreeMap::from([
            ("settings".into(), r#"{"defaultProvider":"mine","defaultModel":"tiny"}"#.into()),
            ("models".into(), r#"{"providers":{"mine":{"api":"openai-responses","baseUrl":"http://remote.example/v1","apiKey":"sk-private","models":[{"id":"tiny"}]}}}"#.into()),
        ]);
        assert!(prepare_import(CliId::Pi, files, &store)
            .unwrap_err()
            .contains("HTTPS"));
        assert!(store.0.lock().unwrap().is_empty());
    }

    #[test]
    fn existing_codex_config_becomes_editable_form_without_losing_unknown_fields() {
        let text = include_str!("../../../tests/fixtures/native/codex-0.158.0.toml");
        let files = BTreeMap::from([("settings".into(), text.into())]);
        let found = inspect(CliId::Codex, &files).unwrap();
        let connection = found.connection.unwrap();
        assert_eq!(connection.provider_id, "existing");
        assert_eq!(connection.model, "gpt-6-astra");
        assert_eq!(connection.interface_format, "openai_responses");
        let changed = set_codex_reasoning_effort(text, Some("high")).unwrap();
        assert!(changed.contains("model_reasoning_effort = \"high\""));
        assert!(changed.contains("# Existing user comments"));
        assert!(changed.contains("image_generation = true"));
        let reread = inspect(
            CliId::Codex,
            &BTreeMap::from([("settings".into(), changed.clone())]),
        )
        .unwrap();
        assert_eq!(reread.reasoning_effort.as_deref(), Some("high"));
        let removed = set_codex_reasoning_effort(&changed, None).unwrap();
        assert!(!removed.contains("model_reasoning_effort"));

        let mut edited = connection;
        edited.model = "new-model".into();
        let profile = profile::NativeProfile {
            revision: String::new(),
            id: String::new(),
            tool: CliId::Codex,
            name: "接入".into(),
            version: 0,
            inherit_common: false,
            files,
            suppressed: BTreeMap::new(),
            authentication: crate::native::profile::ProfileAuthentication::Native,
            native_credentials: BTreeMap::new(),
            connection: Some(edited),
        };
        let merged = super::super::apply::desired_documents(
            &profile,
            None,
            super::super::adapter::Scope::Global,
        )
        .unwrap();
        let settings = &merged["settings"];
        assert_eq!(settings["model"], "new-model");
        assert_eq!(settings["features"]["image_generation"], true);
    }

    #[test]
    fn versioned_native_fixtures_expose_known_connection_fields() {
        let cases = [
            (
                CliId::ClaudeCode,
                "settings",
                include_str!("../../../tests/fixtures/native/claude-2.1.283.json"),
            ),
            (
                CliId::Grok,
                "settings",
                include_str!("../../../tests/fixtures/native/grok-1.0.41.toml"),
            ),
            (
                CliId::Pi,
                "models",
                include_str!("../../../tests/fixtures/native/pi-0.87.1-models.jsonc"),
            ),
            (
                CliId::OpenCode,
                "settings",
                include_str!("../../../tests/fixtures/native/opencode-1.18.33.jsonc"),
            ),
        ];
        for (tool, role, text) in cases {
            let found = inspect(tool, &BTreeMap::from([(role.into(), text.into())])).unwrap();
            assert!(found.model.is_some(), "{tool:?}");
            assert!(found.provider_id.is_some(), "{tool:?}");
            assert!(found.connection.is_some(), "{tool:?}");
        }
    }

    #[test]
    fn unknown_native_wire_format_stays_visible_without_claiming_a_usable_connection() {
        let files = BTreeMap::from([("settings".into(), "model = \"m\"\nmodel_provider = \"custom\"\n[model_providers.custom]\nbase_url = \"https://example.test/v1\"\nwire_api = \"future_protocol\"\n".into())]);
        let found = inspect(CliId::Codex, &files).unwrap();
        assert_eq!(found.provider_id.as_deref(), Some("custom"));
        assert_eq!(found.model.as_deref(), Some("m"));
        assert!(found.connection.is_none());
    }

    #[test]
    fn projected_models_keep_stored_fields_and_skip_sibling_catalogs() {
        let registry = crate::adapters::Registry::builtins();
        let opencode = inspect_registered(
            &registry,
            "open_code",
            &BTreeMap::from([(
                "settings".into(),
                r#"{"model":"demo/m1","provider":{"demo":{"npm":"@ai-sdk/openai","name":"demo","options":{"baseURL":"https://example.test/v1"},"models":{"m1":{"name":"Custom","extra":true},"m2":{"name":"Second"}}}}}"#.into(),
            )]),
        )
        .unwrap();
        let models = opencode.projected_models.expect("OpenCode projects provider models");
        let m1 = models.iter().find(|item| item.id == "m1").unwrap();
        assert_eq!(m1.fields["name"], "Custom");
        assert_eq!(m1.fields["extra"], true);
        assert!(m1.fields.get("contextWindow").is_none());
        assert!(models.iter().any(|item| item.id == "m2" && item.fields["name"] == "Second"));

        let pi = inspect_registered(
            &registry,
            "pi",
            &BTreeMap::from([
                ("settings".into(), r#"{"defaultProvider":"demo","defaultModel":"model-a"}"#.into()),
                ("models".into(), r#"{"providers":{"demo":{"api":"openai-responses","baseUrl":"https://example.test/v1","models":[{"id":"model-a","contextWindow":100,"cost":{"input":1}},{"id":"sibling","name":"Keep"}]}}}"#.into()),
            ]),
        )
        .unwrap();
        let models = pi.projected_models.expect("Pi projects provider models");
        let current = models.iter().find(|item| item.id == "model-a").unwrap();
        assert!(current.fields.get("id").is_none());
        assert_eq!(current.fields["contextWindow"], 100);
        assert_eq!(current.fields["cost"]["input"], 1);
        assert!(models.iter().any(|item| item.id == "sibling" && item.fields["name"] == "Keep"));

        let codex = inspect_registered(
            &registry,
            "codex",
            &BTreeMap::from([(
                "settings".into(),
                "model = \"m\"\nmodel_provider = \"demo\"\n[model_providers.demo]\nbase_url = \"https://example.test/v1\"\nwire_api = \"responses\"\n".into(),
            )]),
        )
        .unwrap();
        assert!(codex.projected_models.is_none());
        let kimi = inspect_registered(
            &registry,
            "kimi_code",
            &BTreeMap::from([(
                "settings".into(),
                "default_model = \"alias\"\n[models.alias]\nprovider = \"demo\"\nmodel = \"k\"\n[providers.demo]\ntype = \"openai\"\nbase_url = \"https://example.test/v1\"\n".into(),
            )]),
        )
        .unwrap();
        assert!(kimi.projected_models.is_none(), "Kimi models stay beside providers");
    }
}
