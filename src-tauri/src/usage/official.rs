//! Official quotas never expose native OAuth material to the JavaScript broker.
use super::*;
use crate::{
    accounts,
    database::Database,
    native::profile::{self, ProfileAuthentication},
};
use serde_json::Value;
use std::sync::atomic::AtomicBool;

fn metadata(tool: &str) -> Option<(&'static str, &'static str, &'static str)> {
    match tool {
        "codex" => Some(("Codex 官方订阅", "https://chatgpt.com", "使用此配置绑定的 Codex 原生账号查询。主/次窗口独立；不推测 token 总量或币种。重新认证后请重新选择账号上下文。")),
        "claude_code" => Some(("Claude 官方订阅（来源受限）", "https://claude.ai", "Claude Code 2.1.287 未核验可用的非交互原生额度接口；auth status 仅核验身份。请在原生交互界面使用 /usage 查看。Cliora 不抓取浏览器 Cookie，也不以推理探测额度。")),
        "grok" => Some(("Grok 官方订阅（来源受限）", "https://grok.com", "Grok 1.0.46 的 usage SESSION_ID 仅返回本地会话 token/成本，不能代表订阅剩余额度；当前没有已核验的非推理订阅查询来源。")),
        _ => None,
    }
}

pub(super) fn presets() -> Vec<UsagePreset> {
    ["codex", "claude_code", "grok"]
        .into_iter()
        .map(|tool| {
            let (label, site, description) = metadata(tool).unwrap();
            UsagePreset {
                id: format!("official-{tool}"),
                label: label.into(),
                description: description.into(),
                config: QueryConfig {
                    schema_version: 1,
                    label: label.into(),
                    site: site.into(),
                    identity: QueryIdentity {
                        account_id: None,
                        context_id: None,
                        profile_id: None,
                        subject: UsageSubject::Plan,
                        subject_id: None,
                    },
                    program: QueryProgram::Official {
                        tool: tool.into(),
                        adapter_version: 1,
                    },
                    parameters: Default::default(),
                    targets: vec![],
                    enabled: true,
                    refresh_interval_seconds: 0,
                },
                credentials: vec![],
            }
        })
        .collect()
}

pub(super) fn validate_config(config: &QueryConfig) -> Result<(), UsageError> {
    let QueryProgram::Official {
        tool,
        adapter_version: 1,
    } = &config.program
    else {
        return Err(UsageError::configuration("官方额度适配版本不可用"));
    };
    let (_, site, _) =
        metadata(tool).ok_or_else(|| UsageError::configuration("此 CLI 未提供官方额度适配"))?;
    if config.site != site
        || !config.targets.is_empty()
        || !config.parameters.is_empty()
        || config.identity.subject != UsageSubject::Plan
        || config.identity.subject_id.is_some()
        || (tool != "codex" && config.refresh_interval_seconds != 0)
    {
        return Err(UsageError::configuration(
            "官方查询使用固定原生来源，不接受站点、网络目标或参数覆盖",
        ));
    }
    Ok(())
}

fn auth(message: &str) -> UsageError {
    UsageError::new(
        UsageErrorCode::Authentication,
        UsageStage::Credential,
        message,
    )
}

/// The persisted selection must still belong to this profile and current account.
/// A reauthentication context is never silently substituted into an old query.
pub(super) fn selection(
    db: &Database,
    config: &QueryConfig,
) -> Result<accounts::AuthAccount, UsageError> {
    let id = config
        .identity
        .account_id
        .as_deref()
        .ok_or_else(|| auth("请先为配置绑定 Codex OAuth 账号，再在额度设置选择该账号"))?;
    let context = config
        .identity
        .context_id
        .as_deref()
        .ok_or_else(|| auth("请选择账号的当前原生上下文"))?;
    let account = accounts::get(db, id).map_err(|_| auth("额度绑定账号不存在，请重新绑定"))?;
    if account.tool_id != "codex"
        || account.state != accounts::AccountState::SignedIn
        || account.pending_login.is_some()
        || account.identity.is_none()
        || account.context.as_ref().is_none_or(|ctx| ctx.id != context)
    {
        return Err(auth(
            "额度绑定账号已退出、正在认证或上下文已更换；请重新认证并更新额度设置",
        ));
    }
    if let Some(profile_id) = &config.identity.profile_id {
        let profile = profile::get_registered_profile(db, profile_id)
            .map_err(|_| auth("额度所属配置不存在，请重新配置"))?;
        if profile.tool != "codex"
            || !matches!(profile.authentication, ProfileAuthentication::OAuth { account_id } if account_id == id)
        {
            return Err(auth(
                "此额度账号与配置的 OAuth 绑定不一致，请先修改配置认证方式，再更新额度设置",
            ));
        }
    }
    Ok(account)
}

