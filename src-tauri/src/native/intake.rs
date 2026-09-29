use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::{json, Value};

use super::{
    format::{self, FileKind},
    profile::{self, Connection},
};
use crate::domain::CliId;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeInspection {
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub connection: Option<Connection>,
    pub reasoning_effort: Option<String>,
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
            model = string_at(&settings, &["model"]).map(str::to_owned);
            base = string_at(&settings, &["env", "ANTHROPIC_BASE_URL"]).map(str::to_owned);
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
                // Pi accepts both environment names and literal keys here. Never
                // reflect an existing auth value into the general form/SQLite.
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
