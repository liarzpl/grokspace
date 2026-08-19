use std::path::Path;

use rusqlite::{Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::now_ms;
use crate::error::{Error, Result};
use crate::session;
use crate::AppState;

const COLUMNS: &str = "id, name, path, last_opened, settings, created_at";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub last_opened: Option<i64>,
    pub settings: serde_json::Value,
    pub created_at: i64,
}

fn from_row(row: &Row<'_>) -> rusqlite::Result<Project> {
    let settings: String = row.get("settings")?;
    Ok(Project {
        id: row.get("id")?,
        name: row.get("name")?,
        path: row.get("path")?,
        last_opened: row.get("last_opened")?,
        // A hand-edited settings blob should not make the whole project unreadable.
        settings: serde_json::from_str(&settings).unwrap_or_else(|_| serde_json::json!({})),
        created_at: row.get("created_at")?,
    })
}

/// Projects the user touched most recently come first; a project that has never
/// been opened falls back to when it was added.
pub fn list(conn: &Connection) -> Result<Vec<Project>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM projects
         ORDER BY COALESCE(last_opened, created_at) DESC, name ASC"
    ))?;
    let projects = stmt
        .query_map([], from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(projects)
}

pub fn get(conn: &Connection, id: &str) -> Result<Project> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM projects WHERE id = ?1"),
        [id],
        from_row,
    )
    .optional()?
    .ok_or_else(|| Error::ProjectNotFound(id.to_string()))
}

/// Registers a folder, keyed on its canonical path. Re-opening a known folder
/// refreshes `last_opened` and keeps the existing row, including any name the
/// user has since chosen, instead of creating a duplicate project.
pub fn upsert_by_path(conn: &Connection, path: &str, name: &str) -> Result<Project> {
    let project = conn.query_row(
        &format!(
            "INSERT INTO projects (id, name, path, last_opened, settings, created_at)
             VALUES (?1, ?2, ?3, ?4, '{{}}', ?4)
             ON CONFLICT (path) DO UPDATE SET last_opened = excluded.last_opened
             RETURNING {COLUMNS}"
        ),
        (uuid::Uuid::new_v4().to_string(), name, path, now_ms()),
        from_row,
    )?;
    Ok(project)
}

/// Validates a folder chosen in the picker and registers it as a project.
pub fn open_folder(conn: &Connection, raw_path: &str) -> Result<Project> {
    let path = Path::new(raw_path);
    if !path.exists() {
        return Err(Error::Invalid(format!("`{raw_path}` no longer exists")));
    }
    if !path.is_dir() {
        return Err(Error::Invalid(format!("`{raw_path}` is not a folder")));
    }

    // Canonicalizing keeps symlinked and relative spellings of the same folder
    // from registering as separate projects.
    let canonical = path.canonicalize()?;
    let canonical_path = canonical
        .to_str()
        .ok_or_else(|| Error::Invalid(format!("`{raw_path}` is not valid UTF-8")))?;
    let name = canonical
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Untitled");

    upsert_by_path(conn, canonical_path, name)
}

pub fn update(
    conn: &Connection,
    id: &str,
    name: Option<&str>,
    settings: Option<&serde_json::Value>,
) -> Result<Project> {
    if let Some(name) = name {
        if name.trim().is_empty() {
            return Err(Error::Invalid("a project name cannot be empty".into()));
        }
    }

    let name = name.map(str::trim);
    let settings = settings.map(serde_json::to_string).transpose()?;

    let affected = conn.execute(
        "UPDATE projects
            SET name = COALESCE(?2, name),
                settings = COALESCE(?3, settings)
          WHERE id = ?1",
        rusqlite::params![id, name, settings],
    )?;
    if affected == 0 {
        return Err(Error::ProjectNotFound(id.to_string()));
    }

    get(conn, id)
}

pub fn touch(conn: &Connection, id: &str) -> Result<Project> {
    let affected = conn.execute(
        "UPDATE projects SET last_opened = ?2 WHERE id = ?1",
        rusqlite::params![id, now_ms()],
    )?;
    if affected == 0 {
        return Err(Error::ProjectNotFound(id.to_string()));
    }

    get(conn, id)
}

