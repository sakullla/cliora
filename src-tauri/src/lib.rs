pub mod commands;
pub mod credentials;
pub mod database;
pub mod domain;

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
            commands::set_theme
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Cliora");
}
