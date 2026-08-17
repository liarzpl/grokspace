//! The task board: rows the Kanban columns are drawn from, and the link from a
//! task to the session working on it.

use rusqlite::{Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::now_ms;
use crate::error::{Error, Result};
use crate::AppState;

/// The assigned session is resolved through a subquery rather than read straight
/// out of the column. `assigned_session_id` has no foreign key — SQLite cannot add
/// one to a table that already exists, and the migrations are append-only — so a
/// closed session would otherwise leave a dangling id behind for the frontend to
/// puzzle over. A task whose session has gone reads as unassigned, which is also
/// the kinder answer: a task outlives the terminal that happened to be on it.
const COLUMNS: &str = "id, project_id, title, description, status, \
                       (SELECT s.id FROM sessions s WHERE s.id = tasks.assigned_session_id) \
                       AS assigned_session_id, \
                       priority, created_at, updated_at";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Backlog,
    InProgress,
    Review,
    Done,
}

impl TaskStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Backlog => "backlog",
            Self::InProgress => "in_progress",
            Self::Review => "review",
            Self::Done => "done",
        }
    }

    /// Anything unrecognised reads as `backlog`: the column values are constrained
    /// by the schema, so a surprise here means a hand-edited database, and the
    /// leftmost column is where a task is easiest to notice and put right.
    fn parse(value: &str) -> Self {
        match value {
            "in_progress" => Self::InProgress,
            "review" => Self::Review,
            "done" => Self::Done,
            _ => Self::Backlog,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub description: Option<String>,
    pub status: TaskStatus,
    pub assigned_session_id: Option<String>,
    pub priority: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

fn from_row(row: &Row<'_>) -> rusqlite::Result<Task> {
    let status: String = row.get("status")?;
    Ok(Task {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        title: row.get("title")?,
        description: row.get("description")?,
        status: TaskStatus::parse(&status),
        assigned_session_id: row.get("assigned_session_id")?,
        priority: row.get("priority")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// Trimmed, and absent rather than empty: a description nobody typed should not
/// read as one that is blank on purpose.
fn clean_description(description: Option<&str>) -> Option<String> {
    description
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn clean_title(title: &str) -> Result<String> {
    let title = title.trim();
    if title.is_empty() {
        return Err(Error::Invalid("a task needs a title".into()));
    }
    Ok(title.to_string())
}

/// Highest priority first, and within one priority the order they were added, so a
/// column reads the same on every load.
pub fn list(conn: &Connection, project_id: &str) -> Result<Vec<Task>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM tasks
          WHERE project_id = ?1
          ORDER BY priority DESC, created_at ASC"
    ))?;
    let tasks = stmt
        .query_map([project_id], from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(tasks)
}

pub fn get(conn: &Connection, id: &str) -> Result<Task> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM tasks WHERE id = ?1"),
        [id],
        from_row,
    )
    .optional()?
    .ok_or_else(|| Error::TaskNotFound(id.to_string()))
}

/// New tasks land in `backlog`. Dispatching is what moves one on, so the board
/// never starts a task in a column that claims work is under way.
pub fn insert(
    conn: &Connection,
    project_id: &str,
    title: &str,
    description: Option<&str>,
) -> Result<Task> {
    let title = clean_title(title)?;
    let description = clean_description(description);
    let now = now_ms();

    let task = conn.query_row(
        &format!(
            "INSERT INTO tasks
                 (id, project_id, title, description, status, priority, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'backlog', 0, ?5, ?5)
             RETURNING {COLUMNS}"
        ),
        rusqlite::params![
            uuid::Uuid::new_v4().to_string(),
            project_id,
            title,
            description,
            now
        ],
        from_row,
    )?;
    Ok(task)
}

/// Whichever fields were supplied. `description` is deliberately not clearable
/// here — `None` means "leave it alone", which is what every caller wants — and
/// the session link has its own function so that unassigning is expressible.
pub fn update(
    conn: &Connection,
    id: &str,
    title: Option<&str>,
    description: Option<&str>,
    status: Option<TaskStatus>,
    priority: Option<i64>,
) -> Result<Task> {
    let title = title.map(clean_title).transpose()?;
    let description = clean_description(description);
    let status = status.map(TaskStatus::as_str);

    let affected = conn.execute(
        "UPDATE tasks
            SET title = COALESCE(?2, title),
                description = COALESCE(?3, description),
                status = COALESCE(?4, status),
                priority = COALESCE(?5, priority),
                updated_at = ?6
          WHERE id = ?1",
        rusqlite::params![id, title, description, status, priority, now_ms()],
    )?;
    if affected == 0 {
        return Err(Error::TaskNotFound(id.to_string()));
    }

    get(conn, id)
}

/// Hands a task to a session and moves it to `in_progress` in one statement.
///
/// The two belong together: a task being worked on is a task in that column, and
/// splitting them would leave a window where the board disagrees with itself. It
/// is also why this is not part of `update`, which has no way to say "no session".
pub fn dispatch(conn: &Connection, id: &str, session_id: &str) -> Result<Task> {
    let affected = conn.execute(
        "UPDATE tasks
            SET assigned_session_id = ?2,
                status = 'in_progress',
                updated_at = ?3
          WHERE id = ?1",
        rusqlite::params![id, session_id, now_ms()],
    )?;
    if affected == 0 {
        return Err(Error::TaskNotFound(id.to_string()));
    }

    get(conn, id)
}

pub fn remove(conn: &Connection, id: &str) -> Result<()> {
    let affected = conn.execute("DELETE FROM tasks WHERE id = ?1", [id])?;
    if affected == 0 {
        return Err(Error::TaskNotFound(id.to_string()));
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
pub fn list_tasks(state: State<'_, AppState>, project_id: String) -> Result<Vec<Task>> {
    with_db(&state, |conn| list(conn, &project_id))
}

#[tauri::command]
pub fn create_task(
    state: State<'_, AppState>,
    project_id: String,
    title: String,
    description: Option<String>,
) -> Result<Task> {
    with_db(&state, |conn| {
        insert(conn, &project_id, &title, description.as_deref())
    })
}

#[tauri::command]
pub fn update_task(
    state: State<'_, AppState>,
    id: String,
    title: Option<String>,
    description: Option<String>,
    status: Option<TaskStatus>,
    priority: Option<i64>,
) -> Result<Task> {
    with_db(&state, |conn| {
        update(
            conn,
            &id,
            title.as_deref(),
            description.as_deref(),
            status,
            priority,
        )
    })
}

#[tauri::command]
pub fn dispatch_task(state: State<'_, AppState>, id: String, session_id: String) -> Result<Task> {
    with_db(&state, |conn| dispatch(conn, &id, &session_id))
}

#[tauri::command]
pub fn remove_task(state: State<'_, AppState>, id: String) -> Result<()> {
    with_db(&state, |conn| remove(conn, &id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::project;
    use crate::session::{self, SessionKind};

    fn fixture() -> (Connection, String) {
        let conn = db::open_in_memory().expect("in-memory database should open");
        let project = project::upsert_by_path(&conn, "/tmp/grokspace-test", "grokspace-test")
            .expect("project should be created");
        (conn, project.id)
    }

    #[test]
    fn a_new_task_starts_in_the_backlog_unassigned() {
        let (conn, project_id) = fixture();

        let task = insert(&conn, &project_id, "  Ship the board  ", None).unwrap();

        assert_eq!(task.title, "Ship the board", "titles are trimmed");
        assert_eq!(task.status, TaskStatus::Backlog);
        assert_eq!(task.assigned_session_id, None);
        assert_eq!(task.priority, 0);
        assert_eq!(task.description, None);
    }

    #[test]
    fn a_blank_description_is_stored_as_none() {
        // Nobody typed one, so it should not read as a description that is empty
        // on purpose.
        let (conn, project_id) = fixture();

        let task = insert(&conn, &project_id, "Title", Some("   \n ")).unwrap();

        assert_eq!(task.description, None);
    }

    #[test]
    fn a_task_needs_a_title() {
        let (conn, project_id) = fixture();

        assert!(insert(&conn, &project_id, "   ", None).is_err());

        let task = insert(&conn, &project_id, "Real", None).unwrap();
        assert!(update(&conn, &task.id, Some("  "), None, None, None).is_err());
    }

    #[test]
    fn tasks_are_listed_per_project_by_priority_then_age() {
        let (conn, project_id) = fixture();
        let other = project::upsert_by_path(&conn, "/tmp/other", "other").unwrap();

        let first = insert(&conn, &project_id, "First", None).unwrap();
        let second = insert(&conn, &project_id, "Second", None).unwrap();
        insert(&conn, &other.id, "Elsewhere", None).unwrap();
        // Pinned rather than timed, so the order does not depend on how fast the
        // inserts ran.
        conn.execute(
            "UPDATE tasks SET created_at = 100 WHERE id = ?1",
            [&first.id],
        )
        .unwrap();
        conn.execute(
            "UPDATE tasks SET created_at = 200 WHERE id = ?1",
            [&second.id],
        )
        .unwrap();

        let titles: Vec<String> = list(&conn, &project_id)
            .unwrap()
            .into_iter()
            .map(|task| task.title)
            .collect();
        assert_eq!(titles, vec!["First", "Second"]);

        update(&conn, &second.id, None, None, None, Some(5)).unwrap();
        let titles: Vec<String> = list(&conn, &project_id)
            .unwrap()
            .into_iter()
            .map(|task| task.title)
            .collect();
        assert_eq!(titles, vec!["Second", "First"], "priority outranks age");
    }

    #[test]
    fn updating_one_field_leaves_the_others_alone() {
        let (conn, project_id) = fixture();
        let task = insert(&conn, &project_id, "Title", Some("Why it matters")).unwrap();

        let moved = update(&conn, &task.id, None, None, Some(TaskStatus::Review), None).unwrap();

        assert_eq!(moved.status, TaskStatus::Review);
        assert_eq!(moved.title, "Title");
        assert_eq!(moved.description.as_deref(), Some("Why it matters"));
        assert!(moved.updated_at >= task.updated_at);
    }

    #[test]
    fn dispatching_assigns_the_session_and_moves_the_task_in_one_step() {
        let (conn, project_id) = fixture();
        let session =
            session::insert(&conn, &project_id, Some("0"), SessionKind::Grok, "Grok").unwrap();
        let task = insert(&conn, &project_id, "Ship it", None).unwrap();

        let dispatched = dispatch(&conn, &task.id, &session.id).unwrap();

        assert_eq!(
            dispatched.assigned_session_id.as_deref(),
            Some(&*session.id)
        );
        assert_eq!(
            dispatched.status,
            TaskStatus::InProgress,
            "a dispatched task is being worked on, and the board has to agree"
        );
    }

    #[test]
    fn a_task_assigned_to_a_session_that_has_gone_reads_as_unassigned() {
        // Closing a session deletes its row, and assigned_session_id has no foreign
        // key to null this out, so the read is what has to be honest.
        let (conn, project_id) = fixture();
        let session =
            session::insert(&conn, &project_id, Some("0"), SessionKind::Grok, "Grok").unwrap();
        let task = insert(&conn, &project_id, "Ship it", None).unwrap();
        dispatch(&conn, &task.id, &session.id).unwrap();

        session::delete(&conn, &session.id).unwrap();

        let orphaned = get(&conn, &task.id).unwrap();
        assert_eq!(orphaned.assigned_session_id, None);
        assert_eq!(
            orphaned.status,
            TaskStatus::InProgress,
            "the work did not stop happening because the terminal closed"
        );
        assert_eq!(
            list(&conn, &project_id).unwrap()[0].assigned_session_id,
            None
        );
    }

    #[test]
    fn removing_a_project_takes_its_tasks_with_it() {
        let (conn, project_id) = fixture();
        insert(&conn, &project_id, "Ship it", None).unwrap();

        project::remove(&conn, &project_id).unwrap();

        assert!(list(&conn, &project_id).unwrap().is_empty());
    }

    #[test]
    fn operations_on_an_unknown_task_report_not_found() {
        let (conn, _project_id) = fixture();

        assert!(matches!(get(&conn, "nope"), Err(Error::TaskNotFound(_))));
        assert!(matches!(
            update(&conn, "nope", Some("Title"), None, None, None),
            Err(Error::TaskNotFound(_))
        ));
        assert!(matches!(
            dispatch(&conn, "nope", "s1"),
            Err(Error::TaskNotFound(_))
        ));
        assert!(matches!(remove(&conn, "nope"), Err(Error::TaskNotFound(_))));
    }
}