/// Forgets a project. This only removes GrokSpace's record of the folder; nothing
/// on disk is touched.
pub fn remove(conn: &Connection, id: &str) -> Result<()> {
    let affected = conn.execute("DELETE FROM projects WHERE id = ?1", [id])?;
    if affected == 0 {
        return Err(Error::ProjectNotFound(id.to_string()));
    }
    Ok(())
}

fn with_db<T>(
    state: &State<'_, AppState>,
    run: impl FnOnce(&Connection) -> Result<T>,
) -> Result<T> {
    let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
    run(&conn)
}

#[tauri::command]
pub fn list_projects(state: State<'_, AppState>) -> Result<Vec<Project>> {
    with_db(&state, list)
}

#[tauri::command]
pub fn open_project(state: State<'_, AppState>, path: String) -> Result<Project> {
    with_db(&state, |conn| open_folder(conn, &path))
}

#[tauri::command]
pub fn update_project(
    state: State<'_, AppState>,
    id: String,
    name: Option<String>,
    settings: Option<serde_json::Value>,
) -> Result<Project> {
    with_db(&state, |conn| {
        update(conn, &id, name.as_deref(), settings.as_ref())
    })
}

#[tauri::command]
pub fn touch_project(state: State<'_, AppState>, id: String) -> Result<Project> {
    with_db(&state, |conn| touch(conn, &id))
}

#[tauri::command]
pub fn remove_project(state: State<'_, AppState>, id: String) -> Result<()> {
    remove_and_stop_sessions(&state, &id)
}

