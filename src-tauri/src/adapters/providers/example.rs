use super::*;
pub(super) fn presets() -> Vec<UsagePreset> {
    let mut presets = vec![];
    let site = "https://your-site.example";
    presets.push(UsagePreset {
        id: "javascript-multiple-plans".into(), label: "JavaScript · 余额与多套餐示例".into(),
        description: "独立脚本副本：按服务文档修改 /balance 与 /plans 及字段映射，两个请求分开处理；需显式配置站点和凭据目标。".into(),
        config: QueryConfig {
            schema_version: 1, label: "自定义余额与套餐".into(), site: site.into(),
            identity: QueryIdentity { account_id: None, context_id: None, profile_id: None, subject: UsageSubject::Account, subject_id: None },
            program: QueryProgram::JavaScript { source: include_str!("example.js").into() },
            parameters: std::collections::BTreeMap::from([("site".into(), site.into())]),
            targets: vec![QueryTarget { origin: site.into(), allow_private_network: false }], enabled: true, refresh_interval_seconds: 0,
        },
        credentials: vec![PresetCredential { name: "user_token".into(), label: "查询令牌".into(), instructions: "普通参数只放非敏感值；秘密绑定 user_token。".into(), allowed_origins: vec![site.into()] }],
    });
    presets
}
