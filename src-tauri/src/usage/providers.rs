//! Versioned, bundled provider programs. Credentials use the same HTTP broker as user scripts.
use super::*;
use serde::Serialize;

pub const BUILTIN_TEMPLATE_VERSION: u32 = 1;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetCredential {
    pub name: String,
    pub label: String,
    pub instructions: String,
    pub allowed_origins: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsagePreset {
    pub id: String,
    pub label: String,
    pub description: String,
    pub config: QueryConfig,
    pub credentials: Vec<PresetCredential>,
}

struct Route {
    origin: &'static str,
    path: &'static str,
    script: &'static str,
}

fn route(config: &QueryConfig) -> Result<Route, UsageError> {
    let QueryProgram::Builtin {
        provider,
        template_version,
    } = &config.program
    else {
        return Err(UsageError::configuration("需要内置查询配置"));
    };
    if *template_version != BUILTIN_TEMPLATE_VERSION {
        return Err(UsageError::configuration(
            "此内置查询版本不可用，请选择受支持的预设",
        ));
    }
    let region = config
        .parameters
        .get("region")
        .and_then(serde_json::Value::as_str);
    let (origin, path, script) = match (provider.as_str(), region) {
        ("glm", Some(region @ ("cn" | "global"))) => (
            if region == "cn" {
                "https://open.bigmodel.cn"
            } else {
                "https://api.z.ai"
            },
            "/api/monitor/usage/quota/limit",
            include_str!("providers/glm.js"),
        ),
        ("kimi", Some(region @ ("cn" | "global"))) => (
            if region == "cn" {
                "https://api.kimi.com"
            } else {
                "https://api.kimi.ai"
            },
            "/coding/v1/usages",
            include_str!("providers/kimi.js"),
        ),
        ("minimax", Some(region @ ("cn" | "global"))) => (
            if region == "cn" {
                "https://api.minimaxi.com"
            } else {
                "https://api.minimax.io"
            },
            match config
                .parameters
                .get("apiVersion")
                .and_then(serde_json::Value::as_str)
            {
                Some("token-plan") => "/v1/token_plan/remains",
                Some("coding-plan") => "/v1/api/openplatform/coding_plan/remains",
                _ => {
                    return Err(UsageError::configuration(
                        "请选择 MiniMax Token/M Plan 或旧 Coding Plan 接口",
                    ))
                }
            },
            include_str!("providers/minimax.js"),
        ),
        _ => return Err(UsageError::configuration("内置供应商或区域不可用")),
    };
    // A regional preset never forwards a credential to an override, including another official region.
    if config.targets.len() != 1
        || config.targets[0].origin != origin
        || config.targets[0].allow_private_network
        || config.site != origin
        || config.identity.subject != UsageSubject::Plan
        || config
            .parameters
            .keys()
            .any(|key| key != "region" && !(provider == "minimax" && key == "apiVersion"))
    {
        return Err(UsageError::configuration(
            "内置预设的站点、区域、统计对象或参数不匹配",
        ));
    }
    Ok(Route {
        origin,
        path,
        script,
    })
}

/// Returns an independent source copy; saving it as JavaScript freezes this template version.
pub fn builtin_script(config: &QueryConfig) -> Result<String, UsageError> {
    config.validate()?;
    let route = route(config)?;
    let endpoint = serde_json::to_string(&format!("{}{}", route.origin, route.path))
        .map_err(|_| UsageError::configuration("内置查询地址无效"))?;
    Ok(format!(
        "const endpoint = {endpoint};\n{}\n{}",
        include_str!("providers/common.js"),
        route.script
    ))
}

pub(super) fn validate_builtin_credentials(
    input: &super::runtime::HelperInput,
) -> Result<(), UsageError> {
    let route = route(&input.config)?;
    if input.secrets.len() != 1
        || input.secrets[0].name != "api_key"
        || input.secrets[0].allowed_origins != [route.origin]
    {
        return Err(UsageError::configuration(
            "内置查询需要仅绑定当前区域的 api_key 凭据",
        ));
    }
    Ok(())
}

/// Pure catalog: listing presets performs no network or credential-store access.
pub fn usage_presets() -> Vec<UsagePreset> {
    let mut presets = Vec::new();
    for (provider, title, instruction, description) in [
        (
            "glm",
            "GLM Coding Plan",
            "填写所选区域的 Coding Plan API Key；不使用按量余额代替套餐。",
            "套餐窗口与 MCP 分开；5 小时额度按动态恢复解释。",
        ),
        (
            "kimi",
            "Kimi For Coding",
            "填写所选区域 Kimi Code 控制台创建的 API Key；Moonshot API Key 不适用。",
            "兼容旧请求计数与新比例额度池；月总量独立展示，不读取或刷新 CLI 登录。",
        ),
        (
            "minimax",
            "MiniMax",
            "填写订阅套餐 Key（例如 sk-cp-*），普通按量 API Key 不适用。",
            "Token/M Plan 与旧 Coding Plan 接口分别选择；不同区域不自动重试。",
        ),
    ] {
        for region in ["cn", "global"] {
            let versions: &[&str] = if provider == "minimax" {
                &["token-plan", "coding-plan"]
            } else {
                &[""]
            };
            for version in versions {
                let origin = match (provider, region) {
                    ("glm", "cn") => "https://open.bigmodel.cn",
                    ("glm", _) => "https://api.z.ai",
                    ("kimi", "cn") => "https://api.kimi.com",
                    ("kimi", _) => "https://api.kimi.ai",
                    ("minimax", "cn") => "https://api.minimaxi.com",
                    _ => "https://api.minimax.io",
                };
                let region_label = if region == "cn" {
                    "中国大陆"
                } else {
                    "国际"
                };
                let version_label = match *version {
                    "token-plan" => " Token/M Plan",
                    "coding-plan" => " Coding Plan（旧接口）",
                    _ => "",
                };
                let label = format!("{title}{version_label} · {region_label}");
                let mut parameters =
                    std::collections::BTreeMap::from([("region".into(), region.into())]);
                if !version.is_empty() {
                    parameters.insert("apiVersion".into(), (*version).into());
                }
                presets.push(UsagePreset {
                    id: format!(
                        "{provider}-{region}{}",
                        if version.is_empty() {
                            String::new()
                        } else {
                            format!("-{version}")
                        }
                    ),
                    label: label.clone(),
                    description: description.into(),
                    config: QueryConfig {
                        schema_version: USAGE_SCHEMA_VERSION,
                        label,
                        site: origin.into(),
                        identity: QueryIdentity {
                            account_id: None,
                            context_id: None,
                            profile_id: None,
                            subject: UsageSubject::Plan,
                            subject_id: None,
                        },
                        program: QueryProgram::Builtin {
                            provider: provider.into(),
                            template_version: BUILTIN_TEMPLATE_VERSION,
                        },
                        parameters,
                        targets: vec![QueryTarget {
                            origin: origin.into(),
                            allow_private_network: false,
                        }],
                        enabled: true,
                        refresh_interval_seconds: 0,
                    },
                    credentials: vec![PresetCredential {
                        name: "api_key".into(),
                        label: "套餐查询 API Key".into(),
                        instructions: instruction.into(),
                        allowed_origins: vec![origin.into()],
                    }],
                });
            }
        }
    }
    presets
}

#[cfg(test)]
#[path = "../../../tests/usage/providers.rs"]
mod tests;
