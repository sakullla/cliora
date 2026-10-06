//! Pure DB reference projection. It never observes native logins or reads paths.
use super::{
    AccountImpact, AccountImpactContext, AccountImpactContextKind as Kind, AccountImpactProfile,
    AccountImpactScope, AccountImpactUsageReference, AccountReapplyRequest, AccountState,
    AuthAccount,
};
use crate::{database::Database, native::adapter::Scope};
use rusqlite::{Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone)]
pub(super) struct ProfileRow {
    pub summary: AccountImpactProfile,
    pub account_id: Option<String>,
    pub authentication: Option<String>,
}
#[derive(Clone)]
pub(super) struct BindingRow {
    pub key: String,
    pub tool: String,
    pub profile_id: String,
    pub version: u64,
    pub context: Option<String>,
    pub managed: String,
    pub common_version: Option<u64>,
    pub common_revision: Option<String>,
    pub applied_profile: Option<String>,
}

fn storage() -> String {
    "无法读取账号影响关系，请重新读取".into()
}
pub(super) fn account(conn: &Connection, id: &str) -> Result<AuthAccount, String> {
    let row: Option<(String, String, u32)> = conn
        .query_row(
            "SELECT data,tool,version FROM auth_accounts WHERE id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|_| storage())?;
    let (data, tool, version) = row.ok_or("账号不存在")?;
    let account: AuthAccount = serde_json::from_str(&data).map_err(|_| "账号数据格式不兼容")?;
    if account.id != id || account.tool_id != tool || account.version != version {
        return Err("账号记录不一致，请重新读取".into());
    }
    Ok(account)
}
pub(super) fn profiles(conn: &Connection) -> Result<Vec<ProfileRow>, String> {
    let mut statement=conn.prepare("SELECT id,tool,version,json_extract(data,'$.name'),COALESCE(json_extract(data,'$.revision'),''),json_extract(data,'$.authentication.accountId'),json_extract(data,'$.authentication.kind') FROM native_profiles ORDER BY rowid").map_err(|_|storage())?;
    let rows = statement
        .query_map([], |row| {
            Ok(ProfileRow {
                summary: AccountImpactProfile {
                    id: row.get(0)?,
                    tool_id: row.get(1)?,
                    version: row.get::<_, i64>(2)?.max(0) as u64,
                    name: row
                        .get::<_, Option<String>>(3)?
                        .unwrap_or_else(|| "未命名配置".into()),
                    revision: row.get(4)?,
                },
                account_id: row.get(5)?,
                authentication: row.get(6)?,
            })
        })
        .map_err(|_| storage())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|_| storage())
}
pub(super) fn binding(
    conn: &Connection,
    tool: &str,
    key: &str,
) -> Result<Option<BindingRow>, String> {
    conn.query_row("SELECT scope_key,tool,profile_id,profile_version,context_id,managed,common_version,common_revision,applied_profile FROM applied_bindings WHERE tool=?1 AND scope_key=?2",[tool,key],read_binding).optional().map_err(|_|storage())
}
fn read_binding(row: &rusqlite::Row<'_>) -> rusqlite::Result<BindingRow> {
    Ok(BindingRow {
        key: row.get(0)?,
        tool: row.get(1)?,
        profile_id: row.get(2)?,
        version: row.get::<_, i64>(3)?.max(0) as u64,
        context: row.get(4)?,
        managed: row.get(5)?, common_version:row.get::<_,Option<i64>>(6)?.map(|value|value.max(0) as u64),common_revision:row.get(7)?,applied_profile:row.get(8)?,
    })
}
fn bindings(conn: &Connection) -> Result<Vec<BindingRow>, String> {
    let mut statement=conn.prepare("SELECT scope_key,tool,profile_id,profile_version,context_id,managed,common_version,common_revision,applied_profile FROM applied_bindings ORDER BY rowid").map_err(|_|storage())?;
    let rows = statement
        .query_map([], read_binding)
        .map_err(|_| storage())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|_| storage())
}
pub(super) fn fingerprint(binding: &BindingRow) -> String {
    let values = (
        &binding.key,
        &binding.tool,
        &binding.profile_id,
        binding.version,
        &binding.context,
        &binding.managed,&binding.common_version,&binding.common_revision,&binding.applied_profile,
    );
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&values).expect("binding projection is serializable"))
    )
}
pub(super) fn scope(key: &str) -> (Option<Scope>, Option<String>) {
    let (_, key) = super::selection::split_key(key);
    if key == "global" {
        (Some(Scope::Global), None)
    } else if let Some(path) = key
        .strip_prefix("project:")
        .filter(|path| !path.is_empty() && !path.chars().any(char::is_control))
    {
        (Some(Scope::Project), Some(path.into()))
    } else {
        (None, None)
    }
}
fn context_kind(context: Option<&str>, known: &BTreeMap<String, Kind>) -> Kind {
    match context {
        None => Kind::None,
        Some(id) => known.get(id).cloned().unwrap_or(Kind::Unknown),
    }
}

