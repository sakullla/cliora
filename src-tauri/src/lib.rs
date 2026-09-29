pub mod commands;
pub mod credentials;
pub mod database;
pub mod domain;
pub mod native;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            use tauri::Manager;
            // The window must remain available when local storage needs repair.
            app.manage(commands::AppState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_bootstrap,
            commands::set_managed_tools,
            commands::set_theme,
            commands::get_tool_workspace,
            commands::set_custom_cli_path,
            commands::save_native_profile,
            commands::delete_native_profile,
            commands::save_common_config,
            commands::apply_native_profile,
            commands::recover_native_transactions,
            commands::set_connection_secret,
            commands::list_provider_models,
            commands::test_provider_connection,
            commands::inspect_native_draft,
            commands::set_codex_reasoning_effort,
            commands::preview_native_profile
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Cliora");
}
