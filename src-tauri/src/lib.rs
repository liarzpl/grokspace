mod db;
mod error;
mod project;

use std::sync::Mutex;

use rusqlite::Connection;

/// Shared handle to the workspace database. Phase 1 will add the PTY manager
/// alongside it.
pub struct AppState {
    pub db: Mutex<Connection>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let connection =
        db::open_default().expect("failed to open the GrokSpace database in ~/.grokspace");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            db: Mutex::new(connection),
        })
        .invoke_handler(tauri::generate_handler![
            project::list_projects,
            project::open_project,
            project::update_project,
            project::touch_project,
            project::remove_project,
        ])
        .run(tauri::generate_context!())
        .expect("error while running GrokSpace");
}
