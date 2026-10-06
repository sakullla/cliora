use super::OpenCode;
use crate::adapters::{configuration::*, pointer_token};
use crate::native::{
    adapter::Scope,
    profile::{Connection, ModelRecord, RegisteredProfile},
};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

const MODEL_FIELDS: &[&str] = &[
    "name",
    "limit.context",
    "limit.output",
    "modalities.input",
    "modalities.output",
    "reasoning",
    "options",
    "variants",
];
fn field(id: &str, label: &str, kind: &str, advanced: bool) -> ConfigurationField {
    ConfigurationField {
        id: id.into(),
        label: label.into(),
        kind: kind.into(),
        required: false,
        advanced,
        choices: vec![],
        minimum: matches!(kind, "integer").then_some(1.0),
        default_source: Some("跟随原生模型默认".into()),
        unavailable_reason: None,
        origin: None,
    }
}
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
        .ok_or("缺少编辑目标类型")?;
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
    if !matches!(kind, "settings")
        && (provider.trim().is_empty()
            || provider.len() > 80
            || provider.chars().any(char::is_control))
    {
        return Err("供应商标识无效".into());
    }
    if kind == "model"
        && (id.trim().is_empty() || id.len() > 200 || id.chars().any(char::is_control))
    {
        return Err("模型标识无效".into());
    }
    Ok((kind, provider, id))
}
fn set(root: &mut Value, path: &[String], value: Option<Value>) -> Result<(), String> {
    if path.is_empty() {
        return Err("缺少字段路径".into());
    }
    let mut node = root;
    for key in &path[..path.len() - 1] {
        if node.get(key).is_none() {
            if value.is_none() {
                return Ok(());
            }
            node[key] = json!({});
        }
        node = node.get_mut(key).ok_or("字段父级不存在")?;
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
fn path(provider: &str, id: &str, field: Option<&str>) -> Vec<String> {
    let mut path = vec![
        "provider".into(),
        provider.into(),
        "models".into(),
        id.into(),
    ];
    if let Some(field) = field {
        path.extend(field.split('.').map(str::to_owned));
    }
    path
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
/// Match the longest known provider prefix so model IDs retain their slashes.
pub(super) fn reference(root: &Value, value: &str) -> Option<(String, String)> {
    root.get("provider")
        .and_then(Value::as_object)?
        .keys()
        .filter_map(|provider| {
            value
                .strip_prefix(&format!("{provider}/"))
                .map(|id| (provider.clone(), id.to_owned()))
        })
        .max_by_key(|(provider, _)| provider.len())
}
fn selected(root: &Value, state: &EditingState) -> Option<String> {
    state.selected_provider.clone().or_else(|| {
        root.get("model")
            .and_then(Value::as_str)
            .and_then(|value| reference(root, value))
            .map(|(provider, _)| provider)
    })
}
fn issue(target: Value, field: &str, message: &str) -> ConfigurationIssue {
    ConfigurationIssue {
        target,
        field: Some(field.into()),
        code: "invalid_native_value".into(),
        message: message.into(),
    }
}
fn entities(documents: &Documents) -> Result<Vec<(String, String, String)>, String> {
    let root = root(documents);
    let mut result = vec![];
    if let Some(providers) = root.get("provider").and_then(Value::as_object) {
        for (provider, entry) in providers {
            if let Some(models) = entry.get("models").and_then(Value::as_object) {
                result.extend(models.keys().map(|id| ("model".into(), provider.clone(), id.clone())));
            }
        }
    }
    Ok(result)
}

// Reusing an identity starts a new entity; obsolete deletions and resets cannot
// erase its fields during application.
fn retire_entity(state: &mut EditingState, entity_kind: &str, provider: &str, id: &str) {
    state.intents.retain(|action| {
        let Ok((kind, p, old_id)) = target(action) else { return true; };
        !(matches!(action.operation.as_str(), "delete" | "rename" | "reset")
            && p == provider && kind == entity_kind && old_id == id)
    });
}

impl ConfigurationAdapter for OpenCode {
    fn credential_paths(&self,connection:&Connection)->Vec<(&'static str,Vec<String>)>{
        ["apiKey"].iter().map(|field|("settings",vec!["provider".into(),connection.provider_id.clone(),"options".into(),(*field).into()])).collect()
    }

    fn native_verification_module(&self) -> Option<&'static str> { Some("src-tauri/src/adapters/opencode/native_verification.mjs") }
    fn catalog_support(&self) -> CatalogSupport { CatalogSupport { available: true, multiple: true, reason: None } }
    fn common_parameters(&self, _: Scope) -> Vec<CommonParameter> {
        let mut log = field("logLevel", "日志级别", "string", false); log.choices = ["DEBUG","INFO","WARN","ERROR"].iter().map(|value| (*value).into()).collect();
        vec![field("theme", "主题", "string", false), log, field("permission", "权限设置", "json", true)].into_iter()
            .map(|field| CommonParameter { path: vec![field.id.clone()], field, role: "settings", target: json!({"kind":"settings"}) }).collect()
    }
    fn common_forbidden_paths(&self) -> Vec<(&'static str, &'static str)> { vec![("settings","/model"), ("settings","/small_model"), ("settings","/agent")] }
    fn draft_connection(&self, documents: &Documents, state: &EditingState) -> Result<Option<Connection>, String> {
        let mut documents = documents.clone();
        let root = root(&documents); let Some(provider) = selected(&root, state) else { return Ok(None); };
        let model = root["provider"][&provider]["models"].as_object().and_then(|models| models.keys().next()).cloned().unwrap_or_default();
        documents.entry("settings".into()).or_insert_with(|| json!({}))["model"] = json!(format!("{provider}/{model}"));
        self.connection(&documents, state)
    }
    fn catalog_actions(&self, documents: &Documents, state: &EditingState, ids: &[String]) -> Result<Vec<ConfigurationAction>, String> {
        let root = root(documents); let provider = selected(&root, state).ok_or("请先设置供应商连接")?;
        Ok(ids.iter().filter(|id| root["provider"][&provider]["models"].get(*id).is_none()).map(|id| ConfigurationAction {
            version: EDITING_VERSION, target: json!({"kind":"model","provider":provider,"id":id}), operation: "create".into(), field: None, value: Some(json!({})),
        }).collect())
    }

    fn cleanup_removed_parents(&self) -> bool { true }
    fn portable_reference_valid(&self, path: &[String], value: &Value) -> bool {
        path.last().is_some_and(|field| field == "apiKey")
            && value
                .as_str()
                .and_then(|value| value.strip_prefix("{env:"))
                .and_then(|value| value.strip_suffix('}'))
                .is_some_and(crate::native::profile::valid_env_name)
    }

    fn unmanaged_paths(
        &self,
        role: &str,
        current: &Value,
        desired: &Value,
        _: &RegisteredProfile,
    ) -> Result<Vec<String>, String> {
        if role != "settings" {
            return Ok(vec![]);
        }
        let selected = desired
            .get("provider")
            .and_then(Value::as_object)
            .and_then(|providers| providers.keys().next());
        Ok(current
            .get("provider")
            .and_then(Value::as_object)
            .map(|providers| {
                providers
                    .keys()
                    .filter(|id| Some(*id) != selected)
                    .map(|id| format!("/provider/{}", pointer_token(id)))
                    .collect()
            })
            .unwrap_or_default())
    }
    fn describe(&self, _: Scope) -> ConfigurationDescriptor {
        ConfigurationDescriptor {
            version: 1,
            operations: [
                "configure_provider",
                "select_provider",
                "create",
                "copy",
                "rename",
                "delete",
                "default",
                "small_default",
                "set",
                "reset",
            ]
            .iter()
            .map(|value| (*value).into())
            .collect(),
            fields: vec![
                field("name", "显示名称", "string", false),
                field("limit.context", "上下文上限", "integer", false),
                field("limit.output", "输出上限", "integer", false),
                field("reasoning", "支持推理", "boolean", false),
                field("modalities.input", "输入模态", "json", true),
                field("modalities.output", "输出模态", "json", true),
                field("options", "模型选项", "json", true),
                field("variants", "推理变体", "json", true),
            ],
        }
    }
    fn read(&self, documents: &Documents, state: &EditingState) -> Result<Value, String> {
        let root = root(documents);
        // The editor browses independently of the CLI's default connection.
        let provider = selected(&root, state);
        let entry = provider
            .as_ref()
            .and_then(|id| root.get("provider").and_then(|providers| providers.get(id)))
            .cloned()
            .unwrap_or_else(|| json!({}));
        let models = entry
            .get("models")
            .and_then(Value::as_object)
            .map(|models| {
                models
                    .iter()
                    .map(|(id, value)| json!({"id":id,"fields":value,"kind":"model"}))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let model = |key: &str| {
            root.get(key)
                .and_then(Value::as_str)
                .and_then(|value| reference(&root, value))
                .filter(|(id, _)| Some(id) == provider.as_ref())
                .map(|(_, model)| model)
        };
        Ok(
            json!({"providerId":provider,"providers":root.get("provider").and_then(Value::as_object).map(|providers|providers.keys().cloned().collect::<Vec<_>>()).unwrap_or_default(),"models":models,"defaultModel":model("model"),"smallModel":model("small_model"),"connection":{"baseUrl":entry.pointer("/options/baseURL"),"protocol":entry.get("npm")},"capabilityReason":if entry.get("npm").and_then(Value::as_str).is_some_and(|npm|crate::native::intake::api_format(npm).is_none()){"保留扩展供应商协议；当前连接目录与凭据能力未核验"}else{""}}),
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
                .get("provider")
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
            let npm = match value.get("interfaceFormat").and_then(Value::as_str) {
                Some("openai_completions") => "@ai-sdk/openai-compatible",
                Some("openai_responses") => "@ai-sdk/openai",
                Some("anthropic_messages") => "@ai-sdk/anthropic",
                _ => return Err("不支持此连接协议".into()),
            };
            set(
                root,
                &["provider".into(), provider.into(), "npm".into()],
                Some(json!(npm)),
            )?;
            set(
                root,
                &[
                    "provider".into(),
                    provider.into(),
                    "options".into(),
                    "baseURL".into(),
                ],
                Some(json!(base)),
            )?;
            state.selected_provider = Some(provider.into());
            return Ok(());
        }
        if kind == "settings" {
            let field = action.field.as_deref().ok_or("缺少设置字段")?;
            if !matches!(field, "model" | "small_model") {
                return Err("未声明此原生设置".into());
            }
            if !matches!(action.operation.as_str(), "set" | "reset") {
                return Err("不支持此设置动作".into());
            }
            return set(
                root,
                &[field.into()],
                if action.operation == "reset" {
                    None
                } else {
                    action.value.clone()
                },
            );
        }
        if kind != "model" {
            return Err("未声明此编辑目标".into());
        }
        let existing = effective
            .get("provider")
            .and_then(|providers| providers.get(provider))
            .and_then(|provider| provider.get("models"))
            .and_then(|models| models.get(id));
        match action.operation.as_str() {
            "create" => {
                if existing.is_some() {
                    return Err("模型标识已存在".into());
                }
                let value = action.value.clone().unwrap_or_else(|| json!({}));
                let fields = value.as_object().ok_or("模型字段必须是对象")?;
                if fields.keys().any(|field| {
                    !matches!(
                        field.as_str(),
                        "name" | "limit" | "modalities" | "reasoning" | "options" | "variants"
                    )
                }) {
                    return Err("新增模型含未声明字段；请使用原生文本保留扩展字段".into());
                }
                set(root, &path(provider, id, None), Some(value))?;
                retire_entity(state, kind, provider, id);
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
                    .ok_or("新模型标识无效")?;
                if effective
                    .get("provider")
                    .and_then(|providers| providers.get(provider))
                    .and_then(|provider| provider.get("models"))
                    .and_then(|models| models.get(next))
                    .is_some()
                {
                    return Err("新模型标识已存在".into());
                }
                set(
                    root,
                    &path(provider, next, None),
                    Some(existing.ok_or("模型不存在")?.clone()),
                )?;
                retire_entity(state, kind, provider, next);
                if action.operation == "rename" {
                    if effective
                        .get("agent")
                        .and_then(Value::as_object)
                        .is_some_and(|agents| {
                            agents.values().any(|agent| {
                                agent.get("model").and_then(Value::as_str)
                                    == Some(&format!("{provider}/{id}"))
                            })
                        })
                    {
                        return Err("角色仍引用旧模型标识，请先修改角色引用".into());
                    }
                    set(root, &path(provider, id, None), None)?;
                    for key in ["model", "small_model"] {
                        if effective.get(key).and_then(Value::as_str)
                            == Some(&format!("{provider}/{id}"))
                        {
                            set(
                                root,
                                &[key.into()],
                                Some(json!(format!("{provider}/{next}"))),
                            )?;
                        }
                    }
                }
            }
            "delete" => {
                if existing.is_none() {
                    return Err("模型不存在".into());
                }
                if ["model", "small_model"].iter().any(|key| {
                    effective.get(*key).and_then(Value::as_str) == Some(&format!("{provider}/{id}"))
                }) {
                    return Err("此模型仍是默认或轻量模型，请先选择替代模型后删除".into());
                }
                if effective
                    .get("agent")
                    .and_then(Value::as_object)
                    .is_some_and(|agents| {
                        agents.values().any(|agent| {
                            agent.get("model").and_then(Value::as_str)
                                == Some(&format!("{provider}/{id}"))
                        })
                    })
                {
                    return Err("角色仍引用此模型，请先在原生文本或角色管理中修改引用".into());
                }
                set(root, &path(provider, id, None), None)?;
                for key in ["model", "small_model"] {
                    if effective.get(key).and_then(Value::as_str)
                        == Some(&format!("{provider}/{id}"))
                    {
                        set(root, &[key.into()], None)?;
                    }
                }
            }
            "default" | "small_default" => {
                if existing.is_none() {
                    return Err("模型不存在".into());
                }
                set(
                    root,
                    &[if action.operation == "default" {
                        "model"
                    } else {
                        "small_model"
                    }
                    .into()],
                    Some(json!(format!("{provider}/{id}"))),
                )?;
            }
            "set" | "reset" => {
                let field = action.field.as_deref().ok_or("缺少模型字段")?;
                if !MODEL_FIELDS.contains(&field) {
                    return Err("未声明此模型字段".into());
                }
                if existing.is_none() {
                    return Err("模型不存在".into());
                }
                set(
                    root,
                    &path(provider, id, Some(field)),
                    if action.operation == "reset" {
                        None
                    } else {
                        action.value.clone()
                    },
                )?;
            }
            _ => return Err("未声明此编辑动作".into()),
        }
        state.selected_provider = Some(provider.into());
        Ok(())
    }
    fn validate(
        &self,
        documents: &Documents,
        state: &EditingState,
        _: Scope,
    ) -> Vec<ConfigurationIssue> {
        let root = root(documents);
        let selected = selected(&root, state);
        let managed_provider = self.connection(documents, state).ok().flatten()
            .map(|connection| connection.provider_id);
        let mut issues = vec![];
        if let Some(providers) = root.get("provider").and_then(Value::as_object) {
            for (provider, entry) in providers {
                if selected
                    .as_ref()
                    .is_some_and(|selected| selected != provider)
                    && managed_provider.as_deref() != Some(provider.as_str())
                {
                    continue;
                }
                if let Some(models) = entry.get("models") {
                    if let Some(models) = models.as_object() {
                        for (id, model) in models {
                            let target = json!({"kind":"model","provider":provider,"id":id});
                            if id.trim().is_empty() || !model.is_object() {
                                issues.push(issue(target.clone(), "id", "模型标识和字段对象无效"));
                                continue;
                            }
                            for field in ["limit.context", "limit.output"] {
                                let pointer = format!("/{}", field.replace('.', "/"));
                                if let Some(value) = model.pointer(&pointer) {
                                    if !value.as_u64().is_some_and(|value| value > 0) {
                                        issues.push(issue(target.clone(), field, "上限须为正整数"));
                                    }
                                }
                            }
                            for field in ["options", "variants", "limit", "modalities"] {
                                if model.get(field).is_some_and(|value| !value.is_object()) {
                                    issues.push(issue(target.clone(), field, "此字段须为原生对象"));
                                }
                            }
                            for field in ["modalities.input", "modalities.output"] {
                                if let Some(value) =
                                    model.pointer(&format!("/{}", field.replace('.', "/")))
                                {
                                    if !value
                                        .as_array()
                                        .is_some_and(|items| items.iter().all(Value::is_string))
                                    {
                                        issues.push(issue(
                                            target.clone(),
                                            field,
                                            "模态须为字符串数组",
                                        ));
                                    }
                                }
                            }
                            if model
                                .get("reasoning")
                                .is_some_and(|value| !value.is_boolean())
                            {
                                issues.push(issue(target, "reasoning", "推理声明须为布尔值"));
                            }
                        }
                    } else {
                        issues.push(issue(
                            json!({"kind":"provider","provider":provider}),
                            "models",
                            "模型集合必须为对象",
                        ));
                    }
                }
            }
        }
        for action in &state.intents {
            if matches!(action.operation.as_str(), "delete" | "rename") {
                if let Ok(("model", provider, id)) = target(action) {
                    for key in ["model", "small_model"] {
                        if root.get(key).and_then(Value::as_str) == Some(&format!("{provider}/{id}")) {
                            issues.push(issue(json!({"kind":"settings"}), key,
                                "已删除的模型仍被引用，请选择替代模型"));
                        }
                    }
                }
            }
        }
        for key in ["model", "small_model"] {
            if let Some(value) = root.get(key) {
                if let Some(value) = value.as_str() {
                    if let Some((provider, id)) = reference(&root, value) {
                        let entry = &root["provider"][&provider];
                        if entry.get("models").is_some()
                            && entry
                                .get("models")
                                .and_then(|models| models.get(&id))
                                .is_none()
                        {
                            issues.push(issue(
                                json!({"kind":"settings"}),
                                key,
                                "模型引用不存在；请设置有效模型或恢复默认",
                            ));
                        }
                    }
                } else {
                    issues.push(issue(json!({"kind":"settings"}), key, "模型引用须为字符串"));
                }
            }
        }
        issues
    }
    fn connection(
        &self,
        documents: &Documents,
        _state: &EditingState,
    ) -> Result<Option<Connection>, String> {
        let root = root(documents);
        let Some(full) = root.get("model").and_then(Value::as_str) else {
            return Ok(None);
        };
        let Some((provider, model)) = reference(&root, full) else {
            return Ok(None);
        };
        let entry = &root["provider"][&provider];
        let Some(base) = entry.pointer("/options/baseURL").and_then(Value::as_str) else {
            return Ok(None);
        };
        let Some(format) = entry
            .get("npm")
            .and_then(Value::as_str)
            .and_then(crate::native::intake::api_format)
        else {
            return Ok(None);
        };
        let auth = entry
            .pointer("/options/apiKey")
            .and_then(Value::as_str)
            .and_then(|value| value.strip_prefix("{env:"))
            .and_then(|value| value.strip_suffix('}'))
            .map(str::to_owned);
        let models = entry
            .get("models")
            .and_then(Value::as_object)
            .map(|models| {
                models
                    .iter()
                    .filter_map(|(id, model)| {
                        Some(ModelRecord {
                            id: id.clone(),
                            fields: model.as_object()?.clone(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(Some(Connection {
            provider_id: provider,
            model,
            base_url: base.into(),
            interface_format: format.into(),
            secret_ref: None,
            auth_env_var: auth,
            model_records: models,
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
        previous: Option<&Documents>,
        next: &Documents,
        _: &Documents,
        state: &mut EditingState,
    ) -> Result<(), String> {
        let root = root(next);
        state.intents.retain(|action| {
            let Ok((kind, provider, id)) = target(action) else {
                return false;
            };
            let entity = root
                .get("provider")
                .and_then(|providers| providers.get(provider))
                .and_then(|provider| provider.get("models"))
                .and_then(|models| models.get(id));
            match action.operation.as_str() {
                "delete" => entity.is_none(),
                "rename" => entity.is_none(),
                "reset" => {
                    let path = if kind == "settings" {
                        vec![action.field.clone().unwrap_or_default()]
                    } else {
                        path(provider, id, action.field.as_deref())
                    };
                    root.pointer(&pointer(&path)).is_none()
                }
                _ => false,
            }
        });
        let next_entities = entities(next)?;
        if let Some(previous) = previous {
            for (kind, provider, id) in entities(previous)? {
                if !(next_entities.iter().any(|(next_kind, next_provider, next_id)| next_kind == &kind && next_provider == &provider && next_id == &id))
                    && !state.intents.iter().any(|action| {
                        target(action).is_ok_and(|(k, p, i)| k == kind && p == provider && i == id)
                            && matches!(action.operation.as_str(), "delete" | "rename")
                    })
                {
                    state.intents.push(ConfigurationAction {
                        version: EDITING_VERSION,
                        target: json!({"kind":kind,"provider":provider,"id":id}),
                        operation: "delete".into(), field: None, value: None,
                    });
                }
            }
        }
        Ok(())
    }
    fn suppression_changes(
        &self,
        action: &ConfigurationAction,
    ) -> Result<Vec<SuppressionChange>, String> {
        let (kind, provider, id) = target(action)?;
        let mut changes = vec![];
        if action.operation == "reset" {
            let field = action.field.as_deref().ok_or("缺少字段")?;
            changes.push(SuppressionChange {
                role: "settings".into(),
                path: if kind == "settings" {
                    format!("/{field}")
                } else {
                    pointer(&path(provider, id, Some(field)))
                },
                suppressed: false,
            });
        }
        if matches!(action.operation.as_str(), "delete" | "rename") {
            changes.push(SuppressionChange {
                role: "settings".into(),
                path: pointer(&path(provider, id, None)),
                suppressed: true,
            });
        }
        if action.operation == "create" {
            changes.push(SuppressionChange {
                role: "settings".into(),
                path: pointer(&path(provider, id, None)),
                suppressed: false,
            });
        }
        if matches!(action.operation.as_str(), "copy" | "rename") {
            if let Some(next) = action.value.as_ref().and_then(Value::as_str) {
                changes.push(SuppressionChange {
                    role: "settings".into(), path: pointer(&path(provider, next, None)), suppressed: false,
                });
            }
        }
        Ok(changes)
    }
    fn portable_field_kind(&self, path: &[String]) -> PortableFieldKind {
        match path.last().map(String::as_str) {
            Some("maxTokens" | "maxOutputTokens" | "max_tokens" | "context" | "output") => {
                PortableFieldKind::Parameter
            }
            Some("apiKey") => PortableFieldKind::CredentialReference,
            Some("api_key" | "headers" | "auth" | "oauth") => PortableFieldKind::Credential,
            _ => PortableFieldKind::Unknown,
        }
    }
    fn managed_documents(
        &self,
        documents: Documents,
        profile: &RegisteredProfile,
        _: Scope,
    ) -> Result<Documents, String> {
        let state = profile.editing.as_ref().ok_or("缺少编辑版本")?;
        let mut root = root(&documents);
        let provider = self.connection(&documents, state)?
            .map(|connection| connection.provider_id)
            .or_else(|| selected(&root, state));
        let mut managed = Map::new();
        for key in ["model", "small_model"] {
            if let Some(value) = root.get(key) {
                managed.insert(key.into(), value.clone());
            }
        }
        if let Some(provider) = provider {
            if let Some(mut entry) = root
                .get_mut("provider")
                .and_then(|providers| providers.get_mut(&provider))
                .cloned()
            {
                if let Some(options) = entry.get_mut("options").and_then(Value::as_object_mut) {
                    if options.get("apiKey").is_some_and(|value| {
                        !self.portable_reference_valid(&["apiKey".into()], value)
                    }) {
                        options.remove("apiKey");
                    }
                }
                managed.insert("provider".into(), json!({provider:entry}));
            }
        }
        Ok(BTreeMap::from([(
            "settings".into(),
            Value::Object(managed),
        )]))
    }
    fn empty_deleted_entities(
        &self,
        role: &str,
        profile: &RegisteredProfile,
    ) -> Result<Vec<Vec<String>>, String> {
        if role != "settings" {
            return Ok(vec![]);
        }
        let own = profile.files.get("settings")
            .map(|text| crate::native::format::parse(crate::native::format::FileKind::Jsonc, text))
            .transpose()?.unwrap_or_else(|| json!({}));
        profile
            .editing
            .as_ref()
            .ok_or("缺少编辑版本")?
            .intents
            .iter()
            .filter(|action| matches!(action.operation.as_str(), "delete" | "rename")
                && target(action).is_ok_and(|(_, provider, id)| own.pointer(&pointer(&path(provider, id, None))).is_none()))
            .map(|action| {
                let (kind, provider, id) = target(action)?;
                if kind != "model" {
                    return Err("未声明此实体删除目标".into());
                }
                Ok(path(provider, id, None))
            })
            .collect()
    }
    fn managed_fields(
        &self,
        _: &str,
        current: &Value,
        desired: &Value,
        profile: &RegisteredProfile,
    ) -> Result<ManagedConfiguration, String> {
        let mut candidate = desired.clone();
        if let Some(providers) = candidate.get_mut("provider").and_then(Value::as_object_mut) {
            for (provider, entry) in providers {
                if entry.get("models").and_then(Value::as_object).is_some_and(Map::is_empty)
                    && profile.editing.as_ref().is_some_and(|state| state.intents.iter().any(|action|
                        target(action).is_ok_and(|(kind, p, _)| kind == "model" && p == provider
                            && matches!(action.operation.as_str(), "delete" | "rename"))))
                { entry.as_object_mut().unwrap().remove("models"); }
            }
        }
        let mut fields = BTreeMap::new();
        crate::native::apply::flatten(&candidate, &mut vec![], &mut fields);
        let mut managed = ManagedConfiguration {
            fields: fields
                .into_iter()
                .map(|(path, value)| (path, Some(value)))
                .collect(),
            released: vec![],
        };
        for action in &profile.editing.as_ref().ok_or("缺少编辑版本")?.intents {
            let (kind, provider, id) = target(action)?;
            if matches!(action.operation.as_str(), "delete" | "rename") {
                if desired.pointer(&pointer(&path(provider, id, None))).is_some() { continue; }
                if current
                    .get("agent")
                    .and_then(Value::as_object)
                    .is_some_and(|agents| {
                        agents.values().any(|agent| {
                            agent.get("model").and_then(Value::as_str)
                                == Some(&format!("{provider}/{id}"))
                        })
                    })
                {
                    return Err(
                        "原生角色仍引用被删除/改名的模型；请先修改角色引用，文件未修改".into(),
                    );
                }
                let prefix = pointer(&path(provider, id, None));
                if let Some(entity) = current.pointer(&prefix) {
                    let mut old = BTreeMap::new();
                    crate::native::apply::flatten(entity, &mut path(provider, id, None), &mut old);
                    for pointer in old.keys() {
                        managed.fields.insert(pointer.clone(), None);
                    }
                }
            } else if action.operation == "reset" {
                managed.released.push(if kind == "settings" {
                    format!("/{}", action.field.as_deref().unwrap_or(""))
                } else {
                    pointer(&path(provider, id, action.field.as_deref()))
                });
            }
        }
        Ok(managed)
    }
}
