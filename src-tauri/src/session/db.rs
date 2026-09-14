//! Session rows and pending-permission rows in SQLite.

use std::path::Path;

use rusqlite::{Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::acp;
use crate::db::now_ms;
use crate::error::{Error, Result};

const COLUMNS: &str = "id, project_id, pane_id, process_id, status, title, role, \
                       worktree_path, isolation_skip, kind, exit_code, created_at, updated_at";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Idle,
    Running,
    NeedsInput,
    Stopped,
}

impl SessionStatus {
    pub(crate) const ALL: [Self; 4] = [Self::Idle, Self::Running, Self::NeedsInput, Self::Stopped];

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Running => "running",
            Self::NeedsInput => "needs_input",
            Self::Stopped => "stopped",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self> {
        Self::ALL
            .into_iter()
            .find(|item| item.as_str() == value)
            .ok_or_else(|| Error::Invalid(format!("unknown session status `{value}`")))
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
    pub(crate) const ALL: [Self; 3] = [Self::Grok, Self::Shell, Self::Agent];

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Grok => "grok",
            Self::Shell => "shell",
            Self::Agent => "agent",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self> {
        Self::ALL
            .into_iter()
            .find(|item| item.as_str() == value)
            .ok_or_else(|| Error::Invalid(format!("unknown session kind `{value}`")))
    }

    pub(crate) fn default_title(self) -> &'static str {
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
    /// Why this agent is on the project tree. Set when isolation is skipped;
    /// absent when the session isolated or was never meant to.
    pub isolation_skip: Option<String>,
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
    #[serde(default)]
    pub options: Vec<acp::PermissionOption>,
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
        status: SessionStatus::parse(&status).map_err(Error::into_sql)?,
        title: row.get("title")?,
        role: row.get("role")?,
        worktree_path: row.get("worktree_path")?,
        isolation_skip: row.get("isolation_skip")?,
        kind: SessionKind::parse(&kind).map_err(Error::into_sql)?,
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

/// Sessions currently sitting in this pane of this project. There should be at
/// most one; the schema does not enforce it, so `start` closes every occupant
/// before inserting a replacement.
pub(crate) fn sessions_for_pane(
    conn: &Connection,
    project_id: &str,
    pane_id: &str,
) -> Result<Vec<Session>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM sessions WHERE project_id = ?1 AND pane_id = ?2
         ORDER BY created_at ASC"
    ))?;
    let sessions = stmt
        .query_map(rusqlite::params![project_id, pane_id], from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(sessions)
}

/// `pane_id` is absent for an agent, which occupies no pane. Nothing else in the
/// app has to special-case that: a session with no pane is simply never the one
/// `sessions_for_pane` finds.
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

pub(crate) fn set_worktree_path(
    conn: &Connection,
    id: &str,
    path: Option<&Path>,
) -> Result<Session> {
    let stored = path.map(|path| path.to_string_lossy().into_owned());
    conn.execute(
        "UPDATE sessions SET worktree_path = ?2, updated_at = ?3 WHERE id = ?1",
        rusqlite::params![id, stored, now_ms()],
    )?;
    get(conn, id)
}

pub(crate) fn set_isolation_skip(
    conn: &Connection,
    id: &str,
    reason: Option<&str>,
) -> Result<Session> {
    conn.execute(
        "UPDATE sessions SET isolation_skip = ?2, updated_at = ?3 WHERE id = ?1",
        rusqlite::params![id, reason, now_ms()],
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
    // Stopped is terminal. A late ACP handshake Idle must not revive a child
    // the waiter already marked dead — the same rule as `record_live_process`.
    let current = get(conn, id)?;
    if current.status == SessionStatus::Stopped {
        return Ok(());
    }
    conn.execute(
        "UPDATE sessions SET status = ?2, exit_code = ?3, updated_at = ?4 WHERE id = ?1",
        rusqlite::params![id, status.as_str(), exit_code, now_ms()],
    )?;
    Ok(())
}

pub(crate) fn record_live_process(
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
    // Only the sessions being listed. The table is not project-scoped, so a
    // full scan would walk every live agent's prompts on every project switch.
    let placeholders = sessions.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
    let sql = format!(
        "SELECT session_id, request_id, summary, options
           FROM session_permissions
          WHERE session_id IN ({placeholders})
          ORDER BY request_id ASC"
    );
    let ids: Vec<&str> = sessions.iter().map(|session| session.id.as_str()).collect();
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(ids), |row| {
        let options_json: String = row.get(3)?;
        Ok((
            row.get::<_, String>(0)?,
            PendingPermission {
                request_id: row.get::<_, i64>(1)? as u64,
                summary: row.get(2)?,
                options: serde_json::from_str(&options_json).unwrap_or_default(),
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
    options: &[acp::PermissionOption],
) -> Result<()> {
    let options_json = serde_json::to_string(options)?;
    conn.execute(
        "INSERT OR REPLACE INTO session_permissions (session_id, request_id, summary, options)
         VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![session_id, request_id as i64, summary, options_json],
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

pub(crate) fn permission_summary(conn: &Connection, session_id: &str, request_id: u64) -> String {
    conn.query_row(
        "SELECT summary FROM session_permissions WHERE session_id = ?1 AND request_id = ?2",
        rusqlite::params![session_id, request_id as i64],
        |row| row.get(0),
    )
    .unwrap_or_default()
}

pub(crate) fn set_process_id(conn: &Connection, id: &str, process_id: Option<u32>) -> Result<()> {
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
    // Same cleanup as `set_status(Stopped)`. A crash leaves permission rows
    // that `list` would otherwise attach as Allow/Deny on a dead process.
    conn.execute(
        "DELETE FROM session_permissions
          WHERE session_id IN (SELECT id FROM sessions WHERE status = 'stopped')",
        [],
    )?;
    Ok(affected)
}
