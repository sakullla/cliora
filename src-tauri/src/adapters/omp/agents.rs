//! OMP Agent definitions: user/project Markdown, extension and builtin sources.
//!
//! Delivered by the resources task. Until the native definition layout and
//! override precedence are verified, the capability is absent rather than
//! reusing Pi's unverified format.

use crate::adapters::agents::AgentAdapter;
use crate::adapters::Facet;

pub(crate) const UNAVAILABLE_REASON: &str =
    "OMP Agent 定义（用户/项目 Markdown、扩展来源与禁用策略）尚未交付";
pub(crate) const AVAILABLE_REASON: &str =
    "可管理 OMP 自有用户/项目 Agent 定义；内置与扩展来源保持只读";

pub(crate) fn port() -> Option<&'static dyn AgentAdapter> {
    None
}

pub(crate) fn facet() -> Facet {
    match port() {
        Some(adapter) if adapter.capability().supported => Facet {
            state: "available",
            reason: AVAILABLE_REASON,
        },
        _ => Facet {
            state: "planned",
            reason: UNAVAILABLE_REASON,
        },
    }
}

pub(crate) fn management_visible(port: Option<&dyn AgentAdapter>) -> bool {
    port.is_some_and(|adapter| adapter.capability().supported)
}

pub(crate) fn verify_case(
    _case: &serde_json::Value,
    _context: &super::verify::CaseContext,
) -> Result<serde_json::Value, super::verify::CaseError> {
    Err(super::verify::CaseError::Unverified(UNAVAILABLE_REASON.into()))
}
