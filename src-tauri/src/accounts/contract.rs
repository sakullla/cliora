use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AccountState {
    SignedOut,
    Pending,
    SignedIn,
    Expired,
    Error,
    Unknown,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountIdentity {
    /// Native account ID or native-reported email, never an application primary key.
    pub subject: String,
    pub email: Option<String>,
    pub plan: Option<String>,
    pub source: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeContext {
    pub id: String,
    pub tool_id: String,
    pub root: PathBuf,
    pub config_root: PathBuf,
    pub auth_files: Vec<PathBuf>,
    pub history_roots: Vec<PathBuf>,
    pub resource_root: PathBuf,
    pub environment: BTreeMap<String, String>,
    pub remove_environment: Vec<String>,
    pub cli_args: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingLogin {
    pub id: String,
    pub expires_at: i64,
    pub context: NativeContext,
    pub previous_state: AccountState,
    /// An external native terminal remains user-controlled after cancel/timeout.
    pub external_terminal: bool,
    pub operation: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthAccount {
    pub id: String,
    pub tool_id: String,
    pub provider: String,
    pub label: String,
    pub version: u32,
    pub state: AccountState,
    pub identity: Option<AccountIdentity>,
    pub context: Option<NativeContext>,
    /// Retained locations for history/resource discovery; never implicit launch targets.
    #[serde(default)]
    pub retired_contexts: Vec<NativeContext>,
    pub pending_login: Option<PendingLogin>,
    pub checked_at: Option<i64>,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountCapability {
    pub browser_link: bool,
    pub tool_id: &'static str,
    pub provider: &'static str,
    pub version: &'static str,
    pub managed_login: bool,
    pub import_native: bool,
    pub methods: Vec<&'static str>,
    pub reason: &'static str,
    pub identity_source: &'static str,
    pub refresh_owner: &'static str,
    pub acceptance: &'static str,
}

#[derive(Clone, Debug)]
pub struct Observation {
    pub state: AccountState,
    pub identity: Option<AccountIdentity>,
    pub detail: Option<String>,
}

/// Read-only discovery, separate from an account owned and selected by Cliora.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeLogin {
    pub provider: String,
    pub auth_kind: String,
    pub state: AccountState,
    pub identity: Option<AccountIdentity>,
    pub detail: Option<String>,
    pub managed_account_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeLoginSnapshot {
    pub tool_id: String,
    pub logins: Vec<NativeLogin>,
    pub checked_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AccountImpactContextKind {
    Current,
    Retained,
    Pending,
    Unknown,
    None,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountImpactContext {
    pub id: String,
    pub kind: AccountImpactContextKind,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountImpactProfile {
    pub id: String,
    pub name: String,
    pub tool_id: String,
    pub version: u64,
    pub revision: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountReapplyRequest {
    pub account_id: String,
    pub expected_account_version: u32,
    pub expected_context_id: String,
    pub tool_id: String,
    pub profile_id: String,
    pub expected_profile_version: u64,
    pub expected_profile_revision: String,
    pub scope: crate::native::adapter::Scope,
    pub project_path: Option<String>,
    pub expected_binding_fingerprint: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountImpactScope {
    pub binding_id: String,
    pub tool_id: String,
    pub profile_id: String,
    pub profile_name: Option<String>,
    pub profile_version: u64,
    pub scope: Option<crate::native::adapter::Scope>,
    pub project_path: Option<String>,
    pub project_name: Option<String>,
    pub context_id: Option<String>,
    pub context_kind: AccountImpactContextKind,
    pub active: bool,
    pub needs_reapply: bool,
    pub can_reapply: bool,
    pub reason: Option<String>,
    pub reapply_request: Option<AccountReapplyRequest>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountImpactUsageReference {
    pub id: String,
    pub label: String,
    pub version: u32,
    pub enabled: bool,
    pub account_id: Option<String>,
    pub context_id: Option<String>,
    pub profile_id: Option<String>,
    pub context_kind: AccountImpactContextKind,
    pub needs_rebind: bool,
}

/// DB-only summary. Native roots, environment, arguments, file contents, query
/// programs and credential references are deliberately absent.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountImpact {
    pub account_id: String,
    pub account_version: u32,
    pub tool_id: String,
    pub current_context_id: Option<String>,
    pub contexts: Vec<AccountImpactContext>,
    pub profiles: Vec<AccountImpactProfile>,
    pub scopes: Vec<AccountImpactScope>,
    pub usage_references: Vec<AccountImpactUsageReference>,
}
