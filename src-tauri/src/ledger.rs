//! Append-only permission ledger (FEAT-015).
//!
//! `~/.grokspace/ledgers/<project-id>.jsonl`, next to `logs/`. Never a worktree
//! Discard deletes. Local file only; no network.

use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::db;
use crate::error::{Error, Result};

pub const DEFAULT_TAIL: usize = 20;
const MAX_TAIL: usize = 50;
const MAX_SUMMARY_CHARS: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEntry {
    pub time: i64,
    pub session_id: String,
    pub request_id: u64,
    pub summary: String,
    pub chip: String,
    pub option_id: Option<String>,
}

pub fn default_path(project_id: &str) -> Result<PathBuf> {
    path_in(&db::data_dir()?, project_id)
}

pub fn path_in(data_dir: &Path, project_id: &str) -> Result<PathBuf> {
    let id = project_id.trim();
    if id.is_empty() || id.contains(['/', '\\', '\0']) || id.contains("..") {
        return Err(Error::Invalid(
            "that project id is not a usable ledger name".into(),
        ));
    }
    Ok(data_dir.join("ledgers").join(format!("{id}.jsonl")))
}

/// Primary Allow omits `option_id` (`allow_once`). A named Always chip sends one.
pub fn chip_for(allow: bool, option_id: Option<&str>) -> &'static str {
    if !allow {
        "deny"
    } else if option_id.map(str::trim).is_some_and(|id| !id.is_empty()) {
        "always"
    } else {
        "allow_once"
    }
}

fn entry(
    session_id: &str,
    request_id: u64,
    summary: &str,
    allow: bool,
    option_id: Option<&str>,
) -> LedgerEntry {
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
    LedgerEntry {
        time: db::now_ms(),
        session_id: session_id.to_string(),
        request_id,
        summary,
        chip: chip_for(allow, option_id).to_string(),
        option_id: option_id
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_string),
    }
}

/// Best-effort: a full disk must not leave the agent stuck.
pub fn record_answer(
    project_id: &str,
    session_id: &str,
    request_id: u64,
    summary: &str,
    allow: bool,
    option_id: Option<&str>,
) {
    if let Ok(path) = default_path(project_id) {
        let _ = append_to(
            &path,
            &entry(session_id, request_id, summary, allow, option_id),
        );
    }
}

pub fn append_to(path: &Path, entry: &LedgerEntry) -> Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    serde_json::to_writer(&mut file, entry)?;
    file.write_all(b"\n")?;
    file.flush()?;
    Ok(())
}

pub fn tail_path(path: &Path, limit: usize) -> Result<Vec<LedgerEntry>> {
    let n = limit.clamp(1, MAX_TAIL);
    let Ok(file) = fs::File::open(path) else {
        return Ok(Vec::new());
    };
    let mut lines = Vec::new();
    for line in BufReader::new(file).lines().map_while(std::io::Result::ok) {
        if let Ok(entry) = serde_json::from_str::<LedgerEntry>(line.trim()) {
            lines.push(entry);
        }
    }
    if lines.len() > n {
        lines.drain(0..lines.len() - n);
    }
    Ok(lines)
}

#[tauri::command]
pub fn list_permission_ledger(project_id: String, limit: Option<u32>) -> Result<Vec<LedgerEntry>> {
    tail_path(
        &default_path(&project_id)?,
        limit.map(|n| n as usize).unwrap_or(DEFAULT_TAIL),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree;

    fn write_answer(dir: &Path, allow: bool, option_id: Option<&str>) -> PathBuf {
        let path = path_in(dir, "proj-1").expect("path");
        append_to(
            &path,
            &entry("sess-1", 9, "Edit src/lib.rs", allow, option_id),
        )
        .expect("append");
        path
    }

    #[test]
    fn path_is_not_a_worktree_and_writer_has_no_network() {
        let path = default_path("proj-1").expect("home");
        assert!(path.ends_with(Path::new(".grokspace").join("ledgers").join("proj-1.jsonl")));
        assert!(!path.components().any(|c| c.as_os_str() == "worktrees"));
        assert!(!path.starts_with(worktree::path_for(Path::new("/repos/app"), "sess-1")));
        let src = include_str!("ledger.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("impl");
        for needle in ["TcpStream", "reqwest", "ureq", "https://"] {
            assert!(!src.contains(needle), "{needle}");
        }
        assert!(path_in(Path::new("/tmp"), "../etc").is_err());
    }

    #[test]
    fn answer_writes_one_json_line() {
        let dir = tempfile::tempdir().expect("temp");
        let lines = tail_path(&write_answer(dir.path(), true, None), 20).expect("tail");
        assert_eq!(lines[0].session_id, "sess-1");
        assert_eq!(lines[0].request_id, 9);
        assert_eq!(lines[0].summary, "Edit src/lib.rs");
        assert_eq!(lines[0].chip, "allow_once");
        assert_eq!(chip_for(true, Some("allow-always")), "always");
        assert_eq!(chip_for(false, None), "deny");
        assert!(!entry("s", 1, "Edit x\nsecret", true, None)
            .summary
            .contains('\n'));
    }

    #[test]
    fn tail_last_n_skips_junk_and_missing() {
        let dir = tempfile::tempdir().expect("temp");
        assert!(tail_path(&path_in(dir.path(), "nobody").expect("p"), 20)
            .expect("empty")
            .is_empty());
        let path = path_in(dir.path(), "proj-1").expect("path");
        fs::create_dir_all(path.parent().expect("dir")).expect("mkdir");
        fs::write(&path, "{\"nope\":1}\nnot-json\n").expect("seed");
        write_answer(dir.path(), true, Some("allow-always"));
        let lines = tail_path(&path, 1).expect("tail");
        assert_eq!(lines[0].chip, "always");
        assert_eq!(lines[0].option_id.as_deref(), Some("allow-always"));
    }
}
