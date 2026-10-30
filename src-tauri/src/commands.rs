use crate::adapters::{self, AdapterCatalog, PublishedDescriptor, UnknownAdapterRecord};
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::credentials::{CredentialStore, SystemCredentialStore};
use crate::database::{Database, OpenError};
use crate::domain::{Bootstrap, CliId, Theme};
use crate::native::{
    adapter::{self, Scope, ToolProbe},
    apply::{self, AppliedBinding},
    intake::{self, NativeInspection},
    models::{self, ModelDirectory},
    profile::{self, CommonConfig, Connection, NativeProfile, RegisteredCommon, RegisteredProfile},
    transaction::{self, ApplyOutcome},
};
use crate::resources::rules;
use crate::{history, launch, library, portable, projects, resources};

#[tauri::command]
pub async fn scan_native_agents(
    app: AppHandle,
    target: resources::plugins::PluginTarget,
) -> Result<resources::agents::AgentSnapshot, ApiError> {
    blocking(move || {
        let db = app.state::<AppState>().database(&app)?;
        resources::agents::scan(&db, &home()?, &target).map_err(native_error)
    })
    .await
}
#[tauri::command]
pub async fn operate_native_agent(
    app: AppHandle,
    request: resources::agents::AgentRequest,
) -> Result<resources::agents::AgentResult, ApiError> {
    blocking(move || {
        let db = app.state::<AppState>().database(&app)?;
        resources::agents::operate(&db, &SystemCredentialStore, &home()?, &request)
            .map_err(native_error)
    })
    .await
}

#[tauri::command]
pub async fn scan_native_plugins(
    app: AppHandle,
    target: resources::plugins::PluginTarget,
) -> Result<resources::plugins::PluginSnapshot, ApiError> {
    blocking(move || {
        let db = app.state::<AppState>().database(&app)?;
        resources::plugins::scan(&db, &home()?, &target).map_err(native_error)
    })
    .await
}

#[tauri::command]
pub async fn preview_native_plugins(
    app: AppHandle,
    target: resources::plugins::PluginTarget,
) -> Result<Option<resources::plugins::PluginSnapshot>, ApiError> {
    blocking(move || {
        let db = app.state::<AppState>().database(&app)?;
        resources::plugins::preview(&db, &home()?, &target).map_err(native_error)
    })
    .await
}

#[tauri::command]
pub async fn operate_native_plugin(
    app: AppHandle,
    request: resources::plugins::PluginRequest,
) -> Result<resources::plugins::PluginResult, ApiError> {
    blocking(move || {
        let db = app.state::<AppState>().database(&app)?;
        resources::plugins::operate(&db, &SystemCredentialStore, &home()?, &request)
            .map_err(native_error)
    })
    .await
}

/// Names what a plugin bundles. Read-only; resolved against a fresh scan of the target.
#[tauri::command]
pub async fn inspect_native_plugin(
    app: AppHandle,
    target: resources::plugins::PluginTarget,
    plugin_id: String,
) -> Result<resources::plugin_contents::PluginContents, ApiError> {
    blocking(move || {
        let db = app.state::<AppState>().database(&app)?;
        resources::plugin_contents::inspect(&db, &home()?, &target, &plugin_id).map_err(native_error)
    })
    .await
}

/// Text of one file inside the plugin's root or declared resources.
#[tauri::command]
pub async fn read_native_plugin_file(
    app: AppHandle,
    target: resources::plugins::PluginTarget,
    plugin_id: String,
    path: String,
) -> Result<resources::plugin_contents::PluginFile, ApiError> {
    blocking(move || {
        let db = app.state::<AppState>().database(&app)?;
        resources::plugin_contents::read_file(&db, &home()?, &target, &plugin_id, &path).map_err(native_error)
    })
    .await
}

/// Shows the plugin folder, or a file inside it, in the system file manager.
#[tauri::command]
pub async fn reveal_native_plugin_path(
    app: AppHandle,
    target: resources::plugins::PluginTarget,
    plugin_id: String,
    path: Option<String>,
) -> Result<(), ApiError> {
    blocking(move || {
        let db = app.state::<AppState>().database(&app)?;
        let location = resources::plugin_contents::locate(&db, &home()?, &target, &plugin_id, path.as_deref()).map_err(native_error)?;
        tauri_plugin_opener::reveal_item_in_dir(&location).map_err(|error| native_error(format!("无法在文件管理器中显示：{error}")))
    })
    .await
}
use std::path::PathBuf;

#[derive(Default)]
pub struct AppState {
    database: Mutex<Option<Arc<Database>>>,
    portable_draft: Mutex<Option<portable::ImportDraft>>,
    workspace: crate::native::workspace::DraftSessions,
}

async fn usage_blocking<T: Send + 'static>(
    app: AppHandle,
    operation: impl FnOnce(&Database) -> Result<T, crate::usage::UsageError> + Send + 'static,
) -> Result<T, crate::usage::UsageError> {
    use crate::usage::{UsageError, UsageErrorCode, UsageStage};
    let db = app
        .state::<AppState>()
        .database(&app)
        .map_err(|_| UsageError::storage())?;
    tauri::async_runtime::spawn_blocking(move || operation(&db))
        .await
        .map_err(|_| {
            UsageError::new(
                UsageErrorCode::Storage,
                UsageStage::Storage,
                "额度查询后台操作中断",
            )
        })?
}

#[tauri::command]
pub fn account_capabilities() -> Vec<crate::accounts::AccountCapability> {
    adapters::accounts::capabilities()
}

#[tauri::command]
pub async fn discover_native_logins(
    app: AppHandle,
    tool_id: String,
) -> Result<crate::accounts::NativeLoginSnapshot, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    let home = home()?;
    blocking(move || {
        crate::accounts::discovery::discover(&db, &home, &tool_id).map_err(native_error)
    })
    .await
}

#[tauri::command]
pub async fn adopt_native_account(
    app: AppHandle,
    tool_id: String,
    label: String,
) -> Result<crate::accounts::AuthAccount, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    let home = dirs::home_dir().ok_or_else(|| native_error("无法定位用户目录".into()))?;
    blocking(move || {
        crate::accounts::adopt_native(&db, &home, &tool_id, &label).map_err(native_error)
    })
    .await
}

#[tauri::command]
pub async fn adopt_native_codex_account(
    app: AppHandle,
    label: String,
) -> Result<crate::accounts::AuthAccount, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    let home = dirs::home_dir().ok_or_else(|| native_error("无法定位用户目录".into()))?;
    blocking(move || crate::accounts::adopt_codex(&db, &home, &label).map_err(native_error)).await
}

#[tauri::command]
pub async fn list_accounts(app: AppHandle) -> Result<Vec<crate::accounts::AuthAccount>, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    let home = dirs::home_dir();
    blocking(move || {
        let accounts = crate::accounts::list(&db).map_err(native_error)?;
        if let Some(home) = home {
            crate::accounts::recover_completed_login(&db, &home, &accounts);
            let accounts = crate::accounts::list(&db).map_err(native_error)?;
            crate::accounts::resume_pending(&db, &home, &accounts);
            return Ok(accounts);
        }
        Ok(accounts)
    })
    .await
}

#[tauri::command]
pub async fn account_impact(
    app: AppHandle,
    id: String,
) -> Result<crate::accounts::AccountImpact, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    blocking(move || crate::accounts::impact(&db, &id).map_err(native_error)).await
}

#[tauri::command]
pub async fn create_account(
    app: AppHandle,
    tool_id: String,
    label: String,
) -> Result<crate::accounts::AuthAccount, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    blocking(move || crate::accounts::create(&db, &tool_id, &label).map_err(native_error)).await
}

#[tauri::command]
pub async fn rename_account(
    app: AppHandle,
    id: String,
    expected_version: u32,
    label: String,
) -> Result<crate::accounts::AuthAccount, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    blocking(move || {
        crate::accounts::rename(&db, &id, expected_version, &label).map_err(native_error)
    })
    .await
}

#[tauri::command]
pub async fn start_account_login(
    app: AppHandle,
    id: String,
    expected_version: u32,
    method: String,
) -> Result<crate::accounts::AuthAccount, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    let base = app
        .path()
        .app_data_dir()
        .map_err(|_| native_error("无法定位账号数据目录".into()))?;
    let home = dirs::home_dir().ok_or_else(|| native_error("无法定位用户目录".into()))?;
    blocking(move || {
        crate::accounts::start_login(db, &base, &home, &id, expected_version, &method)
            .map_err(native_error)
    })
    .await
}

#[tauri::command]
pub async fn cancel_account_login(
    app: AppHandle,
    id: String,
    attempt_id: String,
) -> Result<crate::accounts::AuthAccount, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    blocking(move || crate::accounts::cancel(&db, &id, &attempt_id, false).map_err(native_error))
        .await
}

#[tauri::command]
pub async fn check_account(
    app: AppHandle,
    id: String,
) -> Result<crate::accounts::AuthAccount, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    let home = dirs::home_dir().ok_or_else(|| native_error("无法定位用户目录".into()))?;
    blocking(move || crate::accounts::check(&db, &home, &id).map_err(native_error)).await
}

#[tauri::command]
pub async fn logout_account(
    app: AppHandle,
    id: String,
    expected_version: u32,
) -> Result<crate::accounts::AuthAccount, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    let home = dirs::home_dir().ok_or_else(|| native_error("无法定位用户目录".into()))?;
    blocking(move || {
        crate::accounts::logout(db, &home, &id, expected_version).map_err(native_error)
    })
    .await
}

#[tauri::command]
pub fn usage_presets() -> Vec<crate::usage::UsagePreset> {
    crate::usage::usage_presets()
}

#[tauri::command]
pub async fn ensure_profile_usage(
    app: AppHandle,
    profile_id: String,
    expected_profile_version: u64,
) -> Result<Option<crate::usage::UsageQuery>, crate::usage::UsageError> {
    usage_blocking(app, move |db| {
        crate::usage::ensure_profile_query(
            db,
            &SystemCredentialStore,
            &profile_id,
            expected_profile_version,
        )
    })
    .await
}

#[tauri::command]
pub async fn delete_account(
    app: AppHandle,
    id: String,
    expected_version: u32,
) -> Result<(), ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    blocking(move || crate::accounts::delete(&db, &id, expected_version).map_err(native_error))
        .await
}

#[tauri::command]
pub async fn open_account_login_link(
    app: AppHandle,
    id: String,
    attempt_id: String,
) -> Result<(), ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    blocking(move || {
        let value =
            crate::accounts::native::login_url(&db, &id, &attempt_id).map_err(native_error)?;
        crate::external::open(&app, &value).map_err(native_error)
    })
    .await
}

#[tauri::command]
pub fn usage_builtin_script(
    config: crate::usage::QueryConfig,
) -> Result<String, crate::usage::UsageError> {
    crate::usage::builtin_script(&config)
}

#[tauri::command]
pub async fn list_usage_cache(
    app: AppHandle,
) -> Result<Vec<crate::usage::UsageCache>, crate::usage::UsageError> {
    usage_blocking(app, crate::usage::list_cache).await
}

#[tauri::command]
pub async fn list_usage_samples(
    app: AppHandle,
    query_id: String,
) -> Result<Vec<crate::usage::UsageSample>, crate::usage::UsageError> {
    usage_blocking(app, move |db| crate::usage::list_samples(db, &query_id)).await
}

#[tauri::command]
pub async fn refresh_usage_query(
    app: AppHandle,
    id: String,
) -> Result<(), crate::usage::UsageError> {
    let db = app
        .state::<AppState>()
        .database(&app)
        .map_err(|_| crate::usage::UsageError::storage())?;
    tauri::async_runtime::spawn_blocking(move || crate::usage::refresh_query(db, &id, true))
        .await
        .map_err(|_| crate::usage::UsageError::storage())?
}

#[tauri::command]
pub fn cancel_usage_refresh(id: String) -> Result<(), crate::usage::UsageError> {
    crate::usage::cancel_refresh(&id)
}

pub fn usage_background_tick(app: &AppHandle) -> Result<(), crate::usage::UsageError> {
    let db = app
        .state::<AppState>()
        .database(app)
        .map_err(|_| crate::usage::UsageError::storage())?;
    crate::usage::scheduler_tick(db)
}

#[tauri::command]
pub async fn list_usage_queries(
    app: AppHandle,
) -> Result<Vec<crate::usage::UsageQuery>, crate::usage::UsageError> {
    usage_blocking(app, crate::usage::list_queries).await
}

#[tauri::command]
pub fn create_usage_test() -> Result<String, crate::usage::UsageError> {
    crate::usage::create_test_execution()
}

#[tauri::command]
pub fn cancel_usage_test(execution_id: String) -> Result<(), crate::usage::UsageError> {
    crate::usage::cancel_test_execution(&execution_id)
}

#[tauri::command]
pub async fn test_usage_query(
    app: AppHandle,
    execution_id: String,
    draft_revision: u32,
    draft: crate::usage::UsageQueryDraft,
) -> Result<crate::usage::DraftTestReport, crate::usage::UsageError> {
    usage_blocking(app, move |db| {
        crate::usage::test_draft(
            db,
            &SystemCredentialStore,
            execution_id,
            draft_revision,
            draft,
        )
    })
    .await
}

#[tauri::command]
pub async fn get_usage_query(
    app: AppHandle,
    id: String,
) -> Result<crate::usage::UsageQuery, crate::usage::UsageError> {
    usage_blocking(app, move |db| crate::usage::get_query(db, &id)).await
}

#[tauri::command]
pub async fn save_usage_query(
    app: AppHandle,
    draft: crate::usage::UsageQueryDraft,
) -> Result<crate::usage::SaveQueryResult, crate::usage::UsageError> {
    usage_blocking(app, move |db| {
        crate::usage::save_query(db, &SystemCredentialStore, draft)
    })
    .await
}

#[tauri::command]
pub async fn delete_usage_query(
    app: AppHandle,
    id: String,
    expected_version: u32,
) -> Result<crate::usage::DeleteQueryResult, crate::usage::UsageError> {
    usage_blocking(app, move |db| {
        crate::usage::delete_query(db, &SystemCredentialStore, &id, expected_version)
    })
    .await
}

#[tauri::command]
pub async fn list_portable_items(app: AppHandle) -> Result<Vec<portable::ImportItem>, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    blocking(move || {
        let snapshot = portable::collect_snapshot(
            &db,
            &SystemCredentialStore,
            &adapters::Registry::builtins(),
        )
        .map_err(native_error)?;
        Ok(snapshot
            .entities
            .iter()
            .map(|entity| portable::ImportItem {
                key: entity.key(),
                kind: entity.kind().into(),
                label: entity.label(),
                status: "available",
                pending_fields: entity.pending_fields(),
                tool_id: match &entity.payload {
                    portable::PortablePayload::Profile(value) => Some(value.profile.tool.clone()),
                    _ => None,
                },
                local_preview: None,
                incoming_preview: String::new(),
            })
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn export_portable_bundle(
    app: AppHandle,
    destination: String,
    password: String,
    selected: Vec<String>,
) -> Result<usize, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    blocking(move || {
        let _ = selected;
        portable::export_bundle(
            &db,
            &SystemCredentialStore,
            &adapters::Registry::builtins(),
            &password,
            None,
            Path::new(&destination),
        )
        .map_err(native_error)
    })
    .await
}

#[tauri::command]
pub async fn preview_portable_bundle(
    app: AppHandle,
    source: String,
    password: String,
) -> Result<portable::ImportPreview, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    let draft = blocking(move || {
        let snapshot =
            portable::unlock_bundle(Path::new(&source), &password).map_err(native_error)?;
        portable::preview_import(
            &db,
            &SystemCredentialStore,
            &adapters::Registry::builtins(),
            snapshot,
        )
        .map_err(native_error)
    })
    .await?;
    let preview = portable::preview_dto(&draft);
    *app.state::<AppState>()
        .portable_draft
        .lock()
        .map_err(|_| native_error("迁移预览暂不可用".into()))? = Some(draft);
    Ok(preview)
}

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProjectLink {
    pub project_id: String,
    pub path: String,
}

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportApplyTarget {
    pub profile_id: String,
    pub project_id: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportTargetResult {
    pub label: String,
    pub status: &'static str,
    pub detail: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub imported: usize,
    pub targets: Vec<ImportTargetResult>,
}

#[tauri::command]
pub async fn apply_portable_bundle(
    app: AppHandle,
    preview_id: String,
    selected: Vec<String>,
    project_links: Vec<ImportProjectLink>,
    apply_targets: Vec<ImportApplyTarget>,
) -> Result<ImportReport, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    let app_state = app.state::<AppState>();
    let draft = {
        let mut guard = app_state
            .portable_draft
            .lock()
            .map_err(|_| native_error("迁移预览暂不可用".into()))?;
        if guard.as_ref().is_none_or(|draft| draft.id != preview_id) {
            return Err(native_error("导入预览已失效，请重新解锁".into()));
        }
        guard
            .take()
            .ok_or_else(|| native_error("导入预览已失效，请重新解锁".into()))?
    };
    let retry = draft.clone();
    let _ = (selected, project_links, apply_targets);
    let apply_app = app.clone();
    let result = blocking(move || {
        portable::with_change_notification(
            &db,
            || notify_portable_changed(&apply_app),
            || {
                let imported = portable::restore_preview(
                    &db,
                    &SystemCredentialStore,
                    &adapters::Registry::builtins(),
                    &draft,
                )
                .map_err(native_error)?;
                let targets = portable::load_blockers(&db)
                    .unwrap_or_default()
                    .into_iter()
                    .map(|blocker| ImportTargetResult {
                        label: blocker.label,
                        status: "blocked",
                        detail: Some(blocker.detail),
                    })
                    .collect();
                Ok(ImportReport { imported, targets })
            },
        )
    })
    .await;
    if result.is_err() {
        let mut guard = app_state
            .portable_draft
            .lock()
            .map_err(|_| native_error("迁移预览暂不可用".into()))?;
        if guard.is_none() {
            *guard = Some(retry);
        }
    }
    result
}

#[tauri::command]
pub fn cancel_portable_preview(state: State<'_, AppState>) -> Result<(), ApiError> {
    state
        .portable_draft
        .lock()
        .map_err(|_| native_error("迁移预览暂不可用".into()))?
        .take();
    Ok(())
}

#[tauri::command]
pub fn get_webdav_status(app: AppHandle) -> Result<portable::sync::SyncStatus, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    portable::refresh_auth_read_blockers(&db).map_err(native_error)?;
    portable::sync::status(&db).map_err(native_error)
}

