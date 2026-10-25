//! Remote quota queries are independent of local history token estimates.
mod contract;
mod store;
pub(crate) mod runtime;
mod helper;
mod providers;
mod presets;
mod scheduler;
mod official;
mod profile;
pub use profile::ensure_profile_query;
pub use scheduler::{UsageCache, UsageSample, list_cache, list_samples, refresh_query, cancel_refresh, scheduler_tick};
pub use providers::{builtin_script, usage_presets};
pub use presets::{PresetCredential, UsagePreset};
pub use helper::{helper_entry, create_test_execution, cancel_test_execution, test_draft, DraftTestReport};
pub use runtime::RuntimeReport;

pub use contract::*;
pub use store::{delete_query, get_query, list_queries, save_query};

use crate::adapters::{Registry, RemoteOperation, RemoteOperationResult};
use crate::remote::RemoteTarget;

/// Registry-driven remote quota consumer. No local quota provider is inferred
/// as a remote protocol; an adapter must explicitly declare its remote port.
pub fn remote_usage(
    registry: &Registry,
    adapter_id: &str,
    target: &RemoteTarget,
    args: &[String],
) -> Result<RemoteOperationResult, String> {
    let adapter = registry
        .get(adapter_id)
        .ok_or_else(|| format!("未知 CLI 适配器：{adapter_id}"))?;
    adapter.remote_operation(
        target,
        &RemoteOperation::Usage {
            args: args.to_vec(),
        },
    )
}

#[cfg(test)]
#[path = "../../../tests/usage/queries.rs"]
mod tests;
