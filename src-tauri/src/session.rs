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
use crate::{acp, graph, memory, program, project, AppState};

const COLUMNS: &str = "id, project_id, pane_id, process_id, status, title, role, \
                       worktree_path, kind, exit_code, created_at, updated_at";

/// Emitted when a child terminates. Status changes are infrequent, so the event
/// system is the right fit here; the output stream is not, and uses a channel.
const EXIT_EVENT: &str = "session-exited";

/// An agent's status changed. Only ACP sessions report these: a terminal has no
/// way to say what the process inside it is doing.
const STATUS_EVENT: &str = "session-status";

/// An agent is blocked on a permission it wants granted.
const PERMISSION_EVENT: &str = "session-permission";

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
    /// An interactive Grok Build agent, rendered as a terminal.
    Grok,
    /// A plain login shell, useful next to the agents and the easiest way to
    /// exercise the pty layer without depending on the `grok` binary.
    Shell,
    /// A Grok agent driven over ACP rather than shown as a terminal.
    ///
    /// It has no pty, so no pane draws it; what it has instead is a status worth
    /// reading. See [`crate::acp`] for why the two cannot be the same process.
    Agent,
}

impl SessionKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Grok => "grok",
            Self::Shell => "shell",
            Self::Agent => "agent",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "shell" => Self::Shell,
            "agent" => Self::Agent,
            _ => Self::Grok,
        }
    }

    fn default_title(self) -> &'static str {
        match self {
            Self::Grok => "Grok",
            Self::Shell => "Shell",
            Self::Agent => "Agent",
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
    /// Permission prompts the agent is blocked on. Filled by `list`, not by `from_row`.
    #[serde(default)]
    pub pending_permissions: Vec<PendingPermission>,
}

/// What the frontend needs to put Allow/Deny on a card after a reload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingPermission {
    pub request_id: u64,
    pub summary: String,
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
        pending_permissions: Vec::new(),
    })
}

pub fn list(conn: &Connection, project_id: &str) -> Result<Vec<Session>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM sessions WHERE project_id = ?1 ORDER BY created_at ASC"
    ))?;
    let mut sessions = stmt
        .query_map([project_id], from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    attach_permissions(conn, &mut sessions)?;
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

/// `pane_id` is absent for an agent, which occupies no pane. Nothing else in the
/// app has to special-case that: a session with no pane is simply never the one
/// `session_for_pane` finds.
///
/// `role` is what a session was started as - Planner, Reviewer, and so on - and is
/// absent for one started by hand. It is a label plus the brief the caller sends;
/// nothing in the schema constrains it, because the presets are the frontend's to
/// name and a role nobody recognised should still be remembered.
pub fn insert(
    conn: &Connection,
    project_id: &str,
    pane_id: Option<&str>,
    kind: SessionKind,
    title: &str,
    role: Option<&str>,
) -> Result<Session> {
    let now = now_ms();
    let role = role.map(str::trim).filter(|role| !role.is_empty());
    let session = conn.query_row(
        &format!(
            "INSERT INTO sessions
                 (id, project_id, pane_id, status, title, role, kind, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
             RETURNING {COLUMNS}"
        ),
        rusqlite::params![
            uuid::Uuid::new_v4().to_string(),
            project_id,
            pane_id,
            SessionStatus::Running.as_str(),
            title,
            role,
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
    if status == SessionStatus::Stopped {
        conn.execute(
            "UPDATE sessions
                SET status = ?2, exit_code = ?3, process_id = NULL, updated_at = ?4
              WHERE id = ?1",
            rusqlite::params![id, status.as_str(), exit_code, now_ms()],
        )?;
        conn.execute(
            "DELETE FROM session_permissions WHERE session_id = ?1",
            [id],
        )?;
        return Ok(());
    }
    conn.execute(
        "UPDATE sessions SET status = ?2, exit_code = ?3, updated_at = ?4 WHERE id = ?1",
        rusqlite::params![id, status.as_str(), exit_code, now_ms()],
    )?;
    Ok(())
}

fn record_live_process(
    conn: &Connection,
    id: &str,
    kind: SessionKind,
    process_id: Option<u32>,
) -> Result<()> {
    set_process_id(conn, id, process_id)?;
    // An ACP session that has finished its handshake is idle until something is
    // asked of it. Leaving it `running` made "ask for a graph" refuse to fire.
    // A child that already exited has been marked stopped by its close handler;
    // overwriting that would bring a dead agent back to life on the board.
    if kind == SessionKind::Agent {
        let current = get(conn, id)?;
        if current.status != SessionStatus::Stopped {
            set_status(conn, id, SessionStatus::Idle, None)?;
        }
    }
    Ok(())
}

fn attach_permissions(conn: &Connection, sessions: &mut [Session]) -> Result<()> {
    if sessions.is_empty() {
        return Ok(());
    }
    let mut stmt = conn.prepare(
        "SELECT session_id, request_id, summary FROM session_permissions ORDER BY request_id ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            PendingPermission {
                request_id: row.get::<_, i64>(1)? as u64,
                summary: row.get(2)?,
            },
        ))
    })?;
    let mut by_session: std::collections::HashMap<String, Vec<PendingPermission>> =
        std::collections::HashMap::new();
    for row in rows {
        let (session_id, permission) = row?;
        by_session.entry(session_id).or_default().push(permission);
    }
    for session in sessions {
        if let Some(pending) = by_session.remove(&session.id) {
            session.pending_permissions = pending;
        }
    }
    Ok(())
}

