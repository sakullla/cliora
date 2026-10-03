use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use uuid::Uuid;

use crate::database::Database;
use crate::adapters::Registry;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: Option<String>,
    pub available: bool,
    pub preferred_tool: Option<String>,
    pub last_opened: u64,
    pub model_overrides: BTreeMap<String, String>,
    pub selected_profiles: BTreeMap<String, String>,
    pub applied_profiles: BTreeMap<String, String>,
    pub reapply_profiles: BTreeMap<String, String>,
}

fn timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

pub fn checked_directory(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value);
    let canonical = path
        .canonicalize()
        .map_err(|_| "项目目录不存在或无法访问，请重新关联目录".to_owned())?;
    if !canonical.is_dir() {
        return Err("项目路径不是目录".into());
    }
    Ok(canonical)
}

fn directory_text(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| "项目目录名称无法用当前系统文字编码表示".into())
}

fn checked_tool(registry: &Registry, tool: Option<&str>) -> Result<(), String> {
    if tool.is_some_and(|id| registry.get(id).is_none()) {
        return Err("未注册的 CLI 不能用于项目启动".into());
    }
    Ok(())
}

pub fn list(db: &Database) -> Result<Vec<Project>, String> {
    db.with_connection(|conn| {
        let mut statement = conn
            .prepare("SELECT id, name, path, preferred_tool, last_opened FROM projects ORDER BY last_opened DESC, name ASC")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        let mut projects = Vec::new();
        for row in rows {
            let (id, name, path, preferred_tool, last_opened) =
                row.map_err(|error| error.to_string())?;
            let mut models = conn
                .prepare("SELECT tool, model FROM project_tool_models WHERE project_id = ?1")
                .map_err(|error| error.to_string())?;
            let model_overrides = models
                .query_map([&id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .map_err(|error| error.to_string())?
                .collect::<Result<BTreeMap<_, _>, _>>()
                .map_err(|error| error.to_string())?;
            let mut selections = conn
                .prepare("SELECT tool, profile_id FROM project_tool_selections WHERE project_id = ?1")
                .map_err(|error| error.to_string())?;
            let selected_profiles = selections
                .query_map([&id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .map_err(|error| error.to_string())?
                .collect::<Result<BTreeMap<_, _>, _>>()
                .map_err(|error| error.to_string())?;
            let mut bindings = conn
                .prepare("SELECT b.tool, b.profile_id FROM applied_bindings b
                          JOIN native_profiles p ON p.id = b.profile_id AND p.version = b.profile_version
                          WHERE b.scope_key = ?1")
                .map_err(|error| error.to_string())?;
            let scope_key = path.as_ref().map(|path| format!("project:{path}"));
            let applied_profiles = match scope_key {
                Some(key) => bindings
                    .query_map([key], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                    .map_err(|error| error.to_string())?
                    .collect::<Result<BTreeMap<_, _>, _>>()
                    .map_err(|error| error.to_string())?,
                None => BTreeMap::new(),
            };
            let available = path.as_ref().is_some_and(|value| Path::new(value).is_dir());
            let mut reapply_profiles = BTreeMap::new();
            if let Some(path) = &path {
                for (tool, profile) in &selected_profiles {
                    // A binding at these files keeps its old applied content even if new
                    // database content is pending. Only directory recovery may auto-apply.
                    let directory_recovery: bool = conn.query_row(
                        "SELECT NOT EXISTS(SELECT 1 FROM applied_bindings WHERE scope_key=?1 AND tool=?2)
                         AND NOT EXISTS(SELECT 1 FROM applied_bindings WHERE profile_id=?3 AND profile_version<0)",
                        params![format!("project:{path}"), tool, profile], |row| row.get(0),
                    ).map_err(|error| error.to_string())?;
                    if directory_recovery { reapply_profiles.insert(tool.clone(), profile.clone()); }
                }
            }
            projects.push(Project {
                id,
                name,
                path,
                available,
                preferred_tool,
                last_opened: last_opened.max(0) as u64,
                model_overrides,
                selected_profiles,
                applied_profiles,
                reapply_profiles,
            });
        }
        Ok(projects)
    })
}

pub fn get(db: &Database, id: &str) -> Result<Project, String> {
    list(db)?
        .into_iter()
        .find(|project| project.id == id)
        .ok_or_else(|| "项目不存在，请重新选择".into())
}

pub fn add(
    db: &Database,
    registry: &Registry,
    path: &str,
    name: Option<&str>,
    preferred_tool: Option<&str>,
) -> Result<Project, String> {
    checked_tool(registry, preferred_tool)?;
    let canonical = checked_directory(path)?;
    let path = directory_text(&canonical)?;
    let explicit_name = name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let name = explicit_name
        .clone()
        .or_else(|| canonical.file_name()?.to_str().map(str::to_owned))
        .unwrap_or_else(|| path.clone());
    if name.chars().count() > 120 {
        return Err("项目名称不能超过 120 个字符".into());
    }
    let id = db.with_connection(|conn| {
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        let existing: Option<String> = tx
            .query_row("SELECT id FROM projects WHERE path = ?1", [&path], |row| row.get(0))
            .optional()
            .map_err(|error| error.to_string())?;
        let id = existing.unwrap_or_else(|| Uuid::new_v4().to_string());
        tx.execute(
            "INSERT INTO projects (id, name, path, preferred_tool, last_opened) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET name = COALESCE(?6, projects.name), preferred_tool = COALESCE(excluded.preferred_tool, projects.preferred_tool), last_opened = excluded.last_opened",
            params![id, name, path, preferred_tool, timestamp() as i64, explicit_name],
        )
        .map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(id)
    })?;
    get(db, &id)
}

pub fn rename(db: &Database, id: &str, name: &str) -> Result<Project, String> {
    let name = name.trim(); if name.is_empty() || name.chars().count() > 120 { return Err("项目名称须为 1–120 个字符".into()); }
    db.with_connection(|conn| conn.execute("UPDATE projects SET name=?2 WHERE id=?1", params![id,name]).map(|_| ()).map_err(|e| e.to_string()))?;
    get(db,id)
}
pub fn remove(db: &Database, id: &str) -> Result<(), String> {
    get(db,id)?;
    db.with_connection(|conn| {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute("UPDATE history_sessions SET project_id=NULL WHERE project_id=?1", [id]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM projects WHERE id=?1", [id]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    })
}

pub fn relink(db: &Database, id: &str, path: &str) -> Result<Project, String> {
    let path = directory_text(&checked_directory(path)?)?;
    db.with_connection(|conn| {
        let changed = conn
            .execute(
                "UPDATE projects SET path = ?1 WHERE id = ?2",
                params![path, id],
            )
            .map_err(|error| format!("无法重新关联目录；该目录可能已属于其他项目：{error}"))?;
        if changed == 0 {
            return Err("项目不存在，请重新选择".into());
        }
        Ok(())
    })?;
    get(db, id)
}

pub fn set_preferred_tool(
    db: &Database,
    registry: &Registry,
    id: &str,
    tool: Option<&str>,
) -> Result<Project, String> {
    checked_tool(registry, tool)?;
    db.with_connection(|conn| {
        let changed = conn
            .execute(
                "UPDATE projects SET preferred_tool = ?1 WHERE id = ?2",
                params![tool, id],
            )
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            return Err("项目不存在，请重新选择".into());
        }
        Ok(())
    })?;
    get(db, id)
}

pub fn set_model_override(
    db: &Database,
    registry: &Registry,
    project_id: &str,
    tool_id: &str,
    model: Option<&str>,
) -> Result<Project, String> {
    let adapter = registry
        .get(tool_id)
        .ok_or("未注册的 CLI 不能设置项目模型")?;
    if !adapter.supports_project_model_override() {
        return Err("此 CLI 不支持独立的项目启动模型覆盖".into());
    }
    let model = model.map(str::trim).filter(|value| !value.is_empty());
    if model.is_some_and(|value| value.chars().count() > 200 || value.chars().any(char::is_control))
    {
        return Err("模型 ID 不能超过 200 字符或包含控制字符".into());
    }
    db.with_connection(|conn| {
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        let exists: bool = tx
            .query_row("SELECT 1 FROM projects WHERE id = ?1", [project_id], |_| {
                Ok(true)
            })
            .optional()
            .map_err(|error| error.to_string())?
            .unwrap_or(false);
        if !exists {
            return Err("项目不存在，请重新选择".into());
        }
        match model {
            Some(value) => {
                tx.execute(
                    "INSERT INTO project_tool_models (project_id, tool, model) VALUES (?1, ?2, ?3)
                     ON CONFLICT(project_id, tool) DO UPDATE SET model = excluded.model",
                    params![project_id, tool_id, value],
                )
                .map_err(|error| error.to_string())?;
            }
            None => {
                tx.execute(
                    "DELETE FROM project_tool_models WHERE project_id = ?1 AND tool = ?2",
                    params![project_id, tool_id],
                )
                .map_err(|error| error.to_string())?;
            }
        }
        tx.commit().map_err(|error| error.to_string())?;
        Ok(())
    })?;
    get(db, project_id)
}

pub fn touch(db: &Database, project_id: &str) -> Result<(), String> {
    db.with_connection(|conn| {
        let changed = conn
            .execute(
                "UPDATE projects SET last_opened = ?1 WHERE id = ?2",
                params![timestamp() as i64, project_id],
            )
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            return Err("项目不存在，请重新选择".into());
        }
        Ok(())
    })
}

/// A project keeps its chosen profile identity after its local directory moves.
/// An applied binding remains tied to the old files and must be reapplied in the new directory.
pub fn record_applied_profile(
    db: &Database,
    path: &Path,
    tool: &str,
    profile_id: &str,
) -> Result<(), String> {
    let path = directory_text(&checked_directory(
        path.to_str().ok_or("项目目录名称无法识别")?,
    )?)?;
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO project_tool_selections (project_id, tool, profile_id)
             SELECT id, ?2, ?3 FROM projects WHERE path = ?1
             ON CONFLICT(project_id, tool) DO UPDATE SET profile_id = excluded.profile_id",
            params![path, tool, profile_id],
        )
        .map_err(|error| error.to_string())?;
        Ok(())
    })
}

pub fn open_directory(db: &Database, project_id: &str) -> Result<(), String> {
    let project = get(db, project_id)?;
    let path = checked_directory(project.path.as_deref().ok_or("项目尚未关联本机目录")?)?;
    let program = if cfg!(windows) {
        "explorer.exe"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(program)
        .arg(path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|error| format!("无法打开项目目录，请检查系统文件管理器：{error}"))?;
    Ok(())
}

#[cfg(test)]
#[path = "../../tests/launch/projects.rs"]
mod tests;
