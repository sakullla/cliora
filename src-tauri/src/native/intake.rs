use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::{json, Value};
use uuid::Uuid;

use super::{
    format::{self, FileKind},
    profile::{self, Connection},
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
    mut files: BTreeMap<String, String>,
    credentials: &dyn CredentialStore,
) -> Result<NativeImport, String> {
    let mut found = inspect(tool, &files)?;
    let mut pending_secrets: Vec<(String, String)> = Vec::new();
    let mut native_credentials: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    if matches!(tool, CliId::Codex | CliId::Grok) {
        let mut text = files.get("settings").cloned().unwrap_or_default();
        let parsed = format::parse(FileKind::Toml, &text)?;
        let (collection, field, active) = if tool == CliId::Codex {
            (
                "model_providers",
                "experimental_bearer_token",
                found.provider_id.as_deref(),
            )
        } else {
            ("model", "api_key", found.model.as_deref())
        };
        if let Some(entries) = parsed.get(collection).and_then(Value::as_object) {
            for (name, entry) in entries {
                let Some(key) = entry.get(field).and_then(Value::as_str) else {
                    continue;
                };
                if Some(name.as_str()) != active || found.connection.is_none() {
                    return Err(format!("{collection}.{name}.{field} 含原生密钥，但不是完整的当前连接；请先在 CLI 中选定模型与供应商，原文件未更改"));
                }
                if key.is_empty() || key.len() > 16_384 {
                    return Err("原生 API 密钥为空或过长；原文件未更改".into());
                }
                let id = format!("connection-{}", Uuid::new_v4());
                text = format::set_path(
                    FileKind::Toml,
                    &text,
                    &[collection.into(), name.clone(), field.into()],
                    None,
                )?;
                files.insert("settings".into(), text.clone());
                found.connection.as_mut().unwrap().secret_ref = Some(id.clone());
                pending_secrets.push((id, key.to_owned()));
            }
        }
    }
    if tool == CliId::Pi {
        let raw = files.get("models").cloned().unwrap_or_default();
        let models = format::parse(FileKind::Jsonc, &raw)?;
        if let Some(providers) = models.get("providers").and_then(Value::as_object) {
            let active = found.provider_id.as_deref();
            for (name, provider) in providers {
                let Some(key) = provider.get("apiKey").and_then(Value::as_str) else {
                    continue;
                };
                if pi_env_name(key).is_some() {
                    continue;
                }
                if active != Some(name.as_str()) || found.connection.is_none() {
                    return Err(format!("Pi 供应商 {name} 含字面 apiKey；请先在原生配置中选择完整的默认供应商与模型，再逐一安全接入。原文件未更改"));
                }
                if key.is_empty() || key.len() > 16_384 {
                    return Err("Pi 原生 apiKey 为空或超过系统凭据库限制；原文件未更改".into());
                }
                let id = format!("connection-{}", Uuid::new_v4());
                let connection = found.connection.as_mut().unwrap();
                connection.secret_ref = Some(id.clone());
                let env =
                    profile::auth_env_name(tool, connection).ok_or("无法确定 Pi 的认证环境变量")?;
                connection.auth_env_var = Some(env.clone());
                let replaced = format::set_path(
                    FileKind::Jsonc,
                    &raw,
                    &["providers".into(), name.clone(), "apiKey".into()],
                    Some(&json!(format!("${{{env}}}"))),
                )?;
                files.insert("models".into(), replaced);
                pending_secrets.push((id, key.to_owned()));
            }
        }
    }
    if tool == CliId::OpenCode {
        let raw = files.get("settings").cloned().unwrap_or_default();
        let settings = format::parse(FileKind::Jsonc, &raw)?;
        if let Some(providers) = settings.get("provider").and_then(Value::as_object) {
            for (name, provider) in providers {
                let Some(key) = provider
                    .get("options")
                    .and_then(|value| value.get("apiKey"))
                    .and_then(Value::as_str)
                else {
                    continue;
                };
                if key
                    .strip_prefix("{env:")
                    .and_then(|tail| tail.strip_suffix('}'))
                    .is_some_and(profile::valid_env_name)
                {
                    continue;
                }
                if found.provider_id.as_deref() != Some(name.as_str()) || found.connection.is_none()
                {
                    return Err(format!("OpenCode 供应商 {name} 含字面 apiKey；请先选择完整的默认供应商与模型，再逐一安全接入。原文件未更改"));
                }
                if key.is_empty() || key.len() > 16_384 {
                    return Err("原生 apiKey 为空或超过系统凭据库限制；原文件未更改".into());
                }
                let id = format!("connection-{}", Uuid::new_v4());
                let connection = found.connection.as_mut().unwrap();
                connection.secret_ref = Some(id.clone());
                let env = profile::auth_env_name(tool, connection)
                    .ok_or("无法确定 OpenCode 的认证环境变量")?;
                connection.auth_env_var = Some(env.clone());
                let replaced = format::set_path(
                    FileKind::Jsonc,
                    &raw,
                    &[
                        "provider".into(),
                        name.clone(),
                        "options".into(),
                        "apiKey".into(),
                    ],
                    Some(&json!(format!("{{env:{env}}}"))),
                )?;
                files.insert("settings".into(), replaced);
                pending_secrets.push((id, key.to_owned()));
            }
        }
    }
    if tool == CliId::ClaudeCode {
        for role in ["settings", "local_settings"] {
            let mut text = files.get(role).cloned().unwrap_or_default();
            let parsed = format::parse(FileKind::Json, &text)?;
            for name in ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] {
                let Some(key) = string_at(&parsed, &["env", name]) else {
                    continue;
                };
                if key.is_empty() || key.len() > 16_384 {
                    return Err("原生 API 密钥为空或超过系统凭据库限制；原文件未更改".into());
                }
                let id = format!("connection-{}", Uuid::new_v4());
                text = format::set_path(FileKind::Json, &text, &["env".into(), name.into()], None)?;
                native_credentials
                    .entry(role.into())
                    .or_default()
                    .insert(name.into(), id.clone());
                pending_secrets.push((id.clone(), key.to_owned()));
                // An explicit connection may also use an imported API key for
                // directory tests; a default-only CLI config stays connection-free.
                if name == "ANTHROPIC_API_KEY" {
                    if let Some(connection) = found.connection.as_mut() {
                        connection.secret_ref = Some(id);
                        connection.auth_env_var = Some(name.into());
                    }
                }
            }
            if native_credentials.contains_key(role) {
                files.insert(role.into(), text);
            }
        }
    }
    profile::validate_files(tool, &files)
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
    found = inspect(tool, &files)?;
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

