use super::Grok;
use crate::adapters::official::{OfficialUsageAdapter, OfficialUsageCapability};
impl OfficialUsageAdapter for Grok {
    fn capability(&self) -> OfficialUsageCapability {
        let (label,site,description)=("Grok 官方订阅（来源受限）", "https://grok.com", "2026-10-03 官方文档确认 TUI /usage 可查看 credits 与账单；Grok 1.0.46 的 usage SESSION_ID 仅返回本地会话 token/成本。尚无已核验的非交互订阅查询接口；请在原生 TUI 使用 /usage，Cliora 不以会话成本代替剩余额度。");
        OfficialUsageCapability {
            label,
            site,
            description,
            account_required: false,
            query_available: false,
            automatic_refresh: false,
        }
    }
}
