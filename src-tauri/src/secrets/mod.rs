//! Local prompt secrets. A prompt body keeps only `{{cliora-secret:<uuid>}}`
//! references; the value lives behind the existing native `CredentialStore`
//! boundary and never enters SQLite, search previews, copies or hand-offs.
//!
//! The broker resolves a reference only for a registered installation and an
//! explicit grant, runs a fixed executor without a shell, asks for a fresh
//! approval on every value read, masks the value out of returned text and audits
//! each decision. The MCP stdio helper and the CLI helper reach the same broker
//! over the per-user local IPC address and never open the database themselves.
pub mod approval;
pub mod audit;
pub mod broker;
pub mod cli;
pub mod executor;
pub mod ipc;
pub mod mcp;
pub mod reference;
pub mod store;

pub use reference::{format as format_reference, references as parse_references};
pub use store::{create, delete, list, rename, resolve, update_value, PromptSecret, PromptSecretReference, SecretStatus};
