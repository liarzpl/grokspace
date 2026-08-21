//! What the agents have changed, read out of git.
//!
//! Read-only on the project's tree. A stopped agent's worktree can be Discarded
//! or Merged from the Diff panel — Merge commits leftover files on the session
//! branch, then `git merge`s that branch into the project.
//!
//! The default view is the project's. An ACP agent that got a worktree can be
//! selected so the panel reads *that* checkout — which is why
//! `sessions.worktree_path` is written at last.
//!
//! When two worktrees (or a worktree and the project) touch the same path, the
//! payload names the overlap. That is a warning: Merge stays clickable. Lockfiles
//! and migrations speak louder because they conflict more often, still without a
//! lock.
//!
//! GrokSpace shells out to `git` rather than linking libgit2: it already spawns `grok`
//! and the user's shell, so a third is consistent, and a diff is text a command prints.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use tauri::State;

use crate::error::{Error, Result};
use crate::{program, project, session, AppState};

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
        overlaps: Vec<PathOverlap>,
    },
    Changed {
        branch: Option<String>,
        files: Vec<ChangedFile>,
        overlaps: Vec<PathOverlap>,
    },
}

/// Another tree that also touched a path on screen. `session_id` is absent when
/// the other side is the project itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlapPeer {
    pub session_id: Option<String>,
    pub title: Option<String>,
}

/// One path touched by the tree on screen and by at least one other tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathOverlap {
    pub path: String,
    pub peers: Vec<OverlapPeer>,
    /// Lockfiles and migration paths: the same warning, a louder sentence.
    pub hotspot: bool,
}

/// A checkout that might share paths with the tree on screen. Not serialized;
/// `project_diff` builds these from the session list and `overlaps_with` reads them.
struct OverlapTree {
    session_id: Option<String>,
    title: Option<String>,
    path: PathBuf,
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

pub fn state_of(project_path: &Path) -> Result<DiffState> {
    let Some(git_path) = program::find("git") else {
        return Ok(DiffState::GitMissing);
    };

    let inside = git(
        &git_path,
        project_path,
        &["rev-parse", "--is-inside-work-tree"],
    );
    match inside {
        Ok(output) if output.status.success() => {}
        _ => return Ok(DiffState::NotARepo),
    }

    let branch = branch_of(&git_path, project_path);

    // Porcelain rather than `diff --name-status`, because it reports untracked files
    // too — and an agent's first write to a new file is untracked. `-uall` names
    // files inside a new directory so overlap can see `migrations/0001.sql` instead
    // of only `src-tauri/`. A spawn failure or a non-zero status used to read as
    // Clean, which claimed the agents changed nothing when git could not actually
    // answer.
    let output = git(&git_path, project_path, &["status", "--porcelain", "-uall"])?;
    interpret_porcelain(output, branch)
}

fn interpret_porcelain(output: std::process::Output, branch: Option<String>) -> Result<DiffState> {
    if !output.status.success() {
        let reason = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(Error::Invalid(if reason.is_empty() {
            "git status failed".into()
        } else {
            reason
        }));
    }
    let files: Vec<ChangedFile> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(parse_line)
        .collect();

    Ok(if files.is_empty() {
        DiffState::Clean {
            branch,
            overlaps: Vec::new(),
        }
    } else {
        DiffState::Changed {
            branch,
            files,
            overlaps: Vec::new(),
        }
    })
}

/// Paths GrokSpace owns. Graphs, steps, memory, and the worktrees themselves live
/// here; they are not the human's files, so they must not count as overlap.
fn is_grokspace_path(path: &str) -> bool {
    let path = path.trim_matches('"');
    path == ".grokspace" || path.starts_with(".grokspace/")
}

/// Lockfiles and migration directories speak louder than an ordinary shared path.
/// Still a warning: this does not refuse Merge.
fn is_hotspot(path: &str) -> bool {
    let path = path.trim_matches('"').trim_end_matches('/');
    let name = path.rsplit('/').next().unwrap_or(path);
    if name == "package-lock.json" || name == "Cargo.lock" {
        return true;
    }
    path.split('/').any(|segment| segment == "migrations")
}

fn rev_parse(git_path: &str, cwd: &Path, rev: &str) -> Option<String> {
    let output = git(git_path, cwd, &["rev-parse", rev]).ok()?;
    if !output.status.success() {
        return None;
    }
    let sha = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!sha.is_empty()).then_some(sha)
}