fn pi_env_name(value: &str) -> Option<&str> {
    let name = value.strip_prefix('$')?;
    let name = name
        .strip_prefix('{')
        .and_then(|tail| tail.strip_suffix('}'))
        .unwrap_or(name);
    profile::valid_env_name(name).then_some(name)
}

fn string_at<'a>(root: &'a Value, path: &[&str]) -> Option<&'a str> {
    path.iter()
        .try_fold(root, |value, segment| value.get(*segment))?
        .as_str()
}

fn api_format(value: &str) -> Option<&'static str> {
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
    let settings = format::parse(
        profile::file_kind(tool, "settings")?,
        files.get("settings").map(String::as_str).unwrap_or(""),
    )?;
    let local_settings = if tool == CliId::ClaudeCode {
        format::parse(
            FileKind::Json,
            files
                .get("local_settings")
                .map(String::as_str)
                .unwrap_or(""),
        )?
    } else {
        json!({})
    };
    let models = if tool == CliId::Pi {
        format::parse(
            FileKind::Jsonc,
            files.get("models").map(String::as_str).unwrap_or(""),
        )?
    } else {
        json!({})
    };
    let mut provider = None;
    let mut model = None;
    let mut base = None;
    let mut wire = None;
    let mut env = None;
    let reasoning_effort = if tool == CliId::Codex {
        string_at(&settings, &["model_reasoning_effort"]).map(str::to_owned)
    } else {
        None
    };
    match tool {
        CliId::Codex => {
            provider = string_at(&settings, &["model_provider"]).map(str::to_owned);
            model = string_at(&settings, &["model"]).map(str::to_owned);
            if let Some(id) = &provider {
                base =
                    string_at(&settings, &["model_providers", id, "base_url"]).map(str::to_owned);
                wire =
                    string_at(&settings, &["model_providers", id, "wire_api"]).and_then(api_format);
                env = string_at(&settings, &["model_providers", id, "env_key"]).map(str::to_owned);
            }
        }
        CliId::ClaudeCode => {
            provider = Some("anthropic".into());
            model = string_at(&local_settings, &["model"])
                .or_else(|| string_at(&settings, &["model"]))
                .map(str::to_owned);
            base = string_at(&local_settings, &["env", "ANTHROPIC_BASE_URL"])
                .or_else(|| string_at(&settings, &["env", "ANTHROPIC_BASE_URL"]))
                .map(str::to_owned);
            wire = Some("anthropic_messages");
        }
        CliId::Grok => {
            provider = Some("grok".into());
            model = string_at(&settings, &["models", "default"]).map(str::to_owned);
            if let Some(id) = &model {
                base = string_at(&settings, &["model", id, "base_url"]).map(str::to_owned);
                wire = string_at(&settings, &["model", id, "api_backend"]).and_then(api_format);
                env = string_at(&settings, &["model", id, "env_key"]).map(str::to_owned);
            }
        }
        CliId::Pi => {
            provider = string_at(&settings, &["defaultProvider"])
                .map(str::to_owned)
                .or_else(|| models.get("providers")?.as_object()?.keys().next().cloned());
            model = string_at(&settings, &["defaultModel"]).map(str::to_owned);
            if let Some(id) = &provider {
                let entry = models.get("providers").and_then(|value| value.get(id));
                base = entry
                    .and_then(|value| value.get("baseUrl"))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                wire = entry
                    .and_then(|value| value.get("api"))
                    .and_then(Value::as_str)
                    .and_then(api_format);
                // Only Pi's documented $NAME / ${NAME} syntax is a safe reference.
                env = entry
                    .and_then(|value| value.get("apiKey"))
                    .and_then(Value::as_str)
                    .and_then(pi_env_name)
                    .map(str::to_owned);
                if model.is_none() {
                    model = entry
                        .and_then(|value| value.get("models"))
                        .and_then(Value::as_array)
                        .and_then(|list| list.first())
                        .and_then(|value| value.get("id"))
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                }
            }
        }
        CliId::OpenCode => {
            if let Some(full) = string_at(&settings, &["model"]) {
                if let Some((id, name)) = full.split_once('/') {
                    provider = Some(id.into());
                    model = Some(name.into());
                }
            }
            if provider.is_none() {
                provider = settings
                    .get("provider")
                    .and_then(Value::as_object)
                    .and_then(|items| items.keys().next())
                    .cloned();
            }
            if let Some(id) = &provider {
                let entry = settings.get("provider").and_then(|value| value.get(id));
                base = entry
                    .and_then(|value| value.get("options"))
                    .and_then(|value| value.get("baseURL"))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                wire = entry
                    .and_then(|value| value.get("npm"))
                    .and_then(Value::as_str)
                    .and_then(api_format);
                env = entry
                    .and_then(|value| value.get("options"))
                    .and_then(|value| value.get("apiKey"))
                    .and_then(Value::as_str)
                    .and_then(|value| value.strip_prefix("{env:"))
                    .and_then(|value| value.strip_suffix('}'))
                    .map(str::to_owned);
                if model.is_none() {
                    model = entry
                        .and_then(|value| value.get("models"))
                        .and_then(Value::as_object)
                        .and_then(|items| items.keys().next())
                        .cloned();
                }
            }
        }
    }
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
            })
        }
        _ => None,
    };
    Ok(NativeInspection {
        provider_id: provider,
        model,
        connection,
        reasoning_effort,
    })
}

