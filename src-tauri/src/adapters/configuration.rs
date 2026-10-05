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

pub trait ConfigurationAdapter: Sync {
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