fn porcelain_paths(git_path: &str, cwd: &Path) -> BTreeSet<String> {
    let Ok(output) = git(git_path, cwd, &["status", "--porcelain", "-uall"]) else {
        return BTreeSet::new();
    };
    if !output.status.success() {
        return BTreeSet::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(parse_line)
        .map(|file| file.path)
        .filter(|path| !is_grokspace_path(path))
        .collect()
}

/// Committed changes on this tree since it forked from the project's `HEAD`.
///
/// `git diff --name-only <project-head>...HEAD` is the three-dot form: merge-base
/// to this `HEAD`. Uncommitted files are not in it; porcelain covers those.
fn committed_paths(git_path: &str, cwd: &Path, project_head: &str) -> BTreeSet<String> {
    let spec = format!("{project_head}...HEAD");
    let Ok(output) = git(git_path, cwd, &["diff", "--name-only", &spec]) else {
        return BTreeSet::new();
    };
    if !output.status.success() {
        return BTreeSet::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|line| line.trim().trim_matches('"').to_string())
        .filter(|path| !path.is_empty() && !is_grokspace_path(path))
        .collect()
}

fn touched_paths(git_path: &str, cwd: &Path, project_head: &str) -> BTreeSet<String> {
    if !cwd.exists() {
        return BTreeSet::new();
    }
    let mut paths = porcelain_paths(git_path, cwd);
    paths.extend(committed_paths(git_path, cwd, project_head));
    paths
}

fn sort_peers(peers: &mut [OverlapPeer]) {
    peers.sort_by(|left, right| match (&left.session_id, &right.session_id) {
        (Some(left), Some(right)) => left.cmp(right),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
}

/// Paths this tree shares with `peers`. Empty when git cannot answer; a miss
/// must not hide the diff itself. Never refuses Merge.
fn overlaps_with(ours: &Path, project_path: &Path, peers: &[OverlapTree]) -> Vec<PathOverlap> {
    let Some(git_path) = program::find("git") else {
        return Vec::new();
    };
    let Some(project_head) = rev_parse(&git_path, project_path, "HEAD") else {
        return Vec::new();
    };
    let ours_paths = touched_paths(&git_path, ours, &project_head);
    if ours_paths.is_empty() {
        return Vec::new();
    }

    let mut by_path: BTreeMap<String, Vec<OverlapPeer>> = BTreeMap::new();
    for peer in peers {
        if peer.path == ours {
            continue;
        }
        let theirs = touched_paths(&git_path, &peer.path, &project_head);
        for path in ours_paths.intersection(&theirs) {
            by_path.entry(path.clone()).or_default().push(OverlapPeer {
                session_id: peer.session_id.clone(),
                title: peer.title.clone(),
            });
        }
    }

    by_path
        .into_iter()
        .filter_map(|(path, mut peers)| {
            sort_peers(&mut peers);
            peers.dedup_by(|left, right| left.session_id == right.session_id);
            if peers.is_empty() {
                return None;
            }
            let hotspot = is_hotspot(&path);
            Some(PathOverlap {
                path,
                peers,
                hotspot,
            })
        })
        .collect()
}

/// Resolves `path` to a location inside `project_path`, as a path relative to it.
///
/// Absolute paths, `..`, and anything that canonicalizes outside the project are
/// refused so `git diff --no-index` cannot be pointed at a file the panel should
/// never have seen.
fn confined_to_project(project_path: &Path, path: &str) -> Result<PathBuf> {
    if path.trim().is_empty() {
        return Err(Error::Invalid("a file path is required".into()));
    }
    let root = project_path
        .canonicalize()
        .map_err(|error| Error::Invalid(format!("could not resolve the project path: {error}")))?;

    let requested = Path::new(path);
    let joined = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        root.join(requested)
    };

    let resolved = match joined.canonicalize() {
        Ok(canonical) => canonical,
        Err(_) => {
            let name = joined
                .file_name()
                .ok_or_else(|| Error::Invalid(format!("{path} is outside the project")))?;
            let parent = joined
                .parent()
                .ok_or_else(|| Error::Invalid(format!("{path} is outside the project")))?;
            let parent = parent
                .canonicalize()
                .map_err(|_| Error::Invalid(format!("{path} is outside the project")))?;
            parent.join(name)
        }
    };

    if !resolved.starts_with(&root) {
        return Err(Error::Invalid(format!("{path} is outside the project")));
    }
    let relative = resolved
        .strip_prefix(&root)
        .map_err(|_| Error::Invalid(format!("{path} is outside the project")))?;
    if relative.as_os_str().is_empty() {
        return Err(Error::Invalid(format!("{path} is outside the project")));
    }
    Ok(relative.to_path_buf())
}

/// One file's diff against `HEAD`.
///
/// An untracked file has nothing in `HEAD` to compare with, so it is diffed against
/// nothing at all — which prints every line as an addition, and is what someone
/// looking at a new file wants to see.
pub fn of_file(project_path: &Path, path: &str, untracked: bool) -> Result<String> {
    let git_path = program::find("git")
        .ok_or_else(|| Error::Invalid("git is not installed, so there is no diff".into()))?;

    let jailed = confined_to_project(project_path, path)?;
    let jailed = jailed
        .to_str()
        .ok_or_else(|| Error::Invalid("the file path is not valid UTF-8".into()))?;

    let output = if untracked {
        git(
            &git_path,
            project_path,
            &["diff", "--no-index", "--", "/dev/null", jailed],
        )?
    } else {
        git(&git_path, project_path, &["diff", "HEAD", "--", jailed])?
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

/// The folder `git status` should run in: a session's worktree, or the project.
fn diff_root(
    state: &State<'_, AppState>,
    project_id: &str,
    session_id: Option<&str>,
) -> Result<PathBuf> {
    let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
    let project = project::get(&conn, project_id)?;
    let Some(session_id) = session_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return Ok(PathBuf::from(project.path));
    };
    let chosen = session::get(&conn, session_id)?;
    if chosen.project_id != project.id {
        return Err(Error::Invalid(
            "that session does not belong to this project".into(),
        ));
    }
    chosen
        .worktree_path
        .map(PathBuf::from)
        .ok_or_else(|| Error::Invalid("this session has no worktree".into()))
}

/// The tree on screen plus every other worktree-scoped session (and the project,
/// when the screen is a session). Paths are read under the lock; git runs after.
fn overlap_peers(
    state: &State<'_, AppState>,
    project_id: &str,
    session_id: Option<&str>,
) -> Result<(PathBuf, PathBuf, Vec<OverlapTree>)> {
    let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
    let project = project::get(&conn, project_id)?;
    let ours_id = session_id.map(str::trim).filter(|id| !id.is_empty());
    let root = match ours_id {
        None => PathBuf::from(&project.path),
        Some(id) => {
            let chosen = session::get(&conn, id)?;
            if chosen.project_id != project.id {
                return Err(Error::Invalid(
                    "that session does not belong to this project".into(),
                ));
            }
            chosen
                .worktree_path
                .map(PathBuf::from)
                .ok_or_else(|| Error::Invalid("this session has no worktree".into()))?
        }
    };

    let mut peers = Vec::new();
    if ours_id.is_some() {
        peers.push(OverlapTree {
            session_id: None,
            title: None,
            path: PathBuf::from(&project.path),
        });
    }
    for other in session::list(&conn, project_id)? {
        if ours_id == Some(other.id.as_str()) {
            continue;
        }
        let Some(path) = other.worktree_path else {
            continue;
        };
        peers.push(OverlapTree {
            session_id: Some(other.id),
            title: other.title,
            path: PathBuf::from(path),
        });
    }
    Ok((root, PathBuf::from(project.path), peers))
}

#[tauri::command]
pub fn project_diff(
    state: State<'_, AppState>,
    project_id: String,
    session_id: Option<String>,
) -> Result<DiffState> {
    // The path is read under the lock and git is run after it: spawning a process is
    // slower than any query, and every command shares the one connection.
    let (path, project_path, peers) = overlap_peers(&state, &project_id, session_id.as_deref())?;
    let mut diff = state_of(&path)?;
    match &mut diff {
        DiffState::Clean { overlaps, .. } | DiffState::Changed { overlaps, .. } => {
            *overlaps = overlaps_with(&path, &project_path, &peers);
        }
        _ => {}
    }
    Ok(diff)
}

#[tauri::command]
pub fn file_diff(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
    untracked: bool,
    session_id: Option<String>,
) -> Result<String> {
    let root = diff_root(&state, &project_id, session_id.as_deref())?;
    of_file(&root, &path, untracked)
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

        assert_eq!(state_of(dir.path()).unwrap(), DiffState::NotARepo);
    }

    #[test]
    fn a_repository_with_nothing_changed_is_clean() {
        let dir = repo();
        commit(dir.path(), "README.md", "hello\n");

        assert!(matches!(
            state_of(dir.path()).unwrap(),
            DiffState::Clean { .. }
        ));
    }

    #[test]
    fn a_modified_file_is_reported_as_modified() {
        let dir = repo();
        commit(dir.path(), "README.md", "hello\n");
        std::fs::write(dir.path().join("README.md"), "hello, again\n").unwrap();

        let DiffState::Changed { files, .. } = state_of(dir.path()).unwrap() else {
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

        let DiffState::Changed { files, .. } = state_of(dir.path()).unwrap() else {
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

        let DiffState::Changed { files, .. } = state_of(dir.path()).unwrap() else {
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

    #[cfg(unix)]
    #[test]
    fn a_failed_porcelain_is_an_error_rather_than_clean() {
        use std::os::unix::process::ExitStatusExt;
        let output = std::process::Output {
            status: std::process::ExitStatus::from_raw(128 << 8),
            stdout: Vec::new(),
            stderr: b"fatal: index file corrupt\n".to_vec(),
        };

        let error = interpret_porcelain(output, Some("main".into())).unwrap_err();
        assert!(
            error.to_string().contains("index file corrupt"),
            "got: {error}"
        );
    }

    #[test]
    fn a_path_outside_the_project_is_refused() {
        let dir = repo();
        commit(dir.path(), "README.md", "hello\n");
        let secret =
            std::env::temp_dir().join(format!("grokspace-jail-secret-{}", std::process::id()));
        std::fs::write(&secret, "TOP SECRET\n").unwrap();

        let result = of_file(dir.path(), secret.to_str().unwrap(), true);
        let _ = std::fs::remove_file(&secret);
        match result {
            Ok(text) => {
                assert!(
                    !text.contains("TOP SECRET"),
                    "an escaped path must not leak file contents"
                );
                panic!("a path outside the project must be refused");
            }
            Err(error) => assert!(error.to_string().contains("outside"), "got: {error}"),
        }

        assert!(
            of_file(dir.path(), "../secret.txt", true).is_err(),
            "a relative escape must be refused too"
        );
    }

    #[test]
    fn a_worktree_status_does_not_include_the_project_tree() {
        let dir = repo();
        commit(dir.path(), "README.md", "hello\n");
        let tree = crate::worktree::add(dir.path(), "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
            .path()
            .expect("a real repo should isolate");
        std::fs::write(tree.join("agent.rs"), "fn main() {}\n").unwrap();
        std::fs::write(dir.path().join("human.rs"), "on the project\n").unwrap();

        let DiffState::Changed { files, .. } = state_of(&tree).unwrap() else {
            panic!("the agent's file is a change")
        };
        assert!(
            files.iter().any(|file| file.path == "agent.rs"),
            "got {files:?}"
        );
        assert!(
            files.iter().all(|file| file.path != "human.rs"),
            "the project's dirty file must not leak into the worktree status, got {files:?}"
        );

        let DiffState::Changed { files, .. } = state_of(dir.path()).unwrap() else {
            panic!("the project's file is a change")
        };
        assert!(
            files.iter().all(|file| file.path != "agent.rs"),
            "the agent's file must not leak into the project status, got {files:?}"
        );
    }

    fn checkout(dir: &tempfile::TempDir, session: &str) -> PathBuf {
        crate::worktree::add(dir.path(), session)
            .path()
            .expect("a real repo should isolate")
    }

    fn peer(session_id: &str, title: &str, path: PathBuf) -> OverlapTree {
        OverlapTree {
            session_id: Some(session_id.into()),
            title: Some(title.into()),
            path,
        }
    }

    #[test]
    fn lockfiles_and_migrations_are_hotspots() {
        assert!(is_hotspot("Cargo.lock"));
        assert!(is_hotspot("package-lock.json"));
        assert!(is_hotspot("src-tauri/Cargo.lock"));
        assert!(is_hotspot("src-tauri/migrations/0001_initial.sql"));
        assert!(is_hotspot("migrations/20240101_init.sql"));
        assert!(is_hotspot("src-tauri/migrations"));
        assert!(!is_hotspot("src/lib.rs"));
        assert!(!is_hotspot("migrations.rs"));
        assert!(!is_hotspot("package.json"));
    }

    #[test]
    fn two_worktrees_touching_the_same_path_are_an_overlap() {
        let dir = repo();
        commit(dir.path(), "README.md", "hello\n");
        let a = checkout(&dir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
        let b = checkout(&dir, "bbbbbbbb-cccc-dddd-eeee-ffffffffffff");
        std::fs::write(a.join("agent.rs"), "fn a() {}\n").unwrap();
        std::fs::write(b.join("agent.rs"), "fn b() {}\n").unwrap();

        let overlaps = overlaps_with(
            &a,
            dir.path(),
            &[peer("bbbbbbbb-cccc-dddd-eeee-ffffffffffff", "Reviewer", b)],
        );

        assert_eq!(overlaps.len(), 1, "got {overlaps:?}");
        assert_eq!(overlaps[0].path, "agent.rs");
        assert!(!overlaps[0].hotspot);
        assert_eq!(
            overlaps[0].peers,
            vec![OverlapPeer {
                session_id: Some("bbbbbbbb-cccc-dddd-eeee-ffffffffffff".into()),
                title: Some("Reviewer".into()),
            }]
        );
    }

    #[test]
    fn a_session_and_the_project_touching_the_same_path_are_an_overlap() {
        let dir = repo();
        commit(dir.path(), "README.md", "hello\n");
        let tree = checkout(&dir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
        std::fs::write(tree.join("README.md"), "agent\n").unwrap();
        std::fs::write(dir.path().join("README.md"), "human\n").unwrap();

        let overlaps = overlaps_with(
            &tree,
            dir.path(),
            &[OverlapTree {
                session_id: None,
                title: None,
                path: dir.path().to_path_buf(),
            }],
        );

        assert_eq!(overlaps.len(), 1, "got {overlaps:?}");
        assert_eq!(overlaps[0].path, "README.md");
        assert_eq!(
            overlaps[0].peers,
            vec![OverlapPeer {
                session_id: None,
                title: None,
            }]
        );
    }

    #[test]
    fn different_paths_are_not_an_overlap() {
        let dir = repo();
        commit(dir.path(), "README.md", "hello\n");
        let a = checkout(&dir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
        let b = checkout(&dir, "bbbbbbbb-cccc-dddd-eeee-ffffffffffff");
        std::fs::write(a.join("a.rs"), "fn a() {}\n").unwrap();
        std::fs::write(b.join("b.rs"), "fn b() {}\n").unwrap();

        let overlaps = overlaps_with(
            &a,
            dir.path(),
            &[peer("bbbbbbbb-cccc-dddd-eeee-ffffffffffff", "Reviewer", b)],
        );
        assert!(overlaps.is_empty(), "got {overlaps:?}");
    }

    #[test]
    fn committed_changes_since_the_fork_count_when_the_tree_is_clean() {
        let dir = repo();
        commit(dir.path(), "README.md", "hello\n");
        let a = checkout(&dir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
        let b = checkout(&dir, "bbbbbbbb-cccc-dddd-eeee-ffffffffffff");
        commit(&a, "agent.rs", "fn a() {}\n");
        commit(&b, "agent.rs", "fn b() {}\n");

        assert!(
            matches!(state_of(&a).unwrap(), DiffState::Clean { .. }),
            "the overlap has to be visible after leftover commit, not only while dirty"
        );

        let overlaps = overlaps_with(
            &a,
            dir.path(),
            &[peer("bbbbbbbb-cccc-dddd-eeee-ffffffffffff", "Reviewer", b)],
        );
        assert_eq!(overlaps.len(), 1, "got {overlaps:?}");
        assert_eq!(overlaps[0].path, "agent.rs");
    }

    #[test]
    fn a_shared_lockfile_is_a_hotspot() {
        let dir = repo();
        commit(dir.path(), "README.md", "hello\n");
        let a = checkout(&dir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
        let b = checkout(&dir, "bbbbbbbb-cccc-dddd-eeee-ffffffffffff");
        std::fs::write(a.join("Cargo.lock"), "a\n").unwrap();
        std::fs::write(b.join("Cargo.lock"), "b\n").unwrap();

        let overlaps = overlaps_with(
            &a,
            dir.path(),
            &[peer("bbbbbbbb-cccc-dddd-eeee-ffffffffffff", "Reviewer", b)],
        );
        assert_eq!(overlaps.len(), 1, "got {overlaps:?}");
        assert_eq!(overlaps[0].path, "Cargo.lock");
        assert!(overlaps[0].hotspot);
    }

    #[test]
    fn a_shared_migration_is_a_hotspot() {
        let dir = repo();
        commit(dir.path(), "README.md", "hello\n");
        let a = checkout(&dir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
        let b = checkout(&dir, "bbbbbbbb-cccc-dddd-eeee-ffffffffffff");
        std::fs::create_dir_all(a.join("src-tauri/migrations")).unwrap();
        std::fs::create_dir_all(b.join("src-tauri/migrations")).unwrap();
        std::fs::write(a.join("src-tauri/migrations/0001.sql"), "a\n").unwrap();
        std::fs::write(b.join("src-tauri/migrations/0001.sql"), "b\n").unwrap();

        let overlaps = overlaps_with(
            &a,
            dir.path(),
            &[peer("bbbbbbbb-cccc-dddd-eeee-ffffffffffff", "Reviewer", b)],
        );
        assert_eq!(overlaps.len(), 1, "got {overlaps:?}");
        assert_eq!(overlaps[0].path, "src-tauri/migrations/0001.sql");
        assert!(overlaps[0].hotspot);
    }

    #[test]
    fn grokspace_paths_do_not_count_as_overlap() {
        let dir = repo();
        commit(dir.path(), "README.md", "hello\n");
        let a = checkout(&dir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
        let b = checkout(&dir, "bbbbbbbb-cccc-dddd-eeee-ffffffffffff");
        std::fs::create_dir_all(a.join(".grokspace/graphs")).unwrap();
        std::fs::create_dir_all(b.join(".grokspace/graphs")).unwrap();
        std::fs::write(a.join(".grokspace/graphs/a.json"), "{}\n").unwrap();
        std::fs::write(b.join(".grokspace/graphs/a.json"), "{}\n").unwrap();

        let overlaps = overlaps_with(
            &a,
            dir.path(),
            &[peer("bbbbbbbb-cccc-dddd-eeee-ffffffffffff", "Reviewer", b)],
        );
        assert!(overlaps.is_empty(), "got {overlaps:?}");
    }
}
