//! OMP plugins through the native `omp plugin` contract.
//!
//! Delivered by the plugins task. OMP plugin operations are not transactional,
//! so the capability stays absent until command results can be re-scanned and
//! partial failures reported instead of being collapsed into success.

use crate::adapters::plugins::PluginAdapter;

pub(crate) const UNAVAILABLE_REASON: &str =
    "OMP 插件（npm/git/本地 link/marketplace、启停与部分失败重扫）尚未交付";

pub(crate) fn port() -> Option<&'static dyn PluginAdapter> {
    None
}
pub(crate) fn verify_case(
    _case: &serde_json::Value,
    _context: &super::verify::CaseContext,
) -> Result<serde_json::Value, super::verify::CaseError> {
    Err(super::verify::CaseError::Unverified(UNAVAILABLE_REASON.into()))
}
