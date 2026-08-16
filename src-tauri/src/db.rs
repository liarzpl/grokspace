use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;

use crate::error::{Error, Result};

/// Ordered list of schema migrations. The index of a migration plus one is the
/// `user_version` recorded once it has been applied, so migrations must only ever
/// be appended.
const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/0001_initial.sql"),
    include_str!("../migrations/0002_session_command.sql"),
];

/// GrokSpace keeps all of its state under `~/.grokspace` rather than the
/// platform app-data directory, so the workspace is easy to inspect and back up.
pub fn data_dir() -> Result<PathBuf> {
    Ok(dirs::home_dir().ok_or(Error::NoHomeDir)?.join(".grokspace"))
}

/// Opens (and creates, if needed) the workspace database in `~/.grokspace`.
pub fn open_default() -> Result<Connection> {
    let dir = data_dir()?;
    std::fs::create_dir_all(&dir)?;
    open_at(&dir.join("grokspace.db"))
}

pub fn open_at(path: &Path) -> Result<Connection> {
    let mut conn = Connection::open(path)?;
    configure(&conn)?;
    migrate(&mut conn)?;
    Ok(conn)
}

#[cfg(test)]
pub fn open_in_memory() -> Result<Connection> {
    let mut conn = Connection::open_in_memory()?;
    configure(&conn)?;
    migrate(&mut conn)?;
    Ok(conn)
}

/// Milliseconds since the Unix epoch, the single time representation used by
/// every timestamp column in the schema.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

fn configure(conn: &Connection) -> Result<()> {
    // `execute_batch` tolerates pragmas such as `journal_mode` that return a row.
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;",
    )?;
    Ok(())
}

fn migrate(conn: &mut Connection) -> Result<()> {
    let applied: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let applied = usize::try_from(applied).unwrap_or(0);

    for (index, sql) in MIGRATIONS.iter().enumerate().skip(applied) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        // `PRAGMA user_version` cannot take a bound parameter.
        tx.execute_batch(&format!("PRAGMA user_version = {};", index + 1))?;
        tx.commit()?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user_version(conn: &Connection) -> i64 {
        conn.query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("user_version should be readable")
    }

    fn table_names(conn: &Connection) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .expect("sqlite_master should be queryable");
        let names = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query should run")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("rows should map");
        names
    }

    #[test]
    fn migrations_create_the_full_data_model() {
        let conn = open_in_memory().expect("in-memory database should open");

        assert_eq!(
            table_names(&conn),
            vec!["memory_entries", "projects", "sessions", "tasks"]
        );
        assert_eq!(user_version(&conn), MIGRATIONS.len() as i64);
    }

    #[test]
    fn reopening_an_existing_database_does_not_rerun_migrations() {
        let dir = tempfile::tempdir().expect("temp dir should be created");
        let path = dir.path().join("grokspace.db");

        let first = open_at(&path).expect("first open should succeed");
        assert_eq!(user_version(&first), MIGRATIONS.len() as i64);
        drop(first);

        // A second open replays the migration loop; it must be a no-op rather than
        // failing on `CREATE TABLE projects` already existing.
        let second = open_at(&path).expect("reopening should succeed");
        assert_eq!(user_version(&second), MIGRATIONS.len() as i64);
    }

    #[test]
    fn foreign_keys_are_enforced() {
        let conn = open_in_memory().expect("in-memory database should open");

        let orphan = conn.execute(
            "INSERT INTO tasks (id, project_id, title, status, priority, created_at, updated_at)
             VALUES ('t1', 'missing-project', 'orphan', 'backlog', 0, 0, 0)",
            [],
        );

        assert!(
            orphan.is_err(),
            "inserting a task for a nonexistent project must violate the foreign key"
        );
    }
}
