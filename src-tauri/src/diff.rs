//! What the agents have changed, read out of git.
//!
//! Read-only on purpose. Staging, committing and reverting are decisions about a
//! repository, and undoing an agent's work is not something this app should own
//! before it can show that work clearly.
//!
//! The diff is the project's, not one session's. Per-session attribution would need
//! each agent in its own git worktree, which is why `sessions.worktree_path` is still
//! reserved — see `docs/grok-cli-integration.md` for why that is a phase rather than
//! polish.
//!
//! GrokSpace shells out to `git` rather than linking libgit2: it already spawns `grok`
//! and the user's shell, so a third is consistent, and a diff is text a command prints.

use std::path::Path;
use std::process::Command;

use serde::Serialize;
use tauri::State;

use crate::error::{Error, Result};
use crate::{program, project, AppState};

/// The most diff to carry across the IPC boundary for one file.
///
/// A generated lockfile or a committed binary can be megabytes, and the panel cannot
/// usefully show that. The same reasoning as the graph file's ceiling.
const MAX_DIFF_BYTES: usize = 512 * 1024;

/// What happened to one file, in the words `git status` uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FileChange {
    Added,
    Modified,
    Deleted,
    Renamed,
    /// New, and git has not been told about it. Common for an agent's first write.
    Untracked,
}

impl FileChange {
    /// From the two-letter code `git status --porcelain` prints.
    ///
    /// Either column counts: a file staged by one agent and edited by another shows a
    /// code in both, and the panel cares that it changed rather than where it sits.
    fn parse(code: &str) -> Self {
        let mut letters = code.chars().filter(|letter| *letter != ' ');
        match letters.next() {
            Some('?') => Self::Untracked,
            Some('A') => Self::Added,
            Some('D') => Self::Deleted,
            Some('R') => Self::Renamed,
            _ => Self::Modified,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub change: FileChange,
}

/// What the panel has to draw, as one of four things it can honestly say.
///
/// A tagged enum rather than a struct of optionals: "no git" and "clean" are different
/// sentences, and a `files: []` that meant either would have made the panel guess.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum DiffState {
    /// `git` is not installed, or not anywhere GrokSpace looks.
    GitMissing,
    /// The project folder is not inside a repository, so there is nothing to compare.
    NotARepo,
    Clean {
        branch: Option<String>,
    },
    Changed {
        branch: Option<String>,
        files: Vec<ChangedFile>,
    },
}

fn git(git: &str, cwd: &Path, args: &[&str]) -> Result<std::process::Output> {
    Command::new(git)
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|error| Error::Invalid(format!("could not run git: {error}")))
}

/// The branch name, or `None` on a detached head, which is not worth an error.
fn branch_of(git_path: &str, cwd: &Path) -> Option<String> {
    let output = git(git_path, cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).ok()?;
    if !output.status.success() {
        return None;
    }
    let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!name.is_empty() && name != "HEAD").then_some(name)
}

/// Splits one porcelain line into its code and its path.
///
/// A rename prints `old -> new`; the new name is the one worth showing, since that is
/// the file that now exists.
fn parse_line(line: &str) -> Option<ChangedFile> {
    if line.len() < 4 {
        return None;
    }
    let (code, rest) = line.split_at(2);
    let path = rest.trim();
    let path = path.rsplit(" -> ").next().unwrap_or(path);
    (!path.is_empty()).then(|| ChangedFile {
        path: path.trim_matches('"').to_string(),
        change: FileChange::parse(code),
    })
}

pub fn state_of(project_path: &Path) -> DiffState {
    let Some(git_path) = program::find("git") else {
        return DiffState::GitMissing;
    };

    let inside = git(
        &git_path,
        project_path,
        &["rev-parse", "--is-inside-work-tree"],
    );
    match inside {
        Ok(output) if output.status.success() => {}
        _ => return DiffState::NotARepo,
    }

    let branch = branch_of(&git_path, project_path);

    // Porcelain rather than `diff --name-status`, because it reports untracked files
    // too — and an agent's first write to a new file is untracked.
    let Ok(output) = git(&git_path, project_path, &["status", "--porcelain"]) else {
        return DiffState::Clean { branch };
    };
    let files: Vec<ChangedFile> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(parse_line)
        .collect();

    if files.is_empty() {
        DiffState::Clean { branch }
    } else {
        DiffState::Changed { branch, files }
    }
}

/// One file's diff against `HEAD`.
///
/// An untracked file has nothing in `HEAD` to compare with, so it is diffed against
/// nothing at all — which prints every line as an addition, and is what someone
/// looking at a new file wants to see.
pub fn of_file(project_path: &Path, path: &str, untracked: bool) -> Result<String> {
    let git_path = program::find("git")
        .ok_or_else(|| Error::Invalid("git is not installed, so there is no diff".into()))?;

    let output = if untracked {
        git(
            &git_path,
            project_path,
            &["diff", "--no-index", "--", "/dev/null", path],
        )?
    } else {
        git(&git_path, project_path, &["diff", "HEAD", "--", path])?
    };

    // `--no-index` exits non-zero when the files differ, which is the whole point of
    // asking, so the status is only trusted to be an error when nothing was printed.
    let text = String::from_utf8_lossy(&output.stdout);
    if text.is_empty() && !output.status.success() {
        let reason = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(Error::Invalid(if reason.is_empty() {
            format!("git could not diff {path}")
        } else {
            reason
        }));
    }

    if text.len() > MAX_DIFF_BYTES {
        return Err(Error::Invalid(format!(
            "{path} has more than {MAX_DIFF_BYTES} bytes of diff, which is more than \
             this panel can usefully show"
        )));
    }
    Ok(text.into_owned())
}

