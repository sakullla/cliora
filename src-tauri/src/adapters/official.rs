//! Native quota capability; caller verifies account/profile/context before and after querying.
use crate::{
    accounts::{AccountIdentity, NativeContext},
    usage::{UsageError, UsageResult},
};
use std::{path::Path, sync::atomic::AtomicBool};
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficialUsageCapability {
    pub label: &'static str,
    pub site: &'static str,
    pub description: &'static str,
    pub account_required: bool,
    pub query_available: bool,
    pub automatic_refresh: bool,
}
pub trait OfficialUsageAdapter: Sync {
    fn capability(&self) -> OfficialUsageCapability;
    fn query(
        &self,
        _executable: &Path,
        _context: &NativeContext,
        _identity: &AccountIdentity,
        _cancel: &AtomicBool,
    ) -> Result<UsageResult, UsageError> {
        Err(UsageError::configuration(self.capability().description))
    }
}
pub fn get(tool: &str) -> Result<&'static dyn OfficialUsageAdapter, UsageError> {
    super::Registry::builtins()
        .get(tool)
        .and_then(|a| a.official_usage())
        .ok_or_else(|| UsageError::configuration("此 CLI 未提供官方额度适配"))
}
