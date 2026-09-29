use std::path::Path;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::credentials::{CredentialStore, SystemCredentialStore};
use crate::database::{Database, OpenError};
use crate::domain::{Bootstrap, CliId, Theme};
use crate::native::{
    adapter::{self, Scope, ToolProbe},
    apply::{self, AppliedBinding},
    intake::{self, NativeInspection},
    models::{self, ModelDirectory},
    profile::{self, CommonConfig, Connection, NativeProfile},
    transaction::{self, ApplyOutcome},
};
use std::path::PathBuf;

#[derive(Default)]
pub struct AppState {
    database: Mutex<Option<Arc<Database>>>,
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
    fn database(&self, app: &AppHandle) -> Result<Arc<Database>, ApiError> {
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
            *current = Some(Arc::new(open_database(&directory)?));
        }
        current.as_ref().cloned().ok_or(ApiError {
            code: "storage_unavailable",
            message: "本机数据服务暂时不可用".into(),
            action: "请重新打开栖点；原数据库不会自动清空。",
            data_directory: None,
        })
    }

    fn with_database<T>(
        &self,
        app: &AppHandle,
        operation: impl FnOnce(&Database) -> Result<T, ApiError>,
    ) -> Result<T, ApiError> {
        let database = self.database(app)?;
        operation(&database)
    }
}

async fn blocking<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, ApiError> + Send + 'static,
) -> Result<T, ApiError> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|_| native_error("后台操作意外中断，请重试".into()))?
}

fn native_error(message: String) -> ApiError {
    ApiError {
        code: "native_error",
        message,
        action: "检查工具版本、原生文件和作用范围后重试；原配置不会自动清空。",
        data_directory: None,
    }
}