/// Stops every session that belongs to the project, then forgets the project.
///
/// The folder on disk is left alone; the processes are not. CASCADE would drop
/// the rows and leave `grok` running.
pub(crate) fn remove_and_stop_sessions(state: &AppState, id: &str) -> Result<()> {
    let session_ids = {
        let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
        // Unknown project: fail here rather than succeeding at closing nothing.
        let _ = get(&conn, id)?;
        session::list(&conn, id)?
            .into_iter()
            .map(|session| session.id)
            .collect::<Vec<_>>()
    };
    for session_id in session_ids {
        session::close(state, &session_id)?;
    }
    let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
    remove(&conn, id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn conn() -> Connection {
        db::open_in_memory().expect("in-memory database should open")
    }

    #[test]
    fn opening_a_folder_registers_it_with_the_folder_name() {
        let conn = conn();
        let dir = tempfile::tempdir().expect("temp dir should be created");
        let project_dir = dir.path().join("acme-api");
        std::fs::create_dir(&project_dir).expect("project dir should be created");

        let project =
            open_folder(&conn, project_dir.to_str().unwrap()).expect("open should succeed");

        assert_eq!(project.name, "acme-api");
        assert!(project.last_opened.is_some());
        assert_eq!(project.settings, serde_json::json!({}));
        assert_eq!(list(&conn).unwrap().len(), 1);
    }

    #[test]
    fn reopening_the_same_folder_reuses_the_project_and_keeps_its_name() {
        let conn = conn();
        let dir = tempfile::tempdir().expect("temp dir should be created");
        let path = dir.path().to_str().unwrap();

        let first = open_folder(&conn, path).expect("first open should succeed");
        let renamed =
            update(&conn, &first.id, Some("Renamed"), None).expect("rename should succeed");
        let second = open_folder(&conn, path).expect("second open should succeed");

        assert_eq!(
            second.id, first.id,
            "the same folder must not create a second project"
        );
        assert_eq!(
            second.name, "Renamed",
            "reopening must not clobber a user-chosen name"
        );
        assert_eq!(list(&conn).unwrap().len(), 1);
        assert!(second.last_opened >= renamed.last_opened);
    }

    #[test]
    fn opening_a_file_or_missing_path_is_rejected() {
        let conn = conn();
        let dir = tempfile::tempdir().expect("temp dir should be created");
        let file = dir.path().join("README.md");
        std::fs::write(&file, "not a project").expect("file should be written");

        assert!(open_folder(&conn, file.to_str().unwrap()).is_err());
        assert!(open_folder(&conn, dir.path().join("nope").to_str().unwrap()).is_err());
        assert!(list(&conn).unwrap().is_empty());
    }

    #[test]
    fn projects_are_listed_most_recently_opened_first() {
        let conn = conn();
        let alpha = upsert_by_path(&conn, "/tmp/alpha", "alpha").unwrap();
        let beta = upsert_by_path(&conn, "/tmp/beta", "beta").unwrap();

        // `touch` uses wall-clock milliseconds, so pin the values to keep the test
        // independent of how fast the inserts ran.
        conn.execute(
            "UPDATE projects SET last_opened = 100 WHERE id = ?1",
            [&alpha.id],
        )
        .unwrap();
        conn.execute(
            "UPDATE projects SET last_opened = 200 WHERE id = ?1",
            [&beta.id],
        )
        .unwrap();

        let ordered: Vec<String> = list(&conn).unwrap().into_iter().map(|p| p.name).collect();
        assert_eq!(ordered, vec!["beta", "alpha"]);
    }

    #[test]
    fn update_rejects_an_empty_name_and_persists_settings() {
        let conn = conn();
        let project = upsert_by_path(&conn, "/tmp/gamma", "gamma").unwrap();

        assert!(update(&conn, &project.id, Some("   "), None).is_err());

        let settings = serde_json::json!({ "defaultLayout": "2x2" });
        let updated = update(&conn, &project.id, None, Some(&settings)).unwrap();
        assert_eq!(updated.settings, settings);
        assert_eq!(
            updated.name, "gamma",
            "settings-only updates must not touch the name"
        );
    }

    #[test]
    fn removing_a_project_cascades_to_its_child_rows() {
        let conn = conn();
        let project = upsert_by_path(&conn, "/tmp/delta", "delta").unwrap();
        conn.execute(
            "INSERT INTO tasks (id, project_id, title, status, priority, created_at, updated_at)
             VALUES ('t1', ?1, 'Ship it', 'backlog', 0, 0, 0)",
            [&project.id],
        )
        .unwrap();

        remove(&conn, &project.id).unwrap();

        let tasks: i64 = conn
            .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(tasks, 0);
        assert!(list(&conn).unwrap().is_empty());
    }

    #[test]
    fn operations_on_an_unknown_project_report_not_found() {
        let conn = conn();

        assert!(matches!(get(&conn, "nope"), Err(Error::ProjectNotFound(_))));
        assert!(matches!(
            touch(&conn, "nope"),
            Err(Error::ProjectNotFound(_))
        ));
        assert!(matches!(
            remove(&conn, "nope"),
            Err(Error::ProjectNotFound(_))
        ));
    }

    #[test]
    fn forgetting_a_project_closes_its_sessions() {
        // CASCADE would drop the rows and leave a graph file — and a live child —
        // behind. Closing first is what stops the agent.
        let dir = tempfile::tempdir().expect("temp dir");
        let project_path = dir.path().join("acme");
        std::fs::create_dir(&project_path).unwrap();
        let conn = conn();
        let project = upsert_by_path(&conn, project_path.to_str().unwrap(), "acme").unwrap();
        let session = crate::session::insert(
            &conn,
            &project.id,
            None,
            crate::session::SessionKind::Agent,
            "Planner",
            Some("Planner"),
        )
        .unwrap();
        let graph_dir = project_path.join(".grokspace").join("graphs");
        std::fs::create_dir_all(&graph_dir).unwrap();
        let graph_file = graph_dir.join(format!("{}.json", session.id));
        std::fs::write(&graph_file, "{}").unwrap();

        let state = crate::AppState {
            db: std::sync::Mutex::new(conn),
            pty: crate::pty::PtyManager::new(),
            acp: crate::acp::AcpManager::new(),
            graphs: crate::graph::GraphWatchers::new(),
            steps: crate::steps::StepWatchers::new(),
        };

        remove_and_stop_sessions(&state, &project.id).unwrap();

        let conn = state.db.lock().unwrap();
        assert!(matches!(
            get(&conn, &project.id),
            Err(Error::ProjectNotFound(_))
        ));
        assert!(crate::session::list(&conn, &project.id).unwrap().is_empty());
        assert!(
            !graph_file.exists(),
            "close deletes the graph; a cascade-only forget would leave it"
        );
    }
}
