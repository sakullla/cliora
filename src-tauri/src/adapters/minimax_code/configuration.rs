//! `config.yaml` projection. Overlays write only the active source so Token
//! Plan, the MiniMax API key, and a custom provider do not replace each other.
use super::{custom_secret_env, env_reference, referenced_env, MiniMaxCode, DEFAULT_SECRET_ENV, TOKEN_PLAN_PROFILE_URL};
use crate::adapters::configuration::{
    CommonParameter, ConfigurationAction, ConfigurationAdapter, ConfigurationDescriptor,
    ConfigurationField, ConfigurationIssue, Documents, EditingState, PortableFieldKind,
    EDITING_VERSION,
};
use crate::native::format::{self, FileKind};
use crate::native::intake::NativeInspection;
use crate::native::profile::Connection;
use crate::native::adapter::Scope;
use serde_json::{json, Value};
use std::collections::BTreeMap;

const PERMISSIONS: &[&str] = &["default", "auto", "bypassPermissions", "off"];

impl ConfigurationAdapter for MiniMaxCode {
    fn common_parameters(&self, _scope: Scope) -> Vec<CommonParameter> {
        vec![CommonParameter {
            field: field("permissionMode", "权限模式", "choice", PERMISSIONS),
            role: "config",
            path: vec!["permissionMode".into()],
            target: json!({"kind": "settings"}),
        }]
    }
    fn describe(&self, _scope: Scope) -> ConfigurationDescriptor {
        ConfigurationDescriptor {
            version: EDITING_VERSION,
            operations: vec![
                "set".into(),
                "reset".into(),
                "select_provider".into(),
                "configure_provider".into(),
            ],
            fields: vec![
                field("provider", "供应商", "string", &[]),
                field("name", "自定义供应商名称", "string", &[]),
                field("baseUrl", "请求地址", "string", &[]),
                field("source", "登录来源", "choice", &["token_plan", "minimax_api_key"]),
                field("interfaceFormat", "接口格式", "choice", &[
                    "anthropic_messages",
                    "openai_completions",
                    "openai_responses",
                ]),
                field("model", "模型", "string", &[]),
                field("permissionMode", "权限模式", "choice", PERMISSIONS),
            ],
        }
    }
    fn field_locations(&self, field: &str, _documents: &Documents) -> Vec<(String, Vec<String>)> {
        let path = match field {
            "source" => vec!["minimaxModelSource".into()],
            "model" => vec!["defaultModel".into()],
            "permissionMode" => vec!["permissionMode".into()],
            "baseUrl" => vec!["minimax_api".into(), "baseURL".into()],
            _ => return Vec::new(),
        };
        vec![("config".into(), path)]
    }
    fn read(&self, documents: &Documents, state: &EditingState) -> Result<Value, String> {
        let root = documents.get("config").cloned().unwrap_or_else(|| json!({}));
        let object = root.as_object().cloned().unwrap_or_default();
        let provider = active_provider(&object, state);
        let custom = provider != "token_plan" && provider != "minimax";
        let source = if provider == "minimax" {
            "minimax_api_key"
        } else if custom {
            object
                .get("minimaxModelSource")
                .and_then(Value::as_str)
                .unwrap_or("token_plan")
        } else {
            "token_plan"
        };
        Ok(json!({
            "providerId": provider,
            "providers": custom_ids(&object),
            "name": if custom { custom_name(&object, &provider).unwrap_or(provider.clone()) } else { provider.clone() },
            "source": source,
            "model": view_model(&root, state, &provider),
            "baseUrl": view_base(&root, &provider),
            "interfaceFormat": view_format(&root, &provider),
            "addressLocked": provider == "token_plan",
            "formatLocked": provider == "token_plan",
            "permissionMode": object.get("permissionMode").and_then(Value::as_str).unwrap_or(""),
        }))
    }
    fn edit(
        &self,
        documents: &mut Documents,
        state: &mut EditingState,
        action: &ConfigurationAction,
    ) -> Result<(), String> {
        let root = documents.entry("config".into()).or_insert_with(|| json!({}));
        let object = root.as_object_mut().ok_or("config.yaml 顶层必须是对象")?;
        match action.operation.as_str() {
            "reset" => match action.field.as_deref().unwrap_or("") {
                "permissionMode" => {
                    object.remove("permissionMode");
                }
                "baseUrl" => set_base_url(object, state, "")?,
                _ => return Err("MiniMax Code 未声明此恢复动作".into()),
            },
            "set" => match action.field.as_deref().unwrap_or("") {
                "permissionMode" => {
                    let value = text(action).ok_or("权限模式不在已核对取值内")?;
                    if !PERMISSIONS.contains(&value) {
                        return Err("权限模式不在已核对取值内".into());
                    }
                    object.insert("permissionMode".into(), json!(value));
                }
                "source" => {
                    let value = text(action).ok_or("登录来源不在已核对取值内")?;
                    let provider = match value {
                        "token_plan" => "token_plan",
                        "minimax_api_key" => "minimax",
                        _ => return Err("登录来源不在已核对取值内".into()),
                    };
                    set_provider(object, state, provider)?;
                }
                "provider" => set_provider(object, state, text(action).ok_or("请填写供应商")?)?,
                "name" => set_name(object, state, text(action).ok_or("请填写自定义供应商名称")?)?,
                "baseUrl" => set_base_url(object, state, text(action).unwrap_or(""))?,
                "interfaceFormat" => {
                    set_interface(object, state, text(action).ok_or("请选择接口格式")?)?
                }
                "model" => set_model(object, state, text(action).ok_or("请填写模型")?)?,
                _ => return Err("此字段请通过连接或原始配置修改".into()),
            },
            "select_provider" => set_provider(object, state, &provider_from_action(action)?)?,
            "configure_provider" => {
                let id = provider_from_action(action)?;
                set_provider(object, state, &id)?;
                let value = action.value.as_ref().and_then(Value::as_object);
                if let Some(url) = value.and_then(|value| value.get("baseUrl")).and_then(Value::as_str) {
                    set_base_url(object, state, url)?;
                }
                if let Some(format) = value
                    .and_then(|value| value.get("interfaceFormat"))
                    .and_then(Value::as_str)
                {
                    set_interface(object, state, format)?;
                }
                if let Some(name) = value.and_then(|value| value.get("name")).and_then(Value::as_str) {
                    if !name.trim().is_empty() {
                        set_name(object, state, name)?;
                    }
                }
                if let Some(model) = value.and_then(|value| value.get("model")).and_then(Value::as_str) {
                    if !model.trim().is_empty() {
                        set_model(object, state, model)?;
                    }
                }
            }
            _ => return Err("MiniMax Code 未声明此编辑动作".into()),
        }
        Ok(())
    }
    fn reconcile_text(
        &self,
        _previous: Option<&Documents>,
        next: &Documents,
        _effective: &Documents,
        state: &mut EditingState,
    ) -> Result<(), String> {
        let root = next.get("config").cloned().unwrap_or(Value::Null);
        state.intents.retain(|action| {
            if action.field.as_deref() == Some("officialModel") && action.operation == "set" {
                return true;
            }
            let Some(field) = action.field.as_deref() else {
                return false;
            };
            let pointer = match field {
                "source" => "/minimaxModelSource",
                "model" => "/defaultModel",
                "permissionMode" => "/permissionMode",
                _ => return false,
            };
            matches!(action.operation.as_str(), "reset" | "delete") && root.pointer(pointer).is_none()
        });
        Ok(())
    }
    fn validate(
        &self,
        documents: &Documents,
        _state: &EditingState,
        _scope: Scope,
    ) -> Vec<ConfigurationIssue> {
        let Some(root) = documents.get("config") else {
            return Vec::new();
        };
        match reject_config(root) {
            Ok(()) => Vec::new(),
            Err(message) => vec![ConfigurationIssue {
                target: Value::Null,
                field: Some("config".into()),
                code: "invalid_document".into(),
                message,
            }],
        }
    }
    fn connection(
        &self,
        documents: &Documents,
        _state: &EditingState,
    ) -> Result<Option<Connection>, String> {
        let Some(root) = documents.get("config") else {
            return Ok(None);
        };
        project_connection(root)
    }
    fn portable_field_kind(&self, path: &[String]) -> PortableFieldKind {
        match path.last().map(String::as_str) {
            Some("apiKey" | "api_key") => PortableFieldKind::CredentialReference,
            Some(
                "defaultModel"
                | "defaultModelVariant"
                | "minimaxModelSource"
                | "permissionMode"
                | "baseURL"
                | "name"
                | "api"
                | "enabled"
                | "models",
            ) => PortableFieldKind::Parameter,
            _ => PortableFieldKind::Unknown,
        }
    }
    fn portable_reference_valid(&self, path: &[String], value: &Value) -> bool {
        matches!(path.last().map(String::as_str), Some("apiKey" | "api_key"))
            && value.as_str().is_some_and(|text| referenced_env(text).is_some())
    }
}

