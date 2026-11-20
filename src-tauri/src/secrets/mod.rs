//! Local prompt secrets. A prompt body keeps only `{{cliora-secret:<uuid>}}`
//! references; the value lives behind the existing native `CredentialStore`
//! boundary and never enters SQLite, search previews, copies or hand-offs.
pub mod reference;
pub mod store;

pub use reference::{format as format_reference, references as parse_references};
pub use store::{create, delete, list, rename, resolve, update_value, PromptSecret, PromptSecretReference, SecretStatus};