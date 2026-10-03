use super::Codex;
use crate::adapters::official::{OfficialUsageAdapter, OfficialUsageCapability};
use crate::{
    accounts::{AccountIdentity, NativeContext},
    usage::*,
};
use serde_json::Value;
use std::{path::Path, sync::atomic::AtomicBool};
impl OfficialUsageAdapter for Codex {
    fn capability(&self) -> OfficialUsageCapability {
        let (label,site,description)=("Codex 官方订阅", "https://chatgpt.com", "使用此配置绑定的 Codex 原生账号查询。主/次窗口独立；不推测 token 总量或币种。重新认证后请重新选择账号上下文。");
        OfficialUsageCapability {
            label,
            site,
            description,
            account_required: true,
            query_available: true,
            automatic_refresh: true,
        }
    }
    fn query(
        &self,
        executable: &Path,
        context: &NativeContext,
        identity: &AccountIdentity,
        cancel: &AtomicBool,
    ) -> Result<UsageResult, UsageError> {
        let value = crate::adapters::codex::accounts::codex_quota(
            executable,
            context,
            &identity.subject,
            cancel,
        )
        .map_err(|message| {
            let code = if message.contains("取消") {
                UsageErrorCode::Cancelled
            } else if message.contains("认证")
                || message.contains("身份")
                || message.contains("登录")
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
        parse_codex(&value)
    }
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

pub(crate) fn parse_codex(value: &Value) -> Result<UsageResult, UsageError> {
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
