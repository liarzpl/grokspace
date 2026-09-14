//! Local playbook snapshots (FEAT-030).
//!
//! `~/.grokspace/playbooks/<name>/` and `<project>/.grokspace/playbooks/<name>/`.
//! Graph stub, steps stub, roles, memory excerpt. No transcript. No catalog.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db;
use crate::error::{Error, Result};
use crate::project::{self, GROKSPACE_DIR};
use crate::AppState;

const DIR: &str = "playbooks";
const MAX: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybookRecord {
    pub name: String,
    pub scope: String,
    pub path: String,
    pub roles: Vec<String>,
    pub graph: String,
    pub steps: String,
    pub memory: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Meta {
    name: String,
    roles: Vec<String>,
}

pub fn user_playbooks_dir() -> Result<PathBuf> {
    Ok(db::data_dir()?.join(DIR))
}

pub fn project_playbooks_dir(project_path: &Path) -> PathBuf {
    project_path.join(GROKSPACE_DIR).join(DIR)
}

pub fn validate_name(raw: &str) -> Result<String> {
    let name = raw.trim();
    let ok = !name.is_empty()
        && name.len() <= 63
        && !name.contains("..")
        && name.starts_with(|ch: char| ch.is_ascii_alphanumeric())
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'));
    if !ok {
        return Err(Error::Invalid(
            "playbook name must be letters, digits, '.', '_' or '-'".into(),
        ));
    }
    Ok(name.to_string())
}

pub fn write_playbook(
    root: &Path,
    name: &str,
    roles: &[String],
    graph: &str,
    steps: &str,
    memory: &str,
    scope: &str,
) -> Result<PlaybookRecord> {
    let name = validate_name(name)?;
    for part in [graph, steps, memory] {
        if part.len() > MAX {
            return Err(Error::Invalid("playbook file is too large".into()));
        }
    }
    let dir = root.join(&name);
    fs::create_dir_all(&dir)?;
    fs::write(
        dir.join("playbook.json"),
        serde_json::to_string_pretty(&Meta {
            name: name.clone(),
            roles: roles.to_vec(),
        })?,
    )?;
    fs::write(dir.join("graph.json"), graph)?;
    fs::write(dir.join("steps.json"), steps)?;
    fs::write(dir.join("memory.md"), memory)?;
    read_from(&dir, &name, scope)
}

fn read_capped(path: &Path) -> Result<String> {
    let bytes = fs::read(path)?;
    if bytes.len() > MAX {
        return Err(Error::Invalid("playbook file is too large".into()));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn read_from(dir: &Path, name: &str, scope: &str) -> Result<PlaybookRecord> {
    let meta: Meta = serde_json::from_str(&fs::read_to_string(dir.join("playbook.json"))?)?;
    Ok(PlaybookRecord {
        name: name.into(),
        scope: scope.into(),
        path: dir.to_string_lossy().into_owned(),
        roles: meta.roles,
        graph: read_capped(&dir.join("graph.json"))?,
        steps: read_capped(&dir.join("steps.json"))?,
        memory: read_capped(&dir.join("memory.md")).unwrap_or_default(),
    })
}

fn project_root(state: &AppState, project_id: Option<&str>) -> Result<Option<PathBuf>> {
    let Some(id) = project_id else {
        return Ok(None);
    };
    let project = state.with_db(|conn| project::get(conn, id))?;
    Ok(Some(project_playbooks_dir(Path::new(&project.path))))
}

#[tauri::command]
pub fn save_playbook(
    name: String,
    roles: Vec<String>,
    graph: String,
    steps: String,
    memory: String,
) -> Result<PlaybookRecord> {
    write_playbook(
        &user_playbooks_dir()?,
        &name,
        &roles,
        &graph,
        &steps,
        &memory,
        "user",
    )
}

#[tauri::command]
pub fn read_playbook(
    state: State<'_, AppState>,
    name: String,
    project_id: Option<String>,
) -> Result<PlaybookRecord> {
    let name = validate_name(&name)?;
    if let Some(root) = project_root(&state, project_id.as_deref())? {
        let dir = root.join(&name);
        if dir.join("playbook.json").is_file() {
            return read_from(&dir, &name, "project");
        }
    }
    let dir = user_playbooks_dir()?.join(&name);
    if !dir.join("playbook.json").is_file() {
        return Err(Error::Invalid(format!("no playbook named {name}")));
    }
    read_from(&dir, &name, "user")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn save_writes_stubs_and_never_a_transcript() {
        let root = TempDir::new().unwrap();
        let rec = write_playbook(
            root.path(),
            "review-pr",
            &["Planner".into(), "Coder".into()],
            r#"{"id":"review-pr","nodes":[]}"#,
            r#"{"steps":[{"title":"Read"}]}"#,
            "stack: Rust",
            "user",
        )
        .unwrap();
        let dir = root.path().join("review-pr");
        assert_eq!(rec.roles, ["Planner", "Coder"]);
        assert!(dir.join("graph.json").is_file());
        assert!(dir.join("memory.md").is_file());
        assert!(!dir.join("transcript.md").exists());
        assert!(validate_name("../etc").is_err());
    }
}
