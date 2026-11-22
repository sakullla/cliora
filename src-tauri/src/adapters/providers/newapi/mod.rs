use super::{site::SiteProvider, QueryConfig, UsageError};
pub(super) static ADAPTER: SiteProvider = SiteProvider { id:"newapi",title:"New API",description:"填写独立站点 origin；Key 可读取自身额度，站点允许时同时显示该 Key 可见的账户钱包。仅当站点明确换算时同时设置 unitsPerCurrency 与 currency。",user_instructions:"填写具有 profile:read 与 wallet:read 权限的本站点用户 PAT；模型 API Key 只能用于 Key 查询。旧站点可设置普通参数 userId。",source:include_str!("query.js"),extra_parameters:&["unitsPerCurrency","currency","userId"],validate_parameters:validate };
fn validate(config: &QueryConfig) -> Result<(), UsageError> {
    match (
        config.parameters.get("unitsPerCurrency"),
        config.parameters.get("currency"),
    ) {
        (None, None) => (),
        (Some(rate), Some(currency))
            if rate.as_f64().is_some_and(|n| n.is_finite() && n > 0.0)
                && currency
                    .as_str()
                    .is_some_and(|s| s.len() == 3 && s.bytes().all(|c| c.is_ascii_uppercase())) => {
        }
        _ => {
            return Err(UsageError::configuration(
                "货币换算必须同时提供明确的正数单位除数与三字母币种；否则保留原始额度单位",
            ))
        }
    }
    if config.parameters.get("userId").is_some_and(|v| {
        !v.as_u64()
            .is_some_and(|n| n > 0 && n <= 9_007_199_254_740_991)
    }) {
        return Err(UsageError::configuration("兼容站点用户 ID 必须为正整数"));
    }
    Ok(())
}
