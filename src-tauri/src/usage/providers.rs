//! Shared catalog entry points; supplier implementations live in adapters/providers.
use super::*;
pub use crate::adapters::providers::builtin_script;
pub(crate) use crate::adapters::providers::validate_builtin_credentials;
pub fn usage_presets() -> Vec<UsagePreset> {
    let mut presets = crate::adapters::providers::presets();
    presets.extend(super::official::presets());
    presets
}
#[cfg(test)]
#[path = "../../../tests/usage/sites.rs"]
mod site_tests;
#[cfg(test)]
#[path = "../../../tests/usage/providers.rs"]
mod tests;

#[cfg(test)]
#[path = "../../../tests/usage/provider-extension.rs"]
mod extension_tests;
