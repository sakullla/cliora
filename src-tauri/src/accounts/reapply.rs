//! Operation-local intent guard for the existing shared apply transaction.
use super::{impact, AccountReapplyRequest, AccountState, AuthAccount};
use crate::{
    database::Database,
    native::{
        adapter::Scope,
        profile::{ProfileAuthentication, RegisteredProfile},
    },
};
use rusqlite::Connection;
use std::{cell::RefCell, marker::PhantomData, path::Path, rc::Rc};

struct Intent {
    request: AccountReapplyRequest,
    account_version: u32,
    subject: Option<String>,
}
thread_local! {static INTENT:RefCell<Option<Intent>>=const {RefCell::new(None)};}
pub struct ReapplyGuard(Option<Intent>, PhantomData<Rc<()>>);
impl Drop for ReapplyGuard {
    fn drop(&mut self) {
        INTENT.with(|slot| *slot.borrow_mut() = self.0.take());
    }
}

pub fn enter(request: AccountReapplyRequest) -> Result<ReapplyGuard, String> {
    if request.account_id.is_empty()
        || request.profile_id.is_empty()
        || request.tool_id.is_empty()
        || request.expected_context_id.is_empty()
        || request.expected_account_version == 0
        || request.expected_profile_version == 0
        || request.expected_binding_fingerprint.len() != 64
        || !request
            .expected_binding_fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || request.scope == Scope::Global && request.project_path.is_some()
        || request.scope == Scope::Project
            && request
                .project_path
                .as_deref()
                .is_none_or(|path| path.is_empty())
    {
        return Err("重新应用请求无效，请重新读取账号影响".into());
    }
    Ok(ReapplyGuard(
        INTENT.with(|slot| {
            slot.replace(Some(Intent {
                account_version: request.expected_account_version,
                request,
                subject: None,
            }))
        }),
        PhantomData,
    ))
}
fn changed() -> String {
    "账号、配置或范围关联已变化，请重新读取账号影响后再应用".into()
}
fn account_matches(intent: &Intent, account: &AuthAccount) -> bool {
    account.id == intent.request.account_id
        && account.tool_id == intent.request.tool_id
        && account.version == intent.account_version
        && account.state == AccountState::SignedIn
        && account.pending_login.is_none()
        && account.context.as_ref().is_some_and(|context| {
            context.id == intent.request.expected_context_id
                && context.tool_id == intent.request.tool_id
        })
        && account.identity.as_ref().is_some_and(|identity| {
            intent
                .subject
                .as_ref()
                .is_none_or(|subject| subject == &identity.subject)
        })
}
fn validate(
    conn: &Connection,
    profile: &RegisteredProfile,
    actual_scope_key: Option<&str>,
) -> Result<(), String> {
    INTENT.with(|slot| {
        let mut state=slot.borrow_mut();let Some(intent)=state.as_mut() else {return Ok(());};let request=&intent.request;
        if profile.id!=request.profile_id || profile.tool!=request.tool_id || profile.version!=request.expected_profile_version || profile.revision!=request.expected_profile_revision || !matches!(&profile.authentication,ProfileAuthentication::OAuth {account_id} if account_id==&request.account_id) {return Err(changed());}
        let account=impact::account(conn,&request.account_id)?;if !account_matches(intent,&account) {return Err(changed());}
        let key=match request.scope {Scope::Global=>"global".into(),Scope::Project=>format!("project:{}",request.project_path.as_deref().ok_or_else(changed)?)};
        if actual_scope_key.is_some_and(|actual|actual!=key) {return Err(changed());}
        let binding=impact::binding(conn,&request.tool_id,&key)?.ok_or_else(changed)?;
        if binding.profile_id!=request.profile_id || impact::fingerprint(&binding)!=request.expected_binding_fingerprint {return Err(changed());}
        // Also read the current profile in this same snapshot. A caller cannot
        // approve an old in-memory record after it changed in storage.
        let stored=impact::profiles(conn)?.into_iter().find(|stored|stored.summary.id==request.profile_id).ok_or_else(changed)?;
        if stored.summary.version!=request.expected_profile_version || stored.summary.revision!=request.expected_profile_revision || stored.summary.tool_id!=request.tool_id || stored.authentication.as_deref()!=Some("oauth") || stored.account_id.as_deref()!=Some(request.account_id.as_str()) {return Err(changed());}
        if intent.subject.is_none() {intent.subject=account.identity.map(|identity|identity.subject);}
        Ok(())
    })
}
/// Called before native context resolution/probe. Ordinary apply is unchanged.
pub fn validate_profile(
    db: &Database,
    profile: &RegisteredProfile,
    scope: Scope,
    project: Option<&Path>,
) -> Result<(), String> {
    if INTENT.with(|slot| slot.borrow().is_none()) {
        return Ok(());
    }
    let key = crate::native::apply::scope_key(scope, project)?;
    db.with_connection(|conn| {
        let tx = conn.transaction().map_err(|_| "无法读取账号应用条件")?;
        validate(&tx, profile, Some(&key))?;
        tx.commit().map_err(|_| "无法读取账号应用条件".into())
    })
}
/// Called inside the shared write/already_matching commit. Any rejection rolls
/// back native files and binding changes using the existing transaction engine.
pub fn validate_transaction(
    tx: &rusqlite::Transaction<'_>,
    profile: &RegisteredProfile,
) -> Result<(), String> {
    validate(tx, profile, None)?;
    INTENT.with(|slot| {
        let state = slot.borrow();
        let Some(intent) = state.as_ref() else {
            return Ok(());
        };
        if super::selection::current(&intent.request.tool_id)
            .as_ref()
            .map(|context| context.id.as_str())
            != Some(intent.request.expected_context_id.as_str())
        {
            return Err(changed());
        }
        Ok(())
    })
}
/// A successful check writes its own account CAS revision. Admit only that
/// exact transition; external checks, renames, pending operations and cancels
/// never advance this operation's expected version.
pub(super) fn before_check(account: &AuthAccount) -> Result<(), String> {
    INTENT.with(|slot| {
        let state = slot.borrow();
        let Some(intent) = state.as_ref() else {
            return Ok(());
        };
        if !account_matches(intent, account) {
            return Err(changed());
        }
        Ok(())
    })
}
pub(super) fn after_check(before: &AuthAccount, after: &AuthAccount) -> Result<(), String> {
    INTENT.with(|slot| {
        let mut state = slot.borrow_mut();
        let Some(intent) = state.as_mut() else {
            return Ok(());
        };
        if !account_matches(intent, before)
            || after.id != before.id
            || after.tool_id != before.tool_id
            || after.provider != before.provider
            || after.label != before.label
            || after.version != before.version.checked_add(1).ok_or_else(changed)?
            || after.context != before.context
            || after.retired_contexts != before.retired_contexts
            || after.pending_login.is_some()
            || after.state != AccountState::SignedIn
            || after.identity.as_ref().map(|identity| &identity.subject)
                != before.identity.as_ref().map(|identity| &identity.subject)
        {
            return Err(changed());
        }
        intent.account_version = after.version;
        Ok(())
    })
}

#[cfg(test)]
#[path = "reapply_tests.rs"]
mod tests;