fn field(id: &str, label: &str, kind: &str, choices: &[&str]) -> ConfigurationField {
    ConfigurationField {
        id: id.into(),
        label: label.into(),
        kind: kind.into(),
        required: id == "model",
        advanced: id == "permissionMode",
        choices: choices.iter().map(|choice| (*choice).to_owned()).collect(),
        minimum: None,
        default_source: None,
        unavailable_reason: None,
        origin: None,
    }
}

fn text(action: &ConfigurationAction) -> Option<&str> {
    action.value.as_ref().and_then(Value::as_str)
}

fn provider_from_action(action: &ConfigurationAction) -> Result<String, String> {
    action
        .target
        .get("provider")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .or_else(|| text(action).filter(|id| !id.is_empty()))
        .or_else(|| {
            action
                .value
                .as_ref()
                .and_then(|value| value.get("name"))
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
        })
        .map(str::to_owned)
        .ok_or_else(|| "请填写供应商".into())
}

fn active_provider(object: &serde_json::Map<String, Value>, state: &EditingState) -> String {
    if let Some(id) = state.selected_provider.as_deref().filter(|id| !id.is_empty()) {
        return id.to_owned();
    }
    let model = object.get("defaultModel").and_then(Value::as_str).unwrap_or("");
    if let Some(rest) = model.strip_prefix("custom_provider:") {
        if let Some((id, _)) = rest.split_once('/') {
            if !id.is_empty() {
                return id.to_owned();
            }
        }
    }
    if object.get("minimaxModelSource").and_then(Value::as_str) == Some("minimax_api_key") {
        "minimax".into()
    } else {
        "token_plan".into()
    }
}