fn project_path(state: &State<'_, AppState>, project_id: &str) -> Result<String> {
    let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
    Ok(project::get(&conn, project_id)?.path)
}

#[tauri::command]
pub fn project_diff(state: State<'_, AppState>, project_id: String) -> Result<DiffState> {
    // The path is read under the lock and git is run after it: spawning a process is
    // slower than any query, and every command shares the one connection.
    let path = project_path(&state, &project_id)?;
    Ok(state_of(Path::new(&path)))
}

#[tauri::command]
pub fn file_diff(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
    untracked: bool,
) -> Result<String> {
    let root = project_path(&state, &project_id)?;
    of_file(Path::new(&root), &path, untracked)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("temp dir should be created");
        let git = program::find("git").expect("these tests need git");
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.email", "test@grokspace.dev"],
            vec!["config", "user.name", "GrokSpace Test"],
        ] {
            let done = Command::new(&git)
                .args(&args)
                .current_dir(dir.path())
                .output()
                .expect("git should run");
            assert!(done.status.success(), "git {args:?} failed");
        }
        dir
    }

    fn commit(dir: &Path, name: &str, contents: &str) {
        let git = program::find("git").expect("these tests need git");
        std::fs::write(dir.join(name), contents).unwrap();
        for args in [vec!["add", "."], vec!["commit", "-qm", "first"]] {
            Command::new(&git)
                .args(&args)
                .current_dir(dir)
                .output()
                .expect("git should run");
        }
    }

    #[test]
    fn a_folder_that_is_not_a_repository_says_so() {
        // Rather than reading as clean, which would claim the agents changed nothing.
        let dir = tempfile::tempdir().unwrap();

        assert_eq!(state_of(dir.path()), DiffState::NotARepo);
    }

    #[test]
    fn a_repository_with_nothing_changed_is_clean() {
        let dir = repo();
        commit(dir.path(), "README.md", "hello\n");

        assert!(matches!(state_of(dir.path()), DiffState::Clean { .. }));
    }

    #[test]
    fn a_modified_file_is_reported_as_modified() {
        let dir = repo();
        commit(dir.path(), "README.md", "hello\n");
        std::fs::write(dir.path().join("README.md"), "hello, again\n").unwrap();

        let DiffState::Changed { files, .. } = state_of(dir.path()) else {
            panic!("a modified file is a change")
        };
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "README.md");
        assert_eq!(files[0].change, FileChange::Modified);
    }

    #[test]
    fn a_file_git_has_never_seen_is_untracked_rather_than_missed() {
        // An agent's first write to a new file lands here, so `diff --name-status`
        // alone would have shown nothing at all.
        let dir = repo();
        commit(dir.path(), "README.md", "hello\n");
        std::fs::write(dir.path().join("new.rs"), "fn main() {}\n").unwrap();

        let DiffState::Changed { files, .. } = state_of(dir.path()) else {
            panic!("a new file is a change")
        };
        assert_eq!(files[0].change, FileChange::Untracked);
        assert_eq!(files[0].path, "new.rs");
    }

    #[test]
    fn a_deleted_file_is_reported_too() {
        let dir = repo();
        commit(dir.path(), "gone.txt", "here\n");
        std::fs::remove_file(dir.path().join("gone.txt")).unwrap();

        let DiffState::Changed { files, .. } = state_of(dir.path()) else {
            panic!("a deletion is a change")
        };
        assert_eq!(files[0].change, FileChange::Deleted);
    }

    #[test]
    fn a_tracked_file_diffs_against_head() {
        let dir = repo();
        commit(dir.path(), "README.md", "hello\n");
        std::fs::write(dir.path().join("README.md"), "goodbye\n").unwrap();

        let diff = of_file(dir.path(), "README.md", false).unwrap();

        assert!(diff.contains("-hello"));
        assert!(diff.contains("+goodbye"));
    }

    #[test]
    fn an_untracked_file_diffs_as_all_additions() {
        // There is nothing in HEAD to compare with, so every line is new - which is
        // what someone looking at a file an agent just wrote wants to see.
        let dir = repo();
        commit(dir.path(), "README.md", "hello\n");
        std::fs::write(dir.path().join("new.rs"), "fn main() {}\n").unwrap();

        let diff = of_file(dir.path(), "new.rs", true).unwrap();

        assert!(diff.contains("+fn main() {}"));
        assert!(!diff.contains("-fn main"));
    }

    #[test]
    fn the_status_code_is_read_from_either_column() {
        // A file staged by one agent and edited by another carries a letter in both,
        // and the panel cares that it changed rather than where it sits.
        assert_eq!(FileChange::parse(" M"), FileChange::Modified);
        assert_eq!(FileChange::parse("M "), FileChange::Modified);
        assert_eq!(FileChange::parse("MM"), FileChange::Modified);
        assert_eq!(FileChange::parse("??"), FileChange::Untracked);
        assert_eq!(FileChange::parse("A "), FileChange::Added);
        assert_eq!(FileChange::parse(" D"), FileChange::Deleted);
        assert_eq!(FileChange::parse("R "), FileChange::Renamed);
    }

    #[test]
    fn a_rename_is_reported_under_the_name_the_file_has_now() {
        let line = parse_line("R  old.rs -> new.rs").expect("a rename is a change");

        assert_eq!(line.path, "new.rs");
        assert_eq!(line.change, FileChange::Renamed);
    }

    #[test]
    fn a_line_too_short_to_be_a_status_is_skipped() {
        assert_eq!(parse_line(""), None);
        assert_eq!(parse_line(" M"), None);
    }
}
