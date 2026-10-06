pub mod adapters;
mod path_policy {
    use std::fs;
    use std::path::{Component, Path};

    /// macOS publishes `/var`, `/tmp`, and `/etc` as symlinks into `/private`.
    /// Those three root aliases are operating-system directories, so ancestor
    /// checks may cross them. A symlink anywhere else stays rejected.
    pub fn is_platform_directory_alias(path: &Path) -> bool {
        if path.parent() != Some(Path::new("/")) {
            return false;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            return false;
        };
        if !matches!(name, "var" | "tmp" | "etc") {
            return false;
        }
        let Ok(metadata) = fs::symlink_metadata(path) else {
            return false;
        };
        if !metadata.file_type().is_symlink() {
            return false;
        }
        let Ok(target) = fs::read_link(path) else {
            return false;
        };
        let parts: Vec<String> = target
            .components()
            .filter_map(|component| match component {
                Component::RootDir | Component::CurDir => None,
                Component::Normal(part) => part.to_str().map(str::to_owned),
                _ => Some(String::new()),
            })
            .collect();
        parts == ["private".to_owned(), name.to_owned()]
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[cfg(target_os = "macos")]
        #[test]
        fn macos_root_aliases_point_at_private_directories() {
            for path in ["/var", "/tmp", "/etc"] {
                assert!(
                    is_platform_directory_alias(Path::new(path)),
                    "{path} -> {:?}",
                    fs::read_link(path)
                );
            }
        }

        #[cfg(unix)]
        #[test]
        fn a_symlink_inside_the_managed_tree_is_not_a_platform_alias() {
            let temp = tempfile::tempdir().unwrap();
            let real = temp.path().join("real");
            fs::create_dir(&real).unwrap();
            let link = temp.path().join("link");
            std::os::unix::fs::symlink(&real, &link).unwrap();
            assert!(!is_platform_directory_alias(&link));
            let error = crate::accounts::context::check_path(&link).unwrap_err();
            assert_eq!(error, "账号目录不可包含符号链接");
        }

        #[cfg(target_os = "macos")]
        #[test]
        fn a_temp_directory_under_the_var_alias_can_be_checked() {
            let temp = tempfile::tempdir().unwrap();
            crate::accounts::context::check_path(temp.path()).unwrap();
        }
    }
}
mod external;
mod background_process;
mod process_environment;
mod windows_registry;
#[cfg(windows)]
mod windows_security;
#[cfg(all(test, target_os = "macos"))]
#[path = "../../tests/platform/macos.rs"]
mod macos_tests;
pub mod commands;
pub mod accounts;
pub mod credentials;
pub mod database;
pub mod domain;
pub mod history;
pub mod launch;
pub mod library;
pub mod native;
pub mod portable;
pub mod projects;
pub mod resources;
pub mod tray;
pub mod usage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            tray::show_main(app)
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
        .setup(|app| {
            use tauri::{Listener, Manager};
            // The window must remain available when local storage needs repair.
            app.manage(commands::AppState::default());
            tray::setup(app);
            let usage_handle = app.handle().clone();
            std::thread::spawn(move || loop {
                let _ = commands::usage_background_tick(&usage_handle);
                std::thread::sleep(std::time::Duration::from_secs(5));
            });
            let sync_handle = app.handle().clone();
            std::thread::spawn(move || loop {
                let _ = commands::sync_background_tick(&sync_handle);
                std::thread::sleep(std::time::Duration::from_secs(60));
            });
            let handle = app.handle().clone();
            app.listen("cliora:bindings-changed", move |_| {
                let handle = handle.clone();
                std::thread::spawn(move || {
                    let _ = tray::refresh(&handle);
                });
            });
            let handle = app.handle().clone();
            app.listen("cliora:projects-changed", move |_| {
                let handle = handle.clone();
                std::thread::spawn(move || {
                    let _ = tray::refresh(&handle);
                });
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            use tauri::{Emitter, Manager};
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let status = window.app_handle().state::<tray::TrayState>().status();
                if status.available {
                    if let Err(error) = window.hide() {
                        let _ = window.show();
                        let _ = window.app_handle().emit(
                            "cliora:tray-error",
                            format!("无法将窗口留在托盘，主窗口保持打开：{error}"),
                        );
                    }
                } else {
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = window.app_handle().emit(
                        "cliora:tray-error",
                        status.error.unwrap_or_else(|| {
                            "托盘宿主不可用；主窗口保持打开，可在设置中完全退出".into()
                        }),
                    );
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::account_capabilities,
            commands::discover_native_logins,
            commands::adopt_native_codex_account,
            commands::adopt_native_account,
            commands::list_accounts,
            commands::account_impact,
            commands::create_account,
            commands::rename_account,
            commands::delete_account,
            commands::open_account_login_link,
            commands::start_account_login,
            commands::cancel_account_login,
            commands::check_account,
            commands::logout_account,
            commands::usage_presets,
            commands::ensure_profile_usage,
            commands::usage_builtin_script,
            commands::list_usage_cache,
            commands::refresh_usage_query,
            commands::cancel_usage_refresh,
            commands::list_usage_queries,
            commands::create_usage_test,
            commands::cancel_usage_test,
            commands::test_usage_query,
            commands::get_usage_query,
            commands::save_usage_query,
            commands::delete_usage_query,
            commands::merge_registered_native_edits,
            commands::list_portable_items,
            commands::export_portable_bundle,
            commands::preview_portable_bundle,
            commands::apply_portable_bundle,
            commands::cancel_portable_preview,
            commands::get_webdav_status,
            commands::configure_webdav,
            commands::set_webdav_enabled,
            commands::sync_webdav_now,
            commands::resolve_webdav_conflict,
            commands::preview_webdav_conflict,
            commands::refresh_history,
            commands::cancel_history_refresh,
            commands::get_history_scan_progress,
            commands::list_history_sessions,
            commands::get_history_session,
            commands::set_history_favorite,
            commands::set_history_project,
            commands::get_usage_report,
            commands::list_history_prices,
            commands::save_history_price,
            commands::copy_history_resume_command,
            commands::resume_history_session,
            commands::export_history_session,
            commands::list_library_items,
            commands::save_library_item,
            commands::delete_library_item,
            commands::list_mcp_definitions,
            commands::save_mcp_definition,
            commands::delete_mcp_definition,
            commands::remove_native_mcp,
            commands::list_native_mcp,
            commands::list_mcp_placements,
            commands::scan_native_agents,
            commands::operate_native_agent,
            commands::scan_native_plugins,
            commands::preview_native_plugins,
            commands::operate_native_plugin,
            commands::get_managed_mcp_enabled,
            commands::preview_mcp_targets,
            commands::distribute_mcp,
            commands::preview_rule_targets,
            commands::apply_rule_targets,
            commands::list_rule_placements,
            commands::sync_rule_clients,
            commands::set_skill_in_library,
            commands::list_skill_packages,
            commands::preview_skill_local,
            commands::import_skill_local,
            commands::preview_skill_https_zip,
            commands::import_skill_https_zip,
            commands::list_skill_zip_entries,
            commands::preview_skill_local_zip,
            commands::import_skill_local_zip,
            commands::list_skill_installations,
            commands::list_skill_recovery_issues,
            commands::scan_native_skills,
            commands::preview_skill_target,
            commands::install_skill,
            commands::remove_skill,
            commands::delete_skill_package,
            commands::get_bootstrap,
            commands::list_cli_adapters,
            commands::open_external_url,
            commands::list_projects,
            commands::add_project,
            commands::relink_project,
            commands::rename_project,
            commands::remove_project,
            commands::open_project_directory,
            commands::set_project_tool,
            commands::set_project_model_override,
            commands::get_launch_settings,
            commands::set_preferred_terminal,
            commands::set_custom_terminal,
            commands::set_default_launch_mode,
            commands::launch_cli,
            commands::cli_latest_version,
            commands::maintain_registered_cli,
            commands::get_tray_status,
            commands::quit_app,
            commands::set_registered_managed_tools,
            commands::get_registered_tool_workspace,
            commands::set_registered_custom_cli_path,
            commands::save_registered_native_profile,
            commands::compare_configuration_current,
            commands::rebase_configuration_current,
            commands::preview_configuration_backup,
            commands::restore_configuration_backup,
            commands::begin_configuration_draft,
            commands::update_configuration_draft,
            commands::select_configuration_credential,
            commands::set_configuration_draft_secret,
            commands::remove_configuration_draft_secret,
            commands::reveal_configuration_draft_secret,
            commands::cancel_configuration_draft,
            commands::cancel_configuration_requests,
            commands::add_configuration_models,
            commands::list_configuration_models,
            commands::check_configuration_connection,
            commands::save_configuration_draft,
            commands::common_influence,
            commands::apply_common_configuration,
            commands::describe_configuration,
            commands::open_configuration_draft,
            commands::edit_configuration_draft,
            commands::replace_configuration_text,
            commands::save_registered_common_config,
            commands::apply_registered_native_profile,
            commands::reapply_account_profile,
            commands::compare_registered_application,
            commands::apply_compared_application,
            commands::inspect_registered_native_draft,
            commands::prepare_registered_native_import,
            commands::prepare_registered_native_import_from_disk,
            commands::read_registered_native_file_for_edit,
            commands::save_registered_native_file,
            commands::list_native_backups,
            commands::preview_native_backup,
            commands::restore_native_backup,
            commands::preview_registered_native_profile,
            commands::list_preserved_profiles,
            commands::set_managed_tools,
            commands::set_theme,
            commands::set_tool_icon,
            commands::get_tool_workspace,
            commands::set_custom_cli_path,
            commands::save_native_profile,
            commands::delete_native_profile,
            commands::save_common_config,
            commands::apply_native_profile,
            commands::recover_native_transactions,
            commands::set_connection_secret,
            commands::get_connection_secret,
            commands::launch_cli_login,
            commands::read_native_rule,
            commands::get_skill_enabled,
            commands::set_skill_enabled,
            commands::get_native_rule_enabled,
            commands::set_native_rule_enabled,
            commands::save_native_rule,
            commands::list_provider_models,
            commands::test_provider_connection,
            commands::test_registered_provider_connection,
            commands::inspect_native_draft,
            commands::prepare_native_import,
            commands::prepare_native_import_from_disk,
            commands::read_native_file_for_edit,
            commands::set_codex_reasoning_effort,
            commands::preview_native_profile
        ])
        .build(tauri::generate_context!())
        .expect("failed to run Cliora")
        .run(handle_run_event);
}

/// Dock click on macOS. A hidden main window stays hidden unless we show it.
fn handle_run_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    #[cfg(target_os = "macos")]
    if let tauri::RunEvent::Reopen {
        has_visible_windows: false,
        ..
    } = event
    {
        tray::show_main(app);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, event);
}
