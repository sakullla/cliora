//! Antigravity CLI (agy) typed settings port — 1.5.9 evidence only.
//!
//! The signed-in evidence machine's `~/.gemini/antigravity-cli/settings.json`
//! held exactly two keys (`docs/verification/remote-workflow/agy-1.5.9/`,
//! fixture `tests/fixtures/native/antigravity-cli-1.5.9.json`): `model` (a
//! display-name string persisted by the native `/model` panel, for example
//! `Gemini 4 Carbon (Medium)`) and `trustedWorkspaces` (a string array
//! appended by the folder-trust prompt). Both are exposed as typed fields;
//! every other key stays an unknown native field preserved by the shared
//! apply/merge path, and unsupported settings keep the raw JSON editor.
//!
//! Session-only launch parameters are deliberately not settings fields: agy
//! accepts `--model <id-or-name>`, `--mode accept-edits|auto|plan` and
//! `--effort low|medium|high|xhigh|max` per session, and the evidence run
//! verified that the native `/config` panel holds no model/effort entries —
//! those values never persist. The verified choice sets are published
//! through the draft view (`launchParameters`) so the editor presents them
//! as launch-only reference data, and `--model` rides the project model
//! preference at launch (`CliAdapter::project_model_args`).
//!
//! The typed mapping is gated on the resolved native form: only a probed
//! 1.5 installation (`configuration_requires_version` +
//! `native_form_for_version`) accepts these typed writes. 1.3.x and
//! unverified installations keep the historical raw-JSON editor — the view
//! reports `typedSettings: false`, the editor disables the fields, and both
//! `edit` and the typed value checks refuse instead of guessing. Raw text
//! replacement/save stays available on every line. This port only plans
//! document edits; persistence, CAS, backups and recovery stay in the shared
//! services.

use super::Antigravity;
use crate::adapters::configuration::{
    location_pointer, ConfigurationAction, ConfigurationAdapter, ConfigurationDescriptor,
    ConfigurationField, ConfigurationIssue, Documents, EditingState, ManagedConfiguration,
    PortableFieldKind, SuppressionChange, EDITING_VERSION,
};
use crate::native::{adapter::Scope, profile::Connection};
use serde_json::{json, Value};
use std::collections::BTreeMap;

/// Verified persisted keys of the 1.5.9 settings sample.
pub(crate) const MODEL_FIELD: &str = "model";
pub(crate) const TRUSTED_FIELD: &str = "trustedWorkspaces";
const FIELDS: &[&str] = &[MODEL_FIELD, TRUSTED_FIELD];

/// Verified session-only `--mode` choices (`agy --help`, 1.5.9 evidence).
pub(crate) const MODE_VALUES: &[&str] = &["accept-edits", "auto", "plan"];
/// Verified session-only `--effort` choices (`agy --help`, 1.5.9 evidence).
pub(crate) const EFFORT_VALUES: &[&str] = &["low", "medium", "high", "xhigh", "max"];

/// Native form token of the verified 1.5 line; only this form gets typed
/// writes. The 1.3 line keeps its historical raw-JSON-only behavior.
pub(crate) const FORM_15: &str = "1.5";
pub(crate) const FORM_13: &str = "1.3";

/// Installation versions of the 1.5 line (`1.5.x` up to `<2`) carry the
/// verified settings keys. Older majors/minors stay an explicitly legacy form
/// whose typed fields are read-only and never written; an unrecognized
/// version yields `None` and the shared service records "unverified", which
/// the write gate below also refuses.
fn form_for_version(version: &str) -> Option<&'static str> {
    let version = version.trim().trim_start_matches('v');
    let mut parts = version.split('.');
    let major: u32 = parts.next()?.parse().ok()?;
    let minor: u32 = parts.next().and_then(|part| part.parse().ok()).unwrap_or(0);
    match (major, minor) {
        (1, minor) if minor >= 5 => Some(FORM_15),
        (1, _) => Some(FORM_13),
        _ => None,
    }
}

/// The typed mapping is only written on the verified 1.5 form. Everything
/// else — 1.3.x, an unverified installation, or a draft whose version was
/// never resolved — keeps the raw JSON editor instead of guessing.
fn verified_form(state: &EditingState) -> bool {
    state.native_form.as_deref() == Some(FORM_15)
}

