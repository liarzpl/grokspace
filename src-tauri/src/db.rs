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
    include_str!("../migrations/0007_session_isolation_skip.sql"),
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

    fn columns(conn: &Connection, table: &str) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT name FROM pragma_table_info(?1) ORDER BY cid")
            .expect("pragma_table_info should be queryable");
        let names = stmt
            .query_map([table], |row| row.get::<_, String>(0))
            .expect("query should run")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("rows should map");
        names
    }

    fn has_column(conn: &Connection, table: &str, column: &str) -> bool {
        columns(conn, table).iter().any(|name| name == column)
    }

    fn full_table_names() -> Vec<&'static str> {
        vec![
            "app_settings",
            "memory_entries",
            "projects",
            "session_permissions",
            "session_steps",
            "sessions",
            "tasks",
        ]
    }

    fn blank_db() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory database should open");
        configure(&conn).expect("pragmas should apply");
        conn
    }

    /// Apply migrations `1..=k` and freeze `user_version` there, the way a
    /// real `~/.grokspace/grokspace.db` would look after that release.
    fn apply_first(conn: &mut Connection, k: usize) {
        for (index, sql) in MIGRATIONS.iter().enumerate().take(k) {
            let tx = conn
                .transaction()
                .expect("prefix migration should open a transaction");
            tx.execute_batch(sql)
                .unwrap_or_else(|error| panic!("migration {} should apply: {error}", index + 1));
            tx.execute_batch(&format!("PRAGMA user_version = {};", index + 1))
                .expect("user_version should record the prefix");
            tx.commit().expect("prefix migration should commit");
        }
    }

    fn seed_surviving_rows(conn: &Connection, k: usize) {
        if k >= 1 {
            conn.execute(
                "INSERT INTO projects (id, name, path, created_at)
                 VALUES ('p1', 'seed', '/tmp/seed', 1)",
                [],
            )
            .expect("a project row at this prefix should insert");
        }
        if k >= 4 {
            conn.execute(
                "INSERT INTO sessions (id, project_id, status, created_at, updated_at)
                 VALUES ('s1', 'p1', 'idle', 1, 1)",
                [],
            )
            .expect("a session row at this prefix should insert");
            conn.execute(
                "INSERT INTO session_permissions (session_id, request_id, summary)
                 VALUES ('s1', 1, 'read the repo')",
                [],
            )
            .expect("a permission row at this prefix should insert");
        }
    }

    fn assert_prefix_schema(conn: &Connection, k: usize) {
        assert_eq!(
            user_version(conn),
            k as i64,
            "frozen user_version should be {k}"
        );
        let tables = table_names(conn);
        if k == 0 {
            assert!(tables.is_empty(), "a blank database has no app tables");
            return;
        }

        assert!(tables.contains(&"projects".to_string()));
        assert!(tables.contains(&"sessions".to_string()));
        assert_eq!(
            tables.contains(&"app_settings".to_string()),
            k >= 3,
            "app_settings arrives in 0003"
        );
        assert_eq!(
            tables.contains(&"session_permissions".to_string()),
            k >= 4,
            "session_permissions arrives in 0004"
        );
        assert_eq!(
            tables.contains(&"session_steps".to_string()),
            k >= 5,
            "session_steps arrives in 0005"
        );

        assert_eq!(has_column(conn, "sessions", "kind"), k >= 2);
        assert_eq!(has_column(conn, "sessions", "exit_code"), k >= 2);
        assert_eq!(has_column(conn, "sessions", "steps_phase"), k >= 5);
        if k >= 4 {
            assert_eq!(has_column(conn, "session_permissions", "options"), k >= 6);
        }
    }

    fn assert_current_schema(conn: &Connection) {
        assert_eq!(
            table_names(conn),
            full_table_names()
                .into_iter()
                .map(str::to_string)
                .collect::<Vec<_>>()
        );
        assert_eq!(user_version(conn), MIGRATIONS.len() as i64);
        assert!(has_column(conn, "sessions", "kind"));
        assert!(has_column(conn, "sessions", "exit_code"));
        assert!(has_column(conn, "sessions", "steps_phase"));
        assert!(has_column(conn, "session_permissions", "options"));
    }

    #[test]
    fn migrations_create_the_full_data_model() {
        let conn = open_in_memory().expect("in-memory database should open");

        assert_current_schema(&conn);
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
    fn migrate_completes_the_schema_from_each_prefix() {
        // Fresh-DB tests hide a broken ALTER: they never open a file that stopped
        // at 0001. For every frozen prefix 0..=k, `migrate()` must apply the rest
        // and leave today's schema (TEST-009).
        for k in 0..=MIGRATIONS.len() {
            let mut conn = blank_db();
            apply_first(&mut conn, k);
            assert_prefix_schema(&conn, k);
            seed_surviving_rows(&conn, k);

            migrate(&mut conn).unwrap_or_else(|error| {
                panic!("migrate() from user_version={k} should reach the current schema: {error}")
            });

            assert_current_schema(&conn);

            if k >= 1 {
                let name: String = conn
                    .query_row("SELECT name FROM projects WHERE id = 'p1'", [], |row| {
                        row.get(0)
                    })
                    .expect("prefix project rows must survive later ALTER/CREATE");
                assert_eq!(name, "seed");
            }
            if k >= 4 {
                let options: String = conn
                    .query_row(
                        "SELECT options FROM session_permissions WHERE session_id = 's1'",
                        [],
                        |row| row.get(0),
                    )
                    .expect("prefix permission rows must gain the 0006 default");
                assert_eq!(options, "[]");
            }
        }
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
