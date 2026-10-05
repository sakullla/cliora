//! Native CLI owns authorization and refresh. Cliora only owns context selection.
pub mod context;
pub mod discovery;
pub mod selection;
mod impact;
mod reapply;
mod contract;
pub mod native;
mod store;
use crate::{database::Database, launch};
pub use contract::*;
use std::{path::Path, sync::Arc, time::Duration};
pub use store::get;
pub use store::delete;
pub use impact::query as impact;
pub use reapply::{enter as enter_reapply,validate_profile as validate_reapply_profile,validate_transaction as validate_reapply_transaction};

pub fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

static OPERATION_ADMISSION: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn list(db: &Database) -> Result<Vec<AuthAccount>, String> {
    let accounts = store::list(db)?;
    accounts
        .into_iter()
        .map(|account| {
            if let Some(pending) = &account.pending_login {
                if now() >= pending.expires_at {
                    return cancel(db, &account.id, &pending.id, true)
                        .or_else(|_| get(db, &account.id));
                }
            }
            Ok(account)
        })
        .collect()
}

fn admit(db: &Database) -> Result<(), String> {
    if list(db)?
        .iter()
        .filter(|account| account.pending_login.is_some())
        .count()
        >= 4
    {
        return Err("最多同时进行四个原生账号操作，请先完成或取消已有操作".into());
    }
    Ok(())
}

pub fn create(db: &Database, tool: &str, label: &str) -> Result<AuthAccount, String> {
    let capability = crate::adapters::accounts::capability(tool).ok_or("未知 CLI")?;
    if !capability.managed_login {
        return Err(capability.reason.into());
    }
    validate_label(label)?;
    let account = AuthAccount {
        id: uuid::Uuid::new_v4().to_string(),
        tool_id: tool.into(),
        provider: capability.provider.into(),
        label: label.trim().into(),
        version: 1,
        state: AccountState::SignedOut,
        identity: None,
        context: None,
        retired_contexts: vec![],
        pending_login: None,
        checked_at: None,
        detail: None,
    };
    store::insert(db, &account)?;
    Ok(account)
}

fn validate_label(label: &str) -> Result<(), String> {
    if label.trim().is_empty() || label.len() > 160 || label.chars().any(char::is_control) {
        return Err("账号名称需为 1–160 字节且不含控制字符".into());
    }
    Ok(())
}

/// Explicit adoption of the existing file-backed Codex context, without copying
/// rotating tokens into a second refresh owner or importing unrelated files.
pub fn adopt_codex(db:&Database,home:&Path,label:&str)->Result<AuthAccount,String> {adopt_native(db,home,"codex",label)}

pub fn adopt_native(db: &Database, home: &Path, tool: &str, label: &str) -> Result<AuthAccount, String> {
    use sha2::{Digest, Sha256};
    validate_label(label)?;
    let adapter=crate::adapters::accounts::get(tool)?;
    let capability=adapter.capability();
    if !capability.import_native {return Err(capability.reason.into());}
    let root = crate::adapters::accounts::get(tool)?.native_root(home)?;
    if !root.is_absolute() {
        return Err("原生账号根目录 必须是绝对路径".into());
    }
    context::check_path(&root)?;
    let root = root.canonicalize().map_err(|_| "原生账号目录不存在")?;
    let id = format!(
        "adopted-{tool}-{:x}",
        Sha256::digest(root.to_string_lossy().to_lowercase().as_bytes())
    );
    if list(db)?.iter().any(|account| {
        account
            .context
            .iter()
            .chain(&account.retired_contexts)
            .any(|context| context.id == id)
    }) {
        return Err("此原生上下文已纳入管理".into());
    }
    let context = context::context_at(root, tool, id)?;
    if !context.auth_files.first().is_some_and(|path| path.is_file()) {
        return Err("仅支持明确存在的 file 认证材料；系统 keyring/外部认证材料尚不支持纳入".into());
    }
    let executable = native::executable(db, home, tool)?;
    let observation = native::observe(&executable, &context)?;
    if observation.state != AccountState::SignedIn || observation.identity.is_none() {
        return Err("原生账号尚无可核验的 OAuth 身份".into());
    }
    let account = AuthAccount { id: uuid::Uuid::new_v4().to_string(), tool_id: tool.into(), provider: capability.provider.into(), label: label.trim().into(), version: 1,
        state: AccountState::SignedIn, identity: observation.identity, context: Some(context), retired_contexts: vec![], pending_login: None, checked_at: Some(now()),
        detail: Some("已明确纳入原生默认上下文，未复制令牌；在此账号执行退出会影响使用该原生目录的普通终端。".into()) };
    store::insert(db, &account)?;
    Ok(account)
}

