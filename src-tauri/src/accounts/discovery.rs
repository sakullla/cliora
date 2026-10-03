//! Discover default CLI login without adopting credentials or mutating its files.
use super::{AccountState, NativeLogin, NativeLoginSnapshot};
use crate::{adapters::accounts::AccountAdapter, database::Database};
use std::{collections::BTreeMap, path::Path};

pub fn discover(db: &Database, home: &Path, tool: &str) -> Result<NativeLoginSnapshot, String> {
    let adapter = crate::adapters::accounts::get(tool)?;
    let environment = adapter
        .native_environment_keys()
        .iter()
        .filter_map(|key| std::env::var(key).ok().map(|value| ((*key).into(), value)))
        .collect();
    discover_with(db, home, tool, adapter, &environment)
}

pub fn discover_with(
    db: &Database,
    home: &Path,
    tool: &str,
    adapter: &dyn AccountAdapter,
    environment: &BTreeMap<String, String>,
) -> Result<NativeLoginSnapshot, String> {
    let Some(mut context) = adapter.native_context(home, environment)? else {
        return Err("此适配器尚未提供原生登录发现".into());
    };
    for path in std::iter::once(&context.root).chain(&context.auth_files) {
        if !path.is_absolute() {
            return Err("原生登录目录必须为绝对路径".into());
        }
        super::context::check_path(path)?;
    }
    context
        .remove_environment
        .extend(adapter.remove_environment().iter().map(|key| (*key).into()));
    let logins = if adapter.discovery_needs_executable() && !context.root.is_dir() {
        vec![]
    } else {
        let executable = if adapter.discovery_needs_executable() {
            Some(super::native::executable(db, home, tool)?)
        } else {
            None
        };
        adapter.discover(executable.as_deref(), &context)?
    };
    let mut logins = logins;
    let managed = super::store::list(db)?;
    for login in &mut logins {
        login.managed_account_id = managed
            .iter()
            .find(|account| {
                account.tool_id == tool
                    && account.context.as_ref().is_some_and(|owned| {
                        !context.auth_files.is_empty()
                            && context.auth_files.iter().all(|path| {
                                owned.auth_files.iter().any(|other| same_path(path, other))
                            })
                    })
                    && account.provider == login.provider
            })
            .map(|account| account.id.clone());
    }
    if logins.is_empty() {
        logins.push(NativeLogin {
            provider: adapter.capability().provider.into(),
            auth_kind: "oauth".into(),
            state: AccountState::SignedOut,
            identity: None,
            detail: Some(
                "默认原生目录未发现登录记录；若终端使用自定义目录，请从相同环境启动 Cliora。"
                    .into(),
            ),
            managed_account_id: None,
        });
    }
    Ok(NativeLoginSnapshot {
        tool_id: tool.into(),
        logins,
        checked_at: super::now(),
    })
}

fn same_path(left: &Path, right: &Path) -> bool {
    let left = left.canonicalize().unwrap_or_else(|_| left.to_path_buf());
    let right = right.canonicalize().unwrap_or_else(|_| right.to_path_buf());
    #[cfg(windows)]
    {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}
