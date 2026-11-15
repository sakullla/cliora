//! OMP session v3 history: 256-byte title slot, tree entries, message usage and
//! `--resume` identity.
//!
//! Delivered by the history task. Until the fixed-width title slot and v3 entry
//! semantics are parsed, no source is published and the records page keeps an
//! explicit unavailable state instead of substituting Pi's session format.

use std::path::Path;

use crate::history::{HistorySource, ParsedSession};

pub(crate) const UNAVAILABLE_REASON: &str =
    "OMP session v3（256 字节标题槽、树形条目、model_usage）尚未交付；不读取 Pi 格式代替";

pub(crate) fn supported() -> bool {
    false
}

pub(crate) fn sources(_home: &Path) -> Result<Vec<HistorySource>, String> {
    Ok(Vec::new())
}

pub(crate) fn parse(_source: &HistorySource) -> Result<ParsedSession, String> {
    Err(UNAVAILABLE_REASON.into())
}
pub(crate) fn verify_case(
    _case: &serde_json::Value,
    _context: &super::verify::CaseContext,
) -> Result<serde_json::Value, super::verify::CaseError> {
    Err(super::verify::CaseError::Unverified(UNAVAILABLE_REASON.into()))
}
