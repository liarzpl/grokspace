//! Host permission-heat sidecar (FEAT-034).
//!
//! `<project>/.grokspace/graphs/<session-id>.permissions.json`. Never the
//! agent's `$GROKSPACE_GRAPH_FILE`. Count only — not a trust colour.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{Error, Result};
use crate::ledger;
use crate::{graph, project, session, AppState};

const MAX_ASKS: usize = 100;
const MAX_SUMMARY_CHARS: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionHeatAsk {
    pub request_id: u64,
    pub summary: String,
    pub chip: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionHeatSnapshot {
    pub path: String,
    pub asks: Vec<PermissionHeatAsk>,
}

pub fn sidecar_file_name(session_id: &str) -> String {
    format!("{session_id}.permissions.json")
}

fn usable_session_id(id: &str) -> bool {
    let id = id.trim();
    !id.is_empty() && !id.contains(['/', '\\', '\0']) && !id.contains("..")
}

fn sidecar_dirs(project_path: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![graph::project_graph_dir(project_path)];
    if let Ok(home) = graph::home_graph_dir() {
        if !dirs.contains(&home) {
            dirs.push(home);
        }
    }
    dirs
}

fn ask(
    request_id: u64,
    summary: &str,
    allow: bool,
    option_id: Option<&str>,
    step_id: Option<&str>,
) -> PermissionHeatAsk {
    let collapsed = summary.replace(['\r', '\n'], " ");
    let summary = if collapsed.chars().count() <= MAX_SUMMARY_CHARS {
        collapsed
    } else {
        format!(
            "{}…",
            collapsed
                .chars()
                .take(MAX_SUMMARY_CHARS)
                .collect::<String>()
        )
    };
    PermissionHeatAsk {
        request_id,
        summary,
        chip: ledger::chip_for(allow, option_id).to_string(),
        step_id: step_id
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_string),
    }
}

fn read_asks(path: &Path) -> Vec<PermissionHeatAsk> {
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    value
        .get("asks")
        .and_then(|item| item.as_array())
        .map(|raw| {
            raw.iter()
                .filter_map(|item| serde_json::from_value(item.clone()).ok())
                .collect()
        })
        .unwrap_or_default()
}

fn write_asks(path: &Path, asks: &[PermissionHeatAsk]) -> Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(
        &tmp,
        serde_json::to_vec(&serde_json::json!({ "asks": asks }))?,
    )?;
    fs::rename(&tmp, path)?;
    Ok(())
}

fn upsert_ask(mut asks: Vec<PermissionHeatAsk>, next: PermissionHeatAsk) -> Vec<PermissionHeatAsk> {
    if let Some(existing) = asks
        .iter_mut()
        .find(|item| item.request_id == next.request_id)
    {
        *existing = next;
    } else {
        asks.push(next);
    }
    if asks.len() > MAX_ASKS {
        asks.drain(0..asks.len() - MAX_ASKS);
    }
    asks
}

/// Best-effort: a full disk must not leave the agent stuck.
pub fn record_answer(
    project_path: &Path,
    session_id: &str,
    request_id: u64,
    summary: &str,
    allow: bool,
    option_id: Option<&str>,
    step_id: Option<&str>,
) {
    if !usable_session_id(session_id) {
        return;
    }
    let Ok(dir) = graph::ensure_graph_dir(project_path) else {
        return;
    };
    let path = dir.join(sidecar_file_name(session_id));
    let _ = write_asks(
        &path,
        &upsert_ask(
            read_asks(&path),
            ask(request_id, summary, allow, option_id, step_id),
        ),
    );
}

pub fn snapshot(project_path: &Path, session_id: &str) -> PermissionHeatSnapshot {
    let file_name = sidecar_file_name(session_id);
    let mut expected = PathBuf::new();
    for dir in sidecar_dirs(project_path) {
        let candidate = dir.join(&file_name);
        if expected.as_os_str().is_empty() {
            expected = candidate.clone();
        }
        if candidate.is_file() {
            return PermissionHeatSnapshot {
                path: candidate.to_string_lossy().into_owned(),
                asks: read_asks(&candidate),
            };
        }
    }
    PermissionHeatSnapshot {
        path: expected.to_string_lossy().into_owned(),
        asks: Vec::new(),
    }
}

pub fn remove(project_path: &Path, session_id: &str) {
    let file_name = sidecar_file_name(session_id);
    for dir in sidecar_dirs(project_path) {
        let _ = fs::remove_file(dir.join(&file_name));
    }
}

pub fn doing_step_id(conn: &Connection, session_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT id FROM session_steps WHERE session_id = ?1 AND status = 'doing' ORDER BY sort_index ASC LIMIT 1",
        [session_id],
        |row| row.get(0),
    )
    .ok()
}

#[tauri::command]
pub fn read_session_permission_heat(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<PermissionHeatSnapshot> {
    let project_path = {
        let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
        let live = session::get(&conn, &session_id)?;
        project::get(&conn, &live.project_id)?.path
    };
    Ok(snapshot(Path::new(&project_path), &session_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    const GRAPH: &str = r#"{"id":"g","nodes":[{"id":"a","label":"A"}]}"#;

    fn record(
        project: &Path,
        id: &str,
        request_id: u64,
        summary: &str,
        allow: bool,
        option: Option<&str>,
        step: Option<&str>,
    ) {
        record_answer(project, id, request_id, summary, allow, option, step);
    }

    #[test]
    fn answer_writes_sidecar_and_leaves_the_agent_graph_untouched() {
        let project = tempfile::tempdir().expect("temp");
        let graphs = graph::ensure_graph_dir(project.path()).expect("graphs");
        let graph_path = graphs.join("s1.json");
        fs::write(&graph_path, GRAPH).expect("graph");
        let before = fs::read(&graph_path).expect("read");

        record(
            project.path(),
            "s1",
            9,
            "Edit src/lib.rs\nsecret",
            true,
            None,
            Some("step-a"),
        );
        record(
            project.path(),
            "s1",
            9,
            "Edit src/lib.rs",
            false,
            None,
            Some("step-a"),
        );
        record(
            project.path(),
            "s1",
            2,
            "always",
            true,
            Some("allow-always"),
            None,
        );

        assert_eq!(fs::read(&graph_path).expect("reread"), before);
        assert_eq!(
            graph::snapshot(project.path(), "s1").json.as_deref(),
            Some(GRAPH)
        );
        let heat = snapshot(project.path(), "s1");
        assert!(heat.path.ends_with("s1.permissions.json"));
        assert_eq!(heat.asks.len(), 2);
        assert_eq!(heat.asks[0].chip, "deny");
        assert_eq!(heat.asks[0].step_id.as_deref(), Some("step-a"));
        assert_eq!(heat.asks[1].chip, "always");

        record(project.path(), "keep", 1, "Edit", true, None, None);
        remove(project.path(), "s1");
        assert!(!graphs.join("s1.permissions.json").exists());
        assert!(graph_path.is_file());
        assert_eq!(snapshot(project.path(), "keep").asks.len(), 1);
        assert!(snapshot(project.path(), "missing").asks.is_empty());
    }
}
