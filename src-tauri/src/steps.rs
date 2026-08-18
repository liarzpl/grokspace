//! Session step lists: what this run will do, written by the agent and approved
//! by the person watching it.
//!
//! Distinct from the project task board. That board is how work is handed *to* a
//! session; this list is how the session shows the breakdown *back*. The file is
//! inbound only — agents write it, GrokSpace reads it into SQLite, and edits the
//! user makes go back as a prompt rather than by rewriting the same file.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use rusqlite::{Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::now_ms;
use crate::error::{Error, Result};
use crate::skill::{Skill, SkillFile, SkillStatus};
use crate::{db, project, session, AppState};

const COLUMNS: &str = "id, session_id, sort_index, title, status, origin, created_at, updated_at";

const CHANGE_EVENT: &str = "steps-changed";

/// Twenty titles is a working list. More than that is a dump, and the panel is
/// a checklist, not a scrollback.
pub const MAX_STEPS: usize = 20;

/// A step list is small. Anything past this is almost certainly a log redirected
/// into the file, which we refuse unread.
const MAX_STEPS_BYTES: u64 = 64 * 1024;

const SKILL: Skill = Skill {
    dir: "grokspace-steps",
    files: &[SkillFile {
        path: "SKILL.md",
        content: include_str!("../skills/grokspace-steps/SKILL.md"),
    }],
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepsPhase {
    None,
    Proposed,
    Approved,
}

impl StepsPhase {
    fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Proposed => "proposed",
            Self::Approved => "approved",
        }
    }

    fn parse(value: &str) -> Self {
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
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Doing => "doing",
            Self::Done => "done",
            Self::Skipped => "skipped",
        }
    }

    fn parse(value: &str) -> Self {
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
    fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::User => "user",
        }
    }

    fn parse(value: &str) -> Self {
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

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct StepsChanged {
    session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedStep {
    id: Option<String>,
    title: String,
    status: StepStatus,
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

fn steps_dirs(project_path: &Path) -> Vec<PathBuf> {
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

fn phase_of(conn: &Connection, session_id: &str) -> Result<StepsPhase> {
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

fn set_phase(conn: &Connection, session_id: &str, phase: StepsPhase) -> Result<()> {
    let affected = conn.execute(
        "UPDATE sessions SET steps_phase = ?2, updated_at = ?3 WHERE id = ?1",
        rusqlite::params![session_id, phase.as_str(), now_ms()],
    )?;
    if affected == 0 {
        return Err(Error::SessionNotFound(session_id.to_string()));
    }
    Ok(())
}

fn list_rows(conn: &Connection, session_id: &str) -> Result<Vec<SessionStep>> {
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

fn replace_rows(conn: &Connection, session_id: &str, steps: &[SessionStep]) -> Result<()> {
    conn.execute(
        "DELETE FROM session_steps WHERE session_id = ?1",
        [session_id],
    )?;
    let now = now_ms();
    for (index, step) in steps.iter().enumerate() {
        conn.execute(
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
    Ok(())
}

/// Forgiving parse of an agent's step file. Junk is skipped; the cap is applied
/// after, so a twenty-first real title is dropped rather than taking down the list.
pub fn parse_steps_json(input: &str) -> Vec<ParsedStep> {
    let Ok(value) = serde_json::from_str::<Value>(input) else {
        return Vec::new();
    };
    let array = value
        .get("steps")
        .and_then(Value::as_array)
        .or_else(|| value.as_array());
    let Some(array) = array else {
        return Vec::new();
    };

    array
        .iter()
        .filter_map(|entry| {
            let record = entry.as_object()?;
            let title = record
                .get("title")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|title| !title.is_empty())?;
            let id = record
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_string);
            let status = record
                .get("status")
                .and_then(Value::as_str)
                .map(StepStatus::parse)
                .unwrap_or(StepStatus::Pending);
            Some(ParsedStep {
                id,
                title: title.to_string(),
                status,
            })
        })
        .take(MAX_STEPS)
        .collect()
}

fn read_steps_file(project_path: &Path, session_id: &str) -> Option<String> {
    let file_name = steps_file_name(session_id);
    for dir in steps_dirs(project_path) {
        let candidate = dir.join(&file_name);
        let Ok(metadata) = std::fs::metadata(&candidate) else {
            continue;
        };
        if !metadata.is_file() || metadata.len() > MAX_STEPS_BYTES {
            continue;
        }
        match std::fs::read_to_string(&candidate) {
            Ok(text) if !text.trim().is_empty() => return Some(text),
            _ => continue,
        }
    }
    None
}

fn new_step(
    session_id: &str,
    id: String,
    title: String,
    status: StepStatus,
    origin: StepOrigin,
    sort_index: i64,
) -> SessionStep {
    let now = now_ms();
    SessionStep {
        id,
        session_id: session_id.to_string(),
        sort_index,
        title,
        status,
        origin,
        created_at: now,
        updated_at: now,
    }
}

fn merge_proposed(
    existing: &[SessionStep],
    incoming: &[ParsedStep],
    session_id: &str,
) -> Vec<SessionStep> {
    let mut used_ids = std::collections::HashSet::new();
    let mut merged = Vec::new();

    for parsed in incoming {
        let matched = parsed
            .id
            .as_ref()
            .and_then(|id| existing.iter().find(|step| step.id == *id))
            .or_else(|| {
                existing
                    .iter()
                    .find(|step| step.title == parsed.title && !used_ids.contains(&step.id))
            });

        if let Some(current) = matched {
            used_ids.insert(current.id.clone());
            let title = if current.origin == StepOrigin::User {
                current.title.clone()
            } else {
                parsed.title.clone()
            };
            merged.push(SessionStep {
                title,
                status: parsed.status,
                updated_at: now_ms(),
                ..current.clone()
            });
        } else {
            let id = parsed
                .id
                .clone()
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            used_ids.insert(id.clone());
            merged.push(new_step(
                session_id,
                id,
                parsed.title.clone(),
                parsed.status,
                StepOrigin::Agent,
                merged.len() as i64,
            ));
        }
    }

    for leftover in existing {
        if leftover.origin == StepOrigin::User && !used_ids.contains(&leftover.id) {
            used_ids.insert(leftover.id.clone());
            merged.push(leftover.clone());
        }
    }

    merged.truncate(MAX_STEPS);
    merged
}

fn merge_approved(existing: &[SessionStep], incoming: &[ParsedStep]) -> Vec<SessionStep> {
    let mut next = existing.to_vec();
    let mut claimed = std::collections::HashSet::new();

    for parsed in incoming {
        let position = parsed
            .id
            .as_ref()
            .and_then(|id| next.iter().position(|step| step.id == *id))
            .or_else(|| {
                next.iter()
                    .position(|step| step.title == parsed.title && !claimed.contains(&step.id))
            });

        let Some(position) = position else {
            continue;
        };
        claimed.insert(next[position].id.clone());
        next[position].status = parsed.status;
        next[position].updated_at = now_ms();
    }

    next
}

/// Folds a file the agent wrote into the rows the panel draws.
pub fn ingest(conn: &Connection, session_id: &str, json: &str) -> Result<SessionSteps> {
    let incoming = parse_steps_json(json);
    if incoming.is_empty() {
        return snapshot(conn, session_id);
    }

    let phase = phase_of(conn, session_id)?;
    let existing = list_rows(conn, session_id)?;

    let next = match phase {
        StepsPhase::Approved => merge_approved(&existing, &incoming),
        StepsPhase::None | StepsPhase::Proposed => merge_proposed(&existing, &incoming, session_id),
    };

    replace_rows(conn, session_id, &next)?;
    if phase == StepsPhase::None {
        set_phase(conn, session_id, StepsPhase::Proposed)?;
    }

    snapshot(conn, session_id)
}

pub fn ingest_from_disk(
    conn: &Connection,
    project_path: &Path,
    session_id: &str,
) -> Result<SessionSteps> {
    let Some(json) = read_steps_file(project_path, session_id) else {
        return snapshot(conn, session_id);
    };
    ingest(conn, session_id, &json)
}

/// Drops a session's steps because a new job was handed to it, or because the
/// session itself is gone. The file is the caller's to remove — this only owns
/// the rows.
pub fn clear(conn: &Connection, session_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM session_steps WHERE session_id = ?1",
        [session_id],
    )?;
    // A session that has already been deleted is a successful clear: CASCADE
    // already took the rows, and rewriting steps_phase would fail the FK dance.
    let _ = set_phase(conn, session_id, StepsPhase::None);
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
    set_phase(conn, session_id, StepsPhase::Approved)?;
    snapshot(conn, session_id)
}

fn session_id_for(path: &Path, watched: &[PathBuf]) -> Option<String> {
    let parent = path.parent()?;
    if !watched.iter().any(|dir| dir == parent) {
        return None;
    }
    if path.extension()?.to_str()? != "json" {
        return None;
    }
    let stem = path.file_stem()?.to_str()?;
    (!stem.is_empty()).then(|| stem.to_string())
}

fn watch_dirs(
    dirs: &[PathBuf],
    on_change: impl Fn(String) + Send + 'static,
) -> Result<RecommendedWatcher> {
    let watched = dirs.to_vec();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else { return };
        if !matches!(
            event.kind,
            EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
        ) {
            return;
        }
        for path in &event.paths {
            if let Some(session_id) = session_id_for(path, &watched) {
                on_change(session_id);
            }
        }
    })
    .map_err(|error| Error::Invalid(format!("could not watch for step changes: {error}")))?;

    for dir in dirs {
        watcher
            .watch(dir, RecursiveMode::NonRecursive)
            .map_err(|error| {
                Error::Invalid(format!(
                    "could not watch {}: {error}",
                    dir.to_string_lossy()
                ))
            })?;
    }
    Ok(watcher)
}

fn watched_dirs(project_path: &Path) -> Vec<PathBuf> {
    ensure_steps_dir(project_path)
        .map(|dir| vec![dir])
        .unwrap_or_default()
}

#[derive(Default)]
pub struct StepWatchers {
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
}

impl StepWatchers {
    pub fn new() -> Self {
        Self::default()
    }

    fn watch(&self, app: AppHandle, project_id: &str, project_path: &Path) -> Result<Vec<String>> {
        let existing: Vec<PathBuf> = watched_dirs(project_path)
            .into_iter()
            .filter(|dir| dir.is_dir())
            .collect();
        if existing.is_empty() {
            return Ok(Vec::new());
        }

        let path = project_path.to_path_buf();
        let watcher = watch_dirs(&existing, move |session_id| {
            let state = app.state::<AppState>();
            if let Ok(conn) = state.db.lock() {
                if session::get(&conn, &session_id).is_ok() {
                    let _ = ingest_from_disk(&conn, &path, &session_id);
                }
            }
            let _ = app.emit(
                CHANGE_EVENT,
                StepsChanged {
                    session_id: session_id.clone(),
                },
            );
        })?;

        let mut watchers = self.watchers.lock().map_err(|_| Error::StatePoisoned)?;
        watchers.insert(project_id.to_string(), watcher);

        Ok(existing
            .into_iter()
            .map(|dir| dir.to_string_lossy().into_owned())
            .collect())
    }

    pub fn shutdown(&self) {
        if let Ok(mut watchers) = self.watchers.lock() {
            watchers.clear();
        }
    }
}

fn with_db<T>(
    state: &State<'_, AppState>,
    run: impl FnOnce(&Connection) -> Result<T>,
) -> Result<T> {
    let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
    run(&conn)
}

#[tauri::command]
pub fn list_session_steps(state: State<'_, AppState>, session_id: String) -> Result<SessionSteps> {
    with_db(&state, |conn| snapshot(conn, &session_id))
}

#[tauri::command]
pub fn add_session_step(
    state: State<'_, AppState>,
    session_id: String,
    title: String,
) -> Result<SessionSteps> {
    with_db(&state, |conn| add(conn, &session_id, &title))
}

#[tauri::command]
pub fn update_session_step(
    state: State<'_, AppState>,
    id: String,
    title: Option<String>,
    status: Option<StepStatus>,
) -> Result<SessionSteps> {
    with_db(&state, |conn| update(conn, &id, title.as_deref(), status))
}

#[tauri::command]
pub fn remove_session_step(state: State<'_, AppState>, id: String) -> Result<SessionSteps> {
    with_db(&state, |conn| remove(conn, &id))
}

#[tauri::command]
pub fn reorder_session_steps(
    state: State<'_, AppState>,
    session_id: String,
    ids: Vec<String>,
) -> Result<SessionSteps> {
    with_db(&state, |conn| reorder(conn, &session_id, &ids))
}

#[tauri::command]
pub fn approve_session_steps(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SessionSteps> {
    with_db(&state, |conn| approve(conn, &session_id))
}

#[tauri::command]
pub fn watch_project_steps(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<String>> {
    let project_path = {
        let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
        project::get(&conn, &project_id)?.path
    };
    let path = Path::new(&project_path);
    let watched = state.steps.watch(app, &project_id, path)?;
    // Files written while nothing was watching have to land in SQLite too, or the
    // panel would sit empty until the next save.
    if let Ok(conn) = state.db.lock() {
        let sessions = session::list(&conn, &project_id).unwrap_or_default();
        for live in sessions {
            let _ = ingest_from_disk(&conn, path, &live.id);
        }
    }
    Ok(watched)
}

#[tauri::command]
pub fn steps_skill_status() -> Result<SkillStatus> {
    SKILL.status()
}

#[tauri::command]
pub fn install_steps_skill() -> Result<SkillStatus> {
    SKILL.install()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::SessionKind;

    fn fixture() -> (Connection, String, String) {
        let conn = db::open_in_memory().expect("in-memory database should open");
        let project = project::upsert_by_path(&conn, "/tmp/grokspace-steps", "steps-test")
            .expect("project should be created");
        let session = session::insert(
            &conn,
            &project.id,
            Some("0"),
            SessionKind::Grok,
            "Grok",
            None,
        )
        .unwrap();
        (conn, project.id, session.id)
    }

    #[test]
    fn parse_skips_junk_and_caps_the_list() {
        let parsed = parse_steps_json(
            r#"{ "steps": [
                { "id": "a", "title": "Read it", "status": "doing" },
                { "title": "   " },
                { "title": "Write it" },
                { "not": "a step" }
            ] }"#,
        );
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].id.as_deref(), Some("a"));
        assert_eq!(parsed[0].status, StepStatus::Doing);
        assert_eq!(parsed[1].title, "Write it");
        assert_eq!(parse_steps_json(r#"[{"title":"Root array"}]"#).len(), 1);

        let many = (0..25)
            .map(|n| format!(r#"{{"title":"s{n}"}}"#))
            .collect::<Vec<_>>()
            .join(",");
        assert_eq!(
            parse_steps_json(&format!(r#"{{"steps":[{many}]}}"#)).len(),
            MAX_STEPS
        );
    }

    #[test]
    fn ingest_moves_none_to_proposed() {
        let (conn, _, session_id) = fixture();

        let snap = ingest(
            &conn,
            &session_id,
            r#"{"steps":[{"id":"a","title":"Read auth.ts","status":"pending"}]}"#,
        )
        .unwrap();

        assert_eq!(snap.phase, StepsPhase::Proposed);
        assert_eq!(snap.steps.len(), 1);
        assert_eq!(snap.steps[0].title, "Read auth.ts");
        assert_eq!(snap.steps[0].origin, StepOrigin::Agent);
    }

    #[test]
    fn proposed_keeps_user_titles_and_leftover_user_rows() {
        let (conn, _, session_id) = fixture();
        ingest(
            &conn,
            &session_id,
            r#"{"steps":[{"id":"a","title":"Read it"}]}"#,
        )
        .unwrap();
        update(&conn, "a", Some("Read it carefully"), None).unwrap();
        add(&conn, &session_id, "Also check the tests").unwrap();

        let snap = ingest(
            &conn,
            &session_id,
            r#"{"steps":[{"id":"a","title":"Read src/auth.ts","status":"doing"},{"title":"Write it"}]}"#,
        )
        .unwrap();

        assert_eq!(snap.phase, StepsPhase::Proposed);
        assert_eq!(snap.steps[0].title, "Read it carefully");
        assert_eq!(snap.steps[0].status, StepStatus::Doing);
        assert_eq!(snap.steps[1].title, "Write it");
        assert!(snap
            .steps
            .iter()
            .any(|step| step.title == "Also check the tests"));
    }

    #[test]
    fn approved_applies_status_and_ignores_new_titles() {
        let (conn, _, session_id) = fixture();
        ingest(
            &conn,
            &session_id,
            r#"{"steps":[{"id":"a","title":"Read it"},{"id":"b","title":"Write it"}]}"#,
        )
        .unwrap();
        approve(&conn, &session_id).unwrap();

        let snap = ingest(
            &conn,
            &session_id,
            r#"{"steps":[{"id":"a","title":"changed","status":"done"},{"id":"b","title":"Write it","status":"doing"},{"title":"surprise"}]}"#,
        )
        .unwrap();

        assert_eq!(snap.phase, StepsPhase::Approved);
        assert_eq!(snap.steps.len(), 2);
        assert_eq!(snap.steps[0].title, "Read it");
        assert_eq!(snap.steps[0].status, StepStatus::Done);
        assert_eq!(snap.steps[1].status, StepStatus::Doing);
    }

    #[test]
    fn approve_refuses_an_empty_list() {
        let (conn, _, session_id) = fixture();
        let error = approve(&conn, &session_id).unwrap_err();
        assert!(error.to_string().contains("nothing to approve"));
    }

    #[test]
    fn clear_drops_rows_and_resets_phase() {
        let (conn, _, session_id) = fixture();
        ingest(&conn, &session_id, r#"{"steps":[{"title":"Read it"}]}"#).unwrap();

        clear(&conn, &session_id).unwrap();

        let snap = snapshot(&conn, &session_id).unwrap();
        assert_eq!(snap.phase, StepsPhase::None);
        assert!(snap.steps.is_empty());
    }

    #[test]
    fn reorder_rejects_a_duplicate_id() {
        let (conn, _, session_id) = fixture();
        ingest(
            &conn,
            &session_id,
            r#"{"steps":[{"id":"a","title":"Read it"},{"id":"b","title":"Write it"}]}"#,
        )
        .unwrap();

        let error = reorder(&conn, &session_id, &["a".into(), "a".into()]).unwrap_err();
        assert!(error.to_string().contains("reorder"));
    }

    #[test]
    fn the_bundled_skill_names_the_file_it_relies_on() {
        let runbook = SKILL.content("SKILL.md").expect("a skill needs a SKILL.md");
        assert!(runbook.contains("GROKSPACE_STEPS_FILE"));
        assert!(runbook.contains("wait"));
        assert!(runbook.starts_with("---\n"));
        assert_eq!(SKILL.dir, "grokspace-steps");
    }

    #[test]
    fn a_steps_file_lives_under_the_project_keyed_by_session_id() {
        let path = project_steps_dir(Path::new("/tmp/acme")).join(steps_file_name("abc-123"));
        assert_eq!(
            path,
            PathBuf::from("/tmp/acme/.grokspace/steps/abc-123.json")
        );
    }

    #[test]
    fn closing_removes_only_that_session_file() {
        let dir = tempfile::tempdir().expect("temp dir");
        let steps = ensure_steps_dir(dir.path()).unwrap();
        std::fs::write(steps.join("s1.json"), "{}").unwrap();
        std::fs::write(steps.join("s2.json"), "{}").unwrap();

        remove_steps_file(dir.path(), "s1");

        assert!(!steps.join("s1.json").exists());
        assert!(steps.join("s2.json").exists());
    }
}
