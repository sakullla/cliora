use super::{site::SiteProvider, QueryConfig, UsageError};
pub(super) static ADAPTER: SiteProvider = SiteProvider { id:"sub2api",title:"Sub2API",description:"填写独立站点 origin；Key 接口只显示实际可见对象；用户套餐核对 active 与 progress，日周月分开。",user_instructions:"填写本站点用户 access JWT；不自动刷新，不读取浏览器 cookie。",source:include_str!("query.js"),extra_parameters:&[],validate_parameters:validate };
fn validate(_config: &QueryConfig) -> Result<(), UsageError> {
    Ok(())
}
