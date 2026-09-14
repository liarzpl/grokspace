//! Session step lists: what this run will do, written by the agent and approved
//! by the person watching it.
//!
//! Distinct from the project task board. That board is how work is handed *to* a
//! session; this list is how the session shows the breakdown *back*. The file is
//! inbound only — agents write it, GrokSpace reads it into SQLite, and edits the
//! user makes go back as a prompt rather than by rewriting the same file.
//!
//! [`store`] owns the rows and paths; [`ingest`] folds the agent's file;
//! the watcher stays here for the next slice.

mod ingest;
mod store;

pub(crate) use ingest::ingest_if_none;
#[cfg(test)]
pub(crate) use ingest::parse_steps_json;
#[allow(unused_imports)]
pub use ingest::{ingest, ingest_from_disk};
#[allow(unused_imports)]
pub use store::{
    add, approve, clear, ensure_steps_dir, home_steps_dir, project_steps_dir, remove,
    remove_steps_file, reopen, reorder, snapshot, steps_file_name, update, SessionStep,
    SessionSteps, StepOrigin, StepStatus, StepsPhase, MAX_STEPS,
};

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::error::{Error, Result};
use crate::skill::{Skill, SkillFile, SkillStatus};
use crate::{project, session, AppState};

const CHANGE_EVENT: &str = "steps-changed";

const SKILL: Skill = Skill {
    dir: "grokspace-steps",
    files: &[SkillFile {
        path: "SKILL.md",
        content: include_str!("../../skills/grokspace-steps/SKILL.md"),
    }],
};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct StepsChanged {
    session_id: String,
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

    fn watch<R: Runtime>(
        &self,
        app: AppHandle<R>,
        project_id: &str,
        project_path: &Path,
    ) -> Result<Vec<String>> {
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
            let mut live = false;
            if let Ok(conn) = state.db.lock() {
                if session::get(&conn, &session_id).is_ok() {
                    live = true;
                    let _ = ingest_from_disk(&conn, &path, &session_id);
                }
            }
            // A close deletes the row and then the file. Emitting for a gone
            // session would make the frontend re-read it and banner SessionNotFound.
            if live {
                let _ = app.emit(
                    CHANGE_EVENT,
                    StepsChanged {
                        session_id: session_id.clone(),
                    },
                );
            }
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
pub fn reopen_session_steps(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SessionSteps> {
    with_db(&state, |conn| reopen(conn, &session_id))
}

#[tauri::command]
pub fn watch_project_steps<R: Runtime>(
    app: AppHandle<R>,
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
    // panel would sit empty until the next save. A list already in SQLite is left
    // alone: re-folding the file would restore agent rows the user had deleted.
    if let Ok(conn) = state.db.lock() {
        let sessions = session::list(&conn, &project_id).unwrap_or_default();
        for live in sessions {
            let _ = ingest_if_none(&conn, path, &live.id);
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
    use crate::db;
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
    fn duplicate_incoming_ids_do_not_wipe_the_list() {
        let (conn, _, session_id) = fixture();
        let snap = ingest(
            &conn,
            &session_id,
            r#"{"steps":[{"id":"a","title":"One"},{"id":"a","title":"Two"}]}"#,
        )
        .unwrap();

        assert_eq!(snap.steps.len(), 2);
        assert_ne!(snap.steps[0].id, snap.steps[1].id);
        assert_eq!(snap.steps[0].title, "One");
        assert_eq!(snap.steps[1].title, "Two");
    }

    #[test]
    fn clear_deletes_the_steps_file() {
        let dir = tempfile::tempdir().expect("temp dir");
        let conn = db::open_in_memory().expect("in-memory database should open");
        let project = project::upsert_by_path(
            &conn,
            dir.path().to_str().expect("utf-8 path"),
            "steps-clear",
        )
        .unwrap();
        let session = session::insert(
            &conn,
            &project.id,
            Some("0"),
            SessionKind::Grok,
            "Grok",
            None,
        )
        .unwrap();
        let steps = ensure_steps_dir(dir.path()).unwrap();
        let file = steps.join(steps_file_name(&session.id));
        std::fs::write(&file, r#"{"steps":[{"title":"The last job"}]}"#).unwrap();
        ingest_from_disk(&conn, dir.path(), &session.id).unwrap();

        clear(&conn, &session.id).unwrap();

        assert!(!file.exists(), "the leftover file would be re-proposed");
        let snap = snapshot(&conn, &session.id).unwrap();
        assert_eq!(snap.phase, StepsPhase::None);
        assert!(snap.steps.is_empty());
    }

    #[test]
    fn approve_refuses_an_agent_that_is_still_working() {
        let conn = db::open_in_memory().expect("in-memory database should open");
        let project =
            project::upsert_by_path(&conn, "/tmp/grokspace-steps-agent", "steps-agent").unwrap();
        let session =
            session::insert(&conn, &project.id, None, SessionKind::Agent, "Agent", None).unwrap();
        session::set_status(&conn, &session.id, session::SessionStatus::Running, None).unwrap();
        ingest(&conn, &session.id, r#"{"steps":[{"title":"Read it"}]}"#).unwrap();

        let error = approve(&conn, &session.id).unwrap_err();
        assert!(error.to_string().contains("idle"));
    }

    #[test]
    fn reopen_puts_an_approved_list_back_to_proposed() {
        let (conn, _, session_id) = fixture();
        ingest(&conn, &session_id, r#"{"steps":[{"title":"Read it"}]}"#).unwrap();
        approve(&conn, &session_id).unwrap();

        let snap = reopen(&conn, &session_id).unwrap();

        assert_eq!(snap.phase, StepsPhase::Proposed);
        assert_eq!(snap.steps.len(), 1);
    }

    #[test]
    fn watch_start_does_not_restore_rows_the_user_deleted() {
        let dir = tempfile::tempdir().expect("temp dir");
        let conn = db::open_in_memory().expect("in-memory database should open");
        let project = project::upsert_by_path(
            &conn,
            dir.path().to_str().expect("utf-8 path"),
            "steps-watch-start",
        )
        .unwrap();
        let session = session::insert(
            &conn,
            &project.id,
            Some("0"),
            SessionKind::Grok,
            "Grok",
            None,
        )
        .unwrap();
        let steps = ensure_steps_dir(dir.path()).unwrap();
        let file = steps.join(steps_file_name(&session.id));
        std::fs::write(
            &file,
            r#"{"steps":[{"id":"a","title":"Keep me"},{"id":"b","title":"Delete me"}]}"#,
        )
        .unwrap();
        ingest_from_disk(&conn, dir.path(), &session.id).unwrap();
        remove(&conn, "b").unwrap();

        let snap = ingest_if_none(&conn, dir.path(), &session.id).unwrap();

        assert_eq!(snap.phase, StepsPhase::Proposed);
        assert_eq!(snap.steps.len(), 1);
        assert_eq!(snap.steps[0].title, "Keep me");
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
