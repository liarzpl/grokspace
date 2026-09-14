//! Session handoff pack: files on disk, not a share URL.
//!
//! The destination is a native folder picker (SEC-005: the webview does not
//! pass a path). `.env` and `worktreeinclude` stay out of the folder and the
//! patch. Import is not this command.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::error::{Error, Result};
use crate::{db, diff, graph, memory, project, session, steps, AppState};

const PACK_FILES: &[&str] = &[
    "graph.json",
    "steps.json",
    "memory.md",
    "transcript.md",
    "changes.patch",
];
const LEDGER_FILE: &str = "ledger-tail.jsonl";
const TRANSCRIPT_CHARS: usize = 8 * 1024;
const LEDGER_TAIL_LINES: usize = 50;

pub fn is_secret_path(path: &str) -> bool {
    let path = path.trim_matches('"').replace('\\', "/");
    path.split('/').any(|segment| {
        segment == ".env"
            || segment.starts_with(".env.")
            || segment == "worktreeinclude"
            || segment == ".worktreeinclude"
    })
}

fn skip_from_patch(path: &str) -> bool {
    let path = path.trim_matches('"');
    is_secret_path(path) || path == ".grokspace" || path.starts_with(".grokspace/")
}

pub fn cap_transcript(text: &str) -> String {
    let count = text.chars().count();
    if count <= TRANSCRIPT_CHARS {
        return text.to_string();
    }
    text.chars().skip(count - TRANSCRIPT_CHARS).collect()
}

fn steps_json(state: &AppState, project_path: &Path, session_id: &str) -> String {
    if let Some(text) = steps::read_steps_file(project_path, session_id) {
        return text;
    }
    state
        .with_db(|conn| steps::snapshot(conn, session_id))
        .ok()
        .and_then(|snapshot| serde_json::to_string_pretty(&snapshot).ok())
        .unwrap_or_else(|| "{}".into())
}

fn changes_patch(root: &Path) -> String {
    let Ok(diff::DiffState::Changed { files, .. }) = diff::state_of(root) else {
        return String::new();
    };
    let mut out = String::new();
    for file in files {
        if skip_from_patch(&file.path) {
            continue;
        }
        let untracked = file.change == diff::FileChange::Untracked;
        if let Ok(text) = diff::of_file(root, &file.path, untracked) {
            if text.is_empty() {
                continue;
            }
            out.push_str(&text);
            if !out.ends_with('\n') {
                out.push('\n');
            }
        }
    }
    out
}

fn ledger_tail(project_id: &str) -> Option<String> {
    let path = db::data_dir()
        .ok()?
        .join("ledgers")
        .join(format!("{project_id}.jsonl"));
    let text = std::fs::read_to_string(path).ok()?;
    if text.trim().is_empty() {
        return None;
    }
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(LEDGER_TAIL_LINES);
    Some(format!("{}\n", lines[start..].join("\n")))
}

fn pack_files(
    state: &AppState,
    project_path: &Path,
    project_id: &str,
    session_id: &str,
    worktree_path: Option<&str>,
    transcript: &str,
) -> BTreeMap<String, String> {
    let root = worktree_path
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(project_path));
    let mut files = BTreeMap::from([
        (
            "graph.json".into(),
            graph::snapshot(project_path, session_id)
                .json
                .unwrap_or_else(|| "{}".into()),
        ),
        (
            "steps.json".into(),
            steps_json(state, project_path, session_id),
        ),
        (
            "memory.md".into(),
            std::fs::read_to_string(memory::memory_file(project_path)).unwrap_or_default(),
        ),
        ("transcript.md".into(), cap_transcript(transcript)),
        ("changes.patch".into(), changes_patch(&root)),
    ]);
    if let Some(tail) = ledger_tail(project_id) {
        files.insert(LEDGER_FILE.into(), tail);
    }
    files
}

fn write_pack(dest: &Path, files: &BTreeMap<String, String>) -> Result<()> {
    debug_assert!(PACK_FILES.iter().all(|name| files.contains_key(*name)));
    std::fs::create_dir_all(dest)?;
    for (name, body) in files {
        if name.contains('/') || name.contains('\\') || is_secret_path(name) {
            continue;
        }
        std::fs::write(dest.join(name), body)?;
    }
    Ok(())
}