fn unverified_write_reason() -> String {
    "Antigravity 类型化设置仅在已核验的 1.5 安装上可用；请使用原生文本编辑 settings.json".into()
}

fn nonempty_text(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= 200 && !value.chars().any(char::is_control)
}

/// `/model` persists a display-name string; blank or control-character values
/// are not a native shape and are rejected before any write.
fn valid_model(value: &Value) -> bool {
    value.as_str().is_some_and(nonempty_text)
}

/// `trustedWorkspaces` is the folder-trust prompt's string array; each entry
/// is a path, so blank or control-character items are rejected.
fn valid_trusted(value: &Value) -> bool {
    value
        .as_array()
        .is_some_and(|items| items.iter().all(|item| item.as_str().is_some_and(nonempty_text)))
}

fn field(id: &str) -> ConfigurationField {
    ConfigurationField {
        id: id.into(),
        label: if id == MODEL_FIELD {
            "模型显示名"
        } else {
            "信任的工作区"
        }
        .into(),
        kind: if id == TRUSTED_FIELD { "json" } else { "string" }.into(),
        required: false,
        advanced: false,
        choices: Vec::new(),
        minimum: None,
        default_source: Some("agy 原生默认".into()),
        unavailable_reason: None,
        origin: None,
    }
}

fn valid_value(id: &str, value: &Value) -> bool {
    if id == MODEL_FIELD {
        valid_model(value)
    } else {
        valid_trusted(value)
    }
}

/// The settings document of the draft, if the role is present.
fn settings(documents: &Documents) -> Option<&Value> {
    documents.get("settings")
}

