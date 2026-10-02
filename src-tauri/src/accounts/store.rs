use super::AuthAccount;
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
        conn.execute(
            "INSERT INTO auth_accounts(id,tool,version,data) VALUES(?1,?2,?3,?4)",
            params![account.id, account.tool_id, account.version, data],
        )
        .map_err(|_| "无法保存账号".to_owned())
    })
    .map(|_| ())
    .map_err(|_| "无法保存账号".into())
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