fn custom_ids(object: &serde_json::Map<String, Value>) -> Vec<String> {
    object
        .get("custom_provider")
        .and_then(Value::as_object)
        .map(|providers| providers.keys().cloned().collect())
        .unwrap_or_default()
}

fn custom_name(object: &serde_json::Map<String, Value>, id: &str) -> Option<String> {
    object
        .get("custom_provider")
        .and_then(|providers| providers.get(id))
        .and_then(|entry| entry.get("name"))
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
}

fn view_base(root: &Value, provider: &str) -> String {
    if provider == "token_plan" {
        return TOKEN_PLAN_PROFILE_URL.into();
    }
    if provider == "minimax" {
        return root
            .pointer("/minimax_api/baseURL")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_owned();
    }
    root.pointer(&format!(
        "/custom_provider/{}/options/baseURL",
        pointer_token(provider)
    ))
    .and_then(Value::as_str)
    .unwrap_or("")
    .trim()
    .to_owned()
}

fn view_format(root: &Value, provider: &str) -> String {
    if provider == "token_plan" || provider == "minimax" {
        return "anthropic_messages".into();
    }
    let api = root
        .pointer(&format!("/custom_provider/{}/api", pointer_token(provider)))
        .and_then(Value::as_str)
        .unwrap_or("anthropic-messages");
    interface_kind(api).unwrap_or("anthropic_messages").into()
}

fn view_model(root: &Value, state: &EditingState, provider: &str) -> String {
    if provider == "token_plan" || provider == "minimax" {
        return retained_official(root, state);
    }
    let current = root.get("defaultModel").and_then(Value::as_str).unwrap_or("");
    let prefix = format!("custom_provider:{provider}/");
    if let Some(rest) = current.strip_prefix(&prefix) {
        let (bare, _) = split_variant(rest).unwrap_or((rest.to_owned(), None));
        let variant = root.get("defaultModelVariant").and_then(Value::as_str).unwrap_or("");
        if !bare.is_empty() {
            return if variant.is_empty() || bare.contains('#') {
                bare
            } else {
                format!("{bare}#{variant}")
            };
        }
    }
    root.pointer(&format!("/custom_provider/{}/models", pointer_token(provider)))
        .and_then(Value::as_object)
        .and_then(|models| models.keys().next().cloned())
        .unwrap_or_default()
}

fn retained_official(root: &Value, state: &EditingState) -> String {
    let current = root.get("defaultModel").and_then(Value::as_str).unwrap_or("");
    if !current.is_empty() && !current.starts_with("custom_provider:") {
        return display_model(current, root);
    }
    retained_official_intent(state).unwrap_or_default()
}