impl ConfigurationAdapter for Antigravity {
    fn describe(&self, scope: Scope) -> ConfigurationDescriptor {
        let mut fields: Vec<ConfigurationField> = FIELDS.iter().map(|id| field(id)).collect();
        if scope == Scope::Project {
            // settings.json is a single global file; the project scope has no
            // settings role at all (its native files are mcp/hooks only).
            for entry in &mut fields {
                entry.unavailable_reason =
                    Some("agy 的 settings.json 仅在全局范围；项目范围请使用原生 JSON 或 MCP/Hooks 文件".into());
            }
        }
        ConfigurationDescriptor {
            version: EDITING_VERSION,
            fields,
            operations: vec!["set".into(), "reset".into()],
        }
    }
    fn field_locations(&self, field: &str, _documents: &Documents) -> Vec<(String, Vec<String>)> {
        if FIELDS.contains(&field) {
            vec![("settings".into(), vec![field.into()])]
        } else {
            Vec::new()
        }
    }
    fn configuration_requires_version(&self) -> bool {
        // The typed keys are verified on the 1.5 line only; the shared draft
        // and apply paths resolve the selected installation before any write.
        true
    }
    fn native_form_for_version(&self, version: Option<&str>) -> Option<String> {
        version.and_then(form_for_version).map(str::to_owned)
    }
    fn read(&self, documents: &Documents, state: &EditingState) -> Result<Value, String> {
        let root = settings(documents);
        let value = |key: &str| {
            root.and_then(|root| root.get(key))
                .cloned()
                .unwrap_or(Value::Null)
        };
        let typed = verified_form(state);
        let mut view = json!({
            "values": {
                MODEL_FIELD: value(MODEL_FIELD),
                TRUSTED_FIELD: value(TRUSTED_FIELD),
            },
            // The editor renders the verified 1.5 mapping only when the
            // selected installation resolved to that form; 1.3.x and
            // unverified installs keep the raw JSON editor.
            "typedSettings": typed,
        });
        if typed {
            // Verified per-session launch parameters (never persisted by agy):
            // surfaced as reference data only, so the editor can keep them
            // clearly distinct from the persisted fields above.
            view["launchParameters"] = json!([
                { "id": "model", "flag": "--model", "values": [], "channel": "project_model" },
                { "id": "mode", "flag": "--mode", "values": MODE_VALUES, "channel": "native_only" },
                { "id": "effort", "flag": "--effort", "values": EFFORT_VALUES, "channel": "native_only" },
                { "id": "agent", "flag": "--agent", "values": [], "channel": "launch_dialog" },
            ]);
        }
        Ok(view)
    }
    fn edit(
        &self,
        documents: &mut Documents,
        state: &mut EditingState,
        action: &ConfigurationAction,
    ) -> Result<(), String> {
        if !verified_form(state) {
            return Err(unverified_write_reason());
        }
        if action.version != EDITING_VERSION
            || !matches!(action.operation.as_str(), "set" | "reset")
        {
            return Err("Antigravity 设置仅支持设置或恢复默认".into());
        }
        let id = action
            .field
            .as_deref()
            .filter(|field| FIELDS.contains(field))
            .ok_or("Antigravity 未声明此设置字段")?;
        if action.target != json!("settings") {
            return Err("Antigravity 设置的目标是全局 settings.json".into());
        }
        let value = if action.operation == "reset" {
            None
        } else {
            let value = action.value.as_ref().ok_or("缺少设置值")?;
            if !valid_value(id, value) {
                return Err(if id == MODEL_FIELD {
                    "模型显示名须为非空单行字符串".into()
                } else {
                    "trustedWorkspaces 须为字符串数组，且每项为非空路径".into()
                });
            }
            Some(value.clone())
        };
        let root = documents
            .entry("settings".into())
            .or_insert_with(|| json!({}));
        let map = root
            .as_object_mut()
            .ok_or("settings.json 顶层必须是 JSON 对象；请先修正原文")?;
        match value {
            Some(value) => {
                map.insert(id.into(), value);
            }
            None => {
                map.remove(id);
            }
        }
        Ok(())
    }
    fn validate(
        &self,
        documents: &Documents,
        state: &EditingState,
        _scope: Scope,
    ) -> Vec<ConfigurationIssue> {
        let mut issues = Vec::new();
        let Some(root) = settings(documents) else {
            return issues;
        };
        if !root.is_object() {
            issues.push(ConfigurationIssue {
                target: json!("settings"),
                field: None,
                code: "invalid_document".into(),
                message: "settings.json 顶层必须是 JSON 对象".into(),
            });
            return issues;
        }
        // 1.3.x and unverified installs have no verified key semantics: their
        // raw JSON stays editable and is never judged by the 1.5 shapes.
        if !verified_form(state) {
            return issues;
        }
        for id in FIELDS {
            if root.get(*id).is_some_and(|value| !valid_value(id, value)) {
                issues.push(ConfigurationIssue {
                    target: json!("settings"),
                    field: Some((*id).into()),
                    code: "invalid_native_value".into(),
                    message: if *id == MODEL_FIELD {
                        "model 须为非空单行字符串（/model 持久化的显示名）".into()
                    } else {
                        "trustedWorkspaces 须为字符串数组（信任提示写入的路径列表）".into()
                    },
                });
            }
        }
        issues
    }
    fn suppression_changes(
        &self,
        action: &ConfigurationAction,
        _state: &EditingState,
    ) -> Result<Vec<SuppressionChange>, String> {
        // Field edits (re)claim their native path; suppression entries are an
        // inheritance exclusion and antigravity declares no common layer, so
        // each intent only clears its own path like the qoder precedent.
        let field = action
            .field
            .as_deref()
            .filter(|field| FIELDS.contains(field))
            .ok_or("Antigravity 未声明此设置字段")?;
        Ok(vec![SuppressionChange {
            role: "settings".into(),
            path: location_pointer(&[field.into()]),
            suppressed: false,
        }])
    }
    // Antigravity never manages provider connections through settings.json
    // (the keyring login is not adopted; the headless key is launch-env only).
    fn connection(
        &self,
        _documents: &Documents,
        _state: &EditingState,
    ) -> Result<Option<Connection>, String> {
        Ok(None)
    }
    fn portable_field_kind(&self, path: &[String]) -> PortableFieldKind {
        let path = path
            .strip_prefix(["settings".to_owned()].as_slice())
            .unwrap_or(path);
        match path {
            [key] if FIELDS.contains(&key.as_str()) => PortableFieldKind::Parameter,
            _ => PortableFieldKind::Unknown,
        }
    }
    fn reconcile_text(
        &self,
        _previous: Option<&Documents>,
        next: &Documents,
        _effective: &Documents,
        state: &mut EditingState,
    ) -> Result<(), String> {
        state.intents.retain(|action| {
            if action.operation != "reset" {
                return true;
            }
            match action.field.as_deref() {
                Some(id) if FIELDS.contains(&id) => {
                    settings(next).and_then(|root| root.get(id)).is_none()
                }
                _ => true,
            }
        });
        Ok(())
    }
    fn managed_fields(
        &self,
        role: &str,
        _current: &Value,
        desired: &Value,
        profile: &crate::native::profile::RegisteredProfile,
    ) -> Result<ManagedConfiguration, String> {
        let mut flat = BTreeMap::new();
        crate::native::apply::flatten(desired, &mut vec![], &mut flat);
        let mut managed = ManagedConfiguration {
            fields: flat
                .into_iter()
                .map(|(path, value)| (path, Some(value)))
                .collect(),
            released: Vec::new(),
        };
        if role == "settings" {
            if let Some(state) = &profile.editing {
                for action in &state.intents {
                    if action.operation == "reset"
                        && action.target == json!("settings")
                        && action
                            .field
                            .as_deref()
                            .is_some_and(|id| FIELDS.contains(&id))
                    {
                        let pointer = location_pointer(&[action.field.clone().unwrap()]);
                        if !managed.released.contains(&pointer) {
                            managed.released.push(pointer);
                        }
                    }
                }
            }
        }
        Ok(managed)
    }
}