fn picked_folder_path(folder: tauri_plugin_dialog::FilePath) -> Result<PathBuf> {
    folder
        .simplified()
        .into_path()
        .map_err(|err| Error::Invalid(err.to_string()))
}

/// Writes the pack into `dest` (the folder itself).
pub fn export_session_to(
    state: &AppState,
    session_id: &str,
    transcript: &str,
    dest: &Path,
) -> Result<PathBuf> {
    let (project, session) = {
        let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
        let session = session::get(&conn, session_id)?;
        let project = project::get(&conn, &session.project_id)?;
        (project, session)
    };
    let files = pack_files(
        state,
        Path::new(&project.path),
        &project.id,
        &session.id,
        session.worktree_path.as_deref(),
        transcript,
    );
    write_pack(dest, &files)?;
    Ok(dest.to_path_buf())
}

/// Native folder picker. Cancel is `Ok(None)`. The webview does not pass a path.
#[tauri::command]
pub fn export_session_pack(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    transcript: String,
) -> Result<Option<String>> {
    let mut picker = app.dialog().file().set_title("Export handoff pack");
    if let Some(window) = app.get_webview_window("main") {
        picker = picker.set_parent(&window);
    }
    let Some(folder) = picker.blocking_pick_folder() else {
        return Ok(None);
    };
    let dest = picked_folder_path(folder)?.join(format!("handoff-{session_id}"));
    let written = export_session_to(&state, &session_id, &transcript, &dest)?;
    Ok(Some(written.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::sync::Mutex;

    use crate::graph::GraphWatchers;
    use crate::pty::PtyManager;
    use crate::steps::StepWatchers;
    use crate::{acp, db, program};

    fn git(dir: &Path, args: &[&str]) {
        let git = program::find("git").expect("git");
        let done = Command::new(git)
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git");
        assert!(done.status.success(), "git {args:?} failed");
    }

    #[test]
    fn writes_listed_files_without_env_and_caps_the_transcript() {
        let dir = tempfile::tempdir().expect("temp");
        git(dir.path(), &["init", "-q"]);
        git(dir.path(), &["config", "user.email", "test@grokspace.dev"]);
        git(dir.path(), &["config", "user.name", "GrokSpace Test"]);
        std::fs::write(dir.path().join("README.md"), "hello\n").unwrap();
        git(dir.path(), &["add", "."]);
        git(dir.path(), &["commit", "-qm", "first"]);
        std::fs::write(dir.path().join(".env"), "SECRET=do-not-export\n").unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/lib.rs"), "pub fn ok() {}\n").unwrap();
        std::fs::create_dir_all(dir.path().join(".grokspace")).unwrap();
        std::fs::write(dir.path().join(".grokspace/worktreeinclude"), ".env\n").unwrap();

        let conn = db::open_in_memory().expect("db");
        let project =
            project::upsert_by_path(&conn, dir.path().to_str().expect("utf-8"), "handoff-test")
                .expect("project");
        let session = session::insert(
            &conn,
            &project.id,
            None,
            session::SessionKind::Agent,
            "Reviewer",
            Some("Reviewer"),
        )
        .expect("session");
        let state = AppState {
            db: Mutex::new(conn),
            pty: PtyManager::new(),
            acp: acp::AcpManager::new(),
            graphs: GraphWatchers::new(),
            steps: StepWatchers::new(),
        };
        let dest = tempfile::tempdir().expect("dest");
        let long = format!("{}END", "x".repeat(TRANSCRIPT_CHARS + 32));
        export_session_to(&state, &session.id, &long, dest.path()).expect("export");

        let names: Vec<String> = std::fs::read_dir(dest.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        for required in PACK_FILES {
            assert!(names.iter().any(|name| name == required), "{names:?}");
        }
        assert!(!names
            .iter()
            .any(|name| name == ".env" || name.contains("worktreeinclude")));

        let patch = std::fs::read_to_string(dest.path().join("changes.patch")).unwrap();
        assert!(patch.contains("src/lib.rs"), "{patch}");
        assert!(!patch.contains("SECRET=do-not-export") && !patch.contains("worktreeinclude"));

        let transcript = std::fs::read_to_string(dest.path().join("transcript.md")).unwrap();
        assert!(transcript.ends_with("END"));
        assert!(transcript.chars().count() <= TRANSCRIPT_CHARS);
    }
}