pub fn rename(db: &Database, id: &str, version: u32, label: &str) -> Result<AuthAccount, String> {
    validate_label(label)?;
    let mut account = get(db, id)?;
    expected(&account, version)?;
    account.label = label.trim().into();
    store::replace(db, &mut account)?;
    Ok(account)
}

fn expected(account: &AuthAccount, version: u32) -> Result<(), String> {
    if account.version != version {
        return Err("账号已发生变化，请重新读取".into());
    }
    Ok(())
}

pub fn prepare_login(
    db: &Database,
    base: &Path,
    id: &str,
    version: u32,
) -> Result<AuthAccount, String> {
    let _admission = OPERATION_ADMISSION
        .lock()
        .map_err(|_| "账号操作服务不可用")?;
    admit(db)?;
    let mut account = get(db, id)?;
    expected(&account, version)?;
    if account.pending_login.is_some() {
        return Err("该账号已有进行中的原生操作，请先取消".into());
    }
    let candidate = context::create_context(base, &account.tool_id)?;
    account.pending_login = Some(PendingLogin {
        id: uuid::Uuid::new_v4().to_string(),
        expires_at: now() + 600,
        context: candidate,
        previous_state: account.state.clone(),
        external_terminal: true,
        operation: "login".into(),
    });
    account.state = AccountState::Pending;
    account.detail = Some(
        crate::adapters::accounts::get(&account.tool_id)?.login_detail()
        .into(),
    );
    store::replace(db, &mut account)?;
    Ok(account)
}

/// The only promotion point. The opaque attempt ID and CAS reject late results.
pub fn complete(
    db: &Database,
    id: &str,
    attempt: &str,
    observation: Observation,
    at: i64,
) -> Result<AuthAccount, String> {
    let mut account = get(db, id)?;
    let pending = account.pending_login.clone().ok_or("登录操作已结束")?;
    if pending.id != attempt {
        return Err("已忽略旧账号操作结果".into());
    }
    if at >= pending.expires_at {
        return cancel(db, id, attempt, true);
    }
    if pending.operation == "logout" {
        if observation.state != AccountState::SignedOut {
            return Ok(account);
        }
        account.state = AccountState::SignedOut;
        account.pending_login = None;
        account.detail =
            Some("已核验所选上下文本地退出；未撤销服务端其他设备。已有终端可能仍持有令牌。".into());
    } else {
        if observation.state != AccountState::SignedIn || observation.identity.is_none() {
            if observation.detail != account.detail {
                account.detail = observation.detail;
                account.checked_at = Some(at);
                store::replace(db, &mut account)?;
            }
            return Ok(account);
        }
        let identity = observation.identity.ok_or("原生身份缺失")?;
        if account
            .identity
            .as_ref()
            .is_some_and(|old| old.subject != identity.subject)
        {
            account.state = pending.previous_state;
            account.pending_login = None;
            account.detail = Some(
                "重新认证返回了不同身份；原账号保持不变，请另建账号。候选原生终端仍由用户控制。"
                    .into(),
            );
        } else {
            if let Some(previous) = account.context.take() {
                account.retired_contexts.push(previous);
            }
            account.context = Some(pending.context);
            account.identity = Some(identity);
            account.state = AccountState::SignedIn;
            account.pending_login = None;
            account.detail = observation.detail;
        }
    }
    account.checked_at = Some(at);
    store::replace(db, &mut account)?;
    Ok(account)
}

