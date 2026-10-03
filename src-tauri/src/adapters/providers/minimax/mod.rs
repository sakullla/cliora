use super::regional::RegionalProvider;
pub(super) static ADAPTER: RegionalProvider = RegionalProvider {
    id: "minimax",
    title: "MiniMax",
    instruction: "填写订阅套餐 Key（例如 sk-cp-*），普通按量 API Key 不适用。",
    description: "Token/M Plan 与旧 Coding Plan 接口分别选择；不同区域不自动重试。",
    origins: ["https://api.minimaxi.com", "https://api.minimax.io"],
    endpoints: &[
        ("token-plan", "/v1/token_plan/remains"),
        ("coding-plan", "/v1/api/openplatform/coding_plan/remains"),
    ],
    source: include_str!("query.js"),
    connection_paths: &["/anthropic"],
};
