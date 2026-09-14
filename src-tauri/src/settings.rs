//! Preferences that belong to the app rather than to one project.
//!
//! Stored key-value and read as a struct. The table can take a new preference
//! without a migration, and the typed surface is what stops the frontend guessing
//! at strings — the two halves of the same decision, made in the two places where
//! each is cheap.
//!
//! A missing key reads as its default rather than as an error, so a database from an
//! older build needs no backfill and a hand-deleted row heals itself. A value this
//! build does not know is an error rather than a silent remap.

use std::collections::HashMap;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::now_ms;
use crate::error::{Error, Result};
use crate::AppState;

/// Grid presets, named columns-by-rows. Freeform splits are a later phase.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PaneLayout {
    #[serde(rename = "1x1")]
    OneByOne,
    #[serde(rename = "2x1")]
    TwoByOne,
    #[serde(rename = "2x2")]
    TwoByTwo,
    #[serde(rename = "3x2")]
    ThreeByTwo,
}

impl PaneLayout {
    pub const DEFAULT: Self = Self::TwoByTwo;
    pub const ALL: [Self; 4] = [
        Self::OneByOne,
        Self::TwoByOne,
        Self::TwoByTwo,
        Self::ThreeByTwo,
    ];

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::OneByOne => "1x1",
            Self::TwoByOne => "2x1",
            Self::TwoByTwo => "2x2",
            Self::ThreeByTwo => "3x2",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|item| item.as_str() == value)
    }
}

pub(crate) fn is_pane_layout(value: &str) -> bool {
    PaneLayout::from_str(value).is_some()
}

/// The panels the workspace switches between. Settings' opening tab is this list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceTab {
    Terminals,
    Graph,
    Tasks,
    Memory,
    Diff,
}

impl WorkspaceTab {
    pub const DEFAULT: Self = Self::Terminals;
    pub const ALL: [Self; 5] = [
        Self::Terminals,
        Self::Graph,
        Self::Tasks,
        Self::Memory,
        Self::Diff,
    ];

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Terminals => "terminals",
            Self::Graph => "graph",
            Self::Tasks => "tasks",
            Self::Memory => "memory",
            Self::Diff => "diff",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|item| item.as_str() == value)
    }
}

/// Which new session a dispatch reaches for first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DispatchTarget {
    Pane,
    Agent,
}

impl DispatchTarget {
    pub const DEFAULT: Self = Self::Pane;
    pub const ALL: [Self; 2] = [Self::Pane, Self::Agent];

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Pane => "pane",
            Self::Agent => "agent",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|item| item.as_str() == value)
    }
}

/// Every preference, with the defaults filled in.
///
/// Values are validated on the way out as well as in: a missing key is the default,
/// and a value this build does not know is an error rather than a layout we invent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// The pane layout a project that has never chosen one gets.
    pub default_layout: PaneLayout,
    /// The panel the workspace opens on. Somebody who works from the board should
    /// not have to click past the terminals every time.
    pub opening_tab: WorkspaceTab,
    /// Which new session a dispatch reaches for first: a Grok terminal in a free pane,
    /// or a paneless agent. Only the ordering of the offer changes — nothing is chosen
    /// on the user's behalf — but it decides which chip is nearest the pointer.
    pub default_dispatch: DispatchTarget,
}

impl Settings {
    fn from_rows(rows: &HashMap<String, String>) -> Result<Self> {
        Ok(Self {
            default_layout: stored_or_default(
                rows.get("defaultLayout"),
                PaneLayout::from_str,
                PaneLayout::DEFAULT,
                "defaultLayout",
            )?,
            opening_tab: stored_or_default(
                rows.get("openingTab"),
                WorkspaceTab::from_str,
                WorkspaceTab::DEFAULT,
                "openingTab",
            )?,
            default_dispatch: stored_or_default(
                rows.get("defaultDispatch"),
                DispatchTarget::from_str,
                DispatchTarget::DEFAULT,
                "defaultDispatch",
            )?,
        })
    }
}

/// A missing key is the default. A value this build does not know is an error.
fn stored_or_default<T>(
    stored: Option<&String>,
    parse: fn(&str) -> Option<T>,
    fallback: T,
    key: &str,
) -> Result<T> {
    match stored {
        None => Ok(fallback),
        Some(value) => parse(value).ok_or_else(|| {
            Error::Invalid(format!(
                "`{value}` is not one of the values `{key}` can take"
            ))
        }),
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
    Settings::from_rows(&rows(conn)?)
}

/// Writes one preference and returns them all.
///
/// Refuses a key it does not know, rather than storing it: a typo would otherwise
/// become a row that reads back as the default forever, which looks exactly like the
/// setting not working.
pub fn put(conn: &Connection, key: &str, value: &str) -> Result<Settings> {
    let known = match key {
        "defaultLayout" => PaneLayout::from_str(value).is_some(),
        "openingTab" => WorkspaceTab::from_str(value).is_some(),
        "defaultDispatch" => DispatchTarget::from_str(value).is_some(),
        _ => return Err(Error::Invalid(format!("`{key}` is not a setting"))),
    };
    if !known {
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

#[tauri::command]
pub fn read_settings(state: State<'_, AppState>) -> Result<Settings> {
    state.with_db(get)
}

#[tauri::command]
pub fn write_setting(state: State<'_, AppState>, key: String, value: String) -> Result<Settings> {
    state.with_db(|conn| put(conn, &key, &value))
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

        assert_eq!(settings.default_layout, PaneLayout::DEFAULT);
        assert_eq!(settings.opening_tab, WorkspaceTab::DEFAULT);
        assert_eq!(settings.default_dispatch, DispatchTarget::DEFAULT);
    }

    #[test]
    fn writing_one_preference_leaves_the_others_alone() {
        let conn = conn();

        let after = put(&conn, "openingTab", "tasks").unwrap();

        assert_eq!(after.opening_tab, WorkspaceTab::Tasks);
        assert_eq!(after.default_layout, PaneLayout::DEFAULT);
        assert_eq!(after.default_dispatch, DispatchTarget::DEFAULT);
    }

    #[test]
    fn writing_the_same_key_twice_replaces_it() {
        let conn = conn();

        put(&conn, "defaultLayout", "3x2").unwrap();
        let after = put(&conn, "defaultLayout", "1x1").unwrap();

        assert_eq!(after.default_layout, PaneLayout::OneByOne);
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
    fn the_diff_panel_is_a_valid_opening_tab() {
        // The workspace has five tabs; refusing `diff` made Settings offer a
        // control that always failed.
        let conn = conn();

        let after = put(&conn, "openingTab", "diff").unwrap();

        assert_eq!(after.opening_tab, WorkspaceTab::Diff);
        assert_eq!(get(&conn).unwrap().opening_tab, WorkspaceTab::Diff);
    }

    #[test]
    fn a_value_edited_by_hand_is_an_error() {
        // Remapping `9x9` to `2x2` would look exactly like the setting not working.
        let conn = conn();
        conn.execute(
            "INSERT INTO app_settings (key, value, updated_at) VALUES ('defaultLayout', '9x9', 0)",
            [],
        )
        .unwrap();

        assert!(matches!(get(&conn), Err(Error::Invalid(_))));
    }
}