#[tauri::command]
pub async fn configure_webdav(
    app: AppHandle,
    setup: portable::sync::SyncSetup,
) -> Result<portable::sync::SyncStatus, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    blocking(move || {
        portable::sync::configure(&db, &SystemCredentialStore, setup).map_err(native_error)
    })
    .await
}

#[tauri::command]
pub fn set_webdav_enabled(
    app: AppHandle,
    enabled: bool,
) -> Result<portable::sync::SyncStatus, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    portable::sync::set_enabled(&db, enabled).map_err(native_error)
}

#[tauri::command]
pub async fn retry_restore_blocker(
    app: AppHandle,
    key: String,
) -> Result<portable::sync::SyncStatus, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    blocking(move || {
        portable::retry_native_blocker(
            &db,
            &SystemCredentialStore,
            &adapters::Registry::builtins(),
            &key,
        )
        .map_err(native_error)?;
        portable::sync::status(&db).map_err(native_error)
    })
    .await
}

#[tauri::command]
pub async fn sync_webdav_now(app: AppHandle) -> Result<portable::sync::SyncStatus, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    blocking(move || {
        portable::with_change_notification(
            &db,
            || notify_portable_changed(&app),
            || {
                portable::sync::run_with_progress(
                    &db,
                    &SystemCredentialStore,
                    &adapters::Registry::builtins(),
                    false,
                    &|progress| {
                        let _ = app.emit("cliora:sync-progress", progress.clone());
                    },
                )
                .map_err(native_error)
            },
        )
    })
    .await
}

#[tauri::command]
pub async fn resolve_webdav_conflict(
    app: AppHandle,
    key: String,
    chosen_version_id: Option<String>,
) -> Result<portable::sync::SyncStatus, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    blocking(move || {
        portable::with_change_notification(
            &db,
            || notify_portable_changed(&app),
            || {
                portable::sync::resolve(
                    &db,
                    &SystemCredentialStore,
                    &adapters::Registry::builtins(),
                    &key,
                    chosen_version_id.as_deref(),
                )
                .map_err(native_error)
            },
        )
    })
    .await
}

#[tauri::command]
pub async fn preview_webdav_conflict(
    app: AppHandle,
    key: String,
) -> Result<portable::sync::ConflictPreview, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    blocking(move || {
        portable::sync::preview_conflict(
            &db,
            &SystemCredentialStore,
            &adapters::Registry::builtins(),
            &key,
        )
        .map_err(native_error)
    })
    .await
}

pub fn sync_background_tick(app: &AppHandle) -> Result<(), ApiError> {
    let db = app.state::<AppState>().database(app)?;
    portable::with_change_notification(
        &db,
        || notify_portable_changed(app),
        || {
            portable::sync::run(
                &db,
                &SystemCredentialStore,
                &adapters::Registry::builtins(),
                true,
            )
            .map(|_| ())
            .map_err(native_error)
        },
    )
}

fn notify_portable_changed(app: &AppHandle) {
    let _ = app.emit("cliora:portable-changed", ());
    let _ = app.emit("cliora:bindings-changed", "portable");
    let _ = app.emit("cliora:projects-changed", "portable");
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
        code: native_error_code(&message),
        message,
        action: "检查工具版本、原生文件和作用范围后重试；原配置不会自动清空。",
        data_directory: None,
    }
}

/// Stable codes for the fixed native error literals the UI recognizes; every other
/// message keeps the generic `native_error` code with unchanged message/action text.
fn native_error_code(message: &str) -> &'static str {
    // native/apply.rs builds "原生文件已有不同的字段值：{role}{pointer}；请确认接管"
    // with a variable role/pointer segment, so the fixed template prefix and suffix
    // are the contract for recognizing that construction site.
    if message.starts_with("原生文件已有不同的字段值：") && message.ends_with("；请确认接管")
    {
        return "native_takeover_required";
    }
    // launch.rs rejects oversized CMD launch lines with this exact literal.
    if message == "启动命令超过 CMD 长度限制，请在设置中选择 PowerShell 或 Windows Terminal"
    {
        return "terminal_command_too_long";
    }
    "native_error"
}

static HISTORY_REFRESH_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
static HISTORY_REFRESH_GENERATION: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);
#[tauri::command]
pub fn cancel_history_refresh() {
    HISTORY_REFRESH_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
}
#[tauri::command]
pub fn get_history_scan_progress() -> history::ScanProgress {
    history::scan_progress()
}

#[tauri::command]
pub async fn list_history_scans(app: AppHandle) -> Result<Vec<history::ScanStatus>, ApiError> {
    blocking(move || {
        app.state::<AppState>()
            .with_database(&app, |db| history::scans(db).map_err(native_error))
    })
    .await
}

