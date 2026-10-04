//! One backend adapter package. Implementations are assembled here and selected through capability ports.
pub mod accounts;
pub mod agents;
pub mod claude;
pub mod codebuddy;
pub mod codex;
mod contract;
pub(crate) mod deepseek;
pub(crate) mod grok;
pub(crate) mod kimi_code;
pub mod model_directory;
pub mod official;
pub(crate) mod opencode;
pub(crate) mod pi;
pub mod plugins;
pub mod providers;
pub(crate) mod qoder;
pub(crate) mod qoder_cn;
mod registry;
pub mod version;
pub(crate) mod zcode;
pub use contract::*;
pub use registry::Registry;
// Compatibility facade: shared IO implementation remains in the native service.
pub use crate::native::registered::*;
pub static CODEX: codex::Codex = codex::Codex;
pub static CLAUDE: claude::Claude = claude::Claude;
pub static GROK: grok::Grok = grok::Grok;
pub static PI: pi::Pi = pi::Pi;
pub static OPENCODE: opencode::OpenCode = opencode::OpenCode;
// Default-off additions registered with non-enumerated stable ids; honest
// stubs until the dedicated adapter tasks deliver verified capabilities.
pub static ZCODE: zcode::ZCode = zcode::ZCode;
pub static QODER: qoder::Qoder = qoder::Qoder;
pub static KIMI_CODE: kimi_code::KimiCode = kimi_code::KimiCode;
pub static DEEPSEEK: deepseek::DeepSeek = deepseek::DeepSeek;
pub static CODEBUDDY: codebuddy::CodeBuddy = codebuddy::CodeBuddy;
