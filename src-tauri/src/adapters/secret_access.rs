//! Recorded real-CLI acceptance for the secret MCP entry.
//!
//! Two different facts gate one target, and they are recorded separately:
//!
//! * the adapter owns a native MCP mapping (the configuration half), and
//! * a live CLI was observed negotiating the protocol, listing the tools and
//!   generating a `use_secret` call from a prompt that held references only.
//!
//! A written native entry is placement, never evidence. Every adapter with a
//! mapping publishes `unverified`; only a complete [`SecretMcpAcceptance`] for the
//! same target lets it publish `supported`. No configuration file, digest or
//! successful write can satisfy this gate, and nothing here reads a CLI id from a
//! shared service: the adapter declares its mapping and the record names the
//! mapping it covered.
//!
//! Live results are produced by `node scripts/verify-secret-access.mjs --live` and
//! summarised in [`EVIDENCE_DOC`]. That script also checks that the document matrix
//! and the records below describe the same target and mapping, so a changed mapping
//! without a new record fails the offline verification.

use super::contract::{
    SecretMcpCapability, SECRET_MCP_UNSUPPORTED_REASON, SECRET_MCP_UNVERIFIED_REASON,
};

/// Where a recorded acceptance is described, per target.
pub const EVIDENCE_DOC: &str = "docs/verification/secret-access.md";

/// One target's real acceptance. Every field is an observed fact, not a default.
#[derive(Clone, Copy, Debug)]
pub struct SecretMcpAcceptance {
    pub tool_id: &'static str,
    /// The native mapping the run covered, as the verification document names it.
    /// A mapping change needs a new record instead of quietly keeping this one.
    pub mapping: &'static str,
    /// The date the live run happened (`YYYY-MM-DD`).
    pub recorded_at: &'static str,
    /// The host that produced the evidence, e.g. `macos-arm64`.
    pub platform: &'static str,
    /// The CLI release the run used. A release is evidence, not a version lock.
    pub cli_version: &'static str,
    /// `initialize` and `tools/list` observed with a real MCP client.
    pub protocol: &'static str,
    /// The tool call the model generated from a prompt holding references only.
    pub model_use: &'static str,
    /// The CLI-fallback command that reached the same executor.
    pub cli_fallback: &'static str,
    /// The anchor that holds the observation under `docs/verification/`.
    pub evidence: &'static str,
}

/// A real calendar date. Shape checks alone accept `2026-13-45`, which would let
/// an unrecorded placeholder publish support.
fn valid_date(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() != 10
        || !bytes.iter().enumerate().all(|(index, byte)| match index {
            4 | 7 => *byte == b'-',
            _ => byte.is_ascii_digit(),
        })
    {
        return false;
    }
    let (Ok(year), Ok(month), Ok(day)) =
        (text[0..4].parse::<u32>(), text[5..7].parse::<u32>(), text[8..10].parse::<u32>())
    else {
        return false;
    };
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (2020..=2100).contains(&year) && (1..=days).contains(&day)
}

impl SecretMcpAcceptance {
    /// A record publishes support only when every fact was observed. A placeholder
    /// date, an unrecorded tool call or a missing evidence anchor keeps the target
    /// unverified, which is why the gate checks completeness instead of trusting an
    /// entry that merely exists.
    fn is_complete(self) -> bool {
        valid_date(self.recorded_at)
            && !self.tool_id.trim().is_empty()
            && !self.mapping.trim().is_empty()
            && !self.platform.trim().is_empty()
            && !self.cli_version.trim().is_empty()
            && !self.protocol.trim().is_empty()
            && !self.model_use.trim().is_empty()
            && !self.cli_fallback.trim().is_empty()
            && self.evidence.starts_with("docs/verification/")
            && self.evidence.contains('#')
    }
}

/// Accepted targets. A target without a record publishes `unverified` and keeps
/// the CLI fallback. Adding a record is the only way to publish `supported`, and
/// the mapping label it names must equal the adapter's own declaration.
pub const ACCEPTANCES: &[SecretMcpAcceptance] = &[SecretMcpAcceptance {
    tool_id: "codex",
    mapping: ".codex/config.toml#mcp_servers",
    recorded_at: "2026-11-21",
    platform: "macos-arm64",
    cli_version: "codex-cli 0.171.0",
    protocol: "initialize + tools/list + tools/call over MCP stdio; four tools listed",
    model_use: "use_secret with the referenced secretId/executorId; result carried the sentinel and [redacted]",
    cli_fallback: "cliora --cliora-internal-secret-cli-v1 --installation <id> use --secret <id> --executor <id>",
    evidence: "docs/verification/secret-access.md#codex-2026-11-21",
}];

/// The capability an adapter publishes. A target without a mapping can never be
/// supported; a mapping without a complete acceptance record for that exact
/// mapping label stops at `unverified` with the mapping-only reason.
pub fn published(
    acceptances: &[SecretMcpAcceptance],
    declares_mapping: bool,
    mapping: Option<&str>,
    tool_id: &str,
) -> SecretMcpCapability {
    if !declares_mapping {
        return SecretMcpCapability::unsupported(SECRET_MCP_UNSUPPORTED_REASON);
    }
    match acceptance(acceptances, tool_id) {
        Some(record) if mapping == Some(record.mapping) && record.is_complete() => {
            SecretMcpCapability::supported()
        }
        _ => SecretMcpCapability::unverified(SECRET_MCP_UNVERIFIED_REASON),
    }
}

fn acceptance<'a>(
    acceptances: &'a [SecretMcpAcceptance],
    tool_id: &str,
) -> Option<&'a SecretMcpAcceptance> {
    acceptances.iter().find(|record| record.tool_id == tool_id)
}
