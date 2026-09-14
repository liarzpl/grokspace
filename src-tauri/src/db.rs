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
    include_str!("../migrations/0003_app_settings.sql"),
    include_str!("../migrations/0004_session_permissions.sql"),
    include_str!("../migrations/0005_session_steps.sql"),
    include_str!("../migrations/0006_permission_options.sql"),
];

/// GrokSpace keeps all of its state under `~/.grokspace` rather than the
/// platform app-data directory, so the workspace is easy to inspect and back up.
pub fn data_dir() -> Result<PathBuf> {
    Ok(dirs::home_dir().ok_or(Error::NoHomeDir)?.join(".grokspace"))
}

/// Opens (and creates, if needed) the workspace database in `~/.grokspace`.
///
/// On Unix the directory is `0o700` and the database file is `0o600`, including
/// when they already existed with a looser umask (SEC-006).
pub fn open_default() -> Result<Connection> {
    open_in_dir(&data_dir()?)
}

fn open_in_dir(dir: &Path) -> Result<Connection> {
    ensure_restricted_dir(dir)?;
    let path = dir.join("grokspace.db");
    ensure_restricted_file(&path)?;
    let opened = open_at(&path);
    // Tighten even if open/migrate failed: SQLite may have created the file, or
    // an existing install may still be world-readable.
    let restricted = restrict_unix_mode(&path, 0o600);
    match opened {
        Ok(conn) => {
            restricted?;
            Ok(conn)
        }
        Err(error) => {
            let _ = restricted;
            Err(error)
        }
    }
}

fn ensure_restricted_dir(dir: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)?;
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(dir)?;
    }
    // Existing installs were created with the process umask; tighten those too.
    restrict_unix_mode(dir, 0o700)
}

fn ensure_restricted_file(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(path)?;
    }
    if path.exists() {
        restrict_unix_mode(path, 0o600)?;
    }
    Ok(())
}

fn restrict_unix_mode(path: &Path, mode: u32) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))?;
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
    }
    Ok(())
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
            vec![
                "app_settings",
                "memory_entries",
                "projects",
                "session_permissions",
                "session_steps",
                "sessions",
                "tasks"
            ]
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

    #[cfg(unix)]
    #[test]
    fn workspace_dir_and_database_use_restrictive_modes() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().expect("temp dir should be created");
        let workspace = tmp.path().join(".grokspace");

        let _conn = open_in_dir(&workspace).expect("workspace database should open");

        let dir_mode = std::fs::metadata(&workspace)
            .expect("workspace dir should exist")
            .permissions()
            .mode()
            & 0o777;
        let db_mode = std::fs::metadata(workspace.join("grokspace.db"))
            .expect("database file should exist")
            .permissions()
            .mode()
            & 0o777;

        assert_eq!(dir_mode, 0o700, "workspace dir must be owner-only");
        assert_eq!(db_mode, 0o600, "database file must be owner-only");
    }

    #[cfg(unix)]
    #[test]
    fn open_in_dir_tightens_existing_permissive_modes() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().expect("temp dir should be created");
        let workspace = tmp.path().join(".grokspace");
        std::fs::create_dir_all(&workspace).expect("workspace dir should be created");
        std::fs::set_permissions(&workspace, std::fs::Permissions::from_mode(0o755))
            .expect("permissive dir mode should apply");
        let db_path = workspace.join("grokspace.db");
        std::fs::write(&db_path, []).expect("database file should be created");
        std::fs::set_permissions(&db_path, std::fs::Permissions::from_mode(0o644))
            .expect("permissive file mode should apply");

        let _conn = open_in_dir(&workspace).expect("reopen should succeed");

        let dir_mode = std::fs::metadata(&workspace)
            .expect("workspace dir should exist")
            .permissions()
            .mode()
            & 0o777;
        let db_mode = std::fs::metadata(&db_path)
            .expect("database file should exist")
            .permissions()
            .mode()
            & 0o777;

        assert_eq!(dir_mode, 0o700, "existing workspace dir must be tightened");
        assert_eq!(db_mode, 0o600, "existing database file must be tightened");
    }

    #[cfg(unix)]
    #[test]
    fn open_in_dir_tightens_modes_even_when_open_fails() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().expect("temp dir should be created");
        let workspace = tmp.path().join(".grokspace");
        std::fs::create_dir_all(&workspace).expect("workspace dir should be created");
        std::fs::set_permissions(&workspace, std::fs::Permissions::from_mode(0o755))
            .expect("permissive dir mode should apply");
        let db_path = workspace.join("grokspace.db");
        std::fs::write(&db_path, b"not a sqlite database").expect("junk file should be written");
        std::fs::set_permissions(&db_path, std::fs::Permissions::from_mode(0o644))
            .expect("permissive file mode should apply");

        assert!(
            open_in_dir(&workspace).is_err(),
            "a junk file must not open as the workspace database"
        );

        let dir_mode = std::fs::metadata(&workspace)
            .expect("workspace dir should exist")
            .permissions()
            .mode()
            & 0o777;
        let db_mode = std::fs::metadata(&db_path)
            .expect("database file should exist")
            .permissions()
            .mode()
            & 0o777;

        assert_eq!(dir_mode, 0o700, "dir must be tightened on the error path");
        assert_eq!(db_mode, 0o600, "file must be tightened on the error path");
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