impl ConfigurationAdapter for &Antigravity {
    fn describe(&self, scope: Scope) -> ConfigurationDescriptor {
        (**self).describe(scope)
    }
    fn reconcile_text(
        &self,
        previous: Option<&Documents>,
        next: &Documents,
        effective: &Documents,
        state: &mut EditingState,
    ) -> Result<(), String> {
        (**self).reconcile_text(previous, next, effective, state)
    }
    fn read(&self, documents: &Documents, state: &EditingState) -> Result<Value, String> {
        (**self).read(documents, state)
    }
    fn edit(
        &self,
        documents: &mut Documents,
        state: &mut EditingState,
        action: &ConfigurationAction,
    ) -> Result<(), String> {
        (**self).edit(documents, state, action)
    }
    fn validate(
        &self,
        documents: &Documents,
        state: &EditingState,
        scope: Scope,
    ) -> Vec<ConfigurationIssue> {
        (**self).validate(documents, state, scope)
    }
    fn connection(
        &self,
        documents: &Documents,
        state: &EditingState,
    ) -> Result<Option<Connection>, String> {
        (**self).connection(documents, state)
    }
    fn managed_fields(
        &self,
        role: &str,
        current: &Value,
        desired: &Value,
        profile: &crate::native::profile::RegisteredProfile,
    ) -> Result<ManagedConfiguration, String> {
        (**self).managed_fields(role, current, desired, profile)
    }
    fn field_locations(&self, field: &str, documents: &Documents) -> Vec<(String, Vec<String>)> {
        (**self).field_locations(field, documents)
    }
    fn suppression_changes(
        &self,
        action: &ConfigurationAction,
        state: &EditingState,
    ) -> Result<Vec<SuppressionChange>, String> {
        (**self).suppression_changes(action, state)
    }
    fn portable_field_kind(&self, path: &[String]) -> PortableFieldKind {
        (**self).portable_field_kind(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::configuration::ConfigurationSubject;
    use crate::adapters::{CliAdapter, Registry, ANTIGRAVITY};
    use crate::native::configuration as drafts;

    const SETTINGS_FIXTURE: &str =
        include_str!("../../../../tests/fixtures/native/antigravity-cli-1.5.9.json");
    // 1.3.1 sample: `modelProvider`/`security` shape, no verified typed keys.
    const LEGACY_FIXTURE: &str =
        include_str!("../../../../tests/fixtures/native/antigravity-cli-1.3.json");

    fn registry() -> Registry {
        Registry::with_adapters(vec![&ANTIGRAVITY]).unwrap()
    }

    fn profile_with(files: &str) -> crate::native::profile::RegisteredProfile {
        serde_json::from_value(json!({
            "id": "",
            "tool": "antigravity",
            "name": "Antigravity settings",
            "version": 0,
            "inheritCommon": false,
            "files": { "settings": files },
            "connection": null,
            "nativeCredentials": {},
            // The typed mapping is gated on the resolved 1.5 form; the shared
            // draft begin resolves it from the selected installation.
            "editing": { "version": EDITING_VERSION, "intents": [], "nativeForm": FORM_15 },
        }))
        .unwrap()
    }

    fn form_state(form: &str) -> EditingState {
        EditingState {
            native_form: Some(form.into()),
            ..EditingState::default()
        }
    }

    fn action(operation: &str, field: &str, value: Value) -> ConfigurationAction {
        ConfigurationAction {
            version: EDITING_VERSION,
            target: json!("settings"),
            operation: operation.into(),
            field: Some(field.into()),
            value: Some(value),
        }
    }

    #[test]
    fn descriptor_exposes_only_the_verified_persisted_fields() {
        let global = ANTIGRAVITY.describe(Scope::Global);
        assert_eq!(
            global
                .fields
                .iter()
                .map(|field| field.id.as_str())
                .collect::<Vec<_>>(),
            vec![MODEL_FIELD, TRUSTED_FIELD]
        );
        assert!(global.fields.iter().all(|field| field.choices.is_empty()));
        assert!(global.operations.iter().all(|op| ["set", "reset"].contains(&op.as_str())));
        assert!(global
            .fields
            .iter()
            .all(|field| field.unavailable_reason.is_none()));
        // settings.json is global-only: project scope keeps the fields visible
        // but explicitly unavailable instead of silently editing nothing.
        let project = ANTIGRAVITY.describe(Scope::Project);
        assert!(project
            .fields
            .iter()
            .all(|field| field.unavailable_reason.is_some()));
    }

    #[test]
    fn draft_edits_map_native_keys_and_preserve_unknown_fields() {
        let registry = registry();
        let mut draft = drafts::open(
            &registry,
            profile_with(
                "{\"model\":\"Old Model\",\"unknownNative\":{\"keep\":[1,2]},\"trustedWorkspaces\":[\"/home/example/alpha\"]}",
            ),
            Scope::Global,
            "agy-fields".into(),
        )
        .unwrap();
        assert!(draft.issues.is_empty(), "{:?}", draft.issues);
        assert_eq!(draft.view["values"][MODEL_FIELD], "Old Model");
        assert_eq!(
            draft.view["values"][TRUSTED_FIELD],
            json!(["/home/example/alpha"])
        );
        draft = drafts::edit(
            &registry,
            draft,
            action("set", MODEL_FIELD, json!("Gemini 4 Carbon (Medium)")),
        )
        .unwrap();
        draft = drafts::edit(
            &registry,
            draft,
            action(
                "set",
                TRUSTED_FIELD,
                json!(["/home/example/alpha", "/home/example/projects/beta"]),
            ),
        )
        .unwrap();
        let root: Value = serde_json::from_str(&draft.profile.files["settings"]).unwrap();
        assert_eq!(root[MODEL_FIELD], "Gemini 4 Carbon (Medium)");
        assert_eq!(
            root[TRUSTED_FIELD],
            json!(["/home/example/alpha", "/home/example/projects/beta"])
        );
        // Unknown native fields survive typed edits untouched (R2).
        assert_eq!(root["unknownNative"], json!({"keep": [1, 2]}));
        // The verified session-only launch parameters ride along as reference
        // data, never as persisted settings fields.
        assert_eq!(
            draft.view["launchParameters"][1]["values"],
            json!(MODE_VALUES)
        );
        assert_eq!(
            draft.view["launchParameters"][2]["values"],
            json!(EFFORT_VALUES)
        );
        // Reset removes the owned key and releases it for apply.
        draft = drafts::edit(
            &registry,
            draft,
            action("reset", TRUSTED_FIELD, Value::Null),
        )
        .unwrap();
        let own: Value = serde_json::from_str(&draft.profile.files["settings"]).unwrap();
        assert!(own.get(TRUSTED_FIELD).is_none());
        assert_eq!(own["unknownNative"], json!({"keep": [1, 2]}));
        let managed = ANTIGRAVITY
            .managed_fields("settings", &json!({}), &own, &draft.profile)
            .unwrap();
        assert!(managed.released.contains(&format!("/{TRUSTED_FIELD}")));
    }

    #[test]
    fn invalid_values_are_rejected_before_any_write() {
        let registry = registry();
        let draft = drafts::open(
            &registry,
            profile_with(SETTINGS_FIXTURE),
            Scope::Global,
            "agy-invalid".into(),
        )
        .unwrap();
        for (field, value) in [
            (MODEL_FIELD, json!("")),
            (MODEL_FIELD, json!("  ")),
            (MODEL_FIELD, json!("line\nbreak")),
            (MODEL_FIELD, json!(42)),
            (TRUSTED_FIELD, json!("/not/an/array")),
            (TRUSTED_FIELD, json!(["/ok", ""])),
            (TRUSTED_FIELD, json!([42])),
        ] {
            assert!(
                drafts::edit(&registry, draft.clone(), action("set", field, value.clone())).is_err(),
                "{field} accepted {value}"
            );
        }
        // Unknown fields and wrong targets never reach the document.
        assert!(drafts::edit(
            &registry,
            draft.clone(),
            ConfigurationAction {
                version: EDITING_VERSION,
                target: json!("settings"),
                operation: "set".into(),
                field: Some("inventedSetting".into()),
                value: Some(json!("x")),
            }
        )
        .is_err());
        assert!(drafts::edit(
            &registry,
            draft,
            ConfigurationAction {
                version: EDITING_VERSION,
                target: json!("other"),
                operation: "set".into(),
                field: Some(MODEL_FIELD.into()),
                value: Some(json!("x")),
            }
        )
        .is_err());
        // Native documents with wrong shapes surface typed issues (draft.issues).
        let documents = Documents::from([(
            "settings".into(),
            json!({MODEL_FIELD: 7, TRUSTED_FIELD: "not-array"}),
        )]);
        let issues = ANTIGRAVITY.validate(&documents, &form_state(FORM_15), Scope::Global);
        assert_eq!(issues.len(), 2);
        assert!(issues.iter().all(|issue| issue.code == "invalid_native_value"));
        let non_object = Documents::from([("settings".into(), json!([1, 2]))]);
        let issues = ANTIGRAVITY.validate(&non_object, &form_state(FORM_15), Scope::Global);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].code, "invalid_document");
    }