pub fn record_permission(
    conn: &Connection,
    session_id: &str,
    request_id: u64,
    summary: &str,
) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO session_permissions (session_id, request_id, summary)
         VALUES (?1, ?2, ?3)",
        rusqlite::params![session_id, request_id as i64, summary],
    )?;
    Ok(())
}

pub fn clear_permission(conn: &Connection, session_id: &str, request_id: u64) -> Result<()> {
    conn.execute(
        "DELETE FROM session_permissions WHERE session_id = ?1 AND request_id = ?2",
        rusqlite::params![session_id, request_id as i64],
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

/// How a session is actually started, once its kind has been resolved to a
/// program. Split from `start` so a program that cannot be found fails before a
/// row is written for it.
enum Launch {
    /// On a pty, drawn in a pane.
    Terminal { program: String, args: Vec<String> },
    /// Over ACP, with no pane at all.
    Agent { program: String },
}

fn command_for(kind: SessionKind) -> Result<Launch> {
    match kind {
        SessionKind::Grok => Ok(Launch::Terminal {
            program: program::resolve("grok")?,
            // The working directory is set on the process itself, so `--cwd`
            // would be a second source of truth. `--no-auto-update` keeps
            // background update checks out of an automated session.
            args: vec!["--no-auto-update".to_string()],
        }),
        SessionKind::Shell => Ok(Launch::Terminal {
            program: std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string()),
            args: Vec::new(),
        }),
        // The subcommand and its flags belong to the ACP layer, which is what
        // knows the protocol it is about to speak.
        SessionKind::Agent => Ok(Launch::Agent {
            program: program::resolve("grok")?,
        }),
    }
}

/// What a session is told about itself: which graph file is its own to write, and
/// where the project's shared memory is to be read.
///
/// Failing to prepare the graph directory is not worth refusing to start a terminal
/// over. The variables are still exported, so a writer that creates the directory
/// itself works either way.
fn session_env(project_path: &Path, session_id: &str) -> Vec<(String, String)> {
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
        (
            "GROKSPACE_MEMORY_FILE".to_string(),
            memory::memory_file(project_path)
                .to_string_lossy()
                .into_owned(),
        ),
    ]
}

/// The role a session was started as, for a skill or a hook to read.
///
/// Kept out of `session_env` because that one is derived from the project and the
/// session id alone, and this comes from the request. Absent rather than empty for a
/// session started by hand: an agent should be able to tell "no role" from a role
/// that happens to be blank.
fn role_env(role: Option<&str>) -> Vec<(String, String)> {
    role.map(str::trim)
        .filter(|role| !role.is_empty())
        .map(|role| vec![("GROKSPACE_SESSION_ROLE".to_string(), role.to_string())])
        .unwrap_or_default()
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionStatusChanged {
    id: String,
    status: SessionStatus,
}

/// What the agent's permission request is called on the frontend. Infrequent, and
/// nothing moves until it is answered, so the event system is the right fit.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PermissionAsked {
    id: String,
    request_id: u64,
    summary: String,
}