pub fn cancel(
    db: &Database,
    id: &str,
    attempt: &str,
    timed_out: bool,
) -> Result<AuthAccount, String> {
    let mut account = get(db, id)?;
    let pending = account.pending_login.take().ok_or("账号操作已结束")?;
    if pending.id != attempt {
        return Err("取消标识已过期，请重新读取账号".into());
    }
    account.state = if pending.operation == "logout" {
        AccountState::Unknown
    } else {
        pending.previous_state
    };
    account.detail = Some(
        if pending.operation == "logout" {
            "已停止等待原生退出。原生退出可能已生效，请检查状态；如打开了原生终端，请自行关闭。"
        } else if timed_out {
            "原生认证操作超时，已停止接纳结果。外部终端仍由用户控制，请关闭；候选目录不会自动激活。"
        } else {
            "已取消结果接纳。外部原生终端仍由用户控制，请关闭；迟到授权不会激活候选目录。"
        }
        .into(),
    );
    store::replace(db, &mut account)?;
    Ok(account)
}

fn fail_login(db: &Database, id: &str, attempt: &str, detail: &str) -> Result<AuthAccount, String> {
    let mut account = get(db, id)?;
    let pending = account.pending_login.take().ok_or("登录操作已结束")?;
    if pending.id != attempt || pending.operation != "login" {
        return Err("已忽略旧账号操作结果".into());
    }
    account.state = if account.context.is_some() {
        pending.previous_state
    } else {
        AccountState::Error
    };
    account.detail = Some(detail.into());
    account.checked_at = Some(now());
    store::replace(db, &mut account)?;
    Ok(account)
}

