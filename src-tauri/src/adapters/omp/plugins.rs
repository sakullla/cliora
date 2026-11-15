//! OMP plugins through the native `omp plugin` contract.
//!
//! Delivered by the plugins task. OMP plugin operations are not transactional,
//! so the capability stays absent until command results can be re-scanned and
//! partial failures reported instead of being collapsed into success.

use crate::adapters::plugins::PluginAdapter;

pub(crate) const UNAVAILABLE_REASON: &str =
    "OMP 插件（npm/git/本地 link/marketplace、启停与部分失败重扫）尚未交付";
pub(crate) const AVAILABLE_REASON: &str =
    "可通过 omp plugin 原生契约管理已核实的插件来源与启停状态";

pub(crate) fn port() -> Option<&'static dyn PluginAdapter> {
    None
}

/// Plugin management follows the port's action set; the composition root never
/// stores a plugin capability literal.
pub(crate) fn management_visible(port: Option<&dyn PluginAdapter>) -> bool {
    port.is_some_and(|adapter| !adapter.capability().actions.is_empty())
}

pub(crate) fn project_visible(port: Option<&dyn PluginAdapter>) -> bool {
    port.is_some_and(|adapter| adapter.capability().project)
}

pub(crate) fn facet() -> crate::adapters::Facet {
    match port() {
        Some(active) if management_visible(Some(active)) => crate::adapters::Facet {
            state: "available",
            reason: AVAILABLE_REASON,
        },
        _ => crate::adapters::Facet {
            state: "planned",
            reason: UNAVAILABLE_REASON,
        },
    }
}
pub(crate) fn verify_case(
    _case: &serde_json::Value,
    _context: &super::verify::CaseContext,
) -> Result<serde_json::Value, super::verify::CaseError> {
    Err(super::verify::CaseError::Unverified(UNAVAILABLE_REASON.into()))
}
