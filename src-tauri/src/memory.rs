//! Shared project memory: what everyone working on a project should already know.
//!
//! Two halves. The table is the source of truth, and a Markdown projection of it
//! sits in the project so an agent can read it — agents read files, not SQLite.
//! The projection is rewritten whenever the table changes and is never read back;
//! see `write_projection` for why that direction is the only one for now.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, Row};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::now_ms;
use crate::error::{Error, Result};
use crate::{project, AppState};

const COLUMNS: &str = "project_id, key, content, type, updated_at";

/// The file agents are pointed at, beside the graphs a session writes.
const MEMORY_FILE: &str = "memory.md";

/// The most memory a project may hold, in characters of content.
///
/// Every session is told to read this file, so it is charged against every
/// agent's context. A cap keeps a memory panel someone has pasted a log into from
/// quietly making each session more expensive and less attentive.
const MAX_MEMORY_CHARS: usize = 32 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryEntryType {
    Note,
    Decision,
    Context,
    Artifact,
}

impl MemoryEntryType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Note => "note",
            Self::Decision => "decision",
            Self::Context => "context",
            Self::Artifact => "artifact",
        }
    }

    /// Anything unrecognised reads as a note, which is the type that claims the
    /// least. The schema constrains the column, so a surprise here means someone
    /// edited the database by hand.
    fn parse(value: &str) -> Self {
        match value {
            "decision" => Self::Decision,
            "context" => Self::Context,
            "artifact" => Self::Artifact,
            _ => Self::Note,
        }
    }

    /// The order the projection reads in: what the project is, then what was
    /// decided, then everything else, then where things ended up.
    fn projection_order() -> [Self; 4] {
        [Self::Context, Self::Decision, Self::Note, Self::Artifact]
    }

    fn heading(self) -> &'static str {
        match self {
            Self::Note => "Notes",
            Self::Decision => "Decisions",
            Self::Context => "Context",
            Self::Artifact => "Artifacts",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    pub project_id: String,
    pub key: String,
    pub content: String,
    /// `type` in the schema and on the wire; renamed here because Rust reserves it.
    #[serde(rename = "type")]
    pub entry_type: MemoryEntryType,
    pub updated_at: i64,
}

fn from_row(row: &Row<'_>) -> rusqlite::Result<MemoryEntry> {
    let entry_type: String = row.get("type")?;
    Ok(MemoryEntry {
        project_id: row.get("project_id")?,
        key: row.get("key")?,
        content: row.get("content")?,
        entry_type: MemoryEntryType::parse(&entry_type),
        updated_at: row.get("updated_at")?,
    })
}

fn clean(value: &str, what: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(Error::Invalid(format!("a memory entry needs {what}")));
    }
    Ok(value.to_string())
}

/// By key, so the panel and the projection read the same on every load.
pub fn list(conn: &Connection, project_id: &str) -> Result<Vec<MemoryEntry>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM memory_entries WHERE project_id = ?1 ORDER BY key ASC"
    ))?;
    let entries = stmt
        .query_map([project_id], from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(entries)
}

/// Writes an entry, replacing whatever was under that key.
///
/// An upsert rather than an insert because the key is half the primary key: memory
/// is a set of things that are true about the project, so writing the same key
/// twice is a correction, not a second entry.
pub fn put(
    conn: &Connection,
    project_id: &str,
    key: &str,
    content: &str,
    entry_type: MemoryEntryType,
) -> Result<MemoryEntry> {
    let key = clean(key, "a key")?;
    let content = clean(content, "something to remember")?;

    // Measured across the project rather than per entry: what matters is the total
    // every session has to read, and the entry being written replaces its own
    // previous size rather than adding to it.
    let existing: usize = list(conn, project_id)?
        .iter()
        .filter(|entry| entry.key != key)
        .map(|entry| entry.content.chars().count())
        .sum();
    if existing + content.chars().count() > MAX_MEMORY_CHARS {
        return Err(Error::Invalid(format!(
            "this project's memory would pass {MAX_MEMORY_CHARS} characters, and every \
             session has to read all of it"
        )));
    }

    let entry = conn.query_row(
        &format!(
            "INSERT INTO memory_entries (project_id, key, content, type, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (project_id, key) DO UPDATE
                 SET content = excluded.content,
                     type = excluded.type,
                     updated_at = excluded.updated_at
             RETURNING {COLUMNS}"
        ),
        rusqlite::params![project_id, key, content, entry_type.as_str(), now_ms()],
        from_row,
    )?;
    Ok(entry)
}

/// Forgets one entry. Removing something already gone is not a failure, the same
/// way closing an already-closed session is not.
pub fn remove(conn: &Connection, project_id: &str, key: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM memory_entries WHERE project_id = ?1 AND key = ?2",
        rusqlite::params![project_id, key],
    )?;
    Ok(())
}

