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
/// Canonical create payloads may only use the editor's declared fields.
const CREATE_FIELDS: &[&str] = &["name", "limit", "modalities", "reasoning", "options", "variants"];

/// Native config form of the selected installation. v1 uses `provider`/`npm`
/// /`options`/`modalities` and `small_model`; v2 uses `providers`/`package`
/// (with the `aisdk:` prefix)/`settings`/`capabilities` and
/// `agents.title.model` (verified against a native 2.0.29 load).
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Form {
    V1,
    V2,
}

const AISDK_PREFIX: &str = "aisdk:";

impl Form {
    pub(crate) fn providers_key(self) -> &'static str {
        match self {
            Form::V1 => "provider",
            Form::V2 => "providers",
        }
    }
    pub(crate) fn package_key(self) -> &'static str {
        match self {
            Form::V1 => "npm",
            Form::V2 => "package",
        }
    }
    pub(crate) fn provider_settings_key(self) -> &'static str {
        match self {
            Form::V1 => "options",
            Form::V2 => "settings",
        }
    }
    fn modality_key(self) -> &'static str {
        match self {
            Form::V1 => "modalities",
            Form::V2 => "capabilities",
        }
    }
    fn model_options_key(self) -> &'static str {
        match self {
            Form::V1 => "options",
            Form::V2 => "settings",
        }
    }
    /// Native location of the light-model reference.
    fn small_model_path(self) -> Vec<String> {
        match self {
            Form::V1 => vec!["small_model".into()],
            // The v2 native light model lives in the title agent; Cliora keeps
            // a single authority there instead of a separate small_model key.
            Form::V2 => vec!["agents".into(), "title".into(), "model".into()],
        }
    }
}

/// Form for writes, resolved once at draft begin/application from the selected
/// installation. `None` keeps the legacy v1 behavior for old persisted states;
/// an explicitly unverified token refuses every write.
pub(crate) fn form_of(state: &EditingState) -> Result<Form, String> {
    match state.native_form.as_deref() {
        None | Some("v1") => Ok(Form::V1),
        Some("v2") => Ok(Form::V2),
        Some(_) => Err(
            "OpenCode 安装版本尚未核验（未验证）；请先确认安装版本后再编辑或保存配置".into(),
        ),
    }
}

/// Soft resolution for read-side checks: an unverified draft still views with
/// the legacy form so only writes are gated.
fn view_form(state: &EditingState) -> Form {
    form_of(state).unwrap_or(Form::V1)
}

pub(crate) fn interface_from_package(value: &str) -> Option<&'static str> {
    crate::native::intake::api_format(value.trim_start_matches(AISDK_PREFIX))
}

fn package_base(interface: &str) -> Result<&'static str, String> {
    Ok(match interface {
        "openai_completions" => "@ai-sdk/openai-compatible",
        "openai_responses" => "@ai-sdk/openai",
        "anthropic_messages" => "@ai-sdk/anthropic",
        _ => return Err("不支持此连接协议".into()),
    })
}

fn package_value(form: Form, interface: &str) -> Result<Value, String> {
    let base = package_base(interface)?;
    Ok(match form {
        Form::V1 => json!(base),
        Form::V2 => json!(format!("{AISDK_PREFIX}{base}")),
    })
}

