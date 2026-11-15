//! OMP accounts: read-only agent.db discovery and evidence-gated managed login.
//!
//! Delivered by the accounts task. `agent.db` mixes authentication material with
//! other OMP state, so until per-provider identity, isolation, login, refresh
//! ownership and logout evidence exists the capability is absent instead of
//! exposing controls that would copy or delete native credentials.

use crate::adapters::accounts::AccountAdapter;
use crate::adapters::NativeCredentialTarget;
use crate::native::adapter::Scope;

pub(crate) const UNAVAILABLE_REASON: &str =
    "OMP 账号发现与托管尚未交付；agent.db 含认证之外的状态，未核实前不观察、不采纳、不复制凭据";

pub(crate) fn port() -> Option<&'static dyn AccountAdapter> {
    None
}

pub(crate) fn native_credential_target(_scope: Scope) -> Option<NativeCredentialTarget> {
    None
}
pub(crate) fn verify_case(
    _case: &serde_json::Value,
    _context: &super::verify::CaseContext,
) -> Result<serde_json::Value, super::verify::CaseError> {
    Err(super::verify::CaseError::Unverified(UNAVAILABLE_REASON.into()))
}
