use super::regional::RegionalProvider;
pub(super) static ADAPTER: RegionalProvider = RegionalProvider {
    id: "kimi",
    title: "Kimi For Coding",
    instruction: "填写所选区域 Kimi Code 控制台创建的 API Key；Moonshot API Key 不适用。",
    description: "兼容旧请求计数与新比例额度池；月总量独立展示，不读取或刷新 CLI 登录。",
    origins: ["https://api.kimi.com", "https://api.kimi.ai"],
    endpoints: &[("", "/coding/v1/usages")],
    source: include_str!("query.js"),
    connection_paths: &["/coding"],
};
