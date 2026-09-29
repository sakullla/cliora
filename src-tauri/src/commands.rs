use std::path::Path;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::database::{Database, OpenError};
use crate::domain::{Bootstrap, CliId, Theme};

#[derive(Default)]
pub struct AppState {
    database: Mutex<Option<Database>>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ApiError {
    pub code: &'static str,
    pub message: String,
    pub action: &'static str,
    pub data_directory: Option<String>,
}

fn storage_error(message: String) -> ApiError {
    ApiError {
        code: "storage_error",
        message,
        action: "检查本机数据目录后重试；已有设置不会自动清空。",
        data_directory: None,
    }
}

fn open_database(directory: &Path) -> Result<Database, ApiError> {
    let location = Some(directory.display().to_string());
    std::fs::create_dir_all(directory).map_err(|_| ApiError {
        code: "storage_directory",
        message: "无法创建本机数据目录".into(),
        action: "检查目录权限，修复后点击重试；原有文件不会自动删除。",
        data_directory: location.clone(),
    })?;
    Database::open(&directory.join("cliora.db")).map_err(|error| match error {
        OpenError::UnsupportedVersion(version) => ApiError {
            code: "storage_unsupported_version",
            message: format!("本机数据库版本 {version} 高于当前应用支持的版本"),
            action: "请使用兼容的新版栖点，不要删除或覆盖原数据库。",
            data_directory: location,
        },
        OpenError::Sqlite(_) => ApiError {
            code: "storage_unavailable",
            message: "无法打开本机数据库".into(),
            action: "先备份原数据库，再检查磁盘和权限；修复后点击重试。",
            data_directory: location,
        },
    })
}

impl AppState {
    fn with_database<T>(&self, app: &AppHandle, operation: impl FnOnce(&Database) -> Result<T, ApiError>) -> Result<T, ApiError> {
        let mut current = self.database.lock().map_err(|_| ApiError {
            code: "storage_unavailable",
            message: "本机数据服务暂时不可用".into(),
            action: "请重新打开栖点；原数据库不会自动清空。",
            data_directory: None,
        })?;
        if current.is_none() {
            let directory = app.path().app_data_dir().map_err(|_| ApiError {
                code: "storage_directory",
                message: "无法定位本机数据目录".into(),
                action: "检查系统用户目录后点击重试。",
                data_directory: None,
            })?;
            *current = Some(open_database(&directory)?);
        }
        match current.as_ref() {
            Some(database) => operation(database),
            None => Err(ApiError {
                code: "storage_unavailable",
                message: "本机数据服务暂时不可用".into(),
                action: "请重新打开栖点；原数据库不会自动清空。",
                data_directory: None,
            }),
        }
    }
}

#[tauri::command]
pub fn get_bootstrap(app: AppHandle, state: State<'_, AppState>) -> Result<Bootstrap, ApiError> {
    state.with_database(&app, |database| {
        database.preferences().map(Bootstrap::new).map_err(storage_error)
    })
}

#[tauri::command]
pub fn set_managed_tools(
    app: AppHandle,
    state: State<'_, AppState>,
    managed_tools: Vec<CliId>,
) -> Result<Bootstrap, ApiError> {
    state.with_database(&app, |database| {
        database.update_preferences(|preferences| preferences.set_managed(&managed_tools))
            .map(Bootstrap::new).map_err(storage_error)
    })
}

#[tauri::command]
pub fn set_theme(app: AppHandle, state: State<'_, AppState>, theme: Theme) -> Result<Bootstrap, ApiError> {
    state.with_database(&app, |database| {
        database.update_preferences(|preferences| preferences.theme = theme)
            .map(Bootstrap::new).map_err(storage_error)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn damaged_database_is_preserved_and_can_be_retried_after_external_repair() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("cliora.db");
        let original = b"not a sqlite database";
        std::fs::write(&file, original).unwrap();
        let error = open_database(temp.path()).err().unwrap();
        assert_eq!(error.code, "storage_unavailable");
        assert_eq!(std::fs::read(&file).unwrap(), original);

        std::fs::rename(&file, temp.path().join("cliora.db.saved")).unwrap();
        assert!(open_database(temp.path()).is_ok());
        assert_eq!(std::fs::read(temp.path().join("cliora.db.saved")).unwrap(), original);
    }

    #[test]
    fn blocked_data_directory_keeps_existing_file_and_returns_recovery_action() {
        let temp = tempfile::tempdir().unwrap();
        let blocked = temp.path().join("blocked");
        std::fs::write(&blocked, b"keep me").unwrap();
        let error = open_database(&blocked).err().unwrap();
        assert_eq!(error.code, "storage_directory");
        assert!(error.action.contains("重试"));
        assert_eq!(std::fs::read(blocked).unwrap(), b"keep me");
    }

    #[test]
    fn newer_database_shows_upgrade_action_without_changing_original() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("cliora.db");
        let connection = rusqlite::Connection::open(&file).unwrap();
        connection.execute_batch("PRAGMA user_version = 99;").unwrap();
        drop(connection);
        let original = std::fs::read(&file).unwrap();
        let error = open_database(temp.path()).err().unwrap();
        assert_eq!(error.code, "storage_unsupported_version");
        assert!(error.action.contains("新版"));
        assert_eq!(std::fs::read(file).unwrap(), original);
    }
}
