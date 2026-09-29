use std::path::Path;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::credentials::{CredentialStore, SystemCredentialStore};
use crate::database::{Database, OpenError};
use crate::domain::{Bootstrap, CliId, Theme};
use crate::native::{
    adapter::{self, Scope, ToolProbe},
    adapters::{self, AdapterCatalog, UnknownAdapterRecord},
    apply::{self, AppliedBinding},
    intake::{self, NativeInspection},
    models::{self, ModelDirectory},
    profile::{self, CommonConfig, Connection, NativeProfile, RegisteredCommon, RegisteredProfile},
    transaction::{self, ApplyOutcome},
};
use crate::{launch, projects};
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

    pub(crate) fn with_database<T>(
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

pub(crate) fn native_error(message: String) -> ApiError {
    ApiError {
        code: "native_error",
        message,
        action: "检查工具版本、原生文件和作用范围后重试；原配置不会自动清空。",
        data_directory: None,
    }
}

fn tool_path(database: &Database, tool: CliId) -> Result<Option<PathBuf>, String> {
    registered_tool_path(database, tool.stable_id())
}

fn registered_tool_path(database: &Database, tool: &str) -> Result<Option<PathBuf>, String> {
    database.with_connection(|conn| {
        use rusqlite::OptionalExtension;
        let value: Option<String> = conn
            .query_row(
                "SELECT path FROM installation_choices WHERE tool = ?1",
                [tool],
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

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredToolWorkspace {
    pub probe: ToolProbe,
    pub custom_path: Option<String>,
    pub profiles: Vec<RegisteredProfile>,
    pub common: Option<RegisteredCommon>,
    pub binding: Option<AppliedBinding>,
    pub snapshots: Vec<NativeSnapshot>,
    pub recovery_needed: Vec<String>,
}

fn native_snapshot(file: &adapter::NativeFile) -> NativeSnapshot {
    if file.sensitive {
        return NativeSnapshot {
            role: file.role.into(),
            text: None,
            fingerprint: None,
            error: Some("受保护的原生凭据文件不在通用编辑器中显示".into()),
        };
    }
    match transaction::read_native(Path::new(&file.path)) {
        Ok(_) if Path::new(&file.path).is_file() => NativeSnapshot {
            role: file.role.into(),
            fingerprint: Some("present".into()),
            text: None,
            error: Some("点击“编辑当前磁盘原文”可查看和修改完整文件".into()),
        },
        Ok(_) => NativeSnapshot {
            role: file.role.into(),
            fingerprint: None,
            text: None,
            error: Some("文件尚不存在".into()),
        },
        Err(error) => NativeSnapshot {
            role: file.role.into(),
            fingerprint: None,
            text: None,
            error: Some(error),
        },
    }
}

#[tauri::command]
pub async fn get_registered_tool_workspace(
    app: AppHandle,
    tool_id: String,
    scope: Scope,
    project_path: Option<String>,
) -> Result<RegisteredToolWorkspace, ApiError> {
    blocking(move || {
        let home = home()?;
        let project = checked_project(scope, project_path)?;
        let registry = adapters::Registry::builtins();
        if registry.get(&tool_id).is_none() {
            return Err(native_error("此 CLI 适配器未注册；已有资料只读保留".into()));
        }
        let state = app.state::<AppState>();
        state.with_database(&app, |database| {
            let custom = registered_tool_path(database, &tool_id).map_err(native_error)?;
            let probe = adapter::probe_registered(
                &registry,
                &tool_id,
                custom.as_deref(),
                &home,
                project.as_deref(),
                scope,
            )
            .map_err(native_error)?;
            let key = match scope {
                Scope::Global => "global".into(),
                Scope::Project => format!("project:{}", project.as_ref().unwrap().display()),
            };
            let profiles =
                profile::list_registered_profiles(database, &tool_id).map_err(native_error)?;
            let common =
                profile::get_registered_common(database, &tool_id).map_err(native_error)?;
            let recovery_needed = transaction::recover_pending(database, &SystemCredentialStore)
                .map_err(native_error)?;
            let binding = apply::get_registered_binding(database, &tool_id, &key)
                .map_err(native_error)?
                .map(|mut binding| {
                    binding.managed.clear();
                    binding
                });
            let snapshots = probe.native_files.iter().map(native_snapshot).collect();
            Ok(RegisteredToolWorkspace {
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
            let recovery_needed = transaction::recover_pending(database, &SystemCredentialStore)
                .map_err(native_error)?;
            let binding = apply::get_binding(database, tool, &key)
                .map_err(native_error)?
                .map(|mut binding| {
                    // The page only needs identity/version. Legacy secret
                    // digests may await migration while Keyring is locked.
                    binding.managed.clear();
                    binding
                });
            let snapshots = probe.native_files.iter().map(native_snapshot).collect();
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
    let saved = state.with_database(&app, |database| {
        profile::save_profile(database, profile, expected_version).map_err(native_error)
    })?;
    let _ = app.emit("cliora:bindings-changed", saved.tool.stable_id());
    Ok(saved)
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
    })?;
    let _ = app.emit("cliora:bindings-changed", "profiles");
    Ok(())
}

#[tauri::command]
pub async fn save_common_config(
    app: AppHandle,
    common: CommonConfig,
    expected_version: Option<u64>,
) -> Result<CommonSaveResult, ApiError> {
    let notify = app.clone();
    let result = blocking(move || {
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
    .await?;
    let _ = notify.emit("cliora:bindings-changed", result.common.tool.stable_id());
    Ok(result)
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
        apply_registered_now(
            &app,
            tool.stable_id(),
            &profile_id,
            scope,
            project_path,
            allow_takeover,
        )
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
pub async fn test_registered_provider_connection(
    tool_id: String,
    connection: Connection,
    allow_model_request: bool,
) -> Result<models::ConnectionCheck, ApiError> {
    blocking(move || {
        Ok(models::test_registered_connection(
            &adapters::Registry::builtins(),
            &tool_id,
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

/// Read selected disk roles inside Rust so raw native credentials never cross
/// the workspace IPC boundary before they are moved to the credential store.
#[tauri::command]
pub async fn prepare_native_import_from_disk(
    app: AppHandle,
    tool: CliId,
    scope: Scope,
    project_path: Option<String>,
    roles: Vec<String>,
    mut files: std::collections::BTreeMap<String, String>,
) -> Result<intake::NativeImport, ApiError> {
    blocking(move || {
        if roles.is_empty() {
            return Err(native_error("请选择要接入的原生文件".into()));
        }
        let home = home()?;
        let project = checked_project(scope, project_path)?;
        let state = app.state::<AppState>();
        state.with_database(&app, |database| {
            let custom = tool_path(database, tool).map_err(native_error)?;
            let probe = adapter::probe(tool, custom.as_deref(), &home, project.as_deref(), scope);
            for role in &roles {
                let text = adapters::read_registered_file(
                    &adapters::Registry::builtins(),
                    tool.stable_id(),
                    role,
                    scope,
                    &home,
                    project.as_deref(),
                    probe.native_writes.state == "supported",
                )
                .map_err(native_error)?;
                if text.trim().is_empty() {
                    files.remove(role);
                } else {
                    files.insert(role.clone(), text);
                }
            }
            intake::prepare_import(tool, files, &SystemCredentialStore).map_err(native_error)
        })
    })
    .await
}

/// Explicit native-editor action. This is deliberately separate from the
/// background workspace snapshot, which never returns known raw credentials.
#[tauri::command]
pub async fn read_native_file_for_edit(
    app: AppHandle,
    tool: CliId,
    scope: Scope,
    project_path: Option<String>,
    role: String,
) -> Result<String, ApiError> {
    blocking(move || {
        let home = home()?;
        let project = checked_project(scope, project_path)?;
        let state = app.state::<AppState>();
        state.with_database(&app, |database| {
            let custom = tool_path(database, tool).map_err(native_error)?;
            let probe = adapter::probe(tool, custom.as_deref(), &home, project.as_deref(), scope);
            adapters::read_registered_file(
                &adapters::Registry::builtins(),
                tool.stable_id(),
                &role,
                scope,
                &home,
                project.as_deref(),
                probe.native_writes.state == "supported",
            )
            .map_err(native_error)
        })
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
pub async fn set_registered_custom_cli_path(
    app: AppHandle,
    tool_id: String,
    path: Option<String>,
) -> Result<(), ApiError> {
    blocking(move || {
        let registry = adapters::Registry::builtins();
        if registry.get(&tool_id).is_none() { return Err(native_error("此 CLI 适配器未注册".into())); }
        let state = app.state::<AppState>();
        state.with_database(&app, |database| {
            if let Some(path) = &path {
                let candidate = PathBuf::from(path);
                if !candidate.is_file() { return Err(native_error("自定义 CLI 路径不是文件".into())); }
                let installation = adapter::probe_registered_path(&registry, &tool_id, &candidate).map_err(native_error)?;
                if installation.status != "available" { return Err(native_error(installation.detail.unwrap_or("无法确认 CLI 身份".into()))); }
            }
            database.with_connection(|conn| {
                if let Some(path) = path {
                    conn.execute("INSERT INTO installation_choices (tool, path) VALUES (?1, ?2) ON CONFLICT(tool) DO UPDATE SET path = excluded.path", rusqlite::params![tool_id, path]).map_err(|e| e.to_string())?;
                } else {
                    conn.execute("DELETE FROM installation_choices WHERE tool = ?1", [&tool_id]).map_err(|e| e.to_string())?;
                }
                Ok(())
            }).map_err(native_error)
        })
    }).await
}

#[tauri::command]
pub fn save_registered_native_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: RegisteredProfile,
    expected_version: Option<u64>,
) -> Result<RegisteredProfile, ApiError> {
    let saved = state.with_database(&app, |database| {
        profile::save_registered_profile(
            database,
            &adapters::Registry::builtins(),
            profile,
            expected_version,
        )
        .map_err(native_error)
    })?;
    let _ = app.emit("cliora:bindings-changed", saved.tool.clone());
    Ok(saved)
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredCommonSaveResult {
    pub common: RegisteredCommon,
    pub applications: Vec<CommonApplication>,
}

#[tauri::command]
pub async fn save_registered_common_config(
    app: AppHandle,
    common: RegisteredCommon,
    expected_version: Option<u64>,
) -> Result<RegisteredCommonSaveResult, ApiError> {
    let notify = app.clone();
    let result = blocking(move || {
        let state = app.state::<AppState>();
        let home = home()?;
        state.with_database(&app, |database| {
            let registry = adapters::Registry::builtins();
            let saved =
                profile::save_registered_common(database, &registry, common, expected_version)
                    .map_err(native_error)?;
            let custom = registered_tool_path(database, &saved.tool).map_err(native_error)?;
            let targets: Vec<(String, String)> = database
                .with_connection(|conn| {
                    let mut statement = conn
                        .prepare(
                            "SELECT scope_key, profile_id FROM applied_bindings WHERE tool = ?1",
                        )
                        .map_err(|e| e.to_string())?;
                    let rows = statement
                        .query_map([&saved.tool], |row| Ok((row.get(0)?, row.get(1)?)))
                        .map_err(|e| e.to_string())?;
                    rows.map(|row| row.map_err(|e| e.to_string())).collect()
                })
                .map_err(native_error)?;
            let mut applications = Vec::new();
            for (scope_key, profile_id) in targets {
                let profile = match profile::get_registered_profile(database, &profile_id) {
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
                let result = apply::apply_registered_profile(
                    &registry,
                    database,
                    &SystemCredentialStore,
                    &saved.tool,
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
            Ok(RegisteredCommonSaveResult {
                common: saved,
                applications,
            })
        })
    })
    .await?;
    let _ = notify.emit("cliora:bindings-changed", result.common.tool.clone());
    Ok(result)
}

#[tauri::command]
pub async fn apply_registered_native_profile(
    app: AppHandle,
    tool_id: String,
    profile_id: String,
    scope: Scope,
    project_path: Option<String>,
    allow_takeover: bool,
) -> Result<ApplyOutcome, ApiError> {
    blocking(move || {
        apply_registered_now(
            &app,
            &tool_id,
            &profile_id,
            scope,
            project_path,
            allow_takeover,
        )
    })
    .await
}

pub(crate) fn apply_registered_now(
    app: &AppHandle,
    tool_id: &str,
    profile_id: &str,
    scope: Scope,
    project_path: Option<String>,
    allow_takeover: bool,
) -> Result<ApplyOutcome, ApiError> {
    let home = home()?;
    let project = checked_project(scope, project_path)?;
    let state = app.state::<AppState>();
    let result = state.with_database(app, |database| {
        let custom = registered_tool_path(database, tool_id).map_err(native_error)?;
        let result = apply::apply_registered_profile(
            &adapters::Registry::builtins(),
            database,
            &SystemCredentialStore,
            tool_id,
            profile_id,
            scope,
            &home,
            project.as_deref(),
            custom.as_deref(),
            allow_takeover,
        )
        .map_err(native_error)?;
        if let Some(path) = project.as_deref() {
            if let Err(error) =
                projects::record_applied_profile(database, path, tool_id, profile_id)
            {
                let _ = app.emit(
                    "cliora:tray-error",
                    format!("配置已应用，但项目快捷选择未能保存：{error}"),
                );
            }
        }
        Ok(result)
    })?;
    let _ = app.emit("cliora:bindings-changed", tool_id);
    Ok(result)
}

#[tauri::command]
pub async fn list_projects(app: AppHandle) -> Result<Vec<projects::Project>, ApiError> {
    blocking(move || {
        app.state::<AppState>()
            .with_database(&app, |db| projects::list(db).map_err(native_error))
    })
    .await
}

#[tauri::command]
pub async fn add_project(
    app: AppHandle,
    project_path: String,
    name: Option<String>,
    preferred_tool: Option<String>,
) -> Result<projects::Project, ApiError> {
    let notify = app.clone();
    let project = blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            projects::add(
                db,
                &adapters::Registry::builtins(),
                &project_path,
                name.as_deref(),
                preferred_tool.as_deref(),
            )
            .map_err(native_error)
        })
    })
    .await?;
    let _ = notify.emit("cliora:projects-changed", &project.id);
    Ok(project)
}

#[tauri::command]
pub async fn relink_project(
    app: AppHandle,
    project_id: String,
    project_path: String,
) -> Result<projects::Project, ApiError> {
    let notify = app.clone();
    let project = blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            projects::relink(db, &project_id, &project_path).map_err(native_error)
        })
    })
    .await?;
    let _ = notify.emit("cliora:projects-changed", &project.id);
    Ok(project)
}

#[tauri::command]
pub async fn open_project_directory(app: AppHandle, project_id: String) -> Result<(), ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            projects::open_directory(db, &project_id).map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn set_project_tool(
    app: AppHandle,
    project_id: String,
    tool_id: Option<String>,
) -> Result<projects::Project, ApiError> {
    let notify = app.clone();
    let project = blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            projects::set_preferred_tool(
                db,
                &adapters::Registry::builtins(),
                &project_id,
                tool_id.as_deref(),
            )
            .map_err(native_error)
        })
    })
    .await?;
    let _ = notify.emit("cliora:projects-changed", &project.id);
    Ok(project)
}

#[tauri::command]
pub async fn set_project_model_override(
    app: AppHandle,
    project_id: String,
    tool_id: String,
    model: Option<String>,
) -> Result<projects::Project, ApiError> {
    let notify = app.clone();
    let project = blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            projects::set_model_override(
                db,
                &adapters::Registry::builtins(),
                &project_id,
                &tool_id,
                model.as_deref(),
            )
            .map_err(native_error)
        })
    })
    .await?;
    let _ = notify.emit("cliora:projects-changed", &project.id);
    Ok(project)
}

#[tauri::command]
pub async fn get_launch_settings(app: AppHandle) -> Result<launch::LaunchSettings, ApiError> {
    blocking(move || {
        app.state::<AppState>()
            .with_database(&app, |db| launch::settings(db).map_err(native_error))
    })
    .await
}

#[tauri::command]
pub async fn set_preferred_terminal(
    app: AppHandle,
    terminal: launch::TerminalId,
) -> Result<launch::LaunchSettings, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            launch::set_terminal(db, terminal).map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn launch_cli(
    app: AppHandle,
    request: launch::LaunchRequest,
) -> Result<launch::LaunchResult, ApiError> {
    blocking(move || launch_now(&app, request)).await
}

#[tauri::command]
pub fn get_tray_status(app: AppHandle) -> crate::tray::TrayStatus {
    app.state::<crate::tray::TrayState>().status()
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

pub(crate) fn launch_now(
    app: &AppHandle,
    request: launch::LaunchRequest,
) -> Result<launch::LaunchResult, ApiError> {
    let home = home()?;
    let project_id = request.project_id.clone();
    if let Some(id) = project_id.as_deref() {
        let pending = app.state::<AppState>().with_database(app, |db| {
            let project = projects::get(db, id).map_err(native_error)?;
            let selected = project.selected_profiles.get(&request.tool_id);
            Ok(selected
                .filter(|profile| project.applied_profiles.get(&request.tool_id) != Some(*profile))
                .map(|profile| (profile.clone(), project.path.clone())))
        })?;
        if let Some((profile_id, path)) = pending {
            apply_registered_now(
                app,
                &request.tool_id,
                &profile_id,
                Scope::Project,
                path,
                false,
            )?;
        }
    }
    let result = app.state::<AppState>().with_database(app, |db| {
        let plan = launch::plan(db, &adapters::Registry::builtins(), &home, request)
            .map_err(native_error)?;
        let result = launch::spawn(plan).map_err(native_error)?;
        if let Some(project_id) = &project_id {
            if let Err(error) = projects::touch(db, project_id) {
                let _ = app.emit(
                    "cliora:tray-error",
                    format!("终端已打开，但最近项目时间未保存：{error}"),
                );
            }
        }
        Ok(result)
    })?;
    let _ = app.emit("cliora:projects-changed", project_id);
    Ok(result)
}

#[tauri::command]
pub async fn inspect_registered_native_draft(
    tool_id: String,
    files: std::collections::BTreeMap<String, String>,
) -> Result<NativeInspection, ApiError> {
    blocking(move || {
        intake::inspect_registered(&adapters::Registry::builtins(), &tool_id, &files)
            .map_err(native_error)
    })
    .await
}

#[tauri::command]
pub async fn prepare_registered_native_import(
    tool_id: String,
    files: std::collections::BTreeMap<String, String>,
) -> Result<intake::NativeImport, ApiError> {
    blocking(move || {
        intake::prepare_registered_import(
            &adapters::Registry::builtins(),
            &tool_id,
            files,
            &SystemCredentialStore,
        )
        .map_err(native_error)
    })
    .await
}

#[tauri::command]
pub async fn prepare_registered_native_import_from_disk(
    app: AppHandle,
    tool_id: String,
    scope: Scope,
    project_path: Option<String>,
    roles: Vec<String>,
    mut files: std::collections::BTreeMap<String, String>,
) -> Result<intake::NativeImport, ApiError> {
    blocking(move || {
        if roles.is_empty() {
            return Err(native_error("请选择要接入的原生文件".into()));
        }
        let home = home()?;
        let project = checked_project(scope, project_path)?;
        let state = app.state::<AppState>();
        state.with_database(&app, |database| {
            let registry = adapters::Registry::builtins();
            let custom = registered_tool_path(database, &tool_id).map_err(native_error)?;
            let probe = adapter::probe_registered(
                &registry,
                &tool_id,
                custom.as_deref(),
                &home,
                project.as_deref(),
                scope,
            )
            .map_err(native_error)?;
            for role in roles {
                let text = adapters::read_registered_file(
                    &registry,
                    &tool_id,
                    &role,
                    scope,
                    &home,
                    project.as_deref(),
                    probe.native_writes.state == "supported",
                )
                .map_err(native_error)?;
                if text.trim().is_empty() {
                    files.remove(&role);
                } else {
                    files.insert(role, text);
                }
            }
            intake::prepare_registered_import(&registry, &tool_id, files, &SystemCredentialStore)
                .map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub fn preview_registered_native_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: RegisteredProfile,
    scope: Scope,
) -> Result<apply::NativePreview, ApiError> {
    state.with_database(&app, |database| {
        let registry = adapters::Registry::builtins();
        let common =
            profile::get_registered_common(database, &profile.tool).map_err(native_error)?;
        apply::preview_registered(&registry, &profile, common.as_ref(), scope).map_err(native_error)
    })
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreservedProfile {
    pub id: String,
    pub tool_id: String,
    pub version: u64,
    pub data: serde_json::Value,
}

/// Explicit read-only access to unknown profile data. No background workspace
/// or catalog response includes these contents.
#[tauri::command]
pub fn list_preserved_profiles(
    app: AppHandle,
    state: State<'_, AppState>,
    tool_id: String,
) -> Result<Vec<PreservedProfile>, ApiError> {
    state.with_database(&app, |database| {
        preserved_profiles(database, &tool_id).map_err(native_error)
    })
}

fn preserved_profiles(database: &Database, tool_id: &str) -> Result<Vec<PreservedProfile>, String> {
    if adapters::Registry::builtins().get(tool_id).is_some() {
        return Err("已注册 CLI 请使用命名配置工作区".into());
    }
    database.with_connection(|conn| {
        let mut statement = conn
            .prepare(
                "SELECT id, tool, version, data FROM native_profiles WHERE tool = ?1 ORDER BY id",
            )
            .map_err(|_| "无法读取保留的 CLI 资料")?;
        let rows = statement
            .query_map([&tool_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|_| "无法读取保留的 CLI 资料")?;
        let mut result = Vec::new();
        for row in rows {
            let (id, tool_id, version, raw) = row.map_err(|_| "无法读取保留的 CLI 资料")?;
            if version < 0 {
                return Err("保留的 CLI 资料版本无效".into());
            }
            let data =
                serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::Value::String(raw));
            result.push(PreservedProfile {
                id,
                tool_id,
                version: version as u64,
                data,
            });
        }
        Ok(result)
    })
}

#[tauri::command]
pub async fn read_registered_native_file_for_edit(
    app: AppHandle,
    tool_id: String,
    scope: Scope,
    project_path: Option<String>,
    role: String,
) -> Result<String, ApiError> {
    blocking(move || {
        let home = home()?;
        let project = checked_project(scope, project_path)?;
        let state = app.state::<AppState>();
        state.with_database(&app, |database| {
            let registry = adapters::Registry::builtins();
            let custom = registered_tool_path(database, &tool_id).map_err(native_error)?;
            let probe = adapter::probe_registered(
                &registry,
                &tool_id,
                custom.as_deref(),
                &home,
                project.as_deref(),
                scope,
            )
            .map_err(native_error)?;
            adapters::read_registered_file(
                &registry,
                &tool_id,
                &role,
                scope,
                &home,
                project.as_deref(),
                probe.native_writes.state == "supported",
            )
            .map_err(native_error)
        })
    })
    .await
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
pub fn list_cli_adapters(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AdapterCatalog, ApiError> {
    state.with_database(&app, adapter_catalog)
}

#[tauri::command]
pub fn set_registered_managed_tools(
    app: AppHandle,
    state: State<'_, AppState>,
    managed_ids: Vec<String>,
) -> Result<AdapterCatalog, ApiError> {
    let registry = adapters::Registry::builtins();
    if managed_ids.iter().any(|id| registry.get(id).is_none()) {
        return Err(native_error("不能管理未注册的 CLI 适配器".into()));
    }
    let catalog = state.with_database(&app, |database| {
        database
            .update_preferences(|preferences| {
                preferences
                    .set_registered_managed(&managed_ids, |id| registry.get(id).is_some())
                    .expect("IDs checked against registry");
            })
            .map_err(storage_error)?;
        adapter_catalog(database)
    })?;
    let _ = app.emit("cliora:bindings-changed", "managed-tools");
    Ok(catalog)
}

fn adapter_catalog(database: &Database) -> Result<AdapterCatalog, ApiError> {
    let registry = adapters::Registry::builtins();
    let preferences = database.preferences().map_err(storage_error)?;
    let mut unknown: std::collections::BTreeMap<String, u32> = preferences
        .unknown_managed_tools()
        .iter()
        .filter(|id| registry.get(id).is_none())
        .map(|id| (id.clone(), 0))
        .collect();
    database
        .with_connection(|conn| {
            for table in [
                "native_profiles",
                "common_configs",
                "applied_bindings",
                "installation_choices",
            ] {
                // Table names are closed constants; only tool identifiers come from the database.
                let statement = format!("SELECT tool, COUNT(*) FROM {table} GROUP BY tool");
                let mut query = conn
                    .prepare(&statement)
                    .map_err(|_| "无法读取 CLI 资料索引")?;
                let rows = query
                    .query_map([], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?))
                    })
                    .map_err(|_| "无法读取 CLI 资料索引")?;
                for row in rows {
                    let (id, count) = row.map_err(|_| "无法读取 CLI 资料索引")?;
                    if registry.get(&id).is_none() {
                        let entry = unknown.entry(id).or_default();
                        if table == "native_profiles" {
                            *entry = count;
                        }
                    }
                }
            }
            Ok(())
        })
        .map_err(storage_error)?;
    Ok(AdapterCatalog {
        registered: registry.descriptors(),
        managed_ids: preferences
            .managed_tools
            .iter()
            .map(|tool| tool.stable_id().to_owned())
            .chain(
                preferences
                    .unknown_managed_tools()
                    .iter()
                    .filter(|id| registry.get(id).is_some())
                    .cloned(),
            )
            .collect(),
        preserved_unknown: unknown
            .into_iter()
            .map(|(id, profile_count)| UnknownAdapterRecord {
                id,
                profile_count,
                read_only: true,
                reason: "此 CLI 的适配器未安装；原资料保留，只能查看索引，不能应用或改写",
            })
            .collect(),
    })
}

#[tauri::command]
pub fn set_managed_tools(
    app: AppHandle,
    state: State<'_, AppState>,
    managed_tools: Vec<CliId>,
) -> Result<Bootstrap, ApiError> {
    let bootstrap = state.with_database(&app, |database| {
        database
            .update_preferences(|preferences| preferences.set_managed(&managed_tools))
            .map(Bootstrap::new)
            .map_err(storage_error)
    })?;
    let _ = app.emit("cliora:bindings-changed", "managed-tools");
    Ok(bootstrap)
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
    fn unknown_profiles_are_explicitly_readable_but_never_writable_as_known_tool() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("unknown.db")).unwrap();
        let original = r#"{"id":"future-1","tool":"future_cli","name":"保留方案","version":1,"files":{"settings":"custom = true"}}"#;
        db.with_connection(|conn| {
            conn.execute(
                "INSERT INTO native_profiles (id, tool, version, data) VALUES (?1, ?2, 1, ?3)",
                rusqlite::params!["future-1", "future_cli", original],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })
        .unwrap();
        let listed = preserved_profiles(&db, "future_cli").unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].data["files"]["settings"], "custom = true");
        assert!(preserved_profiles(&db, "codex").is_err());
        assert!(profile::save_registered_profile(
            &db,
            &adapters::Registry::builtins(),
            profile::RegisteredProfile {
                id: "future-1".into(),
                tool: "future_cli".into(),
                name: "write denied".into(),
                version: 1,
                inherit_common: false,
                files: std::collections::BTreeMap::new(),
                suppressed: std::collections::BTreeMap::new(),
                connection: None,
                native_credentials: std::collections::BTreeMap::new()
            },
            Some(1)
        )
        .is_err());
        assert!(profile::delete_profile(&db, "future-1", 1)
            .unwrap_err()
            .contains("未注册的 CLI 适配器"));
        let raw: String = db
            .with_connection(|conn| {
                conn.query_row(
                    "SELECT data FROM native_profiles WHERE id = 'future-1'",
                    [],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())
            })
            .unwrap();
        assert_eq!(raw, original);
    }

    #[test]
    fn ordinary_workspace_snapshot_never_serializes_a_claude_native_key() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("settings.json");
        let source = include_str!("../../tests/fixtures/native/claude-key-only-settings.json");
        std::fs::write(&path, source).unwrap();
        let file = adapter::NativeFile {
            role: "settings",
            path: path.display().to_string(),
            format: "json",
            writable: true,
            reason: None,
            sensitive: false,
        };
        let snapshot = native_snapshot(&file);
        assert_eq!(snapshot.fingerprint.as_deref(), Some("present"));
        assert!(snapshot.text.is_none());
        assert!(!serde_json::to_string(&snapshot)
            .unwrap()
            .contains("test-only-global-secret"));
        assert!(!serde_json::to_string(&snapshot)
            .unwrap()
            .contains(&transaction::fingerprint(source.as_bytes())));
        // The separate explicit native-editor path can still read the full file.
        assert_eq!(transaction::read_native(&path).unwrap(), source);
    }

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
