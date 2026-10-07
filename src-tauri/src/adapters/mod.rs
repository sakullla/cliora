//! One backend adapter package. Implementations are assembled here and selected through capability ports.
pub mod accounts;
pub mod agents;
pub(crate) mod antigravity;
pub mod claude;
pub(crate) mod cline;
pub mod codebuddy;
pub mod codex;
pub(crate) mod command_code;
mod contract;
pub mod configuration;
pub(crate) mod deepseek;
pub(crate) mod devin;
pub(crate) mod grok;
pub(crate) mod kimi_code;
pub(crate) mod kiro;
pub mod model_directory;
pub(crate) mod mimo_code;
pub mod official;
pub(crate) mod opencode;
pub(crate) mod pi;
pub mod plugins;
pub mod providers;
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
pub static KIMI_CODE: kimi_code::KimiCode = kimi_code::KimiCode;
pub static DEEPSEEK: deepseek::DeepSeek = deepseek::DeepSeek;
pub static CODEBUDDY: codebuddy::CodeBuddy = codebuddy::CodeBuddy;
pub static MIMO_CODE: mimo_code::MiMoCode = mimo_code::MiMoCode;
pub static CLINE: cline::Cline = cline::Cline;
pub static DEVIN: devin::Devin = devin::Devin;
pub static COMMAND_CODE: command_code::CommandCode = command_code::CommandCode;
pub static ANTIGRAVITY: antigravity::Antigravity = antigravity::Antigravity;
pub static KIRO: kiro::Kiro = kiro::Kiro;
