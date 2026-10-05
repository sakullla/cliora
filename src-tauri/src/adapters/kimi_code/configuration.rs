//! npm Kimi Code's .kimi-code/config.toml model aliases. Alias is not a request ID.
use super::KimiCode;
use crate::adapters::{configuration::*, pointer_token};
use crate::native::{
    adapter::Scope,
    profile::{Connection, ModelRecord, RegisteredProfile},
};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
const MODEL_FIELDS: &[&str] = &[
    "provider",
    "model",
    "max_context_size",
    "max_input_size",
    "max_output_size",
    "capabilities",
    "display_name",
    "support_efforts",
    "default_effort",
    "adaptive_thinking",
    "protocol",
];
const SETTINGS: &[&str] = &["thinking.enabled", "thinking.effort", "thinking.keep"];
fn root(documents: &Documents) -> Value {
    documents
        .get("settings")
        .cloned()
        .unwrap_or_else(|| json!({}))
}
fn target(action: &ConfigurationAction) -> Result<(&str, &str, &str), String> {
    let kind = action
        .target
        .get("kind")
        .and_then(Value::as_str)
        .ok_or("缺少目标类型")?;
    let provider = action
        .target
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("");
    let id = action
        .target
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("");
    if kind == "model"
        && (id.trim().is_empty() || id.len() > 200 || id.chars().any(char::is_control))
    {
        return Err("模型 alias 无效".into());
    }
    if kind == "provider"
        && (provider.trim().is_empty()
            || provider.len() > 80
            || provider.chars().any(char::is_control))
    {
        return Err("供应商标识无效".into());
    }
    Ok((kind, provider, id))
}
fn set(root: &mut Value, path: &[String], value: Option<Value>) -> Result<(), String> {
    let mut node = root;
    for key in &path[..path.len() - 1] {
        if node.get(key).is_none() {
            if value.is_none() {
                return Ok(());
            }
            node[key] = json!({});
        }
        node = node.get_mut(key).ok_or("缺少字段父级")?;
        if !node.is_object() {
            return Err("字段父级不是原生对象；请先修正原文".into());
        }
    }
    let map = node.as_object_mut().ok_or("字段目标不是对象")?;
    if let Some(value) = value {
        map.insert(path.last().unwrap().clone(), value);
    } else {
        map.remove(path.last().unwrap());
    }
    Ok(())
}
fn pointer(path: &[String]) -> String {
    format!(
        "/{}",
        path.iter()
            .map(|part| pointer_token(part))
            .collect::<Vec<_>>()
            .join("/")
    )
}
fn alias_provider(root: &Value, alias: &str) -> Option<String> {
    root.get("models")?
        .get(alias)?
        .get("provider")?
        .as_str()
        .map(str::to_owned)
}
fn selected(root: &Value, state: &EditingState) -> Option<String> {
    state.selected_provider.clone().or_else(|| {
        root.get("default_model")
            .and_then(Value::as_str)
            .and_then(|alias| alias_provider(root, alias))
    })
}
fn model_target(id: &str, provider: &str) -> Value {
    json!({"kind":"model","provider":provider,"id":id})
}
fn issue(target: Value, field: &str, message: &str) -> ConfigurationIssue {
    ConfigurationIssue {
        target,
        field: Some(field.into()),
        code: "invalid_native_value".into(),
        message: message.into(),
    }
}
fn association(root: &Value, alias: &str) -> bool {
    root.get("secondary_model").is_some_and(|secondary| {
        ["model", "default_model"]
            .iter()
            .any(|key| secondary.get(*key).and_then(Value::as_str) == Some(alias))
            || secondary
                .get("models")
                .and_then(Value::as_object)
                .is_some_and(|models| models.values().any(|value| value.as_str() == Some(alias)))
    })
}
fn description(
    id: &str,
    label: &str,
    kind: &str,
    required: bool,
    advanced: bool,
    scope: Scope,
) -> ConfigurationField {
    ConfigurationField {
        id: id.into(),
        label: label.into(),
        kind: kind.into(),
        required,
        advanced,
        choices: vec![],
        minimum: matches!(kind, "integer").then_some(1.0),
        default_source: (!required).then(|| "跟随原生默认".into()),
        unavailable_reason: (scope == Scope::Project)
            .then(|| "Kimi 模型配置只支持用户级 config.toml".into()),
    }
}

