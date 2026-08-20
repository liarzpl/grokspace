//! Git worktrees for ACP agents.
//!
//! An agent writes in its own checkout so its diff is its own. Grok panes and
//! shells stay on the project folder: that is the tree a person is looking at.
//!
//! GrokSpace calls `git worktree add` itself rather than passing `grok --worktree`.
//! Every extra flag is a way for a session to fail to start on a `grok` that does
//! not recognise it — the same reason graphs, memory, and roles stay out of flags.
//!
//! Isolation is best-effort. Missing git, a folder that is not a repository, or a
//! `worktree add` that fails all mean the agent starts in the project folder with
//! no `worktree_path`, rather than refusing to start at all.
//!
//! No Tauri, no database: tests drive real git against temporary repositories.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::error::{Error, Result};
use crate::program;

/// Where an agent's checkout lives, relative to the project folder.
///
/// Under `.grokspace/` so walk-up from the worktree still finds the project's
/// `AGENTS.md` and `.grok`. A tree under `~/.grokspace` would not.
pub fn path_for(project_path: &Path, session_id: &str) -> PathBuf {
    project_path
        .join(".grokspace")
        .join("worktrees")
        .join(session_id)
}

/// The branch created for a session. Named from the id so two agents never share
/// one, short enough to read on a chip.
pub fn branch_name(session_id: &str) -> String {
    let short: String = session_id
        .chars()
        .filter(|character| character.is_ascii_hexdigit())
        .take(8)
        .collect();
    format!("grokspace/{short}")
}

fn git(git: &str, cwd: &Path, args: &[&str]) -> Result<std::process::Output> {
    Command::new(git)
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|error| Error::Invalid(format!("could not run git: {error}")))
}

fn is_repo(git_path: &str, project_path: &Path) -> bool {
    git(
        git_path,
        project_path,
        &["rev-parse", "--is-inside-work-tree"],
    )
    .ok()
    .is_some_and(|output| output.status.success())
}

/// Creates a clean checkout of `HEAD` for this session, or `None` when isolation
/// is not possible. An existing directory is reused: Restart keeps the files.
pub fn add(project_path: &Path, session_id: &str) -> Option<PathBuf> {
    let git_path = program::find("git")?;
    if !is_repo(&git_path, project_path) {
        return None;
    }

    let dest = path_for(project_path, session_id);
    if dest.is_dir() {
        return Some(dest);
    }

    let parent = dest.parent()?;
    std::fs::create_dir_all(parent).ok()?;

    let branch = branch_name(session_id);
    let dest_str = dest.to_str()?;
    let output = git(
        &git_path,
        project_path,
        &["worktree", "add", "-b", &branch, dest_str],
    )
    .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(dest)
}

/// Whether the worktree has uncommitted or untracked changes.
///
/// A missing directory is not dirty: Close should not get stuck on a tree that
/// is already gone.
pub fn is_dirty(worktree_path: &Path) -> Result<bool> {
    if !worktree_path.exists() {
        return Ok(false);
    }
    let git_path = program::find("git").ok_or_else(|| {
        Error::Invalid("git is not installed, so the worktree cannot be inspected".into())
    })?;
    let output = git(&git_path, worktree_path, &["status", "--porcelain"])?;
    if !output.status.success() {
        let reason = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(Error::Invalid(if reason.is_empty() {
            "git status failed in the worktree".into()
        } else {
            reason
        }));
    }
    Ok(!String::from_utf8_lossy(&output.stdout).trim().is_empty())
}

fn current_branch(git_path: &str, worktree_path: &Path) -> Option<String> {
    let output = git(
        git_path,
        worktree_path,
        &["rev-parse", "--abbrev-ref", "HEAD"],
    )
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!name.is_empty() && name != "HEAD").then_some(name)
}