pub fn query(db: &Database, id: &str) -> Result<AccountImpact, String> {
    db.with_connection(|conn| {
        let tx=conn.transaction().map_err(|_|storage())?;let account=account(&tx,id)?;
        let current=account.context.as_ref().map(|context|context.id.clone());let mut known=BTreeMap::new();let mut contexts=vec![];
        for (context,kind) in account.context.iter().map(|context|(context,Kind::Current)).chain(account.retired_contexts.iter().map(|context|(context,Kind::Retained))).chain(account.pending_login.iter().map(|pending|(&pending.context,Kind::Pending))) {
            if !known.contains_key(&context.id) {known.insert(context.id.clone(),kind.clone());contexts.push(AccountImpactContext {id:context.id.clone(),kind});}
        }
        let all_profiles=profiles(&tx)?;let referenced:Vec<_>=all_profiles.iter().filter(|profile|profile.account_id.as_deref()==Some(id)).collect();let profile_ids:BTreeSet<_>=referenced.iter().map(|profile|profile.summary.id.as_str()).collect();
        let all_bindings=bindings(&tx)?;let mut scopes=vec![];
        let mut applied_references=Vec::new();
        for row in &all_bindings {
            if let Some(snapshot)=row.applied_profile.as_deref().and_then(|data|serde_json::from_str::<crate::native::apply::AppliedProfileSnapshot>(data).ok()) {
                if matches!(&snapshot.runtime_profile.authentication,crate::native::profile::ProfileAuthentication::OAuth{account_id} if account_id==id)
                    && !referenced.iter().any(|profile|profile.summary.id==snapshot.source_profile.id)
                    && !applied_references.iter().any(|profile:&AccountImpactProfile|profile.id==snapshot.source_profile.id)
                { applied_references.push(AccountImpactProfile{id:snapshot.source_profile.id,name:snapshot.source_profile.name,tool_id:snapshot.source_profile.tool,version:snapshot.source_profile.version,revision:snapshot.source_profile.revision}); }
            }
        }

        for row in &all_bindings {
            if !profile_ids.contains(row.profile_id.as_str()) && !row.context.as_ref().is_some_and(|id|known.contains_key(id)) {continue;}
            let (scope,project_path)=scope(&row.key);let (_,base)=super::selection::split_key(&row.key);
            if row.key!=base && all_bindings.iter().any(|alias|alias.key==base && alias.tool==row.tool && alias.profile_id==row.profile_id && alias.version==row.version && alias.context==row.context) {continue;}
            let active=row.key==base && scope.is_some();let profile=all_profiles.iter().find(|profile|profile.summary.id==row.profile_id);
            let refers=profile.is_some_and(|profile|profile.account_id.as_deref()==Some(id) && profile.authentication.as_deref()==Some("oauth"));
            let snapshot=row.applied_profile.as_deref().and_then(|data|serde_json::from_str::<crate::native::apply::AppliedProfileSnapshot>(data).ok());
            let needs_reapply=active && (!refers || row.context.as_ref()!=current.as_ref() || profile.is_none_or(|profile|profile.summary.version!=row.version) || snapshot.as_ref().is_none_or(|snapshot| profile.is_none_or(|profile| snapshot.source_profile.revision!=profile.summary.revision)));
            let eligible=active && refers && scope.is_some() && row.tool==account.tool_id && profile.is_some_and(|profile|profile.summary.tool_id==account.tool_id) && account.state==AccountState::SignedIn && account.identity.is_some() && account.pending_login.is_none() && account.context.as_ref().is_some_and(|context|context.tool_id==account.tool_id);
            let reason=if !active {Some("保留的范围记录，不能作为当前范围重新应用".into())} else if profile.is_none() {Some("关联配置已不存在，请到配置页处理".into())} else if !refers {Some("配置已更换认证来源，请到配置页重新应用".into())} else if row.tool!=account.tool_id || profile.is_some_and(|profile|profile.summary.tool_id!=account.tool_id) {Some("关联配置与账号的 CLI 不匹配".into())} else if !eligible {Some("账号尚不可用于应用，请完成登录或身份核验".into())} else {None};
            let request=if eligible {let profile=&profile.unwrap().summary;Some(AccountReapplyRequest {account_id:id.into(),expected_account_version:account.version,expected_context_id:current.clone().unwrap(),tool_id:row.tool.clone(),profile_id:profile.id.clone(),expected_profile_version:profile.version,expected_profile_revision:profile.revision.clone(),scope:scope.unwrap(),project_path:project_path.clone(),expected_binding_fingerprint:fingerprint(row)})} else {None};
            let project_name=if let Some(path)=&project_path {tx.query_row("SELECT name FROM projects WHERE path=?1",[path],|row|row.get::<_,String>(0)).optional().map_err(|_|storage())?} else {None};
            scopes.push(AccountImpactScope {binding_id:format!("{:x}",Sha256::digest(serde_json::to_vec(&(&row.tool,&row.key)).unwrap())),tool_id:row.tool.clone(),profile_id:row.profile_id.clone(),profile_name:profile.map(|profile|profile.summary.name.clone()),profile_version:row.version,scope,project_path,project_name,context_id:row.context.clone(),context_kind:context_kind(row.context.as_deref(),&known),active,needs_reapply,can_reapply:eligible,reason,reapply_request:request});
        }
        let mut usage_references=vec![];
        {let mut statement=tx.prepare("SELECT id,version,json_extract(data,'$.config.label'),json_extract(data,'$.config.enabled'),json_extract(data,'$.config.identity.accountId'),json_extract(data,'$.config.identity.contextId'),json_extract(data,'$.config.identity.profileId'),json_extract(data,'$.config.program.kind') FROM usage_queries ORDER BY rowid").map_err(|_|storage())?;
        let rows=statement.query_map([],|row|Ok((row.get::<_,String>(0)?,row.get::<_,u32>(1)?,row.get::<_,Option<String>>(2)?.unwrap_or_else(||"未命名额度查询".into()),row.get::<_,Option<bool>>(3)?.unwrap_or(false),row.get::<_,Option<String>>(4)?,row.get::<_,Option<String>>(5)?,row.get::<_,Option<String>>(6)?,row.get::<_,Option<String>>(7)?))).map_err(|_|storage())?;
        for row in rows {let (query_id,version,label,enabled,account_id,context_id,profile_id,program)=row.map_err(|_|storage())?;
            if account_id.as_deref()!=Some(id) && !context_id.as_ref().is_some_and(|id|known.contains_key(id)) && !profile_id.as_deref().is_some_and(|id|profile_ids.contains(id)) {continue;}
            let needs_rebind=program.as_deref()==Some("official") && (account_id.as_deref()!=Some(id) || context_id.as_ref()!=current.as_ref() || current.is_none() || account.state!=AccountState::SignedIn || account.pending_login.is_some() || account.identity.is_none() || profile_id.as_deref().is_some_and(|id|!profile_ids.contains(id)));
            usage_references.push(AccountImpactUsageReference {id:query_id,label,version,enabled,account_id,context_kind:context_kind(context_id.as_deref(),&known),context_id,profile_id,needs_rebind});
        }}
        let result=AccountImpact {account_id:account.id,account_version:account.version,tool_id:account.tool_id,current_context_id:current,contexts,profiles:referenced.into_iter().map(|profile|profile.summary.clone()).chain(applied_references).collect(),scopes,usage_references};tx.commit().map_err(|_|storage())?;Ok(result)
    })
}
