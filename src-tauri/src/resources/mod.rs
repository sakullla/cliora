pub mod mcp;
pub mod plugins;
pub mod plugin_contents;
pub mod rules;
pub mod skills;
pub mod skill_manifest;
pub mod agents;
pub mod memory;

use crate::adapters::{Registry, RemoteOperation, RemoteOperationResult};
use crate::remote::RemoteTarget;

/// Registry-driven remote resource consumer. Unsupported resource protocols
/// are surfaced before transport launch by the selected adapter.
pub fn remote_resources(
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
        &RemoteOperation::Resources {
            args: args.to_vec(),
        },
    )
}