/// Unregisters the worktree. Without `force`, a dirty tree is refused so Close
/// cannot eat uncommitted work. The branch is deleted afterwards: leaving one
/// per session would pile up `grokspace/` names nobody merges in this half.
pub fn remove(project_path: &Path, worktree_path: &Path, force: bool) -> Result<()> {
    if !worktree_path.exists() {
        return Ok(());
    }
    if !force && is_dirty(worktree_path)? {
        return Err(Error::Invalid(
            "this agent still has uncommitted work — discard it from the Diff panel first".into(),
        ));
    }

    let git_path = program::find("git").ok_or_else(|| {
        Error::Invalid("git is not installed, so the worktree cannot be removed".into())
    })?;
    let branch = current_branch(&git_path, worktree_path);
    let dest = worktree_path
        .to_str()
        .ok_or_else(|| Error::Invalid("the worktree path is not valid UTF-8".into()))?;

    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(dest);
    let output = git(&git_path, project_path, &args)?;
    if !output.status.success() {
        let reason = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(Error::Invalid(if reason.is_empty() {
            "git could not remove the worktree".into()
        } else {
            reason
        }));
    }

    if let Some(branch) = branch {
        let _ = git(&git_path, project_path, &["branch", "-D", &branch]);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;

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
        fs::write(dir.path().join("README.md"), "hello\n").unwrap();
        for args in [vec!["add", "."], vec!["commit", "-qm", "first"]] {
            let done = Command::new(&git)
                .args(&args)
                .current_dir(dir.path())
                .output()
                .expect("git should run");
            assert!(done.status.success(), "git {args:?} failed");
        }
        dir
    }

    fn porcelain(cwd: &Path) -> String {
        let git = program::find("git").expect("these tests need git");
        let output = Command::new(git)
            .args(["status", "--porcelain"])
            .current_dir(cwd)
            .output()
            .expect("git status should run");
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    #[test]
    fn a_folder_that_is_not_a_repository_gets_no_worktree() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            add(dir.path(), "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
            None
        );
    }

    #[test]
    fn add_checks_out_head_on_a_session_branch() {
        let dir = repo();
        let session = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        let tree = add(dir.path(), session).expect("a real repo should isolate");

        assert_eq!(tree, path_for(dir.path(), session));
        assert!(tree.join("README.md").is_file());
        assert_eq!(
            fs::read_to_string(tree.join("README.md")).unwrap(),
            "hello\n"
        );
        assert!(!is_dirty(&tree).unwrap());
        assert_eq!(branch_name(session), "grokspace/aaaaaaaa");
    }

    #[test]
    fn a_file_written_in_the_worktree_does_not_dirty_the_project() {
        let dir = repo();
        let tree = add(dir.path(), "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee").unwrap();
        fs::write(tree.join("agent.rs"), "fn main() {}\n").unwrap();

        assert!(is_dirty(&tree).unwrap());
        assert!(
            !porcelain(dir.path()).contains("agent.rs"),
            "the agent's file must not appear in the project's status, got:\n{}",
            porcelain(dir.path())
        );
    }

    #[test]
    fn add_reuses_an_existing_directory() {
        let dir = repo();
        let session = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        let first = add(dir.path(), session).unwrap();
        fs::write(first.join("kept.rs"), "keep\n").unwrap();

        let second = add(dir.path(), session).expect("reuse rather than fail");
        assert_eq!(first, second);
        assert_eq!(fs::read_to_string(first.join("kept.rs")).unwrap(), "keep\n");
    }

    #[test]
    fn a_clean_worktree_removes() {
        let dir = repo();
        let session = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        let tree = add(dir.path(), session).unwrap();

        remove(dir.path(), &tree, false).unwrap();

        assert!(!tree.exists());
        let branches = {
            let git = program::find("git").unwrap();
            let output = Command::new(git)
                .args(["branch"])
                .current_dir(dir.path())
                .output()
                .unwrap();
            String::from_utf8_lossy(&output.stdout).into_owned()
        };
        assert!(
            !branches.contains("grokspace/aaaaaaaa"),
            "the session branch should go with the worktree, got:\n{branches}"
        );
    }

    #[test]
    fn a_dirty_worktree_is_refused_without_force() {
        let dir = repo();
        let tree = add(dir.path(), "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee").unwrap();
        fs::write(tree.join("agent.rs"), "fn main() {}\n").unwrap();

        let error = remove(dir.path(), &tree, false).unwrap_err();
        assert!(error.to_string().contains("uncommitted"), "got: {error}");
        assert!(tree.exists(), "refusing must leave the files");
    }

    #[test]
    fn force_removes_a_dirty_worktree() {
        let dir = repo();
        let tree = add(dir.path(), "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee").unwrap();
        fs::write(tree.join("agent.rs"), "fn main() {}\n").unwrap();

        remove(dir.path(), &tree, true).unwrap();
        assert!(!tree.exists());
    }

    #[test]
    fn removing_a_path_that_is_already_gone_succeeds() {
        let dir = repo();
        remove(dir.path(), &dir.path().join("missing"), false).unwrap();
    }

    #[test]
    fn a_missing_worktree_is_not_dirty() {
        assert!(!is_dirty(Path::new("/tmp/grokspace-no-such-worktree")).unwrap());
    }
}
