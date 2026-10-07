use crate::adapters::{self, AdapterCatalog, UnknownAdapterRecord};
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
use crate::{history, launch, library, portable, projects, resources};
use crate::resources::rules;

#[tauri::command]
pub async fn scan_native_agents(app: AppHandle, target: resources::plugins::PluginTarget) -> Result<resources::agents::AgentSnapshot, ApiError> {
    blocking(move || { let db = app.state::<AppState>().database(&app)?; resources::agents::scan(&db, &home()?, &target).map_err(native_error) }).await
}
#[tauri::command]
pub async fn operate_native_agent(app: AppHandle, request: resources::agents::AgentRequest) -> Result<resources::agents::AgentResult, ApiError> {
    blocking(move || { let db = app.state::<AppState>().database(&app)?; resources::agents::operate(&db, &SystemCredentialStore, &home()?, &request).map_err(native_error) }).await
}

#[tauri::command]
pub async fn scan_native_plugins(app: AppHandle, target: resources::plugins::PluginTarget) -> Result<resources::plugins::PluginSnapshot, ApiError> {
    blocking(move || { let db = app.state::<AppState>().database(&app)?; resources::plugins::scan(&db, &home()?, &target).map_err(native_error) }).await
}

#[tauri::command]
pub async fn preview_native_plugins(app: AppHandle, target: resources::plugins::PluginTarget) -> Result<Option<resources::plugins::PluginSnapshot>, ApiError> {
    blocking(move || { let db = app.state::<AppState>().database(&app)?; resources::plugins::preview(&db, &home()?, &target).map_err(native_error) }).await
}

#[tauri::command]
pub async fn operate_native_plugin(app: AppHandle, request: resources::plugins::PluginRequest) -> Result<resources::plugins::PluginResult, ApiError> {
    blocking(move || { let db = app.state::<AppState>().database(&app)?; resources::plugins::operate(&db, &SystemCredentialStore, &home()?, &request).map_err(native_error) }).await
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
    let db = app.state::<AppState>().database(&app).map_err(|_| UsageError::storage())?;
    tauri::async_runtime::spawn_blocking(move || operation(&db)).await
        .map_err(|_| UsageError::new(UsageErrorCode::Storage, UsageStage::Storage, "额度查询后台操作中断"))?
}

#[tauri::command]
pub fn account_capabilities() -> Vec<crate::accounts::AccountCapability> { adapters::accounts::capabilities() }

#[tauri::command]
pub async fn discover_native_logins(app: AppHandle, tool_id: String) -> Result<crate::accounts::NativeLoginSnapshot, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    let home = home()?;
    blocking(move || crate::accounts::discovery::discover(&db, &home, &tool_id).map_err(native_error)).await
}

#[tauri::command]
pub async fn adopt_native_account(app: AppHandle, tool_id: String, label: String) -> Result<crate::accounts::AuthAccount, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    let home = dirs::home_dir().ok_or_else(|| native_error("无法定位用户目录".into()))?;
    blocking(move || crate::accounts::adopt_native(&db, &home, &tool_id, &label).map_err(native_error)).await
}

#[tauri::command]
pub async fn adopt_native_codex_account(app: AppHandle, label: String) -> Result<crate::accounts::AuthAccount, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    let home = dirs::home_dir().ok_or_else(|| native_error("无法定位用户目录".into()))?;
    blocking(move || crate::accounts::adopt_codex(&db, &home, &label).map_err(native_error)).await
}

#[tauri::command]
pub async fn list_accounts(app: AppHandle) -> Result<Vec<crate::accounts::AuthAccount>, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    blocking(move || crate::accounts::list(&db).map_err(native_error)).await
}

#[tauri::command]
pub async fn account_impact(app: AppHandle, id: String) -> Result<crate::accounts::AccountImpact, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    blocking(move || crate::accounts::impact(&db, &id).map_err(native_error)).await
}

#[tauri::command]
pub async fn create_account(app: AppHandle, tool_id: String, label: String) -> Result<crate::accounts::AuthAccount, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    blocking(move || crate::accounts::create(&db, &tool_id, &label).map_err(native_error)).await
}

#[tauri::command]
pub async fn rename_account(app: AppHandle, id: String, expected_version: u32, label: String) -> Result<crate::accounts::AuthAccount, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    blocking(move || crate::accounts::rename(&db, &id, expected_version, &label).map_err(native_error)).await
}

#[tauri::command]
pub async fn start_account_login(app: AppHandle, id: String, expected_version: u32, method: String) -> Result<crate::accounts::AuthAccount, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    let base = app.path().app_data_dir().map_err(|_| native_error("无法定位账号数据目录".into()))?;
    let home = dirs::home_dir().ok_or_else(|| native_error("无法定位用户目录".into()))?;
    blocking(move || crate::accounts::start_login(db, &base, &home, &id, expected_version, &method).map_err(native_error)).await
}

#[tauri::command]
pub async fn cancel_account_login(app: AppHandle, id: String, attempt_id: String) -> Result<crate::accounts::AuthAccount, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    blocking(move || crate::accounts::cancel(&db, &id, &attempt_id, false).map_err(native_error)).await
}

#[tauri::command]
pub async fn check_account(app: AppHandle, id: String) -> Result<crate::accounts::AuthAccount, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    let home = dirs::home_dir().ok_or_else(|| native_error("无法定位用户目录".into()))?;
    blocking(move || crate::accounts::check(&db, &home, &id).map_err(native_error)).await
}

#[tauri::command]
pub async fn logout_account(app: AppHandle, id: String, expected_version: u32) -> Result<crate::accounts::AuthAccount, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    let home = dirs::home_dir().ok_or_else(|| native_error("无法定位用户目录".into()))?;
    blocking(move || crate::accounts::logout(db, &home, &id, expected_version).map_err(native_error)).await
}

#[tauri::command]
pub fn usage_presets() -> Vec<crate::usage::UsagePreset> { crate::usage::usage_presets() }

#[tauri::command]
pub async fn ensure_profile_usage(app: AppHandle, profile_id: String, expected_profile_version: u64) -> Result<Option<crate::usage::UsageQuery>, crate::usage::UsageError> {
    usage_blocking(app, move |db| crate::usage::ensure_profile_query(db, &SystemCredentialStore, &profile_id, expected_profile_version)).await
}

#[tauri::command]
pub async fn delete_account(app: AppHandle, id: String, expected_version: u32) -> Result<(), ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    blocking(move || crate::accounts::delete(&db, &id, expected_version).map_err(native_error)).await
}

#[tauri::command]
pub async fn open_account_login_link(app: AppHandle, id: String, attempt_id: String) -> Result<(), ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    blocking(move || {
        let value = crate::accounts::native::login_url(&db, &id, &attempt_id).map_err(native_error)?;
        crate::external::open(&app, &value).map_err(native_error)
    }).await
}