pub(super) fn query(
    db: &Database,
    config: &QueryConfig,
    cancel: &AtomicBool,
) -> Result<UsageResult, UsageError> {
    validate_config(config)?;
    let QueryProgram::Official { tool, .. } = &config.program else {
        unreachable!()
    };
    if tool != "codex" {
        return Err(UsageError::configuration(metadata(tool).unwrap().2));
    }
    let account = selection(db, config)?;
    let context = account.context.as_ref().unwrap();
    accounts::context::check_path(&context.root).map_err(|_| auth("原生账号目录无法安全读取"))?;
    let home =
        dirs::home_dir().ok_or_else(|| UsageError::configuration("无法定位 CLI 用户目录"))?;
    let executable = accounts::native::executable(db, &home, tool).map_err(|e| {
        UsageError::new(UsageErrorCode::InvalidConfiguration, UsageStage::Launch, &e)
    })?;
    let value = accounts::native::codex_quota(
        &executable,
        context,
        &account.identity.as_ref().unwrap().subject,
        cancel,
    )
    .map_err(|message| {
        let code = if message.contains("取消") {
            UsageErrorCode::Cancelled
        } else if message.contains("认证") || message.contains("身份") || message.contains("登录")
        {
            UsageErrorCode::Authentication
        } else if message.contains("受限") {
            UsageErrorCode::RateLimit
        } else if message.contains("超时") {
            UsageErrorCode::Timeout
        } else {
            UsageErrorCode::Business
        };
        let mut error = UsageError::new(code, UsageStage::Ipc, &message);
        if error.code == UsageErrorCode::RateLimit {
            error.retry_after_seconds = Some(60);
        }
        error
    })?;
    let current = selection(db, config)?;
    if current.version != account.version || current.identity != account.identity {
        return Err(auth("查询期间账号状态已变化，已丢弃结果，请重新刷新"));
    }
    parse_codex(&value)
}

fn metric(id: String, label: String, subject: UsageSubject, unit: UsageUnit) -> UsageMetric {
    UsageMetric {
        id,
        label,
        subject,
        subject_id: None,
        unit,
        used: None,
        remaining: None,
        total: None,
        source_percent: None,
        unlimited: false,
        expires_at: None,
        never_expires: false,
        window: None,
        missing_reason: None,
    }
}
fn number(value: &Value) -> Option<f64> {
    value.as_f64().filter(|v| v.is_finite() && *v >= 0.)
}
fn decimal(value: &Value) -> Option<f64> {
    value
        .as_str()?
        .parse::<f64>()
        .ok()
        .filter(|v| v.is_finite() && *v >= 0.)
}
fn timestamp(value: &Value) -> Option<String> {
    let seconds = value.as_i64()?;
    // Explicit seconds, bounded to 2000..2100; milliseconds are not guessed.
    (946684800..=4102444800)
        .contains(&seconds)
        .then(|| chrono::DateTime::from_timestamp(seconds, 0))
        .flatten()
        .map(|v| v.to_rfc3339())
}
fn parse_error() -> UsageError {
    UsageError::new(
        UsageErrorCode::Parse,
        UsageStage::Validation,
        "Codex 额度响应缺少可用数据或与已核验协议不兼容",
    )
}

