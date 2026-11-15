//! OMP accounts: read-only agent.db discovery and evidence-gated managed login.
//!
//! Delivered by the accounts task. `agent.db` mixes authentication material with
//! other OMP state, so until per-provider identity, isolation, login, refresh
//! ownership and logout evidence exists the capability is absent instead of
//! exposing controls that would copy or delete native credentials.

use crate::adapters::accounts::AccountAdapter;
use crate::adapters::{Facet, LoginCapability, NativeCredentialTarget};
use crate::native::adapter::Scope;

pub(crate) const UNAVAILABLE_REASON: &str =
    "OMP 账号发现与托管尚未交付；agent.db 含认证之外的状态，未核实前不观察、不采纳、不复制凭据";
pub(crate) const AVAILABLE_REASON: &str =
    "可只读展示可解析的 OMP 原生登录；托管登录仅按逐提供方真实证据开放";

pub(crate) fn port() -> Option<&'static dyn AccountAdapter> {
    None
}

pub(crate) fn native_credential_target(_scope: Scope) -> Option<NativeCredentialTarget> {
    None
}

/// Account publication follows the port: a verified read-only discovery port
/// makes the accounts tab appear without editing the composition root, while
/// managed login stays governed by the port's own capability flags.
pub(crate) fn management_visible(port: Option<&dyn AccountAdapter>) -> bool {
    port.is_some()
}

/// Accounts facet for the descriptor. The accounts task owns this state by
/// publishing its port and reasons here.
pub(crate) fn facet() -> Facet {
    match port() {
        Some(_) => Facet {
            state: "available",
            reason: AVAILABLE_REASON,
        },
        _ => Facet {
            state: "planned",
            reason: UNAVAILABLE_REASON,
        },
    }
}

/// Interactive login entry. OMP's login is a native `/login` TUI command and is
/// not a launched CLI flag; the accounts task overrides this with its verified
/// command instead of the descriptor inventing one.
pub(crate) fn login_args() -> Option<Vec<String>> {
    None
}

pub(crate) fn login_hint() -> &'static str {
    ""
}

pub(crate) fn login_capability() -> Option<LoginCapability> {
    login_args().map(|_| LoginCapability {
        hint: login_hint(),
    })
}

pub(crate) fn verify_case(
    _case: &serde_json::Value,
    _context: &super::verify::CaseContext,
) -> Result<serde_json::Value, super::verify::CaseError> {
    Err(super::verify::CaseError::Unverified(UNAVAILABLE_REASON.into()))
}
