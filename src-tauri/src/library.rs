use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::database::Database;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LibraryKind {
    Prompt,
    Rule,
}

impl LibraryKind {
    fn text(self) -> &'static str {
        match self {
            Self::Prompt => "prompt",
            Self::Rule => "rule",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryItem {
    pub id: String,
    pub kind: LibraryKind,
    pub title: String,
    pub body: String,
    pub category: String,
    pub project_id: Option<String>,
    pub version: u64,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryDraft {
    pub id: Option<String>,
    pub kind: LibraryKind,
    pub title: String,
    pub body: String,
    pub category: String,
    pub project_id: Option<String>,
    pub expected_version: Option<u64>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| time.as_secs())
}

fn row_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryItem> {
    let kind: String = row.get(1)?;
    Ok(LibraryItem {
        id: row.get(0)?,
        kind: if kind == "rule" {
            LibraryKind::Rule
        } else {
            LibraryKind::Prompt
        },
        title: row.get(2)?,
        body: row.get(3)?,
        category: row.get(4)?,
        project_id: row.get(5)?,
        version: row.get::<_, i64>(6)?.max(0) as u64,
        updated_at: row.get::<_, i64>(7)?.max(0) as u64,
    })
}

pub fn list(
    db: &Database,
    kind: LibraryKind,
    project_id: Option<&str>,
    search: &str,
) -> Result<Vec<LibraryItem>, String> {
    let search = search.trim().to_lowercase();
    db.with_connection(|conn| {
        let mut statement = conn
            .prepare(
                "SELECT id, kind, title, body, category, project_id, version, updated_at
             FROM library_items WHERE kind = ?1 ORDER BY updated_at DESC, title COLLATE NOCASE",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([kind.text()], row_item)
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    })
    .map(|items| {
        items
            .into_iter()
            .filter(|item| {
                project_id.is_none_or(|id| item.project_id.as_deref() == Some(id))
                    && (search.is_empty()
                        || [
                            item.title.as_str(),
                            item.body.as_str(),
                            item.category.as_str(),
                        ]
                        .iter()
                        .any(|value| value.to_lowercase().contains(&search)))
            })
            .collect()
    })
}

pub fn get(db: &Database, id: &str) -> Result<LibraryItem, String> {
    db.with_connection(|conn| {
        conn.query_row(
            "SELECT id, kind, title, body, category, project_id, version, updated_at FROM library_items WHERE id = ?1",
            [id], row_item,
        ).optional().map_err(|error| error.to_string())?
            .ok_or_else(|| "资料条目不存在".into())
    })
}

pub fn save(db: &Database, mut draft: LibraryDraft) -> Result<LibraryItem, String> {
    draft.title = draft.title.trim().to_owned();
    draft.category = draft.category.trim().to_owned();
    draft.project_id = draft.project_id.filter(|id| !id.trim().is_empty());
    if draft.title.is_empty() || draft.title.chars().count() > 160 {
        return Err("标题需为 1 至 160 个字符".into());
    }
    if draft.category.chars().count() > 80 {
        return Err("分类不能超过 80 个字符".into());
    }
    if draft.body.len() > 1_000_000 {
        return Err("正文不能超过 1 MB".into());
    }
    let id = draft.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let stamp = now() as i64;
    db.with_connection(|conn| {
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        if let Some(project_id) = draft.project_id.as_deref() {
            let present: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)", [project_id], |row| row.get(0)).map_err(|error| error.to_string())?;
            if !present { return Err("项目已不存在，请重新选择".into()); }
        }
        let changed = match draft.expected_version {
            Some(version) => tx.execute(
                "UPDATE library_items SET title = ?2, body = ?3, category = ?4, project_id = ?5, version = version + 1, updated_at = ?6
                 WHERE id = ?1 AND kind = ?7 AND version = ?8",
                params![id, draft.title, draft.body, draft.category, draft.project_id, stamp, draft.kind.text(), version as i64],
            ),
            None => tx.execute(
                "INSERT INTO library_items (id, kind, title, body, category, project_id, version, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7)",
                params![id, draft.kind.text(), draft.title, draft.body, draft.category, draft.project_id, stamp],
            ),
        }.map_err(|error| error.to_string())?;
        if changed != 1 { return Err("资料已在其他窗口更改，请重新读取后再保存".into()); }
        tx.commit().map_err(|error| error.to_string())
    })?;
    get(db, &id)
}

pub fn delete(db: &Database, id: &str, expected_version: u64) -> Result<(), String> {
    db.with_connection(|conn| {
        let changed = conn
            .execute(
                "DELETE FROM library_items WHERE id = ?1 AND version = ?2",
                params![id, expected_version as i64],
            )
            .map_err(|error| error.to_string())?;
        if changed != 1 {
            return Err("资料已在其他窗口更改，请重新读取后再删除".into());
        }
        Ok(())
    })
}

#[cfg(test)]
#[path = "../../tests/resources/library.rs"]
mod tests;
