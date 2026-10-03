//! Official quotas never expose native OAuth material to the JavaScript broker.
use super::*;
use crate::{
    accounts,
    database::Database,
    native::profile::{self, ProfileAuthentication},
};
use std::sync::atomic::AtomicBool;

fn metadata(tool: &str) -> Option<crate::adapters::official::OfficialUsageCapability> {
    crate::adapters::official::get(tool)
        .ok()
        .map(|a| a.capability())
}

pub(super) fn presets() -> Vec<UsagePreset> {
    crate::adapters::Registry::builtins()
        .iter()
        .filter(|a| a.official_usage().is_some())
        .map(|a| a.id())
        .map(|tool| {
            let info = metadata(tool).unwrap();
            let (label, site, description) = (info.label, info.site, info.description);
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
    let info =
        metadata(tool).ok_or_else(|| UsageError::configuration("此 CLI 未提供官方额度适配"))?;
    let site = info.site;
    if config.site != site
        || !config.targets.is_empty()
        || !config.parameters.is_empty()
        || config.identity.subject != UsageSubject::Plan
        || config.identity.subject_id.is_some()
        || (!info.automatic_refresh && config.refresh_interval_seconds != 0)
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
    let QueryProgram::Official { tool, .. } = &config.program else {
        return Err(UsageError::configuration("需要官方额度配置"));
    };
    let id = config
        .identity
        .account_id
        .as_deref()
        .ok_or_else(|| auth("请先为配置绑定对应 CLI 的 OAuth 账号，再在额度设置选择该账号"))?;
    let context = config
        .identity
        .context_id
        .as_deref()
        .ok_or_else(|| auth("请选择账号的当前原生上下文"))?;
    let account = accounts::get(db, id).map_err(|_| auth("额度绑定账号不存在，请重新绑定"))?;
    if account.tool_id != *tool
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
        if profile.tool != *tool
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
    let adapter = crate::adapters::official::get(tool)?;
    let info = adapter.capability();
    if !info.query_available {
        return Err(UsageError::configuration(info.description));
    }
    let account = selection(db, config)?;
    let context = account.context.as_ref().unwrap();
    accounts::context::check_path(&context.root).map_err(|_| auth("原生账号目录无法安全读取"))?;
    let home =
        dirs::home_dir().ok_or_else(|| UsageError::configuration("无法定位 CLI 用户目录"))?;
    let executable = accounts::native::executable(db, &home, tool).map_err(|e| {
        UsageError::new(UsageErrorCode::InvalidConfiguration, UsageStage::Launch, &e)
    })?;
    let result = adapter.query(
        &executable,
        context,
        account.identity.as_ref().unwrap(),
        cancel,
    )?;
    let current = selection(db, config)?;
    if current.version != account.version || current.identity != account.identity {
        return Err(auth("查询期间账号状态已变化，已丢弃结果，请重新刷新"));
    }
    Ok(result)
}

#[cfg(test)]
use crate::adapters::codex::usage::parse_codex;
#[cfg(test)]
#[path = "../../../tests/usage/official.rs"]
mod tests;
