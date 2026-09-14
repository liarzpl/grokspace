//! Session step lists: what this run will do, written by the agent and approved
//! by the person watching it.
//!
//! Distinct from the project task board. That board is how work is handed *to* a
//! session; this list is how the session shows the breakdown *back*. The file is
//! inbound only — agents write it, GrokSpace reads it into SQLite, and edits the
//! user makes go back as a prompt rather than by rewriting the same file.
//!
//! [`store`] owns the rows and paths; [`ingest`] folds the agent's file;
//! [`watch`] notices writes and starts the project watcher.

mod ingest;
mod store;
mod watch;

#[cfg(test)]
pub(crate) use ingest::parse_steps_json;
#[allow(unused_imports)]
pub use ingest::{ingest, ingest_from_disk, ingest_json};
pub(crate) use ingest::{ingest_if_none, ingest_if_none_json, read_steps_file};
#[allow(unused_imports)]
pub use store::{
    add, approve, clear, ensure_steps_dir, home_steps_dir, project_steps_dir, remove,
    remove_steps_file, reopen, reorder, snapshot, steps_file_name, update, SessionStep,
    SessionSteps, StepOrigin, StepStatus, StepsPhase, MAX_STEPS,
};
#[allow(unused_imports)]
pub use watch::StepWatchers;

use tauri::{AppHandle, Runtime, State};

use crate::error::Result;
use crate::skill::{Skill, SkillFile};
use crate::AppState;

pub(crate) const SKILL: Skill = Skill {
    dir: "grokspace-steps",
    files: &[SkillFile {
        path: "SKILL.md",
        content: include_str!("../../skills/grokspace-steps/SKILL.md"),
    }],
};

#[tauri::command]
pub fn list_session_steps(state: State<'_, AppState>, session_id: String) -> Result<SessionSteps> {
    state.with_db(|conn| snapshot(conn, &session_id))
}

#[tauri::command]
pub fn add_session_step(
    state: State<'_, AppState>,
    session_id: String,
    title: String,
) -> Result<SessionSteps> {
    state.with_db(|conn| add(conn, &session_id, &title))
}

#[tauri::command]
pub fn update_session_step(
    state: State<'_, AppState>,
    id: String,
    title: Option<String>,
    status: Option<StepStatus>,
) -> Result<SessionSteps> {
    state.with_db(|conn| update(conn, &id, title.as_deref(), status))
}

#[tauri::command]
pub fn remove_session_step(state: State<'_, AppState>, id: String) -> Result<SessionSteps> {
    state.with_db(|conn| remove(conn, &id))
}

#[tauri::command]
pub fn reorder_session_steps(
    state: State<'_, AppState>,
    session_id: String,
    ids: Vec<String>,
) -> Result<SessionSteps> {
    state.with_db(|conn| reorder(conn, &session_id, &ids))
}

#[tauri::command]
pub fn approve_session_steps(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SessionSteps> {
    state.with_db(|conn| approve(conn, &session_id))
}

#[tauri::command]
pub fn reopen_session_steps(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SessionSteps> {
    state.with_db(|conn| reopen(conn, &session_id))
}

#[tauri::command]
pub fn watch_project_steps<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<String>> {
    watch::watch_project_steps(app, state, project_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::project;
    use crate::session;
    use crate::session::SessionKind;
    use rusqlite::Connection;
    use std::path::{Path, PathBuf};

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