fn tool_path(database: &Database, tool: CliId) -> Result<Option<PathBuf>, String> {
    database.with_connection(|conn| {
        use rusqlite::OptionalExtension;
        let value: Option<String> = conn
            .query_row(
                "SELECT path FROM installation_choices WHERE tool = ?1",
                [serde_json::to_value(tool).unwrap().as_str().unwrap()],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(value.map(PathBuf::from))
    })
}

fn home() -> Result<PathBuf, ApiError> {
    dirs::home_dir().ok_or_else(|| native_error("无法定位当前用户目录".into()))
}

fn checked_project(
    scope: Scope,
    project_path: Option<String>,
) -> Result<Option<PathBuf>, ApiError> {
    if scope == Scope::Global {
        return Ok(None);
    }
    let path = PathBuf::from(project_path.ok_or_else(|| native_error("请选择项目目录".into()))?);
    let canonical = path
        .canonicalize()
        .map_err(|_| native_error("项目目录不存在或无法访问".into()))?;
    if !canonical.is_dir() {
        return Err(native_error("项目路径不是目录".into()));
    }
    Ok(Some(canonical))
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSnapshot {
    pub role: String,
    pub text: Option<String>,
    pub fingerprint: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolWorkspace {
    pub probe: ToolProbe,
    pub custom_path: Option<String>,
    pub profiles: Vec<NativeProfile>,
    pub common: Option<CommonConfig>,
    pub binding: Option<AppliedBinding>,
    pub snapshots: Vec<NativeSnapshot>,
    pub recovery_needed: Vec<String>,
}

#[tauri::command]
pub async fn get_tool_workspace(
    app: AppHandle,
    tool: CliId,
    scope: Scope,
    project_path: Option<String>,
) -> Result<ToolWorkspace, ApiError> {
    blocking(move || {
        let home = home()?;
        let project = checked_project(scope, project_path)?;
        let state = app.state::<AppState>();
        state.with_database(&app, |database| {
            let custom = tool_path(database, tool).map_err(native_error)?;
            let probe = adapter::probe(tool, custom.as_deref(), &home, project.as_deref(), scope);
            let key = match scope {
                Scope::Global => "global".into(),
                Scope::Project => format!("project:{}", project.as_ref().unwrap().display()),
            };
            let profiles = profile::list_profiles(database, tool).map_err(native_error)?;
            let common = profile::get_common(database, tool).map_err(native_error)?;
            let binding = apply::get_binding(database, tool, &key).map_err(native_error)?;
            let recovery_needed = transaction::recover_pending(database, &SystemCredentialStore)
                .map_err(native_error)?;
            let snapshots = probe
                .native_files
                .iter()
                .map(|file| {
                    if file.sensitive {
                        return NativeSnapshot {
                            role: file.role.into(),
                            text: None,
                            fingerprint: None,
                            error: Some("受保护的原生凭据文件不在通用编辑器中显示".into()),
                        };
                    }
                    match transaction::read_native(Path::new(&file.path)) {
                        Ok(text) => NativeSnapshot {
                            role: file.role.into(),
                            fingerprint: Some(transaction::fingerprint(text.as_bytes())),
                            text: Some(text),
                            error: None,
                        },
                        Err(error) => NativeSnapshot {
                            role: file.role.into(),
                            text: None,
                            fingerprint: None,
                            error: Some(error),
                        },
                    }
                })
                .collect();
            Ok(ToolWorkspace {
                probe,
                custom_path: custom.map(|path| path.display().to_string()),
                profiles,
                common,
                binding,
                snapshots,
                recovery_needed,
            })
        })
    })
    .await
}

#[tauri::command]
pub async fn set_custom_cli_path(
    app: AppHandle,
    tool: CliId,
    path: Option<String>,
) -> Result<(), ApiError> {
    blocking(move || {
        let state = app.state::<AppState>();
        state.with_database(&app, |database| {
            if let Some(path) = &path {
                let candidate = PathBuf::from(path);
                if !candidate.is_file() {
                    return Err(native_error("自定义 CLI 路径不是文件".into()));
                }
                let installation = adapter::probe_path(tool, &candidate);
                if installation.status != "available" {
                    return Err(native_error(
                        installation.detail.unwrap_or("无法确认 CLI 身份".into()),
                    ));
                }
            }
            database
                .with_connection(|conn| {
                    let key = serde_json::to_value(tool).unwrap();
                    let key = key.as_str().unwrap();
                    if let Some(path) = path {
                        conn.execute("INSERT INTO installation_choices (tool, path) VALUES (?1, ?2) ON CONFLICT(tool) DO UPDATE SET path = excluded.path", rusqlite::params![key, path]).map_err(|e| e.to_string())?;
                    } else {
                        conn.execute("DELETE FROM installation_choices WHERE tool = ?1", [key]).map_err(|e| e.to_string())?;
                    }
                    Ok(())
                })
                .map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub fn save_native_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: NativeProfile,
    expected_version: Option<u64>,
) -> Result<NativeProfile, ApiError> {
    state.with_database(&app, |database| {
        profile::save_profile(database, profile, expected_version).map_err(native_error)
    })
}

#[tauri::command]
pub fn delete_native_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    expected_version: u64,
) -> Result<(), ApiError> {
    state.with_database(&app, |database| {
        profile::delete_profile(database, &id, expected_version).map_err(native_error)
    })
}

#[tauri::command]
pub async fn save_common_config(
    app: AppHandle,
    common: CommonConfig,
    expected_version: Option<u64>,
) -> Result<CommonSaveResult, ApiError> {
    blocking(move || {
        let state = app.state::<AppState>();
        let home = home()?;
        state.with_database(&app, |database| {
            let saved =
                profile::save_common(database, common, expected_version).map_err(native_error)?;
            let tool = saved.tool;
            let custom = tool_path(database, tool).map_err(native_error)?;
            let targets: Vec<(String, String)> =
                database
                    .with_connection(|conn| {
                        let mut statement = conn
                    .prepare("SELECT scope_key, profile_id FROM applied_bindings WHERE tool = ?1")
                    .map_err(|e| e.to_string())?;
                        let rows = statement
                            .query_map(
                                [serde_json::to_value(tool).unwrap().as_str().unwrap()],
                                |row| Ok((row.get(0)?, row.get(1)?)),
                            )
                            .map_err(|e| e.to_string())?;
                        rows.map(|row| row.map_err(|e| e.to_string())).collect()
                    })
                    .map_err(native_error)?;
            let mut applications = Vec::new();
            for (scope_key, profile_id) in targets {
                let profile = match profile::get_profile(database, &profile_id) {
                    Ok(profile) => profile,
                    Err(error) => {
                        applications.push(CommonApplication {
                            scope_key,
                            status: "failed",
                            detail: Some(error),
                        });
                        continue;
                    }
                };
                if !profile.inherit_common {
                    continue;
                }
                let (scope, project) = if let Some(path) = scope_key.strip_prefix("project:") {
                    (Scope::Project, Some(PathBuf::from(path)))
                } else {
                    (Scope::Global, None)
                };
                let result = apply::apply_profile(
                    database,
                    &SystemCredentialStore,
                    tool,
                    &profile_id,
                    scope,
                    &home,
                    project.as_deref(),
                    custom.as_deref(),
                    false,
                );
                applications.push(match result {
                    Ok(outcome) => CommonApplication {
                        scope_key,
                        status: outcome.status,
                        detail: None,
                    },
                    Err(error) => CommonApplication {
                        scope_key,
                        status: "failed",
                        detail: Some(error),
                    },
                });
            }
            Ok(CommonSaveResult {
                common: saved,
                applications,
            })
        })
    })
    .await
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommonApplication {
    pub scope_key: String,
    pub status: &'static str,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommonSaveResult {
    pub common: CommonConfig,
    pub applications: Vec<CommonApplication>,
}

#[tauri::command]
pub async fn apply_native_profile(
    app: AppHandle,
    tool: CliId,
    profile_id: String,
    scope: Scope,
    project_path: Option<String>,
    allow_takeover: bool,
) -> Result<ApplyOutcome, ApiError> {
    blocking(move || {
        let state = app.state::<AppState>();
        let home = home()?;
        let project = checked_project(scope, project_path)?;
        state.with_database(&app, |database| {
            let custom = tool_path(database, tool).map_err(native_error)?;
            apply::apply_profile(
                database,
                &SystemCredentialStore,
                tool,
                &profile_id,
                scope,
                &home,
                project.as_deref(),
                custom.as_deref(),
                allow_takeover,
            )
            .map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn recover_native_transactions(app: AppHandle) -> Result<Vec<String>, ApiError> {
    blocking(move || {
        let state = app.state::<AppState>();
        state.with_database(&app, |database| {
            transaction::recover_pending(database, &SystemCredentialStore).map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn set_connection_secret(secret: String) -> Result<String, ApiError> {
    blocking(move || {
        if secret.is_empty() || secret.len() > 16_384 {
            return Err(native_error("API 密钥不能为空或超过长度限制".into()));
        }
        let id = format!("connection-{}", uuid::Uuid::new_v4());
        SystemCredentialStore
            .put(&id, &secret)
            .map_err(native_error)?;
        Ok(id)
    })
    .await
}

#[tauri::command]
pub async fn list_provider_models(
    app: AppHandle,
    connection: Connection,
    force: bool,
    query: String,
) -> Result<ModelDirectory, ApiError> {
    blocking(move || {
        let state = app.state::<AppState>();
        state.with_database(&app, |database| {
            models::list_models(database, &SystemCredentialStore, &connection, force, &query)
                .map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn test_provider_connection(
    tool: CliId,
    connection: Connection,
    allow_model_request: bool,
) -> Result<models::ConnectionCheck, ApiError> {
    blocking(move || {
        Ok(models::test_connection(
            tool,
            &connection,
            &SystemCredentialStore,
            allow_model_request,
        ))
    })
    .await
}

#[tauri::command]
pub async fn inspect_native_draft(
    tool: CliId,
    files: std::collections::BTreeMap<String, String>,
) -> Result<NativeInspection, ApiError> {
    blocking(move || intake::inspect(tool, &files).map_err(native_error)).await
}

#[tauri::command]
pub async fn prepare_native_import(
    tool: CliId,
    files: std::collections::BTreeMap<String, String>,
) -> Result<intake::NativeImport, ApiError> {
    blocking(move || {
        intake::prepare_import(tool, files, &SystemCredentialStore).map_err(native_error)
    })
    .await
}

#[tauri::command]
pub async fn set_codex_reasoning_effort(
    text: String,
    effort: Option<String>,
) -> Result<String, ApiError> {
    blocking(move || {
        intake::set_codex_reasoning_effort(&text, effort.as_deref()).map_err(native_error)
    })
    .await
}

#[tauri::command]
pub fn preview_native_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: NativeProfile,
    scope: Scope,
) -> Result<apply::NativePreview, ApiError> {
    state.with_database(&app, |database| {
        let common = profile::get_common(database, profile.tool).map_err(native_error)?;
        apply::preview(&profile, common.as_ref(), scope).map_err(native_error)
    })
}

#[tauri::command]
pub fn get_bootstrap(app: AppHandle, state: State<'_, AppState>) -> Result<Bootstrap, ApiError> {
    state.with_database(&app, |database| {
        database
            .preferences()
            .map(Bootstrap::new)
            .map_err(storage_error)
    })
}

#[tauri::command]
pub fn set_managed_tools(
    app: AppHandle,
    state: State<'_, AppState>,
    managed_tools: Vec<CliId>,
) -> Result<Bootstrap, ApiError> {
    state.with_database(&app, |database| {
        database
            .update_preferences(|preferences| preferences.set_managed(&managed_tools))
            .map(Bootstrap::new)
            .map_err(storage_error)
    })
}

#[tauri::command]
pub fn set_theme(
    app: AppHandle,
    state: State<'_, AppState>,
    theme: Theme,
) -> Result<Bootstrap, ApiError> {
    state.with_database(&app, |database| {
        database
            .update_preferences(|preferences| preferences.theme = theme)
            .map(Bootstrap::new)
            .map_err(storage_error)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slow_native_work_runs_on_background_thread() {
        let invocation_thread = std::thread::current().id();
        let worker_thread = tauri::async_runtime::block_on(blocking(move || {
            std::thread::sleep(std::time::Duration::from_millis(20));
            Ok(std::thread::current().id())
        }))
        .unwrap();
        assert_ne!(invocation_thread, worker_thread);
    }

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
        assert_eq!(
            std::fs::read(temp.path().join("cliora.db.saved")).unwrap(),
            original
        );
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
        connection
            .execute_batch("PRAGMA user_version = 99;")
            .unwrap();
        drop(connection);
        let original = std::fs::read(&file).unwrap();
        let error = open_database(temp.path()).err().unwrap();
        assert_eq!(error.code, "storage_unsupported_version");
        assert!(error.action.contains("新版"));
        assert_eq!(std::fs::read(file).unwrap(), original);
    }
}