#[tauri::command]
pub fn usage_builtin_script(config: crate::usage::QueryConfig) -> Result<String, crate::usage::UsageError> { crate::usage::builtin_script(&config) }

#[tauri::command]
pub async fn list_usage_cache(app: AppHandle) -> Result<Vec<crate::usage::UsageCache>, crate::usage::UsageError> {
    usage_blocking(app, crate::usage::list_cache).await
}

#[tauri::command]
pub async fn list_usage_samples(app: AppHandle, query_id: String) -> Result<Vec<crate::usage::UsageSample>, crate::usage::UsageError> {
    usage_blocking(app, move |db| crate::usage::list_samples(db, &query_id)).await
}

#[tauri::command]
pub async fn refresh_usage_query(app: AppHandle, id: String) -> Result<(), crate::usage::UsageError> {
    let db=app.state::<AppState>().database(&app).map_err(|_|crate::usage::UsageError::storage())?;
    tauri::async_runtime::spawn_blocking(move ||crate::usage::refresh_query(db,&id,true)).await.map_err(|_|crate::usage::UsageError::storage())?
}

#[tauri::command]
pub fn cancel_usage_refresh(id: String) -> Result<(), crate::usage::UsageError> { crate::usage::cancel_refresh(&id) }

pub fn usage_background_tick(app: &AppHandle) -> Result<(), crate::usage::UsageError> {
    let db=app.state::<AppState>().database(app).map_err(|_|crate::usage::UsageError::storage())?;
    crate::usage::scheduler_tick(db)
}

#[tauri::command]
pub async fn list_usage_queries(app: AppHandle) -> Result<Vec<crate::usage::UsageQuery>, crate::usage::UsageError> {
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
pub async fn test_usage_query(app: AppHandle, execution_id: String, draft_revision: u32, draft: crate::usage::UsageQueryDraft) -> Result<crate::usage::DraftTestReport, crate::usage::UsageError> {
    usage_blocking(app, move |db| crate::usage::test_draft(db, &SystemCredentialStore, execution_id, draft_revision, draft)).await
}

#[tauri::command]
pub async fn get_usage_query(app: AppHandle, id: String) -> Result<crate::usage::UsageQuery, crate::usage::UsageError> {
    usage_blocking(app, move |db| crate::usage::get_query(db, &id)).await
}

#[tauri::command]
pub async fn save_usage_query(app: AppHandle, draft: crate::usage::UsageQueryDraft) -> Result<crate::usage::SaveQueryResult, crate::usage::UsageError> {
    usage_blocking(app, move |db| crate::usage::save_query(db, &SystemCredentialStore, draft)).await
}

#[tauri::command]
pub async fn delete_usage_query(app: AppHandle, id: String, expected_version: u32) -> Result<crate::usage::DeleteQueryResult, crate::usage::UsageError> {
    usage_blocking(app, move |db| crate::usage::delete_query(db, &SystemCredentialStore, &id, expected_version)).await
}

#[tauri::command]
pub async fn list_portable_items(app: AppHandle) -> Result<Vec<portable::ImportItem>, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    blocking(move || {
        let snapshot = portable::collect_snapshot(&db, &SystemCredentialStore, &adapters::Registry::builtins()).map_err(native_error)?;
        Ok(snapshot.entities.iter().map(|entity| portable::ImportItem {
            key: entity.key(), kind: entity.kind().into(), label: entity.label(),
            status: "available", pending_fields: entity.pending_fields(),
            tool_id: match &entity.payload { portable::PortablePayload::Profile(value) => Some(value.profile.tool.clone()), _ => None },
            local_preview: None, incoming_preview: String::new(),
        }).collect())
    }).await
}

#[tauri::command]
pub async fn export_portable_bundle(app: AppHandle, destination: String, password: String,
    selected: Vec<String>) -> Result<usize, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    blocking(move || {
        let keys = selected.into_iter().collect();
        portable::export_bundle(&db, &SystemCredentialStore, &adapters::Registry::builtins(),
            &password, Some(&keys), Path::new(&destination)).map_err(native_error)
    }).await
}

#[tauri::command]
pub async fn preview_portable_bundle(app: AppHandle, source: String, password: String)
    -> Result<portable::ImportPreview, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    let draft = blocking(move || {
        let snapshot = portable::unlock_bundle(Path::new(&source), &password).map_err(native_error)?;
        portable::preview_import(&db, &SystemCredentialStore, &adapters::Registry::builtins(), snapshot).map_err(native_error)
    }).await?;
    let preview = portable::preview_dto(&draft);
    *app.state::<AppState>().portable_draft.lock().map_err(|_| native_error("迁移预览暂不可用".into()))? = Some(draft);
    Ok(preview)
}

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProjectLink { pub project_id: String, pub path: String }

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportApplyTarget { pub profile_id: String, pub project_id: Option<String> }

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportTargetResult { pub label: String, pub status: &'static str, pub detail: Option<String> }

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport { pub imported: usize, pub targets: Vec<ImportTargetResult> }

#[tauri::command]
pub async fn apply_portable_bundle(app: AppHandle, preview_id: String, selected: Vec<String>,
    project_links: Vec<ImportProjectLink>, apply_targets: Vec<ImportApplyTarget>)
    -> Result<ImportReport, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    let app_state = app.state::<AppState>();
    let draft = {
        let mut guard = app_state.portable_draft.lock()
            .map_err(|_| native_error("迁移预览暂不可用".into()))?;
        if guard.as_ref().is_none_or(|draft| draft.id != preview_id) {
            return Err(native_error("导入预览已失效，请重新解锁".into()));
        }
        guard.take().ok_or_else(|| native_error("导入预览已失效，请重新解锁".into()))?
    };
    let retry = draft.clone();
    let selected: std::collections::BTreeSet<String> = selected.into_iter().collect();
    for link in &project_links {
        if !selected.contains(&format!("project:{}", link.project_id)) {
            *app_state.portable_draft.lock().map_err(|_| native_error("迁移预览暂不可用".into()))? = Some(retry.clone());
            return Err(native_error("请先选择要关联目录的项目资料".into()));
        }
    }
    let mut occupied_targets = std::collections::BTreeSet::new();
    for target in &apply_targets {
        if !selected.contains(&format!("profile:{}", target.profile_id)) ||
            !draft.snapshot.entities.iter().any(|entity| entity.key() == format!("profile:{}", target.profile_id)) {
            *app_state.portable_draft.lock().map_err(|_| native_error("迁移预览暂不可用".into()))? = Some(retry.clone());
            return Err(native_error("应用目标不属于这次选择的命名配置".into()));
        }
        let tool = draft.snapshot.entities.iter().find_map(|entity| {
            if entity.key() != format!("profile:{}", target.profile_id) { return None; }
            match &entity.payload { portable::PortablePayload::Profile(value) => Some(value.profile.tool.clone()), _ => None }
        }).ok_or_else(|| native_error("应用配置不可用".into()))?;
        if !occupied_targets.insert((tool, target.project_id.clone())) {
            *app_state.portable_draft.lock().map_err(|_| native_error("迁移预览暂不可用".into()))? = Some(retry.clone());
            return Err(native_error("同一工具与范围只能选择一份配置应用".into()));
        }
    }
    let apply_app = app.clone();
    let result = blocking(move || {
        portable::with_change_notification(&db, || notify_portable_changed(&apply_app), || {
        let imported = portable::apply_import(&db, &SystemCredentialStore, &adapters::Registry::builtins(),
            &draft, &selected).map_err(native_error)?;
        let mut results = Vec::new();
        for link in project_links {
            let result = projects::relink(&db, &link.project_id, &link.path);
            results.push(ImportTargetResult {
                label: format!("项目目录 {}", link.project_id),
                status: if result.is_ok() { "linked" } else { "failed" },
                detail: result.err(),
            });
        }
        for target in apply_targets {
            let Some(portable::PortableEntity { payload: portable::PortablePayload::Profile(profile), .. }) =
                draft.snapshot.entities.iter().find(|entity| entity.key() == format!("profile:{}", target.profile_id)) else { continue };
            let project = target.project_id.as_ref().map(|id| projects::get(&db, id));
            let scope = if project.is_some() { Scope::Project } else { Scope::Global };
            let project_path = project.as_ref().and_then(|result| result.as_ref().ok()).and_then(|project| project.path.clone());
            let label = format!("{} · {}", profile.profile.name, target.project_id.as_deref().unwrap_or("全局"));
            let outcome = if project.as_ref().is_some_and(Result::is_err) {
                Err(native_error("应用项目不存在，请重新预览".into()))
            } else if scope == Scope::Project && project_path.is_none() {
                Err(native_error("项目目录待关联，请在本次预览选择本机目录".into()))
            } else {
                apply_registered_now(&apply_app, &profile.profile.tool, &target.profile_id, scope, project_path, false)
            };
            results.push(ImportTargetResult {
                label,
                status: if outcome.is_ok() { "applied" } else { "failed" },
                detail: outcome.err().map(|error| error.message),
            });
        }
        Ok(ImportReport { imported, targets: results })
        })
    }).await;
    if result.is_err() {
        let mut guard = app_state.portable_draft.lock()
            .map_err(|_| native_error("迁移预览暂不可用".into()))?;
        if guard.is_none() { *guard = Some(retry); }
    }
    result
}