fn retained_official_intent(state: &EditingState) -> Option<String> {
    state.intents.iter().rev().find_map(|action| {
        (action.field.as_deref() == Some("officialModel") && action.operation == "set")
            .then(|| action.value.as_ref().and_then(Value::as_str))
            .flatten()
            .filter(|model| !model.is_empty())
            .map(str::to_owned)
    })
}

fn remember_official(state: &mut EditingState, model: &str) {
    if model.trim().is_empty() {
        return;
    }
    state.intents.retain(|action| action.field.as_deref() != Some("officialModel"));
    state.intents.push(ConfigurationAction {
        version: EDITING_VERSION,
        target: json!({"kind": "provider", "provider": "token_plan"}),
        operation: "set".into(),
        field: Some("officialModel".into()),
        value: Some(json!(model)),
    });
}

fn shown_official(object: &serde_json::Map<String, Value>) -> Option<String> {
    let current = object.get("defaultModel").and_then(Value::as_str)?;
    if current.is_empty() || current.starts_with("custom_provider:") {
        return None;
    }
    Some(display_model(current, &Value::Object(object.clone())))
}

fn set_provider(
    object: &mut serde_json::Map<String, Value>,
    state: &mut EditingState,
    id: &str,
) -> Result<(), String> {
    if id == "token_plan" || id == "minimax" {
        if let Some(model) = shown_official(object) {
            remember_official(state, &model);
        }
        object.insert(
            "minimaxModelSource".into(),
            json!(if id == "token_plan" { "token_plan" } else { "minimax_api_key" }),
        );
        state.selected_provider = Some(id.to_owned());
        restore_official_default(object, state)?;
        return Ok(());
    }
    let id = custom_id(id)?;
    if let Some(model) = shown_official(object) {
        remember_official(state, &model);
    }
    ensure_custom(object, &id)?;
    state.selected_provider = Some(id.clone());
    if let Some(model) = active_custom_model(object, &id) {
        write_custom_default(object, &id, &model)?;
    }
    Ok(())
}

fn restore_official_default(
    object: &mut serde_json::Map<String, Value>,
    state: &EditingState,
) -> Result<(), String> {
    let current = object.get("defaultModel").and_then(Value::as_str).unwrap_or("");
    if !current.is_empty() && !current.starts_with("custom_provider:") {
        return Ok(());
    }
    if let Some(model) = retained_official_intent(state) {
        write_official_model(object, &model)?;
    } else if current.starts_with("custom_provider:") {
        object.remove("defaultModel");
        object.remove("defaultModelVariant");
    }
    Ok(())
}

fn active_custom_model(object: &serde_json::Map<String, Value>, id: &str) -> Option<String> {
    let current = object.get("defaultModel").and_then(Value::as_str).unwrap_or("");
    let prefix = format!("custom_provider:{id}/");
    if let Some(rest) = current.strip_prefix(&prefix) {
        let bare = rest.split_once('#').map(|(model, _)| model).unwrap_or(rest);
        if !bare.is_empty() {
            let variant = object.get("defaultModelVariant").and_then(Value::as_str).unwrap_or("");
            return Some(if variant.is_empty() || bare.contains('#') {
                bare.to_owned()
            } else {
                format!("{bare}#{variant}")
            });
        }
    }
    let name = object
        .get("custom_provider")?
        .get(id)?
        .get("models")?
        .as_object()?
        .keys()
        .next()?
        .clone();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

fn set_name(
    object: &mut serde_json::Map<String, Value>,
    state: &mut EditingState,
    name: &str,
) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() || name.contains(['/', '\\']) {
        return Err("自定义供应商名称无效".into());
    }
    let provider = active_provider(object, state);
    if provider == "token_plan" || provider == "minimax" {
        return set_provider(object, state, name);
    }
    let id = custom_id(&provider)?;
    ensure_custom(object, &id)?;
    let entry = custom_entry(object, &id)?;
    entry.insert("name".into(), json!(name));
    Ok(())
}

