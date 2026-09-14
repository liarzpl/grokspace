//! Sessions: the SQLite row, the start path that drives a pty or an ACP
//! agent, and the worktree commands that merge or close one.

mod db;
mod start;
mod worktree_cmds;

pub use db::{clear_permission, get, list, set_title, Session, SessionKind, SessionStatus};
// Other modules (project, task, graph, steps) call these by name.
#[allow(unused_imports)]
pub use db::{
    delete, insert, reconcile_on_start, record_permission, set_status, PendingPermission,
};
#[allow(unused_imports)] // e2e_smoke (cfg(test))
pub(crate) use start::session_env;
pub(crate) use start::{start, ChannelSink, StartRequest};
#[allow(unused_imports)] // project::remove_project
pub(crate) use worktree_cmds::close_forgetting;
pub use worktree_cmds::MergeOutcome;
pub(crate) use worktree_cmds::{close, close_with, WorktreeTeardown};

use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Runtime, State};

use crate::error::{Error, Result};
use crate::{project, AppState};

#[tauri::command]
pub fn list_sessions(state: State<'_, AppState>, project_id: String) -> Result<Vec<Session>> {
    let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
    list(&conn, &project_id)
}

/// What starting a session takes, as one value.
///
/// Loose arguments were fine at four and stopped being fine at seven: the role took
/// this past what anyone can read at a call site, and past what clippy will accept.
/// Naming the fields at the boundary is what a struct buys.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSession {
    project_id: String,
    /// Absent for an agent, which runs beside the grid rather than in it.
    pane_id: Option<String>,
    kind: SessionKind,
    /// What the session is being started as, when it is being started as anything.
    role: Option<String>,
    cols: u16,
    rows: u16,
    /// Confirm starting an ACP agent on the project tree when isolation skipped.
    #[serde(default)]
    allow_unisolated: bool,
    #[serde(default)]
    seed_graph: Option<String>,
    #[serde(default)]
    seed_steps: Option<String>,
}

#[tauri::command]
pub fn create_session<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    session: NewSession,
) -> Result<Session> {
    start(
        &app,
        &state,
        StartRequest {
            project_id: session.project_id,
            pane_id: session.pane_id,
            kind: session.kind,
            title: None,
            role: session.role,
            cols: session.cols,
            rows: session.rows,
            reuse_worktree: None,
            allow_unisolated: session.allow_unisolated,
            seed_graph: session.seed_graph,
            seed_steps: session.seed_steps,
        },
    )
}

/// Points the session's output at this pane and replays whatever scrollback is
/// buffered, so a remounted pane is not left blank.
#[tauri::command]
pub fn attach_session(
    state: State<'_, AppState>,
    id: String,
    on_output: Channel<InvokeResponseBody>,
) -> Result<()> {
    state.pty.attach(&id, Arc::new(ChannelSink::new(on_output)))
}

#[tauri::command]
pub fn write_session(state: State<'_, AppState>, id: String, data: String) -> Result<()> {
    state.pty.write(&id, data.as_bytes())
}

