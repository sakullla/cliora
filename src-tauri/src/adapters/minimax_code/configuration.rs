//! `config.yaml` projection. Overlays write only the active source so Token
//! Plan, the MiniMax API key, and a custom provider do not replace each other.
use super::{custom_secret_env, env_reference, referenced_env, MiniMaxCode, DEFAULT_SECRET_ENV, TOKEN_PLAN_PROFILE_URL};
use crate::adapters::configuration::{
    ConfigurationAction, ConfigurationAdapter, ConfigurationDescriptor, ConfigurationField,
    ConfigurationIssue, Documents, EditingState, PortableFieldKind, EDITING_VERSION,
};
use crate::native::format::{self, FileKind};
use crate::native::intake::NativeInspection;
use crate::native::profile::Connection;
use crate::native::adapter::Scope;
use serde_json::{json, Value};
use std::collections::BTreeMap;

const PERMISSIONS: &[&str] = &["default", "auto", "bypassPermissions", "off"];

impl ConfigurationAdapter for MiniMaxCode {
    fn describe(&self, _scope: Scope) -> ConfigurationDescriptor {
        ConfigurationDescriptor {
            version: EDITING_VERSION,
            operations: vec!["set".into(), "reset".into()],
            fields: vec![
                field("source", "登录来源", "choice", &["token_plan", "minimax_api_key"]),
                field("model", "模型", "text", &[]),
                field("baseUrl", "请求地址", "text", &[]),
                field("permissionMode", "权限模式", "choice", PERMISSIONS),
            ],
        }
    }
    fn field_locations(&self, field: &str, _documents: &Documents) -> Vec<(String, Vec<String>)> {
        let path = match field {
            "source" => vec!["minimaxModelSource".into()],
            "model" => vec!["defaultModel".into()],
            "permissionMode" => vec!["permissionMode".into()],
            _ => return Vec::new(),
        };
        vec![("config".into(), path)]
    }
    fn read(&self, documents: &Documents, _state: &EditingState) -> Result<Value, String> {
        let root = documents.get("config").cloned().unwrap_or_else(|| json!({}));
        Ok(json!({
            "source": root.get("minimaxModelSource").and_then(Value::as_str).unwrap_or("token_plan"),
            "model": root.get("defaultModel").and_then(Value::as_str).unwrap_or(""),
            "permissionMode": root.get("permissionMode").and_then(Value::as_str).unwrap_or(""),
            "baseUrl": root.pointer("/minimax_api/baseURL").and_then(Value::as_str).unwrap_or(""),
        }))
    }
    fn edit(
        &self,
        documents: &mut Documents,
        state: &mut EditingState,
        action: &ConfigurationAction,
    ) -> Result<(), String> {
        if !matches!(action.operation.as_str(), "set" | "reset") {
            return Err("MiniMax Code 未声明此编辑动作".into());
        }
        let field = action.field.clone().unwrap_or_default();
        let root = documents.entry("config".into()).or_insert_with(|| json!({}));
        let object = root.as_object_mut().ok_or("config.yaml 顶层必须是对象")?;
        match (action.operation.as_str(), field.as_str()) {
            ("reset", "permissionMode") => {
                object.remove("permissionMode");
            }
            ("set", "permissionMode") => {
                let value = text(action).ok_or("权限模式不在已核对取值内")?;
                if !PERMISSIONS.contains(&value) {
                    return Err("权限模式不在已核对取值内".into());
                }
                object.insert(field, json!(value));
            }
            ("set", "source") => {
                let value = text(action).ok_or("登录来源不在已核对取值内")?;
                if !matches!(value, "token_plan" | "minimax_api_key") {
                    return Err("登录来源不在已核对取值内".into());
                }
                object.insert("minimaxModelSource".into(), json!(value));
            }
            ("set", "model") => {
                let value = text(action).filter(|value| !value.is_empty()).ok_or("请填写模型")?;
                object.insert("defaultModel".into(), json!(value));
            }
            _ => return Err("此字段请通过连接或原始配置修改".into()),
        }
        state.intents.push(action.clone());
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