    #[test]
    fn raw_edits_reconcile_reset_intents_and_keep_the_public_document() {
        let registry = registry();
        let mut draft = drafts::open(
            &registry,
            profile_with(SETTINGS_FIXTURE),
            Scope::Global,
            "agy-raw".into(),
        )
        .unwrap();
        draft = drafts::edit(
            &registry,
            draft,
            action("reset", MODEL_FIELD, Value::Null),
        )
        .unwrap();
        let mut raw: Value =
            serde_json::from_str(&draft.profile.files["settings"]).unwrap();
        raw[MODEL_FIELD] = json!(" externally typed ");
        let restored = drafts::replace_text(
            &registry,
            draft,
            BTreeMap::from([("settings".into(), raw.to_string())]),
        );
        assert!(restored.issues.is_empty(), "{:?}", restored.issues);
        // The raw document is authoritative: the stale reset intent for a key
        // that exists again is dropped instead of removing it on apply.
        assert!(restored
            .profile
            .editing
            .as_ref()
            .unwrap()
            .intents
            .iter()
            .all(|action| action.field.as_deref() != Some(MODEL_FIELD)));
        assert_eq!(restored.view["values"][MODEL_FIELD], " externally typed ");
    }

    #[test]
    fn current_file_roundtrip_through_the_shared_apply_preserves_other_fields() {
        use crate::native::workspace::DraftSessions;

        #[derive(Default)]
        struct Store(std::cell::RefCell<BTreeMap<String, String>>);
        impl crate::credentials::CredentialStore for Store {
            fn put(&self, id: &str, secret: &str) -> Result<(), String> {
                self.0.borrow_mut().insert(id.into(), secret.into());
                Ok(())
            }
            fn get(&self, id: &str) -> Result<String, String> {
                self.0.borrow().get(id).cloned().ok_or_else(|| "missing".into())
            }
            fn delete(&self, id: &str) -> Result<(), String> {
                self.0.borrow_mut().remove(id);
                Ok(())
            }
        }
        let temp = tempfile::tempdir().unwrap();
        let registry = registry();
        let db = crate::database::Database::open(&temp.path().join("agy-current.db")).unwrap();
        let sessions = DraftSessions::default();
        let store = Store::default();
        let files = ANTIGRAVITY.native_files(Scope::Global, temp.path(), None, true);
        let settings = files.iter().find(|file| file.role == "settings").unwrap();
        std::fs::create_dir_all(std::path::Path::new(&settings.path).parent().unwrap()).unwrap();
        // The current-file editor reads every non-sensitive native role, so
        // the standalone hooks document needs a valid named-hooks file.
        let hooks = files.iter().find(|file| file.role == "hooks").unwrap();
        std::fs::create_dir_all(std::path::Path::new(&hooks.path).parent().unwrap()).unwrap();
        std::fs::write(
            &hooks.path,
            "{\"fixture-hook\":{\"Stop\":[{\"type\":\"command\",\"command\":\"/bin/true\"}]}}",
        )
        .unwrap();
        // A native file holding both verified keys, one unverified known key
        // from an older install line and one unknown field.
        let original = "{\"model\":\"Old Model\",\"trustedWorkspaces\":[\"/home/example/alpha\"],\"modelProvider\":\"gemini\",\"futureNative\":{\"keep\":true}}";
        std::fs::write(&settings.path, original).unwrap();
        let request = crate::native::workspace::ConfigurationBeginRequest {
            tool_id: "antigravity".into(),
            scope: Scope::Global,
            project_path: None,
            session_id: "agy-current".into(),
            subject: ConfigurationSubject::Current,
            profile: None,
            remote_target_id: None,
            remote_common: None,
            remote_files: BTreeMap::new(),
        };
        let mut draft = sessions
            .begin(&registry, &db, request, None, files.clone(), Some(FORM_15))
            .unwrap();
        assert!(draft.issues.is_empty(), "{:?}", draft.issues);
        draft = sessions
            .edit(
                &registry,
                draft,
                action("set", MODEL_FIELD, json!("Gemini 4 Carbon (Medium)")),
            )
            .unwrap();
        let saved = sessions
            .save_current(&registry, &db, &store, draft, &files)
            .unwrap();
        assert_eq!(
            saved.application.as_ref().unwrap().status,
            "written_for_next_session"
        );
        let text = std::fs::read_to_string(&settings.path).unwrap();
        let actual: Value = serde_json::from_str(&text).unwrap();
        // The typed edit lands; every other known and unknown field is
        // unchanged after the shared transactional save (R2).
        assert_eq!(actual[MODEL_FIELD], "Gemini 4 Carbon (Medium)");
        assert_eq!(actual["trustedWorkspaces"], json!(["/home/example/alpha"]));
        assert_eq!(actual["modelProvider"], "gemini");
        assert_eq!(actual["futureNative"], json!({"keep": true}));

        // A parse failure on the native file is an error with the original
        // bytes untouched — never a silent rebuild.
        std::fs::write(&settings.path, "{ not json").unwrap();
        let request = crate::native::workspace::ConfigurationBeginRequest {
            tool_id: "antigravity".into(),
            scope: Scope::Global,
            project_path: None,
            session_id: "agy-broken".into(),
            subject: ConfigurationSubject::Current,
            profile: None,
            remote_target_id: None,
            remote_common: None,
            remote_files: BTreeMap::new(),
        };
        assert!(sessions
            .begin(&registry, &db, request, None, files.clone(), None)
            .is_err());
        assert_eq!(std::fs::read_to_string(&settings.path).unwrap(), "{ not json");
    }