pub(super) fn parse_codex(value: &Value) -> Result<UsageResult, UsageError> {
    let buckets: Vec<(&str, &Value)> =
        match value.get("rateLimitsByLimitId").filter(|v| !v.is_null()) {
            Some(map) => {
                let map = map.as_object().ok_or_else(parse_error)?;
                if map.is_empty() || map.len() > 32 {
                    return Err(parse_error());
                }
                map.iter()
                    .map(|(key, value)| (key.as_str(), value))
                    .collect()
            }
            None => vec![(
                "codex",
                value
                    .get("rateLimits")
                    .filter(|v| v.is_object())
                    .ok_or_else(parse_error)?,
            )],
        };
    let mut metrics = vec![];
    let mut errors = vec![];
    for (index, (name, bucket)) in buckets.iter().enumerate() {
        if !bucket.is_object()
            || name.is_empty()
            || name.len() > 128
            || name.chars().any(char::is_control)
        {
            return Err(parse_error());
        }
        for (field, title) in [("primary", "主窗口"), ("secondary", "次窗口")] {
            let raw = &bucket[field];
            let mut m = metric(
                format!("bucket{index}.{field}"),
                format!("{name} · {title}"),
                UsageSubject::Plan,
                UsageUnit::Custom {
                    label: "额度比例".into(),
                },
            );
            m.source_percent = number(&raw["usedPercent"]);
            let duration = raw["windowDurationMins"]
                .as_u64()
                .and_then(|n| n.checked_mul(60))
                .and_then(|n| u32::try_from(n).ok())
                .filter(|n| *n > 0);
            let resets = timestamp(&raw["resetsAt"]);
            m.window = Some(UsageWindow {
                duration_seconds: duration,
                resets_at: resets.clone(),
                recovery: RecoveryKind::Unknown,
            });
            if m.source_percent.is_none() {
                m.missing_reason = Some("原生来源未提供此窗口的有效使用比例".into());
            } else if (!raw["resetsAt"].is_null() && resets.is_none())
                || (!raw["windowDurationMins"].is_null() && duration.is_none())
            {
                m.missing_reason = Some("使用比例可用，但窗口时长或重置时间格式不兼容".into());
            }
            metrics.push(m);
        }
        if let Some(raw) = bucket.get("credits").filter(|v| !v.is_null()) {
            let mut m = metric(
                format!("bucket{index}.credits"),
                format!("{name} · 工作区 credits"),
                UsageSubject::Extra,
                UsageUnit::Credits,
            );
            m.unlimited = raw["unlimited"] == true;
            m.remaining = if m.unlimited {
                None
            } else {
                decimal(&raw["balance"])
            };
            if raw["unlimited"].as_bool().is_none()
                || raw["hasCredits"].as_bool().is_none()
                || (!m.unlimited && m.remaining.is_none())
            {
                m.missing_reason =
                    Some("原生来源未提供可用 credits 余额；hasCredits 不代表具体余额".into());
            }
            metrics.push(m);
        }
        if let Some(raw) = bucket.get("individualLimit").filter(|v| !v.is_null()) {
            // Monetary units are not specified by the native schema: never label USD.
            let mut m = metric(
                format!("bucket{index}.individual"),
                format!("{name} · 个人消费限额"),
                UsageSubject::Account,
                UsageUnit::Custom {
                    label: "原生消费单位".into(),
                },
            );
            m.used = decimal(&raw["used"]);
            m.total = decimal(&raw["limit"]);
            m.window = Some(UsageWindow {
                duration_seconds: None,
                resets_at: timestamp(&raw["resetsAt"]),
                recovery: RecoveryKind::Unknown,
            });
            if m.used.is_none()
                || m.total.is_none()
                || m.window.as_ref().unwrap().resets_at.is_none()
            {
                m.missing_reason = Some("个人限额部分字段缺失或格式不兼容".into());
            }
            metrics.push(m);
        }
    }
    if let Some(raw) = value.get("rateLimitResetCredits").filter(|v| !v.is_null()) {
        let mut m = metric(
            "resetCredits".into(),
            "可用额度重置次数".into(),
            UsageSubject::Extra,
            UsageUnit::Custom {
                label: "次".into()
            },
        );
        m.remaining = raw["availableCount"].as_u64().map(|v| v as f64);
        if m.remaining.is_none() {
            m.missing_reason = Some("重置次数格式不兼容".into());
        }
        metrics.push(m);
    }
    if !metrics.iter().any(|m| {
        m.unlimited
            || m.source_percent.is_some()
            || m.used.is_some()
            || m.remaining.is_some()
            || m.total.is_some()
    }) {
        return Err(parse_error());
    }
    // Never infer permission to send inference from quota percentages.
    if value["ordinaryUsageAllowed"] == false {
        errors.push(UsageError::new(
            UsageErrorCode::Permission,
            UsageStage::Validation,
            "原生来源明确禁止普通包含用量；比例和重置时间不代表已恢复使用权限",
        ));
    }
    let partial = !errors.is_empty() || metrics.iter().any(|m| m.missing_reason.is_some());
    let result = UsageResult {
        schema_version: 1,
        status: if partial {
            UsageStatus::Partial
        } else {
            UsageStatus::Success
        },
        metrics,
        errors,
    };
    result.validate()?;
    Ok(result)
}

#[cfg(test)]
#[path = "../../../tests/usage/official.rs"]
mod tests;
