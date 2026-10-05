//! Pi custom model arrays merge by model ID; builtin overrides remain a separate table.
use super::Pi;
use crate::adapters::{configuration::*, pointer_token};
use crate::native::{
    adapter::Scope,
    profile::{Connection, ModelRecord, RegisteredProfile},
};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
const FIELDS: &[&str] = &[
    "name",
    "contextWindow",
    "maxTokens",
    "reasoning",
    "input",
    "thinkingLevelMap",
];
const SETTINGS: &[&str] = &["defaultProvider", "defaultModel", "defaultThinkingLevel"];
fn root(documents: &Documents, role: &str) -> Value {
    documents.get(role).cloned().unwrap_or_else(|| json!({}))
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
    if kind != "settings"
        && (provider.trim().is_empty()
            || provider.len() > 80
            || provider.chars().any(char::is_control))
    {
        return Err("供应商标识无效".into());
    }
    if matches!(kind, "model" | "override")
        && (id.trim().is_empty() || id.len() > 200 || id.chars().any(char::is_control))
    {
        return Err("模型 ID 无效".into());
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
            return Err("字段父级不是对象；请先修正原文".into());
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
fn path(kind: &str, provider: &str, id: &str, field: Option<&str>) -> Vec<String> {
    let mut path = vec![
        "providers".into(),
        provider.into(),
        if kind == "override" {
            "modelOverrides"
        } else {
            "models"
        }
        .into(),
        id.into(),
    ];
    if let Some(field) = field {
        path.push(field.into());
    }
    path
}
fn as_map(mut value: Value) -> Result<Value, String> {
    if let Some(providers) = value.get_mut("providers") {
        let providers = providers.as_object_mut().ok_or("providers 须为对象")?;
        for (provider, entry) in providers {
            if let Some(models) = entry.get_mut("models") {
                let list = models.as_array().ok_or("models 须为原生数组")?;
                let mut map = Map::new();
                for model in list {
                    let id = model
                        .get("id")
                        .and_then(Value::as_str)
                        .filter(|id| !id.trim().is_empty())
                        .ok_or_else(|| format!("供应商 {provider} 的模型缺少 id"))?;
                    if map.insert(id.into(), model.clone()).is_some() {
                        return Err(format!("供应商 {provider} 有重复模型 ID"));
                    }
                }
                *models = Value::Object(map);
            }
        }
    }
    Ok(value)
}
fn from_map(mut value: Value, ordering: &[Value]) -> Value {
    if let Some(providers) = value.get_mut("providers").and_then(Value::as_object_mut) {
        for (provider, entry) in providers {
            if let Some(models) = entry.get_mut("models") {
                if let Some(map) = models.as_object() {
                    let mut ids = vec![];
                    for document in ordering {
                        if let Some(list) = document
                            .get("providers")
                            .and_then(|providers| providers.get(provider))
                            .and_then(|provider| provider.get("models"))
                            .and_then(Value::as_array)
                        {
                            for model in list {
                                if let Some(id) = model.get("id").and_then(Value::as_str) {
                                    if !ids.contains(&id.to_owned()) {
                                        ids.push(id.into());
                                    }
                                }
                            }
                        }
                    }
                    for id in map.keys() {
                        if !ids.contains(id) {
                            ids.push(id.clone());
                        }
                    }
                    let list = ids
                        .iter()
                        .filter_map(|id| map.get(id).cloned())
                        .collect::<Vec<_>>();
                    *models = Value::Array(list);
                }
            }
        }
    }
    value
}
fn selected(documents: &Documents, state: &EditingState) -> Option<String> {
    state.selected_provider.clone().or_else(|| {
        root(documents, "settings")
            .get("defaultProvider")
            .and_then(Value::as_str)
            .map(str::to_owned)
    })
}
fn field(id: &str, label: &str, kind: &str, advanced: bool, scope: Scope) -> ConfigurationField {
    ConfigurationField {
        id: id.into(),
        label: label.into(),
        kind: kind.into(),
        required: false,
        advanced,
        choices: vec![],
        minimum: matches!(kind, "number").then_some(1.0),
        default_source: Some(
            match id {
                "contextWindow" => "Pi 原生缺省（自定义模型 128000）",
                "maxTokens" => "Pi 原生缺省（自定义模型 16384）",
                _ => "跟随原生默认",
            }
            .into(),
        ),
        unavailable_reason: (scope == Scope::Project && !SETTINGS.contains(&id))
            .then(|| "Pi 项目层只支持启动设置，不能编辑自定义 models.json".into()),
    }
}
fn issue(target: Value, field: &str, message: &str) -> ConfigurationIssue {
    ConfigurationIssue {
        target,
        field: Some(field.into()),
        code: "invalid_native_value".into(),
        message: message.into(),
    }
}
fn model_target(kind: &str, provider: &str, id: &str) -> Value {
    json!({"kind":kind,"provider":provider,"id":id})
}
fn private_headers(model: &Value) -> bool {
    model
        .get("headers")
        .and_then(Value::as_object)
        .is_some_and(|headers| {
            headers.iter().any(|(name, value)| {
                let name = name.to_ascii_lowercase();
                (name.contains("authorization")
                    || matches!(name.as_str(), "x-api-key" | "cookie" | "set-cookie")
                    || name.ends_with("-token"))
                    && value
                        .as_str()
                        .is_some_and(|value| super::pi_env_name(value).is_none())
            })
        })
}

impl ConfigurationAdapter for Pi {
    fn portable_reference_valid(&self, path: &[String], value: &Value) -> bool {
        path.last().is_some_and(|field| field == "apiKey")
            && value.as_str().and_then(super::pi_env_name).is_some()
    }
    fn portable_field_kind(&self, path: &[String]) -> PortableFieldKind {
        match path.last().map(String::as_str) {
            Some("maxTokens") => PortableFieldKind::Parameter,
            Some("apiKey") => PortableFieldKind::CredentialReference,
            Some("headers" | "oauth") => PortableFieldKind::Credential,
            _ => PortableFieldKind::Unknown,
        }
    }
    fn resolve_file(
        &self,
        role: &str,
        base: &Value,
        own: &Value,
        suppressed: &[String],
    ) -> Result<(Value, BTreeMap<String, String>), String> {
        if role != "models" {
            return crate::native::format::resolve(base, own, suppressed);
        }
        let (merged, sources) = crate::native::format::resolve(
            &as_map(base.clone())?,
            &as_map(own.clone())?,
            suppressed,
        )?;
        let native = from_map(merged, &[base.clone(), own.clone()]);
        let mut native_sources = BTreeMap::new();
        for (path, label) in sources {
            let parts = path
                .split('/')
                .skip(1)
                .map(|part| part.replace("~1", "/").replace("~0", "~"))
                .collect::<Vec<_>>();
            if parts.len() >= 4 && parts[0] == "providers" && parts[2] == "models" {
                if let Some(index) = native
                    .get("providers")
                    .and_then(|providers| providers.get(&parts[1]))
                    .and_then(|provider| provider.get("models"))
                    .and_then(Value::as_array)
                    .and_then(|models| {
                        models.iter().position(|model| {
                            model.get("id").and_then(Value::as_str) == Some(parts[3].as_str())
                        })
                    })
                {
                    let mut actual = parts.clone();
                    actual[3] = index.to_string();
                    native_sources.insert(pointer(&actual), label);
                }
            } else {
                native_sources.insert(path, label);
            }
        }
        Ok((native, native_sources))
    }
    fn describe(&self, scope: Scope) -> ConfigurationDescriptor {
        let mut thinking = field(
            "defaultThinkingLevel",
            "启动思考档位",
            "string",
            true,
            scope,
        );
        thinking.choices = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
            .iter()
            .map(|level| (*level).into())
            .collect();
        ConfigurationDescriptor {
            version: 1,
            operations: if scope == Scope::Project {
                ["set", "reset", "default"]
                    .iter()
                    .map(|value| (*value).into())
                    .collect()
            } else {
                [
                    "configure_provider",
                    "select_provider",
                    "create",
                    "create_override",
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
                field("defaultProvider", "启动默认供应商", "string", false, scope),
                field("defaultModel", "启动默认模型 ID", "string", false, scope),
                field("name", "显示名称", "string", false, scope),
                field("contextWindow", "上下文上限", "number", false, scope),
                field("maxTokens", "输出上限", "number", false, scope),
                field("reasoning", "支持思考", "boolean", false, scope),
                field("input", "输入类型", "json", true, scope),
                field("thinkingLevelMap", "模型思考档位映射", "json", true, scope),
                thinking,
            ],
        }
    }
    fn read(&self, documents: &Documents, state: &EditingState) -> Result<Value, String> {
        let settings = root(documents, "settings");
        let models = root(documents, "models");
        let provider = selected(documents, state);
        let entry = provider
            .as_ref()
            .and_then(|provider| {
                models
                    .get("providers")
                    .and_then(|providers| providers.get(provider))
            })
            .cloned()
            .unwrap_or_else(|| json!({}));
        let mut list = entry
            .get("models")
            .and_then(Value::as_array)
            .map(|models| {
                models
                    .iter()
                    .filter_map(|model| {
                        Some(json!({"id":model.get("id")?.as_str()?,"kind":"model","fields":model}))
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if let Some(overrides) = entry.get("modelOverrides").and_then(Value::as_object) {
            list.extend(
                overrides
                    .iter()
                    .map(|(id, fields)| json!({"id":id,"kind":"override","fields":fields})),
            );
        }
        Ok(
            json!({"providerId":provider,"providers":models.get("providers").and_then(Value::as_object).map(|providers|providers.keys().cloned().collect::<Vec<_>>()).unwrap_or_default(),"models":list,"defaultProvider":settings.get("defaultProvider"),"defaultModel":if settings.get("defaultProvider").and_then(Value::as_str)==provider.as_deref(){settings.get("defaultModel").cloned()}else{None},"settings":{"defaultProvider":settings.get("defaultProvider"),"defaultModel":settings.get("defaultModel"),"defaultThinkingLevel":settings.get("defaultThinkingLevel")},"connection":{"baseUrl":entry.get("baseUrl"),"protocol":entry.get("api")},"capabilityReason":"自定义模型与内置 modelOverrides 分开；模型/扩展能力未由目录核验时保留原生值"}),
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
        let settings = root(effective, "settings");
        let native = root(documents, "models");
        let mut models = as_map(native.clone())?;
        let effective_models = as_map(root(effective, "models"))?;
        if kind == "settings" {
            // Editing navigation is independent of the CLI's startup supplier.
            if state.selected_provider.is_none() {
                state.selected_provider = selected(effective, state);
            }
            let field = action.field.as_deref().ok_or("缺少设置字段")?;
            if !SETTINGS.contains(&field) || !matches!(action.operation.as_str(), "set" | "reset") {
                return Err("未声明此原生设置或动作".into());
            }
            let root = documents
                .entry("settings".into())
                .or_insert_with(|| json!({}));
            set(
                root,
                &[field.into()],
                if action.operation == "reset" {
                    None
                } else {
                    action.value.clone()
                },
            )?;

            return Ok(());
        }
        if action.operation == "select_provider" {
            if effective_models
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
            let api = match value.get("interfaceFormat").and_then(Value::as_str) {
                Some("openai_completions") => "openai-completions",
                Some("openai_responses") => "openai-responses",
                Some("anthropic_messages") => "anthropic-messages",
                _ => return Err("不支持此连接协议".into()),
            };
            set(
                &mut models,
                &["providers".into(), provider.into(), "api".into()],
                Some(json!(api)),
            )?;
            set(
                &mut models,
                &["providers".into(), provider.into(), "baseUrl".into()],
                Some(json!(base)),
            )?;
        } else if matches!(kind, "model" | "override") {
            let existing = effective_models.pointer(&pointer(&path(kind, provider, id, None)));
            match action.operation.as_str() {
                "create" | "create_override" => {
                    if existing.is_some() {
                        return Err("该模型 ID 已存在于同类定义".into());
                    }
                    let mut model = action.value.clone().unwrap_or_else(|| json!({}));
                    let fields = model.as_object_mut().ok_or("模型字段必须是对象")?;
                    if fields.keys().any(|field| !FIELDS.contains(&field.as_str())) {
                        return Err("新增模型含未声明字段；扩展字段请使用原生文本".into());
                    }
                    if kind == "model" {
                        fields.insert("id".into(), json!(id));
                    }
                    set(&mut models, &path(kind, provider, id, None), Some(model))?;
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
                        .ok_or("新模型 ID 无效")?;
                    if effective_models
                        .pointer(&pointer(&path(kind, provider, next, None)))
                        .is_some()
                    {
                        return Err("新模型 ID 已存在".into());
                    }
                    let mut model = existing.ok_or("模型不存在")?.clone();
                    if kind == "model" {
                        model["id"] = json!(next);
                    }
                    set(&mut models, &path(kind, provider, next, None), Some(model))?;
                    if action.operation == "rename" {
                        set(&mut models, &path(kind, provider, id, None), None)?;
                        if settings.get("defaultProvider").and_then(Value::as_str) == Some(provider)
                            && settings.get("defaultModel").and_then(Value::as_str) == Some(id)
                        {
                            set(
                                documents
                                    .entry("settings".into())
                                    .or_insert_with(|| json!({})),
                                &["defaultModel".into()],
                                Some(json!(next)),
                            )?;
                        }
                    }
                }
                "delete" => {
                    if existing.is_none() {
                        return Err("模型不存在".into());
                    }
                    if kind == "model"
                        && settings.get("defaultProvider").and_then(Value::as_str) == Some(provider)
                        && settings.get("defaultModel").and_then(Value::as_str) == Some(id)
                    {
                        return Err("此模型为启动默认，请先选择替代模型再删除".into());
                    }
                    set(&mut models, &path(kind, provider, id, None), None)?;
                }
                "default" => {
                    let root = documents
                        .entry("settings".into())
                        .or_insert_with(|| json!({}));
                    set(root, &["defaultProvider".into()], Some(json!(provider)))?;
                    set(root, &["defaultModel".into()], Some(json!(id)))?;
                }
                "set" | "reset" => {
                    let field = action.field.as_deref().ok_or("缺少模型字段")?;
                    if !FIELDS.contains(&field) {
                        return Err("未声明此模型字段".into());
                    }
                    if existing.is_none() {
                        return Err("模型不存在".into());
                    }
                    if kind == "model"
                        && models
                            .pointer(&pointer(&path(kind, provider, id, None)))
                            .is_none()
                        && action.operation == "set"
                    {
                        set(
                            &mut models,
                            &path(kind, provider, id, None),
                            Some(json!({"id":id})),
                        )?;
                    }
                    set(
                        &mut models,
                        &path(kind, provider, id, Some(field)),
                        if action.operation == "reset" {
                            None
                        } else {
                            action.value.clone()
                        },
                    )?;
                }
                _ => return Err("未声明此模型动作".into()),
            }
        } else {
            return Err("未声明此编辑目标".into());
        }
        if action.operation != "default" || documents.contains_key("models") {
            documents.insert("models".into(), from_map(models, &[native]));
        }
        state.selected_provider = Some(provider.into());
        Ok(())
    }
    fn validate(
        &self,
        documents: &Documents,
        state: &EditingState,
        scope: Scope,
    ) -> Vec<ConfigurationIssue> {
        let mut issues = vec![];
        let native = root(documents, "models");
        let Ok(models) = as_map(native.clone()) else {
            return vec![issue(
                json!({"kind":"settings"}),
                "models",
                "原生模型数组必须包含唯一且非空的 ID",
            )];
        };
        if scope == Scope::Project && native.as_object().is_some_and(|root| !root.is_empty()) {
            issues.push(issue(
                json!({"kind":"settings"}),
                "scope",
                "Pi 项目层不支持自定义 models.json",
            ));
        }
        if let Some(providers) = models.get("providers").and_then(Value::as_object) {
            let selected = selected(documents, state);
            for (provider, entry) in providers {
                if selected
                    .as_ref()
                    .is_some_and(|selected| selected != provider)
                {
                    continue;
                }
                for (bucket, kind) in [("models", "model"), ("modelOverrides", "override")] {
                    if let Some(values) = entry.get(bucket) {
                        if let Some(values) = values.as_object() {
                            for (id, model) in values {
                                let target = model_target(kind, provider, id);
                                if !model.is_object() {
                                    issues.push(issue(target.clone(), "model", "模型字段须为对象"));
                                    continue;
                                }
                                for field in ["contextWindow", "maxTokens"] {
                                    if model.get(field).is_some_and(|value| {
                                        !value
                                            .as_f64()
                                            .is_some_and(|value| value.is_finite() && value > 0.0)
                                    }) {
                                        issues.push(issue(
                                            target.clone(),
                                            field,
                                            "原生上限须为正数",
                                        ));
                                    }
                                }
                                if model
                                    .get("reasoning")
                                    .is_some_and(|value| !value.is_boolean())
                                {
                                    issues.push(issue(
                                        target.clone(),
                                        "reasoning",
                                        "思考声明须为布尔值",
                                    ));
                                }
                                if model.get("input").is_some_and(|value| {
                                    !value.as_array().is_some_and(|items| {
                                        items.iter().all(|value| {
                                            matches!(value.as_str(), Some("text" | "image"))
                                        })
                                    })
                                }) {
                                    issues.push(issue(
                                        target.clone(),
                                        "input",
                                        "Pi 输入类型只支持 text/image",
                                    ));
                                }
                                if model
                                    .get("thinkingLevelMap")
                                    .is_some_and(|value| !value.is_object())
                                {
                                    issues.push(issue(
                                        target.clone(),
                                        "thinkingLevelMap",
                                        "思考映射须为原生对象",
                                    ));
                                }
                                if private_headers(model) {
                                    issues.push(issue(
                                        target,
                                        "headers",
                                        "模型认证头须使用原生环境引用；不能作为普通模型字段保存",
                                    ));
                                }
                            }
                        } else {
                            issues.push(issue(
                                json!({"kind":"provider","provider":provider}),
                                bucket,
                                "模型定义须为正确的原生集合",
                            ));
                        }
                    }
                }
            }
        }
        let settings = root(documents, "settings");
        for field in SETTINGS {
            if settings.get(*field).is_some_and(|value| !value.is_string()) {
                issues.push(issue(
                    json!({"kind":"settings"}),
                    field,
                    "启动设置须为字符串",
                ));
            }
        }
        issues
    }
    fn connection(
        &self,
        documents: &Documents,
        state: &EditingState,
    ) -> Result<Option<Connection>, String> {
        let settings = root(documents, "settings");
        let (Some(provider), Some(id)) = (
            settings.get("defaultProvider").and_then(Value::as_str),
            settings.get("defaultModel").and_then(Value::as_str),
        ) else {
            return Ok(None);
        };
        if state
            .selected_provider
            .as_ref()
            .is_some_and(|selected| selected != provider)
        {
            return Ok(None);
        };
        let models = root(documents, "models");
        let entry = models
            .get("providers")
            .and_then(|providers| providers.get(provider))
            .cloned()
            .unwrap_or_else(|| json!({}));
        let model = entry
            .get("models")
            .and_then(Value::as_array)
            .and_then(|models| {
                models
                    .iter()
                    .find(|model| model.get("id").and_then(Value::as_str) == Some(id))
            })
            .cloned()
            .unwrap_or_else(|| json!({}));
        let base = model
            .get("baseUrl")
            .or_else(|| entry.get("baseUrl"))
            .and_then(Value::as_str);
        let api = model
            .get("api")
            .or_else(|| entry.get("api"))
            .and_then(Value::as_str)
            .and_then(crate::native::intake::api_format);
        let (Some(base), Some(api)) = (base, api) else {
            return Ok(None);
        };
        let records = entry
            .get("models")
            .and_then(Value::as_array)
            .map(|models| {
                models
                    .iter()
                    .filter_map(|model| {
                        let mut fields = model.as_object()?.clone();
                        let id = fields.remove("id")?.as_str()?.to_owned();
                        Some(ModelRecord { id, fields })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(Some(Connection {
            provider_id: provider.into(),
            model: id.into(),
            base_url: base.into(),
            interface_format: api.into(),
            secret_ref: None,
            auth_env_var: entry
                .get("apiKey")
                .and_then(Value::as_str)
                .and_then(super::pi_env_name)
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
        let next = as_map(root(next, "models"))?;
        let previous = previous.and_then(|docs| as_map(root(docs, "models")).ok());
        if let Some(paths) = suppressed.get_mut("models") {
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
        let models = as_map(root(next, "models"))?;
        let settings = root(next, "settings");
        state.intents.retain(|action| {
            let Ok((kind, provider, id)) = target(action) else {
                return false;
            };
            match action.operation.as_str() {
                "delete" | "rename" => models
                    .pointer(&pointer(&path(kind, provider, id, None)))
                    .is_none(),
                "reset" => {
                    if kind == "settings" {
                        settings
                            .get(action.field.as_deref().unwrap_or(""))
                            .is_none()
                    } else {
                        models
                            .pointer(&pointer(&path(kind, provider, id, action.field.as_deref())))
                            .is_none()
                    }
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
        let (kind, provider, id) = target(action)?;
        let (role, path) = if kind == "settings" {
            (
                "settings",
                format!("/{}", action.field.as_deref().unwrap_or("")),
            )
        } else {
            (
                "models",
                pointer(&path(
                    kind,
                    provider,
                    id,
                    if action.operation == "reset" {
                        action.field.as_deref()
                    } else {
                        None
                    },
                )),
            )
        };
        Ok(match action.operation.as_str() {
            "delete" | "rename" => vec![SuppressionChange {
                role: role.into(),
                path,
                suppressed: true,
            }],
            "create" | "create_override" | "reset" => vec![SuppressionChange {
                role: role.into(),
                path,
                suppressed: false,
            }],
            _ => vec![],
        })
    }
    fn managed_documents(
        &self,
        documents: Documents,
        profile: &RegisteredProfile,
        _: Scope,
    ) -> Result<Documents, String> {
        let state = profile.editing.as_ref().ok_or("缺少编辑版本")?;
        let selected = selected(&documents, state);
        let settings = root(&documents, "settings");
        let mut managed_settings = Map::new();
        for field in SETTINGS {
            if let Some(value) = settings.get(*field) {
                managed_settings.insert((*field).into(), value.clone());
            }
        }
        let mut managed = BTreeMap::from([("settings".into(), Value::Object(managed_settings))]);
        if let Some(provider) = selected {
            if let Some(mut entry) = root(&documents, "models")
                .get("providers")
                .and_then(|providers| providers.get(&provider))
                .cloned()
            {
                if let Some(fields) = entry.as_object_mut() {
                    for key in ["headers", "oauth"] {
                        fields.remove(key);
                    }
                    if fields.get("apiKey").is_some_and(|value| {
                        !self.portable_reference_valid(&["apiKey".into()], value)
                    }) {
                        fields.remove("apiKey");
                    }
                }
                managed.insert("models".into(), json!({"providers":{provider:entry}}));
            }
        }
        Ok(managed)
    }
    fn unmanaged_paths(
        &self,
        role: &str,
        current: &Value,
        desired: &Value,
        profile: &RegisteredProfile,
    ) -> Result<Vec<String>, String> {
        if role != "models" {
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
                    && desired["providers"][provider].get("apiKey").is_none()
                {
                    paths.push(format!("/providers/{}/apiKey", pointer_token(provider)));
                }
            }
        }
        Ok(paths)
    }
    fn managed_fields(
        &self,
        role: &str,
        current: &Value,
        desired: &Value,
        profile: &RegisteredProfile,
    ) -> Result<ManagedConfiguration, String> {
        let state = profile.editing.as_ref().ok_or("缺少编辑版本")?;
        let mut candidate = desired.clone();
        let mut reset_paths = vec![];
        let mut deletes = vec![];
        for action in &state.intents {
            let (kind, provider, id) = target(action)?;
            if action.operation == "reset" {
                if kind == "settings" && role == "settings" {
                    reset_paths.push(format!("/{}", action.field.as_deref().unwrap_or("")));
                } else if kind == "override" && role == "models" {
                    reset_paths.push(pointer(&path(kind, provider, id, action.field.as_deref())));
                }
            }
            if role == "models"
                && kind == "override"
                && matches!(action.operation.as_str(), "delete" | "rename")
            {
                deletes.push(path(kind, provider, id, None));
            }
        }
        if role == "models" {
            if let Some(providers) = candidate
                .get_mut("providers")
                .and_then(Value::as_object_mut)
            {
                for (provider, entry) in providers {
                    if let Some(target_models) =
                        entry.get_mut("models").and_then(Value::as_array_mut)
                    {
                        let original = current
                            .get("providers")
                            .and_then(|providers| providers.get(provider))
                            .and_then(|provider| provider.get("models"))
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default();
                        let removed = state
                            .intents
                            .iter()
                            .filter_map(|action| {
                                let (kind, p, id) = target(action).ok()?;
                                (kind == "model"
                                    && p == provider
                                    && matches!(action.operation.as_str(), "delete" | "rename"))
                                .then(|| id.to_owned())
                            })
                            .collect::<Vec<_>>();
                        let mut next = vec![];
                        for model in original {
                            if private_headers(&model)
                                || crate::native::profile::reject_plaintext_secrets(&model).is_err()
                            {
                                return Err("原生模型数组含未受管理的字面凭据；请先改为环境引用，文件未修改".into());
                            }
                            let Some(id) = model.get("id").and_then(Value::as_str) else {
                                return Err("原生模型缺少 ID，不能安全合并".into());
                            };
                            if removed.iter().any(|removed| removed == id) {
                                continue;
                            }
                            if let Some(own) = target_models
                                .iter()
                                .find(|own| own.get("id").and_then(Value::as_str) == Some(id))
                            {
                                let mut merged =
                                    crate::native::format::resolve(&model, own, &[])?.0;
                                for action in &state.intents {
                                    if let Ok((kind, p, model_id)) = target(action) {
                                        if kind == "model"
                                            && p == provider
                                            && model_id == id
                                            && action.operation == "reset"
                                        {
                                            if let Some(field) = action.field.as_deref() {
                                                if own.get(field).is_none() {
                                                    merged.as_object_mut().unwrap().remove(field);
                                                }
                                            }
                                        }
                                    }
                                }
                                next.push(merged);
                            } else {
                                next.push(model);
                            }
                        }
                        for model in target_models.iter() {
                            if !next
                                .iter()
                                .any(|existing| existing.get("id") == model.get("id"))
                            {
                                next.push(model.clone());
                            }
                        }
                        *target_models = next;
                    }
                }
            }
        }
        let mut fields = BTreeMap::new();
        crate::native::apply::flatten(&candidate, &mut vec![], &mut fields);
        let mut managed = ManagedConfiguration {
            fields: fields
                .into_iter()
                .map(|(path, value)| (path, Some(value)))
                .collect(),
            released: reset_paths,
        };
        for path in deletes {
            if let Some(model) = current.pointer(&pointer(&path)) {
                let mut old = BTreeMap::new();
                crate::native::apply::flatten(model, &mut path.clone(), &mut old);
                for pointer in old.keys() {
                    managed.fields.insert(pointer.clone(), None);
                }
            }
        }
        Ok(managed)
    }
}

#[cfg(test)]
#[path = "configuration_tests.rs"]
mod tests;
