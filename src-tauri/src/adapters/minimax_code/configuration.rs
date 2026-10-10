use super::MiniMaxCode;
use crate::adapters::configuration::*;
use crate::native::{adapter::Scope, profile::Connection};
use serde_json::{json, Value};
const FIELDS: &[(&str, &str, &[&str])] = &[
    ("defaultModel", "string", &[]),
    (
        "permissionMode",
        "string",
        &["default", "auto", "off", "bypassPermissions"],
    ),
    (
        "minimaxModelSource",
        "string",
        &["token_plan", "minimax_api_key"],
    ),
    ("skills.external.enabled", "boolean", &[]),
    ("skills.external.walkUp", "boolean", &[]),
];
pub(super) fn wire(value: &str) -> Option<&'static str> {
    match value {
        "anthropic_messages" | "anthropic-messages" => Some("anthropic_messages"),
        "openai_completions" | "openai-completions" => Some("openai_completions"),
        "openai_responses" | "openai-responses" => Some("openai_responses"),
        _ => None,
    }
}
fn provider_key(id: &str) -> Result<&str, String> {
    let id = id.strip_prefix("custom_provider:").unwrap_or(id);
    if id.is_empty()
        || [
            "minimax",
            "minimax_api",
            "provider",
            "custom_provider",
            "__proto__",
            "constructor",
            "prototype",
        ]
        .contains(&id)
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("MiniMax 自定义供应商 ID 无效或为保留名称；官方 API 使用 minimax_api，官方登录使用原生认证".into());
    }
    Ok(id)
}
pub(super) fn key_path(id: &str) -> Result<Vec<String>, String> {
    if id == "minimax_api" {
        Ok(vec!["minimax_api".into(), "apiKey".into()])
    } else {
        Ok(vec![
            "custom_provider".into(),
            provider_key(id)?.into(),
            "options".into(),
            "apiKey".into(),
        ])
    }
}
pub(super) fn connection_document(connection: &Connection) -> Result<Value, String> {
    if connection.auth_env_var.is_some() {
        return Err("MiniMax BYOK 从 config.yaml 读取 API key，不支持将环境变量名当作密钥".into());
    }
    let api = wire(&connection.interface_format)
        .ok_or("MiniMax 不支持此接口格式")?
        .replace('_', "-");
    if connection.provider_id == "minimax_api" {
        if api != "anthropic-messages" {
            return Err("MiniMax 官方 API 只使用 Anthropic Messages 格式".into());
        }
        return Ok(
            json!({"minimaxModelSource":"minimax_api_key", "defaultModel":format!("minimax_api/{}", connection.model), "minimax_api":{"baseURL":connection.base_url}}),
        );
    }
    let id = provider_key(&connection.provider_id)?;
    Ok(
        json!({"defaultModel":format!("custom_provider:{id}/{}",connection.model),"custom_provider":{id:{"kind":"custom","enabled":true,"api":api,"options":{"authMode":"api-key","baseURL":connection.base_url},"models":{&connection.model:{"name":connection.model,"enabled":true,"configuration_source":"manual"}}}}}),
    )
}
pub(super) fn read_connection(root: &Value) -> Result<Option<Connection>, String> {
    let Some((provider, model)) = root["defaultModel"]
        .as_str()
        .and_then(|v| v.split_once('/'))
    else {
        return Ok(None);
    };
    let (provider_id, options, api) = if provider == "minimax_api"
        || provider == "minimax" && root["minimaxModelSource"] == "minimax_api_key"
    {
        (
            "minimax_api".to_owned(),
            &root["minimax_api"],
            "anthropic_messages",
        )
    } else if let Some(id) = provider.strip_prefix("custom_provider:") {
        provider_key(id)?;
        let entry = &root["custom_provider"][id];
        let Some(api) = entry["api"].as_str().and_then(wire) else {
            return Ok(None);
        };
        (id.to_owned(), &entry["options"], api)
    } else {
        return Ok(None);
    };
    let Some(base) = options["baseURL"].as_str().filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    Ok(Some(Connection {
        provider_id,
        interface_format: api.into(),
        base_url: base.into(),
        model: model.into(),
        secret_ref: None,
        auth_env_var: None,
        model_records: vec![],
    }))
}
pub(super) fn validate(root: &Value) -> Result<(), String> {
    if !root.is_object() {
        return Err("MiniMax config.yaml 必须是对象".into());
    }
    if root.get("provider").is_some_and(|value| !value.is_object()) {
        return Err("MiniMax provider 必须是对象".into());
    }
    for (field, kind, choices) in FIELDS {
        let pointer = format!("/{}", field.replace('.', "/"));
        if let Some(value) = root.pointer(&pointer) {
            if (*kind == "boolean" && !value.is_boolean())
                || (*kind == "string" && !value.is_string())
                || !choices.is_empty() && !value.as_str().is_some_and(|v| choices.contains(&v))
            {
                return Err(format!("MiniMax 设置 {field} 类型或值无效"));
            }
        }
    }
    if let Some(providers) = root.get("custom_provider") {
        for (id, entry) in providers.as_object().ok_or("custom_provider 必须是对象")? {
            provider_key(id)?;
            if !entry.is_object() {
                return Err("自定义供应商必须是对象".into());
            }
            if entry
                .get("api")
                .is_some_and(|v| v.as_str().and_then(wire).is_none())
            {
                return Err("自定义供应商 api 格式无效".into());
            }
            if entry
                .pointer("/options/authMode")
                .is_some_and(|v| v != "api-key")
            {
                return Err("自定义 BYOK 只能使用 api-key，不能借用官方登录".into());
            }
        }
    }
    if root.get("minimax_api").is_some_and(|v| !v.is_object()) {
        return Err("minimax_api 必须是对象".into());
    }
    Ok(())
}
impl ConfigurationAdapter for MiniMaxCode {
    fn describe(&self, _: Scope) -> ConfigurationDescriptor {
        ConfigurationDescriptor {
            version: 1,
            operations: vec!["set".into(), "reset".into(), "configure_connection".into()],
            fields: FIELDS
                .iter()
                .map(|(id, kind, choices)| ConfigurationField {
                    id: (*id).into(),
                    label: (*id).into(),
                    kind: (*kind).into(),
                    required: false,
                    advanced: false,
                    choices: choices.iter().map(|v| (*v).into()).collect(),
                    minimum: None,
                    default_source: Some("MiniMax Code".into()),
                    unavailable_reason: None,
                    origin: None,
                })
                .collect(),
        }
    }
    fn common_parameters(&self, scope: Scope) -> Vec<CommonParameter> {
        self.describe(scope)
            .fields
            .into_iter()
            .filter(|f| !matches!(f.id.as_str(), "defaultModel" | "minimaxModelSource"))
            .map(|field| CommonParameter {
                path: field.id.split('.').map(str::to_owned).collect(),
                field,
                role: "settings",
                target: json!({"kind":"settings"}),
            })
            .collect()
    }
    fn field_locations(&self, field: &str, _: &Documents) -> Vec<(String, Vec<String>)> {
        FIELDS
            .iter()
            .any(|f| f.0 == field)
            .then(|| {
                vec![(
                    "settings".into(),
                    field.split('.').map(str::to_owned).collect(),
                )]
            })
            .unwrap_or_default()
    }
    fn read(&self, documents: &Documents, _: &EditingState) -> Result<Value, String> {
        let root = documents
            .get("settings")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let mut view: serde_json::Map<String, Value> = FIELDS
            .iter()
            .map(|(id, _, _)| {
                (
                    (*id).into(),
                    root.pointer(&format!("/{}", id.replace('.', "/")))
                        .cloned()
                        .unwrap_or(Value::Null),
                )
            })
            .collect();
        view.insert(
            "connection".into(),
            serde_json::to_value(read_connection(&root)?).map_err(|e| e.to_string())?,
        );
        Ok(Value::Object(view))
    }
    fn edit(
        &self,
        documents: &mut Documents,
        state: &mut EditingState,
        action: &ConfigurationAction,
    ) -> Result<(), String> {
        if action.version == 1
            && action.operation == "configure_connection"
            && action.target == json!({"kind":"connection"})
        {
            let connection: Connection =
                serde_json::from_value(action.value.clone().ok_or("连接字段缺失")?)
                    .map_err(|_| "连接字段无效")?;
            if connection.secret_ref.is_some() || connection.auth_env_var.is_some() {
                return Err("凭据必须通过共享凭据入口设置".into());
            }
            crate::native::profile::validate_connection(&connection)?;
            let overlay = connection_document(&connection)?;
            let root = documents
                .entry("settings".into())
                .or_insert_with(|| json!({}));
            *root = crate::native::format::resolve(root, &overlay, &[])?.0;
            state
                .intents
                .retain(|old| old.operation != "configure_connection");
            state.intents.push(action.clone());
            return Ok(());
        }
        if action.version != 1
            || action.target != json!({"kind":"settings"})
            || !["set", "reset"].contains(&action.operation.as_str())
        {
            return Err("MiniMax 设置操作无效".into());
        }
        let field = action
            .field
            .as_deref()
            .filter(|id| FIELDS.iter().any(|f| f.0 == *id))
            .ok_or("未声明的 MiniMax 设置字段")?;
        let root = documents
            .entry("settings".into())
            .or_insert_with(|| json!({}));
        let path: Vec<_> = field.split('.').map(str::to_owned).collect();
        let text = crate::native::format::render(crate::native::format::FileKind::Json, root)?;
        let value = if action.operation == "reset" {
            None
        } else {
            Some(action.value.as_ref().ok_or("设置值缺失")?)
        };
        let text = crate::native::format::set_path(
            crate::native::format::FileKind::Json,
            &text,
            &path,
            value,
        )?;
        let next = crate::native::format::parse(crate::native::format::FileKind::Json, &text)?;
        validate(&next)?;
        *root = next;
        state.intents.retain(|old| old.field != action.field);
        state.intents.push(action.clone());
        Ok(())
    }
    fn reconcile_text(
        &self,
        _: Option<&Documents>,
        _: &Documents,
        _: &Documents,
        state: &mut EditingState,
    ) -> Result<(), String> {
        state.intents.clear();
        Ok(())
    }
    fn validate_changes(
        &self,
        previous: Option<&Documents>,
        next: &Documents,
        _: &EditingState,
        _: Scope,
    ) -> Vec<ConfigurationIssue> {
        let before = previous
            .and_then(|docs| docs.get("settings"))
            .and_then(|root| root.get("provider"));
        let after = next.get("settings").and_then(|root| root.get("provider"));
        if before == after {
            Vec::new()
        } else {
            vec![ConfigurationIssue { target:json!({"kind":"settings"}),field:None,code:"native_auth_owned".into(),message:"provider 是官方登录/兼容配置，保留原值由 mcode 管理；BYOK 使用 minimax_api 或 custom_provider".into() }]
        }
    }
    fn validate(
        &self,
        documents: &Documents,
        _: &EditingState,
        scope: Scope,
    ) -> Vec<ConfigurationIssue> {
        let error = if scope != Scope::Global {
            Some("MiniMax 模型配置仅支持用户级".into())
        } else {
            documents.get("settings").and_then(|r| validate(r).err())
        };
        error
            .map(|message| {
                vec![ConfigurationIssue {
                    target: json!({"kind":"settings"}),
                    field: None,
                    code: "invalid_settings".into(),
                    message,
                }]
            })
            .unwrap_or_default()
    }
    fn connection(
        &self,
        documents: &Documents,
        _: &EditingState,
    ) -> Result<Option<Connection>, String> {
        read_connection(documents.get("settings").unwrap_or(&Value::Null))
    }
    fn credential_paths(&self, connection: &Connection) -> Vec<(&'static str, Vec<String>)> {
        key_path(&connection.provider_id)
            .map(|p| vec![("settings", p)])
            .unwrap_or_default()
    }
    fn portable_field_kind(&self, path: &[String]) -> PortableFieldKind {
        if path.first().map(String::as_str) != Some("settings") {
            return PortableFieldKind::Unknown;
        }
        if path.last().is_some_and(|p| p == "apiKey") {
            PortableFieldKind::Credential
        } else if path.get(1).is_some_and(|p| {
            [
                "defaultModel",
                "minimaxModelSource",
                "custom_provider",
                "minimax_api",
                "permissionMode",
                "skills",
                "notifications",
                "tui",
                "logLevel",
            ]
            .contains(&p.as_str())
        }) {
            PortableFieldKind::Parameter
        } else {
            PortableFieldKind::Unknown
        }
    }
    fn managed_fields(
        &self,
        _: &str,
        _: &Value,
        desired: &Value,
        profile: &crate::native::profile::RegisteredProfile,
    ) -> Result<ManagedConfiguration, String> {
        let mut fields = std::collections::BTreeMap::new();
        crate::native::apply::flatten(desired, &mut vec![], &mut fields);
        let released = profile
            .editing
            .as_ref()
            .map(|s| {
                s.intents
                    .iter()
                    .filter(|a| a.operation == "reset")
                    .filter_map(|a| a.field.as_ref())
                    .filter(|id| FIELDS.iter().any(|f| f.0 == id.as_str()))
                    .map(|id| {
                        location_pointer(&id.split('.').map(str::to_owned).collect::<Vec<_>>())
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(ManagedConfiguration {
            fields: fields.into_iter().map(|(k, v)| (k, Some(v))).collect(),
            released,
        })
    }
}
