//! Qoder CN 1.1.74 settings schema. This port only plans document edits;
//! persistence, credentials and compare-and-swap stay in shared services.
use super::QoderAdapter;
use crate::adapters::configuration::{
    location_pointer, CommonParameter, ConfigurationAction, ConfigurationAdapter,
    ConfigurationDescriptor, ConfigurationField, ConfigurationIssue, Documents, EditingState,
    ManagedConfiguration, PortableFieldKind, SuppressionChange, EDITING_VERSION,
};
use crate::native::{
    adapter::Scope,
    format::{self, FileKind},
    profile::{Connection, RegisteredProfile},
};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const FIELDS: &[(&str, &str, &[&str])] = &[
    ("model.name", "模型", &[]),
    (
        "model.reasoningEffort",
        "推理强度",
        &[
            "disabled", "off", "none", "low", "medium", "high", "xhigh", "max",
        ],
    ),
    (
        "general.defaultPermissionMode",
        "默认权限模式",
        &[
            "default",
            "accept_edits",
            "auto",
            "bypass_permissions",
            "dont_ask",
        ],
    ),
    ("ui.language", "界面语言", &["auto", "zh-CN", "en"]),
    ("autoMemoryEnabled", "项目自动记忆", &[]),
    ("autoMemoryUserScopeEnabled", "用户自动记忆", &[]),
];

fn path(id: &str) -> Result<Vec<String>, String> {
    FIELDS
        .iter()
        .any(|(field, _, _)| *field == id)
        .then(|| id.split('.').map(str::to_owned).collect())
        .ok_or_else(|| "Qoder CN 未声明此配置字段".into())
}

fn native_path(path: &[String]) -> &[String] {
    if path
        .first()
        .is_some_and(|part| matches!(part.as_str(), "settings" | "local_settings"))
    {
        &path[1..]
    } else {
        path
    }
}

fn sensitive_path(path: &[String]) -> bool {
    let path = native_path(path);
    // MCP accepts arbitrary environment/header names: the whole container is
    // private, including values whose names do not resemble a conventional key.
    if path.len() >= 3 && path[0] == "mcpServers" && matches!(path[2].as_str(), "env" | "headers") {
        return true;
    }
    // providers.<id>.apiKey is native in 1.1.74. Keep credential-shaped native
    // extensions private too; ordinary configuration never owns login material.
    path.last().is_some_and(|key| {
        matches!(
            key.to_ascii_lowercase().as_str(),
            "apikey"
                | "api_key"
                | "authorization"
                | "password"
                | "secret"
                | "token"
                | "auth"
                | "oauth"
                | "credentials"
                | "access_token"
                | "refresh_token"
                | "anthropic_api_key"
                | "anthropic_auth_token"
                | "experimental_bearer_token"
        )
    })
}

