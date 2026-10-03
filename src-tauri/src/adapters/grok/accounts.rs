use super::Grok;
use crate::accounts::AccountCapability;
use crate::adapters::accounts::AccountAdapter;

impl AccountAdapter for Grok {
    fn remove_environment(&self) -> &'static [&'static str] {
        &["XAI_API_KEY", "GROK_HOME", "GROK_XAI_API_BASE_URL"]
    }
    fn capability(&self) -> AccountCapability {
        let (provider, version, supported, reason, identity) = ("xai", "1.0.46", false,
            "2026-10-03 核对官方 Grok Build 文档及 1.0.46 帮助：GROK_HOME 包含配置、认证和会话；支持 login --oauth / --device-auth 与 logout。尚未提供可核验账号身份的非交互接口，也未验收系统凭据隔离，因此暂不开放受管多账号。TUI /usage 可查看 credits 与账单；grok usage 仅为会话 token/费用。", "未核验");
        AccountCapability {
            browser_link: false,
            tool_id: "grok",
            provider,
            version,
            managed_login: supported,
            import_native: false,
            methods: if !supported { vec![] } else { vec!["browser"] },
            reason,
            identity_source: identity,
            refresh_owner: "native_cli",
            acceptance: "源码/协议与隔离合成回归；真实授权账号及跨平台尚未验收",
        }
    }
}