    #[test]
    fn named_profile_apply_uses_the_shared_transaction() {
        use crate::native::{apply, profile::save_registered_profile};
        #[derive(Default)]
        struct Store(std::cell::RefCell<BTreeMap<String, String>>);
        impl crate::credentials::CredentialStore for Store {
            fn put(&self, id: &str, secret: &str) -> Result<(), String> {
                self.0.borrow_mut().insert(id.into(), secret.into());
                Ok(())
            }
            fn get(&self, id: &str) -> Result<String, String> {
                self.0.borrow().get(id).cloned().ok_or_else(|| "missing".into())
            }
            fn delete(&self, id: &str) -> Result<(), String> {
                self.0.borrow_mut().remove(id);
                Ok(())
            }
        }
        let temp = tempfile::tempdir().unwrap();
        let registry = registry();
        let db = crate::database::Database::open(&temp.path().join("agy-named.db")).unwrap();
        let store = Store::default();
        let files = ANTIGRAVITY.native_files(Scope::Global, temp.path(), None, true);
        let settings = files.iter().find(|file| file.role == "settings").unwrap();
        std::fs::create_dir_all(std::path::Path::new(&settings.path).parent().unwrap()).unwrap();
        std::fs::write(
            &settings.path,
            json!({"model":"Native Model","futureNative":{"keep":true}}).to_string(),
        )
        .unwrap();
        let draft = drafts::open(
            &registry,
            profile_with(&json!({"model":"Named Model"}).to_string()),
            Scope::Global,
            "agy-named".into(),
        )
        .unwrap();
        let saved = save_registered_profile(&db, &registry, draft.profile, None).unwrap();
        // The native value differs from the desired field: without an explicit
        // takeover the shared apply refuses instead of overwriting silently.
        assert!(apply::apply_registered_validated(
            &registry, &db, &store, &saved, None, &files, "global", Scope::Global, false,
        )
        .is_err());
        apply::apply_registered_validated(
            &registry, &db, &store, &saved, None, &files, "global", Scope::Global, true,
        )
        .unwrap();
        let actual: Value =
            serde_json::from_str(&std::fs::read_to_string(&settings.path).unwrap()).unwrap();
        assert_eq!(actual[MODEL_FIELD], "Named Model");
        assert_eq!(actual["futureNative"], json!({"keep": true}));
    }