/// The three things a live agent reports, each landing in the database first and on
/// the event system second, so a webview that reloads reads the same story.
fn acp_callbacks(app: AppHandle, id: String) -> acp::Callbacks {
    let status_app = app.clone();
    let status_id = id.clone();
    let permission_app = app.clone();
    let permission_id = id.clone();

    acp::Callbacks {
        on_status: std::sync::Arc::new(move |status| {
            let status = match status {
                acp::AgentStatus::Idle => SessionStatus::Idle,
                acp::AgentStatus::Running => SessionStatus::Running,
                acp::AgentStatus::NeedsInput => SessionStatus::NeedsInput,
            };
            let state = status_app.state::<AppState>();
            if let Ok(conn) = state.db.lock() {
                // The exit code stays as it is: this is a change of what the agent
                // is doing, not of whether its process is alive.
                let _ = set_status(&conn, &status_id, status, None);
            }
            let _ = status_app.emit(
                STATUS_EVENT,
                SessionStatusChanged {
                    id: status_id.clone(),
                    status,
                },
            );
        }),
        on_permission: Box::new(move |request| {
            let state = permission_app.state::<AppState>();
            if let Ok(conn) = state.db.lock() {
                let _ = record_permission(&conn, &permission_id, request.id, &request.summary);
            }
            let _ = permission_app.emit(
                PERMISSION_EVENT,
                PermissionAsked {
                    id: permission_id.clone(),
                    request_id: request.id,
                    summary: request.summary,
                },
            );
        }),
        on_closed: Box::new(move || {
            let state = app.state::<AppState>();
            state.acp.remove(&id);
            if let Ok(conn) = state.db.lock() {
                let _ = set_status(&conn, &id, SessionStatus::Stopped, None);
            }
            // Reported as an exit like any other, so the frontend needs no second
            // path for an agent going away.
            let _ = app.emit(
                EXIT_EVENT,
                SessionExited {
                    id: id.clone(),
                    exit_code: None,
                },
            );
        }),
    }
}

struct StartRequest {
    project_id: String,
    pane_id: Option<String>,
    kind: SessionKind,
    title: Option<String>,
    role: Option<String>,
    cols: u16,
    rows: u16,
}

