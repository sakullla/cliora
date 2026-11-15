//! OMP native MCP: user `~/.omp/agent/mcp.json`, project `.omp/mcp.json`,
//! stdio/http/sse and OMP's own enabled/disabled overlays for external sources.
//!
//! Delivered by the resources task. Until the native load order and overlay
//! semantics are verified, the capability is absent: no location is published
//! and writes fail with a reason instead of touching a guessed file.

use std::path::Path;

use serde_json::Value;

use crate::adapters::McpLocation;
use crate::native::adapter::Scope;

pub(crate) const UNAVAILABLE_REASON: &str =
    "OMP 原生 MCP（用户/项目 mcp.json、stdio/http/sse、外部来源启停覆盖）尚未交付";
pub(crate) const AVAILABLE_REASON: &str =
    "可管理 OMP 自有 MCP 与外部来源启停覆盖；第三方文件保持只读";

pub(crate) fn supported() -> bool {
    false
}

pub(crate) fn facet() -> crate::adapters::Facet {
    if supported() {
        crate::adapters::Facet {
            state: "available",
            reason: AVAILABLE_REASON,
        }
    } else {
        crate::adapters::Facet {
            state: "planned",
            reason: UNAVAILABLE_REASON,
        }
    }
}

pub(crate) fn location(
    _scope: Scope,
    _home: &Path,
    _project: Option<&Path>,
) -> Option<McpLocation> {
    None
}

pub(crate) fn document(
    _definition: &crate::resources::mcp::McpDefinition,
    _enabled: bool,
    _existing: Option<&Value>,
) -> Result<Option<Value>, String> {
    Err(UNAVAILABLE_REASON.into())
}

pub(crate) fn entry_view(entry: &Value) -> Value {
    entry.clone()
}

pub(crate) fn entries(
    parsed: &Value,
    location: &McpLocation,
) -> Result<serde_json::Map<String, Value>, String> {
    let root = parsed.get(location.root);
    Ok(root
        .and_then(|root| location.child.map_or(Some(root), |child| root.get(child)))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default())
}

pub(crate) fn disabled_description() -> Option<&'static str> {
    None
}

pub(crate) fn supports_cwd() -> bool {
    false
}

pub(crate) fn supports_sse() -> bool {
    false
}

pub(crate) fn remote_layout() -> crate::adapters::RemoteResourceLayout {
    crate::adapters::RemoteResourceLayout::default()
}

pub(crate) fn remote_native_documents() -> &'static [crate::adapters::RemoteNativeDocument] {
    &[]
}
pub(crate) fn verify_case(
    _case: &serde_json::Value,
    _context: &super::verify::CaseContext,
) -> Result<serde_json::Value, super::verify::CaseError> {
    Err(super::verify::CaseError::Unverified(UNAVAILABLE_REASON.into()))
}