fn set_base_url(
    object: &mut serde_json::Map<String, Value>,
    state: &EditingState,
    url: &str,
) -> Result<(), String> {
    let url = url.trim();
    let provider = active_provider(object, state);
    if provider == "token_plan" {
        return Ok(());
    }
    if provider == "minimax" {
        let api = object.entry("minimax_api".to_owned()).or_insert_with(|| json!({}));
        let api = api.as_object_mut().ok_or("minimax_api 必须是对象")?;
        if url.is_empty() {
            api.remove("baseURL");
        } else {
            api.insert("baseURL".into(), json!(url));
        }
        return Ok(());
    }
    let id = custom_id(&provider)?;
    ensure_custom(object, &id)?;
    let entry = custom_entry(object, &id)?;
    let options = entry.entry("options".to_owned()).or_insert_with(|| json!({}));
    let options = options.as_object_mut().ok_or("自定义供应商选项必须是对象")?;
    if url.is_empty() {
        options.remove("baseURL");
    } else {
        options.insert("baseURL".into(), json!(url));
    }
    Ok(())
}

fn set_interface(
    object: &mut serde_json::Map<String, Value>,
    state: &EditingState,
    interface: &str,
) -> Result<(), String> {
    let provider = active_provider(object, state);
    if provider == "token_plan" || provider == "minimax" {
        return if interface == "anthropic_messages" {
            Ok(())
        } else {
            Err("官方来源的接口格式固定为 Anthropic Messages；请改用自定义供应商".into())
        };
    }
    let api = api_kind(interface)?;
    let id = custom_id(&provider)?;
    ensure_custom(object, &id)?;
    let entry = custom_entry(object, &id)?;
    entry.insert("api".into(), json!(api));
    Ok(())
}

fn set_model(
    object: &mut serde_json::Map<String, Value>,
    state: &mut EditingState,
    model: &str,
) -> Result<(), String> {
    let provider = active_provider(object, state);
    if provider == "token_plan" || provider == "minimax" {
        write_official_model(object, model)?;
        if let Some(shown) = shown_official(object) {
            remember_official(state, &shown);
        }
        return Ok(());
    }
    let id = custom_id(&provider)?;
    write_custom_default(object, &id, model)
}

fn write_official_model(object: &mut serde_json::Map<String, Value>, model: &str) -> Result<(), String> {
    let (model, variant) = official_model(model)?;
    object.insert("defaultModel".into(), json!(model));
    write_variant(object, variant);
    Ok(())
}

fn write_custom_default(
    object: &mut serde_json::Map<String, Value>,
    id: &str,
    model: &str,
) -> Result<(), String> {
    let (bare, variant) = custom_model(model)?;
    ensure_custom(object, id)?;
    {
        let entry = custom_entry(object, id)?;
        let models = entry.entry("models".to_owned()).or_insert_with(|| json!({}));
        let models = models.as_object_mut().ok_or("自定义模型必须是对象")?;
        models.entry(bare.clone()).or_insert_with(|| json!({}));
    }
    object.insert("defaultModel".into(), json!(format!("custom_provider:{id}/{bare}")));
    write_variant(object, variant);
    Ok(())
}

fn write_variant(object: &mut serde_json::Map<String, Value>, variant: Option<String>) {
    match variant.filter(|value| !value.is_empty()) {
        Some(variant) => {
            object.insert("defaultModelVariant".into(), json!(variant));
        }
        None => {
            object.remove("defaultModelVariant");
        }
    }
}

fn ensure_custom(object: &mut serde_json::Map<String, Value>, id: &str) -> Result<(), String> {
    let providers = object.entry("custom_provider".to_owned()).or_insert_with(|| json!({}));
    let providers = providers.as_object_mut().ok_or("custom_provider 必须是对象")?;
    if !providers.contains_key(id) {
        providers.insert(
            id.to_owned(),
            json!({
                "name": id,
                "api": "anthropic-messages",
                "enabled": true,
                "models": {},
                "options": {}
            }),
        );
        return Ok(());
    }
    let entry = providers.get_mut(id).and_then(Value::as_object_mut).ok_or("自定义供应商必须是对象")?;
    entry.entry("name".to_owned()).or_insert_with(|| json!(id));
    entry.entry("api".to_owned()).or_insert_with(|| json!("anthropic-messages"));
    entry.entry("enabled".to_owned()).or_insert_with(|| json!(true));
    entry.entry("models".to_owned()).or_insert_with(|| json!({}));
    entry.entry("options".to_owned()).or_insert_with(|| json!({}));
    Ok(())
}

fn custom_entry<'a>(
    object: &'a mut serde_json::Map<String, Value>,
    id: &str,
) -> Result<&'a mut serde_json::Map<String, Value>, String> {
    object
        .get_mut("custom_provider")
        .and_then(Value::as_object_mut)
        .and_then(|providers| providers.get_mut(id))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "自定义供应商不存在".into())
}

