pub mod commands;
pub mod credentials;
pub mod database;
pub mod domain;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let directory = app.path().app_data_dir()?;
            std::fs::create_dir_all(&directory)?;
            let database = database::Database::open(&directory.join("cliora.db"))?;
            app.manage(commands::AppState { database });
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