#[tauri::command]
pub fn cancel_portable_preview(state: State<'_, AppState>) -> Result<(), ApiError> {
    state.portable_draft.lock().map_err(|_| native_error("迁移预览暂不可用".into()))?.take();
    Ok(())
}

#[tauri::command]
pub fn get_webdav_status(app: AppHandle) -> Result<portable::sync::SyncStatus, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    portable::sync::status(&db).map_err(native_error)
}

#[tauri::command]
pub async fn configure_webdav(app: AppHandle, setup: portable::sync::SyncSetup)
    -> Result<portable::sync::SyncStatus, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    blocking(move || portable::sync::configure(&db, &SystemCredentialStore, setup).map_err(native_error)).await
}

#[tauri::command]
pub fn set_webdav_enabled(app: AppHandle, enabled: bool) -> Result<portable::sync::SyncStatus, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    portable::sync::set_enabled(&db, enabled).map_err(native_error)
}

#[tauri::command]
pub async fn sync_webdav_now(app: AppHandle) -> Result<portable::sync::SyncStatus, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    blocking(move || portable::with_change_notification(&db, || notify_portable_changed(&app), ||
        portable::sync::run(&db, &SystemCredentialStore, &adapters::Registry::builtins(), false).map_err(native_error))).await
}

#[tauri::command]
pub async fn resolve_webdav_conflict(app: AppHandle, key: String, chosen_version_id: Option<String>)
    -> Result<portable::sync::SyncStatus, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    blocking(move || portable::with_change_notification(&db, || notify_portable_changed(&app), ||
        portable::sync::resolve(&db, &SystemCredentialStore, &adapters::Registry::builtins(),
        &key, chosen_version_id.as_deref()).map_err(native_error))).await
}

#[tauri::command]
pub async fn preview_webdav_conflict(app: AppHandle, key: String)
    -> Result<portable::sync::ConflictPreview, ApiError> {
    let db = app.state::<AppState>().database(&app)?;
    blocking(move || portable::sync::preview_conflict(&db,&SystemCredentialStore,
        &adapters::Registry::builtins(),&key).map_err(native_error)).await
}

pub fn sync_background_tick(app: &AppHandle) -> Result<(), ApiError> {
    let db = app.state::<AppState>().database(app)?;
    portable::with_change_notification(&db, || notify_portable_changed(app), ||
        portable::sync::run(&db, &SystemCredentialStore, &adapters::Registry::builtins(), true)
        .map(|_| ()).map_err(native_error))
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
        code: "native_error",
        message,
        action: "检查工具版本、原生文件和作用范围后重试；原配置不会自动清空。",
        data_directory: None,
    }
}

static HISTORY_REFRESH_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
static HISTORY_REFRESH_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
#[tauri::command]
pub fn cancel_history_refresh() { HISTORY_REFRESH_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst); }
#[tauri::command]
pub fn get_history_scan_progress() -> history::ScanProgress { history::scan_progress() }

