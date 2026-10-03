use super::Claude;
use crate::adapters::official::{OfficialUsageAdapter, OfficialUsageCapability};
impl OfficialUsageAdapter for Claude {
    fn capability(&self) -> OfficialUsageCapability {
        let (label,site,description)=("Claude 官方订阅（来源受限）", "https://claude.ai", "Claude Code 2.1.287 未核验可用的非交互原生额度接口；auth status 仅核验身份。请在原生交互界面使用 /usage 查看。Cliora 不抓取浏览器 Cookie，也不以推理探测额度。");
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