#[tauri::command]
pub async fn refresh_history(app: AppHandle) -> Result<Vec<history::ScanStatus>, ApiError> {
    let generation = HISTORY_REFRESH_GENERATION.load(std::sync::atomic::Ordering::SeqCst);
    blocking(move || {
        let _guard = HISTORY_REFRESH_LOCK
            .try_lock()
            .map_err(|_| native_error("扫描已在后台进行".into()))?;
        let home = home()?;
        app.state::<AppState>().with_database(&app, |db| {
            let managed = db.preferences().map_err(native_error)?.managed_tool_ids();
            history::refresh_controlled(
                db,
                &adapters::Registry::builtins(),
                &home,
                &managed,
                &|| {
                    HISTORY_REFRESH_GENERATION.load(std::sync::atomic::Ordering::SeqCst)
                        != generation
                },
            )
            .map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn list_history_sessions(
    app: AppHandle,
    filter: history::HistoryFilter,
) -> Result<Vec<history::HistorySession>, ApiError> {
    blocking(move || {
        app.state::<AppState>()
            .with_database(&app, |db| history::list(db, &filter).map_err(native_error))
    })
    .await
}

#[tauri::command]
pub async fn get_history_session(
    app: AppHandle,
    id: String,
) -> Result<history::HistoryDetail, ApiError> {
    blocking(move || {
        app.state::<AppState>()
            .with_database(&app, |db| history::detail(db, &id).map_err(native_error))
    })
    .await
}

#[tauri::command]
pub async fn set_history_favorite(
    app: AppHandle,
    id: String,
    favorite: bool,
) -> Result<(), ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            history::set_favorite(db, &id, favorite).map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn set_history_project(
    app: AppHandle,
    id: String,
    project_id: Option<String>,
) -> Result<(), ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            history::set_project(db, &id, project_id.as_deref()).map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn get_usage_report(
    app: AppHandle,
    filter: history::HistoryFilter,
) -> Result<history::UsageReport, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            history::usage_report(db, &filter).map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn list_history_prices(app: AppHandle) -> Result<Vec<history::HistoryPrice>, ApiError> {
    blocking(move || {
        app.state::<AppState>()
            .with_database(&app, |db| history::prices(db).map_err(native_error))
    })
    .await
}

#[tauri::command]
pub async fn save_history_price(
    app: AppHandle,
    price: history::HistoryPrice,
) -> Result<history::HistoryPrice, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            history::save_price(db, &adapters::Registry::builtins(), price).map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn copy_history_resume_command(
    app: AppHandle,
    id: String,
    mode: adapters::LaunchMode,
) -> Result<String, ApiError> {
    blocking(move || {
        let home = home()?;
        app.state::<AppState>().with_database(&app, |db| {
            history::copy_resume_command(db, &adapters::Registry::builtins(), &home, &id, mode)
                .map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn resume_history_session(
    app: AppHandle,
    id: String,
    mode: adapters::LaunchMode,
) -> Result<launch::LaunchResult, ApiError> {
    blocking(move || {
        let home = home()?;
        app.state::<AppState>().with_database(&app, |db| {
            let plan = history::resume_plan(db, &adapters::Registry::builtins(), &home, &id, mode)
                .map_err(native_error)?;
            launch::spawn(db, plan).map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn export_history_session(
    app: AppHandle,
    id: String,
    format: String,
    destination: String,
) -> Result<String, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            history::export(db, &id, &format, Path::new(&destination)).map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn list_library_items(
    app: AppHandle,
    kind: library::LibraryKind,
    project_id: Option<String>,
    search: String,
) -> Result<Vec<library::LibraryItem>, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            library::list(db, kind, project_id.as_deref(), &search).map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn save_library_item(
    app: AppHandle,
    draft: library::LibraryDraft,
) -> Result<library::LibraryItem, ApiError> {
    blocking(move || {
        app.state::<AppState>()
            .with_database(&app, |db| library::save(db, draft).map_err(native_error))
    })
    .await
}

#[tauri::command]
pub async fn delete_library_item(
    app: AppHandle,
    id: String,
    expected_version: u64,
) -> Result<(), ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            resources::rules::release_rule(
                db,
                &SystemCredentialStore,
                &adapters::Registry::builtins(),
                &home()?,
                &id,
                expected_version,
            )
            .map_err(native_error)?;
            library::delete(db, &id, expected_version).map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn list_remote_library_items(
    app: AppHandle,
    state: State<'_, AppState>,
    target_id: String,
    kind: library::LibraryKind,
    search: String,
) -> Result<Vec<library::LibraryItem>, ApiError> {
    let target = state.with_database(&app, |db| crate::remote::target(db, &target_id).map_err(|error| native_error(error.to_string())))?;
    blocking(move || crate::remote::list_library(&target, kind, &search).map_err(|error| native_error(error.to_string()))).await
}

#[tauri::command]
pub async fn save_remote_library_item(
    app: AppHandle,
    state: State<'_, AppState>,
    target_id: String,
    draft: library::LibraryDraft,
) -> Result<library::LibraryItem, ApiError> {
    let target = state.with_database(&app, |db| crate::remote::target(db, &target_id).map_err(|error| native_error(error.to_string())))?;
    blocking(move || crate::remote::save_library(&target, draft).map_err(|error| native_error(error.to_string()))).await
}

#[tauri::command]
pub async fn delete_remote_library_item(
    app: AppHandle,
    state: State<'_, AppState>,
    target_id: String,
    id: String,
    expected_version: u64,
) -> Result<(), ApiError> {
    let target = state.with_database(&app, |db| crate::remote::target(db, &target_id).map_err(|error| native_error(error.to_string())))?;
    blocking(move || crate::remote::delete_library(&target, &id, expected_version).map_err(|error| native_error(error.to_string()))).await
}

#[tauri::command]
pub async fn list_remote_rule_placements(
    app: AppHandle,
    state: State<'_, AppState>,
    target_id: String,
) -> Result<Vec<resources::rules::RulePlacement>, ApiError> {
    let target = state.with_database(&app, |db| crate::remote::target(db, &target_id).map_err(|error| native_error(error.to_string())))?;
    blocking(move || crate::remote::list_rule_placements(&target).map_err(|error| native_error(error.to_string()))).await
}

#[tauri::command]
pub async fn sync_remote_rule_clients(
    app: AppHandle,
    state: State<'_, AppState>,
    target_id: String,
    rule_id: String,
    expected_version: u64,
    selection: resources::rules::RuleClientSelection,
) -> Result<Vec<resources::rules::RuleSyncResult>, ApiError> {
    let target = state.with_database(&app, |db| crate::remote::target(db, &target_id).map_err(|error| native_error(error.to_string())))?;
    blocking(move || crate::remote::sync_rules(&target, &rule_id, expected_version, selection).map_err(|error| native_error(error.to_string()))).await
}

#[tauri::command]
pub async fn list_mcp_definitions(
    app: AppHandle,
) -> Result<Vec<resources::mcp::McpDefinition>, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            resources::mcp::list_definitions(db).map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn save_mcp_definition(
    app: AppHandle,
    draft: resources::mcp::McpDraft,
) -> Result<resources::mcp::McpDefinition, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            resources::mcp::save_definition(db, draft).map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn delete_mcp_definition(
    app: AppHandle,
    id: String,
    expected_version: u64,
) -> Result<(), ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            resources::mcp::delete_definition(db, &id, expected_version).map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn export_mcp_definition(app: AppHandle, id: String) -> Result<String, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            resources::mcp::export_definition(db, &id).map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn remove_native_mcp(
    app: AppHandle,
    target: resources::mcp::McpTargetRequest,
    name: String,
) -> Result<(), ApiError> {
    blocking(move || {
        let home = home()?;
        let db = app.state::<AppState>().database(&app)?;
        resources::mcp::remove_native(
            &db,
            &SystemCredentialStore,
            &adapters::Registry::builtins(),
            &home,
            &target,
            &name,
        )
        .map_err(native_error)
    })
    .await
}

#[tauri::command]
pub async fn list_native_mcp(
    app: AppHandle,
    target: resources::mcp::McpTargetRequest,
) -> Result<Vec<resources::mcp::NativeMcpEntry>, ApiError> {
    blocking(move || {
        let home = home()?;
        let db = app.state::<AppState>().database(&app)?;
        resources::mcp::list_native(&db, &adapters::Registry::builtins(), &home, &target)
            .map_err(native_error)
    })
    .await
}

#[tauri::command]
pub async fn list_mcp_placements(
    app: AppHandle,
) -> Result<Vec<resources::mcp::McpPlacement>, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            resources::mcp::list_placements(db).map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn get_managed_mcp_enabled(
    app: AppHandle,
    definition_id: String,
    target: resources::mcp::McpTargetRequest,
) -> Result<Option<bool>, ApiError> {
    blocking(move || {
        let db = app.state::<AppState>().database(&app)?;
        resources::mcp::managed_enabled(&db, &definition_id, &target).map_err(native_error)
    })
    .await
}

#[tauri::command]
pub async fn preview_mcp_targets(
    app: AppHandle,
    definition_id: String,
    targets: Vec<resources::mcp::McpTargetRequest>,
) -> Result<Vec<resources::mcp::McpTargetResult>, ApiError> {
    blocking(move || {
        let home = home()?;
        let db = app.state::<AppState>().database(&app)?;
        Ok(resources::mcp::preview_targets(
            &db,
            &adapters::Registry::builtins(),
            &home,
            &definition_id,
            targets,
        ))
    })
    .await
}

#[tauri::command]
pub async fn preview_mcp_draft(
    app: AppHandle,
    draft: resources::mcp::McpDraft,
    targets: Vec<resources::mcp::McpDraftTargetRequest>,
) -> Result<resources::mcp::McpDraftPreview, ApiError> {
    blocking(move || {
        let home = home()?;
        let db = app.state::<AppState>().database(&app)?;
        resources::mcp::preview_draft(&db, &adapters::Registry::builtins(), &home, draft, targets)
            .map_err(native_error)
    })
    .await
}

#[tauri::command]
pub async fn commit_mcp_draft(
    app: AppHandle,
    draft: resources::mcp::McpDraft,
    targets: Vec<resources::mcp::McpDraftTargetRequest>,
) -> Result<resources::mcp::McpCommitResult, ApiError> {
    blocking(move || {
        let home = home()?;
        let db = app.state::<AppState>().database(&app)?;
        resources::mcp::commit_draft(
            &db,
            &SystemCredentialStore,
            &adapters::Registry::builtins(),
            &home,
            draft,
            targets,
        )
        .map_err(native_error)
    })
    .await
}

#[tauri::command]
pub async fn distribute_mcp(
    app: AppHandle,
    definition_id: String,
    targets: Vec<resources::mcp::McpTargetRequest>,
) -> Result<Vec<resources::mcp::McpTargetResult>, ApiError> {
    blocking(move || {
        let home = home()?;
        let db = app.state::<AppState>().database(&app)?;
        Ok(resources::mcp::distribute(
            &db,
            &SystemCredentialStore,
            &adapters::Registry::builtins(),
            &home,
            &definition_id,
            targets,
        ))
    })
    .await
}

#[tauri::command]
pub async fn preview_rule_targets(
    app: AppHandle,
    rule_id: String,
    targets: Vec<resources::rules::RuleTarget>,
) -> Result<Vec<resources::rules::RulePreview>, ApiError> {
    blocking(move || {
        let home = home()?;
        let db = app.state::<AppState>().database(&app)?;
        Ok(resources::rules::preview(
            &db,
            &adapters::Registry::builtins(),
            &home,
            &rule_id,
            targets,
        ))
    })
    .await
}

#[tauri::command]
pub async fn list_rule_placements(
    app: AppHandle,
) -> Result<Vec<resources::rules::RulePlacement>, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            resources::rules::list_placements(db, &adapters::Registry::builtins(), &home()?)
                .map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn sync_rule_clients(
    app: AppHandle,
    rule_id: String,
    expected_version: u64,
    selection: resources::rules::RuleClientSelection,
) -> Result<Vec<resources::rules::RuleSyncResult>, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            resources::rules::sync_clients(
                db,
                &SystemCredentialStore,
                &adapters::Registry::builtins(),
                &home()?,
                &rule_id,
                expected_version,
                selection,
            )
            .map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn apply_rule_targets(
    app: AppHandle,
    rule_id: String,
    expected_version: u64,
    targets: Vec<resources::rules::RuleTarget>,
) -> Result<Vec<resources::rules::RuleApplyResult>, ApiError> {
    blocking(move || {
        let home = home()?;
        let db = app.state::<AppState>().database(&app)?;
        Ok(resources::rules::apply(
            &db,
            &SystemCredentialStore,
            &adapters::Registry::builtins(),
            &home,
            &rule_id,
            expected_version,
            targets,
        ))
    })
    .await
}

#[tauri::command]
pub async fn list_memories(
    app: AppHandle,
    target: resources::memory::MemoryTarget,
) -> Result<resources::memory::MemoryList, ApiError> {
    blocking(move || {
        let db = app.state::<AppState>().database(&app)?;
        resources::memory::list_memories(&db, &adapters::Registry::builtins(), &home()?, &target)
            .map_err(native_error)
    })
    .await
}

#[tauri::command]
pub async fn list_all_memories(
    app: AppHandle,
    tool_id: String,
) -> Result<resources::memory::MemoryAggregate, ApiError> {
    blocking(move || {
        let db = app.state::<AppState>().database(&app)?;
        resources::memory::list_all_memories(
            &db,
            &adapters::Registry::builtins(),
            &home()?,
            &tool_id,
        )
        .map_err(native_error)
    })
    .await
}

#[tauri::command]
pub async fn read_memories(
    app: AppHandle,
    requests: Vec<resources::memory::MemoryReadRequest>,
) -> Result<Vec<resources::memory::MemoryReadResult>, ApiError> {
    blocking(move || {
        let db = app.state::<AppState>().database(&app)?;
        resources::memory::read_memories(&db, &adapters::Registry::builtins(), &home()?, &requests)
            .map_err(native_error)
    })
    .await
}

#[tauri::command]
pub async fn set_memory_switch_group(
    app: AppHandle,
    tool_id: String,
    group_id: String,
    enabled: bool,
) -> Result<(), ApiError> {
    blocking(move || {
        let db = app.state::<AppState>().database(&app)?;
        resources::memory::set_memory_switch_group(
            &db,
            &SystemCredentialStore,
            &adapters::Registry::builtins(),
            &home()?,
            &tool_id,
            &group_id,
            enabled,
        )
        .map_err(native_error)
    })
    .await
}

#[tauri::command]
pub async fn read_memory(
    app: AppHandle,
    target: resources::memory::MemoryTarget,
    id: String,
) -> Result<resources::memory::MemoryDocument, ApiError> {
    blocking(move || {
        let db = app.state::<AppState>().database(&app)?;
        resources::memory::read_memory(&db, &adapters::Registry::builtins(), &home()?, &target, &id)
            .map_err(native_error)
    })
    .await
}

#[tauri::command]
pub async fn save_memory(
    app: AppHandle,
    request: resources::memory::MemorySave,
) -> Result<resources::memory::MemoryDocument, ApiError> {
    blocking(move || {
        let db = app.state::<AppState>().database(&app)?;
        resources::memory::save_memory(
            &db,
            &SystemCredentialStore,
            &adapters::Registry::builtins(),
            &home()?,
            &request,
        )
        .map_err(native_error)
    })
    .await
}

#[tauri::command]
pub async fn delete_memory(
    app: AppHandle,
    request: resources::memory::MemoryDelete,
) -> Result<(), ApiError> {
    blocking(move || {
        let db = app.state::<AppState>().database(&app)?;
        resources::memory::delete_memory(
            &db,
            &SystemCredentialStore,
            &adapters::Registry::builtins(),
            &home()?,
            &request,
        )
        .map_err(native_error)
    })
    .await
}

#[tauri::command]
pub async fn set_memory_enabled(
    app: AppHandle,
    request: resources::memory::MemoryEnable,
) -> Result<resources::memory::MemoryList, ApiError> {
    blocking(move || {
        let db = app.state::<AppState>().database(&app)?;
        resources::memory::set_memory_enabled(
            &db,
            &SystemCredentialStore,
            &adapters::Registry::builtins(),
            &home()?,
            &request,
        )
        .map_err(native_error)
    })
    .await
}

#[tauri::command]
pub async fn set_skill_in_library(
    app: AppHandle,
    id: String,
    in_library: bool,
) -> Result<(), ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            resources::skills::set_in_library(db, &id, in_library).map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn list_skill_packages(
    app: AppHandle,
) -> Result<Vec<resources::skills::SkillPackage>, ApiError> {
    blocking(move || {
        app.state::<AppState>()
            .with_database(&app, |db| resources::skills::list(db).map_err(native_error))
    })
    .await
}

#[tauri::command]
pub async fn preview_skill_local(
    app: AppHandle,
    source: String,
) -> Result<resources::skills::SkillImportPreview, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            resources::skills::preview_local(db, &source).map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn import_skill_local(
    app: AppHandle,
    source: String,
    expected_new: Option<String>,
    expected_existing: Option<String>,
) -> Result<resources::skills::SkillPackage, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            resources::skills::import_local(
                db,
                &source,
                expected_new.as_deref(),
                expected_existing.as_deref(),
            )
            .map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn list_skill_zip_entries(source: String, local: bool) -> Result<Vec<String>, ApiError> {
    blocking(move || resources::skills::list_zip_entries(&source, local).map_err(native_error))
        .await
}

#[tauri::command]
pub async fn preview_skill_local_zip(
    app: AppHandle,
    source: String,
    subdirectory: Option<String>,
) -> Result<resources::skills::SkillImportPreview, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            resources::skills::preview_local_zip(db, &source, subdirectory.as_deref())
                .map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn import_skill_local_zip(
    app: AppHandle,
    source: String,
    subdirectory: Option<String>,
    expected_new: Option<String>,
    expected_existing: Option<String>,
) -> Result<resources::skills::SkillPackage, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            resources::skills::import_local_zip(
                db,
                &source,
                subdirectory.as_deref(),
                expected_new.as_deref(),
                expected_existing.as_deref(),
            )
            .map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn preview_skill_https_zip(
    app: AppHandle,
    source: String,
    subdirectory: Option<String>,
) -> Result<resources::skills::SkillImportPreview, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            resources::skills::preview_https_zip(db, &source, subdirectory.as_deref())
                .map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn import_skill_https_zip(
    app: AppHandle,
    source: String,
    subdirectory: Option<String>,
    expected_new: Option<String>,
    expected_existing: Option<String>,
) -> Result<resources::skills::SkillPackage, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            resources::skills::import_https_zip(
                db,
                &source,
                subdirectory.as_deref(),
                expected_new.as_deref(),
                expected_existing.as_deref(),
            )
            .map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn list_skill_installations(
    app: AppHandle,
    package_id: String,
) -> Result<Vec<resources::skills::SkillInstallation>, ApiError> {
    blocking(move || {
        let home = home()?;
        let db = app.state::<AppState>().database(&app)?;
        resources::skills::installations(&db, &adapters::Registry::builtins(), &home, &package_id)
            .map_err(native_error)
    })
    .await
}

#[tauri::command]
pub async fn list_skill_recovery_issues(
    app: AppHandle,
) -> Result<Vec<resources::skills::SkillRecoveryIssue>, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            resources::skills::recover_report(db).map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn scan_native_skills(
    app: AppHandle,
    tool_id: String,
    scope: Scope,
    project_path: Option<String>,
) -> Result<Vec<resources::skills::NativeSkillEntry>, ApiError> {
    blocking(move || {
        let home = home()?;
        let db = app.state::<AppState>().database(&app)?;
        resources::skills::scan_native(
            &db,
            &adapters::Registry::builtins(),
            &home,
            &tool_id,
            scope,
            project_path.as_deref(),
        )
        .map_err(native_error)
    })
    .await
}

#[tauri::command]
pub async fn read_native_skill(
    app: AppHandle,
    tool_id: String,
    scope: Scope,
    project_path: Option<String>,
    directory: String,
) -> Result<resources::skills::NativeSkillDocument, ApiError> {
    blocking(move || {
        let home = home()?;
        let db = app.state::<AppState>().database(&app)?;
        resources::skills::read_document(
            &db,
            &adapters::Registry::builtins(),
            &home,
            &tool_id,
            scope,
            project_path.as_deref(),
            &directory,
        )
        .map_err(native_error)
    })
    .await
}

#[tauri::command]
pub async fn list_native_skill_files(
    app: AppHandle,
    tool_id: String,
    scope: Scope,
    project_path: Option<String>,
    directory: String,
) -> Result<resources::skills::SkillFileListing, ApiError> {
    blocking(move || {
        let home = home()?;
        let db = app.state::<AppState>().database(&app)?;
        resources::skills::list_files(&db, &adapters::Registry::builtins(), &home, &tool_id, scope, project_path.as_deref(), &directory)
            .map_err(native_error)
    })
    .await
}

#[tauri::command]
pub async fn read_native_skill_file(
    app: AppHandle,
    tool_id: String,
    scope: Scope,
    project_path: Option<String>,
    directory: String,
    path: String,
) -> Result<resources::skills::SkillFilePreview, ApiError> {
    blocking(move || {
        let home = home()?;
        let db = app.state::<AppState>().database(&app)?;
        resources::skills::read_file(&db, &adapters::Registry::builtins(), &home, &tool_id, scope, project_path.as_deref(), &directory, &path)
            .map_err(native_error)
    })
    .await
}

/// Resolves file references of one skill document; `None` for each target that is not a readable file.
#[tauri::command]
pub async fn resolve_native_skill_references(
    app: AppHandle,
    tool_id: String,
    scope: Scope,
    project_path: Option<String>,
    directory: String,
    from: String,
    targets: Vec<String>,
) -> Result<Vec<Option<String>>, ApiError> {
    blocking(move || {
        let home = home()?;
        let db = app.state::<AppState>().database(&app)?;
        resources::skills::resolve_references(&db, &adapters::Registry::builtins(), &home, &tool_id, scope, project_path.as_deref(), &directory, &from, &targets)
            .map_err(native_error)
    })
    .await
}

/// Reads a file a skill references, by path relative to the skill directory.
#[tauri::command]
pub async fn read_native_skill_reference(
    app: AppHandle,
    tool_id: String,
    scope: Scope,
    project_path: Option<String>,
    directory: String,
    path: String,
) -> Result<resources::skills::SkillFilePreview, ApiError> {
    blocking(move || {
        let home = home()?;
        let db = app.state::<AppState>().database(&app)?;
        resources::skills::read_reference(&db, &adapters::Registry::builtins(), &home, &tool_id, scope, project_path.as_deref(), &directory, &path)
            .map_err(native_error)
    })
    .await
}

/// Reads SKILL.md text the frontend already holds. Pure: no file access.
#[tauri::command]
pub fn analyze_skill_document(
    directory_name: String,
    content: String,
) -> resources::skill_manifest::SkillManifest {
    resources::skill_manifest::analyze(&content, &directory_name)
}

#[tauri::command]
pub async fn save_native_skill(
    app: AppHandle,
    tool_id: String,
    scope: Scope,
    project_path: Option<String>,
    directory: String,
    baseline: String,
    content: String,
) -> Result<(), ApiError> {
    blocking(move || {
        let home = home()?;
        let db = app.state::<AppState>().database(&app)?;
        resources::skills::save_document(
            &db,
            &SystemCredentialStore,
            &adapters::Registry::builtins(),
            &home,
            &tool_id,
            scope,
            project_path.as_deref(),
            &directory,
            &baseline,
            &content,
        )
        .map_err(native_error)
    })
    .await
}

#[tauri::command]
pub async fn preview_skill_target(
    app: AppHandle,
    package_id: String,
    tool_id: String,
    scope: Scope,
    project_path: Option<String>,
) -> Result<resources::skills::SkillTargetPreview, ApiError> {
    blocking(move || {
        let home = home()?;
        let db = app.state::<AppState>().database(&app)?;
        resources::skills::preview_target(
            &db,
            &adapters::Registry::builtins(),
            &home,
            &package_id,
            &tool_id,
            scope,
            project_path.as_deref(),
        )
        .map_err(native_error)
    })
    .await
}

#[tauri::command]
pub async fn install_skill(
    app: AppHandle,
    package_id: String,
    tool_id: String,
    scope: Scope,
    project_path: Option<String>,
    preview_token: Option<String>,
    allow_takeover: bool,
) -> Result<resources::skills::SkillTargetResult, ApiError> {
    blocking(move || {
        let home = home()?;
        let db = app.state::<AppState>().database(&app)?;
        Ok(resources::skills::install_confirmed(
            &db,
            &adapters::Registry::builtins(),
            &home,
            &package_id,
            &tool_id,
            scope,
            project_path.as_deref(),
            preview_token.as_deref(),
            allow_takeover,
        ))
    })
    .await
}

#[tauri::command]
pub async fn delete_skill_package(app: AppHandle, package_id: String) -> Result<(), ApiError> {
    blocking(move || {
        let home = home()?;
        let db = app.state::<AppState>().database(&app)?;
        resources::skills::delete_package(&db, &adapters::Registry::builtins(), &home, &package_id)
            .map_err(native_error)
    })
    .await
}

#[tauri::command]
pub async fn remove_skill(
    app: AppHandle,
    expected_context_id: Option<String>,
    package_id: String,
    tool_id: String,
    scope: Scope,
    project_path: Option<String>,
) -> Result<resources::skills::SkillTargetResult, ApiError> {
    blocking(move || {
        let home = home()?;
        let db = app.state::<AppState>().database(&app)?;
        let _context = crate::accounts::selection::enter_bound(
            &db,
            &home,
            &tool_id,
            scope,
            project_path.as_deref().map(Path::new),
        )
        .map_err(native_error)?;
        crate::accounts::selection::validate_expected(&tool_id, expected_context_id.as_deref())
            .map_err(native_error)?;
        Ok(resources::skills::remove(
            &db,
            &adapters::Registry::builtins(),
            &home,
            &package_id,
            &tool_id,
            scope,
            project_path.as_deref(),
        ))
    })
    .await
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
    pub effective_context_id: Option<String>,
    pub native_context_error: Option<String>,
    pub snapshots: Vec<NativeSnapshot>,
    pub recovery_needed: Vec<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredToolWorkspace {
    pub probe: ToolProbe,
    pub custom_path: Option<String>,
    pub profiles: Vec<RegisteredProfile>,
    pub profile_model_summaries:
        std::collections::BTreeMap<String, Option<crate::native::configuration::ModelSummary>>,
    pub common: Option<RegisteredCommon>,
    pub binding: Option<AppliedBinding>,
    pub effective_context_id: Option<String>,
    pub native_context_error: Option<String>,
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
    match transaction::native_file_present(Path::new(&file.path)) {
        Ok(true) => NativeSnapshot {
            role: file.role.into(),
            fingerprint: Some("present".into()),
            text: None,
            error: Some("点击“编辑当前磁盘原文”可查看和修改完整文件".into()),
        },
        Ok(false) => NativeSnapshot {
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
pub async fn get_registered_tool_context(
    app: AppHandle,
    tool_id: String,
    scope: Scope,
    project_path: Option<String>,
) -> Result<RegisteredToolContext, ApiError> {
    blocking(move || {
        let home = home()?;
        let project = checked_project(scope, project_path)?;
        if adapters::Registry::builtins().get(&tool_id).is_none() {
            return Err(native_error("此 CLI 适配器未注册".into()));
        }
        let database = app.state::<AppState>().database(&app)?;
        match crate::accounts::selection::bound(
            &database,
            &home,
            &tool_id,
            scope,
            project.as_deref(),
            false,
        ) {
            Ok(context) => Ok(RegisteredToolContext {
                effective_context_id: context.map(|(_, context)| context.id),
                native_context_error: None,
            }),
            Err(error) => Ok(RegisteredToolContext {
                effective_context_id: None,
                native_context_error: Some(error),
            }),
        }
    })
    .await
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredToolContext {
    pub effective_context_id: Option<String>,
    pub native_context_error: Option<String>,
}

#[tauri::command]
pub async fn get_registered_tool_workspace(
    app: AppHandle,
    tool_id: String,
    scope: Scope,
    project_path: Option<String>,
    summary: Option<bool>,
    fresh: Option<bool>,
) -> Result<RegisteredToolWorkspace, ApiError> {
    let summary = summary.unwrap_or(false);
    let fresh = fresh.unwrap_or(false);
    blocking(move || {
        let home = home()?;
        let project = checked_project(scope, project_path)?;
        let registry = adapters::Registry::builtins();
        if registry.get(&tool_id).is_none() {
            return Err(native_error("此 CLI 适配器未注册；已有资料只读保留".into()));
        }
        let state = app.state::<AppState>();
        state.with_database(&app, |database| {
            let key = match scope {
                Scope::Global => "global".into(),
                Scope::Project => format!("project:{}", project.as_ref().unwrap().display()),
            };
            let saved =
                crate::native::workspace::saved_workspace(&registry, database, &tool_id, &key)
                    .map_err(native_error)?;
            let (_context, context_error) = match crate::accounts::selection::enter_bound(
                database,
                &home,
                &tool_id,
                scope,
                project.as_deref(),
            ) {
                Ok(context) => (Some(context), None),
                Err(error) => (None, Some(error)),
            };
            let custom = registered_tool_path(database, &tool_id).map_err(native_error)?;
            // The quick-start page only needs the selected CLI version. Skip sibling shims,
            // native file reads, and pending-transaction recovery.
            let mut probe = if summary || context_error.is_some() {
                adapter::probe_registered_summary_cached(
                    &registry,
                    &tool_id,
                    custom.as_deref(),
                    &home,
                    project.as_deref(),
                    scope,
                    fresh,
                )
            } else {
                adapter::probe_registered_cached(
                    &registry,
                    &tool_id,
                    custom.as_deref(),
                    &home,
                    project.as_deref(),
                    scope,
                    fresh,
                )
            }
            .map_err(native_error)?;
            let recovery_needed = if summary || context_error.is_some() {
                Vec::new()
            } else {
                transaction::recover_pending(database, &SystemCredentialStore)
                    .map_err(native_error)?
            };
            if context_error.is_some() {
                probe.native_files.clear();
            }
            let snapshots = if summary {
                Vec::new()
            } else {
                probe.native_files.iter().map(native_snapshot).collect()
            };
            Ok(RegisteredToolWorkspace {
                effective_context_id: crate::accounts::selection::current(&tool_id)
                    .map(|context| context.id),
                native_context_error: context_error,
                probe,
                custom_path: custom.map(|path| path.display().to_string()),
                profiles: saved.profiles,
                profile_model_summaries: saved.profile_model_summaries,
                common: saved.common,
                binding: saved.binding,
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
            let (_context, context_error) = match crate::accounts::selection::enter_bound(
                database,
                &home,
                tool.stable_id(),
                scope,
                project.as_deref(),
            ) {
                Ok(context) => (Some(context), None),
                Err(error) => (None, Some(error)),
            };
            let custom = tool_path(database, tool).map_err(native_error)?;
            let mut probe = if context_error.is_some() {
                adapter::probe_registered_summary_cached(
                    &adapters::Registry::builtins(),
                    tool.stable_id(),
                    custom.as_deref(),
                    &home,
                    project.as_deref(),
                    scope,
                    false,
                )
                .map_err(native_error)?
            } else {
                adapter::probe(tool, custom.as_deref(), &home, project.as_deref(), scope)
            };
            let key = match scope {
                Scope::Global => "global".into(),
                Scope::Project => format!("project:{}", project.as_ref().unwrap().display()),
            };
            let profiles = profile::list_profiles(database, tool).map_err(native_error)?;
            let common = profile::get_common(database, tool).map_err(native_error)?;
            let recovery_needed = if context_error.is_some() {
                Vec::new()
            } else {
                transaction::recover_pending(database, &SystemCredentialStore)
                    .map_err(native_error)?
            };
            if context_error.is_some() {
                probe.native_files.clear();
            }
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
                effective_context_id: crate::accounts::selection::current(tool.stable_id())
                    .map(|context| context.id),
                native_context_error: context_error,
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
    expected_revision: String,
) -> Result<(), ApiError> {
    state.with_database(&app, |database| {
        let removed = profile::get_registered_profile(database, &id).map_err(native_error)?;
        profile::delete_profile(database, &id, expected_version, &expected_revision).map_err(native_error)?;
        for secret_ref in profile::credential_refs(&removed) {
            let _ = crate::native::workspace::cleanup_unreferenced_credential(
                database,
                &SystemCredentialStore,
                &secret_ref,
            );
        }
        Ok(())
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
        app.state::<AppState>().with_database(&app, |database| {
            let saved =
                profile::save_common(database, common, expected_version).map_err(native_error)?;
            Ok(CommonSaveResult {
                common: saved,
                applications: Vec::new(),
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

/// Explicit user action; only app-managed API-key IDs are readable here, never OAuth or backup credentials.
#[tauri::command]
pub async fn get_skill_enabled(
    app: AppHandle,
    package_id: String,
    tool_id: String,
    scope: Scope,
    project_path: Option<String>,
) -> Result<bool, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            resources::skills::enabled(
                db,
                &adapters::Registry::builtins(),
                &home()?,
                &package_id,
                &tool_id,
                scope,
                project_path.as_deref(),
            )
            .map_err(native_error)
        })
    })
    .await
}
#[tauri::command]
pub async fn set_skill_enabled(
    app: AppHandle,
    expected_context_id: Option<String>,
    package_id: String,
    tool_id: String,
    scope: Scope,
    project_path: Option<String>,
    enabled: bool,
) -> Result<(), ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            let home = home()?;
            let _context = crate::accounts::selection::enter_bound(
                db,
                &home,
                &tool_id,
                scope,
                project_path.as_deref().map(Path::new),
            )
            .map_err(native_error)?;
            crate::accounts::selection::validate_expected(&tool_id, expected_context_id.as_deref())
                .map_err(native_error)?;
            resources::skills::set_enabled(
                db,
                &SystemCredentialStore,
                &adapters::Registry::builtins(),
                &home,
                &package_id,
                &tool_id,
                scope,
                project_path.as_deref(),
                enabled,
            )
            .map_err(native_error)
        })
    })
    .await
}
#[tauri::command]
pub async fn get_native_rule_enabled(
    app: AppHandle,
    target: rules::RuleTarget,
) -> Result<bool, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            rules::enabled(db, &adapters::Registry::builtins(), &home()?, &target)
                .map_err(native_error)
        })
    })
    .await
}
#[tauri::command]
pub async fn set_native_rule_enabled(
    app: AppHandle,
    target: rules::RuleTarget,
    enabled: bool,
) -> Result<(), ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            rules::set_enabled(
                db,
                &SystemCredentialStore,
                &adapters::Registry::builtins(),
                &home()?,
                &target,
                enabled,
            )
            .map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn read_native_rule(
    app: AppHandle,
    target: rules::RuleTarget,
) -> Result<rules::NativeRule, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            rules::read_current(db, &adapters::Registry::builtins(), &home()?, &target)
                .map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn save_native_rule(
    app: AppHandle,
    target: rules::RuleTarget,
    original: String,
    edited: String,
) -> Result<transaction::ApplyOutcome, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            rules::save_current(
                db,
                &SystemCredentialStore,
                &adapters::Registry::builtins(),
                &home()?,
                &target,
                &original,
                &edited,
            )
            .map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn list_native_rule_files(
    app: AppHandle,
    target: rules::RuleTarget,
) -> Result<Vec<rules::NativeRuleFile>, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            rules::list_files(db, &adapters::Registry::builtins(), &home()?, &target)
                .map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn save_native_rule_file(
    app: AppHandle,
    target: rules::RuleTarget,
    path: String,
    original: String,
    edited: String,
) -> Result<transaction::ApplyOutcome, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            rules::save_file(
                db,
                &SystemCredentialStore,
                &adapters::Registry::builtins(),
                &home()?,
                &target,
                &path,
                &original,
                &edited,
            )
            .map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn create_native_rule_file(
    app: AppHandle,
    target: rules::RuleTarget,
    name: String,
    text: String,
) -> Result<transaction::ApplyOutcome, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            rules::create_file(
                db,
                &SystemCredentialStore,
                &adapters::Registry::builtins(),
                &home()?,
                &target,
                &name,
                &text,
            )
            .map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn delete_native_rule_file(
    app: AppHandle,
    target: rules::RuleTarget,
    path: String,
    original: String,
) -> Result<transaction::ApplyOutcome, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            rules::delete_file(
                db,
                &SystemCredentialStore,
                &adapters::Registry::builtins(),
                &home()?,
                &target,
                &path,
                &original,
            )
            .map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn set_native_rule_file_enabled(
    app: AppHandle,
    target: rules::RuleTarget,
    path: String,
    enabled: bool,
    original: String,
) -> Result<transaction::ApplyOutcome, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            rules::set_file_enabled(
                db,
                &SystemCredentialStore,
                &adapters::Registry::builtins(),
                &home()?,
                &target,
                &path,
                enabled,
                &original,
            )
            .map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn launch_cli_login(
    app: AppHandle,
    tool_id: String,
) -> Result<launch::LaunchResult, ApiError> {
    blocking(move || {
        let home = home()?;
        app.state::<AppState>().with_database(&app, |db| {
            let custom = registered_tool_path(db, &tool_id).map_err(native_error)?;
            let plan = launch::login_plan(
                db,
                &adapters::Registry::builtins(),
                &home,
                &tool_id,
                custom.as_deref(),
            )
            .map_err(native_error)?;
            launch::spawn(db, plan).map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn get_connection_secret(secret_ref: String) -> Result<String, ApiError> {
    blocking(move || {
        if !profile::valid_connection_secret_ref(&secret_ref) {
            return Err(native_error("不是本应用保存的 API 密钥".into()));
        }
        SystemCredentialStore.get(&secret_ref).map_err(native_error)
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
            let _context = crate::accounts::selection::enter_bound(
                database,
                &home,
                tool.stable_id(),
                scope,
                project.as_deref(),
            )
            .map_err(native_error)?;
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
            let _context = crate::accounts::selection::enter_bound(
                database,
                &home,
                tool.stable_id(),
                scope,
                project.as_deref(),
            )
            .map_err(native_error)?;
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
        app.state::<AppState>().with_database(&app, |database| {
            let saved = profile::save_registered_common(
                database,
                &adapters::Registry::builtins(),
                common,
                expected_version,
            )
            .map_err(native_error)?;
            Ok(RegisteredCommonSaveResult {
                common: saved,
                applications: Vec::new(),
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

#[tauri::command]
pub async fn reapply_account_profile(
    app: AppHandle,
    request: crate::accounts::AccountReapplyRequest,
) -> Result<ApplyOutcome, ApiError> {
    blocking(move || {
        let _intent = crate::accounts::enter_reapply(request.clone()).map_err(native_error)?;
        apply_registered_now(
            &app,
            &request.tool_id,
            &request.profile_id,
            request.scope,
            request.project_path,
            false,
        )
    })
    .await
}

#[tauri::command]
pub async fn compare_registered_application(
    app: AppHandle,
    profile_id: String,
    scope: Scope,
    project_path: Option<String>,
) -> Result<apply::ApplyComparison, ApiError> {
    blocking(move || {
        let home = home()?;
        let project = checked_project(scope, project_path)?;
        let db = app.state::<AppState>().database(&app)?;
        apply::compare_registered_application(
            &adapters::Registry::builtins(),
            &db,
            &home,
            scope,
            project.as_deref(),
            &profile_id,
        )
        .map_err(native_error)
    })
    .await
}
#[tauri::command]
pub async fn apply_compared_application(
    app: AppHandle,
    comparison: apply::ApplyComparison,
    scope: Scope,
    project_path: Option<String>,
) -> Result<ApplyOutcome, ApiError> {
    blocking(move || {
        let home = home()?;
        let project = checked_project(scope, project_path)?;
        let state = app.state::<AppState>();
        let result = state.with_database(&app, |db| {
            let custom =
                registered_tool_path(db, &comparison.profile.tool).map_err(native_error)?;
            let result = apply::apply_compared_application(
                &adapters::Registry::builtins(),
                db,
                &SystemCredentialStore,
                &comparison,
                &home,
                scope,
                project.as_deref(),
                custom.as_deref(),
            )
            .map_err(native_error)?;
            if let Some(path) = project.as_deref() {
                if let Err(error) = projects::record_applied_profile(
                    db,
                    path,
                    &comparison.profile.tool,
                    &comparison.profile.id,
                ) {
                    let _ = app.emit(
                        "cliora:tray-error",
                        format!("配置已应用，但项目快捷选择未能保存：{error}"),
                    );
                }
            }
            Ok(result)
        })?;
        let _ = app.emit("cliora:bindings-changed", &comparison.profile.tool);
        Ok(result)
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
pub async fn rename_project(
    app: AppHandle,
    project_id: String,
    name: String,
) -> Result<projects::Project, ApiError> {
    let notify = app.clone();
    let result = blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            portable::with_change_notification(
                db,
                || notify_portable_changed(&app),
                || projects::rename(db, &project_id, &name).map_err(native_error),
            )
        })
    })
    .await?;
    let _ = notify.emit("cliora:projects-changed", &result.id);
    Ok(result)
}
#[tauri::command]
pub async fn remove_project(app: AppHandle, project_id: String) -> Result<(), ApiError> {
    let notify = app.clone();
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            portable::with_change_notification(
                db,
                || notify_portable_changed(&app),
                || projects::remove(db, &project_id).map_err(native_error),
            )
        })
    })
    .await?;
    let _ = notify.emit("cliora:projects-changed", "removed");
    Ok(())
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
            portable::with_change_notification(
                db,
                || notify_portable_changed(&app),
                || {
                    let previous = projects::get(db, &project_id).map_err(native_error)?;
                    let project =
                        projects::relink(db, &project_id, &project_path).map_err(native_error)?;
                    if let (Some(old), Some(new_path)) = (
                        previous.path.as_deref().filter(|path| !path.is_empty()),
                        project.path.as_deref(),
                    ) {
                        portable::apply_relinked_directory(
                            db,
                            &SystemCredentialStore,
                            &adapters::Registry::builtins(),
                            old,
                            new_path,
                        )
                        .map_err(native_error)?;
                    }
                    Ok(project)
                },
            )
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
pub async fn set_custom_terminal(
    app: AppHandle,
    program: String,
    args: Vec<String>,
) -> Result<launch::LaunchSettings, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            launch::set_custom_terminal(db, program, args).map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn set_default_launch_mode(
    app: AppHandle,
    target: String,
    mode: adapters::LaunchMode,
) -> Result<launch::LaunchSettings, ApiError> {
    let tray = app.clone();
    let settings = blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            launch::set_default_mode(db, &target, mode).map_err(native_error)
        })
    })
    .await?;
    std::thread::spawn(move || {
        let _ = crate::tray::refresh(&tray);
    });
    Ok(settings)
}

#[tauri::command]
pub async fn cli_latest_version(
    tool_id: String,
    version: Option<String>,
) -> Result<String, ApiError> {
    blocking(move || {
        let registry = adapters::Registry::builtins();
        let adapter = registry
            .get(&tool_id)
            .ok_or_else(|| native_error("此 CLI 适配器未注册".into()))?;
        crate::native::releases::latest_for(adapter, version.as_deref()).map_err(native_error)
    })
    .await
}

#[tauri::command]
pub async fn maintain_registered_cli(
    app: AppHandle,
    tool_id: String,
    action: String,
    source: Option<String>,
    version: Option<String>,
) -> Result<crate::native::maintenance::MaintenanceResult, ApiError> {
    blocking(move || {
        crate::native::maintenance::maintain(
            &adapters::Registry::builtins(),
            &tool_id,
            &action,
            source.as_deref().unwrap_or("unknown"),
            version.as_deref(),
            &home()?,
            |progress| {
                let _ = app.emit("cliora:maintenance-progress", progress);
            },
        )
        .map_err(native_error)
    })
    .await
}

/// Run an adapter-declared lifecycle command on the selected SSH target.
/// Remote maintenance never touches the local installation registry.
#[tauri::command]
pub async fn maintain_remote_cli(
    app: AppHandle,
    target_id: String,
    tool_id: String,
    action: String,
    source: Option<String>,
    version: Option<String>,
) -> Result<crate::native::maintenance::MaintenanceResult, ApiError> {
    blocking(move || {
        let database = app.state::<AppState>().database(&app)?;
        crate::remote::ensure_enabled(&database).map_err(|error| native_error(error.to_string()))?;
        let target = crate::remote::list_targets(&database)
            .map_err(|error| native_error(error.to_string()))?
            .into_iter()
            .find(|item| item.id == target_id && item.enabled)
            .ok_or_else(|| native_error("远程目标不存在或已停用".into()))?;
        let adapter = adapters::Registry::builtins()
            .get(&tool_id)
            .ok_or_else(|| native_error("此 CLI 适配器未注册".into()))?;
        let result = match action.as_str() {
            "install" | "install_native" => adapter.remote_install(&target),
            "upgrade" | "upgrade_major" => adapter.remote_upgrade(&target, source.as_deref().unwrap_or("npm_shim")),
            "uninstall_npm" => adapter.remote_uninstall(&target),
            _ => Err("不支持的远程维护操作".into()),
        }.map_err(native_error)?;
        let stdout = result.stdout;
        let output = if result.stderr.trim().is_empty() { stdout.clone() } else { format!("{}\n{}", stdout, result.stderr) };
        Ok(crate::native::maintenance::MaintenanceResult { output, version: version.or_else(|| stdout.lines().find(|line| !line.trim().is_empty()).map(ToOwned::to_owned)) })
    }).await
}

#[tauri::command]
pub fn cancel_cli_maintenance(tool_id: String) {
    crate::native::maintenance::cancel(&tool_id);
}

#[tauri::command]
pub async fn launch_cli(
    app: AppHandle,
    request: launch::LaunchRequest,
) -> Result<launch::LaunchResult, ApiError> {
    blocking(move || launch_now(&app, request)).await
}

#[tauri::command]
pub fn list_workbench_sessions() -> Vec<crate::session_host::SessionSnapshot> {
    crate::session_host::list()
}

pub(crate) fn checkpoint_workbench(app: &AppHandle) -> Result<(), String> {
    let database = app.state::<AppState>().database(app).map_err(|error| error.message)?;
    crate::workbench_restore::checkpoint(&database)
}

#[tauri::command]
pub async fn checkpoint_workbench_sessions(app: AppHandle) -> Result<(), ApiError> {
    blocking(move || checkpoint_workbench(&app).map_err(native_error)).await
}

#[tauri::command]
pub async fn restore_workbench_sessions(app: AppHandle) -> Result<crate::workbench_restore::RestoreReport, ApiError> {
    blocking(move || {
        let db = app.state::<AppState>().database(&app)?;
        crate::workbench_restore::restore(&db, &adapters::Registry::builtins(), &home()?).map_err(native_error)
    }).await
}

#[tauri::command]
pub async fn forget_workbench_restore(app: AppHandle, session_id: String) -> Result<(), ApiError> {
    blocking(move || {
        let db = app.state::<AppState>().database(&app)?;
        crate::workbench_restore::forget(&db, &session_id).map_err(native_error)
    }).await
}

#[tauri::command]
pub async fn list_remote_sessions(
    app: AppHandle,
) -> Result<Vec<crate::launch::RemoteSessionIndexEntry>, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            launch::list_remote_sessions(db).map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn list_remote_history(
    app: AppHandle,
) -> Result<Vec<crate::launch::RemoteSessionIndexEntry>, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            launch::list_remote_history(db).map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn list_remote_native_history(
    app: AppHandle,
    target_id: String,
    refresh: bool,
) -> Result<Vec<history::HistorySession>, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            let target = enabled_target(db, &target_id)?;
            history::remote_native::list(&adapters::Registry::builtins(), &target, refresh).map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn get_remote_native_history(
    app: AppHandle,
    target_id: String,
    id: String,
) -> Result<history::HistoryDetail, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            let target = enabled_target(db, &target_id)?;
            history::remote_native::detail(&adapters::Registry::builtins(), &target, &id).map_err(native_error)
        })
    })
    .await
}

fn enabled_target(db: &crate::database::Database, target_id: &str) -> Result<crate::remote::RemoteTarget, ApiError> {
    crate::remote::ensure_enabled(db).map_err(|error| native_error(error.to_string()))?;
    crate::remote::list_targets(db)
        .map_err(|error| native_error(error.to_string()))?
        .into_iter()
        .find(|item| item.id == target_id && item.enabled)
        .ok_or_else(|| native_error("远程主机不可用".into()))
}

#[tauri::command]
pub async fn replay_workbench_session(session_id: String) -> Result<crate::session_host::ReplaySnapshot, ApiError> {
    blocking(move || crate::session_host::replay_snapshot(&session_id).map_err(native_error)).await
}

/// Branch and worktree of a local session directory; `None` when it is not in a repository or runs remotely.
#[tauri::command]
pub async fn workbench_git_context(session_id: String) -> Result<Option<crate::git_context::GitContext>, ApiError> {
    blocking(move || {
        let directory = crate::session_host::local_directory(&session_id).map_err(native_error)?;
        Ok(directory.and_then(|path| crate::git_context::read(&path)))
    }).await
}

/// Update the visible local working directory from shell integration (OSC 7 /
/// OSC 1337). The session host validates and canonicalizes the path.
#[tauri::command]
pub async fn set_workbench_directory(session_id: String, directory: String) -> Result<String, ApiError> {
    blocking(move || crate::session_host::set_directory(&session_id, &directory).map_err(native_error)).await
}

#[tauri::command]
pub async fn write_workbench_session(
    session_id: String,
    data_base64: String,
) -> Result<(), ApiError> {
    blocking(move || crate::session_host::write(&session_id, &data_base64).map_err(native_error))
        .await
}

#[tauri::command]
pub async fn resize_workbench_session(
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), ApiError> {
    blocking(move || crate::session_host::resize(&session_id, cols, rows).map_err(native_error))
        .await
}

#[tauri::command]
pub async fn close_workbench_session(app: AppHandle, session_id: String) -> Result<(), ApiError> {
    blocking(move || {
        let database = app.state::<AppState>().database(&app)?;
        let remote_id = crate::session_host::remote_session_id(&session_id);
        let remote_project_id = crate::session_host::list().into_iter().find(|item| item.id == session_id)
            .and_then(|item| item.project_id).and_then(|id| id.strip_prefix("remote:").map(str::to_owned));
        let remote_target_id = remote_project_id.as_deref().and_then(|project_id| {
            crate::remote::list_projects(&database, None).ok()?.into_iter().find(|item| item.id == project_id).map(|item| item.target_id)
        });
        crate::session_host::close_with_cleanup(&session_id, || {
            if let (Some(remote_id), Some(target_id)) = (remote_id, remote_target_id) {
                crate::launch::forget_remote_session(&database, &target_id, &remote_id)?;
            }
            crate::workbench_restore::forget(&database, &session_id)
        }).map_err(native_error)?;
        Ok(())
    }).await
}

#[tauri::command]
pub async fn reattach_workbench_session(session_id: String, cols: Option<u16>, rows: Option<u16>) -> Result<(), ApiError> {
    blocking(move || {
        let size = match (cols, rows) {
            (Some(cols), Some(rows)) => Some((cols, rows)),
            (None, None) => None,
            _ => return Err(native_error("重新附着需要完整的终端尺寸".into())),
        };
        crate::session_host::reattach(&session_id, size).map_err(native_error)
    }).await
}

#[tauri::command]
pub fn get_tray_status(app: AppHandle) -> crate::tray::TrayStatus {
    app.state::<crate::tray::TrayState>().status()
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    crate::session_host::shutdown();
    app.exit(0);
}

pub(crate) struct LaunchFailure {
    pub error: ApiError,
    pub stage: launch::LaunchStage,
    pub project_path: Option<String>,
    pub profile_id: Option<String>,
}

impl LaunchFailure {
    fn new(stage: launch::LaunchStage, error: ApiError) -> Box<Self> {
        Box::new(Self {
            error,
            stage,
            project_path: None,
            profile_id: None,
        })
    }
}

pub(crate) fn launch_now(
    app: &AppHandle,
    request: launch::LaunchRequest,
) -> Result<launch::LaunchResult, ApiError> {
    launch_now_with_stage(app, request).map_err(|failure| failure.error)
}

pub(crate) fn launch_now_with_stage(
    app: &AppHandle,
    request: launch::LaunchRequest,
) -> Result<launch::LaunchResult, Box<LaunchFailure>> {
    use launch::LaunchStage;
    let home = home().map_err(|error| LaunchFailure::new(LaunchStage::ProjectDirectory, error))?;
    let project_id = request.project_id.clone();
    let launch_tool_id = request.tool_id.clone();
    let launch_mode = request.mode;
    // Remote projects live in the remote_projects table and are resolved by
    // launch::remote_launch_plan. Do not send their `remote:<id>` key through
    // the local project lookup, otherwise a valid remote project is reported
    // as “项目不存在” before the remote launch planner runs.
    let project = project_id
        .as_deref()
        .filter(|id| !id.starts_with("remote:"))
        .map(|id| {
            app.state::<AppState>()
                .with_database(app, |db| projects::get(db, id).map_err(native_error))
                .map_err(|error| LaunchFailure::new(LaunchStage::ProjectDirectory, error))
        })
        .transpose()?;
    if let Some(project) = &project {
        let path = project.path.as_deref().ok_or_else(|| {
            LaunchFailure::new(
                LaunchStage::ProjectDirectory,
                native_error("项目尚未关联本机目录".into()),
            )
        })?;
        projects::checked_directory(path).map_err(|message| {
            LaunchFailure::new(LaunchStage::ProjectDirectory, native_error(message))
        })?;
        if let Some(profile_id) = project.reapply_profiles.get(&request.tool_id) {
            apply_registered_now(
                app,
                &request.tool_id,
                profile_id,
                Scope::Project,
                Some(path.to_owned()),
                false,
            )
            .map_err(|error| LaunchFailure {
                error,
                stage: LaunchStage::Configuration,
                project_path: Some(path.to_owned()),
                profile_id: Some(profile_id.clone()),
            })?;
        }
    }
    let project_path = project.as_ref().and_then(|item| item.path.clone());
    let plan = app
        .state::<AppState>()
        .with_database(app, |db| {
            Ok(launch::plan_with_stage(
                db,
                &adapters::Registry::builtins(),
                &home,
                request,
            ))
        })
        .map_err(|error| LaunchFailure::new(LaunchStage::Tool, error))?
        .map_err(|failure| LaunchFailure {
            error: native_error(failure.message),
            stage: failure.stage,
            project_path,
            profile_id: None,
        })?;
    let db = app
        .state::<AppState>()
        .database(app)
        .map_err(|error| LaunchFailure::new(LaunchStage::Terminal, error))?;
    // Persist the identity before a remote process can be created. A failed
    // local spawn can be inspected/recovered by its exact durable identity.
    if let (Some(project_id), Some(remote_session_id)) =
        (project_id.as_deref(), plan.remote_session_id.as_deref())
    {
        launch::remember_remote_session(&db, project_id, &launch_tool_id, launch_mode, remote_session_id)
            .map_err(|message| LaunchFailure::new(LaunchStage::Terminal, native_error(message)))?;
    }
    let mut result = launch::spawn(&db, plan)
        .map_err(|message| LaunchFailure::new(LaunchStage::Terminal, native_error(message)))?;
    if let (Some(project_id), Some(remote_session_id)) =
        (project_id.as_deref(), result.remote_session_id.as_deref())
    {
        if let Err(message) = launch::remember_remote_session(&db, project_id, &launch_tool_id, launch_mode, remote_session_id) {
            result.warnings.push(format!("会话已启动，更新恢复记录失败；请勿重复新建，可通过会话 {} 核查：{}", remote_session_id, message));
        }
    }
    if let Some(project_id) = project_id.as_deref().filter(|id| !id.starts_with("remote:")) {
        if let Err(error) = app.state::<AppState>().with_database(app, |db| {
            projects::touch(db, project_id).map_err(native_error)
        }) {
            let _ = app.emit(
                "cliora:tray-error",
                format!("终端已打开，但最近项目时间未保存：{}", error.message),
            );
        }
    }
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
            let _context = crate::accounts::selection::enter_bound(
                database,
                &home,
                &tool_id,
                scope,
                project.as_deref(),
            )
            .map_err(native_error)?;
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
            let _context = crate::accounts::selection::enter_bound(
                database,
                &home,
                &tool_id,
                scope,
                project.as_deref(),
            )
            .map_err(native_error)?;
            // Reading a declared, non-sensitive file does not require starting
            // every installed CLI to check its version. Saving still performs
            // fresh capability checks and the native transaction comparison.
            adapters::read_registered_file(
                &registry,
                &tool_id,
                &role,
                scope,
                &home,
                project.as_deref(),
                false,
            )
            .map_err(native_error)
        })
    })
    .await
}

fn backup_target(
    registry: &adapters::Registry,
    tool_id: &str,
    scope: Scope,
    home: &Path,
    project: Option<&Path>,
    role: &str,
) -> Result<std::path::PathBuf, ApiError> {
    let adapter = registry
        .get(tool_id)
        .ok_or_else(|| native_error("未注册的 CLI 适配器".into()))?;
    let file = adapter
        .native_files(scope, home, project, true)
        .into_iter()
        .find(|file| file.role == role && file.writable && !file.sensitive)
        .ok_or_else(|| native_error("当前角色不允许恢复".into()))?;
    Ok(std::path::PathBuf::from(file.path))
}

#[tauri::command]
pub async fn list_native_backups(
    app: AppHandle,
    tool_id: String,
    scope: Scope,
    project_path: Option<String>,
    role: String,
) -> Result<Vec<transaction::BackupRecord>, ApiError> {
    blocking(move || {
        let home = home()?;
        let project = checked_project(scope, project_path)?;
        let account_db = app.state::<AppState>().database(&app)?;
        let _context = crate::accounts::selection::enter_bound(
            &account_db,
            &home,
            &tool_id,
            scope,
            project.as_deref(),
        )
        .map_err(native_error)?;
        let path = backup_target(
            &adapters::Registry::builtins(),
            &tool_id,
            scope,
            &home,
            project.as_deref(),
            &role,
        )?;
        app.state::<AppState>().with_database(&app, |db| {
            transaction::recent_backups(db, &path).map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub async fn preview_native_backup(
    app: AppHandle,
    tool_id: String,
    scope: Scope,
    project_path: Option<String>,
    role: String,
    transaction_id: String,
) -> Result<transaction::BackupPreview, ApiError> {
    blocking(move || {
        let home = home()?;
        let project = checked_project(scope, project_path)?;
        let account_db = app.state::<AppState>().database(&app)?;
        let _context = crate::accounts::selection::enter_bound(
            &account_db,
            &home,
            &tool_id,
            scope,
            project.as_deref(),
        )
        .map_err(native_error)?;
        let path = backup_target(
            &adapters::Registry::builtins(),
            &tool_id,
            scope,
            &home,
            project.as_deref(),
            &role,
        )?;
        app.state::<AppState>().with_database(&app, |db| {
            transaction::preview_backup(db, &SystemCredentialStore, &path, &transaction_id)
                .map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn restore_native_backup(
    app: AppHandle,
    expected_context_id: Option<String>,
    tool_id: String,
    scope: Scope,
    project_path: Option<String>,
    role: String,
    transaction_id: String,
    current: String,
) -> Result<transaction::ApplyOutcome, ApiError> {
    blocking(move || {
        let home = home()?; let project = checked_project(scope, project_path)?;
        let account_db=app.state::<AppState>().database(&app)?;
        let _context=crate::accounts::selection::enter_bound(&account_db,&home,&tool_id,scope,project.as_deref()).map_err(native_error)?;
        let registry = adapters::Registry::builtins();
        let path = backup_target(&registry, &tool_id, scope, &home, project.as_deref(), &role)?;
        app.state::<AppState>().with_database(&app, |db| {
            let _context = crate::accounts::selection::enter_bound(db, &home, &tool_id, scope, project.as_deref()).map_err(native_error)?;
            crate::accounts::selection::validate_expected(&tool_id,expected_context_id.as_deref()).map_err(native_error)?;
            let custom = registered_tool_path(db, &tool_id).map_err(native_error)?;
            let probe = adapter::probe_registered(&registry, &tool_id, custom.as_deref(), &home, project.as_deref(), scope).map_err(native_error)?;
            if probe.native_writes.state != "supported" { return Err(native_error(probe.native_writes.reason.into())); }
            let scope_key = apply::scope_key(scope, project.as_deref()).map_err(native_error)?;
            transaction::restore_backup(db, &SystemCredentialStore, &path, &transaction_id, &current, |tx| {
                tx.execute("UPDATE applied_bindings SET managed='{}', profile_version=-1 WHERE tool=?1 AND scope_key=?2", rusqlite::params![tool_id, scope_key]).map(|_| ()).map_err(|e| e.to_string())
            }).map_err(native_error)
        })
    }).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn save_registered_native_file(
    app: AppHandle,
    expected_context_id: Option<String>,
    tool_id: String,
    scope: Scope,
    project_path: Option<String>,
    role: String,
    original: String,
    edited: String,
) -> Result<crate::native::transaction::ApplyOutcome, ApiError> {
    blocking(move || {
        let home = home()?;
        let project = checked_project(scope, project_path)?;
        app.state::<AppState>().with_database(&app, |db| {
            let registry = adapters::Registry::builtins();
            let _context = crate::accounts::selection::enter_bound(
                db,
                &home,
                &tool_id,
                scope,
                project.as_deref(),
            )
            .map_err(native_error)?;
            crate::accounts::selection::validate_expected(&tool_id, expected_context_id.as_deref())
                .map_err(native_error)?;
            let custom = registered_tool_path(db, &tool_id).map_err(native_error)?;
            let probe = adapter::probe_registered(
                &registry,
                &tool_id,
                custom.as_deref(),
                &home,
                project.as_deref(),
                scope,
            )
            .map_err(native_error)?;
            if probe.native_writes.state != "supported" {
                return Err(native_error(probe.native_writes.reason.into()));
            }
            let version = probe
                .installations
                .iter()
                .find(|item| Some(&item.path) == probe.selected_path.as_ref())
                .and_then(|item| item.version.as_deref())
                .ok_or_else(|| native_error("未确认 CLI 版本".into()))?;
            adapters::save_registered_text(
                &registry,
                &tool_id,
                &role,
                scope,
                &home,
                project.as_deref(),
                version,
                db,
                &SystemCredentialStore,
                &original,
                &edited,
            )
            .map_err(native_error)
        })
    })
    .await
}

#[tauri::command]
pub fn merge_registered_native_edits(
    tool_id: String,
    role: String,
    original: String,
    edited: String,
    current: String,
) -> Result<String, ApiError> {
    let registry = adapters::Registry::builtins();
    let adapter = registry
        .get(&tool_id)
        .ok_or_else(|| native_error("未注册的 CLI 适配器".into()))?;
    let kind = adapter.file_kind(&role).map_err(native_error)?;
    crate::native::format::merge_edits(kind, &original, &edited, &current).map_err(native_error)
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
        registered: registry
            .iter()
            .map(PublishedDescriptor::from_adapter)
            .collect(),
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

#[tauri::command]
pub fn set_language(
    app: AppHandle,
    state: State<'_, AppState>,
    language: String,
) -> Result<Bootstrap, ApiError> {
    if !matches!(language.as_str(), "zh" | "en") {
        return Err(storage_error("界面语言只支持中文或英文".into()));
    }
    state.with_database(&app, |database| {
        database
            .update_preferences(|preferences| preferences.language = Some(language))
            .map(Bootstrap::new)
            .map_err(storage_error)
    })
}

#[tauri::command]
pub fn set_remote_ssh_enabled(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<Bootstrap, ApiError> {
    let bootstrap = state.with_database(&app, |database| {
        database
            .update_preferences(|preferences| preferences.remote_ssh_enabled = enabled)
            .map(Bootstrap::new)
            .map_err(storage_error)
    })?;
    let _ = app.emit("cliora:remote-ssh-changed", enabled);
    Ok(bootstrap)
}

#[tauri::command]
pub fn list_remote_targets(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<crate::remote::RemoteTarget>, ApiError> {
    state.with_database(&app, |database| {
        crate::remote::list_targets(database).map_err(|error| native_error(error.to_string()))
    })
}

#[tauri::command]
pub fn save_remote_target(
    app: AppHandle,
    state: State<'_, AppState>,
    target: crate::remote::RemoteTarget,
    password: Option<String>,
) -> Result<crate::remote::RemoteTarget, ApiError> {
    let saved = state.with_database(&app, |database| {
        crate::remote::save_target(database, target)
            .map_err(|error| native_error(error.to_string()))
    })?;
    // The secret goes straight to the system credential store; SQLite keeps
    // only the target record.
    crate::remote::password::apply_save_request(&crate::credentials::SystemCredentialStore, &saved, password.as_deref())
        .map_err(|error| native_error(format!("主机已保存，但密码未能写入系统凭据：{error}")))?;
    Ok(saved)
}

/// Ids of targets that have a saved password. The secrets never cross IPC.
#[tauri::command]
pub fn list_remote_saved_passwords(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<String>, ApiError> {
    let targets = state.with_database(&app, |database| {
        crate::remote::list_targets(database).map_err(|error| native_error(error.to_string()))
    })?;
    Ok(targets
        .into_iter()
        .filter(|target| target.auth_method == "password" && crate::remote::password::is_saved(&crate::credentials::SystemCredentialStore, &target.id))
        .map(|target| target.id)
        .collect())
}

#[tauri::command]
pub fn delete_remote_target(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), ApiError> {
    state.with_database(&app, |database| {
        crate::remote::delete_target(database, &id).map_err(|error| native_error(error.to_string()))
    })?;
    let _ = crate::remote::password::forget(&crate::credentials::SystemCredentialStore, &id);
    Ok(())
}

#[tauri::command]
pub fn list_remote_projects(
    app: AppHandle,
    state: State<'_, AppState>,
    target_id: Option<String>,
) -> Result<Vec<crate::remote::RemoteProject>, ApiError> {
    state.with_database(&app, |database| {
        crate::remote::list_projects(database, target_id.as_deref())
            .map_err(|error| native_error(error.to_string()))
    })
}

#[tauri::command]
pub async fn list_remote_directories(
    app: AppHandle,
    state: State<'_, AppState>,
    target_id: String,
    parent: String,
) -> Result<Vec<String>, ApiError> {
    let _ = state;
    blocking(move || {
        let database = app.state::<AppState>().database(&app)?;
        crate::remote::ensure_enabled(&database).map_err(|error| native_error(error.to_string()))?;
        let target = crate::remote::list_targets(&database)
            .map_err(|error| native_error(error.to_string()))?
            .into_iter()
            .find(|item| item.id == target_id)
            .ok_or_else(|| native_error("远程目标不存在".into()))?;
        crate::remote::list_directories(&target, &parent)
            .map_err(|error| native_error(error.to_string()))
    }).await
}

#[tauri::command]
pub async fn create_remote_directory(
    app: AppHandle,
    state: State<'_, AppState>,
    target_id: String,
    path: String,
) -> Result<(), ApiError> {
    let _ = state;
    blocking(move || {
        let database = app.state::<AppState>().database(&app)?;
        crate::remote::ensure_enabled(&database).map_err(|error| native_error(error.to_string()))?;
        let target = crate::remote::list_targets(&database)
            .map_err(|error| native_error(error.to_string()))?
            .into_iter()
            .find(|item| item.id == target_id)
            .ok_or_else(|| native_error("远程目标不存在".into()))?;
        crate::remote::create_directory(&target, &path)
            .map_err(|error| native_error(error.to_string()))
    }).await
}

#[tauri::command]
pub fn save_remote_project(
    app: AppHandle,
    state: State<'_, AppState>,
    project: crate::remote::RemoteProject,
) -> Result<crate::remote::RemoteProject, ApiError> {
    state.with_database(&app, |database| {
        crate::remote::save_project(database, project)
            .map_err(|error| native_error(error.to_string()))
    })
}

#[tauri::command]
pub fn delete_remote_project(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), ApiError> {
    state.with_database(&app, |database| {
        crate::remote::delete_project(database, &id)
            .map_err(|error| native_error(error.to_string()))
    })
}

#[tauri::command]
pub async fn test_remote_target(
    app: AppHandle,
    target: crate::remote::RemoteTarget,
    password: Option<String>,
) -> Result<crate::remote::RemoteProbe, ApiError> {
    blocking(move || {
        let database = app.state::<AppState>().database(&app)?;
        crate::remote::ensure_enabled(&database)
            .map_err(|error| native_error(error.to_string()))?;
        let typed = password.filter(|value| !value.is_empty() && target.auth_method == "password");
        let Some(typed) = typed else {
            return crate::remote::probe_target(&target).map_err(|error| native_error(error.to_string()));
        };
        // Test a password that is not saved yet under a throwaway credential id,
        // then remove it, so "test before save" never persists the secret.
        let store = crate::credentials::SystemCredentialStore;
        let mut probe_target = target.clone();
        probe_target.id = uuid::Uuid::new_v4().to_string();
        crate::remote::password::save(&store, &probe_target.id, &typed)
            .map_err(|error| native_error(error.to_string()))?;
        let result = crate::remote::probe_target(&probe_target);
        let _ = crate::remote::password::forget(&store, &probe_target.id);
        result
            .map(|mut probe| { probe.target_id = target.id.clone(); probe })
            .map_err(|error| native_error(error.to_string()))
    })
    .await
}

/// Probe one registered CLI on the selected remote target. A missing remote
/// executable is a per-CLI result so the UI can keep rendering the rest of
/// the target instead of treating one missing tool as a connection failure.
#[tauri::command]
pub async fn probe_remote_cli(
    app: AppHandle,
    target_id: String,
    tool_id: String,
) -> Result<crate::remote::RemoteCliProbe, ApiError> {
    blocking(move || {
        let database = app.state::<AppState>().database(&app)?;
        crate::remote::ensure_enabled(&database).map_err(|error| native_error(error.to_string()))?;
        let target = crate::remote::list_targets(&database)
            .map_err(|error| native_error(error.to_string()))?
            .into_iter()
            .find(|item| item.id == target_id && item.enabled)
            .ok_or_else(|| native_error("远程目标不存在或已停用".into()))?;
        let adapter = crate::adapters::Registry::builtins()
            .get(&tool_id)
            .ok_or_else(|| native_error("未注册的 CLI 不能探测".into()))?;
        let executable = adapter.command().to_owned();
        match adapter.remote_probe(&target) {
            Ok(result) => Ok(crate::remote::RemoteCliProbe {
                target_id: target.id,
                tool_id,
                executable,
                installed: true,
                version: result.stdout.lines().map(str::trim).find(|line| !line.is_empty()).map(ToOwned::to_owned),
                detail: None,
            }),
            Err(detail) => Ok(crate::remote::RemoteCliProbe {
                target_id: target.id,
                tool_id,
                executable,
                installed: false,
                version: None,
                detail: Some(detail),
            }),
        }
    }).await
}

#[tauri::command]
pub async fn probe_remote_clis(
    app: AppHandle,
    target_id: String,
    tool_ids: Vec<String>,
) -> Result<Vec<crate::remote::RemoteCliProbe>, ApiError> {
    blocking(move || {
        let database = app.state::<AppState>().database(&app)?;
        crate::remote::ensure_enabled(&database).map_err(|error| native_error(error.to_string()))?;
        let target = crate::remote::list_targets(&database)
            .map_err(|error| native_error(error.to_string()))?
            .into_iter()
            .find(|item| item.id == target_id && item.enabled)
            .ok_or_else(|| native_error("远程目标不存在或已停用".into()))?;
        let registry = adapters::Registry::builtins();
        let tools = tool_ids.into_iter().filter_map(|tool_id| registry.get(&tool_id).map(|adapter| (tool_id, adapter.command().to_owned()))).collect::<Vec<_>>();
        crate::remote::probe_clis(&target, &tools).map_err(|error| native_error(error.to_string()))
    }).await
}

#[tauri::command]
pub async fn get_remote_tool_store(
    app: AppHandle,
    target_id: String,
    tool_id: String,
    scope: Option<String>,
    project_path: Option<String>,
) -> Result<crate::remote::RemoteToolStore, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            crate::remote::ensure_enabled(db).map_err(|error| native_error(error.to_string()))?;
            let target = crate::remote::list_targets(db)
                .map_err(|error| native_error(error.to_string()))?
                .into_iter()
                .find(|item| item.id == target_id && item.enabled)
                .ok_or_else(|| native_error("远程主机不可用".into()))?;
            let scope = scope.unwrap_or_else(|| "global".into());
            crate::remote::load_scoped_tool_store(&target, &tool_id, &scope, project_path.as_deref()).map_err(|error| native_error(error.to_string()))
        })
    }).await
}

#[tauri::command]
pub async fn save_remote_tool_store(
    app: AppHandle,
    target_id: String,
    tool_id: String,
    store: crate::remote::RemoteToolStore,
    scope: Option<String>,
    project_path: Option<String>,
) -> Result<(), ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            crate::remote::ensure_enabled(db).map_err(|error| native_error(error.to_string()))?;
            let target = crate::remote::list_targets(db)
                .map_err(|error| native_error(error.to_string()))?
                .into_iter()
                .find(|item| item.id == target_id && item.enabled)
                .ok_or_else(|| native_error("远程主机不可用".into()))?;
            let scope = scope.unwrap_or_else(|| "global".into());
            crate::remote::save_scoped_tool_store(&target, &tool_id, &store, &scope, project_path.as_deref()).map_err(|error| native_error(error.to_string()))
        })
    }).await
}

#[tauri::command]
pub async fn delete_remote_tool_profile(
    app: AppHandle,
    target_id: String,
    tool_id: String,
    profile_id: String,
) -> Result<(), ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            crate::remote::ensure_enabled(db).map_err(|error| native_error(error.to_string()))?;
            let target = crate::remote::list_targets(db)
                .map_err(|error| native_error(error.to_string()))?
                .into_iter()
                .find(|item| item.id == target_id && item.enabled)
                .ok_or_else(|| native_error("远程主机不可用".into()))?;
            crate::remote::delete_tool_profile(&target, &tool_id, &profile_id).map_err(|error| native_error(error.to_string()))
        })
    }).await
}

#[tauri::command]
pub async fn get_remote_resource_store(
    app: AppHandle,
    target_id: String,
    tool_id: String,
    kind: String,
) -> Result<serde_json::Value, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            crate::remote::ensure_enabled(db).map_err(|error| native_error(error.to_string()))?;
            let target = crate::remote::list_targets(db)
                .map_err(|error| native_error(error.to_string()))?
                .into_iter()
                .find(|item| item.id == target_id && item.enabled)
                .ok_or_else(|| native_error("远程主机不可用".into()))?;
            crate::remote::load_resource_store(&target, &tool_id, &kind)
                .map_err(|error| native_error(error.to_string()))
        })
    }).await
}

#[tauri::command]
pub async fn list_remote_resource_stores(
    app: AppHandle,
    target_id: String,
    tool_ids: Vec<String>,
    kind: String,
) -> Result<serde_json::Value, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            crate::remote::ensure_enabled(db).map_err(|error| native_error(error.to_string()))?;
            let target = crate::remote::list_targets(db)
                .map_err(|error| native_error(error.to_string()))?
                .into_iter()
                .find(|item| item.id == target_id && item.enabled)
                .ok_or_else(|| native_error("远程主机不可用".into()))?;
            crate::remote::load_resource_stores(&target, &tool_ids, &kind)
                .map_err(|error| native_error(error.to_string()))
        })
    }).await
}

#[tauri::command]
pub async fn save_remote_resource_store(
    app: AppHandle,
    target_id: String,
    tool_id: String,
    kind: String,
    value: serde_json::Value,
) -> Result<(), ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            crate::remote::ensure_enabled(db).map_err(|error| native_error(error.to_string()))?;
            let target = crate::remote::list_targets(db)
                .map_err(|error| native_error(error.to_string()))?
                .into_iter()
                .find(|item| item.id == target_id && item.enabled)
                .ok_or_else(|| native_error("远程主机不可用".into()))?;
            crate::remote::save_resource_store(&target, &tool_id, &kind, &value)
                .map_err(|error| native_error(error.to_string()))
        })
    }).await
}

