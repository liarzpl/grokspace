//! Terminal sessions: the database record for a pane, and the commands that
//! drive the pty behind it.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::now_ms;
use crate::error::{Error, Result};
use crate::pty::{ExitHandler, OutputSink, SpawnOptions};
use crate::{graph, project, AppState};

const COLUMNS: &str = "id, project_id, pane_id, process_id, status, title, role, \
                       worktree_path, kind, exit_code, created_at, updated_at";

/// Emitted when a child terminates. Status changes are infrequent, so the event
/// system is the right fit here; the output stream is not, and uses a channel.
const EXIT_EVENT: &str = "session-exited";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Idle,
    Running,
    NeedsInput,
    Stopped,
}

impl SessionStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Running => "running",
            Self::NeedsInput => "needs_input",
            Self::Stopped => "stopped",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "idle" => Self::Idle,
            "running" => Self::Running,
            "needs_input" => Self::NeedsInput,
            _ => Self::Stopped,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionKind {
    /// An interactive Grok Build agent.
    Grok,
    /// A plain login shell, useful next to the agents and the easiest way to
    /// exercise the pty layer without depending on the `grok` binary.
    Shell,
}

impl SessionKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Grok => "grok",
            Self::Shell => "shell",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "shell" => Self::Shell,
            _ => Self::Grok,
        }
    }

    fn default_title(self) -> &'static str {
        match self {
            Self::Grok => "Grok",
            Self::Shell => "Shell",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub project_id: String,
    pub pane_id: Option<String>,
    pub process_id: Option<u32>,
    pub status: SessionStatus,
    pub title: Option<String>,
    pub role: Option<String>,
    pub worktree_path: Option<String>,
    pub kind: SessionKind,
    pub exit_code: Option<i32>,
    pub created_at: i64,
    pub updated_at: i64,
}

fn from_row(row: &Row<'_>) -> rusqlite::Result<Session> {
    let status: String = row.get("status")?;
    let kind: String = row.get("kind")?;
    let process_id: Option<i64> = row.get("process_id")?;
    Ok(Session {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        pane_id: row.get("pane_id")?,
        process_id: process_id.and_then(|pid| u32::try_from(pid).ok()),
        status: SessionStatus::parse(&status),
        title: row.get("title")?,
        role: row.get("role")?,
        worktree_path: row.get("worktree_path")?,
        kind: SessionKind::parse(&kind),
        exit_code: row.get("exit_code")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn list(conn: &Connection, project_id: &str) -> Result<Vec<Session>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM sessions WHERE project_id = ?1 ORDER BY created_at ASC"
    ))?;
    let sessions = stmt
        .query_map([project_id], from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(sessions)
}

pub fn get(conn: &Connection, id: &str) -> Result<Session> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM sessions WHERE id = ?1"),
        [id],
        from_row,
    )
    .optional()?
    .ok_or_else(|| Error::SessionNotFound(id.to_string()))
}

