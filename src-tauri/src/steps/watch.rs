//! Watch the on-disk steps files and fold them when they change.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use notify::RecommendedWatcher;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::error::{Error, Result};
use crate::{project, session, AppState};

use super::ingest::{ingest_from_disk, ingest_if_none};
use super::store::ensure_steps_dir;

const CHANGE_EVENT: &str = "steps-changed";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct StepsChanged {
    session_id: String,
}

fn watch_dirs(
    dirs: &[PathBuf],
    on_change: impl Fn(String) + Send + 'static,
) -> Result<RecommendedWatcher> {
    crate::watch::watch_session_json_dir(dirs, "step", move |session_id, _path| {
        on_change(session_id);
    })
}

fn watched_dirs(project_path: &Path) -> Vec<PathBuf> {
    ensure_steps_dir(project_path)
        .map(|dir| vec![dir])
        .unwrap_or_default()
}

#[derive(Default)]
pub struct StepWatchers {
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
}

impl StepWatchers {
    pub fn new() -> Self {
        Self::default()
    }

    fn watch<R: Runtime>(
        &self,
        app: AppHandle<R>,
        project_id: &str,
        project_path: &Path,
    ) -> Result<Vec<String>> {
        let existing: Vec<PathBuf> = watched_dirs(project_path)
            .into_iter()
            .filter(|dir| dir.is_dir())
            .collect();
        if existing.is_empty() {
            return Ok(Vec::new());
        }

        let path = project_path.to_path_buf();
        let watcher = watch_dirs(&existing, move |session_id| {
            let state = app.state::<AppState>();
            let mut live = false;
            if let Ok(conn) = state.db.lock() {
                if session::get(&conn, &session_id).is_ok() {
                    live = true;
                    let _ = ingest_from_disk(&conn, &path, &session_id);
                }
            }
            // A close deletes the row and then the file. Emitting for a gone
            // session would make the frontend re-read it and banner SessionNotFound.
            if live {
                let _ = app.emit(
                    CHANGE_EVENT,
                    StepsChanged {
                        session_id: session_id.clone(),
                    },
                );
            }
        })?;

        let mut watchers = self.watchers.lock().map_err(|_| Error::StatePoisoned)?;
        watchers.insert(project_id.to_string(), watcher);

        Ok(existing
            .into_iter()
            .map(|dir| dir.to_string_lossy().into_owned())
            .collect())
    }

    pub fn shutdown(&self) {
        if let Ok(mut watchers) = self.watchers.lock() {
            watchers.clear();
        }
    }
}

pub(crate) fn watch_project_steps<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<String>> {
    let project_path = {
        let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
        project::get(&conn, &project_id)?.path
    };
    let path = Path::new(&project_path);
    let watched = state.steps.watch(app, &project_id, path)?;
    // Files written while nothing was watching have to land in SQLite too, or the
    // panel would sit empty until the next save. A list already in SQLite is left
    // alone: re-folding the file would restore agent rows the user had deleted.
    if let Ok(conn) = state.db.lock() {
        let sessions = session::list(&conn, &project_id).unwrap_or_default();
        for live in sessions {
            let _ = ingest_if_none(&conn, path, &live.id);
        }
    }
    Ok(watched)
}
