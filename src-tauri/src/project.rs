use std::path::Path;

use rusqlite::{Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::now_ms;
use crate::error::{Error, Result};
use crate::session;
use crate::settings;
use crate::AppState;

const COLUMNS: &str = "id, name, path, last_opened, settings, created_at";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub last_opened: Option<i64>,
    pub settings: ProjectSettings,
    pub created_at: i64,
}

/// The only project preference this build writes. Unknown keys are refused on
/// the way in so a typo cannot sit in the blob forever.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_layout: Option<String>,
}

impl ProjectSettings {
    fn from_json(raw: &str) -> Self {
        // Hand-edited extra keys must not make the project unreadable. They are
        // dropped here; `update` is what refuses them so they cannot be written.
        let value: serde_json::Value =
            serde_json::from_str(raw).unwrap_or_else(|_| serde_json::json!({}));
        let Some(object) = value.as_object() else {
            return Self::default();
        };
        let terminal_layout = object
            .get("terminalLayout")
            .and_then(|value| value.as_str())
            .filter(|layout| settings::is_pane_layout(layout))
            .map(str::to_string);
        Self { terminal_layout }
    }

    fn validated(self) -> Result<Self> {
        if let Some(layout) = &self.terminal_layout {
            if !settings::is_pane_layout(layout) {
                return Err(Error::Invalid(format!(
                    "`{layout}` is not one of the pane layouts"
                )));
            }
        }
        Ok(self)
    }
}

