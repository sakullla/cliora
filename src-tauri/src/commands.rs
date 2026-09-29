use serde::Serialize;
use tauri::State;

use crate::database::Database;
use crate::domain::{Bootstrap, CliId, Theme};

pub struct AppState {
    pub database: Database,
}

#[derive(Debug, Serialize)]
pub struct ApiError {
    pub code: &'static str,
    pub message: String,
    pub action: &'static str,
}

fn storage_error(message: String) -> ApiError {
    ApiError {
        code: "storage_error",
        message,
        action: "检查本机数据目录后重试；已有设置不会自动清空。",
    }
}

#[tauri::command]
pub fn get_bootstrap(state: State<'_, AppState>) -> Result<Bootstrap, ApiError> {
    state
        .database
        .preferences()
        .map(Bootstrap::new)
        .map_err(storage_error)
}

#[tauri::command]
pub fn set_managed_tools(
    state: State<'_, AppState>,
    managed_tools: Vec<CliId>,
) -> Result<Bootstrap, ApiError> {
    let preferences = state.database
        .update_preferences(|preferences| preferences.set_managed(&managed_tools))
        .map_err(storage_error)?;
    Ok(Bootstrap::new(preferences))
}

#[tauri::command]
pub fn set_theme(state: State<'_, AppState>, theme: Theme) -> Result<Bootstrap, ApiError> {
    let preferences = state.database
        .update_preferences(|preferences| preferences.theme = theme)
        .map_err(storage_error)?;
    Ok(Bootstrap::new(preferences))
}
