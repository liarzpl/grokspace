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
use crate::{acp, graph, memory, program, project, steps, task, worktree, AppState};

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

/// An ACP session produced visible output: a message, a thought, a tool, or a plan.
const UPDATE_EVENT: &str = "session-update";

/// Isolation did not happen. The session still starts; the UI has to say so.
const ISOLATION_EVENT: &str = "session-isolation";

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

fn set_worktree_path(conn: &Connection, id: &str, path: Option<&Path>) -> Result<Session> {
    let stored = path.map(|path| path.to_string_lossy().into_owned());
    conn.execute(
        "UPDATE sessions SET worktree_path = ?2, updated_at = ?3 WHERE id = ?1",
        rusqlite::params![id, stored, now_ms()],
    )?;
    get(conn, id)
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

/// What a session is told about itself: which graph and steps files are its own
/// to write, and where the project's shared memory is to be read.
///
/// Failing to prepare those directories is not worth refusing to start a terminal
/// over. The variables are still exported, so a writer that creates the directory
/// itself works either way.
fn session_env(project_path: &Path, session_id: &str) -> Vec<(String, String)> {
    let dir = graph::ensure_graph_dir(project_path)
        .unwrap_or_else(|_| graph::project_graph_dir(project_path));
    let file = dir.join(graph::graph_file_name(session_id));
    let steps_dir = steps::ensure_steps_dir(project_path)
        .unwrap_or_else(|_| steps::project_steps_dir(project_path));
    let steps_file = steps_dir.join(steps::steps_file_name(session_id));
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
            "GROKSPACE_STEPS_DIR".to_string(),
            steps_dir.to_string_lossy().into_owned(),
        ),
        (
            "GROKSPACE_STEPS_FILE".to_string(),
            steps_file.to_string_lossy().into_owned(),
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionUpdated {
    id: String,
    kind: acp::UpdateKind,
    text: String,
}

/// Why this agent is on the project tree. Infrequent, and the row still starts,
/// so the event system carries the reason without a schema change.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct IsolationFailed {
    id: String,
    reason: String,
}

/// The three things a live agent reports, each landing in the database first and on
/// the event system second, so a webview that reloads reads the same story.
fn acp_callbacks(app: AppHandle, id: String) -> acp::Callbacks {
    let status_app = app.clone();
    let status_id = id.clone();
    let permission_app = app.clone();
    let permission_id = id.clone();
    let update_app = app.clone();
    let update_id = id.clone();

    acp::Callbacks {
        on_status: std::sync::Arc::new(move |status| {
            let status = match status {
                acp::AgentStatus::Idle => SessionStatus::Idle,
                acp::AgentStatus::Running => SessionStatus::Running,
                acp::AgentStatus::NeedsInput => SessionStatus::NeedsInput,
            };
            let state = status_app.state::<AppState>();
            let mut reviewed_project = None;
            if let Ok(conn) = state.db.lock() {
                // The exit code stays as it is: this is a change of what the agent
                // is doing, not of whether its process is alive.
                let _ = set_status(&conn, &status_id, status, None);
                if status == SessionStatus::Idle {
                    if let Ok(session) = get(&conn, &status_id) {
                        if let Ok(project) = project::get(&conn, &session.project_id) {
                            if let Ok(moved) =
                                task::review_on_idle(&conn, &status_id, Path::new(&project.path))
                            {
                                reviewed_project =
                                    moved.first().map(|task| task.project_id.clone());
                            }
                        }
                    }
                }
            }
            let _ = status_app.emit(
                STATUS_EVENT,
                SessionStatusChanged {
                    id: status_id.clone(),
                    status,
                },
            );
            if let Some(project_id) = reviewed_project {
                let _ = status_app.emit(task::CHANGE_EVENT, task::TasksChanged { project_id });
            }
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
        on_update: std::sync::Arc::new(move |update| {
            let _ = update_app.emit(
                UPDATE_EVENT,
                SessionUpdated {
                    id: update_id.clone(),
                    kind: update.kind,
                    text: update.text,
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
    /// Set on Restart so a new row keeps the files the previous run wrote.
    reuse_worktree: Option<PathBuf>,
}

/// A clean checkout for an ACP agent, when git will give us one.
///
/// Grok panes and shells stay on the project folder. Missing git, a folder that
/// is not a repository, or a failed `worktree add` all fall through to that
/// folder rather than refusing to start. `None` here means "not an agent"; a
/// skip is `Some(Skipped(...))`, which is what the UI needs to tell apart from
/// a grok pane that was never meant to isolate.
fn isolate_agent(
    request: &StartRequest,
    session: &Session,
    project_path: &Path,
) -> Option<worktree::Isolation> {
    if request.kind != SessionKind::Agent {
        return None;
    }
    if let Some(existing) = request.reuse_worktree.as_ref().filter(|path| path.is_dir()) {
        return Some(worktree::Isolation::Isolated(existing.clone()));
    }
    Some(worktree::add(project_path, &session.id))
}

/// Creates the row first and spawns second. The other order races: a child that
/// exits immediately would fire its exit handler before the row it needs to
/// update exists.
fn start(app: &AppHandle, state: &State<'_, AppState>, request: StartRequest) -> Result<Session> {
    let launch = command_for(request.kind)?;

    let (session, project_path, remembered) = {
        let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
        let project = project::get(&conn, &request.project_id)?;
        // A role makes a better title than the kind does: five agents all called
        // "Agent" are five things nobody can tell apart.
        let title = request
            .title
            .clone()
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

    let project_path = PathBuf::from(project_path);
    let isolation = isolate_agent(&request, &session, &project_path);
    if let Some(worktree::Isolation::Skipped(skip)) = &isolation {
        // The row still starts. The event is how the UI learns why, without a
        // column to persist it; reload falls back to kind + a null path.
        let _ = app.emit(
            ISOLATION_EVENT,
            IsolationFailed {
                id: session.id.clone(),
                reason: skip.as_str().to_string(),
            },
        );
    }
    let worktree = isolation.and_then(worktree::Isolation::path);
    if let Some(ref path) = worktree {
        // Best-effort: a row without the path still starts, and Diff simply
        // will not offer this session as a scope.
        if let Ok(conn) = state.db.lock() {
            let _ = set_worktree_path(&conn, &session.id, Some(path));
        }
    }

    // Deliberately after the lock is dropped, since this writes a file and every
    // command queues on the one connection. Written even when the memory is empty:
    // the session is about to be told to read this path, and a file saying there is
    // nothing to know is friendlier than one that is missing. Always the project
    // folder, not the worktree: memory is shared.
    let _ = memory::write_projection(&project_path, &remembered);
    let mut env = session_env(&project_path, &session.id);
    env.extend(role_env(session.role.as_deref()));
    if let Some(ref path) = worktree {
        env.push((
            "GROKSPACE_WORKTREE".to_string(),
            path.to_string_lossy().into_owned(),
        ));
    }
    let cwd = worktree.clone().unwrap_or_else(|| project_path.clone());
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
            // that is about to go back to being empty. A worktree created for
            // this attempt would otherwise sit registered until git prune.
            if request.reuse_worktree.is_none() {
                if let Some(ref path) = worktree {
                    let _ = worktree::remove(&project_path, path, true);
                }
            }
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
            reuse_worktree: None,
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
    let (session, project_path) = {
        let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
        let session = get(&conn, &id)?;
        let project = project::get(&conn, &session.project_id)?;
        (session, project.path)
    };
    if session.status != SessionStatus::Stopped {
        return Err(Error::Invalid("stop the agent first".into()));
    }
    let Some(tree) = session.worktree_path.as_deref() else {
        return Err(Error::Invalid("this session has no worktree".into()));
    };
    worktree::remove(Path::new(&project_path), Path::new(tree), true)?;
    let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
    set_worktree_path(&conn, &id, None)
}

/// Merges a stopped agent's worktree into the project branch.
///
/// Uncommitted files are committed on the session branch first: merging a
/// branch that has not moved past the project's `HEAD` would bring nothing.
/// Refused while the process is still running — the merge then removes the
/// tree, which is that process's cwd. Refused when the project tree is dirty,
/// so the agent's commit cannot land on top of uncommitted human work.
#[tauri::command]
pub fn merge_session_worktree(state: State<'_, AppState>, id: String) -> Result<Session> {
    let (session, project_path) = {
        let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
        let session = get(&conn, &id)?;
        let project = project::get(&conn, &session.project_id)?;
        (session, project.path)
    };
    if session.status != SessionStatus::Stopped {
        return Err(Error::Invalid("stop the agent first".into()));
    }
    let Some(tree) = session.worktree_path.as_deref() else {
        return Err(Error::Invalid("this session has no worktree".into()));
    };
    worktree::merge_into_project(
        Path::new(&project_path),
        Path::new(tree),
        &merge_commit_message(&session),
    )?;
    // The work is already on the project. Force-remove so a leftover dirty
    // file cannot block teardown, and clear the path even if git still
    // cannot delete the folder — otherwise a retry hits "nothing to merge".
    let removed = worktree::remove(Path::new(&project_path), Path::new(tree), true);
    let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
    let session = set_worktree_path(&conn, &id, None)?;
    match removed {
        Ok(()) => Ok(session),
        Err(error) => Err(Error::Invalid(format!(
            "the branch landed, but the worktree could not be removed: {error}"
        ))),
    }
}

/// Why Merge would refuse this session, without committing or merging.
///
/// `None` means leftover commit + `git merge --no-edit` may run. Conflicts
/// are not predicted. The Diff panel reads this onto a strip so the reasons
/// are visible before a click, rather than only on the toast afterwards.
#[tauri::command]
pub fn session_merge_readiness(state: State<'_, AppState>, id: String) -> Result<Option<String>> {
    let (session, project_path) = {
        let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
        let session = get(&conn, &id)?;
        let project = project::get(&conn, &session.project_id)?;
        (session, project.path)
    };
    if session.status != SessionStatus::Stopped {
        return Ok(Some("stop the agent first".into()));
    }
    let Some(tree) = session.worktree_path.as_deref() else {
        return Ok(Some("this session has no worktree".into()));
    };
    worktree::merge_refusal(Path::new(&project_path), Path::new(tree))
}

fn merge_commit_message(session: &Session) -> String {
    let label = session
        .title
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .or_else(|| {
            session
                .role
                .as_deref()
                .map(str::trim)
                .filter(|text| !text.is_empty())
        })
        .unwrap_or("agent");
    let label = label.split_whitespace().collect::<Vec<_>>().join(" ");
    format!("GrokSpace: {label}")
}

enum WorktreeTeardown {
    /// `git worktree remove` without `--force`. Dirty trees refuse Close.
    Remove,
    /// Forget-project: the folder is leaving the sidebar, so leftovers must go.
    Force,
    /// Restart: the next row will keep these files.
    Keep,
}

/// Ends the session, kills its process, and drops its graph file.
///
/// `remove_project` calls `close_forgetting` for every session it is about to
/// forget, so a project leaving the sidebar cannot leave `grok` running behind
/// it, or a worktree registered after it is gone.
pub(crate) fn close(state: &crate::AppState, id: &str) -> Result<()> {
    close_with(state, id, WorktreeTeardown::Remove)
}

pub(crate) fn close_forgetting(state: &crate::AppState, id: &str) -> Result<()> {
    close_with(state, id, WorktreeTeardown::Force)
}

fn close_with(state: &crate::AppState, id: &str, teardown: WorktreeTeardown) -> Result<()> {
    let snapshot = {
        let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
        let session = get(&conn, id).ok();
        let project_path = session
            .as_ref()
            .and_then(|session| project::get(&conn, &session.project_id).ok())
            .map(|project| project.path);
        (session, project_path)
    };

    // Dirty check before kill: Close must not eat a live agent's files, and must
    // not kill it only to then refuse.
    if matches!(teardown, WorktreeTeardown::Remove) {
        if let (Some(session), Some(project_path)) = (&snapshot.0, &snapshot.1) {
            if let Some(tree) = session.worktree_path.as_deref() {
                let tree = Path::new(tree);
                if worktree::is_dirty(tree)? {
                    return worktree::remove(Path::new(project_path), tree, false);
                }
            }
        }
    }

    // Both are asked without checking which kind this is: whichever manager does
    // not hold the session says so and nothing happens, which is cheaper than
    // reading the row back to find out.
    let _ = state.acp.kill(id);
    state.acp.remove(id);
    let _ = state.pty.kill(id);
    state.pty.remove(id);

    if let (Some(session), Some(project_path)) = (&snapshot.0, &snapshot.1) {
        if let Some(tree) = session.worktree_path.as_deref() {
            let tree = Path::new(tree);
            match teardown {
                WorktreeTeardown::Remove | WorktreeTeardown::Force => {
                    let force = matches!(teardown, WorktreeTeardown::Force);
                    let _ = worktree::remove(Path::new(project_path), tree, force);
                }
                WorktreeTeardown::Keep => {}
            }
        }
    }

    let project_path = {
        let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
        let path = snapshot.1.clone();
        delete(&conn, id)?;
        path
    };

    // Deliberately after the lock is dropped: every command shares this one
    // connection, and remove_file can block on a slow or networked disk. Nothing
    // can surface this file again once the id has left the database, and restarting
    // closes a session too, so leaving it meant every restart added one.
    if let Some(path) = project_path {
        graph::remove_graph(Path::new(&path), id);
        steps::remove_steps_file(Path::new(&path), id);
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
        };
        assert_eq!(isolate_agent(&request, &session, Path::new("/tmp")), None);
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
        };
        assert_eq!(
            isolate_agent(&request, &session, dir.path()),
            Some(worktree::Isolation::Skipped(
                worktree::IsolationSkip::NotARepo
            ))
        );
    }
}