fn from_row(row: &Row<'_>) -> rusqlite::Result<Project> {
    let settings: String = row.get("settings")?;
    Ok(Project {
        id: row.get("id")?,
        name: row.get("name")?,
        path: row.get("path")?,
        last_opened: row.get("last_opened")?,
        settings: ProjectSettings::from_json(&settings),
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

/// The folder GrokSpace writes into a user project: memory, graphs, steps, worktrees.
pub(crate) const GROKSPACE_DIR: &str = ".grokspace";

/// Contents of `.grokspace/.gitignore`. `*` hides memory, graphs, and worktrees
/// from `git add .`. An existing file, including one a person edited, is left alone.
pub(crate) const GROKSPACE_IGNORE: &str = "*\n";

/// Plants `.grokspace/.gitignore` on the first write under that folder.
///
/// The app used to create the directory and never ignore it, so a later
/// `git add .` committed notes (and anything else under `.grokspace/`). This is
/// idempotent and best-effort at the call site: failing to ignore is not a
/// reason to refuse a memory or graph write.
pub(crate) fn ensure_grokspace_ignored(project_path: &Path) -> Result<()> {
    let dir = project_path.join(GROKSPACE_DIR);
    std::fs::create_dir_all(&dir)?;
    let ignore = dir.join(".gitignore");
    if ignore.exists() {
        return Ok(());
    }
    std::fs::write(ignore, GROKSPACE_IGNORE)?;
    Ok(())
}

pub fn update(
    conn: &Connection,
    id: &str,
    name: Option<&str>,
    settings: Option<&ProjectSettings>,
) -> Result<Project> {
    if let Some(name) = name {
        if name.trim().is_empty() {
            return Err(Error::Invalid("a project name cannot be empty".into()));
        }
    }

    let name = name.map(str::trim);
    let settings = match settings {
        Some(settings) => Some(serde_json::to_string(&settings.clone().validated()?)?),
        None => None,
    };

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

#[tauri::command]
pub fn list_projects(state: State<'_, AppState>) -> Result<Vec<Project>> {
    state.with_db(list)
}

#[tauri::command]
pub fn open_project(state: State<'_, AppState>, path: String) -> Result<Project> {
    state.with_db(|conn| open_folder(conn, &path))
}

#[tauri::command]
pub fn update_project(
    state: State<'_, AppState>,
    id: String,
    name: Option<String>,
    settings: Option<ProjectSettings>,
) -> Result<Project> {
    state.with_db(|conn| update(conn, &id, name.as_deref(), settings.as_ref()))
}

#[tauri::command]
pub fn touch_project(state: State<'_, AppState>, id: String) -> Result<Project> {
    state.with_db(|conn| touch(conn, &id))
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
        session::close_forgetting(state, &session_id)?;
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
        assert_eq!(project.settings, ProjectSettings::default());
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

        let settings = ProjectSettings {
            terminal_layout: Some("2x2".into()),
        };
        let updated = update(&conn, &project.id, None, Some(&settings)).unwrap();
        assert_eq!(updated.settings, settings);
        assert_eq!(
            updated.name, "gamma",
            "settings-only updates must not touch the name"
        );
    }

    #[test]
    fn update_refuses_an_unknown_settings_key_and_an_unknown_layout() {
        let conn = conn();
        let project = upsert_by_path(&conn, "/tmp/kappa", "kappa").unwrap();

        let unknown = serde_json::from_value::<ProjectSettings>(serde_json::json!({
            "terminalLayout": "2x2",
            "lastGraphSession": "s7"
        }));
        assert!(unknown.is_err(), "unknown keys must not deserialize");

        let bad = ProjectSettings {
            terminal_layout: Some("9x9".into()),
        };
        assert!(update(&conn, &project.id, None, Some(&bad)).is_err());
        assert_eq!(
            get(&conn, &project.id).unwrap().settings,
            ProjectSettings::default()
        );
    }

    #[test]
    fn a_hand_edited_blob_keeps_only_a_known_layout() {
        let conn = conn();
        let project = upsert_by_path(&conn, "/tmp/lambda", "lambda").unwrap();
        conn.execute(
            "UPDATE projects SET settings = ?1 WHERE id = ?2",
            rusqlite::params![
                r#"{"terminalLayout":"3x2","lastGraphSession":"s7","terminal_layout":"1x1"}"#,
                project.id
            ],
        )
        .unwrap();

        assert_eq!(
            get(&conn, &project.id).unwrap().settings,
            ProjectSettings {
                terminal_layout: Some("3x2".into()),
            }
        );

        conn.execute(
            "UPDATE projects SET settings = '{\"terminalLayout\":\"9x9\"}' WHERE id = ?1",
            [&project.id],
        )
        .unwrap();
        assert_eq!(
            get(&conn, &project.id).unwrap().settings,
            ProjectSettings::default(),
            "an unknown layout must not be served to the frontend"
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
    fn first_write_under_grokspace_plants_a_star_gitignore() {
        let dir = tempfile::tempdir().expect("temp dir should be created");

        ensure_grokspace_ignored(dir.path()).unwrap();

        let ignore = dir.path().join(GROKSPACE_DIR).join(".gitignore");
        assert_eq!(std::fs::read_to_string(&ignore).unwrap(), GROKSPACE_IGNORE);
        ensure_grokspace_ignored(dir.path()).unwrap();
        assert_eq!(
            std::fs::read_to_string(&ignore).unwrap(),
            GROKSPACE_IGNORE,
            "planting twice must not rewrite the file"
        );
    }

    #[test]
    fn an_existing_grokspace_ignore_is_left_alone() {
        let dir = tempfile::tempdir().expect("temp dir should be created");
        let grokspace = dir.path().join(GROKSPACE_DIR);
        std::fs::create_dir_all(&grokspace).unwrap();
        let ignore = grokspace.join(".gitignore");
        std::fs::write(&ignore, "graphs/\n").unwrap();

        ensure_grokspace_ignored(dir.path()).unwrap();

        assert_eq!(
            std::fs::read_to_string(&ignore).unwrap(),
            "graphs/\n",
            "a person who edited the ignore must keep their rules"
        );
    }

    #[test]
    fn git_add_dot_skips_grokspace_after_it_is_ignored() {
        // The security property: memory and graph files stay out of the index.
        let git = crate::program::find("git").expect("these tests need git");
        let dir = tempfile::tempdir().expect("temp dir should be created");
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.email", "test@grokspace.dev"],
            vec!["config", "user.name", "GrokSpace Test"],
        ] {
            let done = std::process::Command::new(&git)
                .args(&args)
                .current_dir(dir.path())
                .output()
                .expect("git should run");
            assert!(done.status.success(), "git {args:?} failed");
        }
        std::fs::write(dir.path().join("README.md"), "hello\n").unwrap();
        for args in [vec!["add", "."], vec!["commit", "-qm", "first"]] {
            let done = std::process::Command::new(&git)
                .args(&args)
                .current_dir(dir.path())
                .output()
                .expect("git should run");
            assert!(done.status.success(), "git {args:?} failed");
        }

        ensure_grokspace_ignored(dir.path()).unwrap();
        std::fs::write(dir.path().join(GROKSPACE_DIR).join("memory.md"), "secret\n").unwrap();
        let graphs = dir.path().join(GROKSPACE_DIR).join("graphs");
        std::fs::create_dir_all(&graphs).unwrap();
        std::fs::write(graphs.join("s1.json"), "{}\n").unwrap();

        let add = std::process::Command::new(&git)
            .args(["add", "."])
            .current_dir(dir.path())
            .output()
            .expect("git add should run");
        assert!(add.status.success(), "git add . failed");
        let status = std::process::Command::new(&git)
            .args(["status", "--porcelain"])
            .current_dir(dir.path())
            .output()
            .expect("git status should run");
        let porcelain = String::from_utf8_lossy(&status.stdout);
        assert!(
            porcelain.is_empty(),
            "git add . must not stage .grokspace/: {porcelain}"
        );
        let ignored = std::process::Command::new(&git)
            .args(["check-ignore", "-q", ".grokspace/memory.md"])
            .current_dir(dir.path())
            .status()
            .expect("git check-ignore should run");
        assert!(ignored.success(), "memory.md should be ignored");
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
