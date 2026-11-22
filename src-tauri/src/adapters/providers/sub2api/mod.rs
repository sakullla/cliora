use super::{site::SiteProvider, QueryConfig, UsageError};
pub(super) static ADAPTER: SiteProvider = SiteProvider { id:"sub2api",title:"Sub2API",description:"填写独立站点 origin；Key 接口只显示实际可见对象；用户套餐核对 active 与 progress，日周月分开。",user_instructions:"从站点 localStorage 的 auth_token 填写用户 access JWT；有效期通常 24 小时，Cliora 不自动刷新。长期查询请改用 Key 预设读取 /v1/usage。",source:include_str!("query.js"),extra_parameters:&[],validate_parameters:validate };
fn validate(_config: &QueryConfig) -> Result<(), UsageError> {
    Ok(())
}