/// Creates the row first and spawns second. The other order races: a child that
/// exits immediately would fire its exit handler before the row it needs to
/// update exists.
fn start(app: &AppHandle, state: &State<'_, AppState>, request: StartRequest) -> Result<Session> {
    let launch = command_for(request.kind)?;

    let (session, cwd, remembered) = {
        let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
        let project = project::get(&conn, &request.project_id)?;
        // A role makes a better title than the kind does: five agents all called
        // "Agent" are five things nobody can tell apart.
        let title = request
            .title
            .or_else(|| request.role.clone())
            .unwrap_or_else(|| request.kind.default_title().to_string());
        (
            insert(
                &conn,
                &request.project_id,
                request.pane_id.as_deref(),
                request.kind,
                &title,
                request.role.as_deref(),
            )?,
            project.path,
            memory::list(&conn, &request.project_id)?,
        )
    };

    let cwd = PathBuf::from(cwd);
    // Deliberately after the lock is dropped, since this writes a file and every
    // command queues on the one connection. Written even when the memory is empty:
    // the session is about to be told to read this path, and a file saying there is
    // nothing to know is friendlier than one that is missing.
    let _ = memory::write_projection(&cwd, &remembered);
    let mut env = session_env(&cwd, &session.id);
    env.extend(role_env(session.role.as_deref()));
    // An agent is told where its graph belongs the same way a terminal is, which is
    // what lets the Graph tab draw a plan for a session that has no pane.
    let spawned = match launch {
        Launch::Terminal { program, args } => state.pty.spawn(
            SpawnOptions {
                id: session.id.clone(),
                program,
                args,
                env,
                cwd,
                cols: request.cols,
                rows: request.rows,
            },
            exit_handler(app.clone(), session.id.clone()),
        ),
        Launch::Agent { program } => state.acp.start(
            acp::StartOptions {
                id: session.id.clone(),
                program,
                cwd,
                env,
            },
            acp_callbacks(app.clone(), session.id.clone()),
        ),
    };

    match spawned {
        Ok(process_id) => {
            let became_idle = {
                let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
                record_live_process(&conn, &session.id, request.kind, process_id)?;
                request.kind == SessionKind::Agent
                    && get(&conn, &session.id)?.status == SessionStatus::Idle
            };
            // After the lock is dropped: the webview has to hear that an agent
            // which just finished its handshake is idle, not still `running`.
            if became_idle {
                let _ = app.emit(
                    STATUS_EVENT,
                    SessionStatusChanged {
                        id: session.id.clone(),
                        status: SessionStatus::Idle,
                    },
                );
            }
            let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
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
}

#[tauri::command]
pub fn create_session(
    app: AppHandle,
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

/// Answers a permission the agent is blocked on. Until this arrives the session
/// stays `needs_input` and the agent does nothing.
#[tauri::command]
pub fn answer_session_permission(
    state: State<'_, AppState>,
    id: String,
    request_id: u64,
    allow: bool,
) -> Result<()> {
    state.acp.answer_permission(&id, request_id, allow)?;
    if let Ok(conn) = state.db.lock() {
        let _ = clear_permission(&conn, &id, request_id);
    }
    Ok(())
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

/// Ends the session, kills its process, and drops its graph file.
///
/// `remove_project` calls this for every session it is about to forget, so a
/// project leaving the sidebar cannot leave `grok` running behind it.
pub(crate) fn close(state: &crate::AppState, id: &str) -> Result<()> {
    // Both are asked without checking which kind this is: whichever manager does
    // not hold the session says so and nothing happens, which is cheaper than
    // reading the row back to find out.
    let _ = state.acp.kill(id);
    state.acp.remove(id);
    let _ = state.pty.kill(id);
    state.pty.remove(id);

    // The project path is read while the row is still there, since the session is
    // the only way back to the folder that holds its graph.
    let project_path = {
        let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
        let path = get(&conn, id)
            .ok()
            .and_then(|session| project::get(&conn, &session.project_id).ok())
            .map(|project| project.path);
        // A row that would not delete means the session is still here, and so is
        // its graph.
        delete(&conn, id)?;
        path
    };

    // Deliberately after the lock is dropped: every command shares this one
    // connection, and remove_file can block on a slow or networked disk. Nothing
    // can surface this file again once the id has left the database, and restarting
    // closes a session too, so leaving it meant every restart added one.
    if let Some(path) = project_path {
        graph::remove_graph(Path::new(&path), id);
    }

    Ok(())
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
    fn a_pending_permission_survives_a_list_round_trip() {
        let (conn, project_id) = fixture();
        let session = insert(&conn, &project_id, None, SessionKind::Agent, "Agent", None).unwrap();

        record_permission(&conn, &session.id, 9, "Write a file").unwrap();

        let listed = list(&conn, &project_id).unwrap();
        assert_eq!(
            listed[0].pending_permissions,
            vec![PendingPermission {
                request_id: 9,
                summary: "Write a file".into(),
            }]
        );

        clear_permission(&conn, &session.id, 9).unwrap();
        assert!(list(&conn, &project_id).unwrap()[0]
            .pending_permissions
            .is_empty());
    }

    #[test]
    fn stopping_a_session_drops_its_pending_permissions() {
        let (conn, project_id) = fixture();
        let session = insert(&conn, &project_id, None, SessionKind::Agent, "Agent", None).unwrap();
        record_permission(&conn, &session.id, 9, "Write a file").unwrap();

        set_status(&conn, &session.id, SessionStatus::Stopped, None).unwrap();

        assert!(list(&conn, &project_id).unwrap()[0]
            .pending_permissions
            .is_empty());
    }
}