pub fn insert(
    conn: &Connection,
    project_id: &str,
    pane_id: &str,
    kind: SessionKind,
    title: &str,
) -> Result<Session> {
    let now = now_ms();
    let session = conn.query_row(
        &format!(
            "INSERT INTO sessions
                 (id, project_id, pane_id, status, title, kind, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
             RETURNING {COLUMNS}"
        ),
        rusqlite::params![
            uuid::Uuid::new_v4().to_string(),
            project_id,
            pane_id,
            SessionStatus::Running.as_str(),
            title,
            kind.as_str(),
            now,
        ],
        from_row,
    )?;
    Ok(session)
}

pub fn set_status(
    conn: &Connection,
    id: &str,
    status: SessionStatus,
    exit_code: Option<i32>,
) -> Result<()> {
    conn.execute(
        "UPDATE sessions SET status = ?2, exit_code = ?3, updated_at = ?4 WHERE id = ?1",
        rusqlite::params![id, status.as_str(), exit_code, now_ms()],
    )?;
    Ok(())
}

fn set_process_id(conn: &Connection, id: &str, process_id: Option<u32>) -> Result<()> {
    conn.execute(
        "UPDATE sessions SET process_id = ?2 WHERE id = ?1",
        rusqlite::params![id, process_id.map(i64::from)],
    )?;
    Ok(())
}

pub fn set_title(conn: &Connection, id: &str, title: &str) -> Result<Session> {
    if title.trim().is_empty() {
        return Err(Error::Invalid("a session name cannot be empty".into()));
    }
    let affected = conn.execute(
        "UPDATE sessions SET title = ?2, updated_at = ?3 WHERE id = ?1",
        rusqlite::params![id, title.trim(), now_ms()],
    )?;
    if affected == 0 {
        return Err(Error::SessionNotFound(id.to_string()));
    }
    get(conn, id)
}

pub fn delete(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM sessions WHERE id = ?1", [id])?;
    Ok(())
}

/// Children die with the app, so any session the database still believes is
/// live is stale. Marking them stopped on boot keeps the pane layout and the
/// session titles, and offers Restart instead of a terminal that looks alive
/// but is not.
pub fn reconcile_on_start(conn: &Connection) -> Result<usize> {
    let affected = conn.execute(
        "UPDATE sessions
            SET status = 'stopped', process_id = NULL, updated_at = ?1
          WHERE status <> 'stopped'",
        [now_ms()],
    )?;
    Ok(affected)
}

/// Raw bytes reach the webview as an `ArrayBuffer`. Sending a string instead
/// would have to decode UTF-8 in Rust, which corrupts any multi-byte sequence
/// that happens to straddle a read boundary.
struct ChannelSink(Channel<InvokeResponseBody>);

impl OutputSink for ChannelSink {
    fn emit(&self, bytes: &[u8]) {
        let _ = self.0.send(InvokeResponseBody::Raw(bytes.to_vec()));
    }
}

fn command_for(kind: SessionKind) -> Result<(String, Vec<String>)> {
    match kind {
        SessionKind::Grok => Ok((
            resolve_program("grok")?,
            // The working directory is set on the process itself, so `--cwd`
            // would be a second source of truth. `--no-auto-update` keeps
            // background update checks out of an automated session.
            vec!["--no-auto-update".to_string()],
        )),
        SessionKind::Shell => Ok((
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string()),
            Vec::new(),
        )),
    }
}

/// A macOS app launched from Finder does not inherit the shell's `PATH`, so a
/// `grok` installed into a user-local bin directory is invisible to a plain
/// `PATH` lookup. Check the usual install locations before giving up.
fn resolve_program(program: &str) -> Result<String> {
    if program.contains('/') {
        return Ok(program.to_string());
    }

    if let Some(found) = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .map(|dir| dir.join(program))
        .find(|candidate| candidate.is_file())
    {
        return Ok(found.to_string_lossy().into_owned());
    }

    let home = dirs::home_dir();
    let fallbacks = [
        home.as_ref().map(|home| home.join(".local/bin")),
        home.as_ref().map(|home| home.join(".grok/bin")),
        Some(PathBuf::from("/usr/local/bin")),
        Some(PathBuf::from("/opt/homebrew/bin")),
    ];
    for dir in fallbacks.into_iter().flatten() {
        let candidate = dir.join(program);
        if candidate.is_file() {
            return Ok(candidate.to_string_lossy().into_owned());
        }
    }

    Err(Error::Pty(format!(
        "could not find `{program}` on PATH or in the usual install locations. \
         Install it with: curl -fsSL https://x.ai/cli/install.sh | bash"
    )))
}