#[tauri::command]
pub async fn import_remote_skill_directory(
    app: AppHandle,
    target_id: String,
    tool_id: String,
    source: String,
) -> Result<(), ApiError> {
    blocking(move || {
        let database = app.state::<AppState>().database(&app)?;
        crate::remote::ensure_enabled(&database).map_err(|error| native_error(error.to_string()))?;
        let target = crate::remote::list_targets(&database).map_err(|error| native_error(error.to_string()))?.into_iter().find(|item| item.id == target_id && item.enabled).ok_or_else(|| native_error("远程主机不可用".into()))?;
        crate::remote::import_skill_directory(&target, &tool_id, &source).map_err(|error| native_error(error.to_string()))
    }).await
}

#[tauri::command]
pub fn set_tool_icon(
    app: AppHandle,
    state: State<'_, AppState>,
    tool_id: String,
    data_url: Option<String>,
) -> Result<Bootstrap, ApiError> {
    let candidate = data_url
        .clone()
        .map(|data| std::collections::BTreeMap::from([(tool_id.clone(), data)]))
        .unwrap_or_default();
    if !crate::domain::valid_icon_id(&tool_id) || !crate::domain::valid_tool_icons(&candidate) {
        return Err(storage_error(
            "请选择不超过 128 KB 的 PNG、JPEG 或 WebP 图标".into(),
        ));
    }
    state.with_database(&app, |database| {
        let current = database.preferences().map_err(storage_error)?;
        if data_url.is_some()
            && !current.tool_icons.contains_key(&tool_id)
            && current.tool_icons.len() >= 100
        {
            return Err(storage_error("最多保存 100 个工具图标".into()));
        }
        database
            .update_preferences(|preferences| {
                if let Some(data) = data_url {
                    preferences.tool_icons.insert(tool_id, data);
                } else {
                    preferences.tool_icons.remove(&tool_id);
                }
            })
            .map(Bootstrap::new)
            .map_err(storage_error)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configuration_snapshot_checks_presence_without_decoding_content() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config.json");
        let mut file = adapter::NativeFile {
            role: "settings",
            path: path.display().to_string(),
            format: "json",
            writable: true,
            reason: None,
            sensitive: false,
        };
        assert!(native_snapshot(&file).fingerprint.is_none());
        std::fs::write(&path, [0xff, 0xfe]).unwrap();
        let present = native_snapshot(&file);
        assert_eq!(present.fingerprint.as_deref(), Some("present"));
        assert!(present.text.is_none());
        // Decoding failures still surface when opening the editor.
        assert!(transaction::read_native(&path).is_err());
        file.sensitive = true;
        assert!(native_snapshot(&file).fingerprint.is_none());
        file.sensitive = false;
        file.path = temp.path().display().to_string();
        let directory = native_snapshot(&file);
        assert!(directory.fingerprint.is_none());
        assert!(directory.error.unwrap().contains("无法读取"));
    }

    #[test]
    #[ignore = "synthetic performance measurement; writes only a temporary config"]
    fn performance_configuration_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config.json");
        std::fs::write(&path, " ".repeat(16 * 1024 * 1024)).unwrap();
        let file = adapter::NativeFile {
            role: "settings",
            path: path.display().to_string(),
            format: "json",
            writable: true,
            reason: None,
            sensitive: false,
        };
        for pass in 0..3 {
            let start = std::time::Instant::now();
            for _ in 0..40 {
                let snapshot = native_snapshot(&file);
                assert_eq!(snapshot.fingerprint.as_deref(), Some("present"));
                assert!(snapshot.text.is_none());
            }
            eprintln!(
                "BENCH config pass={pass} bytes=16777216 reads=40 elapsed_ms={:.2}",
                start.elapsed().as_secs_f64() * 1000.0
            );
        }
    }

    #[test]
    fn unknown_profiles_are_explicitly_readable_but_never_writable_as_known_tool() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("unknown.db")).unwrap();
        let original = r#"{"id":"future-1","tool":"future_cli","name":"保留方案","version":1,"inheritCommon":false,"files":{"settings":"custom = true"}}"#;
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
                editing: None,
                revision: String::new(),
                id: "future-1".into(),
                tool: "future_cli".into(),
                name: "write denied".into(),
                version: 1,
                inherit_common: false,
                files: std::collections::BTreeMap::new(),
                suppressed: std::collections::BTreeMap::new(),
                connection: None,
                authentication: crate::native::profile::ProfileAuthentication::Native,
                native_credentials: std::collections::BTreeMap::new()
            },
            Some(1)
        )
        .is_err());
        let delete_error = profile::delete_profile(&db, "future-1", 1, "").unwrap_err();
        assert!(
            delete_error.contains("未注册的 CLI 适配器"),
            "{delete_error}"
        );
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
    fn native_error_assigns_stable_codes_only_to_the_two_recognized_literals() {
        const ACTION: &str = "检查工具版本、原生文件和作用范围后重试；原配置不会自动清空。";
        // apply.rs fills a variable role/pointer between the fixed template parts.
        let takeover = native_error("原生文件已有不同的字段值：settings$.model；请确认接管".into());
        assert_eq!(takeover.code, "native_takeover_required");
        assert_eq!(
            takeover.message,
            "原生文件已有不同的字段值：settings$.model；请确认接管"
        );
        assert_eq!(takeover.action, ACTION);
        assert_eq!(takeover.data_directory, None);
        // launch.rs rejects oversized CMD launch lines with the exact literal.
        let too_long = native_error(
            "启动命令超过 CMD 长度限制，请在设置中选择 PowerShell 或 Windows Terminal".into(),
        );
        assert_eq!(too_long.code, "terminal_command_too_long");
        assert_eq!(
            too_long.message,
            "启动命令超过 CMD 长度限制，请在设置中选择 PowerShell 或 Windows Terminal"
        );
        assert_eq!(too_long.action, ACTION);
        // Near misses and unrelated messages keep the generic code and action.
        for message in [
            "原生文件已有不同的字段值：settings$.model；请确认接管 ",
            "原生文件已有不同的字段值：settings$.model，请确认接管",
            "上次管理的字段已被外部修改：settings$.model",
            "扫描已在后台进行",
        ] {
            let error = native_error(message.into());
            assert_eq!(error.code, "native_error", "{message}");
            assert_eq!(error.action, ACTION, "{message}");
        }
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

#[tauri::command]
pub async fn open_external_url(app: AppHandle, url: String) -> Result<(), ApiError> {
    blocking(move || crate::external::open(&app, &url).map_err(native_error)).await
}

#[tauri::command]
pub async fn open_workbench_path(app: AppHandle, session_id: String, path: String) -> Result<(), ApiError> {
    blocking(move || crate::terminal_paths::open(&app, &session_id, &home()?, &path).map_err(native_error)).await
}

#[tauri::command]
pub fn describe_configuration(
    tool_id: String,
    scope: Scope,
) -> Result<Option<adapters::configuration::ConfigurationDescriptor>, ApiError> {
    crate::native::configuration::describe(&adapters::Registry::builtins(), &tool_id, scope)
        .map_err(native_error)
}
#[tauri::command]
pub fn open_configuration_draft(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: RegisteredProfile,
    scope: Scope,
    session_id: String,
) -> Result<crate::native::configuration::ConfigurationDraft, ApiError> {
    state.with_database(&app, |database| {
        let common =
            profile::get_registered_common(database, &profile.tool).map_err(native_error)?;
        crate::native::configuration::open_with_common(
            &adapters::Registry::builtins(),
            profile,
            common,
            scope,
            session_id,
        )
        .map_err(native_error)
    })
}
#[tauri::command]
pub fn edit_configuration_draft(
    app: AppHandle,
    draft: crate::native::configuration::ConfigurationDraft,
    action: adapters::configuration::ConfigurationAction,
) -> Result<crate::native::configuration::ConfigurationDraft, ApiError> {
    if draft.subject.is_some() {
        app.state::<AppState>()
            .workspace
            .edit(&adapters::Registry::builtins(), draft, action)
            .map_err(native_error)
    } else {
        crate::native::configuration::edit(&adapters::Registry::builtins(), draft, action)
            .map_err(native_error)
    }
}
#[tauri::command]
pub fn replace_configuration_text(
    app: AppHandle,
    draft: crate::native::configuration::ConfigurationDraft,
    files: std::collections::BTreeMap<String, String>,
) -> Result<crate::native::configuration::ConfigurationDraft, ApiError> {
    if draft.subject.is_some() {
        app.state::<AppState>()
            .workspace
            .raw(&adapters::Registry::builtins(), draft, files)
            .map_err(native_error)
    } else {
        Ok(crate::native::configuration::replace_text(
            &adapters::Registry::builtins(),
            draft,
            files,
        ))
    }
}

#[tauri::command]
pub async fn begin_configuration_draft(
    app: AppHandle,
    mut request: crate::native::workspace::ConfigurationBeginRequest,
) -> Result<crate::native::configuration::ConfigurationDraft, ApiError> {
    blocking(move || {
        let home = home()?;
        let project = checked_project(request.scope, request.project_path.clone())?;
        app.state::<AppState>().with_database(&app, |db| {
            let registry = adapters::Registry::builtins();
            if let Some(target_id) = request.remote_target_id.clone() {
                crate::remote::ensure_enabled(db).map_err(|error| native_error(error.to_string()))?;
                let target = crate::remote::list_targets(db)
                    .map_err(|error| native_error(error.to_string()))?
                    .into_iter()
                    .find(|item| item.id == target_id && item.enabled)
                    .ok_or_else(|| native_error("远程主机不可用".into()))?;
                let store = crate::remote::load_tool_store(&target, &request.tool_id)
                    .map_err(|error| native_error(error.to_string()))?;
                request.remote_files = if request.subject == crate::adapters::configuration::ConfigurationSubject::Current && request.scope == Scope::Project {
                    let project = request.project_path.clone().filter(|path| !path.trim().is_empty()).ok_or_else(|| native_error("请选择项目目录".into()))?;
                    crate::remote::read_scope_native(&target, &request.tool_id, "project", Some(&project)).map_err(|error| native_error(error.to_string()))?
                } else {
                    store.current_files
                };
                request.remote_common = store.common;
                return app.state::<AppState>().workspace.begin(
                    &registry,
                    db,
                    request,
                    None,
                    Vec::new(),
                    None,
                ).map_err(native_error);
            }
            app.state::<AppState>()
                .workspace
                .begin_registered(&registry, db, request, &home, project.as_deref())
                .map_err(native_error)
        })
    })
    .await
}
#[tauri::command]
pub fn update_configuration_draft(
    app: AppHandle,
    draft: crate::native::configuration::ConfigurationDraft,
    profile: RegisteredProfile,
) -> Result<crate::native::configuration::ConfigurationDraft, ApiError> {
    app.state::<AppState>()
        .workspace
        .update(&adapters::Registry::builtins(), draft, profile)
        .map_err(native_error)
}
#[tauri::command]
pub fn select_configuration_credential(
    app: AppHandle,
    draft: crate::native::configuration::ConfigurationDraft,
    credential: crate::native::workspace::ConfigurationCredential,
) -> Result<crate::native::configuration::ConfigurationDraft, ApiError> {
    app.state::<AppState>().with_database(&app, |db| {
        app.state::<AppState>()
            .workspace
            .select_credential(&adapters::Registry::builtins(), db, draft, credential)
            .map_err(native_error)
    })
}
#[tauri::command]
pub fn set_configuration_draft_secret(
    app: AppHandle,
    draft: crate::native::configuration::ConfigurationDraft,
    secret: String,
) -> Result<crate::native::configuration::ConfigurationDraft, ApiError> {
    app.state::<AppState>()
        .workspace
        .set_secret(&adapters::Registry::builtins(), draft, secret)
        .map_err(native_error)
}
#[tauri::command]
pub fn remove_configuration_draft_secret(
    app: AppHandle,
    draft: crate::native::configuration::ConfigurationDraft,
) -> Result<crate::native::configuration::ConfigurationDraft, ApiError> {
    app.state::<AppState>()
        .workspace
        .remove_secret(&adapters::Registry::builtins(), draft)
        .map_err(native_error)
}
#[tauri::command]
pub fn reveal_configuration_draft_secret(
    app: AppHandle,
    draft: crate::native::configuration::ConfigurationDraft,
) -> Result<String, ApiError> {
    app.state::<AppState>()
        .workspace
        .reveal_secret(&draft, &SystemCredentialStore)
        .map_err(native_error)
}
#[tauri::command]
pub fn cancel_configuration_draft(app: AppHandle, session_id: String) -> Result<(), ApiError> {
    app.state::<AppState>()
        .workspace
        .cancel(&session_id)
        .map_err(native_error)
}
#[tauri::command]
pub fn cancel_configuration_requests(
    app: AppHandle,
    draft: crate::native::configuration::ConfigurationDraft,
) -> Result<crate::native::configuration::ConfigurationDraft, ApiError> {
    app.state::<AppState>()
        .workspace
        .cancel_requests(draft)
        .map_err(native_error)
}
#[tauri::command]
pub fn add_configuration_models(
    app: AppHandle,
    draft: crate::native::configuration::ConfigurationDraft,
    ids: Vec<String>,
) -> Result<crate::native::configuration::ConfigurationDraft, ApiError> {
    app.state::<AppState>()
        .workspace
        .add_models(&adapters::Registry::builtins(), draft, ids)
        .map_err(native_error)
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationDirectoryResult {
    session_id: String,
    revision: u64,
    request_generation: u64,
    directory: models::ModelDirectory,
}
#[tauri::command]
pub async fn list_configuration_models(
    app: AppHandle,
    draft: crate::native::configuration::ConfigurationDraft,
    force: bool,
    query: String,
) -> Result<ConfigurationDirectoryResult, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            let workspace = &app.state::<AppState>().workspace;
            // Remote and local drafts both ask the provider written in the draft.
            // The secret is the draft lease or the saved connection secret.
            let directory = workspace
                .provider_directory(db, &draft, &SystemCredentialStore, force, &query)
                .map_err(native_error)?;
            workspace.finish_request(&draft).map_err(native_error)?;
            Ok(ConfigurationDirectoryResult {
                session_id: draft.session_id,
                revision: draft.revision,
                request_generation: draft.request_generation,
                directory,
            })
        })
    })
    .await
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationCheckResult {
    session_id: String,
    revision: u64,
    request_generation: u64,
    check: models::ConnectionCheck,
}
#[tauri::command]
pub async fn check_configuration_connection(
    app: AppHandle,
    draft: crate::native::configuration::ConfigurationDraft,
    allow_model_request: bool,
) -> Result<ConfigurationCheckResult, ApiError> {
    blocking(move || {
        if let Some(target_id) = draft.remote_target_id.clone() {
            return app.state::<AppState>().with_database(&app, |db| {
                crate::remote::ensure_enabled(db).map_err(|error| native_error(error.to_string()))?;
                let target = crate::remote::list_targets(db).map_err(|error| native_error(error.to_string()))?.into_iter().find(|item| item.id == target_id && item.enabled).ok_or_else(|| native_error("远程主机不可用".into()))?;
                let check = match crate::remote::probe_target(&target) {
                    Ok(_) => models::ConnectionCheck { format: models::CheckStep { state: "passed", message: "远程 CLI 配置格式由所选主机维护".into() }, connectivity: models::CheckStep { state: "passed", message: "SSH 已连接到所选远程主机".into() }, model_request: models::CheckStep { state: "skipped", message: if allow_model_request { "模型请求需由远端 CLI 会话执行，未在本机发起".into() } else { "未发送模型请求".into() } } },
                    Err(error) => models::ConnectionCheck { format: models::CheckStep { state: "passed", message: "远程 CLI 配置格式由所选主机维护".into() }, connectivity: models::CheckStep { state: "failed", message: error.to_string() }, model_request: models::CheckStep { state: "skipped", message: "连接检查未通过".into() } },
                };
                Ok(ConfigurationCheckResult { session_id: draft.session_id, revision: draft.revision, request_generation: draft.request_generation, check })
            });
        }
        let workspace = &app.state::<AppState>().workspace;
        let (mut connection, credential) = workspace
            .request(&draft, &SystemCredentialStore)
            .map_err(native_error)?;
        if allow_model_request {
            let actual = draft
                .profile
                .connection
                .as_ref()
                .filter(|actual| {
                    actual.provider_id == connection.provider_id
                        && actual.base_url == connection.base_url
                        && actual.interface_format == connection.interface_format
                        && !actual.model.trim().is_empty()
                })
                .ok_or_else(|| native_error("请明确设置此连接的默认模型后再确认模型请求".into()))?;
            connection.model = actual.model.clone();
        }
        let check = models::test_registered_connection_guarded(
            &adapters::Registry::builtins(),
            &draft.profile.tool,
            &connection,
            &credential,
            allow_model_request,
            || !workspace.is_current(&draft),
        );
        workspace.finish_request(&draft).map_err(native_error)?;
        Ok(ConfigurationCheckResult {
            session_id: draft.session_id,
            revision: draft.revision,
            request_generation: draft.request_generation,
            check,
        })
    })
    .await
}
#[tauri::command]
pub async fn save_configuration_draft(
    app: AppHandle,
    draft: crate::native::configuration::ConfigurationDraft,
) -> Result<crate::native::workspace::ConfigurationSaveResult, ApiError> {
    if let Some(target_id) = draft.remote_target_id.clone() {
        let tool_id = draft.profile.tool.clone();
        return blocking(move || {
            app.state::<AppState>().with_database(&app, |db| {
                crate::remote::ensure_enabled(db).map_err(|error| native_error(error.to_string()))?;
                let target = crate::remote::list_targets(db)
                    .map_err(|error| native_error(error.to_string()))?
                    .into_iter()
                    .find(|item| item.id == target_id && item.enabled)
                    .ok_or_else(|| native_error("远程主机不可用".into()))?;
                let mut store = crate::remote::load_tool_store(&target, &tool_id)
                    .map_err(|error| native_error(error.to_string()))?;
                let mut next = draft.clone();
                let registry = adapters::Registry::builtins();
                // The key typed into this draft is written into the remote file
                // by the same adapter writer a local save uses. The CLI reads
                // that file directly. A missing lease must not be saved as a
                // config that looks connected and then returns 401.
                let entered = match app.state::<AppState>().workspace.draft_secret(&draft) {
                    Ok(value) => value,
                    Err(error) => return Err(native_error(error)),
                };
                if entered.is_none()
                    && matches!(
                        draft.credential,
                        Some(crate::native::workspace::ConfigurationCredential::ApiKey {
                            secret_ref: Some(_),
                            remove: false
                        })
                    )
                {
                    return Err(native_error("远程 API 密钥已失效，请重新输入".into()));
                }
                let mut staged_secrets: Option<crate::native::apply::NativeSecrets> = None;
                if let Some(secret) = entered {
                    let secret_ref = match draft.credential.as_ref() {
                        Some(crate::native::workspace::ConfigurationCredential::ApiKey {
                            secret_ref: Some(id),
                            remove: false,
                        }) => id.clone(),
                        _ => return Err(native_error("远程 API 密钥已失效，请重新输入".into())),
                    };
                    let secrets = crate::native::workspace::remote_connection_secrets(
                        &registry,
                        &draft.profile,
                        draft.scope,
                        draft.draft_connection.as_ref(),
                        &secret_ref,
                        &secret,
                    )
                    .map_err(native_error)?;
                    let adapter = registry.get(&tool_id).ok_or_else(|| native_error("适配器未注册".into()))?;
                    for (role, text) in &mut next.profile.files {
                        let kind = adapter.file_kind(role).map_err(native_error)?;
                        *text = secrets.apply_text(role, kind, std::mem::take(text)).map_err(native_error)?;
                    }
                    if let Some(connection) = next.profile.connection.as_mut() {
                        connection.secret_ref = None;
                        connection.auth_env_var = None;
                    }
                    staged_secrets = Some(secrets);
                }
                match draft.subject.unwrap_or(crate::adapters::configuration::ConfigurationSubject::Profile) {
                    crate::adapters::configuration::ConfigurationSubject::Current => {
                        let mut files = app.state::<AppState>().workspace.remote_current_contents(&registry, &draft, &draft.profile.files).map_err(native_error)?;
                        if let (Some(secrets), Some(adapter)) = (&staged_secrets, registry.get(&tool_id)) {
                            for (role, text) in files.iter_mut() {
                                let kind = adapter.file_kind(role).map_err(native_error)?;
                                *text = secrets.apply_text(role, kind, std::mem::take(text)).map_err(native_error)?;
                            }
                        }
                        if draft.scope == Scope::Project {
                            let project = draft.project_path.clone().filter(|path| !path.trim().is_empty()).ok_or_else(|| native_error("请选择项目目录".into()))?;
                            crate::remote::write_scope_native(&target, &tool_id, "project", Some(&project), &files).map_err(|error| native_error(error.to_string()))?;
                        } else {
                            store.current_files = files;
                            crate::remote::save_tool_store(&target, &tool_id, &store).map_err(|error| native_error(error.to_string()))?;
                        }
                        next.revision = next.revision.saturating_add(1);
                        return Ok(crate::native::workspace::ConfigurationSaveResult { draft: next, profile: None, common: None, application: None });
                    }
                    crate::adapters::configuration::ConfigurationSubject::Common => {
                        let common = crate::native::profile::RegisteredCommon { tool: tool_id.clone(), version: next.profile.version, revision: next.profile.revision.clone(), files: next.profile.files.clone() };
                        store.common = Some(common.clone());
                        store.current_files = next.profile.files.clone();
                        crate::remote::save_tool_store(&target, &tool_id, &store).map_err(|error| native_error(error.to_string()))?;
                        next.revision = next.revision.saturating_add(1);
                        return Ok(crate::native::workspace::ConfigurationSaveResult { draft: next, profile: None, common: Some(common), application: None });
                    }
                    _ => {
                        let mut profile = next.profile.clone();
                        if staged_secrets.is_none() {
                            if !profile.id.is_empty() {
                                if let Some(previous) = store.profiles.iter().find(|item| item.id == profile.id) {
                                    profile.files = crate::native::workspace::preserve_withheld_credentials(&registry, &tool_id, &profile.files, &previous.files).map_err(native_error)?;
                                }
                            }
                            if !store.current_files.is_empty() {
                                profile.files = crate::native::workspace::preserve_withheld_credentials(&registry, &tool_id, &profile.files, &store.current_files).map_err(native_error)?;
                            }
                        }
                        if profile.id.is_empty() { profile.id = format!("remote-{}", uuid::Uuid::new_v4()); }
                        // The value is in the native file. Never persist the
                        // local draft lease ID in the remote metadata store.
                        // Saving a named profile keeps the file in use. Choosing
                        // the profile, or saving the current files, writes it.
                        if let Some(connection) = profile.connection.as_mut() {
                            connection.secret_ref = None;
                        }
                        profile.version = profile.version.saturating_add(1);
                        profile.revision = uuid::Uuid::new_v4().to_string();
                        store.profiles.retain(|item| item.id != profile.id);
                        store.profiles.push(profile.clone());
                        crate::remote::save_tool_store(&target, &tool_id, &store).map_err(|error| native_error(error.to_string()))?;
                        next.revision = next.revision.saturating_add(1);
                        return Ok(crate::native::workspace::ConfigurationSaveResult { draft: next, profile: Some(profile), common: None, application: None });
                    }
                };
            })
        }).await;
    }
    let notify = app.clone();
    let tool = draft.profile.tool.clone();
    let result = blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            let registry = adapters::Registry::builtins();
            if draft.subject == Some(adapters::configuration::ConfigurationSubject::Current) {
                let home = home()?;
                let project = checked_project(draft.scope, draft.project_path.clone())?;
                let _context = crate::accounts::selection::enter_bound(
                    db,
                    &home,
                    &draft.profile.tool,
                    draft.scope,
                    project.as_deref(),
                )
                .map_err(native_error)?;
                crate::accounts::selection::validate_expected(
                    &draft.profile.tool,
                    draft.context_id.as_deref(),
                )
                .map_err(native_error)?;
                let custom = registered_tool_path(db, &draft.profile.tool).map_err(native_error)?;
                let probe = adapter::probe_registered(
                    &registry,
                    &draft.profile.tool,
                    custom.as_deref(),
                    &home,
                    project.as_deref(),
                    draft.scope,
                )
                .map_err(native_error)?;
                if probe.native_writes.state != "supported" {
                    return Err(native_error(probe.native_writes.reason.into()));
                }
                app.state::<AppState>()
                    .workspace
                    .save_current(
                        &registry,
                        db,
                        &SystemCredentialStore,
                        draft,
                        &probe.native_files,
                    )
                    .map_err(native_error)
            } else {
                app.state::<AppState>()
                    .workspace
                    .save_database(&registry, db, &SystemCredentialStore, draft)
                    .map_err(native_error)
            }
        })
    })
    .await?;
    let _ = notify.emit("cliora:bindings-changed", tool);
    Ok(result)
}
#[tauri::command]
pub fn common_influence(
    app: AppHandle,
    tool_id: String,
) -> Result<crate::native::workspace::CommonInfluence, ApiError> {
    app.state::<AppState>().with_database(&app, |db| {
        crate::native::workspace::common_influence(db, &tool_id).map_err(native_error)
    })
}
#[tauri::command]
pub async fn apply_common_configuration(
    app: AppHandle,
    common: RegisteredCommon,
    targets: Vec<crate::native::workspace::CommonInfluenceTarget>,
) -> Result<Vec<crate::native::workspace::CommonApplicationResult>, ApiError> {
    let notify = app.clone();
    let tool = common.tool.clone();
    let result = blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            crate::native::workspace::apply_common(
                &adapters::Registry::builtins(),
                db,
                &common,
                &targets,
                |target, profile, binding| {
                    let registry = adapters::Registry::builtins();
                    let home = home().map_err(|error| error.message)?;
                    let project = checked_project(target.scope, target.project_path.clone())
                        .map_err(|error| error.message)?;
                    crate::accounts::validate_reapply_profile(
                        db,
                        profile,
                        target.scope,
                        project.as_deref(),
                    )?;
                    let _context = crate::accounts::selection::enter(
                        crate::accounts::selection::for_profile(db, &home, profile)?,
                    );
                    crate::accounts::selection::validate_expected(
                        &common.tool,
                        target.context_id.as_deref(),
                    )?;
                    let custom = registered_tool_path(db, &common.tool)?;
                    let probe = adapter::probe_registered(
                        &registry,
                        &common.tool,
                        custom.as_deref(),
                        &home,
                        project.as_deref(),
                        target.scope,
                    )?;
                    if probe.native_writes.state != "supported" {
                        return Err(probe.native_writes.reason.into());
                    }
                    apply::apply_registered_validated_expected(
                        &registry,
                        db,
                        &SystemCredentialStore,
                        profile,
                        Some(&common),
                        &probe.native_files,
                        &apply::scope_key(target.scope, project.as_deref())?,
                        target.scope,
                        binding,
                    )
                },
            )
            .map_err(native_error)
        })
    })
    .await?;
    let _ = notify.emit("cliora:bindings-changed", tool);
    Ok(result)
}