    #[test]
    fn typed_writes_are_gated_to_the_verified_15_form() {
        assert_eq!(form_for_version("1.5.9"), Some(FORM_15));
        assert_eq!(form_for_version("v1.6.0"), Some(FORM_15));
        assert_eq!(form_for_version("1.3.1"), Some(FORM_13));
        assert_eq!(form_for_version("1.4.0"), Some(FORM_13));
        assert_eq!(form_for_version("2.0.0"), None);
        assert_eq!(form_for_version("not-a-version"), None);
        assert_eq!(
            ANTIGRAVITY.native_form_for_version(Some("1.5.9")).as_deref(),
            Some(FORM_15)
        );
        assert_eq!(
            ANTIGRAVITY.native_form_for_version(Some("1.3.1")).as_deref(),
            Some(FORM_13)
        );
        assert!(ANTIGRAVITY.native_form_for_version(None).is_none());

        let registry = registry();
        let mut legacy = drafts::open(
            &registry,
            profile_with(LEGACY_FIXTURE),
            Scope::Global,
            "agy-legacy".into(),
        )
        .unwrap();
        legacy.profile.editing.as_mut().unwrap().native_form = Some(FORM_13.into());
        // The 1.3 view exposes no typed mapping and no 1.5 launch reference.
        let view = ANTIGRAVITY
            .read(
                &drafts_documents(&legacy),
                legacy.profile.editing.as_ref().unwrap(),
            )
            .unwrap();
        assert_eq!(view["typedSettings"], false);
        assert!(view.get("launchParameters").is_none());
        // Typed set/reset are refused before touching the document; the raw
        // text path (the 1.3 behavior) stays available and unchanged.
        assert!(drafts::edit(
            &registry,
            legacy.clone(),
            action("set", MODEL_FIELD, json!("Gemini 4 Carbon (Medium)"))
        )
        .is_err());
        assert!(drafts::edit(
            &registry,
            legacy.clone(),
            action("reset", MODEL_FIELD, Value::Null)
        )
        .is_err());
        let before = legacy.profile.files["settings"].clone();
        let raw = drafts::replace_text(
            &registry,
            legacy.clone(),
            BTreeMap::from([(
                "settings".into(),
                before.replace("\"gemini\"", "\"gemini-next\""),
            )]),
        );
        assert!(raw.issues.is_empty(), "{:?}", raw.issues);
        assert!(raw.profile.files["settings"].contains("gemini-next"));
        // An unresolved form is treated the same as legacy: no typed write.
        let mut unresolved = legacy;
        unresolved.profile.editing.as_mut().unwrap().native_form = None;
        assert!(drafts::edit(
            &registry,
            unresolved,
            action("set", MODEL_FIELD, json!("Gemini 4 Carbon (Medium)"))
        )
        .is_err());
    }

    fn drafts_documents(draft: &crate::native::configuration::ConfigurationDraft) -> Documents {
        draft
            .profile
            .files
            .iter()
            .map(|(role, text)| (role.clone(), serde_json::from_str(text).unwrap()))
            .collect()
    }
}
