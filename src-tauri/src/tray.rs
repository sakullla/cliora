use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::menu::{Menu, MenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::{self, AppState};
use crate::launch::LaunchRequest;
use crate::native::adapter::Scope;
use crate::native::adapters::{LaunchMode, Registry};
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
    },
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

fn report_error(app: &AppHandle, message: String) {
    app.state::<TrayState>().set_error(message.clone());
    let _ = app.emit("cliora:tray-error", message);
    show_main(app);
}

fn simple_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, String> {
    let menu = Menu::new(app).map_err(|error| error.to_string())?;
    let root = Submenu::new(app, "栖点", true).map_err(|error| error.to_string())?;
    root.append(
        &MenuItem::with_id(app, "show", "显示栖点", true, None::<&str>)
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    root.append(
        &MenuItem::with_id(app, "quit", "完全退出", true, None::<&str>)
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    menu.append(&root).map_err(|error| error.to_string())?;
    Ok(menu)
}

pub fn setup(app: &mut tauri::App) {
    let handle = app.handle().clone();
    let state = TrayState::default();
    app.manage(state);
    let icon = app.default_window_icon().cloned();
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
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| on_menu(app, event.id.as_ref()))
        .on_tray_icon_event(|tray, event| {
            if matches!(
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
    let root = Submenu::new(app, "栖点", true).map_err(|error| error.to_string())?;
    root.append(&register_action(
        app,
        &mut actions,
        &mut counter,
        generation,
        Action::Show,
        "显示主窗口",
        true,
    )?)
    .map_err(|error| error.to_string())?;
    menu.append(&root).map_err(|error| error.to_string())?;

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
            Ok((tools, recent))
        })
        .map_err(|error| error.message)?;
    let (tools, recent) = data;
    for (tool, name, profiles, global) in &tools {
        let submenu = Submenu::new(app, name, true).map_err(|error| error.to_string())?;
        let global_name = global
            .as_ref()
            .and_then(|binding| {
                profiles.iter().find(|item| {
                    item.id == binding.profile_id && item.version == binding.profile_version
                })
            })
            .map(|profile| profile.name.as_str())
            .unwrap_or("未选择");
        submenu
            .append(&new_item(
                app,
                &format!("current-{tool}"),
                &format!("全局 · {global_name}"),
                false,
            )?)
            .map_err(|error| error.to_string())?;
        for profile in profiles {
            let chosen = global.as_ref().is_some_and(|binding| {
                binding.profile_id == profile.id && binding.profile_version == profile.version
            });
            submenu
                .append(&register_action(
                    app,
                    &mut actions,
                    &mut counter,
                    generation,
                    Action::Switch {
                        tool: tool.clone(),
                        profile: profile.id.clone(),
                        project: None,
                    },
                    &format!("{}{}", if chosen { "✓ " } else { "" }, profile.name),
                    true,
                )?)
                .map_err(|error| error.to_string())?;
        }
        for project in recent.iter().filter(|project| project.available).take(5) {
            let key = format!("project:{}", project.path.as_deref().unwrap_or_default());
            let binding = app
                .state::<AppState>()
                .with_database(app, |db| {
                    apply::get_registered_binding(db, tool, &key).map_err(commands::native_error)
                })
                .map_err(|error| error.message)?;
            for profile in profiles {
                let chosen = binding.as_ref().is_some_and(|active| {
                    active.profile_id == profile.id && active.profile_version == profile.version
                });
                let pending = !chosen
                    && project
                        .selected_profiles
                        .get(tool)
                        .is_some_and(|id| id == &profile.id);
                submenu
                    .append(&register_action(
                        app,
                        &mut actions,
                        &mut counter,
                        generation,
                        Action::Switch {
                            tool: tool.clone(),
                            profile: profile.id.clone(),
                            project: Some(project.id.clone()),
                        },
                        &format!(
                            "{}{} · {} · 项目{}",
                            if chosen { "✓ " } else { "" },
                            project.name,
                            profile.name,
                            if pending { " · 待重新应用" } else { "" }
                        ),
                        true,
                    )?)
                    .map_err(|error| error.to_string())?;
            }
        }
        menu.append(&submenu).map_err(|error| error.to_string())?;
    }
    let recent_menu = Submenu::new(app, "最近项目 · 普通启动", !recent.is_empty())
        .map_err(|error| error.to_string())?;
    for project in recent.iter().take(8) {
        let tool = project
            .preferred_tool
            .as_ref()
            .filter(|id| tools.iter().any(|entry| &entry.0 == *id));
        let enabled = project.available && tool.is_some();
        let label = if !project.available {
            format!("{} · 目录需重关联", project.name)
        } else if tool.is_none() {
            format!("{} · 请在主窗口选择工具", project.name)
        } else {
            let name = tools
                .iter()
                .find(|entry| &entry.0 == tool.unwrap())
                .map(|entry| entry.1.as_str())
                .unwrap_or("");
            format!("{} · {}", project.name, name)
        };
        let action = Action::Launch {
            tool: tool.cloned().unwrap_or_default(),
            project: project.id.clone(),
        };
        recent_menu
            .append(&register_action(
                app,
                &mut actions,
                &mut counter,
                generation,
                action,
                &label,
                enabled,
            )?)
            .map_err(|error| error.to_string())?;
    }
    menu.append(&recent_menu)
        .map_err(|error| error.to_string())?;
    let exit = Submenu::new(app, "窗口与退出", true).map_err(|error| error.to_string())?;
    exit.append(&register_action(
        app,
        &mut actions,
        &mut counter,
        generation,
        Action::Quit,
        "完全退出栖点",
        true,
    )?)
    .map_err(|error| error.to_string())?;
    menu.append(&exit).map_err(|error| error.to_string())?;
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
        Action::Switch {
            tool,
            profile,
            project,
        } => {
            let app = app.clone();
            std::thread::spawn(move || {
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
                        report_error(&app, "项目目录已移动，请在主窗口重新关联".into());
                        return;
                    }
                };
                if let Err(error) =
                    commands::apply_registered_now(&app, &tool, &profile, scope, path, false)
                {
                    report_error(&app, error.message);
                    return;
                }
                if let Err(error) = refresh(&app) {
                    report_error(&app, error);
                }
            });
        }
        Action::Launch { tool, project } => {
            let app = app.clone();
            std::thread::spawn(move || {
                let request = LaunchRequest {
                    tool_id: tool,
                    project_id: Some(project),
                    session_id: None,
                    mode: LaunchMode::Normal,
                };
                if let Err(error) = commands::launch_now(&app, request) {
                    report_error(&app, error.message);
                } else if let Err(error) = refresh(&app) {
                    report_error(&app, error);
                }
            });
        }
    }
}