pub(crate) fn overlay(connection: &Connection) -> Result<Value, String> {
    if connection.provider_id == "token_plan" {
        let (model, variant) = official_model(&connection.model)?;
        let mut value = json!({
            "minimaxModelSource": "token_plan",
            "defaultModel": model,
        });
        if let Some(variant) = variant {
            value["defaultModelVariant"] = json!(variant);
        }
        return Ok(value);
    }
    if connection.provider_id == "minimax" {
        let (model, variant) = official_model(&connection.model)?;
        let mut api = json!({});
        if !connection.base_url.trim().is_empty() {
            api["baseURL"] = json!(connection.base_url.trim());
        }
        if let Some(name) = secret_env(connection, DEFAULT_SECRET_ENV) {
            api["apiKey"] = json!(env_reference(&name));
        }
        let mut value = json!({
            "minimaxModelSource": "minimax_api_key",
            "defaultModel": model,
            "minimax_api": api,
        });
        if let Some(variant) = variant {
            value["defaultModelVariant"] = json!(variant);
        }
        return Ok(value);
    }
    let provider = custom_id(&connection.provider_id)?;
    let (model, variant) = custom_model(&connection.model)?;
    let api = api_kind(&connection.interface_format)?;
    let mut options = json!({});
    if !connection.base_url.trim().is_empty() {
        options["baseURL"] = json!(connection.base_url.trim());
    }
    if let Some(name) = secret_env(connection, &custom_secret_env(&provider)) {
        options["apiKey"] = json!(env_reference(&name));
    }
    let mut value = json!({
        "defaultModel": format!("custom_provider:{provider}/{model}"),
        "custom_provider": {
            provider.clone(): {
                "name": provider,
                "api": api,
                "enabled": true,
                "models": { model: {} },
                "options": options,
            }
        }
    });
    if let Some(variant) = variant {
        value["defaultModelVariant"] = json!(variant);
    }
    Ok(value)
}

fn secret_env(connection: &Connection, default_name: &str) -> Option<String> {
    if let Some(name) = connection.auth_env_var.as_deref() {
        return crate::native::profile::valid_env_name(name).then(|| name.to_owned());
    }
    connection.secret_ref.as_ref().map(|_| default_name.to_owned())
}

fn official_model(model: &str) -> Result<(String, Option<String>), String> {
    let (model, variant) = split_variant(model)?;
    if model.starts_with("custom_provider:") {
        return Err("官方来源不能使用自定义供应商模型".into());
    }
    let full = if model.contains('/') {
        model
    } else {
        format!("minimax/{model}")
    };
    Ok((full, variant))
}

fn custom_model(model: &str) -> Result<(String, Option<String>), String> {
    let (model, variant) = split_variant(model)?;
    let bare = model
        .rsplit(['/'])
        .next()
        .filter(|value| !value.is_empty())
        .ok_or("请填写模型")?;
    if bare.contains(':') {
        return Err("自定义模型标识无效".into());
    }
    Ok((bare.to_owned(), variant))
}

fn split_variant(model: &str) -> Result<(String, Option<String>), String> {
    let model = model.trim();
    if model.is_empty() {
        return Err("请填写模型".into());
    }
    let (model, variant) = model
        .split_once('#')
        .map(|(model, variant)| (model, Some(variant.trim().to_owned())))
        .unwrap_or((model, None));
    if model.is_empty() || variant.as_ref().is_some_and(|value| value.is_empty()) {
        return Err("请填写模型".into());
    }
    Ok((model.to_owned(), variant))
}

fn custom_id(provider: &str) -> Result<String, String> {
    if provider.is_empty()
        || provider == "minimax"
        || provider == "token_plan"
        || provider.contains('/')
        || provider.contains('\\')
        || provider.contains("..")
        || !provider.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.'))
    {
        return Err("自定义供应商标识无效".into());
    }
    Ok(provider.to_owned())
}

fn api_kind(interface: &str) -> Result<&'static str, String> {
    match interface {
        "anthropic_messages" => Ok("anthropic-messages"),
        "openai_completions" => Ok("openai-completions"),
        "openai_responses" => Ok("openai-responses"),
        _ => Err("MiniMax Code 不支持所选接口格式".into()),
    }
}

