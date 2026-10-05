use super::Claude;
use crate::adapters::configuration::*;
use crate::native::{
    adapter::Scope,
    profile::{Connection, RegisteredProfile},
};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const ROLES: &[(&str, &str)] = &[
    ("default", "ANTHROPIC_MODEL"),
    ("sonnet", "ANTHROPIC_DEFAULT_SONNET_MODEL"),
    ("opus", "ANTHROPIC_DEFAULT_OPUS_MODEL"),
    ("fable", "ANTHROPIC_DEFAULT_FABLE_MODEL"),
    ("haiku", "ANTHROPIC_DEFAULT_HAIKU_MODEL"),
    ("subagent", "CLAUDE_CODE_SUBAGENT_MODEL"),
];
fn root(documents: &Documents) -> Result<Value, String> {
    let settings = documents
        .get("settings")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if !settings.is_object() || settings.get("env").is_some_and(|env| !env.is_object()) {
        return Err("Claude settings 和 env 须为 JSON 对象".into());
    }
    if let Some(local) = documents.get("local_settings") {
        if !local.is_object() || local.get("env").is_some_and(|env| !env.is_object()) {
            return Err("Claude local settings 和 env 须为 JSON 对象".into());
        }
        return Ok(crate::native::format::resolve(&settings, local, &[])?.0);
    }
    Ok(settings)
}
fn action_role(action: &ConfigurationAction) -> &'static str {
    if action
        .target
        .as_str()
        .is_some_and(|target| target == "local_configuration" || target.starts_with("local:model:"))
    {
        "local_settings"
    } else {
        "settings"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{adapters::Registry, native::configuration};
    fn action(operation: &str, field: Option<&str>, value: Value) -> ConfigurationAction {
        ConfigurationAction {
            version: 1,
            target: json!("configuration"),
            operation: operation.into(),
            field: field.map(str::to_owned),
            value: Some(value),
        }
    }
    fn profile() -> RegisteredProfile {
        serde_json::from_value(json!({"id":"","tool":"claude_code","name":"Native roles","version":0,"inheritCommon":false,"files":{"settings":include_str!("../../../../tests/fixtures/native/claude-model-editor.json")},"connection":null,"nativeCredentials":{}})).unwrap()
    }
    #[test]
    fn claude_roles_edit_independently_and_unify_is_explicit() {
        let registry = Registry::with_adapters(vec![&Claude]).unwrap();
        let mut draft =
            configuration::open(&registry, profile(), Scope::Global, "claude-session".into())
                .unwrap();
        assert!(draft.issues.is_empty());
        draft = configuration::edit(
            &registry,
            draft,
            action("set", Some("default.model"), json!("claude-sonnet-4-6")),
        )
        .unwrap();
        assert_eq!(draft.view["values"]["sonnet.model"], "gateway-sonnet");
        assert_eq!(draft.view["values"]["subagent.model"], "gateway-subagent");
        assert!(draft.issues.is_empty());
        assert_eq!(draft.view["values"]["effortLevel"], "xhigh");
        assert!(!draft.view["effortWarnings"].as_array().unwrap().is_empty());
        draft = configuration::edit(
            &registry,
            draft,
            action("reset", Some("effortLevel"), Value::Null),
        )
        .unwrap();
        draft = configuration::edit(
            &registry,
            draft,
            action("set", Some("sonnet.model"), json!("中文模型")),
        )
        .unwrap();
        assert_eq!(draft.view["values"]["sonnet.longContext"], true);
        assert_eq!(draft.view["values"]["sonnet.model"], "中文模型");
        draft = configuration::edit(
            &registry,
            draft,
            action("unify", None, json!("gateway-all")),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&draft.profile.files["settings"]).unwrap();
        for (_, key) in ROLES {
            assert_eq!(parsed["env"][*key], "gateway-all");
        }
        assert_eq!(parsed["model"], "gateway-all");
        assert_eq!(
            parsed["env"]["ANTHROPIC_DEFAULT_SONNET_MODEL_NAME"],
            "Sonnet gateway"
        );
        assert_eq!(parsed["env"]["USER_CUSTOM_OPTION"], "preserve");
        assert_eq!(parsed["permissions"]["allow"][0], "Read");
        assert_eq!(parsed["modelPicker"]["options"][0]["custom"], true);
    }
    #[test]
    fn claude_reset_and_raw_round_trip_keep_native_semantics() {
        let registry = Registry::with_adapters(vec![&Claude]).unwrap();
        let draft =
            configuration::open(&registry, profile(), Scope::Global, "claude-session".into())
                .unwrap();
        let reset = configuration::edit(
            &registry,
            draft,
            action("reset", Some("default.model"), Value::Null),
        )
        .unwrap();
        let own: Value = serde_json::from_str(&reset.profile.files["settings"]).unwrap();
        assert!(own.get("model").is_none());
        assert!(own["env"].get("ANTHROPIC_MODEL").is_none());
        let managed = Claude
            .managed_fields("settings", &json!({}), &own, &reset.profile)
            .unwrap();
        assert_eq!(managed.released, vec!["/env/ANTHROPIC_MODEL", "/model"]);
        let mut raw = own;
        raw["model"] = json!("opus");
        let restored = configuration::replace_text(
            &registry,
            reset,
            BTreeMap::from([("settings".into(), raw.to_string())]),
        );
        assert_eq!(restored.view["values"]["default.model"], "opus");
        assert!(restored.profile.editing.unwrap().intents.is_empty());
        let settings =
            json!({"effortLevel":"max","env":{"ANTHROPIC_DEFAULT_HAIKU_MODEL":"haiku[1m]"}});
        let issues = Claude.validate(
            &BTreeMap::from([("settings".into(), settings)]),
            &EditingState::default(),
            Scope::Global,
        );
        assert_eq!(issues.len(), 2);
        let issues = Claude.validate(
            &BTreeMap::from([("settings".into(), json!({"model":"claude-haiku-4-5[1m]"}))]),
            &EditingState::default(),
            Scope::Global,
        );
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].field.as_deref(), Some("default.longContext"));
    }
    #[test]
    fn claude_long_context_edit_uses_inherited_role_model() {
        let effective = BTreeMap::from([(
            "settings".into(),
            json!({"env":{"ANTHROPIC_DEFAULT_OPUS_MODEL":"claude-opus-4-8"}}),
        )]);
        let mut own = BTreeMap::new();
        Claude
            .edit_inherited(
                &mut own,
                &effective,
                &mut EditingState::default(),
                &action("set", Some("opus.longContext"), json!(true)),
            )
            .unwrap();
        assert_eq!(
            own["settings"]["env"]["ANTHROPIC_DEFAULT_OPUS_MODEL"],
            "claude-opus-4-8[1m]"
        );
        assert!(own["settings"].get("model").is_none());
    }
    #[test]
    fn claude_model_effort_edit_and_reset_preserve_other_model_settings() {
        let registry = Registry::with_adapters(vec![&Claude]).unwrap();
        let mut profile = profile();
        let mut settings: Value = serde_json::from_str(&profile.files["settings"]).unwrap();
        settings["modelSettings"] = json!({"claude-opus-4-8":{"effortLevel":"high","maxEffortLevel":"xhigh","autoCompactWindow":200000},"claude-sonnet-4-6":{"effortLevel":"xhigh"}});
        profile
            .files
            .insert("settings".into(), settings.to_string());
        let draft = configuration::open(&registry, profile, Scope::Global, "claude-session".into())
            .unwrap();
        assert_eq!(draft.view["currentEffortModel"], "claude-opus-4-8");
        assert!(draft.issues.is_empty());
        assert!(draft.view["effortWarnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|warning| warning.as_str().is_some_and(|warning| warning
                .contains("claude-sonnet-4-6")
                && warning.contains("high"))));
        let mut edit = action("set", Some("modelEffortLevel"), json!("low"));
        edit.target = json!("model:claude-opus-4-8");
        let changed = configuration::edit(&registry, draft, edit.clone()).unwrap();
        assert_eq!(changed.view["modelEfforts"]["claude-opus-4-8"], "low");
        assert_eq!(changed.view["values"]["effortLevel"], "xhigh");
        edit.operation = "reset".into();
        edit.value = None;
        let reset = configuration::edit(&registry, changed, edit).unwrap();
        let own: Value = serde_json::from_str(&reset.profile.files["settings"]).unwrap();
        assert!(own["modelSettings"]["claude-opus-4-8"]
            .get("effortLevel")
            .is_none());
        assert_eq!(
            own["modelSettings"]["claude-opus-4-8"]["maxEffortLevel"],
            "xhigh"
        );
        assert_eq!(
            own["modelSettings"]["claude-opus-4-8"]["autoCompactWindow"],
            200000
        );
        assert_eq!(
            own["modelSettings"]["claude-sonnet-4-6"]["effortLevel"],
            "xhigh"
        );
        let managed = Claude
            .managed_fields("settings", &json!({}), &own, &reset.profile)
            .unwrap();
        assert!(managed
            .released
            .contains(&"/modelSettings/claude-opus-4-8/effortLevel".into()));
        assert!(reset.issues.is_empty());
        let temp = tempfile::tempdir().unwrap();
        let db = crate::database::Database::open(&temp.path().join("test.db")).unwrap();
        assert!(crate::native::profile::save_registered_profile(
            &db,
            &registry,
            reset.profile,
            None
        )
        .is_ok());
    }
    #[test]
    fn claude_project_local_editor_uses_native_precedence_and_stable_target() {
        let documents = BTreeMap::from([
            (
                "settings".into(),
                json!({"model":"claude-sonnet-4-6","effortLevel":"medium"}),
            ),
            (
                "local_settings".into(),
                json!({"env":{"ANTHROPIC_MODEL":"claude-opus-4-8"},"modelSettings":{"claude-opus-4-8":{"effortLevel":"high"}}}),
            ),
        ]);
        let view = Claude.read(&documents, &EditingState::default()).unwrap();
        assert_eq!(view["values"]["default.model"], "claude-opus-4-8");
        assert_eq!(view["editTarget"], "local_configuration");
        let mut own = documents.clone();
        let mut edit = action("set", Some("modelEffortLevel"), json!("low"));
        edit.target = json!("local:model:claude-opus-4-8");
        Claude
            .edit_inherited(&mut own, &documents, &mut EditingState::default(), &edit)
            .unwrap();
        assert_eq!(
            own["local_settings"]["modelSettings"]["claude-opus-4-8"]["effortLevel"],
            "low"
        );
        assert_eq!(own["settings"], documents["settings"]);
        assert_eq!(
            Claude.suppression_changes(&edit).unwrap()[0].role,
            "local_settings"
        );
    }
    #[test]
    fn claude_scalar_reset_does_not_claim_empty_native_containers() {
        let mut own = BTreeMap::from([(
            "settings".into(),
            json!({"modelSettings":{"claude-opus-4-8":{"effortLevel":"high"}},"env":{"ANTHROPIC_MODEL":"opus"},"model":"opus"}),
        )]);
        let mut state = EditingState::default();
        let reset = action("reset", Some("default.model"), Value::Null);
        Claude.edit(&mut own, &mut state, &reset).unwrap();
        let mut model_reset = action("reset", Some("modelEffortLevel"), Value::Null);
        model_reset.target = json!("model:claude-opus-4-8");
        Claude.edit(&mut own, &mut state, &model_reset).unwrap();
        let managed = Claude
            .managed_fields(
                "settings",
                &json!({"env":{"USER_OWNED":"kept"}}),
                &own["settings"],
                &profile(),
            )
            .unwrap();
        assert!(!managed.fields.contains_key("/env"));
        assert!(!managed
            .fields
            .contains_key("/modelSettings/claude-opus-4-8"));
    }
    #[test]
    fn claude_model_effort_pointer_escapes_native_identity_and_reset_clears_only_its_suppression() {
        let registry = Registry::with_adapters(vec![&Claude]).unwrap();
        let mut profile = profile();
        let mut settings: Value = serde_json::from_str(&profile.files["settings"]).unwrap();
        settings["modelSettings"] =
            json!({"gateway/model~variant":{"effortLevel":"high","autoCompactWindow":200000}});
        profile
            .files
            .insert("settings".into(), settings.to_string());
        profile.suppressed.insert(
            "settings".into(),
            vec![
                "/modelSettings/gateway~1model~0variant/effortLevel".into(),
                "/permissions/deny".into(),
            ],
        );
        let draft = configuration::open(&registry, profile, Scope::Global, "claude-session".into())
            .unwrap();
        let mut reset = action("reset", Some("modelEffortLevel"), Value::Null);
        reset.target = json!("model:gateway/model~variant");
        let reset = configuration::edit(&registry, draft, reset).unwrap();
        assert_eq!(
            reset.profile.suppressed["settings"],
            vec!["/permissions/deny"]
        );
        let own: Value = serde_json::from_str(&reset.profile.files["settings"]).unwrap();
        assert!(own["modelSettings"]["gateway/model~variant"]
            .get("effortLevel")
            .is_none());
        assert_eq!(
            own["modelSettings"]["gateway/model~variant"]["autoCompactWindow"],
            200000
        );
        let managed = Claude
            .managed_fields("settings", &json!({}), &own, &reset.profile)
            .unwrap();
        assert!(managed
            .released
            .contains(&"/modelSettings/gateway~1model~0variant/effortLevel".into()));
    }
}
fn paths(field: &str) -> Result<Vec<Vec<String>>, String> {
    if field == "effortLevel" {
        return Ok(vec![vec![field.into()]]);
    }
    if field == "base_url" {
        return Ok(vec![vec!["env".into(), "ANTHROPIC_BASE_URL".into()]]);
    }
    let (role, kind) = field.split_once('.').ok_or("缺少 Claude 模型角色字段")?;
    let key = ROLES
        .iter()
        .find(|(id, _)| *id == role)
        .map(|(_, key)| *key)
        .ok_or("未知 Claude 模型角色")?;
    match kind {
        "model" | "longContext" => {
            let mut locations = vec![vec!["env".into(), key.into()]];
            if role == "default" {
                locations.push(vec!["model".into()]);
            }
            Ok(locations)
        }
        "name" if !["default", "subagent"].contains(&role) => {
            Ok(vec![vec!["env".into(), format!("{key}_NAME")]])
        }
        _ => Err("不支持的 Claude 角色参数".into()),
    }
}
fn action_paths(action: &ConfigurationAction) -> Result<Vec<Vec<String>>, String> {
    if action.field.as_deref() == Some("modelEffortLevel") {
        let model = action
            .target
            .as_str()
            .and_then(|target| {
                target
                    .strip_prefix("model:")
                    .or_else(|| target.strip_prefix("local:model:"))
            })
            .filter(|model| !model.trim().is_empty() && !model.chars().any(char::is_control))
            .ok_or("缺少已确认的模型 canonical ID")?;
        return Ok(vec![vec![
            "modelSettings".into(),
            model.into(),
            "effortLevel".into(),
        ]]);
    }
    if action.target != json!("configuration") && action.target != json!("local_configuration") {
        return Err("未知 Claude 配置目标".into());
    }
    paths(action.field.as_deref().ok_or("缺少 Claude 字段")?)
}
fn canonical_model(settings: &Value) -> Option<String> {
    let raw = raw_model(settings, "default", "ANTHROPIC_MODEL")?;
    let (model, _) = strip(raw);
    let pinned = ROLES
        .iter()
        .find(|(role, _)| *role == model)
        .and_then(|(_, key)| settings["env"][*key].as_str())
        .unwrap_or(model);
    let (model, _) = strip(pinned);
    // An existing native key is authoritative. Publicly documented exact IDs
    // are safe; aliases without a pin and arbitrary gateway IDs are not guessed.
    if settings["modelSettings"].get(model).is_some()
        || !effort_choices(model).is_empty()
        || model == "claude-haiku-4-5"
    {
        Some(model.into())
    } else {
        None
    }
}
fn pointer(path: &[String]) -> String {
    format!(
        "/{}",
        path.iter()
            .map(|part| crate::adapters::pointer_token(part))
            .collect::<Vec<_>>()
            .join("/")
    )
}
fn remove(root: &mut Value, path: &[String]) {
    if let Some((last, parents)) = path.split_last() {
        let mut target = root;
        for part in parents {
            let Some(next) = target.get_mut(part) else {
                return;
            };
            target = next;
        }
        if let Some(map) = target.as_object_mut() {
            map.remove(last);
        }
    }
}
fn strip(model: &str) -> (&str, bool) {
    let mut model = model.trim();
    let mut long = false;
    while model.len() >= 4
        && model
            .get(model.len() - 4..)
            .is_some_and(|suffix| suffix.eq_ignore_ascii_case("[1m]"))
    {
        model = &model[..model.len() - 4];
        long = true;
    }
    (model, long)
}
fn effort_choices(model: &str) -> Vec<&'static str> {
    // Exact native identities from https://code.claude.com/docs/en/model-config,
    // observed 2026-10-05. Custom IDs and aliases remain unverified.
    let (model, _) = strip(model);
    match model {
        "claude-fable-5" | "claude-fable-5-1" | "claude-opus-5-5" | "claude-sonnet-5-5"
        | "claude-opus-5" | "claude-sonnet-5" | "claude-opus-4-8" | "claude-opus-4-7" => {
            vec!["low", "medium", "high", "xhigh"]
        }
        "claude-opus-4-6" | "claude-sonnet-4-6" => vec!["low", "medium", "high"],
        _ => vec![],
    }
}
fn effort_fallback_warning(model: &str, effort: &str) -> Option<String> {
    let choices = effort_choices(model);
    let levels = ["low", "medium", "high", "xhigh"];
    let rank = levels.iter().position(|level| *level == effort)?;
    if choices.is_empty() || choices.contains(&effort) {
        return None;
    }
    let fallback = choices.iter().rev().find(|choice| {
        levels
            .iter()
            .position(|level| level == *choice)
            .is_some_and(|level| level <= rank)
    })?;
    Some(format!(
        "{model} 使用 {effort} 时，Claude 会按原生规则回退至 {fallback}；配置原值保留。"
    ))
}
fn raw_model<'a>(settings: &'a Value, role: &str, key: &str) -> Option<&'a str> {
    settings["env"][key].as_str().or_else(|| {
        (role == "default")
            .then(|| settings["model"].as_str())
            .flatten()
    })
}
fn field(
    id: &str,
    label: &str,
    kind: &str,
    choices: &[&str],
    advanced: bool,
) -> ConfigurationField {
    ConfigurationField {
        id: id.into(),
        label: label.into(),
        kind: kind.into(),
        required: false,
        advanced,
        choices: choices.iter().map(|value| (*value).into()).collect(),
        minimum: None,
        default_source: Some("跟随 Claude 原生默认或继承值".into()),
        unavailable_reason: None,
    }
}
impl ConfigurationAdapter for Claude {
    fn portable_field_kind(&self, path: &[String]) -> PortableFieldKind {
        match path.last().map(String::as_str) {
            Some("ANTHROPIC_API_KEY" | "ANTHROPIC_AUTH_TOKEN" | "CLAUDE_CODE_OAUTH_TOKEN") => {
                PortableFieldKind::Credential
            }
            Some(
                "model"
                | "effortLevel"
                | "modelEffortLevel"
                | "ANTHROPIC_BASE_URL"
                | "CLAUDE_CODE_EFFORT_LEVEL",
            ) => PortableFieldKind::Parameter,
            Some(key)
                if ROLES
                    .iter()
                    .any(|(_, model)| key == *model || key == format!("{model}_NAME")) =>
            {
                PortableFieldKind::Parameter
            }
            _ => PortableFieldKind::Unknown,
        }
    }
    fn suppression_changes(
        &self,
        action: &ConfigurationAction,
    ) -> Result<Vec<SuppressionChange>, String> {
        if action.operation == "unify" {
            return Ok(ROLES
                .iter()
                .flat_map(|(role, _)| paths(&format!("{role}.model")).unwrap())
                .map(|path| SuppressionChange {
                    role: action_role(action).into(),
                    path: pointer(&path),
                    suppressed: false,
                })
                .collect());
        }
        Ok(action_paths(action)?
            .into_iter()
            .map(|path| SuppressionChange {
                role: action_role(action).into(),
                path: pointer(&path),
                suppressed: false,
            })
            .collect())
    }
    fn reconcile_text(
        &self,
        _: Option<&Documents>,
        next: &Documents,
        _: &Documents,
        state: &mut EditingState,
    ) -> Result<(), String> {
        root(next)?;
        state.intents.retain(|action| {
            action.operation == "reset"
                && action_paths(action).ok().is_some_and(|paths| {
                    paths.iter().all(|path| {
                        next.get(action_role(action))
                            .and_then(|settings| settings.pointer(&pointer(path)))
                            .is_none()
                    })
                })
        });
        Ok(())
    }
    fn describe(&self, _: Scope) -> ConfigurationDescriptor {
        let mut fields = vec![
            field("default.model", "默认模型", "string", &[], false),
            field("base_url", "Anthropic 地址", "string", &[], false),
            field(
                "effortLevel",
                "默认推理 effort",
                "string",
                &["low", "medium", "high", "xhigh"],
                true,
            ),
            field(
                "modelEffortLevel",
                "此模型推理 effort",
                "string",
                &["low", "medium", "high", "xhigh"],
                true,
            ),
        ];
        for (role, _) in ROLES {
            if *role != "default" {
                fields.push(field(
                    &format!("{role}.model"),
                    &format!("{role} 模型"),
                    "string",
                    &[],
                    true,
                ));
            }
            if !["default", "subagent"].contains(role) {
                fields.push(field(
                    &format!("{role}.name"),
                    &format!("{role} 显示名称"),
                    "string",
                    &[],
                    true,
                ));
            }
            fields.push(field(
                &format!("{role}.longContext"),
                &format!("{role} 长上下文 [1m]"),
                "boolean",
                &[],
                true,
            ));
        }
        ConfigurationDescriptor {
            version: EDITING_VERSION,
            fields,
            operations: vec!["set".into(), "reset".into(), "unify".into()],
        }
    }
    fn read(&self, documents: &Documents, _: &EditingState) -> Result<Value, String> {
        let settings = root(documents)?;
        let mut values = BTreeMap::new();
        for (role, key) in ROLES {
            if let Some(raw) = raw_model(&settings, role, key) {
                let (model, long) = strip(raw);
                values.insert(format!("{role}.model"), json!(model));
                values.insert(format!("{role}.longContext"), json!(long));
            }
            if let Some(name) = settings["env"].get(format!("{key}_NAME")) {
                values.insert(format!("{role}.name"), name.clone());
            }
        }
        if let Some(base) = settings["env"].get("ANTHROPIC_BASE_URL") {
            values.insert("base_url".into(), base.clone());
        }
        if let Some(effort) = settings.get("effortLevel") {
            values.insert("effortLevel".into(), effort.clone());
        }
        let model = raw_model(&settings, "default", "ANTHROPIC_MODEL").unwrap_or("");
        let choices = effort_choices(model);
        let (canonical, _) = strip(model);
        let model_efforts: BTreeMap<_, _> = settings["modelSettings"]
            .as_object()
            .into_iter()
            .flat_map(|map| map.iter())
            .filter_map(|(id, settings)| {
                settings
                    .get("effortLevel")
                    .map(|value| (id.clone(), value.clone()))
            })
            .collect();
        let current_model = canonical_model(&settings);
        let mut effort_warnings: Vec<String> = settings["effortLevel"]
            .as_str()
            .and_then(|effort| {
                effort_fallback_warning(current_model.as_deref().unwrap_or(model), effort)
            })
            .into_iter()
            .collect();
        effort_warnings.extend(model_efforts.iter().filter_map(|(model, effort)| {
            effort
                .as_str()
                .and_then(|effort| effort_fallback_warning(model, effort))
        }));
        let model_effort_choices: BTreeMap<_, _> = model_efforts
            .keys()
            .cloned()
            .chain(current_model.clone())
            .map(|model| {
                let choices = effort_choices(&model);
                (model, choices)
            })
            .collect();
        Ok(
            json!({"values":values,"editTarget":if documents.contains_key("local_settings"){"local_configuration"}else{"configuration"},"effortChoices":choices,"effortWarnings":effort_warnings,"effortOverride":settings["env"].get("CLAUDE_CODE_EFFORT_LEVEL"),"modelEffortOverride":settings["modelSettings"][canonical].get("effortLevel"),"modelEfforts":model_efforts,"modelEffortChoices":model_effort_choices,"currentEffortModel":current_model,"capabilitySource":if choices.is_empty(){"未核验模型能力；展示 CLI 可持久化的原生档位"}else{"Claude 原生模型文档（2026-10-05）"}}),
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
        _: &mut EditingState,
        action: &ConfigurationAction,
    ) -> Result<(), String> {
        if action.operation == "unify"
            && action.target != json!("configuration")
            && action.target != json!("local_configuration")
        {
            return Err("未知 Claude 配置目标".into());
        }
        let baseline = root(effective)?;
        let settings = documents
            .entry(action_role(action).into())
            .or_insert_with(|| json!({}));
        if !settings.is_object() || settings.get("env").is_some_and(|env| !env.is_object()) {
            return Err("Claude settings 和 env 须为 JSON 对象".into());
        }
        if action.operation == "unify" {
            let model = action
                .value
                .as_ref()
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or("请选择要统一的模型")?;
            for (role, _) in ROLES {
                // Unification changes only these six explicit mappings, never display names,
                // credentials, effort, modelPicker, permissions, or arbitrary env values.
                for path in paths(&format!("{role}.model"))? {
                    crate::native::apply::set_json(
                        settings,
                        &path.iter().map(String::as_str).collect::<Vec<_>>(),
                        json!(model),
                    );
                }
            }
            return Ok(());
        }
        let field = action.field.as_deref().ok_or("缺少 Claude 字段")?;
        let locations = action_paths(action)?;
        if field == "modelEffortLevel"
            && (settings
                .get("modelSettings")
                .is_some_and(|models| !models.is_object())
                || settings["modelSettings"]
                    .get(&locations[0][1])
                    .is_some_and(|model| !model.is_object()))
        {
            return Err("模型设置须为对象；请先修正原文".into());
        }
        match action.operation.as_str() {
            "reset" if !field.ends_with(".longContext") => {
                for path in locations {
                    remove(settings, &path);
                }
            }
            "set" => {
                let mut value = action.value.clone().ok_or("缺少 Claude 字段值")?;
                if field.ends_with(".model") {
                    let model = value.as_str().ok_or("模型须为字符串")?;
                    if model.trim().is_empty() {
                        return Err("恢复默认请使用 reset".into());
                    }
                    let (_, was_long) = strip(
                        baseline
                            .pointer(&pointer(&locations[0]))
                            .and_then(Value::as_str)
                            .or_else(|| {
                                (field == "default.model")
                                    .then(|| baseline["model"].as_str())
                                    .flatten()
                            })
                            .unwrap_or(""),
                    );
                    let (model, explicit_long) = strip(model);
                    value = json!(format!(
                        "{model}{}",
                        if was_long || explicit_long {
                            "[1m]"
                        } else {
                            ""
                        }
                    ));
                } else if field.ends_with(".longContext") {
                    let long = value.as_bool().ok_or("长上下文须为布尔值")?;
                    let raw = baseline
                        .pointer(&pointer(&locations[0]))
                        .and_then(Value::as_str)
                        .or_else(|| {
                            (field == "default.longContext")
                                .then(|| baseline["model"].as_str())
                                .flatten()
                        })
                        .ok_or("请先为此角色选择模型")?;
                    let (model, _) = strip(raw);
                    value = json!(format!("{model}{}", if long { "[1m]" } else { "" }));
                } else if value.is_null() {
                    return Err("恢复默认请使用 reset".into());
                }
                for path in locations {
                    crate::native::apply::set_json(
                        settings,
                        &path.iter().map(String::as_str).collect::<Vec<_>>(),
                        value.clone(),
                    );
                }
            }
            _ => return Err("不支持的 Claude 编辑操作；长上下文随角色模型恢复默认".into()),
        }
        Ok(())
    }
    fn validate(
        &self,
        documents: &Documents,
        _: &EditingState,
        _: Scope,
    ) -> Vec<ConfigurationIssue> {
        let settings = match root(documents) {
            Ok(value) => value,
            Err(message) => {
                return vec![ConfigurationIssue {
                    target: json!("configuration"),
                    field: None,
                    code: "invalid_document".into(),
                    message,
                }]
            }
        };
        let mut issues = vec![];
        let mut issue = |field: &str, message: &str| {
            issues.push(ConfigurationIssue {
                target: json!("configuration"),
                field: Some(field.into()),
                code: "invalid_value".into(),
                message: message.into(),
            })
        };
        for (role, key) in ROLES {
            for value in settings["env"].get(*key).into_iter().chain(
                ((*role == "default")
                    .then(|| settings.get("model"))
                    .flatten())
                .into_iter(),
            ) {
                if !value.as_str().is_some_and(|model| {
                    !strip(model).0.is_empty() && !model.chars().any(char::is_control)
                }) {
                    issue(&format!("{role}.model"), "模型须为非空原生 ID 或别名");
                }
                if value.as_str().is_some_and(|model| {
                    strip(model).1 && matches!(strip(model).0, "haiku" | "claude-haiku-4-5")
                }) {
                    issue(
                        &format!("{role}.longContext"),
                        "已知 Haiku 模型不支持 [1m] 长上下文",
                    );
                }
            }
            if settings["env"]
                .get(format!("{key}_NAME"))
                .is_some_and(|value| !value.is_string())
            {
                issue(&format!("{role}.name"), "显示名称须为字符串");
            }
        }
        if let Some(base) = settings["env"].get("ANTHROPIC_BASE_URL") {
            if !base.as_str().is_some_and(|base| {
                url::Url::parse(base).is_ok_and(|url| {
                    matches!(url.scheme(), "http" | "https") && url.host_str().is_some()
                })
            }) {
                issue("base_url", "请输入有效 HTTP 或 HTTPS Anthropic 地址");
            }
        }
        if let Some(effort) = settings.get("effortLevel") {
            if !effort
                .as_str()
                .is_some_and(|value| ["low", "medium", "high", "xhigh"].contains(&value))
            {
                issue("effortLevel","Claude 可保存的 effort 档位为 low、medium、high、xhigh；max 仅用于原生会话选择");
            }
        }
        if let Some(models) = settings.get("modelSettings") {
            if let Some(models) = models.as_object() {
                for (id, model) in models {
                    if !model.is_object() {
                        issue("modelEffortLevel", "modelSettings 模型设置须为对象");
                        continue;
                    }
                    if let Some(effort) = model.get("effortLevel") {
                        if !effort.as_str().is_some_and(|effort| {
                            ["low", "medium", "high", "xhigh"].contains(&effort)
                        }) {
                            issue(
                                "modelEffortLevel",
                                &format!("{id} 的模型 effort 不符合原生可持久化档位"),
                            );
                        }
                    }
                }
            } else {
                issue("modelEffortLevel", "modelSettings 须为对象");
            }
        }
        issues
    }
    fn connection(
        &self,
        documents: &Documents,
        state: &EditingState,
    ) -> Result<Option<Connection>, String> {
        let settings = root(documents)?;
        Ok(
            match (
                settings["env"]["ANTHROPIC_BASE_URL"].as_str(),
                raw_model(&settings, "default", "ANTHROPIC_MODEL"),
            ) {
                (Some(base), Some(model)) => Some(Connection {
                    provider_id: state
                        .selected_provider
                        .clone()
                        .unwrap_or_else(|| "anthropic".into()),
                    interface_format: "anthropic_messages".into(),
                    base_url: base.into(),
                    model: model.into(),
                    secret_ref: None,
                    auth_env_var: None,
                    model_records: vec![],
                }),
                _ => None,
            },
        )
    }
    fn managed_fields(
        &self,
        role: &str,
        _: &Value,
        desired: &Value,
        profile: &RegisteredProfile,
    ) -> Result<ManagedConfiguration, String> {
        let mut fields = BTreeMap::new();
        crate::native::apply::flatten(desired, &mut vec![], &mut fields);
        // Empty containers left by a scalar reset do not own or replace native
        // environment variables, credentials, or unrelated model settings.
        fields.retain(|path, value| {
            !(value.as_object().is_some_and(|map| map.is_empty())
                && (path == "/env"
                    || path == "/modelSettings"
                    || path.starts_with("/modelSettings/")))
        });
        let mut managed = ManagedConfiguration {
            fields: fields
                .into_iter()
                .map(|(path, value)| (path, Some(value)))
                .collect(),
            released: vec![],
        };
        if matches!(role, "settings" | "local_settings") {
            if let Some(state) = &profile.editing {
                for action in &state.intents {
                    if action.operation == "reset" && action_role(action) == role {
                        for path in action_paths(action)? {
                            managed.released.push(pointer(&path));
                        }
                    }
                }
            }
        }
        Ok(managed)
    }
}
