mod db;
mod error;
mod project;
mod pty;
mod session;

use std::sync::Mutex;

use rusqlite::Connection;
use tauri::{Manager, RunEvent};

use crate::pty::PtyManager;

/// Shared handles for the workspace: its database and its live terminals.
pub struct AppState {
    pub db: Mutex<Connection>,
    pub pty: PtyManager,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let connection =
        db::open_default().expect("failed to open the GrokSpace database in ~/.grokspace");

    // Terminal children do not survive the app, so anything the database still
    // believes is running is left over from the previous run.
    if let Err(error) = session::reconcile_on_start(&connection) {
        eprintln!("could not reconcile sessions from the previous run: {error}");
    }

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            db: Mutex::new(connection),
            pty: PtyManager::new(),
        })
        .invoke_handler(tauri::generate_handler![
            project::list_projects,
            project::open_project,
            project::update_project,
            project::touch_project,
            project::remove_project,
            session::list_sessions,
            session::create_session,
            session::attach_session,
            session::write_session,
            session::resize_session,
            session::stop_session,
            session::restart_session,
            session::rename_session,
            session::close_session,
        ])
        .build(tauri::generate_context!())
        .expect("error while starting GrokSpace");

    app.run(|app, event| {
        if matches!(event, RunEvent::Exit) {
            app.state::<AppState>().pty.shutdown();
        }
    });
}
