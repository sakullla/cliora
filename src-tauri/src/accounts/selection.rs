//! Synchronous operation-local native paths. Never changes process environment.
//! The !Send guard cannot cross a worker/async boundary and restores nesting on drop.
use super::NativeContext;
use crate::{
    database::Database,
    native::{
        adapter::Scope,
        profile::{ProfileAuthentication, RegisteredProfile},
    },
};
use std::{
    cell::RefCell,
    marker::PhantomData,
    path::{Path, PathBuf},
    rc::Rc,
};
thread_local! { static CURRENT: RefCell<Option<Option<NativeContext>>> = const { RefCell::new(None) }; }
pub struct ContextGuard(Option<Option<NativeContext>>, PhantomData<Rc<()>>);
impl Drop for ContextGuard {
    fn drop(&mut self) {
        CURRENT.with(|slot| *slot.borrow_mut() = self.0.take());
    }
}
pub fn enter(context: Option<NativeContext>) -> ContextGuard {
    ContextGuard(
        CURRENT.with(|slot| slot.replace(Some(context))),
        PhantomData,
    )
}
pub fn current(tool: &str) -> Option<NativeContext> {
    CURRENT.with(|slot| {
        slot.borrow()
            .as_ref()
            .and_then(|value| value.as_ref())
            .filter(|ctx| ctx.tool_id == tool)
            .cloned()
    })
}
pub fn config_root(tool: &str, fallback: impl FnOnce() -> PathBuf) -> PathBuf {
    current(tool)
        .map(|ctx| ctx.config_root)
        .unwrap_or_else(fallback)
}
pub fn history_root(tool: &str, fallback: impl FnOnce() -> PathBuf) -> PathBuf {
    current(tool)
        .and_then(|ctx| ctx.history_roots.first().cloned())
        .unwrap_or_else(fallback)
}
pub fn key(key: &str) -> String {
    if key.starts_with("project:") {
        return key.into();
    }
    CURRENT.with(|slot| {
        slot.borrow()
            .as_ref()
            .and_then(|value| value.as_ref())
            .map(|ctx| format!("context:{}:{key}", ctx.id))
            .unwrap_or_else(|| key.into())
    })
}
pub fn for_profile(
    db: &Database,
    home: &Path,
    profile: &RegisteredProfile,
) -> Result<Option<NativeContext>, String> {
    match &profile.authentication {
        ProfileAuthentication::OAuth { account_id } => {
            super::resolve(db, home, account_id, &profile.tool).map(Some)
        }
        ProfileAuthentication::RebindRequired => {
            Err("此配置来自其他设备，请重新绑定 OAuth 账号".into())
        }
        _ => Ok(None),
    }
}
pub fn bound(
    db: &Database,
    home: &Path,
    tool: &str,
    scope: Scope,
    project: Option<&Path>,
    verify: bool,
) -> Result<Option<(String, NativeContext)>, String> {
    let key = crate::native::apply::scope_key(scope, project)?;
    let binding = crate::native::apply::get_registered_binding(db, tool, &key)?;
    let binding = if binding.is_none() && scope == Scope::Project {
        crate::native::apply::get_registered_binding(db, tool, "global")?
    } else {
        binding
    };
    let Some(binding) = binding else {
        return Ok(None);
    };
    let profile = if let Some(snapshot)=&binding.applied_profile {
        &snapshot.runtime_profile
    } else {
        // A legacy native-directory binding proves its directory, not an old
        // connection/key. No application credential is injected during launch.
        if binding.context_id.is_none(){return Ok(None);}
        return Err("最后应用的账号身份快照未知，请明确使用配置后重试；不会退回默认目录".into());
    };
    if profile.id!=binding.profile_id||profile.tool!=tool {return Err("应用快照与范围不一致，请重新应用".into());}
    match &profile.authentication {
        ProfileAuthentication::OAuth { account_id } => {
            let context_id = binding
                .context_id
                .as_deref()
                .ok_or("OAuth 配置尚未应用，请重新应用")?;
            let ctx = if verify {
                super::resolve_retained(db, home, account_id, tool, context_id)?
            } else {
                let account = super::get(db, account_id)?;
                account
                    .context
                    .iter()
                    .chain(&account.retired_contexts)
                    .find(|ctx| ctx.id == context_id)
                    .cloned()
                    .ok_or("账号上下文已丢失，请重新绑定")?
            };
            super::context::check_path(&ctx.root)?;
            Ok(Some((account_id.clone(), ctx)))
        }
        ProfileAuthentication::RebindRequired => Err("此配置需要重新绑定 OAuth 账号".into()),
        _ if binding.context_id.is_some() => Err("认证配置已改变，请重新应用后启动".into()),
        _ => Ok(None),
    }
}
pub fn enter_bound(
    db: &Database,
    home: &Path,
    tool: &str,
    scope: Scope,
    project: Option<&Path>,
) -> Result<ContextGuard, String> {
    Ok(enter(
        match CURRENT
            .with(|slot| slot.borrow().clone())
            .filter(|value| value.as_ref().is_none_or(|ctx| ctx.tool_id == tool))
        {
            Some(context) => context,
            None => bound(db, home, tool, scope, project, false)?.map(|(_, ctx)| ctx),
        },
    ))
}

pub fn split_key(key: &str) -> (Option<&str>, &str) {
    key.strip_prefix("context:")
        .and_then(|tail| tail.split_once(':'))
        .map(|(id, key)| (Some(id), key))
        .unwrap_or((None, key))
}

pub fn validate_expected(tool: &str, expected: Option<&str>) -> Result<(), String> {
    let actual = current(tool).map(|ctx| ctx.id).unwrap_or_default();
    if actual != expected.unwrap_or("") {
        return Err("账号上下文已切换；请先应用目标账号的配置，再重新读取文件或资源后操作".into());
    }
    Ok(())
}

pub fn by_id(db: &Database, tool: &str, id: &str) -> Result<NativeContext, String> {
    super::list(db)?
        .into_iter()
        .filter(|account| account.tool_id == tool)
        .flat_map(|account| account.context.into_iter().chain(account.retired_contexts))
        .find(|ctx| ctx.id == id)
        .ok_or_else(|| "资源所属账号上下文不存在，请重新绑定".into())
}
pub fn validate_oauth_files(
    registry: &crate::adapters::Registry,
    tool: &str,
    home: &Path,
    project: Option<&Path>,
) -> Result<(), String> {
    if current(tool).is_none() {
        return Ok(());
    }
    let adapter = registry.get(tool).ok_or("CLI 未注册")?;
    let mut documents = Vec::new();
    for scope in [Scope::Global, Scope::Project] {
        if scope == Scope::Project && project.is_none() {
            continue;
        }
        for file in adapter
            .native_files(scope, home, project, true)
            .into_iter()
            .filter(|file| !file.sensitive)
        {
            let text = crate::native::transaction::read_native(Path::new(&file.path))?;
            let value = crate::native::format::parse(adapter.file_kind(file.role)?, &text)?;
            documents.push(value);
        }
    }
    adapter
        .accounts()
        .ok_or("此 CLI 未提供账号适配")?
        .validate_documents(&documents)
}
