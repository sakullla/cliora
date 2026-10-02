//! Self-hosted sites retain an explicit origin and a separate credential per query instance.
use super::*;

pub(super) fn is_site(config: &QueryConfig) -> bool {
    matches!(&config.program, QueryProgram::Builtin { provider, .. } if provider == "sub2api" || provider == "newapi")
}

fn settings(config: &QueryConfig) -> Result<(&str, &str), UsageError> {
    let QueryProgram::Builtin {
        provider,
        template_version,
    } = &config.program
    else {
        return Err(UsageError::configuration("需要站点内置查询配置"));
    };
    let mode = config
        .parameters
        .get("mode")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let subject = match mode {
        "key" => UsageSubject::Key,
        "account" | "account-plans" => UsageSubject::Account,
        "plans" => UsageSubject::Plan,
        _ => return Err(UsageError::configuration("请选择账户、套餐或 Key 查询范围")),
    };
    if *template_version != BUILTIN_TEMPLATE_VERSION
        || !is_site(config)
        || config.targets.len() != 1
        || config.site != config.targets[0].origin
        || config.identity.subject != subject
        || config.parameters.keys().any(|key| {
            key != "mode"
                && !(provider == "newapi"
                    && matches!(key.as_str(), "unitsPerCurrency" | "currency" | "userId"))
        })
    {
        return Err(UsageError::configuration(
            "站点、查询版本、参数或统计范围不匹配",
        ));
    }
    if provider == "newapi" {
        match (
            config.parameters.get("unitsPerCurrency"),
            config.parameters.get("currency"),
        ) {
            (None, None) => (),
            (Some(rate), Some(currency))
                if rate.as_f64().is_some_and(|n| n.is_finite() && n > 0.0)
                    && currency.as_str().is_some_and(|s| {
                        s.len() == 3 && s.bytes().all(|c| c.is_ascii_uppercase())
                    }) =>
            {
                ()
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
    }
    Ok((provider, mode))
}

pub(super) fn script(config: &QueryConfig) -> Result<String, UsageError> {
    let (provider, mode) = settings(config)?;
    let site =
        serde_json::to_string(&config.site).map_err(|_| UsageError::configuration("站点无效"))?;
    let mode = serde_json::to_string(mode).map_err(|_| UsageError::configuration("范围无效"))?;
    Ok(format!(
        "const site = {site};\nconst mode = {mode};\n{}\n{}\n{}",
        include_str!("common.js"),
        include_str!("site-common.js"),
        if provider == "sub2api" {
            include_str!("sub2api.js")
        } else {
            include_str!("newapi.js")
        }
    ))
}

pub(super) fn validate_credentials(
    input: &super::super::runtime::HelperInput,
) -> Result<(), UsageError> {
    let (_, mode) = settings(&input.config)?;
    let name = if mode == "key" {
        "api_key"
    } else {
        "user_token"
    };
    if input.secrets.len() != 1
        || input.secrets[0].name != name
        || input.secrets[0].allowed_origins != [input.config.site.clone()]
    {
        return Err(UsageError::configuration(
            "Key 查询需要 api_key；账户/套餐查询需要独立 user_token，且只能绑定本站点",
        ));
    }
    Ok(())
}

pub(super) fn presets() -> Vec<UsagePreset> {
    let mut presets = Vec::new();
    for (provider, title) in [("sub2api", "Sub2API"), ("newapi", "New API")] {
        for (mode, label, subject) in [
            ("key", "Key 可见额度", UsageSubject::Key),
            ("account", "账户余额", UsageSubject::Account),
            ("plans", "订阅套餐", UsageSubject::Plan),
            ("account-plans", "账户余额与多个套餐", UsageSubject::Account),
        ] {
            let site = "https://your-site.example";
            let label = format!("{title} · {label}");
            let key = mode == "key";
            presets.push(UsagePreset {
                id: format!("{provider}-{mode}"), label: label.clone(),
                description: if provider == "sub2api" {
                    "填写独立站点 origin；Key 接口只显示实际可见对象；用户套餐核对 active 与 progress，日周月分开。".into()
                } else {
                    "填写独立站点 origin；默认保留原始 quota 单位。仅在明确站点换算时同时设置 unitsPerCurrency 与 currency；套餐价格不是换算依据。".into()
                },
                config: QueryConfig {
                    schema_version: USAGE_SCHEMA_VERSION, label, site: site.into(),
                    identity: QueryIdentity { account_id: None, context_id: None, profile_id: None, subject, subject_id: None },
                    program: QueryProgram::Builtin { provider: provider.into(), template_version: BUILTIN_TEMPLATE_VERSION },
                    parameters: std::collections::BTreeMap::from([("mode".into(), mode.into())]),
                    targets: vec![QueryTarget { origin: site.into(), allow_private_network: false }],
                    enabled: true, refresh_interval_seconds: 0,
                },
                credentials: vec![PresetCredential {
                    name: if key { "api_key" } else { "user_token" }.into(),
                    label: if key { "模型 API Key" } else { "用户查询令牌" }.into(),
                    instructions: if key { "只查询此 Key 实际可见的范围，不能代替面板用户凭据。" }
                        else if provider == "sub2api" { "填写本站点用户 access JWT；不自动刷新，不读取浏览器 cookie。" }
                        else { "填写具有对应读取权限的本站点用户 PAT/面板访问令牌；模型 API Key 不适用。旧站点可设置普通参数 userId。" }.into(),
                    allowed_origins: vec![site.into()],
                }],
            });
        }
    }
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

#[cfg(test)]
#[path = "../../../../tests/usage/sites.rs"]
mod tests;