/// Where a project's memory is projected for agents to read.
///
/// Beside the graphs, under the same `.grokspace` directory a session already
/// writes into, so a project gains one folder rather than two.
pub fn memory_file(project_path: &Path) -> PathBuf {
    project_path.join(".grokspace").join(MEMORY_FILE)
}

/// Renders the memory as the Markdown an agent is asked to read.
///
/// Grouped by type and ordered so it reads as a briefing: what the project is,
/// what has been decided, then the rest. The header says it is generated, because
/// an agent that edits it would have its edits overwritten by the next write.
pub fn render(entries: &[MemoryEntry]) -> String {
    let mut out = String::from(
        "# Project memory\n\n\
         Written by GrokSpace from its Memory panel, and rewritten whenever that \
         changes.\n\
         Read it; do not edit it, because an edit here is lost on the next write.\n",
    );

    for entry_type in MemoryEntryType::projection_order() {
        let of_type: Vec<&MemoryEntry> = entries
            .iter()
            .filter(|entry| entry.entry_type == entry_type)
            .collect();
        if of_type.is_empty() {
            continue;
        }

        out.push_str(&format!("\n## {}\n", entry_type.heading()));
        for entry in of_type {
            out.push_str(&format!("\n### {}\n\n{}\n", entry.key, entry.content));
        }
    }

    out
}

/// Writes the projection, creating its directory if need be.
///
/// One direction only. GrokSpace writes and the agent reads: a file the agent also
/// wrote to would need merging against the table on every change, and a merge that
/// guesses wrong loses something someone typed. The skill therefore teaches reading
/// and nothing else.
pub fn write_projection(project_path: &Path, entries: &[MemoryEntry]) -> Result<()> {
    let file = memory_file(project_path);
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&file, render(entries))?;
    Ok(())
}

/// Rewrites the projection after a change, and says nothing if it cannot.
///
/// The table is the source of truth, so a project folder that will not take the
/// file is not a reason to refuse the write — losing a note because a directory is
/// read-only would be the worse outcome. The panel names the path, which is how a
/// missing file stays discoverable.
fn project_memory(conn: &Connection, project_id: &str) -> Result<Vec<MemoryEntry>> {
    let entries = list(conn, project_id)?;
    if let Ok(project) = project::get(conn, project_id) {
        let _ = write_projection(Path::new(&project.path), &entries);
    }
    Ok(entries)
}

fn with_db<T>(
    state: &State<'_, AppState>,
    run: impl FnOnce(&Connection) -> Result<T>,
) -> Result<T> {
    let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
    run(&conn)
}

#[tauri::command]
pub fn list_memory(state: State<'_, AppState>, project_id: String) -> Result<Vec<MemoryEntry>> {
    with_db(&state, |conn| list(conn, &project_id))
}

/// Writes an entry and returns the whole memory, since the projection is rebuilt
/// from all of it and the panel wants the same list the file was built from.
#[tauri::command]
pub fn put_memory(
    state: State<'_, AppState>,
    project_id: String,
    key: String,
    content: String,
    entry_type: MemoryEntryType,
) -> Result<Vec<MemoryEntry>> {
    with_db(&state, |conn| {
        put(conn, &project_id, &key, &content, entry_type)?;
        project_memory(conn, &project_id)
    })
}

#[tauri::command]
pub fn remove_memory(
    state: State<'_, AppState>,
    project_id: String,
    key: String,
) -> Result<Vec<MemoryEntry>> {
    with_db(&state, |conn| {
        remove(conn, &project_id, &key)?;
        project_memory(conn, &project_id)
    })
}

