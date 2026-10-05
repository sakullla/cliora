//! Configuration semantics live in adapter implementations. This port never writes files.
use crate::native::{
    adapter::Scope,
    profile::{Connection, RegisteredProfile},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub type Documents = BTreeMap<String, Value>;
pub const EDITING_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConfigurationSubject {
    #[default]
    Profile,
    Current,
    Common,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSupport {
    pub available: bool,
    pub multiple: bool,
    pub reason: Option<String>,
}

/// Adapter-owned logical field and its common-layer native location.
pub struct CommonParameter {
    pub field: ConfigurationField,
    pub role: &'static str,
    pub path: Vec<String>,
    pub target: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationAction {
    pub version: u32,
    /// Adapter-owned logical identity, never an array index or a filesystem path.
    pub target: Value,
    /// set, reset, create, rename, delete, default, or an adapter-declared operation.
    pub operation: String,
    pub field: Option<String>,
    pub value: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EditingState {
    pub version: u32,
    pub selected_provider: Option<String>,
    #[serde(default)]
    pub intents: Vec<ConfigurationAction>,
}
impl Default for EditingState {
    fn default() -> Self {
        Self {
            version: EDITING_VERSION,
            selected_provider: None,
            intents: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationField {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub required: bool,
    pub advanced: bool,
    pub choices: Vec<String>,
    pub minimum: Option<f64>,
    pub default_source: Option<String>,
    pub unavailable_reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationDescriptor {
    pub version: u32,
    pub fields: Vec<ConfigurationField>,
    pub operations: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationIssue {
    pub target: Value,
    pub field: Option<String>,
    pub code: String,
    pub message: String,
}

/// None means explicit deletion. Released paths restore the effective inherited
/// value or safely remove previously managed overrides to use native defaults.
/// Unowned native values remain intact. The service retains CAS and encrypted writes.
#[derive(Default)]
pub struct ManagedConfiguration {
    pub fields: BTreeMap<String, Option<Value>>,
    pub released: Vec<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PortableFieldKind {
    #[default]
    Unknown,
    Parameter,
    Credential,
    CredentialReference,
    Local,
}

#[derive(Clone, Debug)]
pub struct SuppressionChange {
    pub role: String,
    pub path: String,
    pub suppressed: bool,
}

pub trait ConfigurationAdapter: Sync {
    fn credential_paths(&self, _connection: &Connection) -> Vec<(&'static str, Vec<String>)> { Vec::new() }
    fn native_verification_module(&self) -> Option<&'static str> { None }
    fn common_parameters(&self, _scope: Scope) -> Vec<CommonParameter> { Vec::new() }
    fn common_forbidden_paths(&self) -> Vec<(&'static str, &'static str)> { Vec::new() }
    fn describe_subject(&self, scope: Scope, subject: ConfigurationSubject) -> ConfigurationDescriptor {
        if subject != ConfigurationSubject::Common { return self.describe(scope); }
        ConfigurationDescriptor { version: EDITING_VERSION, operations: vec!["set".into(), "reset".into()],
            fields: self.common_parameters(scope).into_iter().map(|parameter| parameter.field).collect() }
    }
    fn read_subject(&self, documents: &Documents, state: &EditingState, scope: Scope, subject: ConfigurationSubject) -> Result<Value, String> {
        if subject != ConfigurationSubject::Common { return self.read(documents, state); }
        Ok(serde_json::json!({"commonFields":self.common_parameters(scope).into_iter().map(|parameter| {
            let path = format!("/{}", parameter.path.iter().map(|part| crate::adapters::pointer_token(part)).collect::<Vec<_>>().join("/"));
            let value=documents.get(parameter.role).and_then(|root|root.pointer(&path));
            serde_json::json!({"id":parameter.field.id,"target":parameter.target,"value":value,"origin":if value.is_some(){"explicit"}else{"unset"}})
        }).collect::<Vec<_>>()}))
    }
    fn edit_subject(&self, documents: &mut Documents, effective: &Documents, state: &mut EditingState, action: &ConfigurationAction, scope: Scope, subject: ConfigurationSubject) -> Result<(), String> {
        if subject != ConfigurationSubject::Common { return self.edit_inherited(documents, effective, state, action); }
        let parameter = self.common_parameters(scope).into_iter().find(|parameter|
            Some(parameter.field.id.as_str()) == action.field.as_deref() && parameter.target == action.target).ok_or("此字段不适用于通用配置")?;
        if !matches!(action.operation.as_str(), "set" | "reset") { return Err("通用配置只支持字段设置与恢复默认".into()); }
        let root = documents.entry(parameter.role.into()).or_insert_with(|| serde_json::json!({}));
        let text = crate::native::format::render(crate::native::format::FileKind::Json, root)?;
        let text = crate::native::format::set_path(crate::native::format::FileKind::Json, &text, &parameter.path,
            if action.operation == "reset" { None } else { action.value.as_ref() })?;
        *root = crate::native::format::parse(crate::native::format::FileKind::Json, &text)?;
        Ok(())
    }
    fn validate_subject(&self, documents: &Documents, state: &EditingState, scope: Scope, subject: ConfigurationSubject) -> Vec<ConfigurationIssue> {
        let mut issues = self.validate(documents, state, scope);
        if subject != ConfigurationSubject::Common { return issues; }
        for parameter in self.common_parameters(scope) {
            let path=format!("/{}",parameter.path.iter().map(|part|crate::adapters::pointer_token(part)).collect::<Vec<_>>().join("/"));
            if let Some(value)=documents.get(parameter.role).and_then(|root|root.pointer(&path)) {
                let valid=match parameter.field.kind.as_str(){"boolean"=>value.is_boolean(),"string"=>value.is_string(),"integer"=>value.as_i64().is_some_and(|value|parameter.field.minimum.is_none_or(|minimum|value as f64>=minimum)),"number"=>value.as_f64().is_some_and(|value|value.is_finite()&&parameter.field.minimum.is_none_or(|minimum|value>=minimum)),_=>true};
                if !valid {issues.push(ConfigurationIssue{target:parameter.target,field:Some(parameter.field.id),code:"invalid_native_value".into(),message:"通用字段的原生类型或数值无效".into()});}
            }
        }
        for (role, path) in self.common_forbidden_paths() {
            if documents.get(role).and_then(|root| root.pointer(path)).is_some() {
                issues.push(ConfigurationIssue { target: serde_json::json!({"kind":"settings"}), field: None,
                    code: "common_scope".into(), message: format!("通用配置不能传播此模型引用：{role}{path}") });
            }
        }
        fn credentials<P: ConfigurationAdapter + ?Sized>(port: &P, value: &Value, path: &mut Vec<String>) -> bool {
            if matches!(port.portable_field_kind(path), PortableFieldKind::Credential | PortableFieldKind::CredentialReference) { return true; }
            match value {
                Value::Object(map) => map.iter().any(|(key, value)| { path.push(key.clone()); let found=credentials(port,value,path);path.pop();found }),
                Value::Array(items) => items.iter().any(|value| credentials(port,value,path)),
                _ => false,
            }
        }
        for (role, value) in documents {
            if credentials(self, value, &mut vec![role.clone()]) {
                issues.push(ConfigurationIssue { target: Value::Null, field: None, code: "common_credentials".into(), message: "通用配置不能包含或传播认证凭据及环境引用".into() });
            }
        }
        issues
    }
    /// Connection being edited, independent from the persisted default identity.
    fn draft_connection(&self, documents: &Documents, state: &EditingState) -> Result<Option<Connection>, String> { self.connection(documents, state) }
    fn catalog_support(&self) -> CatalogSupport { CatalogSupport { available: false, multiple: false, reason: Some("此配置适配器未声明模型目录映射".into()) } }
    fn catalog_actions(&self, _documents: &Documents, _state: &EditingState, _ids: &[String]) -> Result<Vec<ConfigurationAction>, String> { Err("此适配器未声明模型目录映射".into()) }
    /// Remove only empty parents left by this apply's deletion of owned leaves.
    /// Shared code protects declared empty objects, foreign values and credentials.
    fn cleanup_removed_parents(&self) -> bool {
        false
    }
    /// Validate newly introduced declarations against a trusted prior document.
    /// Existing native extensions may remain without accepting new unsupported values.
    /// Drafts use their fixed baseline; persistence supplies the old DB document.
    fn validate_changes(
        &self,
        _previous: Option<&Documents>,
        _next: &Documents,
        _state: &EditingState,
        _scope: Scope,
    ) -> Vec<ConfigurationIssue> {
        Vec::new()
    }
    /// Raw reintroduction of an entity can revoke an older deletion exclusion.
    /// Only the adapter maps logical identities to native suppression paths.
    fn reconcile_suppressions(
        &self,
        _previous: Option<&Documents>,
        _next: &Documents,
        _suppressed: &mut BTreeMap<String, Vec<String>>,
    ) -> Result<(), String> {
        Ok(())
    }
    /// Cleanup only explicitly deleted logical entities after field CAS.
    /// Shared code verifies that the candidate subtree contains only empty
    /// objects and that no detached/credential path is being removed.
    fn empty_deleted_entities(
        &self,
        _role: &str,
        _profile: &RegisteredProfile,
    ) -> Result<Vec<Vec<String>>, String> {
        Ok(Vec::new())
    }
    /// Validate a declared public reference using this CLI's native syntax only;
    /// never evaluate commands or read environment/credential values here.
    fn portable_reference_valid(&self, _path: &[String], _value: &Value) -> bool {
        false
    }

    /// Adapter-owned entity merge; the default retains ordinary object/array semantics.
    fn resolve_file(
        &self,
        _role: &str,
        base: &Value,
        own: &Value,
        suppressed: &[String],
    ) -> Result<(Value, BTreeMap<String, String>), String> {
        crate::native::format::resolve(base, own, suppressed)
    }
    /// Relinquish another provider's paths without deleting its native values.
    /// This is separate from reset and cannot override shared credential plans.
    fn unmanaged_paths(
        &self,
        _role: &str,
        _current: &Value,
        _desired: &Value,
        _profile: &RegisteredProfile,
    ) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }

    /// Classify native/model values, including action payloads, for migration.
    fn portable_field_kind(&self, _path: &[String]) -> PortableFieldKind {
        PortableFieldKind::Unknown
    }
    /// Native logical identities and field locations remain adapter-owned.
    fn suppression_changes(
        &self,
        _action: &ConfigurationAction,
    ) -> Result<Vec<SuppressionChange>, String> {
        Ok(Vec::new())
    }
    /// A valid raw document is authoritative over prior logical edits. Keep
    /// only intents that still describe its final entities and field ownership.
    fn reconcile_text(
        &self,
        previous: Option<&Documents>,
        next: &Documents,
        effective: &Documents,
        state: &mut EditingState,
    ) -> Result<(), String>;

    fn describe(&self, scope: Scope) -> ConfigurationDescriptor;
    fn read(&self, documents: &Documents, state: &EditingState) -> Result<Value, String>;
    fn edit(
        &self,
        documents: &mut Documents,
        state: &mut EditingState,
        action: &ConfigurationAction,
    ) -> Result<(), String>;
    /// Inherited values are a read-only baseline. Override when an array edit
    /// needs stable identities from common; only write the current layer.
    fn edit_inherited(
        &self,
        documents: &mut Documents,
        _effective: &Documents,
        state: &mut EditingState,
        action: &ConfigurationAction,
    ) -> Result<(), String> {
        self.edit(documents, state, action)
    }
    fn validate(
        &self,
        documents: &Documents,
        state: &EditingState,
        scope: Scope,
    ) -> Vec<ConfigurationIssue>;
    /// Read-only compatibility projection. Secrets remain opaque references.
    fn connection(
        &self,
        documents: &Documents,
        state: &EditingState,
    ) -> Result<Option<Connection>, String>;
    /// Restrict named configuration ownership to selected provider and CLI-owned settings.
    fn managed_documents(
        &self,
        documents: Documents,
        _profile: &RegisteredProfile,
        _scope: Scope,
    ) -> Result<Documents, String> {
        Ok(documents)
    }
    /// Resolve logical delete/reset intents against the current disk document;
    /// arrays must be merged by stable native identity inside the adapter.
    fn managed_fields(
        &self,
        _role: &str,
        _current: &Value,
        desired: &Value,
        _profile: &RegisteredProfile,
    ) -> Result<ManagedConfiguration, String> {
        let mut fields = BTreeMap::new();
        crate::native::apply::flatten(desired, &mut Vec::new(), &mut fields);
        Ok(ManagedConfiguration {
            fields: fields
                .into_iter()
                .map(|(path, value)| (path, Some(value)))
                .collect(),
            released: Vec::new(),
        })
    }
}