/// Base model id of a `provider/model#variant` reference; v2 keeps the variant
/// suffix in the native string, editor identities use the base id.
fn base_model_id(id: &str) -> &str {
    id.split('#').next().unwrap_or(id)
}

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
/// Native entity path of a model (and optional editor field) in one form.
pub(crate) fn model_path(form: Form, provider: &str, id: &str, field: Option<&str>) -> Vec<String> {
    let mut path = vec![form.providers_key().into(), provider.into(), "models".into(), id.into()];
    if let Some(field) = field {
        path.extend(native_field_segments(form, field));
    }
    path
}
/// Native segments of a canonical editor field inside a model entry.
pub(crate) fn native_field_segments(form: Form, field: &str) -> Vec<String> {
    let segments: &[&str] = match (form, field) {
        (_, "name") => &["name"],
        (_, "limit.context") => &["limit", "context"],
        (_, "limit.output") => &["limit", "output"],
        (_, "reasoning") => &["reasoning"],
        (Form::V1, "modalities.input") => &["modalities", "input"],
        (Form::V1, "modalities.output") => &["modalities", "output"],
        (Form::V1, "options") => &["options"],
        (Form::V1, "variants") => &["variants"],
        (Form::V2, "modalities.input") => &["capabilities", "input"],
        (Form::V2, "modalities.output") => &["capabilities", "output"],
        (Form::V2, "options") => &["settings"],
        (Form::V2, "variants") => &["variants"],
        // Unknown editor fields keep their dotted path (legacy passthrough).
        _ => return field.split('.').map(str::to_owned).collect(),
    };
    segments.iter().map(|segment| segment.to_string()).collect()
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
/// Merged v1/v2 provider entries for reading; a same-id overlap is a conflict.
pub(crate) fn provider_entries(root: &Value) -> Result<BTreeMap<String, Value>, String> {
    let v1 = root.get("provider").and_then(Value::as_object);
    let v2 = root.get("providers").and_then(Value::as_object);
    if let (Some(v1), Some(v2)) = (v1, v2) {
        if v1.keys().any(|id| v2.contains_key(id)) {
            return Err("同一供应商同时存在 v1 `provider` 与 v2 `providers` 同义条目；请先在原文只保留一种形态，文件不会被改写".into());
        }
    }
    Ok(union_entries_lossy(root))
}

/// Union without conflict detection; viewing a conflicted file still lists
/// every entity while writes stay rejected.
fn union_entries_lossy(root: &Value) -> BTreeMap<String, Value> {
    let mut merged = BTreeMap::new();
    for key in ["provider", "providers"] {
        if let Some(entries) = root.get(key).and_then(Value::as_object) {
            for (id, entry) in entries {
                merged.insert(id.clone(), entry.clone());
            }
        }
    }
    merged
}
pub(crate) fn entry_base_url(entry: &Value) -> Option<&str> {
    entry
        .pointer("/options/baseURL")
        .or_else(|| entry.pointer("/settings/baseURL"))
        .and_then(Value::as_str)
}
pub(crate) fn entry_package(entry: &Value) -> Option<&str> {
    entry
        .get("npm")
        .or_else(|| entry.get("package"))
        .and_then(Value::as_str)
}
fn entry_models(entry: &Value) -> Option<&Map<String, Value>> {
    entry.get("models").and_then(Value::as_object)
}
/// Match the longest known provider prefix so model IDs retain their slashes.
/// The v2 `#variant` suffix is not part of the editor identity.
pub(super) fn reference(root: &Value, value: &str) -> Option<(String, String)> {
    provider_entries(root)
        .ok()?
        .keys()
        .filter_map(|provider| {
            value
                .strip_prefix(&format!("{provider}/"))
                .map(|id| (provider.clone(), base_model_id(id).to_owned()))
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
    for (provider, entry) in provider_entries(&root)? {
        if let Some(models) = entry_models(&entry) {
            result.extend(models.keys().map(|id| ("model".into(), provider.clone(), id.clone())));
        }
    }
    Ok(result)
}

/// Convert a v2 variants array (entries carry `id`) to the editor's object
/// projection and back. Non-matching shapes pass through unchanged.
pub(crate) fn variants_to_canonical(native: &Value) -> Value {
    let Some(items) = native.as_array() else {
        return native.clone();
    };
    let mut map = Map::new();
    for item in items {
        let Some(id) = item.get("id").and_then(Value::as_str) else {
            continue;
        };
        let mut rest = item.as_object().cloned().unwrap_or_default();
        rest.remove("id");
        map.insert(id.to_owned(), Value::Object(rest));
    }
    Value::Object(map)
}
pub(crate) fn variants_to_native(value: &Value) -> Value {
    let Some(map) = value.as_object() else {
        return value.clone();
    };
    Value::Array(
        map.iter()
            .map(|(id, rest)| {
                let mut item = rest.as_object().cloned().unwrap_or_default();
                item.insert("id".into(), json!(id));
                Value::Object(item)
            })
            .collect(),
    )
}

/// Project a native model entry into the editor's canonical field names.
pub(crate) fn canonical_model_fields(form: Form, native: &Value) -> Value {
    let mut out = Map::new();
    let object = native.as_object();
    for source in [form.modality_key(), if form == Form::V2 { "modalities" } else { "capabilities" }] {
        let Some(value) = object.and_then(|map| map.get(source)) else {
            continue;
        };
        let mut modalities = out
            .remove("modalities")
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        let mut leftover = Map::new();
        for (part, item) in value.as_object().into_iter().flatten() {
            if matches!(part.as_str(), "input" | "output") {
                modalities.insert(part.clone(), item.clone());
            } else {
                leftover.insert(part.clone(), item.clone());
            }
        }
        if !modalities.is_empty() {
            out.insert("modalities".into(), Value::Object(modalities));
        }
        if !leftover.is_empty() {
            out.insert(source.to_owned(), Value::Object(leftover));
        }
    }
    for (source, canonical) in [
        ("options", "options"),
        ("settings", "options"),
        ("name", "name"),
        ("limit", "limit"),
        ("reasoning", "reasoning"),
    ] {
        if let Some(value) = object.and_then(|map| map.get(source)) {
            out.insert(canonical.into(), value.clone());
        }
    }
    if let Some(variants) = object.and_then(|map| map.get("variants")) {
        let value = if variants.is_array() {
            variants_to_canonical(variants)
        } else {
            variants.clone()
        };
        out.insert("variants".into(), value);
    }
    // Unknown native keys stay visible so raw round-trips keep their values.
    if let Some(map) = object {
        for (key, value) in map {
            if !matches!(
                key.as_str(),
                "name" | "limit" | "reasoning" | "modalities" | "capabilities" | "options" | "settings" | "variants"
            ) {
                out.insert(key.clone(), value.clone());
            }
        }
    }
    Value::Object(out)
}

/// Rewrite a provider entity (protocol, address, models) into one form.
pub(crate) fn provider_entry_in_form(entry: &Value, form: Form) -> Value {
    let mut out = Map::new();
    let object = entry.as_object();
    if let Some(package) = entry_package(entry) {
        let base = package.trim_start_matches(AISDK_PREFIX);
        let value = match form {
            Form::V1 => base.to_owned(),
            Form::V2 => format!("{AISDK_PREFIX}{base}"),
        };
        out.insert(form.package_key().into(), json!(value));
    }
    let settings = entry
        .get("options")
        .or_else(|| entry.get("settings"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if !settings.is_empty() {
        out.insert(
            form.provider_settings_key().into(),
            Value::Object(settings),
        );
    }
    if let Some(models) = entry_models(entry) {
        let mut converted = Map::new();
        for (id, model) in models {
            converted.insert(id.clone(), model_in_form(model, form));
        }
        out.insert("models".into(), Value::Object(converted));
    }
    if let Some(map) = object {
        for (key, value) in map {
            if !matches!(key.as_str(), "npm" | "package" | "options" | "settings" | "models") {
                out.insert(key.clone(), value.clone());
            }
        }
    }
    Value::Object(out)
}

/// Rewrite one native model entry into the target form, preserving unknown keys.
pub(crate) fn model_in_form(model: &Value, form: Form) -> Value {
    let mut out = Map::new();
    let object = model.as_object();
    for key in ["modalities", "capabilities"] {
        let Some(value) = object.and_then(|map| map.get(key)) else {
            continue;
        };
        let mut bucket = out
            .remove(form.modality_key())
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        let mut leftover = Map::new();
        for (part, item) in value.as_object().into_iter().flatten() {
            if matches!(part.as_str(), "input" | "output") {
                bucket.insert(part.clone(), item.clone());
            } else {
                leftover.insert(part.clone(), item.clone());
            }
        }
        if !bucket.is_empty() {
            out.insert(form.modality_key().into(), Value::Object(bucket));
        }
        if !leftover.is_empty() {
            out.insert(key.to_owned(), Value::Object(leftover));
        }
    }
    for source in ["options", "settings"] {
        if let Some(value) = object.and_then(|map| map.get(source)) {
            out.insert(form.model_options_key().into(), value.clone());
        }
    }
    if let Some(variants) = object.and_then(|map| map.get("variants")) {
        let value = match (form, variants) {
            (Form::V2, Value::Object(_)) => variants_to_native(variants),
            (Form::V1, Value::Array(_)) => variants_to_canonical(variants),
            _ => variants.clone(),
        };
        out.insert("variants".into(), value);
    }
    if let Some(map) = object {
        for (key, value) in map {
            if !matches!(
                key.as_str(),
                "modalities" | "capabilities" | "options" | "settings" | "variants"
            ) {
                out.insert(key.clone(), value.clone());
            }
        }
    }
    Value::Object(out)
}

/// Canonicalize a model entry of unknown native form for viewing/validation.
fn canonical_model_of_unknown_form(native: &Value) -> Value {
    let has_v2 = native.get("capabilities").is_some() || native.get("settings").is_some();
    let form = if has_v2 { Form::V2 } else { Form::V1 };
    canonical_model_fields(form, native)
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

/// Move a provider entity wholly into the target form when it only exists in
/// the other form, so an edited entity never leaves a same-id synonym behind.
fn ensure_provider_form(root: &mut Value, form: Form, provider: &str) -> Result<(), String> {
    let other = match form {
        Form::V1 => "providers",
        Form::V2 => "provider",
    };
    let has_target = root
        .get(form.providers_key())
        .and_then(|nodes| nodes.get(provider))
        .is_some();
    let other_entry = root.get(other).and_then(|nodes| nodes.get(provider)).cloned();
    if has_target || other_entry.is_none() {
        return Ok(());
    }
    let converted = provider_entry_in_form(&other_entry.unwrap(), form);
    set(root, &[other.into(), provider.into()], None)?;
    set(
        root,
        &[form.providers_key().into(), provider.into()],
        Some(converted),
    )?;
    Ok(())
}

/// Any agent entry (v1 `agent` or v2 `agents`) still referencing the model.
fn agent_references(root: &Value, provider: &str, id: &str) -> bool {
    let expected = format!("{provider}/{id}");
    ["agent", "agents"].iter().any(|key| {
        root.get(*key)
            .and_then(Value::as_object)
            .is_some_and(|agents| {
                agents.values().any(|agent| {
                    agent
                        .get("model")
                        .and_then(Value::as_str)
                        .is_some_and(|value| base_model_id(value) == expected)
                })
            })
    })
}

/// Native locations of the default and light model references in one form.
fn model_reference_paths(form: Form) -> Vec<Vec<String>> {
    let mut paths = vec![vec!["model".into()]];
    paths.push(form.small_model_path());
    paths
}

fn settings_field_path(form: Form, field: &str) -> Result<Vec<String>, String> {
    match field {
        "model" => Ok(vec!["model".into()]),
        "small_model" => Ok(form.small_model_path()),
        _ => Err("未声明此原生设置".into()),
    }
}

impl ConfigurationAdapter for OpenCode {
    fn credential_paths(&self,connection:&Connection)->Vec<(&'static str,Vec<String>)>{
        ["apiKey"].iter().map(|field|("settings",vec!["provider".into(),connection.provider_id.clone(),"options".into(),(*field).into()])).collect()
    }
    fn credential_paths_for_form(&self, connection: &Connection, form: Option<&str>) -> Vec<(&'static str, Vec<String>)> {
        let form = if form == Some("v2") { Form::V2 } else { Form::V1 };
        ["apiKey"].iter().map(|field|("settings",vec![form.providers_key().into(),connection.provider_id.clone(),form.provider_settings_key().into(),(*field).into()])).collect()
    }
    fn configuration_requires_version(&self) -> bool {
        true
    }
    fn native_form_for_version(&self, version: Option<&str>) -> Option<String> {
        let major = version?
            .trim()
            .trim_start_matches('v')
            .split('.')
            .next()?
            .parse::<u32>()
            .ok()?;
        match major {
            1 => Some("v1".into()),
            2 => Some("v2".into()),
            _ => None,
        }
    }

    fn native_verification_module(&self) -> Option<&'static str> { Some("src-tauri/src/adapters/opencode/native_verification.mjs") }
    fn catalog_support(&self) -> CatalogSupport { CatalogSupport { available: true, multiple: true, reason: None } }
    fn common_parameters(&self, _: Scope) -> Vec<CommonParameter> {
        let mut log = field("logLevel", "日志级别", "string", false); log.choices = ["DEBUG","INFO","WARN","ERROR"].iter().map(|value| (*value).into()).collect();
        vec![field("theme", "主题", "string", false), log, field("permission", "权限设置", "json", true)].into_iter()
            .map(|field| CommonParameter { path: vec![field.id.clone()], field, role: "settings", target: json!({"kind":"settings"}) }).collect()
    }
    fn common_forbidden_paths(&self) -> Vec<(&'static str, &'static str)> {
        // Both native forms of model references stay out of the common layer.
        vec![("settings","/model"), ("settings","/small_model"), ("settings","/agent"), ("settings","/agents")]
    }
    fn draft_connection(&self, documents: &Documents, state: &EditingState) -> Result<Option<Connection>, String> {
        let mut documents = documents.clone();
        let root = root(&documents); let Some(provider) = selected(&root, state) else { return Ok(None); };
        let model = provider_entries(&root)?
            .get(&provider)
            .and_then(|entry| entry_models(entry))
            .and_then(|models| models.keys().next().cloned())
            .unwrap_or_default();
        documents.entry("settings".into()).or_insert_with(|| json!({}))["model"] = json!(format!("{provider}/{model}"));
        self.connection(&documents, state)
    }
    fn catalog_actions(&self, documents: &Documents, state: &EditingState, ids: &[String]) -> Result<Vec<ConfigurationAction>, String> {
        let root = root(documents); let provider = selected(&root, state).ok_or("请先设置供应商连接")?;
        let models = provider_entries(&root)?
            .get(&provider)
            .and_then(|entry| entry_models(entry))
            .cloned()
            .unwrap_or_default();
        Ok(ids.iter().filter(|id| !models.contains_key(*id)).map(|id| ConfigurationAction {
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
        profile: &RegisteredProfile,
    ) -> Result<Vec<String>, String> {
        if role != "settings" {
            return Ok(vec![]);
        }
        let form = profile
            .editing
            .as_ref()
            .map(view_form)
            .unwrap_or(Form::V1);
        let selected = desired
            .get(form.providers_key())
            .and_then(Value::as_object)
            .and_then(|providers| providers.keys().next());
        Ok(current
            .get(form.providers_key())
            .and_then(Value::as_object)
            .map(|providers| {
                providers
                    .keys()
                    .filter(|id| Some(*id) != selected)
                    .map(|id| format!("/{}", pointer_token(id)))
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
        // Viewing a conflicted (v1+v2 synonym) file still lists everything;
        // the conflict reason is surfaced and writes stay rejected.
        let conflict = provider_entries(&root).is_err();
        let entries = if conflict {
            union_entries_lossy(&root)
        } else {
            provider_entries(&root)?
        };
        let provider = provider.or_else(|| conflict.then(|| entries.keys().next().cloned()).flatten());
        let entry = provider.as_ref().and_then(|id| entries.get(id));
        let models = entry
            .and_then(|entry| entry_models(entry))
            .map(|models| {
                models
                    .iter()
                    .map(|(id, value)| {
                        json!({"id":id,"fields":canonical_model_fields(view_form(state), value),"kind":"model"})
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let model = |value: Option<&str>| {
            value
                .and_then(|value| reference(&root, value))
                .filter(|(id, _)| Some(id) == provider.as_ref())
                .map(|(_, model)| model)
        };
        // Dual-form read: v1 `small_model` and v2 `agents.title.model` are the
        // same canonical light-model reference.
        let small_model = root
            .get("small_model")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| {
                root.pointer("/agents/title/model")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
        let package = entry.and_then(entry_package);
        let reason = if conflict {
            "同一供应商同时存在 v1/v2 同义条目；保存被拒绝，请先在原文只保留一种形态"
        } else if package.is_some_and(|package| interface_from_package(package).is_none()) {
            "保留扩展供应商协议；当前连接目录与凭据能力未核验"
        } else {
            ""
        };
        Ok(
            json!({"providerId":provider,"providers":entries.keys().cloned().collect::<Vec<_>>(),"models":models,"defaultModel":model(root.get("model").and_then(Value::as_str)),"smallModel":model(small_model.as_deref()),"connection":{"baseUrl":entry.and_then(entry_base_url),"protocol":package.map(|package| package.trim_start_matches(AISDK_PREFIX))},"capabilityReason":reason}),
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
            if !provider_entries(&effective)?.contains_key(provider) {
                return Err("供应商不存在".into());
            }
            state.selected_provider = Some(provider.into());
            return Ok(());
        }
        let form = form_of(state)?;
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
            let interface = match value.get("interfaceFormat").and_then(Value::as_str) {
                Some("openai_completions") => "openai_completions",
                Some("openai_responses") => "openai_responses",
                Some("anthropic_messages") => "anthropic_messages",
                _ => return Err("不支持此连接协议".into()),
            };
            // An edited entity keeps a single form: rewrite the whole provider
            // node when it only exists under the other form's key.
            ensure_provider_form(root, form, provider)?;
            set(
                root,
                &[
                    form.providers_key().into(),
                    provider.into(),
                    form.package_key().into(),
                ],
                Some(package_value(form, interface)?),
            )?;
            set(
                root,
                &[
                    form.providers_key().into(),
                    provider.into(),
                    form.provider_settings_key().into(),
                    "baseURL".into(),
                ],
                Some(json!(base)),
            )?;
            state.selected_provider = Some(provider.into());
            return Ok(());
        }
        if kind == "settings" {
            let field = action.field.as_deref().ok_or("缺少设置字段")?;
            let path = settings_field_path(form, field)?;
            if !matches!(action.operation.as_str(), "set" | "reset") {
                return Err("不支持此设置动作".into());
            }
            return set(
                root,
                &path,
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
        // Any model-level write first moves the provider entity into the
        // target form, so one nested entry never keeps both spellings.
        ensure_provider_form(root, form, provider)?;
        let effective_entry = provider_entries(&effective)?.get(provider).cloned();
        let existing = effective_entry
            .as_ref()
            .and_then(|entry| entry_models(entry))
            .and_then(|models| models.get(id))
            .cloned();
        let entity_path = |field: Option<&str>| model_path(form, provider, id, field);
        match action.operation.as_str() {
            "create" => {
                if existing.is_some() {
                    return Err("模型标识已存在".into());
                }
                let value = action.value.clone().unwrap_or_else(|| json!({}));
                let fields = value.as_object().ok_or("模型字段必须是对象")?;
                if fields.keys().any(|field| !CREATE_FIELDS.contains(&field.as_str())) {
                    return Err("新增模型含未声明字段；请使用原生文本保留扩展字段".into());
                }
                // Creating a model under a provider of the other form moves the
                // provider entity into the target form first.
                ensure_provider_form(root, form, provider)?;
                set(root, &entity_path(None), Some(model_in_form(&value, form)))?;
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
                if effective_entry
                    .as_ref()
                    .and_then(|entry| entry_models(entry))
                    .and_then(|models| models.get(next))
                    .is_some()
                {
                    return Err("新模型标识已存在".into());
                }
                set(
                    root,
                    &model_path(form, provider, next, None),
                    Some(existing.clone().ok_or("模型不存在")?),
                )?;
                retire_entity(state, kind, provider, next);
                if action.operation == "rename" {
                    if agent_references(&effective, provider, id) {
                        return Err("角色仍引用旧模型标识，请先修改角色引用".into());
                    }
                    set(root, &entity_path(None), None)?;
                    for path in model_reference_paths(form) {
                        if effective
                            .pointer(&pointer(&path))
                            .and_then(Value::as_str)
                            .is_some_and(|value| {
                                base_model_id(value) == format!("{provider}/{id}")
                            })
                        {
                            set(
                                root,
                                &path,
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
                if model_reference_paths(form).iter().any(|path| {
                    effective
                        .pointer(&pointer(path))
                        .and_then(Value::as_str)
                        .is_some_and(|value| base_model_id(value) == format!("{provider}/{id}"))
                }) {
                    return Err("此模型仍是默认或轻量模型，请先选择替代模型后删除".into());
                }
                if agent_references(&effective, provider, id) {
                    return Err("角色仍引用此模型，请先在原生文本或角色管理中修改引用".into());
                }
                set(root, &entity_path(None), None)?;
                for path in model_reference_paths(form) {
                    if effective
                        .pointer(&pointer(&path))
                        .and_then(Value::as_str)
                        .is_some_and(|value| base_model_id(value) == format!("{provider}/{id}"))
                    {
                        set(root, &path, None)?;
                    }
                }
            }
            "default" | "small_default" => {
                if existing.is_none() {
                    return Err("模型不存在".into());
                }
                let path = if action.operation == "default" {
                    vec!["model".into()]
                } else {
                    form.small_model_path()
                };
                set(root, &path, Some(json!(format!("{provider}/{id}"))))?;
            }
            "set" | "reset" => {
                let field = action.field.as_deref().ok_or("缺少模型字段")?;
                if !MODEL_FIELDS.contains(&field) {
                    return Err("未声明此模型字段".into());
                }
                if existing.is_none() {
                    return Err("模型不存在".into());
                }
                let value = if action.operation == "reset" {
                    None
                } else {
                    action.value.clone().map(|value| {
                        if form == Form::V2 && field == "variants" {
                            variants_to_native(&value)
                        } else {
                            value
                        }
                    })
                };
                set(root, &entity_path(Some(field)), value)?;
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
        let form = view_form(state);
        let managed_provider = self.connection(documents, state).ok().flatten()
            .map(|connection| connection.provider_id);
        let mut issues = vec![];
        if let Err(message) = provider_entries(&root) {
            issues.push(issue(json!({"kind":"settings"}), "provider", &message));
        }
        if let Ok(providers) = provider_entries(&root) {
            for (provider, entry) in &providers {
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
                            // Checks run on the canonical projection so both
                            // native field spellings validate identically.
                            let canonical = canonical_model_of_unknown_form(model);
                            for field in ["limit.context", "limit.output"] {
                                let pointer = format!("/{}", field.replace('.', "/"));
                                if let Some(value) = canonical.pointer(&pointer) {
                                    if !value.as_u64().is_some_and(|value| value > 0) {
                                        issues.push(issue(target.clone(), field, "上限须为正整数"));
                                    }
                                }
                            }
                            for field in ["options", "variants", "limit", "modalities"] {
                                if canonical.get(field).is_some_and(|value| !value.is_object()) {
                                    issues.push(issue(target.clone(), field, "此字段须为原生对象"));
                                }
                            }
                            for field in ["modalities.input", "modalities.output"] {
                                if let Some(value) =
                                    canonical.pointer(&format!("/{}", field.replace('.', "/")))
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
                            if canonical
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
                    for path in model_reference_paths(form) {
                        if root.pointer(&pointer(&path)).and_then(Value::as_str).is_some_and(|value| {
                            base_model_id(value) == format!("{provider}/{id}")
                        }) {
                            issues.push(issue(json!({"kind":"settings"}), path.last().unwrap(),
                                "已删除的模型仍被引用，请选择替代模型"));
                        }
                    }
                }
            }
        }
        for path in model_reference_paths(form) {
            if let Some(value) = root.pointer(&pointer(&path)) {
                if let Some(value) = value.as_str() {
                    if let Some((provider, id)) = reference(&root, value) {
                        let entry = provider_entries(&root)
                            .ok()
                            .and_then(|providers| providers.get(&provider).cloned());
                        if entry
                            .as_ref()
                            .and_then(|entry| entry_models(entry))
                            .is_some_and(|models| !models.contains_key(&id))
                        {
                            issues.push(issue(
                                json!({"kind":"settings"}),
                                path.last().unwrap(),
                                "模型引用不存在；请设置有效模型或恢复默认",
                            ));
                        }
                    }
                } else {
                    issues.push(issue(json!({"kind":"settings"}), path.last().unwrap(), "模型引用须为字符串"));
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
        let entries = provider_entries(&root)?;
        let Some(entry) = entries.get(&provider) else {
            return Ok(None);
        };
        let Some(base) = entry_base_url(entry) else {
            return Ok(None);
        };
        let Some(format) = entry_package(entry).and_then(interface_from_package) else {
            return Ok(None);
        };
        let auth = entry
            .pointer("/options/apiKey")
            .or_else(|| entry.pointer("/settings/apiKey"))
            .and_then(Value::as_str)
            .and_then(|value| value.strip_prefix("{env:"))
            .and_then(|value| value.strip_suffix('}'))
            .map(str::to_owned);
        let models = entry_models(entry)
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
        let form = view_form(state);
        state.intents.retain(|action| {
            let Ok((kind, provider, id)) = target(action) else {
                return false;
            };
            let entity = provider_entries(&root)
                .ok()
                .and_then(|providers| providers.get(provider).cloned())
                .and_then(|entry| entry_models(&entry).and_then(|models| models.get(id).cloned()));
            match action.operation.as_str() {
                "delete" => entity.is_none(),
                "rename" => entity.is_none(),
                "reset" => {
                    let path = if kind == "settings" {
                        settings_field_path(form, action.field.as_deref().unwrap_or_default())
                            .unwrap_or_else(|_| vec![action.field.clone().unwrap_or_default()])
                    } else {
                        model_path(form, provider, id, action.field.as_deref())
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
        state: &EditingState,
    ) -> Result<Vec<SuppressionChange>, String> {
        let (kind, provider, id) = target(action)?;
        // Navigation-only actions never touch native paths, so an unresolved
        // form must not block them.
        if !matches!(
            action.operation.as_str(),
            "reset" | "delete" | "rename" | "create" | "copy"
        ) {
            return Ok(vec![]);
        }
        let form = form_of(state)?;
        let mut changes = vec![];
        if action.operation == "reset" {
            let field = action.field.as_deref().ok_or("缺少字段")?;
            changes.push(SuppressionChange {
                role: "settings".into(),
                path: if kind == "settings" {
                    pointer(&settings_field_path(form, field)?)
                } else {
                    pointer(&model_path(form, provider, id, Some(field)))
                },
                suppressed: false,
            });
        }
        if matches!(action.operation.as_str(), "delete" | "rename") {
            changes.push(SuppressionChange {
                role: "settings".into(),
                path: pointer(&model_path(form, provider, id, None)),
                suppressed: true,
            });
        }
        if action.operation == "create" {
            changes.push(SuppressionChange {
                role: "settings".into(),
                path: pointer(&model_path(form, provider, id, None)),
                suppressed: false,
            });
        }
        if matches!(action.operation.as_str(), "copy" | "rename") {
            if let Some(next) = action.value.as_ref().and_then(Value::as_str) {
                changes.push(SuppressionChange {
                    role: "settings".into(), path: pointer(&model_path(form, provider, next, None)), suppressed: false,
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
        let form = form_of(state)?;
        let mut root = root(&documents);
        let provider = self.connection(&documents, state)?
            .map(|connection| connection.provider_id)
            .or_else(|| selected(&root, state));
        let mut managed = json!({});
        if let Some(value) = root.get("model") {
            set(&mut managed, &["model".into()], Some(value.clone()))?;
        }
        let small = form.small_model_path();
        if let Some(value) = root.pointer(&pointer(&small)) {
            set(&mut managed, &small, Some(value.clone()))?;
        }
        if let Some(provider) = provider {
            if let Some(mut entry) = root
                .get_mut(form.providers_key())
                .and_then(|providers| providers.get_mut(&provider))
                .cloned()
            {
                if let Some(options) = entry
                    .get_mut(form.provider_settings_key())
                    .and_then(Value::as_object_mut)
                {
                    if options.get("apiKey").is_some_and(|value| {
                        !self.portable_reference_valid(&["apiKey".into()], value)
                    }) {
                        options.remove("apiKey");
                    }
                }
                set(
                    &mut managed,
                    &[form.providers_key().into()],
                    Some(json!({provider:entry})),
                )?;
            }
        }
        let Value::Object(managed) = managed else {
            return Ok(BTreeMap::from([("settings".into(), json!({}))]));
        };
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
        let state = profile.editing.as_ref().ok_or("缺少编辑版本")?;
        let form = form_of(state)?;
        let own = profile.files.get("settings")
            .map(|text| crate::native::format::parse(crate::native::format::FileKind::Jsonc, text))
            .transpose()?.unwrap_or_else(|| json!({}));
        state
            .intents
            .iter()
            .filter(|action| matches!(action.operation.as_str(), "delete" | "rename")
                && target(action).is_ok_and(|(_, provider, id)| own.pointer(&pointer(&model_path(form, provider, id, None))).is_none()))
            .map(|action| {
                let (kind, provider, id) = target(action)?;
                if kind != "model" {
                    return Err("未声明此实体删除目标".into());
                }
                Ok(model_path(form, provider, id, None))
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
        let state = profile.editing.as_ref().ok_or("缺少编辑版本")?;
        let form = form_of(state)?;
        let mut candidate = desired.clone();
        if let Some(providers) = candidate.get_mut(form.providers_key()).and_then(Value::as_object_mut) {
            for (provider, entry) in providers {
                if entry.get("models").and_then(Value::as_object).is_some_and(Map::is_empty)
                    && state.intents.iter().any(|action|
                        target(action).is_ok_and(|(kind, p, _)| kind == "model" && p == provider
                            && matches!(action.operation.as_str(), "delete" | "rename")))
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
        for action in &state.intents {
            let (kind, provider, id) = target(action)?;
            if matches!(action.operation.as_str(), "delete" | "rename") {
                if desired.pointer(&pointer(&model_path(form, provider, id, None))).is_some() { continue; }
                if agent_references(current, provider, id) {
                    return Err(
                        "原生角色仍引用被删除/改名的模型；请先修改角色引用，文件未修改".into(),
                    );
                }
                let prefix = pointer(&model_path(form, provider, id, None));
                if let Some(entity) = current.pointer(&prefix) {
                    let mut old = BTreeMap::new();
                    crate::native::apply::flatten(entity, &mut model_path(form, provider, id, None), &mut old);
                    for pointer in old.keys() {
                        managed.fields.insert(pointer.clone(), None);
                    }
                }
            } else if action.operation == "reset" {
                managed.released.push(if kind == "settings" {
                    pointer(&settings_field_path(form, action.field.as_deref().unwrap_or(""))?)
                } else {
                    pointer(&model_path(form, provider, id, action.field.as_deref()))
                });
            }
        }
        Ok(managed)
    }
}
