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
//! Merge commits leftover files on the session branch, then merges that branch
//! into the project. The worktree is left for the caller to remove.
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

fn git_error(output: &std::process::Output, fallback: &str) -> Error {
    let reason = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Error::Invalid(if reason.is_empty() {
        fallback.into()
    } else {
        reason
    })
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
        return Err(git_error(&output, "git status failed"));
    }
    Ok(!String::from_utf8_lossy(&output.stdout).trim().is_empty())
}

/// Paths GrokSpace owns under the project. Worktrees, graphs, steps, and memory
/// all live here; they are not the human's uncommitted work, so they must not
/// block a merge.
fn is_grokspace_path(path: &str) -> bool {
    let path = path.trim_matches('"');
    path == ".grokspace" || path.starts_with(".grokspace/")
}

fn porcelain_path(line: &str) -> &str {
    let rest = line.get(3..).unwrap_or("").trim();
    rest.rsplit_once(" -> ").map(|(_, to)| to).unwrap_or(rest)
}

/// Uncommitted changes in the project tree, ignoring `.grokspace/`.
fn is_project_dirty(git_path: &str, project_path: &Path) -> Result<bool> {
    let output = git(git_path, project_path, &["status", "--porcelain"])?;
    if !output.status.success() {
        return Err(git_error(&output, "git status failed"));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .any(|line| !line.trim().is_empty() && !is_grokspace_path(porcelain_path(line))))
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
        return Err(git_error(&output, "git could not remove the worktree"));
    }

    if let Some(branch) = branch {
        let _ = git(&git_path, project_path, &["branch", "-D", &branch]);
    }
    Ok(())
}

fn rev_parse(git_path: &str, cwd: &Path, rev: &str) -> Result<String> {
    let output = git(git_path, cwd, &["rev-parse", rev])?;
    if !output.status.success() {
        return Err(git_error(&output, "git could not read HEAD"));
    }
    let sha = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if sha.is_empty() {
        return Err(Error::Invalid("git could not read HEAD".into()));
    }
    Ok(sha)
}

fn commit_all(git_path: &str, worktree_path: &Path, message: &str) -> Result<()> {
    let add = git(git_path, worktree_path, &["add", "-A"])?;
    if !add.status.success() {
        return Err(git_error(&add, "git could not stage the agent's work"));
    }
    let commit = git(git_path, worktree_path, &["commit", "-m", message])?;
    if !commit.status.success() {
        return Err(git_error(&commit, "git could not commit the agent's work"));
    }
    Ok(())
}

/// Commits dirty files on the session branch, then merges that branch into the
/// project's current `HEAD`.
///
/// The worktree is left in place: the caller clears `worktree_path` and removes
/// the tree after the database agrees. Conflicts abort the merge so neither
/// tree is left half-applied.
///
/// Uncommitted agent work has to become a commit first: merging a branch that
/// has not moved past the project's `HEAD` brings nothing, which is why
/// GrokSpace would not own a commit until the Diff panel could show the work.
pub fn merge_into_project(project_path: &Path, worktree_path: &Path, message: &str) -> Result<()> {
    if !worktree_path.exists() {
        return Err(Error::Invalid("this session has no worktree".into()));
    }

    let git_path = program::find("git").ok_or_else(|| {
        Error::Invalid("git is not installed, so the worktree cannot be merged".into())
    })?;

    if is_project_dirty(&git_path, project_path)? {
        return Err(Error::Invalid("commit or stash the project first".into()));
    }

    if is_dirty(worktree_path)? {
        commit_all(&git_path, worktree_path, message)?;
    }

    let branch = current_branch(&git_path, worktree_path).ok_or_else(|| {
        Error::Invalid("this worktree is not on a branch, so there is nothing to merge".into())
    })?;

    let project_head = rev_parse(&git_path, project_path, "HEAD")?;
    let worktree_head = rev_parse(&git_path, worktree_path, "HEAD")?;
    if project_head == worktree_head {
        return Err(Error::Invalid("nothing to merge".into()));
    }

    let merged = git(&git_path, project_path, &["merge", "--no-edit", &branch])?;
    if !merged.status.success() {
        let _ = git(&git_path, project_path, &["merge", "--abort"]);
        return Err(git_error(
            &merged,
            "git could not merge the agent's branch — the merge was aborted",
        ));
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

    #[test]
    fn merge_commits_dirty_work_and_lands_it_on_the_project() {
        let dir = repo();
        let tree = add(dir.path(), "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee").unwrap();
        fs::write(tree.join("agent.rs"), "fn main() {}\n").unwrap();

        merge_into_project(dir.path(), &tree, "GrokSpace: agent").unwrap();

        assert_eq!(
            fs::read_to_string(dir.path().join("agent.rs")).unwrap(),
            "fn main() {}\n"
        );
        assert!(
            !porcelain(dir.path()).contains("agent.rs"),
            "the agent's file is committed on the project, not leftover dirty, got:\n{}",
            porcelain(dir.path())
        );
        assert!(tree.exists(), "the caller removes the worktree, not merge");
    }

    #[test]
    fn merge_refuses_a_dirty_project() {
        let dir = repo();
        let tree = add(dir.path(), "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee").unwrap();
        fs::write(tree.join("agent.rs"), "fn main() {}\n").unwrap();
        fs::write(dir.path().join("README.md"), "human edit\n").unwrap();

        let error = merge_into_project(dir.path(), &tree, "GrokSpace: agent").unwrap_err();
        assert!(
            error.to_string().contains("commit or stash"),
            "got: {error}"
        );
        assert!(
            !dir.path().join("agent.rs").exists(),
            "refusing must not copy the agent's file"
        );
        assert!(is_dirty(&tree).unwrap(), "the worktree must stay dirty");
    }

    #[test]
    fn merge_aborts_a_conflict_and_leaves_both_trees() {
        let dir = repo();
        let tree = add(dir.path(), "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee").unwrap();
        fs::write(tree.join("README.md"), "agent\n").unwrap();
        fs::write(dir.path().join("README.md"), "human\n").unwrap();
        let git = program::find("git").unwrap();
        for args in [vec!["add", "."], vec!["commit", "-qm", "human"]] {
            let done = Command::new(&git)
                .args(&args)
                .current_dir(dir.path())
                .output()
                .unwrap();
            assert!(done.status.success(), "git {args:?} failed");
        }

        let error = merge_into_project(dir.path(), &tree, "GrokSpace: agent").unwrap_err();
        assert!(
            !error.to_string().is_empty(),
            "a conflict has to say why it stopped"
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("README.md")).unwrap(),
            "human\n"
        );
        assert!(
            !porcelain(dir.path()).contains("UU"),
            "abort must not leave the project conflicted, got:\n{}",
            porcelain(dir.path())
        );
        assert!(tree.exists());
        assert_eq!(
            fs::read_to_string(tree.join("README.md")).unwrap(),
            "agent\n"
        );
    }

    #[test]
    fn a_clean_worktree_on_the_same_head_has_nothing_to_merge() {
        let dir = repo();
        let tree = add(dir.path(), "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee").unwrap();

        let error = merge_into_project(dir.path(), &tree, "GrokSpace: agent").unwrap_err();
        assert!(
            error.to_string().contains("nothing to merge"),
            "got: {error}"
        );
    }
}