impl ConfigurationAdapter for KimiCode {
    fn portable_reference_valid(&self, path: &[String], value: &Value) -> bool {
        path.last().is_some_and(|field| field == "api_key_env")
            && value
                .as_str()
                .is_some_and(crate::native::profile::valid_env_name)
    }

    fn describe(&self, scope: Scope) -> ConfigurationDescriptor {
        ConfigurationDescriptor {
            version: 1,
            operations: if scope == Scope::Project {
                vec![]
            } else {
                [
                    "configure_provider",
                    "select_provider",
                    "create",
                    "copy",
                    "rename",
                    "delete",
                    "default",
                    "set",
                    "reset",
                ]
                .iter()
                .map(|value| (*value).into())
                .collect()
            },
            fields: vec![
                description("model", "请求模型 ID", "string", true, false, scope),
                description("provider", "供应商 ID", "string", true, false, scope),
                description(
                    "max_context_size",
                    "上下文上限",
                    "integer",
                    true,
                    false,
                    scope,
                ),
                description("display_name", "显示名称", "string", false, false, scope),
                description("max_input_size", "输入上限", "integer", false, true, scope),
                description("max_output_size", "输出上限", "integer", false, true, scope),
                description("capabilities", "原生能力声明", "json", false, true, scope),
                description(
                    "support_efforts",
                    "支持的思考档位",
                    "json",
                    false,
                    true,
                    scope,
                ),
                description(
                    "default_effort",
                    "模型思考档位",
                    "string",
                    false,
                    true,
                    scope,
                ),
                description(
                    "adaptive_thinking",
                    "自适应思考",
                    "boolean",
                    false,
                    true,
                    scope,
                ),
                description("protocol", "模型协议", "string", false, true, scope),
                description(
                    "thinking.enabled",
                    "默认启用思考",
                    "boolean",
                    false,
                    true,
                    scope,
                ),
                description(
                    "thinking.effort",
                    "默认思考档位",
                    "string",
                    false,
                    true,
                    scope,
                ),
                description(
                    "thinking.keep",
                    "思考内容保留",
                    "string",
                    false,
                    true,
                    scope,
                ),
            ],
        }
    }
    fn read(&self, documents: &Documents, state: &EditingState) -> Result<Value, String> {
        let root = root(documents);
        let provider = selected(&root, state);
        let entry = provider
            .as_ref()
            .and_then(|id| {
                root.get("providers")
                    .and_then(|providers| providers.get(id))
            })
            .cloned()
            .unwrap_or_else(|| json!({}));
        let models = root
            .get("models")
            .and_then(Value::as_object)
            .map(|models| {
                models
                    .iter()
                    .filter(|(_, model)| {
                        provider.as_ref().is_none_or(|provider| {
                            model.get("provider").and_then(Value::as_str) == Some(provider)
                        })
                    })
                    .map(|(alias, model)| json!({"id":alias,"kind":"model","fields":model}))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        Ok(
            json!({"providerId":provider,"providers":root.get("providers").and_then(Value::as_object).map(|providers|providers.keys().cloned().collect::<Vec<_>>()).unwrap_or_default(),"models":models,"defaultModel":root.get("default_model"),"settings":root.get("thinking").cloned().unwrap_or_else(||json!({})),"connection":{"baseUrl":entry.get("base_url"),"protocol":entry.get("type"),"readOnlyReason":if entry.get("oauth").is_some(){"由 Kimi 原生登录管理，模型可编辑；凭据不接管"}else{""}},"capabilityReason":"模型能力取自原生声明；没有元数据时保持未核验"}),
        )
    }
    fn edit(
        &self,
        documents: &mut Documents,
        state: &mut EditingState,
        action: &ConfigurationAction,
    ) -> Result<(), String> {
        let effective = documents.clone();
        self.edit_inherited(documents, &effective, state, action)
    }
    fn edit_inherited(
        &self,
        documents: &mut Documents,
        effective: &Documents,
        state: &mut EditingState,
        action: &ConfigurationAction,
    ) -> Result<(), String> {
        let (kind, provider, id) = target(action)?;
        let effective = root(effective);
        let root = documents
            .entry("settings".into())
            .or_insert_with(|| json!({}));
        if action.operation == "select_provider" {
            if effective
                .get("providers")
                .and_then(|providers| providers.get(provider))
                .is_none()
            {
                return Err("供应商不存在".into());
            }
            state.selected_provider = Some(provider.into());
            return Ok(());
        }
        if action.operation == "configure_provider" {
            if kind != "provider" {
                return Err("连接目标必须是供应商".into());
            }
            if effective
                .get("providers")
                .and_then(|providers| providers.get(provider))
                .is_some_and(|provider| provider.get("oauth").is_some())
            {
                return Err("原生 OAuth 供应商连接只读；请创建独立供应商设置 API 连接".into());
            }
            let value = action
                .value
                .as_ref()
                .and_then(Value::as_object)
                .ok_or("缺少连接字段")?;
            let base = value
                .get("baseUrl")
                .and_then(Value::as_str)
                .filter(|base| !base.is_empty())
                .ok_or("连接地址必填")?;
            let kind = super::provider_type(
                value
                    .get("interfaceFormat")
                    .and_then(Value::as_str)
                    .ok_or("缺少接口协议")?,
            )?;
            set(
                root,
                &["providers".into(), provider.into(), "type".into()],
                Some(json!(kind)),
            )?;
            set(
                root,
                &["providers".into(), provider.into(), "base_url".into()],
                Some(json!(base)),
            )?;
            state.selected_provider = Some(provider.into());
            return Ok(());
        }
        if kind == "settings" {
            let field = action.field.as_deref().ok_or("缺少设置字段")?;
            if !SETTINGS.contains(&field) {
                return Err("未声明此设置；npm 2.1.1 使用 thinking section".into());
            }
            if !matches!(action.operation.as_str(), "set" | "reset") {
                return Err("未声明此设置动作".into());
            }
            return set(
                root,
                &field.split('.').map(str::to_owned).collect::<Vec<_>>(),
                if action.operation == "reset" {
                    None
                } else {
                    action.value.clone()
                },
            );
        }
        if kind != "model" {
            return Err("未声明此目标类型".into());
        }
        let existing = effective.get("models").and_then(|models| models.get(id));
        match action.operation.as_str() {
            "create" => {
                if existing.is_some() {
                    return Err("alias 已存在".into());
                }
                let mut value = action.value.clone().unwrap_or_else(|| json!({}));
                let fields = value.as_object_mut().ok_or("模型字段必须是对象")?;
                if fields
                    .keys()
                    .any(|field| !MODEL_FIELDS.contains(&field.as_str()))
                {
                    return Err("新增模型含未声明字段；扩展字段请使用原生文本".into());
                }
                fields.entry("provider").or_insert(json!(provider));
                set(root, &["models".into(), id.into()], Some(value))?;
            }
            "copy" | "rename" => {
                let next = action
                    .value
                    .as_ref()
                    .and_then(Value::as_str)
                    .filter(|id| {
                        !id.trim().is_empty()
                            && id.len() <= 200
                            && !id.chars().any(char::is_control)
                    })
                    .ok_or("新 alias 无效")?;
                if effective
                    .get("models")
                    .and_then(|models| models.get(next))
                    .is_some()
                {
                    return Err("新 alias 已存在".into());
                }
                if action.operation == "rename" && association(&effective, id) {
                    return Err("secondary_model 仍引用此 alias；请先修改关联引用".into());
                }
                set(
                    root,
                    &["models".into(), next.into()],
                    Some(existing.ok_or("模型不存在")?.clone()),
                )?;
                if action.operation == "rename" {
                    set(root, &["models".into(), id.into()], None)?;
                    if effective.get("default_model").and_then(Value::as_str) == Some(id) {
                        set(root, &["default_model".into()], Some(json!(next)))?;
                    }
                }
            }
            "delete" => {
                if existing.is_none() {
                    return Err("模型不存在".into());
                }
                if effective.get("default_model").and_then(Value::as_str) == Some(id)
                    || association(&effective, id)
                {
                    return Err("此 alias 仍被默认或 secondary_model 引用，请先选择替代模型".into());
                }
                set(root, &["models".into(), id.into()], None)?;
            }
            "default" => {
                if existing.is_none() {
                    return Err("模型不存在".into());
                }
                set(root, &["default_model".into()], Some(json!(id)))?;
            }
            "set" | "reset" => {
                let field = action.field.as_deref().ok_or("缺少模型字段")?;
                if !MODEL_FIELDS.contains(&field) {
                    return Err("未声明此模型字段".into());
                }
                if action.operation == "reset"
                    && matches!(field, "provider" | "model" | "max_context_size")
                {
                    // Removing this layer is valid only if the inherited model supplies the required value.
                }
                if existing.is_none() {
                    return Err("模型不存在".into());
                }
                set(
                    root,
                    &["models".into(), id.into(), field.into()],
                    if action.operation == "reset" {
                        None
                    } else {
                        action.value.clone()
                    },
                )?;
            }
            _ => return Err("未声明此编辑动作".into()),
        }
        // Moving an alias does not silently navigate away from other pending models.
        if state.selected_provider.is_none() {
            state.selected_provider = existing
                .and_then(|model| model.get("provider"))
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| (!provider.is_empty()).then(|| provider.to_owned()));
        }
        Ok(())
    }
    fn validate(
        &self,
        documents: &Documents,
        _: &EditingState,
        scope: Scope,
    ) -> Vec<ConfigurationIssue> {
        let root = root(documents);
        let mut issues = vec![];
        if scope == Scope::Project && !root.as_object().is_none_or(Map::is_empty) {
            issues.push(issue(
                json!({"kind":"settings"}),
                "scope",
                "Kimi 用户模型配置不支持项目范围",
            ));
        }
        if root.get("default_thinking").is_some() {
            issues.push(issue(
                json!({"kind":"settings"}),
                "default_thinking",
                "npm 2.1.1 不使用 default_thinking；请迁移为 [thinking] enabled/effort",
            ));
        }
        if let Some(models) = root.get("models") {
            if let Some(models) = models.as_object() {
                for (alias, model) in models {
                    let provider = model.get("provider").and_then(Value::as_str).unwrap_or("");
                    let target = model_target(alias, provider);
                    if alias.trim().is_empty() || !model.is_object() {
                        issues.push(issue(target.clone(), "id", "alias 和模型字段对象无效"));
                        continue;
                    }
                    if provider.is_empty()
                        || root
                            .get("providers")
                            .and_then(|providers| providers.get(provider))
                            .is_none()
                    {
                        issues.push(issue(
                            target.clone(),
                            "provider",
                            "模型须指向实际存在的供应商表",
                        ));
                    }
                    if !model
                        .get("model")
                        .and_then(Value::as_str)
                        .is_some_and(|id| !id.trim().is_empty())
                    {
                        issues.push(issue(target.clone(), "model", "请求模型 ID 必填"));
                    }
                    if !model
                        .get("max_context_size")
                        .and_then(Value::as_u64)
                        .is_some_and(|value| value > 0)
                    {
                        issues.push(issue(
                            target.clone(),
                            "max_context_size",
                            "上下文上限必填，且须为正整数",
                        ));
                    }
                    for field in ["max_input_size", "max_output_size"] {
                        if model
                            .get(field)
                            .is_some_and(|value| !value.as_u64().is_some_and(|value| value > 0))
                        {
                            issues.push(issue(target.clone(), field, "上限须为正整数"));
                        }
                    }
                    for field in ["capabilities", "support_efforts"] {
                        if model.get(field).is_some_and(|value| {
                            !value
                                .as_array()
                                .is_some_and(|items| items.iter().all(Value::is_string))
                        }) {
                            issues.push(issue(target.clone(), field, "此声明须为字符串数组"));
                        }
                    }
                    if let Some(effort) = model.get("default_effort") {
                        if let Some(effort) = effort.as_str() {
                            if model
                                .get("support_efforts")
                                .and_then(Value::as_array)
                                .is_some_and(|levels| {
                                    !levels.iter().any(|value| value.as_str() == Some(effort))
                                })
                            {
                                issues.push(issue(
                                    target.clone(),
                                    "default_effort",
                                    "默认思考档位不在模型声明的 support_efforts 中",
                                ));
                            }
                        } else {
                            issues.push(issue(
                                target.clone(),
                                "default_effort",
                                "思考档位须为字符串",
                            ));
                        }
                    }
                    if model
                        .get("adaptive_thinking")
                        .is_some_and(|value| !value.is_boolean())
                    {
                        issues.push(issue(
                            target.clone(),
                            "adaptive_thinking",
                            "此声明须为布尔值",
                        ));
                    }
                    if model.get("protocol").is_some_and(|value| {
                        !matches!(value.as_str(), Some("anthropic" | "openai_responses"))
                    }) {
                        issues.push(issue(
                            target,
                            "protocol",
                            "npm 2.1.1 模型协议只支持 anthropic/openai_responses",
                        ));
                    }
                }
            } else {
                issues.push(issue(
                    json!({"kind":"settings"}),
                    "models",
                    "models 必须为 alias 表",
                ));
            }
        }
        if let Some(default) = root.get("default_model") {
            if !default.as_str().is_some_and(|id| {
                root.get("models")
                    .and_then(|models| models.get(id))
                    .is_some()
            }) {
                issues.push(issue(
                    json!({"kind":"settings"}),
                    "default_model",
                    "默认模型必须指向存在的 alias",
                ));
            }
        }
        if let Some(thinking) = root.get("thinking") {
            if !thinking.is_object() {
                issues.push(issue(
                    json!({"kind":"settings"}),
                    "thinking",
                    "thinking 必须为独立原生表",
                ));
            }
            if thinking
                .get("enabled")
                .is_some_and(|value| !value.is_boolean())
            {
                issues.push(issue(
                    json!({"kind":"settings"}),
                    "thinking.enabled",
                    "思考开关须为布尔值",
                ));
            }
            for field in ["effort", "keep"] {
                if thinking.get(field).is_some_and(|value| !value.is_string()) {
                    issues.push(issue(
                        json!({"kind":"settings"}),
                        &format!("thinking.{field}"),
                        "思考选项须为字符串",
                    ));
                }
            }
        }
        if let Some(providers) = root.get("providers").and_then(Value::as_object) {
            for (id, provider) in providers {
                if provider.get("type").is_some_and(|value| {
                    !matches!(
                        value.as_str(),
                        Some(
                            "kimi"
                                | "anthropic"
                                | "openai"
                                | "openai_responses"
                                | "google-genai"
                                | "vertexai"
                        )
                    )
                }) {
                    issues.push(issue(
                        json!({"kind":"provider","provider":id}),
                        "type",
                        "此 npm 产品未声明该供应商协议",
                    ));
                }
            }
        }
        issues
    }
    fn connection(
        &self,
        documents: &Documents,
        state: &EditingState,
    ) -> Result<Option<Connection>, String> {
        let root = root(documents);
        let Some(alias) = root.get("default_model").and_then(Value::as_str) else {
            return Ok(None);
        };
        let Some(model) = root.get("models").and_then(|models| models.get(alias)) else {
            return Ok(None);
        };
        let Some(provider) = model.get("provider").and_then(Value::as_str) else {
            return Ok(None);
        };
        if state
            .selected_provider
            .as_ref()
            .is_some_and(|selected| selected != provider)
        {
            return Ok(None);
        };
        let entry = root
            .get("providers")
            .and_then(|providers| providers.get(provider))
            .cloned()
            .unwrap_or_else(|| json!({}));
        let (Some(base), Some(format), Some(request)) = (
            entry.get("base_url").and_then(Value::as_str),
            entry
                .get("type")
                .and_then(Value::as_str)
                .and_then(super::wire_format),
            model.get("model").and_then(Value::as_str),
        ) else {
            return Ok(None);
        };
        if !provider.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
        }) {
            return Ok(None);
        }
        let records = root
            .get("models")
            .and_then(Value::as_object)
            .map(|models| {
                models
                    .iter()
                    .filter(|(_, model)| {
                        model.get("provider").and_then(Value::as_str) == Some(provider)
                    })
                    .filter_map(|(alias, model)| {
                        Some(ModelRecord {
                            id: alias.clone(),
                            fields: model.as_object()?.clone(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(Some(Connection {
            provider_id: provider.into(),
            interface_format: format.into(),
            base_url: base.into(),
            model: request.into(),
            secret_ref: None,
            auth_env_var: entry
                .get("api_key_env")
                .and_then(Value::as_str)
                .map(str::to_owned),
            model_records: records,
        }))
    }
    fn reconcile_suppressions(
        &self,
        previous: Option<&Documents>,
        next: &Documents,
        suppressed: &mut BTreeMap<String, Vec<String>>,
    ) -> Result<(), String> {
        let next = root(next);
        let previous = previous.map(root);
        if let Some(paths) = suppressed.get_mut("settings") {
            paths.retain(|path| {
                !(next.pointer(path).is_some()
                    && previous
                        .as_ref()
                        .is_none_or(|previous| previous.pointer(path).is_none()))
            });
        }
        suppressed.retain(|_, paths| !paths.is_empty());
        Ok(())
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
            let Ok((kind, _, id)) = target(action) else {
                return false;
            };
            match action.operation.as_str() {
                "delete" | "rename" => root
                    .get("models")
                    .and_then(|models| models.get(id))
                    .is_none(),
                "reset" => {
                    let path = if kind == "settings" {
                        action
                            .field
                            .as_deref()
                            .unwrap_or("")
                            .split('.')
                            .map(str::to_owned)
                            .collect::<Vec<_>>()
                    } else {
                        vec![
                            "models".into(),
                            id.into(),
                            action.field.clone().unwrap_or_default(),
                        ]
                    };
                    root.pointer(&pointer(&path)).is_none()
                }
                _ => false,
            }
        });
        Ok(())
    }
    fn suppression_changes(
        &self,
        action: &ConfigurationAction,
    ) -> Result<Vec<SuppressionChange>, String> {
        let (kind, _, id) = target(action)?;
        let path = if kind == "settings" {
            action
                .field
                .as_deref()
                .unwrap_or("")
                .split('.')
                .map(str::to_owned)
                .collect::<Vec<_>>()
        } else {
            let mut path = vec!["models".into(), id.into()];
            if matches!(action.operation.as_str(), "set" | "reset") {
                path.push(action.field.clone().ok_or("缺少字段")?);
            }
            path
        };
        let path = pointer(&path);
        Ok(match action.operation.as_str() {
            "delete" | "rename" => vec![SuppressionChange {
                role: "settings".into(),
                path,
                suppressed: true,
            }],
            "create" | "reset" => vec![SuppressionChange {
                role: "settings".into(),
                path,
                suppressed: false,
            }],
            _ => vec![],
        })
    }
    fn portable_field_kind(&self, path: &[String]) -> PortableFieldKind {
        match path.last().map(String::as_str) {
            Some("max_context_size" | "max_input_size" | "max_output_size") => {
                PortableFieldKind::Parameter
            }
            Some("api_key_env") => PortableFieldKind::CredentialReference,
            Some("api_key" | "apiKey" | "oauth" | "env" | "custom_headers") => {
                PortableFieldKind::Credential
            }
            _ => PortableFieldKind::Unknown,
        }
    }
    fn managed_documents(
        &self,
        documents: Documents,
        profile: &RegisteredProfile,
        _: Scope,
    ) -> Result<Documents, String> {
        let root = root(&documents);
        let provider = selected(&root, profile.editing.as_ref().ok_or("缺少编辑版本")?);
        let mut managed = Map::new();
        for key in ["default_model", "thinking"] {
            if let Some(value) = root.get(key) {
                managed.insert(key.into(), value.clone());
            }
        }
        if let Some(provider) = provider {
            if let Some(entry) = root
                .get("providers")
                .and_then(|providers| providers.get(&provider))
            {
                let mut entry = entry.as_object().cloned().unwrap_or_default();
                for field in ["api_key", "oauth", "env", "custom_headers"] {
                    entry.remove(field);
                }
                managed.insert("providers".into(), json!({provider.clone():entry}));
            }
            if let Some(models) = root.get("models").and_then(Value::as_object) {
                managed.insert(
                    "models".into(),
                    Value::Object(
                        models
                            .iter()
                            .filter(|(_, model)| {
                                model.get("provider").and_then(Value::as_str)
                                    == Some(provider.as_str())
                            })
                            .map(|(alias, model)| (alias.clone(), model.clone()))
                            .collect(),
                    ),
                );
            }
        }
        Ok(BTreeMap::from([(
            "settings".into(),
            Value::Object(managed),
        )]))
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
        let selected = desired
            .get("providers")
            .and_then(Value::as_object)
            .and_then(|providers| providers.keys().next());
        let mut paths = vec![];
        if let Some(providers) = current.get("providers").and_then(Value::as_object) {
            for provider in providers.keys() {
                if Some(provider) != selected {
                    paths.push(format!("/providers/{}", pointer_token(provider)));
                } else if matches!(
                    profile.authentication,
                    crate::native::profile::ProfileAuthentication::Native
                ) && profile
                    .connection
                    .as_ref()
                    .is_none_or(|connection| connection.secret_ref.is_none())
                    && !desired["providers"][provider].get("api_key").is_some()
                {
                    paths.push(format!("/providers/{}/api_key", pointer_token(provider)));
                }
            }
        }
        if let Some(models) = current.get("models").and_then(Value::as_object) {
            for (alias, model) in models {
                if model.get("provider").and_then(Value::as_str) != selected.map(String::as_str) {
                    paths.push(format!("/models/{}", pointer_token(alias)));
                }
            }
        }
        Ok(paths)
    }
    fn managed_fields(
        &self,
        _: &str,
        current: &Value,
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
        for action in &profile.editing.as_ref().ok_or("缺少编辑版本")?.intents {
            let (kind, _, id) = target(action)?;
            if matches!(action.operation.as_str(), "delete" | "rename") {
                if association(current, id) {
                    return Err("原生 secondary_model 仍引用被删除/改名的 alias；未修改文件".into());
                }
                let path = vec!["models".into(), id.into()];
                if let Some(model) = current.pointer(&pointer(&path)) {
                    let mut removed = BTreeMap::new();
                    crate::native::apply::flatten(model, &mut path.clone(), &mut removed);
                    for pointer in removed.keys() {
                        managed.fields.insert(pointer.clone(), None);
                    }
                }
            } else if action.operation == "reset" {
                let path = if kind == "settings" {
                    action
                        .field
                        .as_deref()
                        .unwrap_or("")
                        .split('.')
                        .map(str::to_owned)
                        .collect::<Vec<_>>()
                } else {
                    vec![
                        "models".into(),
                        id.into(),
                        action.field.clone().unwrap_or_default(),
                    ]
                };
                managed.released.push(pointer(&path));
            }
        }
        Ok(managed)
    }
}