/// Input is the public document after shared current-file redaction, or a new
/// untrusted draft. Native private nodes are restored only by the shared session
/// patcher; accepting them here would let raw edits bypass credential ownership.
pub(super) fn validate_public_settings(root: &Value) -> Result<(), String> {
    fn visit(value: &Value, path: &mut Vec<String>) -> Result<(), String> {
        if sensitive_path(path) {
            return Err("Qoder CN 凭据及 MCP 环境变量、请求头由原生配置保留，不能通过普通配置草稿新增或修改".into());
        }
        match value {
            Value::Object(map) => {
                for (key, value) in map {
                    path.push(key.clone());
                    visit(value, path)?;
                    path.pop();
                }
            }
            Value::Array(items) => {
                for item in items {
                    visit(item, path)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    // Shared redaction walks objects, not arrays. Refuse malformed native maps
    // rather than returning an unexamined secret-bearing array in a draft.
    for container in ["mcpServers", "providers"] {
        if let Some(value) = root.get(container) {
            let entries = value
                .as_object()
                .ok_or("Qoder CN MCP 与供应商配置必须是原生对象映射")?;
            if entries.values().any(|entry| !entry.is_object()) {
                return Err("Qoder CN MCP 与供应商条目必须是原生对象".into());
            }
        }
    }
    visit(root, &mut Vec::new())
}
fn role(action: &ConfigurationAction) -> Result<&str, String> {
    match action.target.as_str() {
        Some("settings") => Ok("settings"),
        Some("local_settings") => Ok("local_settings"),
        _ => Err("Qoder CN 配置目标无效".into()),
    }
}
fn fields() -> Vec<ConfigurationField> {
    FIELDS
        .iter()
        .map(|(id, label, choices)| ConfigurationField {
            id: (*id).into(),
            label: (*label).into(),
            kind: if id.starts_with("autoMemory") {
                "boolean"
            } else {
                "string"
            }
            .into(),
            required: false,
            advanced: false,
            choices: choices.iter().map(|s| (*s).into()).collect(),
            minimum: None,
            default_source: Some(
                if id.starts_with("autoMemory") {
                    "原生默认（当前生效状态未知）"
                } else {
                    "原生默认"
                }
                .into(),
            ),
            unavailable_reason: None,
            origin: None,
        })
        .collect()
}
fn valid_value(id: &str, value: &Value) -> bool {
    if id.starts_with("autoMemory") {
        value.is_boolean()
    } else {
        value.as_str().is_some_and(|s| !s.trim().is_empty())
    }
}

impl ConfigurationAdapter for QoderAdapter {
    fn describe(&self, _scope: Scope) -> ConfigurationDescriptor {
        ConfigurationDescriptor {
            version: EDITING_VERSION,
            fields: fields(),
            operations: vec!["set".into(), "reset".into()],
        }
    }
    fn common_parameters(&self, _scope: Scope) -> Vec<CommonParameter> {
        fields()
            .into_iter()
            .map(|field| CommonParameter {
                path: path(&field.id).unwrap(),
                field,
                role: "settings",
                target: json!("settings"),
            })
            .collect()
    }
    fn field_locations(&self, field: &str, documents: &Documents) -> Vec<(String, Vec<String>)> {
        let Ok(path) = path(field) else {
            return vec![];
        };
        let role = if documents
            .get("local_settings")
            .and_then(|root| root.pointer(&location_pointer(&path)))
            .is_some()
        {
            "local_settings"
        } else {
            "settings"
        };
        vec![(role.into(), path)]
    }
    fn read(&self, documents: &Documents, _state: &EditingState) -> Result<Value, String> {
        let mut values = serde_json::Map::new();
        let mut targets = serde_json::Map::new();
        for (id, _, _) in FIELDS {
            let pointer = location_pointer(&path(id)?);
            let local = documents
                .get("local_settings")
                .and_then(|root| root.pointer(&pointer));
            let value = local.or_else(|| {
                documents
                    .get("settings")
                    .and_then(|root| root.pointer(&pointer))
            });
            values.insert((*id).into(), value.cloned().unwrap_or(Value::Null));
            targets.insert(
                (*id).into(),
                json!(if local.is_some() {
                    "local_settings"
                } else {
                    "settings"
                }),
            );
        }
        Ok(json!({"values":values,"targets":targets}))
    }
    fn edit(
        &self,
        documents: &mut Documents,
        _state: &mut EditingState,
        action: &ConfigurationAction,
    ) -> Result<(), String> {
        if action.version != EDITING_VERSION
            || !matches!(action.operation.as_str(), "set" | "reset")
        {
            return Err("Qoder CN 只支持设置或恢复默认".into());
        }
        let role = role(action)?;
        let id = action.field.as_deref().ok_or("缺少配置字段")?;
        let path = path(id)?;
        let value = if action.operation == "reset" {
            None
        } else {
            let value = action.value.as_ref().ok_or("缺少配置值")?;
            if !valid_value(id, value) {
                return Err("配置值类型无效；清除设置请恢复默认".into());
            }
            let choices = FIELDS.iter().find(|(field, _, _)| *field == id).unwrap().2;
            if !choices.is_empty() && !choices.contains(&value.as_str().unwrap_or_default()) {
                return Err("请选择已核验的原生取值；已有未知值可保留".into());
            }
            Some(value)
        };
        let root = documents.entry(role.into()).or_insert_with(|| json!({}));
        let text = format::render(FileKind::Json, root)?;
        *root = format::parse(
            FileKind::Json,
            &format::set_path(FileKind::Json, &text, &path, value)?,
        )?;
        Ok(())
    }
    fn suppression_changes(
        &self,
        action: &ConfigurationAction,
        _state: &EditingState,
    ) -> Result<Vec<SuppressionChange>, String> {
        Ok(vec![SuppressionChange {
            role: role(action)?.into(),
            path: location_pointer(&path(action.field.as_deref().ok_or("缺少配置字段")?)?),
            suppressed: false,
        }])
    }
    fn reconcile_text(
        &self,
        _previous: Option<&Documents>,
        next: &Documents,
        _effective: &Documents,
        state: &mut EditingState,
    ) -> Result<(), String> {
        state.intents.retain(|action| {
            action.operation == "reset"
                && role(action)
                    .ok()
                    .zip(action.field.as_deref().and_then(|id| path(id).ok()))
                    .is_some_and(|(role, path)| {
                        next.get(role)
                            .and_then(|root| root.pointer(&location_pointer(&path)))
                            .is_none()
                    })
        });
        Ok(())
    }
    fn validate(
        &self,
        documents: &Documents,
        _state: &EditingState,
        _scope: Scope,
    ) -> Vec<ConfigurationIssue> {
        let mut issues = vec![];
        if let Err(message) = super::config_directory_name(
            std::env::var("QODERCN_CONFIG_DIR_NAME").ok().as_deref(),
            self.directory,
        ) {
            issues.push(ConfigurationIssue {
                target: Value::Null,
                field: None,
                code: "invalid_configuration_directory".into(),
                message,
            });
        }
        for (role, root) in documents {
            if !root.is_object() {
                issues.push(ConfigurationIssue {
                    target: json!(role),
                    field: None,
                    code: "invalid_document".into(),
                    message: "Qoder CN settings 顶层必须是对象".into(),
                });
                continue;
            }
            for parent in ["model", "general", "ui"] {
                if root.get(parent).is_some_and(|value| !value.is_object()) {
                    issues.push(ConfigurationIssue {
                        target: json!(role),
                        field: Some(parent.into()),
                        code: "invalid_native_value".into(),
                        message: format!("{parent} 必须是原生配置对象"),
                    });
                }
            }
            for (id, _, _) in FIELDS {
                if root
                    .pointer(&location_pointer(&path(id).unwrap()))
                    .is_some_and(|value| !valid_value(id, value))
                {
                    issues.push(ConfigurationIssue {
                        target: json!(role),
                        field: Some((*id).into()),
                        code: "invalid_native_value".into(),
                        message: format!("{id} 原生类型无效"),
                    });
                }
            }
        }
        issues
    }
    // Raw native enums remain forward-compatible. The form limits new choices
    // in edit(); validating every persisted enum against today's catalog would
    // reject an imported native extension when a new profile inherits common.
    fn connection(
        &self,
        _documents: &Documents,
        _state: &EditingState,
    ) -> Result<Option<Connection>, String> {
        Ok(None)
    }
    fn portable_field_kind(&self, path: &[String]) -> PortableFieldKind {
        if sensitive_path(path) {
            PortableFieldKind::Credential
        } else if self::path(&native_path(path).join(".")).is_ok() {
            PortableFieldKind::Parameter
        } else {
            PortableFieldKind::Unknown
        }
    }
    fn managed_fields(
        &self,
        role: &str,
        _current: &Value,
        desired: &Value,
        profile: &RegisteredProfile,
    ) -> Result<ManagedConfiguration, String> {
        let mut flat = BTreeMap::new();
        crate::native::apply::flatten(desired, &mut vec![], &mut flat);
        flat.retain(|path, value| {
            // A redacted credential-only provider/MCP entry is an empty object.
            // It must not claim the whole native container during named apply.
            !((matches!(
                path.as_str(),
                "/model" | "/general" | "/ui" | "/providers" | "/mcpServers"
            ) || path.starts_with("/providers/")
                || path.starts_with("/mcpServers/"))
                && value.as_object().is_some_and(|v| v.is_empty()))
        });
        let mut managed = ManagedConfiguration {
            fields: flat
                .into_iter()
                .map(|(key, value)| (key, Some(value)))
                .collect(),
            released: vec![],
        };
        if let Some(state) = &profile.editing {
            for action in &state.intents {
                if action.operation == "reset" && self::role(action)? == role {
                    managed.released.push(location_pointer(&path(
                        action.field.as_deref().ok_or("缺少配置字段")?,
                    )?));
                }
            }
        }
        Ok(managed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::qoder_cn::QODER_CN;
    use crate::{adapters::Registry, native::configuration};

    #[derive(Default)]
    struct CurrentStore(std::sync::Mutex<BTreeMap<String, String>>);
    impl crate::credentials::CredentialStore for CurrentStore {
        fn put(&self, id: &str, secret: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert(id.into(), secret.into());
            Ok(())
        }
        fn get(&self, id: &str) -> Result<String, String> {
            self.0
                .lock()
                .unwrap()
                .get(id)
                .cloned()
                .ok_or("missing".into())
        }
        fn delete(&self, id: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(id);
            Ok(())
        }
    }
    // Synthetic native text deliberately retains escaped bytes and spacing.
    const PRIVATE_SETTINGS: &str = r#"{
  "model": { "name": "old-model" },
  "providers": { "fixture": { "apiKey" : "\u0073ynthetic-provider-key", "baseUrl": "https://example.test/v1" }, "private-only": { "apiKey": "synthetic-private-only" } },
  "mcpServers": { "fixture": { "command": "fixture-mcp", "env" : { "GITHUB_TOKEN" : "synthetic-mcp-env", "PUBLIC_LABEL": "private-container-value" }, "headers" : { "Authorization" : "Bearer synthetic-header", "X-Custom-Credential": "synthetic-custom-header" } }, "private-only": { "env": { "OPAQUE": "synthetic-private-only-env" } } },
  "customNative": { "keep": true }
}"#;
    fn current_request(
        id: &str,
        scope: Scope,
        project: Option<&std::path::Path>,
    ) -> crate::native::workspace::ConfigurationBeginRequest {
        crate::native::workspace::ConfigurationBeginRequest {
            tool_id: "qoder_cn".into(),
            scope,
            project_path: project.map(|path| path.to_string_lossy().into_owned()),
            session_id: id.into(),
            subject: crate::adapters::configuration::ConfigurationSubject::Current,
            profile: None,
        }
    }
    fn assert_public(value: &impl serde::Serialize) {
        let text = serde_json::to_string(value).unwrap();
        for private in [
            "synthetic-provider-key",
            "synthetic-mcp-env",
            "private-container-value",
            "synthetic-header",
            "synthetic-custom-header",
            "synthetic-private-only",
            "GITHUB_TOKEN",
            "X-Custom-Credential",
        ] {
            assert!(
                !text.contains(private),
                "private native node crossed the public boundary"
            );
        }
    }

    #[test]
    fn qoder_current_sessions_redact_and_preserve_secret_nodes_through_preview_save_and_reopen() {
        use crate::{
            adapters::CliAdapter,
            native::{apply, workspace::DraftSessions},
        };
        for (scope, role) in [
            (Scope::Global, "settings"),
            (Scope::Project, "local_settings"),
        ] {
            let temp = tempfile::tempdir().unwrap();
            let project = (scope == Scope::Project).then_some(temp.path());
            let registry = Registry::with_adapters(vec![&QODER_CN]).unwrap();
            let db = crate::database::Database::open(&temp.path().join("current.db")).unwrap();
            let sessions = DraftSessions::default();
            let store = CurrentStore::default();
            let files = QODER_CN.native_files(scope, temp.path(), project, true);
            let file = files.iter().find(|file| file.role == role).unwrap();
            std::fs::create_dir_all(std::path::Path::new(&file.path).parent().unwrap()).unwrap();
            std::fs::write(&file.path, PRIVATE_SETTINGS).unwrap();
            let mut draft = sessions
                .begin(
                    &registry,
                    &db,
                    current_request("current-private", scope, project),
                    None,
                    files.clone(),
                    None,
                )
                .unwrap();
            assert!(draft.issues.is_empty(), "{:?}", draft.issues);
            assert_public(&draft);
            assert!(store.0.lock().unwrap().is_empty());
            for (field, value) in [
                ("model.name", json!("new-model")),
                ("ui.language", json!("zh-CN")),
                ("autoMemoryEnabled", json!(true)),
                ("autoMemoryUserScopeEnabled", json!(false)),
            ] {
                draft = sessions
                    .edit(&registry, draft, action(role, "set", field, value))
                    .unwrap();
            }
            assert_public(
                &apply::preview_registered(&registry, &draft.profile, draft.common.as_ref(), scope)
                    .unwrap(),
            );
            assert_public(&sessions.compare_current(&registry, draft.clone()).unwrap());
            let saved = sessions
                .save_current(&registry, &db, &store, draft, &files)
                .unwrap();
            assert_public(&saved);
            let mut public_profile = saved.draft.profile.clone();
            let text = std::fs::read_to_string(&file.path).unwrap();
            for fragment in [
                r#""apiKey" : "\u0073ynthetic-provider-key""#,
                r#""GITHUB_TOKEN" : "synthetic-mcp-env""#,
                r#""Authorization" : "Bearer synthetic-header""#,
            ] {
                assert!(text.contains(fragment), "private source bytes were changed");
            }
            let original: Value = serde_json::from_str(PRIVATE_SETTINGS).unwrap();
            let actual: Value = serde_json::from_str(&text).unwrap();
            for key in ["providers", "mcpServers", "customNative"] {
                assert_eq!(actual[key], original[key]);
            }
            assert_eq!(actual["model"]["name"], "new-model");
            assert_eq!(actual["ui"]["language"], "zh-CN");
            assert_eq!(actual["autoMemoryEnabled"], true);
            assert_eq!(actual["autoMemoryUserScopeEnabled"], false);
            assert_public(
                &sessions
                    .preview_backup(
                        &registry,
                        &db,
                        &store,
                        saved.draft,
                        role.into(),
                        saved.application.unwrap().transaction_id,
                    )
                    .unwrap(),
            );
            assert_public(
                &sessions
                    .begin(
                        &registry,
                        &db,
                        current_request("current-reread", scope, project),
                        None,
                        files.clone(),
                        None,
                    )
                    .unwrap(),
            );
            assert!(
                crate::native::profile::list_registered_profiles(&db, "qoder_cn")
                    .unwrap()
                    .is_empty()
            );
            if scope == Scope::Global {
                public_profile.id.clear();
                public_profile.name = "Public settings only".into();
                public_profile.version = 0;
                let mut public: Value = serde_json::from_str(&public_profile.files[role]).unwrap();
                public["model"]["name"] = json!("named-model");
                public_profile.files.insert(role.into(), public.to_string());
                let named = crate::native::profile::save_registered_profile(
                    &db,
                    &registry,
                    public_profile,
                    None,
                )
                .unwrap();
                assert_public(&named);
                assert!(apply::apply_registered_validated(
                    &registry, &db, &store, &named, None, &files, "global", scope, false,
                )
                .is_err());
                apply::apply_registered_validated(
                    &registry, &db, &store, &named, None, &files, "global", scope, true,
                )
                .unwrap();
                let actual: Value =
                    serde_json::from_str(&std::fs::read_to_string(&file.path).unwrap()).unwrap();
                assert_eq!(actual["model"]["name"], "named-model");
                assert_eq!(actual["providers"], original["providers"]);
                assert_eq!(actual["mcpServers"], original["mcpServers"]);
            }
        }
    }

    #[test]
    fn qoder_current_sessions_reject_new_sensitive_containers_and_protect_parent_deletion() {
        use crate::{
            adapters::CliAdapter,
            native::{apply, workspace::DraftSessions},
        };
        let temp = tempfile::tempdir().unwrap();
        let registry = Registry::with_adapters(vec![&QODER_CN]).unwrap();
        let db = crate::database::Database::open(&temp.path().join("injection.db")).unwrap();
        let sessions = DraftSessions::default();
        let store = CurrentStore::default();
        let files = QODER_CN.native_files(Scope::Global, temp.path(), None, true);
        let file = &files[0];
        std::fs::create_dir_all(std::path::Path::new(&file.path).parent().unwrap()).unwrap();
        std::fs::write(&file.path, "{}").unwrap();
        for (index, injection) in [
            json!({"mcpServers":{"new":{"env":{"GITHUB_TOKEN":"synthetic-injection"}}}}),
            json!({"mcpServers":{"new":{"headers":{"X-Custom":"synthetic-injection"}}}}),
            json!({"providers":{"new":{"apiKey":"synthetic-injection"}}}),
            json!({"providers":{"new":{"apiKey":"${QODER_NATIVE_KEY}"}}}),
            json!({"mcpServers":{"new":{"env":[{"CUSTOM":"synthetic-injection"}]}}}),
        ]
        .iter()
        .enumerate()
        {
            let draft = sessions
                .begin(
                    &registry,
                    &db,
                    current_request(&format!("injection-{index}"), Scope::Global, None),
                    None,
                    files.clone(),
                    None,
                )
                .unwrap();
            let invalid = sessions
                .raw(
                    &registry,
                    draft,
                    BTreeMap::from([("settings".into(), injection.to_string())]),
                )
                .unwrap();
            assert!(!invalid.issues.is_empty(), "sensitive injection accepted");
            assert!(
                apply::preview_registered(&registry, &invalid.profile, None, Scope::Global)
                    .is_err()
            );
            assert!(sessions
                .save_current(&registry, &db, &store, invalid.clone(), &files)
                .is_err());
            assert!(crate::native::profile::save_registered_profile(
                &db,
                &registry,
                invalid.profile,
                None
            )
            .is_err());
            assert_eq!(std::fs::read_to_string(&file.path).unwrap(), "{}");
        }
        std::fs::write(&file.path, PRIVATE_SETTINGS).unwrap();
        for parent in ["providers", "mcpServers"] {
            let draft = sessions
                .begin(
                    &registry,
                    &db,
                    current_request(&format!("delete-{parent}"), Scope::Global, None),
                    None,
                    files.clone(),
                    None,
                )
                .unwrap();
            let mut public: Value = serde_json::from_str(&draft.profile.files["settings"]).unwrap();
            public.as_object_mut().unwrap().remove(parent);
            let edited = sessions
                .raw(
                    &registry,
                    draft,
                    BTreeMap::from([("settings".into(), public.to_string())]),
                )
                .unwrap();
            assert!(sessions
                .save_current(&registry, &db, &store, edited, &files)
                .is_err());
            assert_eq!(
                std::fs::read_to_string(&file.path).unwrap(),
                PRIVATE_SETTINGS
            );
        }
    }

    fn fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../../tests/fixtures/native/qoder-1.1.74.json"
        ))
        .unwrap()
    }
    fn profile() -> RegisteredProfile {
        serde_json::from_value(json!({"id":"","tool":"qoder_cn","name":"Qoder settings","version":0,"inheritCommon":false,"files":{"settings":fixture()["settings"].to_string()},"connection":null,"nativeCredentials":{}})).unwrap()
    }
    fn action(role: &str, operation: &str, field: &str, value: Value) -> ConfigurationAction {
        ConfigurationAction {
            version: 1,
            target: json!(role),
            operation: operation.into(),
            field: Some(field.into()),
            value: Some(value),
        }
    }
    #[test]
    fn qoder_draft_edits_reset_and_raw_roundtrip_preserve_native_extensions() {
        let registry = Registry::with_adapters(vec![&QODER_CN]).unwrap();
        let mut draft =
            configuration::open(&registry, profile(), Scope::Global, "qoder-fields".into())
                .unwrap();
        assert!(draft.issues.is_empty(), "{:?}", draft.issues);
        assert!(draft.draft_connection.is_none());
        for (field, value) in [
            ("model.name", json!("new-model")),
            ("model.reasoningEffort", json!("max")),
            ("general.defaultPermissionMode", json!("accept_edits")),
            ("ui.language", json!("en")),
            ("autoMemoryEnabled", json!(true)),
            ("autoMemoryUserScopeEnabled", json!(false)),
        ] {
            draft = configuration::edit(
                &registry,
                draft,
                action("settings", "set", field, value.clone()),
            )
            .unwrap();
            assert_eq!(draft.view["values"][field], value);
        }
        let root: Value = serde_json::from_str(&draft.profile.files["settings"]).unwrap();
        for key in ["customUserField", "mcpServers", "enabledPlugins"] {
            assert_eq!(root[key], fixture()["settings"][key]);
        }
        assert_eq!(root["model"]["contextWindow"], 12345);
        draft = configuration::edit(
            &registry,
            draft,
            action("settings", "reset", "autoMemoryEnabled", Value::Null),
        )
        .unwrap();
        let own: Value = serde_json::from_str(&draft.profile.files["settings"]).unwrap();
        assert!(own.get("autoMemoryEnabled").is_none());
        assert!(draft.view["values"]["autoMemoryEnabled"].is_null());
        let managed = QODER_CN
            .managed_fields("settings", &json!({}), &own, &draft.profile)
            .unwrap();
        assert!(managed.released.contains(&"/autoMemoryEnabled".into()));
        let mut raw = own;
        raw["autoMemoryEnabled"] = json!(false);
        let restored = configuration::replace_text(
            &registry,
            draft,
            BTreeMap::from([("settings".into(), raw.to_string())]),
        );
        assert!(restored.issues.is_empty());
        assert_eq!(restored.view["values"]["autoMemoryEnabled"], false);
        assert!(restored
            .profile
            .editing
            .unwrap()
            .intents
            .iter()
            .all(|action| action.field.as_deref() != Some("autoMemoryEnabled")));
    }
    #[test]
    fn qoder_project_local_override_and_unknown_choices_survive_unrelated_edits() {
        let registry = Registry::with_adapters(vec![&QODER_CN]).unwrap();
        let mut profile = profile();
        let mut settings = fixture()["settings"].clone();
        settings["model"]["reasoningEffort"] = json!("future-level");
        profile
            .files
            .insert("settings".into(), settings.to_string());
        profile.files.insert(
            "local_settings".into(),
            fixture()["localSettings"].to_string(),
        );
        let draft =
            configuration::open(&registry, profile, Scope::Project, "qoder-local".into()).unwrap();
        assert!(draft.issues.is_empty());
        assert_eq!(draft.view["values"]["model.name"], "local-fixture-model");
        assert_eq!(draft.view["targets"]["model.name"], "local_settings");
        let draft = configuration::edit(
            &registry,
            draft,
            action("local_settings", "reset", "model.name", Value::Null),
        )
        .unwrap();
        assert_eq!(draft.view["values"]["model.name"], "fixture-model");
        assert_eq!(
            draft.view["values"]["model.reasoningEffort"],
            "future-level"
        );
        let temp = tempfile::tempdir().unwrap();
        let db = crate::database::Database::open(&temp.path().join("unknown-settings.db")).unwrap();
        crate::native::profile::save_registered_common(
            &db,
            &registry,
            crate::native::profile::RegisteredCommon {
                tool: "qoder_cn".into(),
                version: 0,
                revision: String::new(),
                files: BTreeMap::new(),
            },
            None,
        )
        .unwrap();
        let mut imported = draft.profile.clone();
        imported.inherit_common = true;
        imported.files.remove("local_settings");
        imported.editing.as_mut().unwrap().intents.clear();
        let saved = crate::native::profile::save_registered_profile(&db, &registry, imported, None)
            .unwrap();
        assert!(saved.files["settings"].contains("future-level"));
        let bad = action(
            "settings",
            "set",
            "model.reasoningEffort",
            json!("invented"),
        );
        assert!(configuration::edit(&registry, draft, bad).is_err());
    }
    #[test]
    fn qoder_configuration_rejects_wrong_shapes_and_global_local_files() {
        use crate::adapters::CliAdapter;
        assert!(QODER_CN
            .validate_role_scope("local_settings", Scope::Global)
            .is_err());
        let docs = BTreeMap::from([(
            "settings".into(),
            json!({"model":"old-unsupported-shape","autoMemoryEnabled":"yes"}),
        )]);
        assert_eq!(
            QODER_CN
                .validate(&docs, &EditingState::default(), Scope::Global)
                .len(),
            2
        );
    }
    #[test]
    fn qoder_settings_apply_uses_shared_transaction_and_preserves_native_login_files() {
        use crate::{
            adapters::CliAdapter,
            credentials::CredentialStore,
            native::{apply, profile::save_registered_profile},
        };
        #[derive(Default)]
        struct Store(std::sync::Mutex<BTreeMap<String, String>>);
        impl CredentialStore for Store {
            fn put(&self, id: &str, secret: &str) -> Result<(), String> {
                self.0.lock().unwrap().insert(id.into(), secret.into());
                Ok(())
            }
            fn get(&self, id: &str) -> Result<String, String> {
                self.0
                    .lock()
                    .unwrap()
                    .get(id)
                    .cloned()
                    .ok_or("missing".into())
            }
            fn delete(&self, id: &str) -> Result<(), String> {
                self.0.lock().unwrap().remove(id);
                Ok(())
            }
        }
        let temp = tempfile::tempdir().unwrap();
        let root = QODER_CN.config_root(temp.path()).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        let login = b"synthetic native login material; never imported";
        std::fs::write(root.join("credentials.json"), login).unwrap();
        let initial = json!({"customNative":{"untouched":true},"model":{"contextWindow":12345}});
        std::fs::write(root.join("settings.json"), initial.to_string()).unwrap();
        let db = crate::database::Database::open(&temp.path().join("config-test.db")).unwrap();
        let registry = Registry::with_adapters(vec![&QODER_CN]).unwrap();
        let store = Store::default();
        let mut own = profile();
        own.files.insert(
            "settings".into(),
            json!({"model":{"name":"local-choice"},"autoMemoryEnabled":true}).to_string(),
        );
        let draft =
            configuration::open(&registry, own, Scope::Global, "disk-roundtrip".into()).unwrap();
        let saved = save_registered_profile(&db, &registry, draft.profile, None).unwrap();
        let mut credential_request = saved.clone();
        credential_request.authentication = crate::native::profile::ProfileAuthentication::ApiKey;
        assert!(QODER_CN
            .write_connection_secret(
                &credential_request,
                Scope::Global,
                &store,
                &mut apply::NativeSecrets::default()
            )
            .is_err());
        let mut plaintext_request = saved.clone();
        plaintext_request.files.insert(
            "settings".into(),
            json!({"apiKey":"synthetic-rejected-key"}).to_string(),
        );
        assert!(save_registered_profile(&db, &registry, plaintext_request, None).is_err());
        let files = QODER_CN.native_files(Scope::Global, temp.path(), None, true);
        let result = apply::apply_registered_validated(
            &registry,
            &db,
            &store,
            &saved,
            None,
            &files,
            "global",
            Scope::Global,
            false,
        )
        .unwrap();
        assert_eq!(result.status, "written_for_next_session");
        let reread: Value =
            serde_json::from_str(&std::fs::read_to_string(root.join("settings.json")).unwrap())
                .unwrap();
        assert_eq!(reread["model"]["name"], "local-choice");
        assert_eq!(reread["model"]["contextWindow"], 12345);
        assert_eq!(reread["customNative"], initial["customNative"]);
        assert_eq!(reread["autoMemoryEnabled"], true);
        assert_eq!(std::fs::read(root.join("credentials.json")).unwrap(), login);
        // Editing a managed native leaf externally retains shared conflict protection.
        let mut changed = reread;
        changed["model"]["name"] = json!("external-choice");
        std::fs::write(root.join("settings.json"), changed.to_string()).unwrap();
        assert!(apply::apply_registered_validated(
            &registry,
            &db,
            &store,
            &saved,
            None,
            &files,
            "global",
            Scope::Global,
            false
        )
        .is_err());
        assert_eq!(std::fs::read(root.join("credentials.json")).unwrap(), login);
    }
}