#[tauri::command]
pub async fn compare_configuration_current(
    app: AppHandle,
    draft: crate::native::configuration::ConfigurationDraft,
) -> Result<crate::native::workspace::ConfigurationCurrentComparison, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            let home = home()?;
            let project = checked_project(draft.scope, draft.project_path.clone())?;
            let _context = crate::accounts::selection::enter_bound(
                db,
                &home,
                &draft.profile.tool,
                draft.scope,
                project.as_deref(),
            )
            .map_err(native_error)?;
            app.state::<AppState>()
                .workspace
                .compare_current(&adapters::Registry::builtins(), draft)
                .map_err(native_error)
        })
    })
    .await
}
#[tauri::command]
pub async fn rebase_configuration_current(
    app: AppHandle,
    draft: crate::native::configuration::ConfigurationDraft,
    comparison_id: String,
    files: std::collections::BTreeMap<String, String>,
) -> Result<crate::native::configuration::ConfigurationDraft, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            let home = home()?;
            let project = checked_project(draft.scope, draft.project_path.clone())?;
            let _context = crate::accounts::selection::enter_bound(
                db,
                &home,
                &draft.profile.tool,
                draft.scope,
                project.as_deref(),
            )
            .map_err(native_error)?;
            app.state::<AppState>()
                .workspace
                .rebase_current(&adapters::Registry::builtins(), draft, comparison_id, files)
                .map_err(native_error)
        })
    })
    .await
}
#[tauri::command]
pub async fn preview_configuration_backup(
    app: AppHandle,
    draft: crate::native::configuration::ConfigurationDraft,
    role: String,
    transaction_id: String,
) -> Result<crate::native::workspace::ConfigurationBackupPreview, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            let home = home()?;
            let project = checked_project(draft.scope, draft.project_path.clone())?;
            let _context = crate::accounts::selection::enter_bound(
                db,
                &home,
                &draft.profile.tool,
                draft.scope,
                project.as_deref(),
            )
            .map_err(native_error)?;
            app.state::<AppState>()
                .workspace
                .preview_backup(
                    &adapters::Registry::builtins(),
                    db,
                    &SystemCredentialStore,
                    draft,
                    role,
                    transaction_id,
                )
                .map_err(native_error)
        })
    })
    .await
}
#[tauri::command]
pub async fn restore_configuration_backup(
    app: AppHandle,
    draft: crate::native::configuration::ConfigurationDraft,
    role: String,
    transaction_id: String,
) -> Result<crate::native::workspace::ConfigurationSaveResult, ApiError> {
    let notify = app.clone();
    let tool = draft.profile.tool.clone();
    let result = blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            let home = home()?;
            let project = checked_project(draft.scope, draft.project_path.clone())?;
            let _context = crate::accounts::selection::enter_bound(
                db,
                &home,
                &draft.profile.tool,
                draft.scope,
                project.as_deref(),
            )
            .map_err(native_error)?;
            app.state::<AppState>()
                .workspace
                .restore_backup(
                    &adapters::Registry::builtins(),
                    db,
                    &SystemCredentialStore,
                    draft,
                    role,
                    transaction_id,
                )
                .map_err(native_error)
        })
    })
    .await?;
    let _ = notify.emit("cliora:bindings-changed", tool);
    Ok(result)
}
