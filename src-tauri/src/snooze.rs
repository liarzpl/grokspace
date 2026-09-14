//! Inbox snooze timestamps (`FEAT-024`).
//!
//! `~/.grokspace/inbox-snooze.json`. Local file only. Hides a Needs you item
//! in the renderer; the host never answers `session/request_permission`.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::db;
use crate::error::Result;

const FILE_NAME: &str = "inbox-snooze.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct SnoozeFile {
    #[serde(default)]
    until: HashMap<String, i64>,
}

pub fn default_path() -> Result<PathBuf> {
    Ok(db::data_dir()?.join(FILE_NAME))
}

fn usable_id(id: &str) -> bool {
    let id = id.trim();
    !id.is_empty() && !id.contains(['/', '\\', '\0']) && !id.contains("..")
}

fn sanitize(until: &HashMap<String, i64>) -> HashMap<String, i64> {
    let mut clean = HashMap::new();
    for (id, at) in until {
        if usable_id(id) && *at > 0 {
            clean.insert(id.clone(), *at);
        }
    }
    clean
}

pub fn load(path: &Path) -> HashMap<String, i64> {
    let Ok(text) = fs::read_to_string(path) else {
        return HashMap::new();
    };
    serde_json::from_str::<SnoozeFile>(&text)
        .map(|file| sanitize(&file.until))
        .unwrap_or_default()
}

pub fn save(path: &Path, until: &HashMap<String, i64>) -> Result<HashMap<String, i64>> {
    let clean = sanitize(until);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let body = serde_json::to_string_pretty(&SnoozeFile {
        until: clean.clone(),
    })?;
    fs::write(path, format!("{body}\n"))?;
    Ok(clean)
}

#[tauri::command]
pub fn read_inbox_snooze() -> Result<HashMap<String, i64>> {
    Ok(load(&default_path()?))
}

#[tauri::command]
pub fn write_inbox_snooze(until: HashMap<String, i64>) -> Result<HashMap<String, i64>> {
    save(&default_path()?, &until)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_or_junk_is_empty_so_every_wait_shows() {
        let dir = tempfile::tempdir().expect("temp");
        let path = dir.path().join(FILE_NAME);
        assert!(load(&path).is_empty());
        fs::write(&path, "not-json").expect("junk");
        assert!(load(&path).is_empty());
    }

    #[test]
    fn roundtrip_drops_unusable_ids_and_never_answers_acp() {
        let dir = tempfile::tempdir().expect("temp");
        let path = dir.path().join(FILE_NAME);
        let mut until = HashMap::new();
        until.insert("sess-1".into(), 1_700_000_000_000);
        until.insert("../etc".into(), 9);
        until.insert(String::new(), 9);
        until.insert("gone".into(), 0);
        let stored = save(&path, &until).expect("save");
        assert_eq!(stored.get("sess-1"), Some(&1_700_000_000_000));
        assert_eq!(stored.len(), 1);
        assert_eq!(load(&path).get("sess-1"), Some(&1_700_000_000_000));
        assert!(default_path().expect("home").ends_with(FILE_NAME));
        let src = include_str!("snooze.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("impl");
        assert!(!src.contains("answer_session_permission"));
        for needle in ["TcpStream", "reqwest", "ureq", "https://"] {
            assert!(!src.contains(needle), "{needle}");
        }
    }
}
