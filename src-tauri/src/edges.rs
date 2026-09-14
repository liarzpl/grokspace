//! Project `.grokspace/edges.json`. Overlayed on the Graph tab; never merged
//! into a session graph. JSON is unparsed here — `src/lib/edges.ts` validates.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::State;

use crate::error::{Error, Result};
use crate::project::{self, GROKSPACE_DIR};
use crate::AppState;

const MAX_EDGES_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgesSnapshot {
    pub path: String,
    pub exists: bool,
    pub json: Option<String>,
    pub too_large: bool,
    pub updated_at: Option<i64>,
}

pub fn project_edges_file(project_path: &Path) -> PathBuf {
    project_path.join(GROKSPACE_DIR).join("edges.json")
}

pub fn snapshot(project_path: &Path) -> EdgesSnapshot {
    let path = project_edges_file(project_path);
    let display = path.to_string_lossy().into_owned();
    let metadata = std::fs::metadata(&path).ok().filter(|meta| meta.is_file());
    let Some(metadata) = metadata else {
        return EdgesSnapshot {
            path: display,
            exists: false,
            json: None,
            too_large: false,
            updated_at: None,
        };
    };
    let too_large = metadata.len() > MAX_EDGES_BYTES;
    let json = if too_large {
        None
    } else {
        match std::fs::read_to_string(&path) {
            Ok(text) if !text.trim().is_empty() => Some(text),
            _ => None,
        }
    };
    EdgesSnapshot {
        path: display,
        exists: true,
        json,
        too_large,
        updated_at: metadata.modified().ok().and_then(|time| {
            time.duration_since(UNIX_EPOCH)
                .ok()
                .map(|since| since.as_millis() as i64)
        }),
    }
}

#[tauri::command]
pub fn read_project_edges(state: State<'_, AppState>, project_id: String) -> Result<EdgesSnapshot> {
    let project_path = {
        let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
        project::get(&conn, &project_id)?.path
    };
    Ok(snapshot(Path::new(&project_path)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_project_file_and_ignores_session_graphs() {
        assert_eq!(
            project_edges_file(Path::new("/tmp/acme")),
            PathBuf::from("/tmp/acme/.grokspace/edges.json")
        );
        let project = tempfile::tempdir().unwrap();
        let graphs = project.path().join(".grokspace").join("graphs");
        std::fs::create_dir_all(&graphs).unwrap();
        std::fs::write(graphs.join("s1.json"), r#"{"nodes":[]}"#).unwrap();
        assert!(!snapshot(project.path()).exists);

        let path = project_edges_file(project.path());
        std::fs::write(&path, r#"{"edges":[]}"#).unwrap();
        assert_eq!(
            snapshot(project.path()).json.as_deref(),
            Some(r#"{"edges":[]}"#)
        );
    }
}