fn interface_kind(api: &str) -> Result<&'static str, String> {
    match api {
        "anthropic-messages" => Ok("anthropic_messages"),
        "openai-completions" => Ok("openai_completions"),
        "openai-responses" => Ok("openai_responses"),
        _ => Err("自定义供应商接口不在已核对取值内".into()),
    }
}

pub(crate) fn project_connection(root: &Value) -> Result<Option<Connection>, String> {
    let model = root.get("defaultModel").and_then(Value::as_str).unwrap_or("");
    if model.is_empty()
        && root.get("minimaxModelSource").is_none()
        && root.get("custom_provider").is_none()
        && root.get("minimax_api").is_none()
    {
        return Ok(None);
    }
    if let Some(rest) = model.strip_prefix("custom_provider:") {
        let (id, model_name) = rest.split_once('/').ok_or("自定义模型格式无效")?;
        let entry = root.get("custom_provider").and_then(|value| value.get(id));
        let base = entry
            .and_then(|entry| entry.pointer("/options/baseURL"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_owned();
        let api = entry
            .and_then(|entry| entry.get("api"))
            .and_then(Value::as_str)
            .unwrap_or("anthropic-messages");
        let (bare, _) = split_variant(model_name).unwrap_or((model_name.to_owned(), None));
        let variant = root.get("defaultModelVariant").and_then(Value::as_str);
        let model = match variant {
            Some(variant) if !variant.is_empty() && !bare.contains('#') => format!("{bare}#{variant}"),
            _ => bare,
        };
        return Ok(Some(Connection {
            provider_id: id.to_owned(),
            interface_format: interface_kind(api)?.into(),
            base_url: base,
            model,
            secret_ref: None,
            auth_env_var: referenced_env(
                entry.and_then(|entry| entry.pointer("/options/apiKey")).and_then(Value::as_str).unwrap_or(""),
            )
            .map(str::to_owned),
            model_records: Vec::new(),
        }));
    }
    let source = root
        .get("minimaxModelSource")
        .and_then(Value::as_str)
        .unwrap_or("token_plan");
    if source == "minimax_api_key" {
        let base = root
            .pointer("/minimax_api/baseURL")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_owned();
        return Ok(Some(Connection {
            provider_id: "minimax".into(),
            interface_format: "anthropic_messages".into(),
            base_url: base,
            model: display_model(model, root),
            secret_ref: None,
            auth_env_var: referenced_env(
                root.pointer("/minimax_api/apiKey").and_then(Value::as_str).unwrap_or(""),
            )
            .map(str::to_owned),
            model_records: Vec::new(),
        }));
    }
    Ok(Some(Connection {
        provider_id: "token_plan".into(),
        interface_format: "token_plan".into(),
        base_url: TOKEN_PLAN_PROFILE_URL.into(),
        model: display_model(model, root),
        secret_ref: None,
        auth_env_var: None,
        model_records: Vec::new(),
    }))
}

fn display_model(model: &str, root: &Value) -> String {
    let bare = model
        .split_once('#')
        .map(|(model, _)| model)
        .unwrap_or(model)
        .strip_prefix("minimax/")
        .unwrap_or(model);
    let bare = bare.strip_prefix("minimax/").unwrap_or(bare);
    let variant = root.get("defaultModelVariant").and_then(Value::as_str).unwrap_or("");
    if variant.is_empty() || bare.contains('#') || bare.is_empty() {
        bare.to_owned()
    } else {
        format!("{bare}#{variant}")
    }
}

pub(crate) fn contains_plaintext_secret(root: &Value) -> bool {
    plaintext(root.pointer("/minimax_api/apiKey"))
        || root
            .get("custom_provider")
            .and_then(Value::as_object)
            .is_some_and(|providers| {
                providers
                    .values()
                    .any(|entry| plaintext(entry.pointer("/options/apiKey")))
            })
}

fn plaintext(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|text| !text.is_empty() && referenced_env(text).is_none())
}

pub(crate) fn reject_config(root: &Value) -> Result<(), String> {
    if let Some(mode) = root.get("permissionMode").and_then(Value::as_str) {
        if !PERMISSIONS.contains(&mode) {
            return Err("权限模式不在已核对取值内".into());
        }
    }
    if let Some(source) = root.get("minimaxModelSource").and_then(Value::as_str) {
        if !matches!(source, "token_plan" | "minimax_api_key") {
            return Err("登录来源不在已核对取值内".into());
        }
    }
    if let Some(providers) = root.get("custom_provider").and_then(Value::as_object) {
        for (id, entry) in providers {
            custom_id(id)?;
            if let Some(api) = entry.get("api").and_then(Value::as_str) {
                interface_kind(api)?;
            }
        }
    }
    if contains_plaintext_secret(root) {
        return Err("配置正文不能保存 API Key 明文；请使用 ${变量名} 引用".into());
    }
    crate::native::profile::reject_plaintext_secrets(root)
}

pub(crate) fn inspect(settings: &Value) -> crate::adapters::InspectionFields {
    let projected = project_connection(settings).ok().flatten();
    crate::adapters::InspectionFields {
        provider: projected.as_ref().map(|connection| connection.provider_id.clone()),
        model: projected.as_ref().map(|connection| connection.model.clone()),
        base: projected.as_ref().map(|connection| connection.base_url.clone()),
        wire: None,
        env: projected.as_ref().and_then(|connection| connection.auth_env_var.clone()),
        reasoning_effort: None,
    }
}

pub(crate) fn import_literal_secrets(
    files: &mut BTreeMap<String, String>,
    found: &mut NativeInspection,
    pending: &mut Vec<(String, String)>,
    native_refs: &mut BTreeMap<String, BTreeMap<String, String>>,
) -> Result<(), String> {
    let Some(text) = files.get("config").cloned() else {
        return Ok(());
    };
    let mut parsed = format::parse(FileKind::Yaml, &text)?;
    let mut replaced = false;
    if let Some(secret) = take_plaintext(parsed.pointer_mut("/minimax_api/apiKey")) {
        let env = DEFAULT_SECRET_ENV.to_owned();
        assign_secret(&mut parsed, &["minimax_api", "apiKey"], &env, &secret, "minimax", found, pending, native_refs)?;
        replaced = true;
    }
    let ids: Vec<String> = parsed
        .get("custom_provider")
        .and_then(Value::as_object)
        .map(|providers| providers.keys().cloned().collect())
        .unwrap_or_default();
    for id in ids {
        let pointer = format!("/custom_provider/{}/options/apiKey", pointer_token(&id));
        let Some(secret) = take_plaintext(parsed.pointer_mut(&pointer)) else {
            continue;
        };
        let env = custom_secret_env(&id);
        assign_secret(
            &mut parsed,
            &["custom_provider", &id, "options", "apiKey"],
            &env,
            &secret,
            &id,
            found,
            pending,
            native_refs,
        )?;
        replaced = true;
    }
    if replaced {
        files.insert("config".into(), format::render(FileKind::Yaml, &parsed)?);
    }
    Ok(())
}

fn take_plaintext(value: Option<&mut Value>) -> Option<String> {
    let value = value?;
    let text = value.as_str()?.to_owned();
    if text.is_empty() || referenced_env(&text).is_some() {
        return None;
    }
    *value = json!(env_reference("placeholder"));
    Some(text)
}

#[allow(clippy::too_many_arguments)]
fn assign_secret(
    parsed: &mut Value,
    path: &[&str],
    env: &str,
    secret: &str,
    provider: &str,
    found: &mut NativeInspection,
    pending: &mut Vec<(String, String)>,
    native_refs: &mut BTreeMap<String, BTreeMap<String, String>>,
) -> Result<(), String> {
    let id = format!("connection-{}", uuid::Uuid::new_v4());
    set_path(parsed, path, json!(env_reference(env)))?;
    native_refs
        .entry("config".into())
        .or_default()
        .insert(env.to_owned(), id.clone());
    if found
        .connection
        .as_ref()
        .is_some_and(|connection| connection.provider_id == provider)
    {
        let connection = found.connection.as_mut().unwrap();
        connection.secret_ref = Some(id.clone());
        connection.auth_env_var = Some(env.to_owned());
    }
    pending.push((id, secret.to_owned()));
    Ok(())
}

fn set_path(root: &mut Value, path: &[&str], value: Value) -> Result<(), String> {
    let mut cursor = root;
    for (index, segment) in path.iter().enumerate() {
        if index + 1 == path.len() {
            let object = cursor.as_object_mut().ok_or("配置路径不是对象")?;
            object.insert((*segment).to_owned(), value);
            return Ok(());
        }
        cursor = cursor
            .as_object_mut()
            .and_then(|object| object.get_mut(*segment))
            .ok_or("配置路径不存在")?;
    }
    Err("配置路径为空".into())
}

fn pointer_token(segment: &str) -> String {
    segment.replace('~', "~0").replace('/', "~1")
}