/// The path the panel names, so someone can look at what agents are being given.
#[tauri::command]
pub fn memory_file_path(state: State<'_, AppState>, project_id: String) -> Result<String> {
    with_db(&state, |conn| {
        let project = project::get(conn, &project_id)?;
        Ok(memory_file(Path::new(&project.path))
            .to_string_lossy()
            .into_owned())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn fixture() -> (Connection, String) {
        let conn = db::open_in_memory().expect("in-memory database should open");
        let project = project::upsert_by_path(&conn, "/tmp/grokspace-test", "grokspace-test")
            .expect("project should be created");
        (conn, project.id)
    }

    #[test]
    fn writing_the_same_key_twice_corrects_it_rather_than_adding_a_second() {
        // The key is half the primary key on purpose: memory is a set of things
        // that are true, not a log of things that were said.
        let (conn, project_id) = fixture();

        put(
            &conn,
            &project_id,
            "database",
            "Postgres",
            MemoryEntryType::Decision,
        )
        .unwrap();
        let corrected = put(
            &conn,
            &project_id,
            "database",
            "SQLite, since it ships in-process",
            MemoryEntryType::Decision,
        )
        .unwrap();

        assert_eq!(corrected.content, "SQLite, since it ships in-process");
        assert_eq!(list(&conn, &project_id).unwrap().len(), 1);
    }

    #[test]
    fn a_key_and_some_content_are_both_required() {
        let (conn, project_id) = fixture();

        assert!(put(&conn, &project_id, "  ", "something", MemoryEntryType::Note).is_err());
        assert!(put(&conn, &project_id, "key", "   \n", MemoryEntryType::Note).is_err());
        assert!(list(&conn, &project_id).unwrap().is_empty());
    }

    #[test]
    fn entries_are_listed_per_project_by_key() {
        let (conn, project_id) = fixture();
        let other = project::upsert_by_path(&conn, "/tmp/other", "other").unwrap();

        put(&conn, &project_id, "zeta", "last", MemoryEntryType::Note).unwrap();
        put(&conn, &project_id, "alpha", "first", MemoryEntryType::Note).unwrap();
        put(
            &conn,
            &other.id,
            "elsewhere",
            "not ours",
            MemoryEntryType::Note,
        )
        .unwrap();

        let keys: Vec<String> = list(&conn, &project_id)
            .unwrap()
            .into_iter()
            .map(|entry| entry.key)
            .collect();
        assert_eq!(keys, vec!["alpha", "zeta"]);
    }

    #[test]
    fn memory_is_capped_because_every_session_reads_all_of_it() {
        let (conn, project_id) = fixture();
        let big = "x".repeat(MAX_MEMORY_CHARS - 10);
        put(&conn, &project_id, "big", &big, MemoryEntryType::Context).unwrap();

        let over = put(
            &conn,
            &project_id,
            "another",
            "yyyyyyyyyyyyyyyyyyyy",
            MemoryEntryType::Note,
        );

        assert!(over.is_err(), "the second entry takes the project over");
        // Rewriting the big entry is still allowed: it replaces its own size rather
        // than adding to it, so a correction can never be refused for being long.
        assert!(put(&conn, &project_id, "big", &big, MemoryEntryType::Context).is_ok());
    }

    #[test]
    fn forgetting_something_already_gone_is_not_a_failure() {
        let (conn, project_id) = fixture();

        assert!(remove(&conn, &project_id, "never-existed").is_ok());
    }

    #[test]
    fn removing_a_project_takes_its_memory_with_it() {
        let (conn, project_id) = fixture();
        put(&conn, &project_id, "key", "content", MemoryEntryType::Note).unwrap();

        project::remove(&conn, &project_id).unwrap();

        assert!(list(&conn, &project_id).unwrap().is_empty());
    }

    #[test]
    fn the_projection_groups_by_type_and_reads_as_a_briefing() {
        let (conn, project_id) = fixture();
        put(
            &conn,
            &project_id,
            "stack",
            "Tauri and React",
            MemoryEntryType::Context,
        )
        .unwrap();
        put(
            &conn,
            &project_id,
            "database",
            "SQLite",
            MemoryEntryType::Decision,
        )
        .unwrap();
        put(&conn, &project_id, "todo", "Ship it", MemoryEntryType::Note).unwrap();

        let rendered = render(&list(&conn, &project_id).unwrap());

        let context = rendered.find("## Context").expect("context section");
        let decisions = rendered.find("## Decisions").expect("decisions section");
        let notes = rendered.find("## Notes").expect("notes section");
        assert!(
            context < decisions && decisions < notes,
            "what the project is comes before what was decided, which comes before the rest"
        );
        assert!(rendered.contains("### stack"));
        assert!(rendered.contains("Tauri and React"));
        assert!(
            rendered.contains("do not edit"),
            "an agent that edits the file would lose its edits on the next write"
        );
    }

    #[test]
    fn a_type_with_nothing_in_it_gets_no_heading() {
        let (conn, project_id) = fixture();
        put(&conn, &project_id, "only", "a note", MemoryEntryType::Note).unwrap();

        let rendered = render(&list(&conn, &project_id).unwrap());

        assert!(rendered.contains("## Notes"));
        assert!(!rendered.contains("## Artifacts"));
    }

    #[test]
    fn the_projection_lands_beside_the_graphs() {
        let dir = tempfile::tempdir().expect("temp dir should be created");
        let entries = vec![MemoryEntry {
            project_id: "p1".to_string(),
            key: "stack".to_string(),
            content: "Tauri".to_string(),
            entry_type: MemoryEntryType::Context,
            updated_at: 0,
        }];

        write_projection(dir.path(), &entries).unwrap();

        let file = memory_file(dir.path());
        assert!(file.ends_with(".grokspace/memory.md"));
        assert!(std::fs::read_to_string(&file).unwrap().contains("Tauri"));
    }

    #[test]
    fn an_empty_memory_still_writes_a_file_that_says_so() {
        // The session is told to read this path either way, so the file existing and
        // holding nothing is friendlier than the file being absent.
        let dir = tempfile::tempdir().expect("temp dir should be created");

        write_projection(dir.path(), &[]).unwrap();

        let text = std::fs::read_to_string(memory_file(dir.path())).unwrap();
        assert!(text.contains("# Project memory"));
        assert!(!text.contains("## Notes"));
    }
}