/// What a session is told about itself, so an agent can report its plan into the
/// one graph file this terminal draws. Failing to prepare the directory is not
/// worth refusing to start a terminal over: the variables are still exported, so
/// a writer that creates the directory itself works either way.
fn graph_env(project_path: &Path, session_id: &str) -> Vec<(String, String)> {
    let dir = graph::ensure_graph_dir(project_path)
        .unwrap_or_else(|_| graph::project_graph_dir(project_path));
    let file = dir.join(graph::graph_file_name(session_id));
    vec![
        ("GROKSPACE_SESSION_ID".to_string(), session_id.to_string()),
        (
            "GROKSPACE_PROJECT_DIR".to_string(),
            project_path.to_string_lossy().into_owned(),
        ),
        (
            "GROKSPACE_GRAPH_DIR".to_string(),
            dir.to_string_lossy().into_owned(),
        ),
        (
            "GROKSPACE_GRAPH_FILE".to_string(),
            file.to_string_lossy().into_owned(),
        ),
    ]
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionExited {
    id: String,
    exit_code: Option<i32>,
}

fn exit_handler(app: AppHandle, id: String) -> ExitHandler {
    Box::new(move |exit| {
        let state = app.state::<AppState>();
        // Dropping the pty handles is what lets the reader thread finish.
        state.pty.remove(&id);
        if let Ok(conn) = state.db.lock() {
            let _ = set_status(&conn, &id, SessionStatus::Stopped, exit.code);
        }
        let _ = app.emit(
            EXIT_EVENT,
            SessionExited {
                id: id.clone(),
                exit_code: exit.code,
            },
        );
    })
}

struct StartRequest {
    project_id: String,
    pane_id: String,
    kind: SessionKind,
    title: Option<String>,
    cols: u16,
    rows: u16,
}

/// Creates the row first and spawns second. The other order races: a child that
/// exits immediately would fire its exit handler before the row it needs to
/// update exists.
fn start(app: &AppHandle, state: &State<'_, AppState>, request: StartRequest) -> Result<Session> {
    let (program, args) = command_for(request.kind)?;

    let (session, cwd) = {
        let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
        let project = project::get(&conn, &request.project_id)?;
        let title = request
            .title
            .unwrap_or_else(|| request.kind.default_title().to_string());
        (
            insert(
                &conn,
                &request.project_id,
                &request.pane_id,
                request.kind,
                &title,
            )?,
            project.path,
        )
    };

    let cwd = PathBuf::from(cwd);
    let spawned = state.pty.spawn(
        SpawnOptions {
            id: session.id.clone(),
            program,
            args,
            env: graph_env(&cwd, &session.id),
            cwd,
            cols: request.cols,
            rows: request.rows,
        },
        exit_handler(app.clone(), session.id.clone()),
    );

    match spawned {
        Ok(process_id) => {
            let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
            // Only the pid is written back: if the child already exited, its
            // handler has set the status and must not be overwritten.
            set_process_id(&conn, &session.id, process_id)?;
            get(&conn, &session.id)
        }
        Err(error) => {
            // Nothing was started, so leave no orphan row behind for a pane
            // that is about to go back to being empty.
            if let Ok(conn) = state.db.lock() {
                let _ = delete(&conn, &session.id);
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub fn list_sessions(state: State<'_, AppState>, project_id: String) -> Result<Vec<Session>> {
    let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
    list(&conn, &project_id)
}

#[tauri::command]
pub fn create_session(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    pane_id: String,
    kind: SessionKind,
    cols: u16,
    rows: u16,
) -> Result<Session> {
    start(
        &app,
        &state,
        StartRequest {
            project_id,
            pane_id,
            kind,
            title: None,
            cols,
            rows,
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
    state.pty.attach(&id, Arc::new(ChannelSink(on_output)))
}

#[tauri::command]
pub fn write_session(state: State<'_, AppState>, id: String, data: String) -> Result<()> {
    state.pty.write(&id, data.as_bytes())
}

#[tauri::command]
pub fn resize_session(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> Result<()> {
    state.pty.resize(&id, cols, rows)
}

#[tauri::command]
pub fn stop_session(state: State<'_, AppState>, id: String) -> Result<()> {
    state.pty.kill(&id)
}

/// Restarting starts a fresh session in the same pane rather than reusing the
/// row. Killing is asynchronous, so reusing the id would race the old child's
/// exit handler against the new child's registration.
#[tauri::command]
pub fn restart_session(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<Session> {
    let previous = {
        let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
        get(&conn, &id)?
    };

    close(&state, &id)?;

    start(
        &app,
        &state,
        StartRequest {
            pane_id: previous.pane_id.unwrap_or_else(|| "0".to_string()),
            project_id: previous.project_id,
            kind: previous.kind,
            title: previous.title,
            cols,
            rows,
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

fn close(state: &State<'_, AppState>, id: &str) -> Result<()> {
    let _ = state.pty.kill(id);
    state.pty.remove(id);
    let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
    // Before the row goes, since the session is the only way back to the project
    // whose folder holds the graph. Nothing can surface this file again once the id
    // is gone from the database, and restarting closes a session too, so leaving it
    // meant every restart added one.
    if let Ok(session) = get(&conn, id) {
        if let Ok(project) = project::get(&conn, &session.project_id) {
            graph::remove_graph(Path::new(&project.path), id);
        }
    }
    delete(&conn, id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::project;

    fn fixture() -> (Connection, String) {
        let conn = db::open_in_memory().expect("in-memory database should open");
        let project =
            project::upsert_by_path(&conn, "/tmp/grokspace-test", "grokspace-test").unwrap();
        (conn, project.id)
    }

    #[test]
    fn a_new_session_starts_running_in_its_pane() {
        let (conn, project_id) = fixture();

        let session = insert(&conn, &project_id, "1", SessionKind::Grok, "Grok").unwrap();

        assert_eq!(session.status, SessionStatus::Running);
        assert_eq!(session.kind, SessionKind::Grok);
        assert_eq!(session.pane_id.as_deref(), Some("1"));
        assert_eq!(session.exit_code, None);
    }

    #[test]
    fn sessions_are_listed_per_project_in_creation_order() {
        let (conn, project_id) = fixture();
        let other = project::upsert_by_path(&conn, "/tmp/other", "other").unwrap();

        insert(&conn, &project_id, "0", SessionKind::Grok, "First").unwrap();
        insert(&conn, &project_id, "1", SessionKind::Shell, "Second").unwrap();
        insert(&conn, &other.id, "0", SessionKind::Grok, "Elsewhere").unwrap();

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
        let session = insert(&conn, &project_id, "0", SessionKind::Shell, "Shell").unwrap();

        set_status(&conn, &session.id, SessionStatus::Stopped, Some(130)).unwrap();

        let reloaded = get(&conn, &session.id).unwrap();
        assert_eq!(reloaded.status, SessionStatus::Stopped);
        assert_eq!(reloaded.exit_code, Some(130));
    }

    #[test]
    fn renaming_rejects_an_empty_title() {
        let (conn, project_id) = fixture();
        let session = insert(&conn, &project_id, "0", SessionKind::Grok, "Grok").unwrap();

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
        let running = insert(&conn, &project_id, "0", SessionKind::Grok, "Grok").unwrap();
        set_process_id(&conn, &running.id, Some(4242)).unwrap();
        let already_stopped = insert(&conn, &project_id, "1", SessionKind::Shell, "Shell").unwrap();
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
    fn removing_a_project_takes_its_sessions_with_it() {
        let (conn, project_id) = fixture();
        insert(&conn, &project_id, "0", SessionKind::Grok, "Grok").unwrap();

        project::remove(&conn, &project_id).unwrap();

        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(remaining, 0);
    }

    #[test]
    fn a_session_is_told_where_its_own_graph_belongs() {
        let dir = tempfile::tempdir().expect("temp dir should be created");

        let env = graph_env(dir.path(), "session-42");

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
    }

    #[test]
    fn two_sessions_in_one_project_get_different_graph_files() {
        let dir = tempfile::tempdir().expect("temp dir should be created");

        let first = graph_env(dir.path(), "s1");
        let second = graph_env(dir.path(), "s2");

        let graph_file = |env: &[(String, String)]| {
            env.iter()
                .find(|(name, _)| name == "GROKSPACE_GRAPH_FILE")
                .map(|(_, value)| value.clone())
                .expect("the graph file should be exported")
        };
        assert_ne!(graph_file(&first), graph_file(&second));
    }

    #[test]
    fn a_shell_session_resolves_to_a_real_program() {
        let (program, _) = command_for(SessionKind::Shell).unwrap();

        assert!(
            PathBuf::from(&program).is_file(),
            "expected a runnable shell, got {program}"
        );
    }

    #[test]
    fn resolving_a_missing_program_explains_how_to_install_it() {
        let error = resolve_program("grokspace-no-such-binary").unwrap_err();

        let message = error.to_string();
        assert!(message.contains("grokspace-no-such-binary"));
        assert!(message.contains("x.ai/cli"));
    }
}
