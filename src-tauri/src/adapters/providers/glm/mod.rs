use super::regional::RegionalProvider;
mod model_directory;
pub(super) fn model_directory_adapter(
) -> &'static dyn crate::adapters::model_directory::ModelDirectoryAdapter {
    &model_directory::MODEL_DIRECTORY
}
pub(super) static ADAPTER: RegionalProvider = RegionalProvider {
    id: "glm",
    title: "GLM Coding Plan",
    instruction: "填写所选区域的 Coding Plan API Key；不使用按量余额代替套餐。",
    description: "套餐窗口与 MCP 分开；5 小时额度按动态恢复解释。",
    origins: ["https://open.bigmodel.cn", "https://api.z.ai"],
    endpoints: &[("", "/api/monitor/usage/quota/limit")],
    source: include_str!("query.js"),
    connection_paths: &["/api/anthropic", "/api/coding/paas/v4"],
};
