//! Project hooks trust surface (FEAT-038).
//!
//! Grok loads `.grok/hooks/*.json` and `.cursor/hooks.json` only after
//! `/hooks-trust` writes `~/.grok/trusted_folders.toml`. GrokSpace does not
//! spawn grok. Host trust (FEAT-027) keeps worktree setup off until the
//! folder is trusted. This module lists hook files and reads grok's toml;
//! it does not run hooks, add HTTP hooks, or block tools.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{Error, Result};
use crate::project::{allows_project_hooks, get, trust_of, FolderTrust};
use crate::AppState;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectHooksStatus {
    pub host_trust: FolderTrust,
    pub hooks_allowed: bool,
    pub hook_files: Vec<String>,
    pub grok_trust_file: String,
    pub grok_lists_folder: bool,
}

pub fn grok_trusted_folders_path(home: &Path) -> PathBuf {
    home.join(".grok").join("trusted_folders.toml")
}

/// Best-effort: grok keys folders as quoted paths. Prefix matches are refused.
pub fn grok_toml_lists_folder(toml: &str, project_path: &str) -> bool {
    let trimmed = project_path.trim_end_matches('/');
    if trimmed.is_empty() {
        return false;
    }
    toml.contains(&format!("\"{trimmed}\""))
}

pub fn discover_hook_files(project: &Path) -> Vec<String> {
    let mut found = Vec::new();
    if project.join(".cursor").join("hooks.json").is_file() {
        found.push(".cursor/hooks.json".into());
    }
    let grok_hooks = project.join(".grok").join("hooks");
    if grok_hooks.is_dir() {
        if let Ok(entries) = fs::read_dir(&grok_hooks) {
            let mut names: Vec<String> = entries
                .filter_map(|entry| entry.ok())
                .filter(|entry| {
                    entry.path().extension().and_then(|ext| ext.to_str()) == Some("json")
                })
                .map(|entry| format!(".grok/hooks/{}", entry.file_name().to_string_lossy()))
                .collect();
            names.sort();
            found.extend(names);
        }
    }
    let claude = project.join(".claude").join("settings.json");
    if claude.is_file() {
        if let Ok(text) = fs::read_to_string(&claude) {
            if text.contains("\"hooks\"") {
                found.push(".claude/settings.json".into());
            }
        }
    }
    found
}

/// Host trust, hook files, and whether grok's toml lists this folder. No grok spawn.
#[tauri::command]
pub fn project_hooks_status(state: State<'_, AppState>, id: String) -> Result<ProjectHooksStatus> {
    state.with_db(|conn| {
        let project = get(conn, &id)?;
        let session = state
            .folder_trust
            .lock()
            .map_err(|_| Error::StatePoisoned)?;
        let host_trust = trust_of(conn, &session, &project.path)?;
        let grok_file = grok_trusted_folders_path(&dirs::home_dir().ok_or(Error::NoHomeDir)?);
        let grok_lists_folder = fs::read_to_string(&grok_file)
            .ok()
            .is_some_and(|text| grok_toml_lists_folder(&text, &project.path));
        Ok(ProjectHooksStatus {
            host_trust,
            hooks_allowed: allows_project_hooks(host_trust),
            hook_files: discover_hook_files(Path::new(&project.path)),
            grok_trust_file: grok_file.to_string_lossy().into_owned(),
            grok_lists_folder,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn untrusted_host_keeps_hooks_off() {
        assert!(!allows_project_hooks(FolderTrust::Unknown));
        assert!(!allows_project_hooks(FolderTrust::Denied));
        assert!(allows_project_hooks(FolderTrust::Once));
        assert!(allows_project_hooks(FolderTrust::Folder));
    }

    #[test]
    fn discovers_grok_and_cursor_hooks_not_mcp() {
        let root = TempDir::new().unwrap();
        let project = root.path();
        fs::create_dir_all(project.join(".grok").join("hooks")).unwrap();
        fs::write(
            project.join(".grok").join("hooks").join("lint.json"),
            "{}\n",
        )
        .unwrap();
        fs::create_dir_all(project.join(".cursor")).unwrap();
        fs::write(project.join(".cursor").join("hooks.json"), "{}\n").unwrap();
        fs::write(project.join(".mcp.json"), "{}\n").unwrap();
        fs::create_dir_all(project.join(".claude")).unwrap();
        fs::write(
            project.join(".claude").join("settings.json"),
            "{\"model\":\"x\"}\n",
        )
        .unwrap();

        assert_eq!(
            discover_hook_files(project),
            vec![
                ".cursor/hooks.json".to_string(),
                ".grok/hooks/lint.json".to_string()
            ]
        );
    }

    #[test]
    fn lists_claude_settings_only_when_it_has_hooks() {
        let root = TempDir::new().unwrap();
        let project = root.path();
        fs::create_dir_all(project.join(".claude")).unwrap();
        fs::write(
            project.join(".claude").join("settings.json"),
            "{\"hooks\":{}}\n",
        )
        .unwrap();
        assert_eq!(
            discover_hook_files(project),
            vec![".claude/settings.json".to_string()]
        );
    }

    #[test]
    fn grok_toml_matches_quoted_path_not_a_prefix() {
        let toml = "[folders.\"/tmp/acme-api\"]\ntrusted = true\n";
        assert!(grok_toml_lists_folder(toml, "/tmp/acme-api"));
        assert!(!grok_toml_lists_folder(toml, "/tmp/acme"));
        assert!(!grok_toml_lists_folder(toml, "/tmp/other"));
        assert!(!grok_toml_lists_folder("", "/tmp/acme-api"));
    }

    #[test]
    fn module_does_not_spawn_grok() {
        let src = include_str!("hooks.rs");
        assert!(!src.contains(&["std", "process"].join("::")));
        assert!(!src.contains(&["Command", "new"].join("::")));
    }
}
