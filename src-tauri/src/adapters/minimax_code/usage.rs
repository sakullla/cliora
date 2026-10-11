//! Token Plan has no verified non-interactive quota query that avoids login
//! tokens. The description points at the CLI and never returns a zero balance.
use super::MiniMaxCode;
use crate::adapters::official::{OfficialUsageAdapter, OfficialUsageCapability};

impl OfficialUsageAdapter for MiniMaxCode {
    fn capability(&self) -> OfficialUsageCapability {
        OfficialUsageCapability {
            label: "MiniMax Code Token Plan",
            site: "https://agent.minimax.io",
            description: "Token Plan 没有已核对的、不接触登录令牌的非交互额度查询。详细用量留在 CLI，这里不显示 0，也不改用 API Key 查询。",
            account_required: false,
            query_available: false,
            automatic_refresh: false,
        }
    }
}