pub fn set_codex_reasoning_effort(text: &str, effort: Option<&str>) -> Result<String, String> {
    if effort.is_some_and(|value| !matches!(value, "minimal" | "low" | "medium" | "high" | "xhigh"))
    {
        return Err("不支持的 Codex 推理强度".into());
    }
    let value = effort.map(|value| json!(value));
    format::set_path(
        FileKind::Toml,
        text,
        &["model_reasoning_effort".into()],
        value.as_ref(),
    )
}

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
                id: String::new(),
                tool: CliId::ClaudeCode,
                name: "默认配置".into(),
                version: 0,
                inherit_common: false,
                files: imported.files,
                suppressed: BTreeMap::new(),
                connection: imported.inspection.connection,
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
                id: String::new(),
                tool: CliId::ClaudeCode,
                name: "raw".into(),
                version: 0,
                inherit_common: false,
                files: local_only,
                suppressed: BTreeMap::new(),
                connection: None,
                native_credentials: BTreeMap::new(),
            },
            None
        )
        .is_err());
        let profile = profile::NativeProfile {
            id: String::new(),
            tool: CliId::ClaudeCode,
            name: "项目".into(),
            version: 0,
            inherit_common: false,
            files: imported.files,
            suppressed: BTreeMap::new(),
            connection: None,
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
            id: String::new(),
            tool: CliId::Pi,
            name: "接入".into(),
            version: 0,
            inherit_common: false,
            files: imported.files,
            suppressed: BTreeMap::new(),
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
            id: String::new(),
            tool: CliId::Codex,
            name: "接入".into(),
            version: 0,
            inherit_common: false,
            files,
            suppressed: BTreeMap::new(),
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
}
