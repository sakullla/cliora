//! Profile-linked supplier queries reuse the saved key without copying or owning it.
use super::*;
use crate::{
    adapters::providers::ProviderRegistry,
    credentials::CredentialStore,
    database::Database,
    native::profile::{get_registered_profile, ProfileAuthentication, RegisteredProfile},
};
use std::sync::Mutex;

static ENSURE_LOCK: Mutex<()> = Mutex::new(());

fn preset(profile: &RegisteredProfile) -> Option<UsagePreset> {
    if matches!(
        profile.authentication,
        ProfileAuthentication::OAuth { .. } | ProfileAuthentication::RebindRequired
    ) {
        return None;
    }
    ProviderRegistry::builtins().profile_preset(profile.connection.as_ref()?)
}

fn linked_config(profile: &RegisteredProfile, preset: UsagePreset) -> QueryConfig {
    let mut config = preset.config;
    let QueryProgram::Builtin {
        provider,
        template_version,
    } = config.program
    else {
        unreachable!()
    };
    config.program = QueryProgram::ProfileBuiltin {
        provider,
        template_version,
        profile_version: profile.version,
    };
    config.identity.profile_id = Some(profile.id.clone());
    config
}

pub(super) fn selection(
    db: &Database,
    config: &QueryConfig,
) -> Result<RegisteredProfile, UsageError> {
    let id = config
        .identity
        .profile_id
        .as_deref()
        .ok_or_else(|| UsageError::configuration("套餐查询缺少关联配置"))?;
    let profile = get_registered_profile(db, id)
        .map_err(|_| UsageError::configuration("关联配置已不存在，请重新读取"))?;
    let selected = preset(&profile)
        .ok_or_else(|| UsageError::configuration("关联配置已不再使用可识别的官方套餐地址"))?;
    let mut expected = linked_config(&profile, selected);
    expected.label = config.label.clone();
    expected.enabled = config.enabled;
    expected.refresh_interval_seconds = config.refresh_interval_seconds;
    if expected != *config {
        return Err(UsageError::new(
            UsageErrorCode::VersionConflict,
            UsageStage::Configuration,
            "关联配置或查询目标已改变，请重新读取套餐额度",
        ));
    }
    Ok(profile)
}

pub(super) fn resolve(
    db: &Database,
    credentials: &dyn CredentialStore,
    config: &QueryConfig,
) -> Result<runtime::HelperInput, UsageError> {
    let profile = selection(db, config)?;
    let secret_ref = profile
        .connection
        .as_ref()
        .and_then(|connection| connection.secret_ref.as_deref())
        .ok_or_else(|| {
            UsageError::new(
                UsageErrorCode::Credential,
                UsageStage::Credential,
                "此官方配置没有已保存的 API Key，请先修改配置并保存凭据",
            )
        })?;
    let value = credentials.get(secret_ref).map_err(|_| {
        UsageError::new(
            UsageErrorCode::Credential,
            UsageStage::Credential,
            "无法读取此配置的系统凭据，请重新保存 API Key",
        )
    })?;
    if value.is_empty() || value.len() > 16_384 {
        return Err(UsageError::configuration("配置凭据格式无效"));
    }
    let QueryProgram::ProfileBuiltin {
        provider,
        template_version,
        ..
    } = &config.program
    else {
        return Err(UsageError::configuration("需要配置关联的套餐查询"));
    };
    let mut resolved = config.clone();
    resolved.program = QueryProgram::Builtin {
        provider: provider.clone(),
        template_version: *template_version,
    };
    Ok(runtime::HelperInput {
        config: resolved,
        secrets: vec![runtime::BoundSecret {
            name: "api_key".into(),
            allowed_origins: vec![config.site.clone()],
            value,
        }],
    })
}

/// No network or credential reads. Existing user queries take precedence.
pub fn ensure_profile_query(
    db: &Database,
    credentials: &dyn CredentialStore,
    id: &str,
    expected_profile_version: u64,
) -> Result<Option<UsageQuery>, UsageError> {
    let _guard = ENSURE_LOCK.lock().map_err(|_| UsageError::storage())?;
    let profile =
        get_registered_profile(db, id).map_err(|_| UsageError::configuration("配置已不存在"))?;
    if profile.version != expected_profile_version {
        return Err(UsageError::configuration("配置已更新，请重新读取后查询"));
    }
    let queries: Vec<_> = list_queries(db)?
        .into_iter()
        .filter(|query| query.config.identity.profile_id.as_deref() == Some(id))
        .collect();
    let old = queries
        .iter()
        .find(|query| matches!(query.config.program, QueryProgram::ProfileBuiltin { .. }));
    let Some(selected) = preset(&profile) else {
        return Ok(None);
    };
    if old.is_none() && !queries.is_empty() {
        return Ok(None);
    }
    let mut config = linked_config(&profile, selected);
    if let Some(old) = old {
        config.label = old.config.label.clone();
        config.enabled = old.config.enabled;
        config.refresh_interval_seconds = old.config.refresh_interval_seconds;
        if old.config == config {
            return Ok(Some(old.clone()));
        }
    }
    let saved = save_query(
        db,
        credentials,
        UsageQueryDraft {
            id: old.map(|query| query.id.clone()),
            expected_version: old.map(|query| query.version),
            config,
            credentials: vec![],
        },
    )?;
    Ok(Some(saved.query))
}

#[cfg(test)]
#[path = "../../../tests/usage/profile.rs"]
mod tests;