#[tauri::command]
pub fn resize_session(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> Result<()> {
    state.pty.resize(&id, cols, rows)
}

/// Sends a prompt to an ACP session.
///
/// The terminal equivalent is `write_session`, which types into a pty and cannot
/// know whether anything read it. This one is a request, so the agent's reply is
/// what moves the session back to `idle`.
#[tauri::command]
pub fn prompt_session(state: State<'_, AppState>, id: String, text: String) -> Result<()> {
    if text.trim().is_empty() {
        return Err(Error::Invalid("an empty prompt has nothing to ask".into()));
    }
    state.acp.prompt(&id, text.trim())
}

/// Interrupts the current turn without ending the session. Stop is the other
/// button: that kills the process.
#[tauri::command]
pub fn cancel_session(state: State<'_, AppState>, id: String) -> Result<()> {
    state.acp.cancel(&id)
}

/// Answers a permission the agent is blocked on. Until this arrives the session
/// stays `needs_input` and the agent does nothing.
#[tauri::command]
pub fn answer_session_permission(
    state: State<'_, AppState>,
    id: String,
    request_id: u64,
    allow: bool,
    option_id: Option<String>,
) -> Result<()> {
    let snapshot = answer_snapshot(&state, &id, request_id);
    state
        .acp
        .answer_permission(&id, request_id, allow, option_id.as_deref())?;
    if let Ok(conn) = state.db.lock() {
        let _ = clear_permission(&conn, &id, request_id);
    }
    if let Some((project_id, summary, project_path, step_id)) = snapshot {
        crate::ledger::record_answer(
            &project_id,
            &id,
            request_id,
            &summary,
            allow,
            option_id.as_deref(),
        );
        crate::permission_heat::record_answer(
            &project_path,
            &id,
            request_id,
            &summary,
            allow,
            option_id.as_deref(),
            step_id.as_deref(),
        );
    }
    Ok(())
}

fn answer_snapshot(
    state: &AppState,
    id: &str,
    request_id: u64,
) -> Option<(String, String, PathBuf, Option<String>)> {
    let conn = state.db.lock().ok()?;
    let session = get(&conn, id).ok()?;
    let path = project::get(&conn, &session.project_id).ok()?.path;
    Some((
        session.project_id,
        db::permission_summary(&conn, id, request_id),
        PathBuf::from(path),
        crate::permission_heat::doing_step_id(&conn, id),
    ))
}

#[tauri::command]
pub fn stop_session(state: State<'_, AppState>, id: String) -> Result<()> {
    // An agent has no pty to signal. Killing it is the same intent, and `cancel`
    // is not: that interrupts the turn and leaves the session open.
    if state.acp.is_running(&id) {
        return state.acp.kill(&id);
    }
    state.pty.kill(&id)
}

/// Restarting starts a fresh session in the same pane rather than reusing the
/// row. Killing is asynchronous, so reusing the id would race the old child's
/// exit handler against the new child's registration.
///
/// Continue this job uses this same start (`reuse_worktree`, new id, no
/// `--resume`). The host brief is sent after the new ACP handshake.
#[tauri::command]
pub fn restart_session<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<Session> {
    let previous = {
        let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
        get(&conn, &id)?
    };

    close_with(&state, &id, WorktreeTeardown::Keep)?;

    start(
        &app,
        &state,
        StartRequest {
            // Preserved as it was, including absent: an agent restarted into pane
            // zero would displace whatever terminal is actually there.
            pane_id: previous.pane_id,
            project_id: previous.project_id,
            kind: previous.kind,
            title: previous.title,
            // Kept, so a restarted Reviewer comes back a Reviewer. The brief is the
            // caller's to send again; this is only the label.
            role: previous.role,
            cols,
            rows,
            reuse_worktree: previous.worktree_path.map(PathBuf::from),
            // A previous skip already ran on the project tree; Restart must not
            // fail-closed on the same folder the user already confirmed.
            allow_unisolated: previous.isolation_skip.is_some(),
            seed_graph: None,
            seed_steps: None,
        },
    )
}

#[tauri::command]
pub fn rename_session(state: State<'_, AppState>, id: String, title: String) -> Result<Session> {
    let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
    set_title(&conn, &id, &title)
}

/// Ends the session and frees its pane. The exit handler may still fire for the
/// killed child; it finds no row and the frontend ignores the event.
#[tauri::command]
pub fn close_session(state: State<'_, AppState>, id: String) -> Result<()> {
    close(&state, &id)
}

/// Throws away a stopped agent's worktree so Close can proceed.
///
/// Refused while the process is still running: deleting its cwd from under it is
/// not a teardown, it is a crash. Refused when there is no worktree, so the
/// button is not a silent no-op.
#[tauri::command]
pub fn discard_session_worktree(state: State<'_, AppState>, id: String) -> Result<Session> {
    worktree_cmds::discard(&state, &id)
}

/// Merges a stopped agent's worktree into the project branch.
///
/// Uncommitted files are committed on the session branch first: merging a
/// branch that has not moved past the project's `HEAD` would bring nothing.
/// Refused while the process is still running — the merge then removes the
/// tree, which is that process's cwd. Refused when the project tree is dirty,
/// so the agent's commit cannot land on top of uncommitted human work.
#[tauri::command]
pub fn merge_session_worktree(state: State<'_, AppState>, id: String) -> Result<MergeOutcome> {
    worktree_cmds::merge(&state, &id)
}

/// Why Merge would refuse this session, without committing or merging.
///
/// `None` means leftover commit + `git merge --no-edit` may run. Conflicts
/// are not predicted. The Diff panel reads this onto a strip so the reasons
/// are visible before a click, rather than only on the toast afterwards.
#[tauri::command]
pub fn session_merge_readiness(state: State<'_, AppState>, id: String) -> Result<Option<String>> {
    worktree_cmds::merge_readiness(&state, &id)
}

/// Leftover `.grokspace/worktrees/` directories with no session row, plus sizes.
/// Dirty trees are listed so Settings can show them; they are not removable.
#[tauri::command]
pub fn preview_worktree_gc(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<worktree_cmds::WorktreeGcEntry>> {
    worktree_cmds::preview_gc(&state, &project_id)
}

/// Removes clean orphan worktrees after Settings confirm. Never `--force`.
#[tauri::command]
pub fn gc_orphan_worktrees(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<worktree_cmds::WorktreeGcEntry>> {
    worktree_cmds::remove_clean_orphans(&state, &project_id)
}

#[cfg(test)]
mod tests {
    use super::db::{
        record_live_process, sessions_for_pane, set_isolation_skip, set_process_id,
        set_worktree_path,
    };
    use super::start::{
        command_for, env_to_unset, isolate_agent, role_env, session_env, write_session_seeds,
        Launch,
    };
    use super::*;
    use crate::acp;
    use crate::db;
    use crate::project;
    use crate::worktree;
    use rusqlite::Connection;
    use std::path::{Path, PathBuf};

    fn fixture() -> (Connection, String) {
        let conn = db::open_in_memory().expect("in-memory database should open");
        let project =
            project::upsert_by_path(&conn, "/tmp/grokspace-test", "grokspace-test").unwrap();
        (conn, project.id)
    }

    #[test]
    fn an_unknown_kind_is_an_error_rather_than_grok() {
        // `kind` has no CHECK — 0002 could not add one to the live table — so a
        // hand-edited row is the path that used to collapse to Grok.
        let (conn, project_id) = fixture();
        let session = insert(
            &conn,
            &project_id,
            Some("1"),
            SessionKind::Grok,
            "Grok",
            None,
        )
        .unwrap();
        conn.execute(
            "UPDATE sessions SET kind = 'wizard' WHERE id = ?1",
            [&session.id],
        )
        .unwrap();

        let error = get(&conn, &session.id).unwrap_err();
        assert!(
            error.to_string().contains("unknown session kind `wizard`"),
            "{error}"
        );
    }

    #[test]
    fn a_new_session_starts_running_in_its_pane() {
        let (conn, project_id) = fixture();

        let session = insert(
            &conn,
            &project_id,
            Some("1"),
            SessionKind::Grok,
            "Grok",
            None,
        )
        .unwrap();

        assert_eq!(session.status, SessionStatus::Running);
        assert_eq!(session.kind, SessionKind::Grok);
        assert_eq!(session.pane_id.as_deref(), Some("1"));
        assert_eq!(session.exit_code, None);
    }

    #[test]
    fn sessions_for_pane_returns_every_occupant_of_that_pane() {
        let (conn, project_id) = fixture();
        let first = insert(
            &conn,
            &project_id,
            Some("0"),
            SessionKind::Grok,
            "First",
            None,
        )
        .unwrap();
        let second = insert(
            &conn,
            &project_id,
            Some("0"),
            SessionKind::Shell,
            "Second",
            None,
        )
        .unwrap();
        insert(
            &conn,
            &project_id,
            Some("1"),
            SessionKind::Grok,
            "Other pane",
            None,
        )
        .unwrap();
        insert(&conn, &project_id, None, SessionKind::Agent, "Agent", None).unwrap();

        let ids: Vec<_> = sessions_for_pane(&conn, &project_id, "0")
            .unwrap()
            .into_iter()
            .map(|session| session.id)
            .collect();
        assert_eq!(ids, vec![first.id, second.id]);
        assert!(sessions_for_pane(&conn, &project_id, "9")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn sessions_for_pane_does_not_cross_projects() {
        let (conn, project_id) = fixture();
        let other = project::upsert_by_path(&conn, "/tmp/other-pane", "other-pane").unwrap();
        insert(
            &conn,
            &project_id,
            Some("0"),
            SessionKind::Grok,
            "Here",
            None,
        )
        .unwrap();
        insert(
            &conn,
            &other.id,
            Some("0"),
            SessionKind::Grok,
            "There",
            None,
        )
        .unwrap();

        let titles: Vec<_> = sessions_for_pane(&conn, &project_id, "0")
            .unwrap()
            .into_iter()
            .filter_map(|session| session.title)
            .collect();
        assert_eq!(titles, vec!["Here"]);
    }

    #[test]
    fn an_agent_holds_no_pane_and_so_never_displaces_a_terminal() {
        let (conn, project_id) = fixture();
        let terminal = insert(
            &conn,
            &project_id,
            Some("0"),
            SessionKind::Grok,
            "Grok",
            None,
        )
        .unwrap();

        let agent = insert(&conn, &project_id, None, SessionKind::Agent, "Agent", None).unwrap();

        assert_eq!(agent.pane_id, None);
        assert_eq!(agent.kind, SessionKind::Agent);
        assert_eq!(
            terminal.pane_id.as_deref(),
            Some("0"),
            "the agent is beside the grid, not in it"
        );
        assert_eq!(list(&conn, &project_id).unwrap().len(), 2);
    }

    #[test]
    fn sessions_are_listed_per_project_in_creation_order() {
        let (conn, project_id) = fixture();
        let other = project::upsert_by_path(&conn, "/tmp/other", "other").unwrap();

        insert(
            &conn,
            &project_id,
            Some("0"),
            SessionKind::Grok,
            "First",
            None,
        )
        .unwrap();
        insert(
            &conn,
            &project_id,
            Some("1"),
            SessionKind::Shell,
            "Second",
            None,
        )
        .unwrap();
        insert(
            &conn,
            &other.id,
            Some("0"),
            SessionKind::Grok,
            "Elsewhere",
            None,
        )
        .unwrap();

        let titles: Vec<_> = list(&conn, &project_id)
            .unwrap()
            .into_iter()
            .filter_map(|session| session.title)
            .collect();
        assert_eq!(titles, vec!["First", "Second"]);
    }

    #[test]
    fn an_exit_records_the_status_and_the_code() {
        let (conn, project_id) = fixture();
        let session = insert(
            &conn,
            &project_id,
            Some("0"),
            SessionKind::Shell,
            "Shell",
            None,
        )
        .unwrap();

        set_status(&conn, &session.id, SessionStatus::Stopped, Some(130)).unwrap();

        let reloaded = get(&conn, &session.id).unwrap();
        assert_eq!(reloaded.status, SessionStatus::Stopped);
        assert_eq!(reloaded.exit_code, Some(130));
    }

    #[test]
    fn renaming_rejects_an_empty_title() {
        let (conn, project_id) = fixture();
        let session = insert(
            &conn,
            &project_id,
            Some("0"),
            SessionKind::Grok,
            "Grok",
            None,
        )
        .unwrap();

        assert!(set_title(&conn, &session.id, "   ").is_err());
        assert_eq!(
            set_title(&conn, &session.id, "  Reviewer  ")
                .unwrap()
                .title
                .as_deref(),
            Some("Reviewer")
        );
    }

    #[test]
    fn startup_marks_every_surviving_session_stopped() {
        let (conn, project_id) = fixture();
        let running = insert(
            &conn,
            &project_id,
            Some("0"),
            SessionKind::Grok,
            "Grok",
            None,
        )
        .unwrap();
        set_process_id(&conn, &running.id, Some(4242)).unwrap();
        let already_stopped = insert(
            &conn,
            &project_id,
            Some("1"),
            SessionKind::Shell,
            "Shell",
            None,
        )
        .unwrap();
        set_status(&conn, &already_stopped.id, SessionStatus::Stopped, Some(0)).unwrap();

        let reconciled = reconcile_on_start(&conn).unwrap();

        assert_eq!(reconciled, 1, "only the live-looking session needs fixing");
        let reloaded = get(&conn, &running.id).unwrap();
        assert_eq!(reloaded.status, SessionStatus::Stopped);
        assert_eq!(
            reloaded.process_id, None,
            "a stale pid must not be shown as if it were live"
        );
    }

    #[test]
    fn startup_drops_pending_permissions() {
        let (conn, project_id) = fixture();
        let live = insert(&conn, &project_id, None, SessionKind::Agent, "Live", None).unwrap();
        record_permission(&conn, &live.id, 9, "Write a file", &[]).unwrap();

        let already = insert(
            &conn,
            &project_id,
            None,
            SessionKind::Agent,
            "Already",
            None,
        )
        .unwrap();
        set_status(&conn, &already.id, SessionStatus::Stopped, None).unwrap();
        // The old reconcile path left these; answering them is SessionNotRunning.
        record_permission(&conn, &already.id, 10, "Run a command", &[]).unwrap();

        reconcile_on_start(&conn).unwrap();

        for session in list(&conn, &project_id).unwrap() {
            assert!(
                session.pending_permissions.is_empty(),
                "{} still has {:?}",
                session.title.unwrap_or_default(),
                session.pending_permissions
            );
        }
    }

    #[test]
    fn removing_a_project_takes_its_sessions_with_it() {
        let (conn, project_id) = fixture();
        insert(
            &conn,
            &project_id,
            Some("0"),
            SessionKind::Grok,
            "Grok",
            None,
        )
        .unwrap();

        project::remove(&conn, &project_id).unwrap();

        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(remaining, 0);
    }

    #[test]
    fn a_session_is_told_where_its_own_graph_belongs() {
        let dir = tempfile::tempdir().expect("temp dir should be created");

        let env = session_env(dir.path(), "session-42");

        let value = |key: &str| {
            env.iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value.clone())
                .unwrap_or_else(|| panic!("{key} should be exported"))
        };
        assert_eq!(value("GROKSPACE_SESSION_ID"), "session-42");
        assert_eq!(value("GROKSPACE_PROJECT_DIR"), dir.path().to_string_lossy());
        // The path is absolute so that an agent working in a worktree still
        // reports into the graph the pane is drawing.
        let file = PathBuf::from(value("GROKSPACE_GRAPH_FILE"));
        assert!(file.is_absolute());
        assert!(file.ends_with("session-42.json"));
        assert_eq!(
            file.parent().map(Path::to_path_buf),
            Some(PathBuf::from(value("GROKSPACE_GRAPH_DIR")))
        );
        assert!(
            file.parent().is_some_and(Path::is_dir),
            "the directory is prepared up front so the watcher has something to watch"
        );

        let steps_file = PathBuf::from(value("GROKSPACE_STEPS_FILE"));
        assert!(steps_file.is_absolute());
        assert!(steps_file.ends_with("session-42.json"));
        assert_eq!(
            steps_file.parent().map(Path::to_path_buf),
            Some(PathBuf::from(value("GROKSPACE_STEPS_DIR")))
        );
        assert!(
            steps_file.parent().is_some_and(Path::is_dir),
            "the steps directory is prepared up front so the watcher has something to watch"
        );
    }

    #[test]
    fn a_session_remembers_the_role_it_was_started_as() {
        let (conn, project_id) = fixture();

        let reviewer = insert(
            &conn,
            &project_id,
            None,
            SessionKind::Agent,
            "Reviewer",
            Some("  Reviewer  "),
        )
        .unwrap();
        let by_hand = insert(
            &conn,
            &project_id,
            Some("0"),
            SessionKind::Grok,
            "Grok",
            None,
        )
        .unwrap();

        assert_eq!(
            reviewer.role.as_deref(),
            Some("Reviewer"),
            "roles are trimmed"
        );
        assert_eq!(
            by_hand.role, None,
            "a session started by hand has no role, which is not the same as a blank one"
        );
    }

    #[test]
    fn a_blank_role_is_stored_as_none() {
        // So an agent can tell "no role" from a role that happens to be empty.
        let (conn, project_id) = fixture();

        let session = insert(
            &conn,
            &project_id,
            None,
            SessionKind::Agent,
            "Agent",
            Some("  "),
        )
        .unwrap();

        assert_eq!(session.role, None);
    }

    #[test]
    fn only_a_session_with_a_role_is_told_about_one() {
        assert!(role_env(None).is_empty());
        assert!(role_env(Some("   ")).is_empty());
        assert_eq!(
            role_env(Some(" Planner ")),
            vec![("GROKSPACE_SESSION_ROLE".to_string(), "Planner".to_string())]
        );
    }

    #[test]
    fn every_session_in_a_project_is_pointed_at_the_same_memory() {
        // The graph is one session's own; the memory is what they share, so unlike
        // the graph file this one must not vary by session.
        let dir = tempfile::tempdir().expect("temp dir should be created");

        let memory_of = |session_id: &str| {
            session_env(dir.path(), session_id)
                .into_iter()
                .find(|(name, _)| name == "GROKSPACE_MEMORY_FILE")
                .map(|(_, value)| value)
                .expect("the memory file should be exported")
        };

        let first = memory_of("s1");
        assert_eq!(first, memory_of("s2"));
        assert!(PathBuf::from(&first).is_absolute());
        assert!(first.ends_with("memory.md"));
    }

    #[test]
    fn two_sessions_in_one_project_get_different_graph_files() {
        let dir = tempfile::tempdir().expect("temp dir should be created");

        let first = session_env(dir.path(), "s1");
        let second = session_env(dir.path(), "s2");

        let graph_file = |env: &[(String, String)]| {
            env.iter()
                .find(|(name, _)| name == "GROKSPACE_GRAPH_FILE")
                .map(|(_, value)| value.clone())
                .expect("the graph file should be exported")
        };
        assert_ne!(graph_file(&first), graph_file(&second));
    }

    #[test]
    fn a_shell_unsets_the_host_api_key_and_agents_do_not() {
        let unset = env_to_unset(SessionKind::Shell);
        assert!(unset.iter().any(|name| name == "XAI_API_KEY"));
        assert!(env_to_unset(SessionKind::Grok).is_empty());
        assert!(env_to_unset(SessionKind::Agent).is_empty());
    }

    #[test]
    fn a_shell_session_resolves_to_a_real_program() {
        let Launch::Terminal { program, .. } = command_for(SessionKind::Shell).unwrap() else {
            panic!("a shell is a terminal");
        };

        assert!(
            PathBuf::from(&program).is_file(),
            "expected a runnable shell, got {program}"
        );
    }

    #[test]
    fn an_agent_session_is_not_launched_as_a_terminal() {
        // The kind decides which manager runs it, and an agent has no pty at all.
        // Which branch it takes is what this pins; whether `grok` is installed on
        // the machine running the tests is not this test's business.
        match command_for(SessionKind::Agent) {
            Ok(Launch::Agent { .. }) => {}
            Ok(Launch::Terminal { .. }) => panic!("an agent must not be started on a pty"),
            Err(_) => {} // No `grok` here, which is a different failure.
        }
    }

    #[test]
    fn an_agent_that_has_started_is_idle_rather_than_running() {
        let (conn, project_id) = fixture();
        let agent = insert(&conn, &project_id, None, SessionKind::Agent, "Agent", None).unwrap();

        record_live_process(&conn, &agent.id, SessionKind::Agent, Some(4242)).unwrap();

        let reloaded = get(&conn, &agent.id).unwrap();
        assert_eq!(reloaded.status, SessionStatus::Idle);
        assert_eq!(reloaded.process_id, Some(4242));
    }

    #[test]
    fn a_terminal_that_has_started_stays_running() {
        let (conn, project_id) = fixture();
        let grok = insert(
            &conn,
            &project_id,
            Some("0"),
            SessionKind::Grok,
            "Grok",
            None,
        )
        .unwrap();

        record_live_process(&conn, &grok.id, SessionKind::Grok, Some(7)).unwrap();

        let reloaded = get(&conn, &grok.id).unwrap();
        assert_eq!(reloaded.status, SessionStatus::Running);
        assert_eq!(reloaded.process_id, Some(7));
    }

    #[test]
    fn stopping_a_session_clears_its_process_id() {
        let (conn, project_id) = fixture();
        let session = insert(
            &conn,
            &project_id,
            Some("0"),
            SessionKind::Grok,
            "Grok",
            None,
        )
        .unwrap();
        set_process_id(&conn, &session.id, Some(4242)).unwrap();

        set_status(&conn, &session.id, SessionStatus::Stopped, Some(0)).unwrap();

        let reloaded = get(&conn, &session.id).unwrap();
        assert_eq!(reloaded.status, SessionStatus::Stopped);
        assert_eq!(reloaded.process_id, None);
    }

    #[test]
    fn a_stopped_session_ignores_a_later_idle() {
        let (conn, project_id) = fixture();
        let session = insert(&conn, &project_id, None, SessionKind::Agent, "Agent", None).unwrap();
        set_status(&conn, &session.id, SessionStatus::Stopped, Some(0)).unwrap();

        set_status(&conn, &session.id, SessionStatus::Idle, None).unwrap();
        set_status(&conn, &session.id, SessionStatus::Running, None).unwrap();

        let reloaded = get(&conn, &session.id).unwrap();
        assert_eq!(reloaded.status, SessionStatus::Stopped);
        assert_eq!(
            reloaded.exit_code,
            Some(0),
            "a late status must not clear the exit code"
        );
    }

    #[test]
    fn record_live_process_does_not_revive_a_stopped_agent() {
        let (conn, project_id) = fixture();
        let session = insert(&conn, &project_id, None, SessionKind::Agent, "Agent", None).unwrap();
        set_status(&conn, &session.id, SessionStatus::Stopped, Some(1)).unwrap();

        record_live_process(&conn, &session.id, SessionKind::Agent, Some(99)).unwrap();

        let reloaded = get(&conn, &session.id).unwrap();
        assert_eq!(reloaded.status, SessionStatus::Stopped);
        assert_eq!(reloaded.exit_code, Some(1));
    }

    #[test]
    fn listing_a_project_does_not_attach_another_projects_permissions() {
        let (conn, project_id) = fixture();
        let other = project::upsert_by_path(&conn, "/tmp/other-perms", "other-perms").unwrap();
        let ours = insert(&conn, &project_id, None, SessionKind::Agent, "Ours", None).unwrap();
        let theirs = insert(&conn, &other.id, None, SessionKind::Agent, "Theirs", None).unwrap();

        record_permission(&conn, &theirs.id, 1, "Write a secret", &[]).unwrap();
        record_permission(&conn, &ours.id, 2, "Write a file", &[]).unwrap();

        let listed = list(&conn, &project_id).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].pending_permissions.len(), 1);
        assert_eq!(listed[0].pending_permissions[0].request_id, 2);
        assert_eq!(listed[0].pending_permissions[0].summary, "Write a file");
    }

    #[test]
    fn a_pending_permission_survives_a_list_round_trip() {
        let (conn, project_id) = fixture();
        let session = insert(&conn, &project_id, None, SessionKind::Agent, "Agent", None).unwrap();

        record_permission(&conn, &session.id, 9, "Write a file", &[]).unwrap();

        let listed = list(&conn, &project_id).unwrap();
        assert_eq!(
            listed[0].pending_permissions,
            vec![PendingPermission {
                request_id: 9,
                summary: "Write a file".into(),
                options: Vec::new(),
            }]
        );

        clear_permission(&conn, &session.id, 9).unwrap();
        assert!(list(&conn, &project_id).unwrap()[0]
            .pending_permissions
            .is_empty());
    }

    #[test]
    fn a_pending_permission_keeps_the_options_the_agent_offered() {
        let (conn, project_id) = fixture();
        let session = insert(&conn, &project_id, None, SessionKind::Agent, "Agent", None).unwrap();
        let options = vec![
            acp::PermissionOption {
                option_id: "allow-once".into(),
                kind: "allow_once".into(),
                name: "Allow once".into(),
            },
            acp::PermissionOption {
                option_id: "allow-always".into(),
                kind: "allow_always".into(),
                name: "Always allow".into(),
            },
        ];

        record_permission(&conn, &session.id, 9, "Write a file", &options).unwrap();

        assert_eq!(
            list(&conn, &project_id).unwrap()[0].pending_permissions[0].options,
            options
        );
    }

    #[test]
    fn stopping_a_session_drops_its_pending_permissions() {
        let (conn, project_id) = fixture();
        let session = insert(&conn, &project_id, None, SessionKind::Agent, "Agent", None).unwrap();
        record_permission(&conn, &session.id, 9, "Write a file", &[]).unwrap();

        set_status(&conn, &session.id, SessionStatus::Stopped, None).unwrap();

        assert!(list(&conn, &project_id).unwrap()[0]
            .pending_permissions
            .is_empty());
    }

    #[test]
    fn an_isolation_skip_survives_a_list_round_trip() {
        let (conn, project_id) = fixture();
        let session = insert(&conn, &project_id, None, SessionKind::Agent, "Agent", None).unwrap();
        assert_eq!(session.isolation_skip, None);

        let stored = set_isolation_skip(
            &conn,
            &session.id,
            Some("this folder is not a git repository"),
        )
        .unwrap();
        assert_eq!(
            stored.isolation_skip.as_deref(),
            Some("this folder is not a git repository")
        );
        assert_eq!(
            list(&conn, &project_id).unwrap()[0]
                .isolation_skip
                .as_deref(),
            Some("this folder is not a git repository")
        );

        let cleared = set_isolation_skip(&conn, &session.id, None).unwrap();
        assert_eq!(cleared.isolation_skip, None);
    }

    #[test]
    fn a_worktree_path_is_remembered_and_can_be_cleared() {
        let (conn, project_id) = fixture();
        let session = insert(&conn, &project_id, None, SessionKind::Agent, "Agent", None).unwrap();
        assert_eq!(session.worktree_path, None);

        let stored = set_worktree_path(
            &conn,
            &session.id,
            Some(Path::new("/tmp/acme/.grokspace/worktrees/s1")),
        )
        .unwrap();
        assert_eq!(
            stored.worktree_path.as_deref(),
            Some("/tmp/acme/.grokspace/worktrees/s1")
        );

        let cleared = set_worktree_path(&conn, &session.id, None).unwrap();
        assert_eq!(cleared.worktree_path, None);
    }

    #[test]
    fn session_env_does_not_claim_a_worktree() {
        // GROKSPACE_WORKTREE is added at spawn, and only when isolate_agent found
        // one. Putting it in session_env would lie for every grok pane and shell.
        let dir = tempfile::tempdir().expect("temp dir should be created");
        let env = session_env(dir.path(), "session-42");
        assert!(
            env.iter().all(|(name, _)| name != "GROKSPACE_WORKTREE"),
            "session_env should leave GROKSPACE_WORKTREE to start()"
        );
    }

    #[test]
    fn isolate_agent_leaves_grok_panes_on_the_project() {
        let (conn, project_id) = fixture();
        let session = insert(
            &conn,
            &project_id,
            Some("0"),
            SessionKind::Grok,
            "Grok",
            None,
        )
        .unwrap();
        let request = StartRequest {
            project_id,
            pane_id: Some("0".into()),
            kind: SessionKind::Grok,
            title: None,
            role: None,
            cols: 80,
            rows: 24,
            reuse_worktree: None,
            allow_unisolated: false,
            seed_graph: None,
            seed_steps: None,
        };
        assert_eq!(isolate_agent(&request, &session, Path::new("/tmp")), None);
    }

    #[test]
    fn isolate_agent_leaves_shells_on_the_project() {
        let (conn, project_id) = fixture();
        let session = insert(
            &conn,
            &project_id,
            Some("0"),
            SessionKind::Shell,
            "Shell",
            None,
        )
        .unwrap();
        let request = StartRequest {
            project_id,
            pane_id: Some("0".into()),
            kind: SessionKind::Shell,
            title: None,
            role: None,
            cols: 80,
            rows: 24,
            reuse_worktree: None,
            allow_unisolated: false,
            seed_graph: None,
            seed_steps: None,
        };
        assert_eq!(isolate_agent(&request, &session, Path::new("/tmp")), None);
    }

    #[test]
    fn merge_outcome_names_teardown_without_an_english_phrase() {
        let (conn, project_id) = fixture();
        let session = insert(&conn, &project_id, None, SessionKind::Agent, "Agent", None).unwrap();
        let json = serde_json::to_value(MergeOutcome {
            session,
            teardown_error: Some("device busy".into()),
        })
        .unwrap();
        assert_eq!(json["teardownError"], "device busy");
        assert!(json.get("session").is_some());
        assert!(
            !json.to_string().contains("the branch landed"),
            "the frontend must not have to match a sentence, got: {json}"
        );
    }

    #[test]
    fn isolate_agent_does_not_reuse_a_directory_that_is_not_a_checkout() {
        let leftover = tempfile::tempdir().expect("temp dir should be created");
        let (conn, project_id) = fixture();
        let session = insert(&conn, &project_id, None, SessionKind::Agent, "Agent", None).unwrap();
        let request = StartRequest {
            project_id,
            pane_id: None,
            kind: SessionKind::Agent,
            title: None,
            role: None,
            cols: 80,
            rows: 24,
            reuse_worktree: Some(leftover.path().to_path_buf()),
            allow_unisolated: false,
            seed_graph: None,
            seed_steps: None,
        };
        assert_eq!(
            isolate_agent(&request, &session, leftover.path()),
            Some(worktree::Isolation::Skipped(
                worktree::IsolationSkip::NotARepo
            )),
            "a leftover folder is not Isolated; add() then skips the non-repo project"
        );
    }

    #[test]
    fn write_session_seeds_lands_on_the_new_id_and_leaves_the_parent() {
        let dir = tempfile::tempdir().expect("temp dir should be created");
        let graphs = crate::graph::project_graph_dir(dir.path());
        std::fs::create_dir_all(&graphs).unwrap();
        let parent = graphs.join("parent.json");
        std::fs::write(&parent, r#"{"id":"parent"}"#).unwrap();

        write_session_seeds(
            dir.path(),
            "child",
            Some(r#"{"id":"forked","nodes":[{"id":"n1"}]}"#),
            Some(r#"{"steps":[{"title":"Ship it","status":"pending"}]}"#),
        );

        assert_eq!(
            std::fs::read_to_string(graphs.join("child.json")).unwrap(),
            r#"{"id":"forked","nodes":[{"id":"n1"}]}"#
        );
        assert_eq!(
            std::fs::read_to_string(crate::steps::project_steps_dir(dir.path()).join("child.json"))
                .unwrap(),
            r#"{"steps":[{"title":"Ship it","status":"pending"}]}"#
        );
        assert_eq!(
            std::fs::read_to_string(&parent).unwrap(),
            r#"{"id":"parent"}"#
        );
    }

    #[test]
    fn isolate_agent_skips_a_folder_that_is_not_a_repository() {
        let dir = tempfile::tempdir().expect("temp dir should be created");
        let (conn, project_id) = fixture();
        let session = insert(&conn, &project_id, None, SessionKind::Agent, "Agent", None).unwrap();
        let request = StartRequest {
            project_id,
            pane_id: None,
            kind: SessionKind::Agent,
            title: None,
            role: None,
            cols: 80,
            rows: 24,
            reuse_worktree: None,
            allow_unisolated: false,
            seed_graph: None,
            seed_steps: None,
        };
        assert_eq!(
            isolate_agent(&request, &session, dir.path()),
            Some(worktree::Isolation::Skipped(
                worktree::IsolationSkip::NotARepo
            ))
        );
    }
}
