//! Session step rows in SQLite, plus the on-disk file paths they pair with.
//!
//! Ingest and the watcher live in [`super`].

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::db::now_ms;
use crate::error::{Error, Result};
use crate::session::{SessionKind, SessionStatus};
use crate::{db, project, session};

const COLUMNS: &str = "id, session_id, sort_index, title, status, origin, created_at, updated_at";

/// Twenty titles is a working list. More than that is a dump, and the panel is
/// a checklist, not a scrollback.
pub const MAX_STEPS: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepsPhase {
    None,
    Proposed,
    Approved,
}

impl StepsPhase {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Proposed => "proposed",
            Self::Approved => "approved",
        }
    }

    pub(crate) fn parse(value: &str) -> Self {
        match value {
            "proposed" => Self::Proposed,
            "approved" => Self::Approved,
            _ => Self::None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    Pending,
    Doing,
    Done,
    Skipped,
}

impl StepStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Doing => "doing",
            Self::Done => "done",
            Self::Skipped => "skipped",
        }
    }

    pub(crate) fn parse(value: &str) -> Self {
        match value {
            "doing" => Self::Doing,
            "done" => Self::Done,
            "skipped" => Self::Skipped,
            _ => Self::Pending,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepOrigin {
    Agent,
    User,
}

impl StepOrigin {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::User => "user",
        }
    }

    pub(crate) fn parse(value: &str) -> Self {
        if value == "user" {
            Self::User
        } else {
            Self::Agent
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStep {
    pub id: String,
    pub session_id: String,
    pub sort_index: i64,
    pub title: String,
    pub status: StepStatus,
    pub origin: StepOrigin,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSteps {
    pub session_id: String,
    pub phase: StepsPhase,
    pub steps: Vec<SessionStep>,
}

pub fn project_steps_dir(project_path: &Path) -> PathBuf {
    project_path.join(".grokspace").join("steps")
}

pub fn home_steps_dir() -> Result<PathBuf> {
    Ok(db::data_dir()?.join("steps"))
}

pub fn steps_file_name(session_id: &str) -> String {
    format!("{session_id}.json")
}

pub(crate) fn steps_dirs(project_path: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![project_steps_dir(project_path)];
    if let Ok(home) = home_steps_dir() {
        if !dirs.contains(&home) {
            dirs.push(home);
        }
    }
    dirs
}

pub fn ensure_steps_dir(project_path: &Path) -> Result<PathBuf> {
    let preferred = project_steps_dir(project_path);
    if std::fs::create_dir_all(&preferred).is_ok() {
        return Ok(preferred);
    }
    let fallback = home_steps_dir()?;
    std::fs::create_dir_all(&fallback)?;
    Ok(fallback)
}

/// Removes the steps file of a session that is going away for good.
pub fn remove_steps_file(project_path: &Path, session_id: &str) {
    let file_name = steps_file_name(session_id);
    for dir in steps_dirs(project_path) {
        let _ = std::fs::remove_file(dir.join(&file_name));
    }
}

fn from_row(row: &Row<'_>) -> rusqlite::Result<SessionStep> {
    let status: String = row.get("status")?;
    let origin: String = row.get("origin")?;
    Ok(SessionStep {
        id: row.get("id")?,
        session_id: row.get("session_id")?,
        sort_index: row.get("sort_index")?,
        title: row.get("title")?,
        status: StepStatus::parse(&status),
        origin: StepOrigin::parse(&origin),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub(crate) fn phase_of(conn: &Connection, session_id: &str) -> Result<StepsPhase> {
    let value: String = conn
        .query_row(
            "SELECT steps_phase FROM sessions WHERE id = ?1",
            [session_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| Error::SessionNotFound(session_id.to_string()))?;
    Ok(StepsPhase::parse(&value))
}

pub(crate) fn set_phase(conn: &Connection, session_id: &str, phase: StepsPhase) -> Result<()> {
    let affected = conn.execute(
        "UPDATE sessions SET steps_phase = ?2, updated_at = ?3 WHERE id = ?1",
        rusqlite::params![session_id, phase.as_str(), now_ms()],
    )?;
    if affected == 0 {
        return Err(Error::SessionNotFound(session_id.to_string()));
    }
    Ok(())
}

pub(crate) fn list_rows(conn: &Connection, session_id: &str) -> Result<Vec<SessionStep>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM session_steps WHERE session_id = ?1 ORDER BY sort_index ASC"
    ))?;
    let steps = stmt
        .query_map([session_id], from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(steps)
}

pub fn snapshot(conn: &Connection, session_id: &str) -> Result<SessionSteps> {
    Ok(SessionSteps {
        session_id: session_id.to_string(),
        phase: phase_of(conn, session_id)?,
        steps: list_rows(conn, session_id)?,
    })
}

fn clean_title(title: &str) -> Result<String> {
    let title = title.trim();
    if title.is_empty() {
        return Err(Error::Invalid("a step needs a title".into()));
    }
    Ok(title.to_string())
}

pub(crate) fn replace_rows(
    conn: &Connection,
    session_id: &str,
    steps: &[SessionStep],
) -> Result<()> {
    // One transaction so a duplicate id cannot DELETE the list and then fail
    // the INSERT, leaving the panel empty.
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM session_steps WHERE session_id = ?1",
        [session_id],
    )?;
    let now = now_ms();
    for (index, step) in steps.iter().enumerate() {
        tx.execute(
            "INSERT INTO session_steps
                 (id, session_id, sort_index, title, status, origin, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                step.id,
                session_id,
                index as i64,
                step.title,
                step.status.as_str(),
                step.origin.as_str(),
                step.created_at,
                now,
            ],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Drops a session's steps because a new job was handed to it, or because the
/// session itself is gone. The inbound file is removed too: leaving it would
/// let the watcher fold the last job back in as a fresh proposal.
pub fn clear(conn: &Connection, session_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM session_steps WHERE session_id = ?1",
        [session_id],
    )?;
    // A session that has already been deleted is a successful clear: CASCADE
    // already took the rows, and rewriting steps_phase would fail the FK dance.
    let _ = set_phase(conn, session_id, StepsPhase::None);
    if let Ok(live) = session::get(conn, session_id) {
        if let Ok(proj) = project::get(conn, &live.project_id) {
            remove_steps_file(Path::new(&proj.path), session_id);
        }
    }
    Ok(())
}

pub fn add(conn: &Connection, session_id: &str, title: &str) -> Result<SessionSteps> {
    let title = clean_title(title)?;
    let existing = list_rows(conn, session_id)?;
    if existing.len() >= MAX_STEPS {
        return Err(Error::Invalid("a session can hold at most 20 steps".into()));
    }
    let now = now_ms();
    conn.execute(
        "INSERT INTO session_steps
             (id, session_id, sort_index, title, status, origin, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'pending', 'user', ?5, ?5)",
        rusqlite::params![
            uuid::Uuid::new_v4().to_string(),
            session_id,
            existing.len() as i64,
            title,
            now,
        ],
    )?;
    if phase_of(conn, session_id)? == StepsPhase::None {
        set_phase(conn, session_id, StepsPhase::Proposed)?;
    }
    snapshot(conn, session_id)
}

pub fn update(
    conn: &Connection,
    id: &str,
    title: Option<&str>,
    status: Option<StepStatus>,
) -> Result<SessionSteps> {
    let current: SessionStep = conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM session_steps WHERE id = ?1"),
            [id],
            from_row,
        )
        .optional()?
        .ok_or_else(|| Error::Invalid("no step found with that id".into()))?;

    let title = title.map(clean_title).transpose()?;
    let origin = if title.is_some() {
        StepOrigin::User
    } else {
        current.origin
    };
    let status = status.unwrap_or(current.status);

    conn.execute(
        "UPDATE session_steps
            SET title = COALESCE(?2, title),
                status = ?3,
                origin = ?4,
                updated_at = ?5
          WHERE id = ?1",
        rusqlite::params![id, title, status.as_str(), origin.as_str(), now_ms()],
    )?;
    snapshot(conn, &current.session_id)
}

pub fn remove(conn: &Connection, id: &str) -> Result<SessionSteps> {
    let current: SessionStep = conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM session_steps WHERE id = ?1"),
            [id],
            from_row,
        )
        .optional()?
        .ok_or_else(|| Error::Invalid("no step found with that id".into()))?;
    conn.execute("DELETE FROM session_steps WHERE id = ?1", [id])?;
    let remaining = list_rows(conn, &current.session_id)?;
    replace_rows(conn, &current.session_id, &remaining)?;
    if remaining.is_empty() {
        set_phase(conn, &current.session_id, StepsPhase::None)?;
    }
    snapshot(conn, &current.session_id)
}

pub fn reorder(conn: &Connection, session_id: &str, ids: &[String]) -> Result<SessionSteps> {
    let existing = list_rows(conn, session_id)?;
    let unique: HashSet<&String> = ids.iter().collect();
    if unique.len() != ids.len()
        || unique.len() != existing.len()
        || existing.iter().any(|step| !unique.contains(&step.id))
    {
        return Err(Error::Invalid(
            "reorder has to name each of this session's steps once".into(),
        ));
    }
    let by_id: HashMap<_, _> = existing
        .into_iter()
        .map(|step| (step.id.clone(), step))
        .collect();
    let ordered: Vec<SessionStep> = ids.iter().filter_map(|id| by_id.get(id).cloned()).collect();
    replace_rows(conn, session_id, &ordered)?;
    snapshot(conn, session_id)
}

pub fn approve(conn: &Connection, session_id: &str) -> Result<SessionSteps> {
    let current = snapshot(conn, session_id)?;
    if current.steps.is_empty() {
        return Err(Error::Invalid("nothing to approve".into()));
    }
    gate_approve(conn, session_id)?;
    set_phase(conn, session_id, StepsPhase::Approved)?;
    snapshot(conn, session_id)
}

/// Puts an approved list back to `proposed` when the follow-up prompt never
/// landed, so Approve can be tried again.
pub fn reopen(conn: &Connection, session_id: &str) -> Result<SessionSteps> {
    if phase_of(conn, session_id)? == StepsPhase::Approved {
        set_phase(conn, session_id, StepsPhase::Proposed)?;
    }
    snapshot(conn, session_id)
}

fn gate_approve(conn: &Connection, session_id: &str) -> Result<()> {
    let live = session::get(conn, session_id)?;
    match live.kind {
        SessionKind::Shell => Err(Error::Invalid("a shell has no steps to approve".into())),
        SessionKind::Grok if live.status != SessionStatus::Running => {
            Err(Error::Invalid("that session is not running".into()))
        }
        SessionKind::Agent if live.status != SessionStatus::Idle => {
            Err(Error::Invalid("approve when the agent is idle".into()))
        }
        _ => Ok(()),
    }
}
