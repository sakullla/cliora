//! One backend adapter package. Implementations are assembled here and selected through capability ports.
pub mod accounts;
pub mod agents;
pub mod claude;
pub mod codex;
mod contract;
pub(crate) mod grok;
pub mod model_directory;
pub mod official;
pub(crate) mod opencode;
pub(crate) mod pi;
pub mod plugins;
pub mod providers;
mod registry;
pub mod version;
pub use contract::*;
pub use registry::Registry;
// Compatibility facade: shared IO implementation remains in the native service.
pub use crate::native::registered::*;
pub static CODEX: codex::Codex = codex::Codex;
pub static CLAUDE: claude::Claude = claude::Claude;
pub static GROK: grok::Grok = grok::Grok;
pub static PI: pi::Pi = pi::Pi;
pub static OPENCODE: opencode::OpenCode = opencode::OpenCode;
