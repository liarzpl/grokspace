mod acp;
mod db;
mod diff;
#[cfg(test)]
mod domain;
mod edges;
mod error;
mod graph;
mod handoff;
mod hooks;
mod ledger;
mod log;
mod memory;
mod permission_heat;
mod playbook;
mod policy;
mod program;
mod project;
mod pty;
mod session;
mod settings;
mod skill;
mod snooze;
mod steps;
mod task;
mod user_skill;
mod watch;
mod worktree;

#[cfg(test)]
mod command_tests;

#[cfg(test)]
mod e2e_smoke;

#[cfg(test)]
mod ipc_fixtures;

#[cfg(test)]
thread_local! {
    pub(crate) static TEST_LAUNCH_PROGRAM: std::cell::RefCell<Option<String>> =
        const { std::cell::RefCell::new(None) };
}

use std::sync::Mutex;

use rusqlite::Connection;
use tauri::{Manager, RunEvent};

use crate::acp::AcpManager;
use crate::error::{Error, Result};
use crate::graph::GraphWatchers;
use crate::pty::PtyManager;
use crate::steps::StepWatchers;

/// Shared handles for the workspace: its database, its live terminals, the agents
/// it drives over ACP, and the watchers that report graph and step files changing
/// under each project.
pub struct AppState {
    pub db: Mutex<Connection>,
    pub pty: PtyManager,
    pub acp: AcpManager,
    pub graphs: GraphWatchers,
    pub steps: StepWatchers,
    pub folder_trust: Mutex<project::FolderTrustSession>,
}

impl AppState {
    /// Runs `run` with the database lock held. Poison becomes `StatePoisoned`.
    pub fn with_db<T>(&self, run: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let conn = self.db.lock().map_err(|_| Error::StatePoisoned)?;
        run(&conn)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Before the database: a failed open still has somewhere to land.
    log::init();

    let connection =
        db::open_default().expect("failed to open the GrokSpace database in ~/.grokspace");

    // Terminal children do not survive the app, so anything the database still
    // believes is running is left over from the previous run.
    if let Err(error) = session::reconcile_on_start(&connection) {
        log::error(
            "startup",
            &format!("could not reconcile sessions from the previous run: {error}"),
        );
    }

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            db: Mutex::new(connection),
            pty: PtyManager::new(),
            acp: AcpManager::new(),
            graphs: GraphWatchers::new(),
            steps: StepWatchers::new(),
            folder_trust: Mutex::new(project::FolderTrustSession::default()),
        })
        .invoke_handler(tauri::generate_handler![
            log::log_client_error,
            project::list_projects,
            project::open_project,
            project::update_project,
            project::touch_project,
            project::remove_project,
            project::project_trust,
            project::set_project_trust,
            hooks::project_hooks_status,
            session::list_sessions,
            session::create_session,
            session::attach_session,
            session::write_session,
            session::resize_session,
            session::stop_session,
            session::restart_session,
            session::rename_session,
            session::close_session,
            session::discard_session_worktree,
            session::merge_session_worktree,
            session::session_merge_readiness,
            session::preview_worktree_gc,
            session::gc_orphan_worktrees,
            session::prompt_session,
            session::cancel_session,
            session::answer_session_permission,
            memory::list_memory,
            memory::put_memory,
            memory::remove_memory,
            memory::memory_file_path,
            skill::skill_status,
            skill::install_skill,
            user_skill::save_user_skill,
            task::list_tasks,
            task::create_task,
            task::update_task,
            task::dispatch_task,
            task::undispatch_task,
            task::remove_task,
            diff::project_diff,
            diff::file_diff,
            diff::reveal_artifact,
            handoff::export_session_pack,
            settings::read_settings,
            settings::write_setting,
            policy::read_permission_policy,
            policy::write_permission_policy,
            ledger::list_permission_ledger,
            playbook::save_playbook,
            playbook::read_playbook,
            snooze::read_inbox_snooze,
            snooze::write_inbox_snooze,
            graph::read_session_graph,
            graph::list_session_graphs,
            graph::watch_project_graphs,
            permission_heat::read_session_permission_heat,
            edges::read_project_edges,
            steps::list_session_steps,
            steps::list_project_steps,
            steps::add_session_step,
            steps::update_session_step,
            steps::remove_session_step,
            steps::reorder_session_steps,
            steps::approve_session_steps,
            steps::reopen_session_steps,
            steps::watch_project_steps,
        ])
        .build(tauri::generate_context!())
        .expect("error while starting GrokSpace");

    app.run(|app, event| {
        if matches!(event, RunEvent::Exit) {
            let state = app.state::<AppState>();
            state.pty.shutdown();
            state.acp.shutdown();
            state.graphs.shutdown();
            state.steps.shutdown();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> AppState {
        AppState {
            db: Mutex::new(db::open_in_memory().expect("in-memory database should open")),
            pty: PtyManager::new(),
            acp: AcpManager::new(),
            graphs: GraphWatchers::new(),
            steps: StepWatchers::new(),
            folder_trust: Mutex::new(project::FolderTrustSession::default()),
        }
    }

    #[test]
    fn with_db_runs_the_closure_against_the_locked_connection() {
        let state = state();
        let n: i64 = state
            .with_db(|conn| Ok(conn.query_row("SELECT 1", [], |row| row.get(0))?))
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn with_db_maps_a_closure_error() {
        let state = state();
        let err = state
            .with_db::<()>(|_| Err(Error::Invalid("nope".into())))
            .unwrap_err();
        assert!(err.to_string().contains("nope"));
    }
}
