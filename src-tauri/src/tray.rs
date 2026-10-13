use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::{self, AppState};
use crate::launch::{self, LaunchRequest, LaunchStage};
use crate::native::adapter::Scope;
use crate::adapters::{LaunchMode, Registry};
use crate::native::{apply, profile};
use crate::projects;

#[derive(Clone, Debug)]
enum Action {
    Show,
    Quit,
    Switch {
        tool: String,
        profile: String,
        project: Option<String>,
    },
    Launch {
        tool: String,
        project: String,
        mode: LaunchMode,
    },
    RepairProject {
        project: String,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepairTarget {
    page: &'static str,
    resource_view: Option<&'static str>,
    tool_id: Option<String>,
    scope: Option<Scope>,
    project_id: Option<String>,
    project_path: Option<String>,
    profile_id: Option<String>,
}

impl RepairTarget {
    fn project(project_id: String) -> Self {
        Self {
            page: "home",
            resource_view: None,
            tool_id: None,
            scope: None,
            project_id: Some(project_id),
            project_path: None,
            profile_id: None,
        }
    }

    fn connection(
        tool_id: String,
        scope: Scope,
        project_id: Option<String>,
        project_path: Option<String>,
        profile_id: Option<String>,
    ) -> Self {
        Self {
            page: "connections",
            resource_view: None,
            tool_id: Some(tool_id),
            scope: Some(scope),
            project_id,
            project_path,
            profile_id,
        }
    }

    fn settings() -> Self {
        Self {
            page: "settings",
            resource_view: None,
            tool_id: None,
            scope: None,
            project_id: None,
            project_path: None,
            profile_id: None,
        }
    }

    fn for_launch_failure(tool: &str, project: &str, failure: &commands::LaunchFailure) -> Self {
        match failure.stage {
            LaunchStage::ProjectDirectory => Self::project(project.to_owned()),
            LaunchStage::Configuration => Self::connection(
                tool.to_owned(),
                Scope::Project,
                Some(project.to_owned()),
                failure.project_path.clone(),
                failure.profile_id.clone(),
            ),
            LaunchStage::Skills => {
                let mut target = Self::connection(
                    tool.to_owned(),
                    Scope::Project,
                    Some(project.to_owned()),
                    failure.project_path.clone(),
                    None,
                );
                target.resource_view = Some("skills");
                target
            }
            LaunchStage::Tool => Self::connection(
                tool.to_owned(),
                Scope::Project,
                Some(project.to_owned()),
                failure.project_path.clone(),
                None,
            ),
            LaunchStage::Terminal => Self::settings(),
        }
    }
}

#[derive(Default)]
pub struct TrayState {
    icon: Mutex<Option<TrayIcon>>,
    refresh_lock: Mutex<()>,
    actions: Mutex<HashMap<String, Action>>,
    error: Mutex<Option<String>>,
    generation: AtomicU64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayStatus {
    pub available: bool,
    pub error: Option<String>,
}

impl TrayState {
    pub fn status(&self) -> TrayStatus {
        TrayStatus {
            available: self.icon.lock().is_ok_and(|icon| icon.is_some()),
            error: self.error.lock().ok().and_then(|error| error.clone()),
        }
    }

    fn set_error(&self, message: String) {
        if let Ok(mut error) = self.error.lock() {
            *error = Some(message);
        }
    }
}

pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn report_error(app: &AppHandle, message: String, repair: Option<RepairTarget>) {
    app.state::<TrayState>().set_error(message.clone());
    show_main(app);
    if let Some(target) = repair {
        let _ = app.emit("cliora:tray-repair", target);
    }
    let _ = app.emit("cliora:tray-error", message);
}

fn applied_label(
    profiles: &[profile::RegisteredProfile],
    binding: Option<&apply::AppliedBinding>,
) -> String {
    let Some(binding) = binding else {
        return "未选择".into();
    };
    let Some(profile) = profiles.iter().find(|item| item.id == binding.profile_id) else {
        return format!("已应用配置 {} · 当前列表不可用", binding.profile_id);
    };
    if profile.version == binding.profile_version {
        profile.name.clone()
    } else {
        if binding.profile_version == 0 { format!("{} · 导入内容待应用", profile.name) }
        else { format!("{} · 有未应用修改（已应用 v{}）", profile.name, binding.profile_version) }
    }
}

fn profile_state_label(
    profile: &profile::RegisteredProfile,
    binding: Option<&apply::AppliedBinding>,
    pending: bool,
) -> String {
    if let Some(binding) = binding.filter(|binding| binding.profile_id == profile.id) {
        let status = if binding.profile_version == profile.version {
            String::new()
        } else {
            if binding.profile_version == 0 { " · 导入内容待应用".into() }
            else { format!(" · 有未应用修改（已应用 v{}）", binding.profile_version) }
        };
        format!("{}{}", profile.name, status)
    } else if pending {
        format!("{} · 待重新应用", profile.name)
    } else {
        profile.name.clone()
    }
}

fn recent_action(project_id: &str, tool: Option<&str>, available: bool, mode: LaunchMode) -> Action {
    match (available, tool) {
        (true, Some(tool)) => Action::Launch {
            tool: tool.to_owned(),
            project: project_id.to_owned(),
            mode,
        },
        _ => Action::RepairProject {
            project: project_id.to_owned(),
        },
    }
}

fn simple_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, String> {
    let menu = Menu::new(app).map_err(|error| error.to_string())?;
    menu.append(
        &MenuItem::with_id(app, "show", "显示栖点", true, None::<&str>)
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    menu.append(
        &MenuItem::with_id(app, "quit", "完全退出", true, None::<&str>)
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    Ok(menu)
}

/// macOS menu bar extras open their menu on a left click and use a monochrome
/// template image that follows the menu bar appearance. Windows and Linux keep
/// the colour icon and left click to show the window.
const MENU_BAR_STYLE: bool = cfg!(target_os = "macos");

fn tray_icon(app: &tauri::App) -> Option<tauri::image::Image<'static>> {
    if MENU_BAR_STYLE {
        Some(tauri::include_image!("icons/tray-template.png"))
    } else {
        app.default_window_icon().map(|icon| icon.clone().to_owned())
    }
}

pub fn setup(app: &mut tauri::App) {
    let handle = app.handle().clone();
    let state = TrayState::default();
    app.manage(state);
    let icon = tray_icon(app);
    let Some(icon) = icon else {
        app.state::<TrayState>()
            .set_error("应用图标不可用；主窗口将保持打开".into());
        return;
    };
    let menu = match simple_menu(&handle) {
        Ok(menu) => menu,
        Err(error) => {
            app.state::<TrayState>()
                .set_error(format!("托盘菜单不可用；主窗口将保持打开：{error}"));
            return;
        }
    };
    match TrayIconBuilder::with_id("cliora-main")
        .icon(icon)
        .tooltip("栖点 · Cliora")
        .menu(&menu)
        .icon_as_template(MENU_BAR_STYLE)
        .show_menu_on_left_click(MENU_BAR_STYLE)
        .on_menu_event(|app, event| on_menu(app, event.id.as_ref()))
        .on_tray_icon_event(|tray, event| {
            if !MENU_BAR_STYLE && matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_main(tray.app_handle());
            }
        })
        .build(app)
    {
        Ok(icon) => {
            if let Ok(mut current) = app.state::<TrayState>().icon.lock() {
                *current = Some(icon);
            }
            if let Err(error) = refresh(&handle) {
                app.state::<TrayState>()
                    .set_error(format!("托盘列表暂不可用：{error}"));
            }
        }
        Err(error) => app
            .state::<TrayState>()
            .set_error(format!("托盘不可用；主窗口将保持打开：{error}")),
    }
}

fn new_item(
    app: &AppHandle,
    id: &str,
    text: &str,
    enabled: bool,
) -> Result<MenuItem<tauri::Wry>, String> {
    MenuItem::with_id(app, id, text, enabled, None::<&str>).map_err(|error| error.to_string())
}

fn register_action(
    app: &AppHandle,
    actions: &mut HashMap<String, Action>,
    counter: &mut usize,
    generation: u64,
    action: Action,
    text: &str,
    enabled: bool,
) -> Result<MenuItem<tauri::Wry>, String> {
    *counter += 1;
    let id = format!("g{generation}-action-{counter}");
    actions.insert(id.clone(), action);
    new_item(app, &id, text, enabled)
}

fn register_check_action(
    app: &AppHandle,
    actions: &mut HashMap<String, Action>,
    counter: &mut usize,
    generation: u64,
    action: Action,
    text: &str,
    checked: bool,
) -> Result<CheckMenuItem<tauri::Wry>, String> {
    *counter += 1;
    let id = format!("g{generation}-action-{counter}");
    actions.insert(id.clone(), action);
    CheckMenuItem::with_id(app, &id, text, true, checked, None::<&str>)
        .map_err(|error| error.to_string())
}

fn separator(app: &AppHandle) -> Result<PredefinedMenuItem<tauri::Wry>, String> {
    PredefinedMenuItem::separator(app).map_err(|error| error.to_string())
}

/// Disabled, non-interactive row used as a section heading.
fn section_label(app: &AppHandle, text: &str) -> Result<MenuItem<tauri::Wry>, String> {
    MenuItem::new(app, text, false, None::<&str>).map_err(|error| error.to_string())
}

/// Tray menu layout (kept short and scannable, one decision per level):
///
/// ```text
/// 显示主窗口
/// ──────────
/// 全局配置                      (section label)
/// Codex · 日常开发          ▸   ✓ 日常开发 / GLM 官方套餐
/// ──────────
/// 最近项目 · 普通启动            (section label)
/// 栖点 · 桌面工具           ▸   启动 Codex / ── / Codex · 日常开发 ▸
/// 旧项目 · 目录需重关联           (opens repair)
/// ──────────
/// 完全退出栖点
/// ```
pub fn refresh(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<TrayState>();
    let _refresh_guard = state
        .refresh_lock
        .lock()
        .map_err(|_| "托盘刷新暂不可用".to_owned())?;
    if !state.status().available {
        return Ok(());
    }
    let menu = Menu::new(app).map_err(|error| error.to_string())?;
    let mut actions = HashMap::new();
    let mut counter = 0;
    let generation = state.generation.fetch_add(1, Ordering::Relaxed) + 1;
    menu.append(&register_action(
        app,
        &mut actions,
        &mut counter,
        generation,
        Action::Show,
        "显示主窗口",
        true,
    )?)
    .map_err(|error| error.to_string())?;

    let registry = Registry::builtins();
    let data = app
        .state::<AppState>()
        .with_database(app, |db| {
            let preferences = db.preferences().map_err(commands::native_error)?;
            let mut managed: Vec<String> = preferences
                .managed_tools
                .iter()
                .map(|id| id.stable_id().to_owned())
                .collect();
            managed.extend(
                preferences
                    .unknown_managed_tools()
                    .iter()
                    .filter(|id| registry.get(id).is_some())
                    .cloned(),
            );
            let recent = projects::list(db).map_err(commands::native_error)?;
            let (_, project_mode) = launch::saved_launch_modes(db).map_err(commands::native_error)?;
            let mut tools = Vec::new();
            for id in managed {
                let Some(adapter) = registry.get(&id) else {
                    continue;
                };
                let profiles =
                    profile::list_registered_profiles(db, &id).map_err(commands::native_error)?;
                let global = apply::get_registered_binding(db, &id, "global")
                    .map_err(commands::native_error)?;
                tools.push((id, adapter.name().to_owned(), profiles, global));
            }
            Ok((tools, recent, project_mode))
        })
        .map_err(|error| error.message)?;
    let (tools, recent, project_mode) = data;

    if !tools.is_empty() {
        menu.append(&separator(app)?).map_err(|error| error.to_string())?;
        menu.append(&section_label(app, "全局配置")?)
            .map_err(|error| error.to_string())?;
        for (tool, name, profiles, global) in &tools {
            let submenu = profile_submenu(
                app,
                &mut actions,
                &mut counter,
                generation,
                ProfileTarget { tool, name, profiles, binding: global.as_ref(), project: None },
            )?;
            menu.append(&submenu).map_err(|error| error.to_string())?;
        }
    }

    let shown: Vec<_> = recent.iter().take(RECENT_PROJECT_LIMIT).collect();
    if !shown.is_empty() {
        menu.append(&separator(app)?).map_err(|error| error.to_string())?;
        menu.append(&section_label(app, recent_section_title(project_mode))?)
            .map_err(|error| error.to_string())?;
    }
    for project in shown {
        let tool = project
            .preferred_tool
            .as_ref()
            .filter(|id| tools.iter().any(|entry| &entry.0 == *id));
        let yolo = tool.is_some_and(|id| {
            registry.get(id).is_some_and(|adapter| adapter.launch_args(None, LaunchMode::Yolo).is_ok())
        });
        let mode = if project_mode == LaunchMode::Yolo && yolo { LaunchMode::Yolo } else { LaunchMode::Normal };
        let action = recent_action(&project.id, tool.map(String::as_str), project.available, mode);
        if !project.available {
            menu.append(&register_action(
                app,
                &mut actions,
                &mut counter,
                generation,
                action,
                &format!("{} · 目录需重关联", project.name),
                true,
            )?)
            .map_err(|error| error.to_string())?;
            continue;
        }
        let submenu = Submenu::new(app, &project.name, true).map_err(|error| error.to_string())?;
        let tool_name = tool.and_then(|id| tools.iter().find(|entry| &entry.0 == id)).map(|entry| entry.1.as_str());
        submenu
            .append(&register_action(
                app,
                &mut actions,
                &mut counter,
                generation,
                action,
                &launch_label(tool_name, project_mode, mode),
                true,
            )?)
            .map_err(|error| error.to_string())?;
        if !tools.is_empty() {
            submenu.append(&separator(app)?).map_err(|error| error.to_string())?;
            submenu
                .append(&section_label(app, "项目配置")?)
                .map_err(|error| error.to_string())?;
        }
        let key = format!("project:{}", project.path.as_deref().unwrap_or_default());
        for (tool, name, profiles, _) in &tools {
            let binding = app
                .state::<AppState>()
                .with_database(app, |db| {
                    apply::get_registered_binding(db, tool, &key).map_err(commands::native_error)
                })
                .map_err(|error| error.message)?;
            let pending = project.selected_profiles.get(tool).map(String::as_str);
            let nested = profile_submenu(
                app,
                &mut actions,
                &mut counter,
                generation,
                ProfileTarget {
                    tool,
                    name,
                    profiles,
                    binding: binding.as_ref(),
                    project: Some((&project.id, pending)),
                },
            )?;
            submenu.append(&nested).map_err(|error| error.to_string())?;
        }
        menu.append(&submenu).map_err(|error| error.to_string())?;
    }

    menu.append(&separator(app)?).map_err(|error| error.to_string())?;
    menu.append(&register_action(
        app,
        &mut actions,
        &mut counter,
        generation,
        Action::Quit,
        "完全退出栖点",
        true,
    )?)
    .map_err(|error| error.to_string())?;
    let icon = state
        .icon
        .lock()
        .map_err(|_| "托盘状态暂不可用".to_owned())?;
    icon.as_ref()
        .ok_or("托盘图标暂不可用")?
        .set_menu(Some(menu))
        .map_err(|error| error.to_string())?;
    *state
        .actions
        .lock()
        .map_err(|_| "托盘操作暂不可用".to_owned())? = actions;
    if let Ok(mut error) = state.error.lock() {
        *error = None;
    }
    Ok(())
}

const RECENT_PROJECT_LIMIT: usize = 5;

fn recent_section_title(mode: LaunchMode) -> &'static str {
    if mode == LaunchMode::Yolo { "最近项目 · YOLO 启动" } else { "最近项目 · 普通启动" }
}

/// First entry of a project submenu. A missing tool opens the project card so
/// the user can pick one; a YOLO preference the CLI cannot honour is spelled out.
fn launch_label(tool_name: Option<&str>, preferred: LaunchMode, mode: LaunchMode) -> String {
    match tool_name {
        None => "选择启动工具…".into(),
        Some(name) if preferred == LaunchMode::Yolo && mode == LaunchMode::Normal => {
            format!("启动 {name} · 普通模式")
        }
        Some(name) => format!("启动 {name}"),
    }
}

struct ProfileTarget<'a> {
    tool: &'a str,
    name: &'a str,
    profiles: &'a [profile::RegisteredProfile],
    binding: Option<&'a apply::AppliedBinding>,
    /// Project id and the profile the project card last selected for this tool.
    project: Option<(&'a str, Option<&'a str>)>,
}

/// `Codex · 日常开发 ▸` with one checkable row per saved profile. The title
/// shows the applied profile so the current state is readable without opening it.
fn profile_submenu(
    app: &AppHandle,
    actions: &mut HashMap<String, Action>,
    counter: &mut usize,
    generation: u64,
    target: ProfileTarget<'_>,
) -> Result<Submenu<tauri::Wry>, String> {
    let title = format!("{} · {}", target.name, applied_label(target.profiles, target.binding));
    let submenu = Submenu::new(app, &title, true).map_err(|error| error.to_string())?;
    if target.profiles.is_empty() {
        submenu
            .append(&section_label(app, "还没有保存的配置")?)
            .map_err(|error| error.to_string())?;
    }
    for profile in target.profiles {
        let pending = target
            .project
            .and_then(|(_, selected)| selected)
            .is_some_and(|selected| selected == profile.id)
            && target.binding.is_none_or(|active| active.profile_id != profile.id);
        let checked = target.binding.is_some_and(|active| active.profile_id == profile.id);
        let item = register_check_action(
            app,
            actions,
            counter,
            generation,
            Action::Switch {
                tool: target.tool.to_owned(),
                profile: profile.id.clone(),
                project: target.project.map(|(id, _)| id.to_owned()),
            },
            &profile_state_label(profile, target.binding, pending),
            checked,
        )?;
        submenu.append(&item).map_err(|error| error.to_string())?;
    }
    Ok(submenu)
}

fn on_menu(app: &AppHandle, id: &str) {
    if id == "show" {
        show_main(app);
        return;
    }
    if id == "quit" {
        app.exit(0);
        return;
    }
    let action = app
        .state::<TrayState>()
        .actions
        .lock()
        .ok()
        .and_then(|items| items.get(id).cloned());
    let Some(action) = action else {
        return;
    };
    match action {
        Action::Show => show_main(app),
        Action::Quit => app.exit(0),
        Action::RepairProject { project } => {
            show_main(app);
            let _ = app.emit("cliora:tray-repair", RepairTarget::project(project));
        }
        Action::Switch {
            tool,
            profile,
            project,
        } => {
            let app = app.clone();
            std::thread::spawn(move || {
                let project_id = project.clone();
                let scope = if project.is_some() {
                    Scope::Project
                } else {
                    Scope::Global
                };
                let path = project
                    .as_deref()
                    .map(|id| {
                        app.state::<AppState>().with_database(&app, |db| {
                            projects::get(db, id).map_err(commands::native_error)
                        })
                    })
                    .transpose();
                let path = match path {
                    Ok(Some(project)) if project.available => project.path,
                    Ok(None) => None,
                    _ => {
                        let _ = refresh(&app);
                        report_error(
                            &app,
                            "项目目录已移动，请重新关联".into(),
                            project_id.map(RepairTarget::project),
                        );
                        return;
                    }
                };
                let repair = RepairTarget::connection(
                    tool.clone(),
                    scope,
                    project_id,
                    path.clone(),
                    Some(profile.clone()),
                );
                if let Err(error) =
                    commands::apply_registered_now(&app, &tool, &profile, scope, path, false)
                {
                    // Native check items toggle on click; rebuild so the menu shows the real state.
                    let _ = refresh(&app);
                    report_error(&app, error.message, Some(repair));
                    return;
                }
                if let Err(error) = refresh(&app) {
                    report_error(&app, error, None);
                }
            });
        }
        Action::Launch { tool, project, mode } => {
            let app = app.clone();
            std::thread::spawn(move || {
                let request = LaunchRequest {
                    tool_id: tool.clone(),
                    project_id: Some(project.clone()),
                    session_id: None,
                    directory: None,
                    initial_prompt: None,
                    mode,
                    resume_latest: false,
                };
                if let Err(failure) = commands::launch_now_with_stage(&app, request) {
                    let repair = RepairTarget::for_launch_failure(&tool, &project, &failure);
                    report_error(&app, failure.error.message, Some(repair));
                } else if let Err(error) = refresh(&app) {
                    report_error(&app, error, None);
                }
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn saved_profile(version: u64) -> profile::RegisteredProfile {
        profile::RegisteredProfile {
            editing: None,
            revision: String::new(),
            id: "daily".into(),
            tool: "grok".into(),
            name: "日常".into(),
            version,
            inherit_common: false,
            files: BTreeMap::new(),
            suppressed: BTreeMap::new(),
            connection: None,
            authentication: crate::native::profile::ProfileAuthentication::Native,
            native_credentials: BTreeMap::new(),
        }
    }

    fn old_binding() -> apply::AppliedBinding {
        apply::AppliedBinding {
            context_id: None,
            scope_key: "global".into(),
            tool: "grok".into(),
            profile_id: "daily".into(),
            profile_version: 1,
            managed: BTreeMap::new(),
            common_version: None,
            common_revision: None,
            applied_profile: None,
            applied_profile_available: false,
            applied_summary: None,
        }
    }

    #[test]
    fn saved_new_version_does_not_erase_the_applied_old_version_in_global_or_project_menu() {
        let profile = saved_profile(2);
        let binding = old_binding();
        assert_eq!(
            applied_label(&[profile.clone()], Some(&binding)),
            "日常 · 有未应用修改（已应用 v1）"
        );
        assert_eq!(
            profile_state_label(&profile, Some(&binding), false),
            "日常 · 有未应用修改（已应用 v1）"
        );
        assert_eq!(
            profile_state_label(&profile, Some(&binding), true),
            "日常 · 有未应用修改（已应用 v1）"
        );
        assert_eq!(
            profile_state_label(&profile, None, true),
            "日常 · 待重新应用"
        );
        assert_eq!(applied_label(&[saved_profile(1)], Some(&binding)), "日常");
    }

    #[test]
    fn project_launch_row_names_the_tool_and_a_downgraded_mode() {
        assert_eq!(launch_label(Some("Codex"), LaunchMode::Normal, LaunchMode::Normal), "启动 Codex");
        assert_eq!(launch_label(Some("Codex"), LaunchMode::Yolo, LaunchMode::Yolo), "启动 Codex");
        assert_eq!(launch_label(Some("Pi"), LaunchMode::Yolo, LaunchMode::Normal), "启动 Pi · 普通模式");
        assert_eq!(launch_label(None, LaunchMode::Normal, LaunchMode::Normal), "选择启动工具…");
        assert_eq!(recent_section_title(LaunchMode::Yolo), "最近项目 · YOLO 启动");
        assert_eq!(recent_section_title(LaunchMode::Normal), "最近项目 · 普通启动");
    }

    #[test]
    fn invalid_recent_project_opens_repair_instead_of_disabled_launch() {
        assert!(
            matches!(recent_action("project-1", Some("grok"), false, LaunchMode::Normal), Action::RepairProject { project } if project == "project-1")
        );
        assert!(
            matches!(recent_action("project-1", None, true, LaunchMode::Yolo), Action::RepairProject { project } if project == "project-1")
        );
        assert!(
            matches!(recent_action("project-1", Some("grok"), true, LaunchMode::Yolo), Action::Launch { tool, project, mode } if tool == "grok" && project == "project-1" && mode == LaunchMode::Yolo)
        );
        let target = RepairTarget::connection(
            "grok".into(),
            Scope::Project,
            Some("project-1".into()),
            Some("C:\\项目".into()),
            Some("daily".into()),
        );
        let json = serde_json::to_value(target).unwrap();
        assert_eq!(json["page"], "connections");
        assert_eq!(json["toolId"], "grok");
        assert_eq!(json["scope"], "project");
        assert_eq!(json["projectId"], "project-1");
        assert_eq!(json["projectPath"], "C:\\项目");
        assert_eq!(json["profileId"], "daily");
    }

    #[test]
    fn launch_failure_routes_to_the_matching_repair_stage() {
        let failure = |stage, path: Option<&str>, profile: Option<&str>| commands::LaunchFailure {
            error: commands::native_error("failed".into()),
            stage,
            project_path: path.map(str::to_owned),
            profile_id: profile.map(str::to_owned),
        };
        let project = "project-1";
        let config = RepairTarget::for_launch_failure(
            "grok",
            project,
            &failure(LaunchStage::Configuration, Some("C:\\项目"), Some("daily")),
        );
        let config = serde_json::to_value(config).unwrap();
        assert_eq!(config["page"], "connections");
        assert_eq!(config["scope"], "project");
        assert_eq!(config["projectPath"], "C:\\项目");
        assert_eq!(config["profileId"], "daily");
        assert_eq!(config["projectId"], project);
        assert!(config["resourceView"].is_null());

        let skills = serde_json::to_value(RepairTarget::for_launch_failure(
            "grok",
            project,
            &failure(LaunchStage::Skills, Some("C:\\项目"), None),
        ))
        .unwrap();
        assert_eq!(skills["page"], "connections");
        assert_eq!(skills["resourceView"], "skills");
        assert_eq!(skills["projectPath"], "C:\\项目");

        let directory = serde_json::to_value(RepairTarget::for_launch_failure(
            "grok",
            project,
            &failure(LaunchStage::ProjectDirectory, None, None),
        ))
        .unwrap();
        assert_eq!(directory["page"], "home");
        assert_eq!(directory["projectId"], project);

        let terminal = serde_json::to_value(RepairTarget::for_launch_failure(
            "grok",
            project,
            &failure(LaunchStage::Terminal, None, None),
        ))
        .unwrap();
        assert_eq!(terminal["page"], "settings");

        let tool = serde_json::to_value(RepairTarget::for_launch_failure(
            "grok",
            project,
            &failure(LaunchStage::Tool, Some("C:\\项目"), None),
        ))
        .unwrap();
        assert_eq!(tool["page"], "connections");
        assert_eq!(tool["profileId"], serde_json::Value::Null);
    }
}