fn watch(db: Arc<Database>, account: AuthAccount, executable: std::path::PathBuf) {
    let Some(pending) = account.pending_login else {
        return;
    };
    std::thread::spawn(move || {
        struct LinkReceipt(std::path::PathBuf);
        impl Drop for LinkReceipt {
            fn drop(&mut self) { if context::check_path(&self.0).is_ok() { let _ = std::fs::remove_file(&self.0); } }
        }
        let _link_receipt = LinkReceipt(pending.context.root.join(".cliora-auth-url"));
        loop {
        let Ok(current) = get(&db, &account.id) else {
            return;
        };
        if current
            .pending_login
            .as_ref()
            .is_none_or(|p| p.id != pending.id)
        {
            return;
        }
        if now() >= pending.expires_at {
            let _ = cancel(&db, &account.id, &pending.id, true);
            return;
        }
        let receipt = pending.context.root.join(".cliora-auth-exit");
        if pending.operation == "login" && context::check_path(&receipt).is_ok() {
            use std::io::Read;
            let code = std::fs::File::open(&receipt).ok().and_then(|file| {
                let mut text = String::new();
                file.take(16).read_to_string(&mut text).ok()?;
                text.trim().parse::<i32>().ok()
            });
            if code.is_some_and(|value| value != 0) {
                let _ = fail_login(&db, &account.id, &pending.id, "原生登录命令未成功（可能拒绝授权或流程失败）；原账号保持不变，请查看原生终端后重试。");
                return;
            }
        }
        // Fresh login directories have no auth until the native flow completes.
        if pending.operation == "logout"
            || pending.context.auth_files.iter().any(|path| path.is_file())
        {
            match native::observe(&executable, &pending.context) {
                Ok(observation) => {
                    if let Ok(updated) = complete(&db, &account.id, &pending.id, observation, now())
                    {
                        if updated.pending_login.is_none() {
                            return;
                        }
                    }
                }
                Err(error) => {
                    // Fixed, bounded native errors only; raw stdout/stderr never escapes.
                    if let Ok(mut current) = get(&db, &account.id) {
                        if current
                            .pending_login
                            .as_ref()
                            .is_some_and(|p| p.id == pending.id)
                            && current.detail.as_ref() != Some(&error)
                        {
                            current.detail = Some(error);
                            let _ = store::replace(&db, &mut current);
                        }
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_secs(2));
        }
    });
}

pub fn start_login(
    db: Arc<Database>,
    base: &Path,
    home: &Path,
    id: &str,
    version: u32,
    method: &str,
) -> Result<AuthAccount, String> {
    let current = get(&db, id)?;
    expected(&current, version)?;
    let args = native::login_args(&current.tool_id, method)?;
    let executable = native::executable(&db, home, &current.tool_id)?;
    let account = prepare_login(&db, base, id, version)?;
    let pending = account.pending_login.as_ref().ok_or("登录上下文缺失")?;
    let completion = pending.context.root.join(".cliora-auth-exit");
    if launch::spawn_account_terminal(
        &db,
        &executable,
        &args,
        &pending.context,
        account.detail.as_deref().unwrap_or(""),
        Some(&completion),
    )
    .is_err()
    {
        let _ = cancel(&db, id, &pending.id, false);
        return Err("无法打开原生登录终端，未激活账号".into());
    }
    watch(db, account.clone(), executable);
    Ok(account)
}

pub fn check(db: &Database, home: &Path, id: &str) -> Result<AuthAccount, String> {
    let mut account = get(db, id)?;
    reapply::before_check(&account)?;
    let before_check = account.clone();
    let executable = native::executable(db, home, &account.tool_id)?;
    if let Some(pending) = account.pending_login.clone() {
        if now() >= pending.expires_at {
            return cancel(db, id, &pending.id, true);
        }
        let observation = native::observe(&executable, &pending.context)?;
        return complete(db, id, &pending.id, observation, now());
    }
    let Some(context) = &account.context else {
        return Ok(account);
    };
    let observation = match native::observe(&executable, context) {
        Ok(observation) => observation,
        Err(error) => {
            account.state = AccountState::Error;
            account.detail = Some(error);
            account.checked_at = Some(now());
            store::replace(db, &mut account)?;
            return Ok(account);
        }
    };
    // A signed-out account can be explicitly checked after the user authenticates
    // in that same native context, but never accept a different account identity.
    if observation
        .identity
        .as_ref()
        .zip(account.identity.as_ref())
        .is_some_and(|(a, b)| a.subject != b.subject)
    {
        account.state = AccountState::Error;
        account.detail = Some("原生上下文的身份已改变，拒绝用于原绑定，请重新认证".into());
    } else {
        account.state = observation.state;
        account.detail = observation.detail;
        if observation.identity.is_some() {
            account.identity = observation.identity;
        }
    }
    account.checked_at = Some(now());
    store::replace(db, &mut account)?;
    reapply::after_check(&before_check, &account)?;
    Ok(account)
}

pub fn logout(
    db: Arc<Database>,
    home: &Path,
    id: &str,
    version: u32,
) -> Result<AuthAccount, String> {
    let admission = OPERATION_ADMISSION
        .lock()
        .map_err(|_| "账号操作服务不可用")?;
    admit(&db)?;
    let mut account = get(&db, id)?;
    expected(&account, version)?;
    if account.pending_login.is_some() {
        return Err("请先取消正在进行的账号操作".into());
    }
    let context = account.context.clone().ok_or("此账号没有已激活上下文")?;
    let executable = native::executable(&db, home, &account.tool_id)?;
    account.pending_login = Some(PendingLogin {
        id: uuid::Uuid::new_v4().to_string(),
        expires_at: now() + 300,
        context: context.clone(),
        previous_state: account.state.clone(),
        external_terminal: crate::adapters::accounts::get(&account.tool_id)?.terminal_logout(),
        operation: "logout".into(),
    });
    account.state = AccountState::Pending;
    account.detail = Some(
        crate::adapters::accounts::get(&account.tool_id)?.logout_detail()
        .into(),
    );
    store::replace(&db, &mut account)?;
    drop(admission);
    if !crate::adapters::accounts::get(&account.tool_id)?.terminal_logout() {
        let attempt = account
            .pending_login
            .as_ref()
            .ok_or("账号操作丢失")?
            .id
            .clone();
        return match native::perform_logout(&executable, &context) {
            Ok(observation) => complete(&db, id, &attempt, observation, now()),
            Err(error) => {
                let mut failed = get(&db, id)?;
                if failed
                    .pending_login
                    .as_ref()
                    .is_some_and(|pending| pending.id == attempt)
                {
                    failed.pending_login = None;
                    failed.state = AccountState::Error;
                    failed.detail = Some(error);
                    failed.checked_at = Some(now());
                    store::replace(&db, &mut failed)?;
                }
                Ok(failed)
            }
        };
    }
    if launch::spawn_account_terminal(
        &db,
        &executable,
        &native::logout_args(&account.tool_id),
        &context,
        account.detail.as_deref().unwrap_or(""),
        None,
    )
    .is_err()
    {
        let _ = cancel(
            &db,
            id,
            &account.pending_login.as_ref().ok_or("账号操作丢失")?.id,
            false,
        );
        return Err("无法打开退出终端；账号状态需重新检查".into());
    }
    watch(db, account.clone(), executable);
    Ok(account)
}

/// T7 must use this same context for apply, resources, history and process env.
/// Fresh native identity checks avoid silently falling back to another auth mode.
pub fn resolve(db: &Database, home: &Path, id: &str, tool: &str) -> Result<NativeContext, String> {
    let account = get(db, id)?;
    if account.tool_id != tool {
        return Err("账号与 CLI 不匹配".into());
    }
    if account.pending_login.is_some() || account.state != AccountState::SignedIn {
        return Err("账号尚不可用，请完成登录或重新认证".into());
    }
    let checked = check(db, home, id)?;
    if checked.state != AccountState::SignedIn {
        return Err("账号认证已失效，未回退到其他凭据".into());
    }
    checked.context.ok_or_else(|| "账号上下文缺失".into())
}

/// Resume may explicitly reference a retained context, but must verify both its
/// owner and native identity; retired locations are never a fallback credential.
pub fn resolve_retained(
    db: &Database,
    home: &Path,
    id: &str,
    tool: &str,
    context_id: &str,
) -> Result<NativeContext, String> {
    let current = resolve(db, home, id, tool)?;
    if current.id == context_id {
        return Ok(current);
    }
    let account = get(db, id)?;
    let retained = account
        .retired_contexts
        .iter()
        .find(|context| context.id == context_id)
        .ok_or("历史账号上下文不存在，请重新绑定")?;
    let executable = native::executable(db, home, tool)?;
    let observation = native::observe(&executable, retained)?;
    if observation.state != AccountState::SignedIn
        || observation.identity.as_ref().map(|value| &value.subject)
            != account.identity.as_ref().map(|value| &value.subject)
    {
        return Err("历史上下文认证已失效或身份已改变；未回退到其他账号".into());
    }
    validate_selected_context(db, id, context_id)?;
    Ok(retained.clone())
}

pub fn validate_selected_context(db: &Database, id: &str, context_id: &str) -> Result<(), String> {
    let account = get(db, id)?;
    if account.state != AccountState::SignedIn
        || account.pending_login.is_some()
        || !account
            .context
            .iter()
            .chain(&account.retired_contexts)
            .any(|context| context.id == context_id)
    {
        return Err("账号或上下文已改变，请重新选择后启动".into());
    }
    Ok(())
}

#[cfg(test)]
#[path = "../../../tests/accounts/lifecycle.rs"]
mod tests;

#[cfg(test)]
#[path = "../../../tests/accounts/binding.rs"]
mod binding_tests;

#[cfg(test)]
#[path = "../../../tests/accounts/discovery.rs"]
mod discovery_tests;
