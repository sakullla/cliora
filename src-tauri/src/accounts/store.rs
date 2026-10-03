use super::{AuthAccount, NativeContext};
use crate::database::Database;
use rusqlite::{params, OptionalExtension};

pub fn list(db: &Database) -> Result<Vec<AuthAccount>, String> {
    db.with_connection(|conn| {
        let mut statement = conn
            .prepare("SELECT data FROM auth_accounts ORDER BY rowid")
            .map_err(|_| "无法读取账号".to_owned())?;
        let records = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|_| "无法读取账号".to_owned())?;
        records
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "无法读取账号".to_owned())
    })
    .map_err(|_| "无法读取账号列表".to_owned())?
    .into_iter()
    .map(|data| serde_json::from_str(&data).map_err(|_| "账号数据格式不兼容".into()))
    .collect()
}

pub fn get(db: &Database, id: &str) -> Result<AuthAccount, String> {
    let data: Option<String> = db
        .with_connection(|conn| {
            conn.query_row("SELECT data FROM auth_accounts WHERE id=?1", [id], |row| {
                row.get(0)
            })
            .optional()
            .map_err(|_| "无法读取账号".to_owned())
        })
        .map_err(|_| "无法读取账号")?;
    serde_json::from_str(&data.ok_or("账号不存在")?).map_err(|_| "账号数据格式不兼容".into())
}

pub fn insert(db: &Database, account: &AuthAccount) -> Result<(), String> {
    let data = serde_json::to_string(account).map_err(|_| "无法编码账号")?;
    db.with_connection(|conn| {
        // Adoption verifies identity before this write. Serialize the ownership
        // check and insertion across database handles so two verified requests
        // cannot register the same native directory as independent accounts.
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| "无法保存账号".to_owned())?;
        let candidate: Vec<_> = contexts(account)
            .map(|context| (&context.id, canonical_root(context)))
            .collect();
        if !candidate.is_empty() {
            let mut statement = tx
                .prepare("SELECT data FROM auth_accounts")
                .map_err(|_| "无法检查账号目录归属".to_owned())?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|_| "无法检查账号目录归属".to_owned())?;
            for row in rows {
                let other: AuthAccount =
                    serde_json::from_str(&row.map_err(|_| "无法检查账号目录归属")?)
                        .map_err(|_| "账号数据格式不兼容")?;
                for context in contexts(&other) {
                    let root = canonical_root(context);
                    if candidate
                        .iter()
                        .any(|(id, path)| **id == context.id || *path == root)
                    {
                        return Err("此原生目录已由另一账号管理，不能重复纳入".into());
                    }
                }
            }
        }
        tx.execute(
            "INSERT INTO auth_accounts(id,tool,version,data) VALUES(?1,?2,?3,?4)",
            params![account.id, account.tool_id, account.version, data],
        )
        .map_err(|_| "无法保存账号".to_owned())?;
        tx.commit().map_err(|_| "无法保存账号".to_owned())
    })
}

fn contexts(account: &AuthAccount) -> impl Iterator<Item = &NativeContext> {
    account
        .context
        .iter()
        .chain(&account.retired_contexts)
        .chain(account.pending_login.iter().map(|pending| &pending.context))
}

/// Remove management metadata only. Native credentials, resources and history stay intact.
pub fn delete(db: &Database, id: &str, expected_version: u32) -> Result<(), String> {
    db.with_connection(|conn| {
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| "无法删除账号")?;
        let data: Option<String> = tx.query_row("SELECT data FROM auth_accounts WHERE id=?1", [id], |row| row.get(0))
            .optional().map_err(|_| "无法读取账号")?;
        let account: AuthAccount = serde_json::from_str(&data.ok_or("账号不存在")?).map_err(|_| "账号数据格式不兼容")?;
        if account.version != expected_version { return Err("账号已发生变化，请重新读取".into()); }
        if account.pending_login.is_some() { return Err("请先取消正在进行的账号操作，再删除账号".into()); }
        let profile: Option<String> = tx.query_row(
            "SELECT json_extract(data, '$.name') FROM native_profiles WHERE json_extract(data, '$.authentication.accountId')=?1 LIMIT 1",
            [id], |row| row.get(0)).optional().map_err(|_| "无法检查账号引用")?;
        if let Some(name) = profile { return Err(format!("配置“{name}”仍绑定此账号，请先修改或删除配置")); }
        let query: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM usage_queries WHERE json_extract(data, '$.config.identity.accountId')=?1)",
            [id], |row| row.get(0)).map_err(|_| "无法检查额度查询引用")?;
        if query { return Err("额度查询仍引用此账号，请先修改或删除查询".into()); }
        for context in contexts(&account) {
            let bound: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM applied_bindings WHERE context_id=?1)", [&context.id], |row| row.get(0))
                .map_err(|_| "无法检查活动配置")?;
            if bound { return Err("活动配置仍使用此账号目录，请先停用或切换配置".into()); }
            let queried: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM usage_queries WHERE json_extract(data, '$.config.identity.contextId')=?1)", [&context.id], |row| row.get(0))
                .map_err(|_| "无法检查额度查询引用")?;
            if queried { return Err("额度查询仍引用此账号目录，请先修改或删除查询".into()); }
        }
        let changed = tx.execute("DELETE FROM auth_accounts WHERE id=?1 AND version=?2", params![id, expected_version]).map_err(|_| "无法删除账号")?;
        if changed != 1 { return Err("账号已发生变化，请重新读取".into()); }
        tx.commit().map_err(|_| "无法删除账号".into())
    })
}

fn canonical_root(context: &NativeContext) -> String {
    let root = context
        .root
        .canonicalize()
        .unwrap_or_else(|_| context.root.clone());
    let value = root.to_string_lossy().into_owned();
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value
    }
}

/// CAS applies to all status, logout and login completion writes. Late results never win.
pub fn replace(db: &Database, account: &mut AuthAccount) -> Result<(), String> {
    let old = account.version;
    account.version = old.checked_add(1).ok_or("账号修订耗尽")?;
    let data = serde_json::to_string(account).map_err(|_| "无法编码账号")?;
    let changed = db
        .with_connection(|conn| {
            conn.execute(
                "UPDATE auth_accounts SET version=?1,data=?2 WHERE id=?3 AND version=?4",
                params![account.version, data, account.id, old],
            )
            .map_err(|_| "无法保存账号".to_owned())
        })
        .map_err(|_| "无法保存账号")?;
    if changed != 1 {
        return Err("账号已发生变化，请重新读取".into());
    }
    Ok(())
}
