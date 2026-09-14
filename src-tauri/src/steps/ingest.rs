//! Fold an agent's steps file into the SQLite rows the panel draws.
//!
//! The watcher that notices those files lives in [`super::watch`].

use std::collections::HashSet;
use std::path::Path;

use rusqlite::Connection;
use serde_json::Value;

use crate::db::now_ms;
use crate::error::Result;

use super::store::{
    list_rows, phase_of, replace_rows, set_phase, snapshot, steps_dirs, steps_file_name,
    SessionStep, SessionSteps, StepOrigin, StepStatus, StepsPhase, MAX_STEPS,
};

/// A step list is small. Anything past this is almost certainly a log redirected
/// into the file, which we refuse unread.
const MAX_STEPS_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ParsedStep {
    pub(crate) id: Option<String>,
    pub(crate) title: String,
    pub(crate) status: StepStatus,
}

/// Forgiving parse of an agent's step file. Junk is skipped; the cap is applied
/// after, so a twenty-first real title is dropped rather than taking down the list.
pub(crate) fn parse_steps_json(input: &str) -> Vec<ParsedStep> {
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
    let mut used_ids = HashSet::new();
    let mut merged = Vec::new();

    for parsed in incoming {
        let matched = parsed
            .id
            .as_ref()
            .and_then(|id| {
                existing
                    .iter()
                    .find(|step| step.id == *id && !used_ids.contains(&step.id))
            })
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
                .filter(|id| !used_ids.contains(id))
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
    let mut claimed = HashSet::new();

    for parsed in incoming {
        let position = parsed
            .id
            .as_ref()
            .and_then(|id| {
                next.iter()
                    .position(|step| step.id == *id && !claimed.contains(&step.id))
            })
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

/// Fold a leftover file only when this session has no list yet. Re-reading
/// while `proposed` would restore agent rows the user had deleted. Watch-start
/// and idle review share this gate.
pub(crate) fn ingest_if_none(
    conn: &Connection,
    project_path: &Path,
    session_id: &str,
) -> Result<SessionSteps> {
    if phase_of(conn, session_id)? != StepsPhase::None {
        return snapshot(conn, session_id);
    }
    ingest_from_disk(conn, project_path, session_id)
}
