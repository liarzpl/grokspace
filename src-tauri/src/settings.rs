//! Preferences that belong to the app rather than to one project.
//!
//! Stored key-value and read as a struct. The table can take a new preference
//! without a migration, and the typed surface is what stops the frontend guessing
//! at strings — the two halves of the same decision, made in the two places where
//! each is cheap.
//!
//! A missing key reads as its default rather than as an error, so a database from an
//! older build needs no backfill and a hand-deleted row heals itself.

use std::collections::HashMap;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::now_ms;
use crate::error::{Error, Result};
use crate::AppState;

const DEFAULT_LAYOUT: &str = "2x2";
const LAYOUTS: [&str; 4] = ["1x1", "2x1", "2x2", "3x2"];

const DEFAULT_TAB: &str = "terminals";
const TABS: [&str; 4] = ["terminals", "graph", "tasks", "memory"];

const DEFAULT_DISPATCH: &str = "pane";
const DISPATCH: [&str; 2] = ["pane", "agent"];

/// Every preference, with the defaults filled in.
///
/// Values are validated on the way out as well as in: a row edited by hand should
/// give the app a working default rather than a layout it cannot draw.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// The pane layout a project that has never chosen one gets.
    pub default_layout: String,
    /// The panel the workspace opens on. Somebody who works from the board should
    /// not have to click past the terminals every time.
    pub opening_tab: String,
    /// Which new session a dispatch reaches for first: a Grok terminal in a free pane,
    /// or a paneless agent. Only the ordering of the offer changes — nothing is chosen
    /// on the user's behalf — but it decides which chip is nearest the pointer.
    pub default_dispatch: String,
}

impl Settings {
    fn from_rows(rows: &HashMap<String, String>) -> Self {
        Self {
            default_layout: one_of(rows.get("defaultLayout"), &LAYOUTS, DEFAULT_LAYOUT),
            opening_tab: one_of(rows.get("openingTab"), &TABS, DEFAULT_TAB),
            default_dispatch: one_of(rows.get("defaultDispatch"), &DISPATCH, DEFAULT_DISPATCH),
        }
    }
}

/// The stored value when it is one of the ones this build knows, and the default
/// otherwise.
fn one_of(stored: Option<&String>, allowed: &[&str], fallback: &str) -> String {
    match stored {
        Some(value) if allowed.contains(&value.as_str()) => value.clone(),
        _ => fallback.to_string(),
    }
}

fn rows(conn: &Connection) -> Result<HashMap<String, String>> {
    let mut stmt = conn.prepare("SELECT key, value FROM app_settings")?;
    let pairs = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<HashMap<_, _>>>()?;
    Ok(pairs)
}

pub fn get(conn: &Connection) -> Result<Settings> {
    Ok(Settings::from_rows(&rows(conn)?))
}

/// Writes one preference and returns them all.
///
/// Refuses a key it does not know, rather than storing it: a typo would otherwise
/// become a row that reads back as the default forever, which looks exactly like the
/// setting not working.
pub fn put(conn: &Connection, key: &str, value: &str) -> Result<Settings> {
    let allowed: &[&str] = match key {
        "defaultLayout" => &LAYOUTS,
        "openingTab" => &TABS,
        "defaultDispatch" => &DISPATCH,
        _ => return Err(Error::Invalid(format!("`{key}` is not a setting"))),
    };
    if !allowed.contains(&value) {
        return Err(Error::Invalid(format!(
            "`{value}` is not one of the values `{key}` can take"
        )));
    }

    conn.execute(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        rusqlite::params![key, value, now_ms()],
    )?;
    get(conn)
}

fn with_db<T>(
    state: &State<'_, AppState>,
    run: impl FnOnce(&Connection) -> Result<T>,
) -> Result<T> {
    let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
    run(&conn)
}

#[tauri::command]
pub fn read_settings(state: State<'_, AppState>) -> Result<Settings> {
    with_db(&state, get)
}

#[tauri::command]
pub fn write_setting(state: State<'_, AppState>, key: String, value: String) -> Result<Settings> {
    with_db(&state, |conn| put(conn, &key, &value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn conn() -> Connection {
        db::open_in_memory().expect("in-memory database should open")
    }

    #[test]
    fn an_empty_table_reads_as_the_defaults() {
        // A database from an older build has no rows, and must not need a backfill.
        let conn = conn();

        let settings = get(&conn).unwrap();

        assert_eq!(settings.default_layout, "2x2");
        assert_eq!(settings.opening_tab, "terminals");
        assert_eq!(settings.default_dispatch, "pane");
    }

    #[test]
    fn writing_one_preference_leaves_the_others_alone() {
        let conn = conn();

        let after = put(&conn, "openingTab", "tasks").unwrap();

        assert_eq!(after.opening_tab, "tasks");
        assert_eq!(after.default_layout, "2x2");
        assert_eq!(after.default_dispatch, "pane");
    }

    #[test]
    fn writing_the_same_key_twice_replaces_it() {
        let conn = conn();

        put(&conn, "defaultLayout", "3x2").unwrap();
        let after = put(&conn, "defaultLayout", "1x1").unwrap();

        assert_eq!(after.default_layout, "1x1");
        let stored: i64 = conn
            .query_row("SELECT COUNT(*) FROM app_settings", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            stored, 1,
            "a preference is one row however often it changes"
        );
    }

    #[test]
    fn a_key_this_build_does_not_know_is_refused() {
        // Storing it would leave a row that reads back as the default forever, which
        // looks exactly like the setting not working.
        let conn = conn();

        assert!(put(&conn, "colourOfTheSky", "blue").is_err());
        assert!(matches!(
            put(&conn, "defaultDispatch", "carrier-pigeon"),
            Err(Error::Invalid(_))
        ));
        assert!(matches!(
            put(&conn, "openingTab", "nonesuch"),
            Err(Error::Invalid(_))
        ));
    }

    #[test]
    fn a_value_edited_by_hand_reads_as_the_default() {
        // Validated on the way out as well as in, so a hand-edited row gives the app
        // a layout it can draw rather than one it cannot.
        let conn = conn();
        conn.execute(
            "INSERT INTO app_settings (key, value, updated_at) VALUES ('defaultLayout', '9x9', 0)",
            [],
        )
        .unwrap();

        assert_eq!(get(&conn).unwrap().default_layout, "2x2");
    }
}