#[tauri::command]
pub async fn refresh_history(app: AppHandle) -> Result<Vec<history::ScanStatus>, ApiError> {
    let generation = HISTORY_REFRESH_GENERATION.load(std::sync::atomic::Ordering::SeqCst);
    blocking(move || {
        let _guard = HISTORY_REFRESH_LOCK.try_lock().map_err(|_| native_error("扫描已在后台进行".into()))?;
        let home = home()?;
        app.state::<AppState>().with_database(&app, |db| {
            let managed = db.preferences().map_err(native_error)?.managed_tool_ids();
            history::refresh_controlled(db, &adapters::Registry::builtins(), &home, &managed, &|| HISTORY_REFRESH_GENERATION.load(std::sync::atomic::Ordering::SeqCst) != generation).map_err(native_error)
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
pub async fn delete_mcp_definition(app: AppHandle, id: String, expected_version: u64) -> Result<(), ApiError> {
    blocking(move || app.state::<AppState>().with_database(&app, |db| resources::mcp::delete_definition(db, &id, expected_version).map_err(native_error))).await
}

#[tauri::command]
pub async fn remove_native_mcp(app: AppHandle, target: resources::mcp::McpTargetRequest, name: String) -> Result<(), ApiError> {
    blocking(move || {
        let home = home()?;
        let db = app.state::<AppState>().database(&app)?;
        resources::mcp::remove_native(&db, &SystemCredentialStore, &adapters::Registry::builtins(), &home, &target, &name).map_err(native_error)
    }).await
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
pub async fn list_mcp_placements(app: AppHandle) -> Result<Vec<resources::mcp::McpPlacement>, ApiError> {
    blocking(move || app.state::<AppState>().with_database(&app, |db| resources::mcp::list_placements(db).map_err(native_error))).await
}

#[tauri::command]
pub async fn get_managed_mcp_enabled(app: AppHandle, definition_id: String, target: resources::mcp::McpTargetRequest) -> Result<Option<bool>,ApiError> {
    blocking(move || {let db=app.state::<AppState>().database(&app)?;resources::mcp::managed_enabled(&db,&definition_id,&target).map_err(native_error)}).await
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
pub async fn list_rule_placements(app: AppHandle) -> Result<Vec<resources::rules::RulePlacement>, ApiError> {
    blocking(move || {
        app.state::<AppState>().with_database(&app, |db| {
            resources::rules::list_placements(db, &adapters::Registry::builtins(), &home()?).map_err(native_error)
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
pub async fn set_skill_in_library(app: AppHandle, id: String, in_library: bool) -> Result<(), ApiError> {
    blocking(move || app.state::<AppState>().with_database(&app, |db| resources::skills::set_in_library(db, &id, in_library).map_err(native_error))).await
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
    blocking(move || resources::skills::list_zip_entries(&source, local).map_err(native_error)).await
}

#[tauri::command]
pub async fn preview_skill_local_zip(app: AppHandle, source: String, subdirectory: Option<String>) -> Result<resources::skills::SkillImportPreview, ApiError> {
    blocking(move || app.state::<AppState>().with_database(&app, |db| resources::skills::preview_local_zip(db, &source, subdirectory.as_deref()).map_err(native_error))).await
}

#[tauri::command]
pub async fn import_skill_local_zip(app: AppHandle, source: String, subdirectory: Option<String>, expected_new: Option<String>, expected_existing: Option<String>) -> Result<resources::skills::SkillPackage, ApiError> {
    blocking(move || app.state::<AppState>().with_database(&app, |db| resources::skills::import_local_zip(db, &source, subdirectory.as_deref(), expected_new.as_deref(), expected_existing.as_deref()).map_err(native_error))).await
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
        resources::skills::delete_package(&db, &adapters::Registry::builtins(), &home, &package_id).map_err(native_error)
    }).await
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
        let _context=crate::accounts::selection::enter_bound(&db,&home,&tool_id,scope,project_path.as_deref().map(Path::new)).map_err(native_error)?;
        crate::accounts::selection::validate_expected(&tool_id,expected_context_id.as_deref()).map_err(native_error)?;
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
    pub profile_model_summaries: std::collections::BTreeMap<String, Option<crate::native::configuration::ModelSummary>>,
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
        match crate::accounts::selection::bound(&database, &home, &tool_id, scope, project.as_deref(), false) {
            Ok(context) => Ok(RegisteredToolContext { effective_context_id: context.map(|(_, context)| context.id), native_context_error: None }),
            Err(error) => Ok(RegisteredToolContext { effective_context_id: None, native_context_error: Some(error) }),
        }
    }).await
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
            let saved = crate::native::workspace::saved_workspace(&registry, database, &tool_id, &key).map_err(native_error)?;
            let (_context, context_error) = match crate::accounts::selection::enter_bound(database, &home, &tool_id, scope, project.as_deref()) {
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
                transaction::recover_pending(database, &SystemCredentialStore).map_err(native_error)?
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
                effective_context_id: crate::accounts::selection::current(&tool_id).map(|context| context.id),
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
            let (_context, context_error) = match crate::accounts::selection::enter_bound(database, &home, tool.stable_id(), scope, project.as_deref()) {
                Ok(context) => (Some(context), None),
                Err(error) => (None, Some(error)),
            };
            let custom = tool_path(database, tool).map_err(native_error)?;
            let mut probe = if context_error.is_some() {
                adapter::probe_registered_summary_cached(&adapters::Registry::builtins(), tool.stable_id(), custom.as_deref(), &home, project.as_deref(), scope, false).map_err(native_error)?
            } else { adapter::probe(tool, custom.as_deref(), &home, project.as_deref(), scope) };
            let key = match scope {
                Scope::Global => "global".into(),
                Scope::Project => format!("project:{}", project.as_ref().unwrap().display()),
            };
            let profiles = profile::list_profiles(database, tool).map_err(native_error)?;
            let common = profile::get_common(database, tool).map_err(native_error)?;
            let recovery_needed = if context_error.is_some() { Vec::new() } else { transaction::recover_pending(database, &SystemCredentialStore).map_err(native_error)? };
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
                effective_context_id: crate::accounts::selection::current(tool.stable_id()).map(|context| context.id),
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
        profile::delete_profile(database, &id, expected_version, &expected_revision).map_err(native_error)
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
            let saved = profile::save_common(database, common, expected_version).map_err(native_error)?;
            Ok(CommonSaveResult { common: saved, applications: Vec::new() })
        })
    }).await?;
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
pub async fn get_skill_enabled(app: AppHandle, package_id: String, tool_id: String, scope: Scope, project_path: Option<String>) -> Result<bool,ApiError> {
    blocking(move || app.state::<AppState>().with_database(&app, |db| resources::skills::enabled(db,&adapters::Registry::builtins(),&home()?,&package_id,&tool_id,scope,project_path.as_deref()).map_err(native_error))).await
}
#[tauri::command]
pub async fn set_skill_enabled(app: AppHandle, expected_context_id: Option<String>, package_id: String, tool_id: String, scope: Scope, project_path: Option<String>, enabled: bool) -> Result<(),ApiError> {
    blocking(move || app.state::<AppState>().with_database(&app, |db| { let home=home()?; let _context=crate::accounts::selection::enter_bound(db,&home,&tool_id,scope,project_path.as_deref().map(Path::new)).map_err(native_error)?; crate::accounts::selection::validate_expected(&tool_id,expected_context_id.as_deref()).map_err(native_error)?; resources::skills::set_enabled(db,&SystemCredentialStore,&adapters::Registry::builtins(),&home,&package_id,&tool_id,scope,project_path.as_deref(),enabled).map_err(native_error) })).await
}
#[tauri::command]
pub async fn get_native_rule_enabled(app: AppHandle, target: rules::RuleTarget) -> Result<bool,ApiError> {
    blocking(move || app.state::<AppState>().with_database(&app, |db| rules::enabled(db,&adapters::Registry::builtins(),&home()?,&target).map_err(native_error))).await
}
#[tauri::command]
pub async fn set_native_rule_enabled(app: AppHandle, target: rules::RuleTarget, enabled: bool) -> Result<(),ApiError> {
    blocking(move || app.state::<AppState>().with_database(&app, |db| rules::set_enabled(db,&SystemCredentialStore,&adapters::Registry::builtins(),&home()?,&target,enabled).map_err(native_error))).await
}

#[tauri::command]
pub async fn read_native_rule(app: AppHandle, target: rules::RuleTarget) -> Result<rules::NativeRule, ApiError> {
    blocking(move || app.state::<AppState>().with_database(&app, |db| rules::read_current(db, &adapters::Registry::builtins(), &home()?, &target).map_err(native_error))).await
}

#[tauri::command]
pub async fn save_native_rule(app: AppHandle, target: rules::RuleTarget, original: String, edited: String) -> Result<transaction::ApplyOutcome, ApiError> {
    blocking(move || app.state::<AppState>().with_database(&app, |db| rules::save_current(db, &SystemCredentialStore, &adapters::Registry::builtins(), &home()?, &target, &original, &edited).map_err(native_error))).await
}

#[tauri::command]
pub async fn launch_cli_login(app: AppHandle, tool_id: String) -> Result<launch::LaunchResult, ApiError> {
    blocking(move || {
        let home = home()?;
        app.state::<AppState>().with_database(&app, |db| {
            let custom = registered_tool_path(db, &tool_id).map_err(native_error)?;
            let plan = launch::login_plan(db, &adapters::Registry::builtins(), &home, &tool_id, custom.as_deref()).map_err(native_error)?;
            launch::spawn(&db, plan).map_err(native_error)
        })
    }).await
}

#[tauri::command]
pub async fn get_connection_secret(secret_ref: String) -> Result<String, ApiError> {
    blocking(move || {
        if !profile::valid_connection_secret_ref(&secret_ref) { return Err(native_error("不是本应用保存的 API 密钥".into())); }
        SystemCredentialStore.get(&secret_ref).map_err(native_error)
    }).await
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
            let _context = crate::accounts::selection::enter_bound(database, &home, tool.stable_id(), scope, project.as_deref()).map_err(native_error)?;
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
            let _context = crate::accounts::selection::enter_bound(database, &home, tool.stable_id(), scope, project.as_deref()).map_err(native_error)?;
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
            let saved = profile::save_registered_common(database, &adapters::Registry::builtins(), common, expected_version).map_err(native_error)?;
            Ok(RegisteredCommonSaveResult { common: saved, applications: Vec::new() })
        })
    }).await?;
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
pub async fn reapply_account_profile(app:AppHandle,request:crate::accounts::AccountReapplyRequest)->Result<ApplyOutcome,ApiError> {
    blocking(move || {
        let _intent=crate::accounts::enter_reapply(request.clone()).map_err(native_error)?;
        apply_registered_now(&app,&request.tool_id,&request.profile_id,request.scope,request.project_path,false)
    }).await
}

#[tauri::command]
pub async fn compare_registered_application(app:AppHandle,profile_id:String,scope:Scope,project_path:Option<String>)->Result<apply::ApplyComparison,ApiError> {
    blocking(move || {let home=home()?;let project=checked_project(scope,project_path)?;let db=app.state::<AppState>().database(&app)?;
        apply::compare_registered_application(&adapters::Registry::builtins(),&db,&home,scope,project.as_deref(),&profile_id).map_err(native_error)}).await
}
#[tauri::command]
pub async fn apply_compared_application(app:AppHandle,comparison:apply::ApplyComparison,scope:Scope,project_path:Option<String>)->Result<ApplyOutcome,ApiError> {
    blocking(move || {let home=home()?;let project=checked_project(scope,project_path)?;let state=app.state::<AppState>();
        let result=state.with_database(&app,|db| {
            let custom=registered_tool_path(db,&comparison.profile.tool).map_err(native_error)?;
            let result=apply::apply_compared_application(&adapters::Registry::builtins(),db,&SystemCredentialStore,&comparison,&home,scope,project.as_deref(),custom.as_deref()).map_err(native_error)?;
            if let Some(path)=project.as_deref(){if let Err(error)=projects::record_applied_profile(db,path,&comparison.profile.tool,&comparison.profile.id){let _=app.emit("cliora:tray-error",format!("配置已应用，但项目快捷选择未能保存：{error}"));}}
            Ok(result)
        })?;
        let _=app.emit("cliora:bindings-changed",&comparison.profile.tool);Ok(result)
    }).await
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
pub async fn rename_project(app: AppHandle, project_id: String, name: String) -> Result<projects::Project, ApiError> {
    let notify = app.clone();
    let result = blocking(move || app.state::<AppState>().with_database(&app, |db| portable::with_change_notification(db, || notify_portable_changed(&app), || projects::rename(db,&project_id,&name).map_err(native_error)))).await?;
    let _ = notify.emit("cliora:projects-changed", &result.id); Ok(result)
}
#[tauri::command]
pub async fn remove_project(app: AppHandle, project_id: String) -> Result<(), ApiError> {
    let notify = app.clone();
    blocking(move || app.state::<AppState>().with_database(&app, |db| portable::with_change_notification(db, || notify_portable_changed(&app), || projects::remove(db,&project_id).map_err(native_error)))).await?;
    let _ = notify.emit("cliora:projects-changed", "removed"); Ok(())
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

fn npm_latest_version(package: &str) -> Result<String, String> {
    let url = format!("https://registry.npmjs.org/{package}/latest");
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
        .map_err(|_| "暂时查不到最新版本".to_string())?;
    let response = client
        .get(&url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .map_err(|_| "暂时查不到最新版本".to_string())?;
    if !response.status().is_success() {
        return Err("暂时查不到最新版本".into());
    }
    let body: serde_json::Value = response.json().map_err(|_| "暂时查不到最新版本".to_string())?;
    body.get("version")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "暂时查不到最新版本".into())
}

#[tauri::command]
pub async fn cli_latest_version(tool_id: String) -> Result<String, ApiError> {
    blocking(move || {
        let adapter = adapters::Registry::builtins()
            .get(&tool_id)
            .ok_or_else(|| native_error("此 CLI 适配器未注册".into()))?;
        npm_latest_version(adapter.npm_package()).map_err(native_error)
    })
    .await
}

#[tauri::command]
pub async fn maintain_registered_cli(
    app: AppHandle,
    tool_id: String,
    action: String,
    source: Option<String>,
) -> Result<(), ApiError> {
    blocking(move || {
        let registry = adapters::Registry::builtins();
        let adapter = registry
            .get(&tool_id)
            .ok_or_else(|| native_error("此 CLI 适配器未注册".into()))?;
        let source = source.as_deref().unwrap_or("unknown");
        if !matches!(source, "npm_shim" | "native" | "unknown") {
            return Err(native_error("未知安装来源".into()));
        }
        let script = match action.as_str() {
            "install" => match source {
                "npm_shim" => adapter.npm_install_command(),
                "native" => adapter.native_install_command(),
                _ => adapter.install_command(),
            },
            "install_native" => adapter.native_install_command(),
            "upgrade" => adapter.upgrade_command(source),
            "uninstall_npm" => adapter.npm_uninstall_command(),
            _ => None,
        }
        .ok_or_else(|| native_error("没有可直接执行的命令".into()))?;
        app.state::<AppState>().with_database(&app, |database| {
            launch::open_shell(database, &script).map_err(native_error)
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

pub(crate) struct LaunchFailure {
    pub error: ApiError,
    pub stage: launch::LaunchStage,
    pub project_path: Option<String>,
    pub profile_id: Option<String>,
}

impl LaunchFailure {
    fn new(stage: launch::LaunchStage, error: ApiError) -> Self {
        Self {
            error,
            stage,
            project_path: None,
            profile_id: None,
        }
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
) -> Result<launch::LaunchResult, LaunchFailure> {
    use launch::LaunchStage;
    let home = home().map_err(|error| LaunchFailure::new(LaunchStage::ProjectDirectory, error))?;
    let project_id = request.project_id.clone();
    let project = project_id
        .as_deref()
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
    let db = app.state::<AppState>().database(app).map_err(|error| LaunchFailure::new(LaunchStage::Terminal, error))?;
    let result = launch::spawn(&db, plan).map_err(|message| LaunchFailure::new(LaunchStage::Terminal, native_error(message)))?;
    if let Some(project_id) = &project_id {
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
            let _context = crate::accounts::selection::enter_bound(database, &home, &tool_id, scope, project.as_deref()).map_err(native_error)?;
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
            let _context = crate::accounts::selection::enter_bound(database, &home, &tool_id, scope, project.as_deref()).map_err(native_error)?;
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

fn backup_target(registry: &adapters::Registry, tool_id: &str, scope: Scope, home: &Path, project: Option<&Path>, role: &str) -> Result<std::path::PathBuf, ApiError> {
    let adapter = registry.get(tool_id).ok_or_else(|| native_error("未注册的 CLI 适配器".into()))?;
    let file = adapter.native_files(scope, home, project, true).into_iter().find(|file| file.role == role && file.writable && !file.sensitive).ok_or_else(|| native_error("当前角色不允许恢复".into()))?;
    Ok(std::path::PathBuf::from(file.path))
}

#[tauri::command]
pub async fn list_native_backups(app: AppHandle, tool_id: String, scope: Scope, project_path: Option<String>, role: String) -> Result<Vec<transaction::BackupRecord>, ApiError> {
    blocking(move || {
        let home = home()?; let project = checked_project(scope, project_path)?;
        let account_db=app.state::<AppState>().database(&app)?;
        let _context=crate::accounts::selection::enter_bound(&account_db,&home,&tool_id,scope,project.as_deref()).map_err(native_error)?;
        let path = backup_target(&adapters::Registry::builtins(), &tool_id, scope, &home, project.as_deref(), &role)?;
        app.state::<AppState>().with_database(&app, |db| transaction::recent_backups(db, &path).map_err(native_error))
    }).await
}

#[tauri::command]
pub async fn preview_native_backup(app: AppHandle, tool_id: String, scope: Scope, project_path: Option<String>, role: String, transaction_id: String) -> Result<transaction::BackupPreview, ApiError> {
    blocking(move || {
        let home = home()?; let project = checked_project(scope, project_path)?;
        let account_db=app.state::<AppState>().database(&app)?;
        let _context=crate::accounts::selection::enter_bound(&account_db,&home,&tool_id,scope,project.as_deref()).map_err(native_error)?;
        let path = backup_target(&adapters::Registry::builtins(), &tool_id, scope, &home, project.as_deref(), &role)?;
        app.state::<AppState>().with_database(&app, |db| transaction::preview_backup(db, &SystemCredentialStore, &path, &transaction_id).map_err(native_error))
    }).await
}

#[tauri::command]
pub async fn restore_native_backup(app: AppHandle, expected_context_id: Option<String>, tool_id: String, scope: Scope, project_path: Option<String>, role: String, transaction_id: String, current: String) -> Result<transaction::ApplyOutcome, ApiError> {
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
pub async fn save_registered_native_file(app: AppHandle, expected_context_id: Option<String>, tool_id: String, scope: Scope, project_path: Option<String>, role: String, original: String, edited: String) -> Result<crate::native::transaction::ApplyOutcome, ApiError> {
    blocking(move || {
        let home = home()?;
        let project = checked_project(scope, project_path)?;
        app.state::<AppState>().with_database(&app, |db| {
            let registry = adapters::Registry::builtins();
            let _context = crate::accounts::selection::enter_bound(db, &home, &tool_id, scope, project.as_deref()).map_err(native_error)?;
            crate::accounts::selection::validate_expected(&tool_id,expected_context_id.as_deref()).map_err(native_error)?;
            let custom = registered_tool_path(db, &tool_id).map_err(native_error)?;
            let probe = adapter::probe_registered(&registry, &tool_id, custom.as_deref(), &home, project.as_deref(), scope).map_err(native_error)?;
            if probe.native_writes.state != "supported" { return Err(native_error(probe.native_writes.reason.into())); }
            let version = probe.installations.iter().find(|item| Some(&item.path) == probe.selected_path.as_ref()).and_then(|item| item.version.as_deref()).ok_or_else(|| native_error("未确认 CLI 版本".into()))?;
            adapters::save_registered_text(&registry, &tool_id, &role, scope, &home, project.as_deref(), version, db, &SystemCredentialStore, &original, &edited).map_err(native_error)
        })
    }).await
}

#[tauri::command]
pub fn merge_registered_native_edits(tool_id: String, role: String, original: String, edited: String, current: String) -> Result<String, ApiError> {
    let registry = adapters::Registry::builtins();
    let adapter = registry.get(&tool_id).ok_or_else(|| native_error("未注册的 CLI 适配器".into()))?;
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

#[tauri::command]
pub fn set_tool_icon(app: AppHandle, state: State<'_, AppState>, tool_id: String, data_url: Option<String>) -> Result<Bootstrap, ApiError> {
    let candidate = data_url.clone().map(|data| std::collections::BTreeMap::from([(tool_id.clone(), data)])).unwrap_or_default();
    if !crate::domain::valid_icon_id(&tool_id) || !crate::domain::valid_tool_icons(&candidate) {
        return Err(storage_error("请选择不超过 128 KB 的 PNG、JPEG 或 WebP 图标".into()));
    }
    state.with_database(&app, |database| {
        let current = database.preferences().map_err(storage_error)?;
        if data_url.is_some() && !current.tool_icons.contains_key(&tool_id) && current.tool_icons.len() >= 100 {
            return Err(storage_error("最多保存 100 个工具图标".into()));
        }
        database.update_preferences(|preferences| {
            if let Some(data) = data_url { preferences.tool_icons.insert(tool_id, data); }
            else { preferences.tool_icons.remove(&tool_id); }
        }).map(Bootstrap::new).map_err(storage_error)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(delete_error.contains("未注册的 CLI 适配器"), "{delete_error}");
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

#[tauri::command]
pub async fn open_external_url(app:AppHandle,url:String)->Result<(),ApiError> {blocking(move || crate::external::open(&app,&url).map_err(native_error)).await}

#[tauri::command]
pub fn describe_configuration(tool_id: String, scope: Scope) -> Result<Option<adapters::configuration::ConfigurationDescriptor>, ApiError> {
    crate::native::configuration::describe(&adapters::Registry::builtins(), &tool_id, scope).map_err(native_error)
}
#[tauri::command]
pub fn open_configuration_draft(app: AppHandle, state: State<'_, AppState>, profile: RegisteredProfile, scope: Scope, session_id: String) -> Result<crate::native::configuration::ConfigurationDraft, ApiError> {
    state.with_database(&app, |database| {
        let common = profile::get_registered_common(database, &profile.tool).map_err(native_error)?;
        crate::native::configuration::open_with_common(&adapters::Registry::builtins(), profile, common, scope, session_id).map_err(native_error)
    })
}
#[tauri::command]
pub fn edit_configuration_draft(app:AppHandle,draft: crate::native::configuration::ConfigurationDraft, action: adapters::configuration::ConfigurationAction) -> Result<crate::native::configuration::ConfigurationDraft, ApiError> {
    if draft.subject.is_some(){app.state::<AppState>().workspace.edit(&adapters::Registry::builtins(),draft,action).map_err(native_error)}
    else{crate::native::configuration::edit(&adapters::Registry::builtins(), draft, action).map_err(native_error)}
}
#[tauri::command]
pub fn replace_configuration_text(app:AppHandle,draft: crate::native::configuration::ConfigurationDraft, files: std::collections::BTreeMap<String, String>) -> Result<crate::native::configuration::ConfigurationDraft,ApiError> {
    if draft.subject.is_some(){app.state::<AppState>().workspace.raw(&adapters::Registry::builtins(),draft,files).map_err(native_error)}
    else{Ok(crate::native::configuration::replace_text(&adapters::Registry::builtins(), draft, files))}
}

#[tauri::command]
pub async fn begin_configuration_draft(app:AppHandle,request:crate::native::workspace::ConfigurationBeginRequest)->Result<crate::native::configuration::ConfigurationDraft,ApiError>{
    blocking(move||{
        let home=home()?;let project=checked_project(request.scope,request.project_path.clone())?;
        app.state::<AppState>().with_database(&app,|db|{
            let registry=adapters::Registry::builtins();
            app.state::<AppState>().workspace.begin_registered(&registry,db,request,&home,project.as_deref()).map_err(native_error)
        })
    }).await
}
#[tauri::command]
pub fn update_configuration_draft(app:AppHandle,draft:crate::native::configuration::ConfigurationDraft,profile:RegisteredProfile)->Result<crate::native::configuration::ConfigurationDraft,ApiError>{
    app.state::<AppState>().workspace.update(&adapters::Registry::builtins(),draft,profile).map_err(native_error)
}
#[tauri::command]
pub fn select_configuration_credential(app:AppHandle,draft:crate::native::configuration::ConfigurationDraft,credential:crate::native::workspace::ConfigurationCredential)->Result<crate::native::configuration::ConfigurationDraft,ApiError>{
    app.state::<AppState>().with_database(&app,|db|app.state::<AppState>().workspace.select_credential(&adapters::Registry::builtins(),db,draft,credential).map_err(native_error))
}
#[tauri::command]
pub fn set_configuration_draft_secret(app:AppHandle,draft:crate::native::configuration::ConfigurationDraft,secret:String)->Result<crate::native::configuration::ConfigurationDraft,ApiError>{
    app.state::<AppState>().workspace.set_secret(&adapters::Registry::builtins(),draft,secret).map_err(native_error)
}
#[tauri::command]
pub fn remove_configuration_draft_secret(app:AppHandle,draft:crate::native::configuration::ConfigurationDraft)->Result<crate::native::configuration::ConfigurationDraft,ApiError>{
    app.state::<AppState>().workspace.remove_secret(&adapters::Registry::builtins(),draft).map_err(native_error)
}
#[tauri::command]
pub fn reveal_configuration_draft_secret(app:AppHandle,draft:crate::native::configuration::ConfigurationDraft)->Result<String,ApiError>{
    app.state::<AppState>().workspace.reveal_secret(&draft,&SystemCredentialStore).map_err(native_error)
}
#[tauri::command]
pub fn cancel_configuration_draft(app:AppHandle,session_id:String)->Result<(),ApiError>{app.state::<AppState>().workspace.cancel(&session_id).map_err(native_error)}
#[tauri::command]
pub fn cancel_configuration_requests(app:AppHandle,draft:crate::native::configuration::ConfigurationDraft)->Result<crate::native::configuration::ConfigurationDraft,ApiError>{app.state::<AppState>().workspace.cancel_requests(draft).map_err(native_error)}
#[tauri::command]
pub fn add_configuration_models(app:AppHandle,draft:crate::native::configuration::ConfigurationDraft,ids:Vec<String>)->Result<crate::native::configuration::ConfigurationDraft,ApiError>{app.state::<AppState>().workspace.add_models(&adapters::Registry::builtins(),draft,ids).map_err(native_error)}
#[derive(serde::Serialize)]
#[serde(rename_all="camelCase")]
pub struct ConfigurationDirectoryResult {session_id:String,revision:u64,request_generation:u64,directory:models::ModelDirectory}
#[tauri::command]
pub async fn list_configuration_models(app:AppHandle,draft:crate::native::configuration::ConfigurationDraft,force:bool,query:String)->Result<ConfigurationDirectoryResult,ApiError>{
    blocking(move||app.state::<AppState>().with_database(&app,|db|{
        let workspace=&app.state::<AppState>().workspace;
        let(connection,credential)=workspace.request_directory(&draft,&SystemCredentialStore).map_err(native_error)?;
        let directory=models::list_models_guarded(db,&credential,&connection,force,&query,||!workspace.is_current(&draft)).map_err(native_error)?;
        workspace.finish_request(&draft).map_err(native_error)?;
        Ok(ConfigurationDirectoryResult{session_id:draft.session_id,revision:draft.revision,request_generation:draft.request_generation,directory})
    })).await
}
#[derive(serde::Serialize)]
#[serde(rename_all="camelCase")]
pub struct ConfigurationCheckResult {session_id:String,revision:u64,request_generation:u64,check:models::ConnectionCheck}
#[tauri::command]
pub async fn check_configuration_connection(app:AppHandle,draft:crate::native::configuration::ConfigurationDraft,allow_model_request:bool)->Result<ConfigurationCheckResult,ApiError>{
    blocking(move||{
        let workspace=&app.state::<AppState>().workspace;
        let(mut connection,credential)=workspace.request(&draft,&SystemCredentialStore).map_err(native_error)?;
        if allow_model_request {
            let actual=draft.profile.connection.as_ref().filter(|actual|actual.provider_id==connection.provider_id&&actual.base_url==connection.base_url&&actual.interface_format==connection.interface_format&&!actual.model.trim().is_empty()).ok_or_else(||native_error("请明确设置此连接的默认模型后再确认模型请求".into()))?;
            connection.model=actual.model.clone();
        }
        let check=models::test_registered_connection_guarded(&adapters::Registry::builtins(),&draft.profile.tool,&connection,&credential,allow_model_request,||!workspace.is_current(&draft));
        workspace.finish_request(&draft).map_err(native_error)?;
        Ok(ConfigurationCheckResult{session_id:draft.session_id,revision:draft.revision,request_generation:draft.request_generation,check})
    }).await
}
#[tauri::command]
pub async fn save_configuration_draft(app:AppHandle,draft:crate::native::configuration::ConfigurationDraft)->Result<crate::native::workspace::ConfigurationSaveResult,ApiError>{
    let notify=app.clone();let tool=draft.profile.tool.clone();
    let result=blocking(move||app.state::<AppState>().with_database(&app,|db|{
        let registry=adapters::Registry::builtins();
        if draft.subject==Some(adapters::configuration::ConfigurationSubject::Current){
            let home=home()?;let project=checked_project(draft.scope,draft.project_path.clone())?;
            let _context=crate::accounts::selection::enter_bound(db,&home,&draft.profile.tool,draft.scope,project.as_deref()).map_err(native_error)?;
            crate::accounts::selection::validate_expected(&draft.profile.tool,draft.context_id.as_deref()).map_err(native_error)?;
            let custom=registered_tool_path(db,&draft.profile.tool).map_err(native_error)?;
            let probe=adapter::probe_registered(&registry,&draft.profile.tool,custom.as_deref(),&home,project.as_deref(),draft.scope).map_err(native_error)?;
            if probe.native_writes.state!="supported"{return Err(native_error(probe.native_writes.reason.into()));}
            app.state::<AppState>().workspace.save_current(&registry,db,&SystemCredentialStore,draft,&probe.native_files).map_err(native_error)
        }else{app.state::<AppState>().workspace.save_database(&registry,db,&SystemCredentialStore,draft).map_err(native_error)}
    })).await?;
    let _=notify.emit("cliora:bindings-changed",tool);Ok(result)
}
#[tauri::command]
pub fn common_influence(app:AppHandle,tool_id:String)->Result<crate::native::workspace::CommonInfluence,ApiError>{app.state::<AppState>().with_database(&app,|db|crate::native::workspace::common_influence(db,&tool_id).map_err(native_error))}
#[tauri::command]
pub async fn apply_common_configuration(app:AppHandle,common:RegisteredCommon,targets:Vec<crate::native::workspace::CommonInfluenceTarget>)->Result<Vec<crate::native::workspace::CommonApplicationResult>,ApiError>{
    let notify=app.clone();let tool=common.tool.clone();
    let result=blocking(move||app.state::<AppState>().with_database(&app,|db|{
        crate::native::workspace::apply_common(&adapters::Registry::builtins(),db,&common,&targets,|target,profile,binding|{
            let registry=adapters::Registry::builtins();let home=home().map_err(|error|error.message)?;
            let project=checked_project(target.scope,target.project_path.clone()).map_err(|error|error.message)?;
            crate::accounts::validate_reapply_profile(db,profile,target.scope,project.as_deref())?;
            let _context=crate::accounts::selection::enter(crate::accounts::selection::for_profile(db,&home,profile)?);
            crate::accounts::selection::validate_expected(&common.tool,target.context_id.as_deref())?;
            let custom=registered_tool_path(db,&common.tool)?;
            let probe=adapter::probe_registered(&registry,&common.tool,custom.as_deref(),&home,project.as_deref(),target.scope)?;
            if probe.native_writes.state!="supported"{return Err(probe.native_writes.reason.into());}
            apply::apply_registered_validated_expected(&registry,db,&SystemCredentialStore,profile,Some(&common),&probe.native_files,&apply::scope_key(target.scope,project.as_deref())?,target.scope,binding)
        }).map_err(native_error)
    })).await?;
    let _=notify.emit("cliora:bindings-changed",tool);Ok(result)
}

#[tauri::command]
pub async fn compare_configuration_current(app:AppHandle,draft:crate::native::configuration::ConfigurationDraft)->Result<crate::native::workspace::ConfigurationCurrentComparison,ApiError>{
    blocking(move||app.state::<AppState>().with_database(&app,|db|{let home=home()?;let project=checked_project(draft.scope,draft.project_path.clone())?;let _context=crate::accounts::selection::enter_bound(db,&home,&draft.profile.tool,draft.scope,project.as_deref()).map_err(native_error)?;app.state::<AppState>().workspace.compare_current(&adapters::Registry::builtins(),draft).map_err(native_error)})).await
}
#[tauri::command]
pub async fn rebase_configuration_current(app:AppHandle,draft:crate::native::configuration::ConfigurationDraft,comparison_id:String,files:std::collections::BTreeMap<String,String>)->Result<crate::native::configuration::ConfigurationDraft,ApiError>{
    blocking(move||app.state::<AppState>().with_database(&app,|db|{let home=home()?;let project=checked_project(draft.scope,draft.project_path.clone())?;let _context=crate::accounts::selection::enter_bound(db,&home,&draft.profile.tool,draft.scope,project.as_deref()).map_err(native_error)?;app.state::<AppState>().workspace.rebase_current(&adapters::Registry::builtins(),draft,comparison_id,files).map_err(native_error)})).await
}
#[tauri::command]
pub async fn preview_configuration_backup(app:AppHandle,draft:crate::native::configuration::ConfigurationDraft,role:String,transaction_id:String)->Result<crate::native::workspace::ConfigurationBackupPreview,ApiError>{
    blocking(move||app.state::<AppState>().with_database(&app,|db|{let home=home()?;let project=checked_project(draft.scope,draft.project_path.clone())?;let _context=crate::accounts::selection::enter_bound(db,&home,&draft.profile.tool,draft.scope,project.as_deref()).map_err(native_error)?;app.state::<AppState>().workspace.preview_backup(&adapters::Registry::builtins(),db,&SystemCredentialStore,draft,role,transaction_id).map_err(native_error)})).await
}
#[tauri::command]
pub async fn restore_configuration_backup(app:AppHandle,draft:crate::native::configuration::ConfigurationDraft,role:String,transaction_id:String)->Result<crate::native::workspace::ConfigurationSaveResult,ApiError>{
    let notify=app.clone();let tool=draft.profile.tool.clone();
    let result=blocking(move||app.state::<AppState>().with_database(&app,|db|{let home=home()?;let project=checked_project(draft.scope,draft.project_path.clone())?;let _context=crate::accounts::selection::enter_bound(db,&home,&draft.profile.tool,draft.scope,project.as_deref()).map_err(native_error)?;app.state::<AppState>().workspace.restore_backup(&adapters::Registry::builtins(),db,&SystemCredentialStore,draft,role,transaction_id).map_err(native_error)})).await?;
    let _=notify.emit("cliora:bindings-changed",tool);Ok(result)
}
