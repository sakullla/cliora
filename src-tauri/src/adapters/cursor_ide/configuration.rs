use super::CursorIde;
use crate::adapters::configuration::*;
use crate::native::{adapter::Scope, profile::Connection};
use serde_json::{json, Value};
pub(super) const FIELDS: &[&str] = &[
    "editor.fontSize",
    "editor.tabSize",
    "editor.wordWrap",
    "files.autoSave",
    "workbench.colorTheme",
];
pub(super) fn reject_secrets(root: &Value) -> Result<(), String> {
    crate::native::profile::reject_plaintext_secrets(root)?;
    match root {
        Value::Object(values) => for (key, value) in values {
            // IDE extension settings use dotted keys rather than nested maps.
            if let Some((_, leaf)) = key.rsplit_once('.') {
                crate::native::profile::reject_plaintext_secrets(&json!({leaf: value}))?;
            }
            reject_secrets(value)?;
        },
        Value::Array(values) => for value in values { reject_secrets(value)?; },
        _ => (),
    }
    Ok(())
}
pub(super) fn validate_settings(root: &Value) -> Result<(), String> {
    if !root.is_object() {
        return Err("IDE 设置必须是对象".into());
    }
    for (key, value) in root.as_object().unwrap() {
        let valid =
            match key.as_str() {
                "editor.fontSize" => value.as_f64().is_some_and(|v| (6.0..=100.0).contains(&v)),
                "editor.tabSize" => value.as_u64().is_some_and(|v| (1..=32).contains(&v)),
                "editor.wordWrap" => value
                    .as_str()
                    .is_some_and(|v| ["off", "on", "wordWrapColumn", "bounded"].contains(&v)),
                "files.autoSave" => value.as_str().is_some_and(|v| {
                    ["off", "afterDelay", "onFocusChange", "onWindowChange"].contains(&v)
                }),
                "workbench.colorTheme" => value.is_string(),
                "mcpServers" | "permissions" | "model" => return Err(
                    "此内容不是 IDE settings.json；MCP 请使用资源页，Agent CLI 配置不属于此工具"
                        .into(),
                ),
                _ => true,
            };
        if !valid {
            return Err(format!("Cursor IDE 设置 {key} 类型或值无效"));
        }
    }
    Ok(())
}
impl ConfigurationAdapter for CursorIde {
    fn describe(&self, _: Scope) -> ConfigurationDescriptor {
        ConfigurationDescriptor {
            version: 1,
            operations: vec!["set".into(), "reset".into()],
            fields: FIELDS
                .iter()
                .map(|key| ConfigurationField {
                    id: (*key).into(),
                    label: (*key).into(),
                    kind: if *key == "editor.fontSize" {
                        "number"
                    } else if *key == "editor.tabSize" {
                        "integer"
                    } else {
                        "string"
                    }
                    .into(),
                    required: false,
                    advanced: false,
                    choices: match *key {
                        "editor.wordWrap" => vec!["off", "on", "wordWrapColumn", "bounded"],
                        "files.autoSave" => {
                            vec!["off", "afterDelay", "onFocusChange", "onWindowChange"]
                        }
                        _ => vec![],
                    }
                    .into_iter()
                    .map(str::to_owned)
                    .collect(),
                    minimum: match *key {
                        "editor.fontSize" => Some(6.0),
                        "editor.tabSize" => Some(1.0),
                        _ => None,
                    },
                    default_source: Some("Cursor IDE".into()),
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
            .map(|field| CommonParameter {
                path: vec![field.id.clone()],
                field,
                role: "settings",
                target: json!({"kind":"settings"}),
            })
            .collect()
    }
    fn managed_fields(
        &self,
        _: &str,
        _: &Value,
        desired: &Value,
        profile: &crate::native::profile::RegisteredProfile,
    ) -> Result<ManagedConfiguration, String> {
        let mut fields = std::collections::BTreeMap::new();
        crate::native::apply::flatten(desired, &mut Vec::new(), &mut fields);
        let released = profile
            .editing
            .as_ref()
            .map(|state| {
                state
                    .intents
                    .iter()
                    .filter(|action| action.operation == "reset")
                    .filter_map(|action| action.field.as_ref())
                    .filter(|field| FIELDS.contains(&field.as_str()))
                    .map(|field| location_pointer(&[field.clone()]))
                    .collect()
            })
            .unwrap_or_default();
        Ok(ManagedConfiguration {
            fields: fields
                .into_iter()
                .map(|(path, value)| (path, Some(value)))
                .collect(),
            released,
        })
    }
    fn field_locations(&self, field: &str, _: &Documents) -> Vec<(String, Vec<String>)> {
        FIELDS
            .contains(&field)
            .then(|| vec![("settings".into(), vec![field.into()])])
            .unwrap_or_default()
    }
    fn read(&self, documents: &Documents, _: &EditingState) -> Result<Value, String> {
        Ok(documents
            .get("settings")
            .cloned()
            .unwrap_or_else(|| json!({})))
    }
    fn edit(
        &self,
        documents: &mut Documents,
        state: &mut EditingState,
        action: &ConfigurationAction,
    ) -> Result<(), String> {
        if action.version != 1 || action.target != json!({"kind":"settings"}) {
            return Err("Cursor IDE 设置操作无效".into());
        }
        let field = action
            .field
            .as_deref()
            .filter(|field| FIELDS.contains(field))
            .ok_or("未声明的 Cursor IDE 设置字段")?;
        let mut next = documents
            .get("settings")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let map = next.as_object_mut().ok_or("IDE 设置必须是对象")?;
        match action.operation.as_str() {
            "set" => {
                map.insert(field.into(), action.value.clone().ok_or("设置值缺失")?);
            }
            "reset" => {
                map.remove(field);
            }
            _ => return Err("未支持的 IDE 设置操作".into()),
        }
        validate_settings(&next)?;
        documents.insert("settings".into(), next);
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
    fn validate(
        &self,
        documents: &Documents,
        _: &EditingState,
        _: Scope,
    ) -> Vec<ConfigurationIssue> {
        documents
            .get("settings")
            .and_then(|value| validate_settings(value).err())
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
    fn connection(&self, _: &Documents, _: &EditingState) -> Result<Option<Connection>, String> {
        Ok(None)
    }
    fn portable_field_kind(&self, path: &[String]) -> PortableFieldKind {
        if path.len() == 2 && path[0] == "settings" && FIELDS.contains(&path[1].as_str()) {
            PortableFieldKind::Parameter
        } else {
            PortableFieldKind::Unknown
        }
    }
}
