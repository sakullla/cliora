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
