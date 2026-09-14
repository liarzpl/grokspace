//! Git worktrees for ACP agents.
//!
//! An agent writes in its own checkout so its diff is its own. Grok panes and
//! shells stay on the project folder: that is the tree a person is looking at.
//!
//! GrokSpace calls `git worktree add` itself rather than passing `grok --worktree`.
//! Every extra flag is a way for a session to fail to start on a `grok` that does
//! not recognise it — the same reason graphs, memory, and roles stay out of flags.
//!
//! Isolation is fail-closed at start. Missing git, a folder that is not a
//! repository, or a `worktree add` that fails is a skip with a reason. `start`
//! refuses that skip unless the caller confirms working on the project tree.
//! Silent `None` is how an agent would write on the project tree without anyone
//! being told; a skip is never silent.
//!
//! Merge commits leftover files on the session branch, then merges that branch
//! into the project. The worktree is left for the caller to remove.
//!
//! After a successful `worktree add`, listed paths from
//! `<project>/.grokspace/worktreeinclude` are copied into the new tree. A
//! missing source is a skip with a reason, not a failed start. Nothing is
//! copied by default — not `.env`. Restart reuses a checkout and does not
//! copy again.
//!
//! No Tauri, no database: tests drive real git against temporary repositories.

use std::fs;
use std::path::{Component, Path, PathBuf};
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

/// Whether `path` is the root of its own checkout, not a leftover folder
/// sitting inside the project tree (`rev-parse --is-inside-work-tree` is true
/// for those too).
fn is_worktree_root(git_path: &str, path: &Path) -> bool {
    let Ok(output) = git(git_path, path, &["rev-parse", "--show-toplevel"]) else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let toplevel = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    let (Ok(toplevel), Ok(path)) = (toplevel.canonicalize(), path.canonicalize()) else {
        return false;
    };
    toplevel == path
}

/// Whether `path` is a real git checkout GrokSpace can reuse, not a leftover
/// directory from a failed add or a partial teardown.
pub fn is_checkout(path: &Path) -> bool {
    let Some(git_path) = program::find("git") else {
        return false;
    };
    path.is_dir() && is_worktree_root(&git_path, path)
}

/// Why an ACP agent started in the project folder instead of its own checkout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IsolationSkip {
    GitMissing,
    NotARepo,
    Failed(String),
}

impl IsolationSkip {
    /// Short enough to sit in a banner, specific enough to tell the cases apart.
    pub fn as_str(&self) -> &str {
        match self {
            Self::GitMissing => "git is not installed",
            Self::NotARepo => "this folder is not a git repository",
            Self::Failed(reason) => reason,
        }
    }
}

/// Outcome of trying to give an ACP agent its own checkout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Isolation {
    Isolated(PathBuf),
    Skipped(IsolationSkip),
}

impl Isolation {
    pub fn path(self) -> Option<PathBuf> {
        match self {
            Self::Isolated(path) => Some(path),
            Self::Skipped(_) => None,
        }
    }
}

fn add_failed(reason: impl Into<String>) -> Isolation {
    let reason = reason.into();
    Isolation::Skipped(IsolationSkip::Failed(if reason.is_empty() {
        "git worktree add failed".into()
    } else {
        reason
    }))
}

fn worktree_stderr(output: &std::process::Output) -> String {
    let reason = String::from_utf8_lossy(&output.stderr).trim().to_string();
    reason
        .lines()
        .next()
        .unwrap_or("git worktree add failed")
        .to_string()
}

/// Creates a clean checkout of `HEAD` for this session, or a skip when isolation
/// is not possible. An existing git checkout is reused: Restart keeps the files.
/// A leftover directory that is not a worktree is replaced. A successful add
/// then copies paths listed in `.grokspace/worktreeinclude`.
pub fn add(project_path: &Path, session_id: &str) -> Isolation {
    let Some(git_path) = program::find("git") else {
        return Isolation::Skipped(IsolationSkip::GitMissing);
    };
    if !is_repo(&git_path, project_path) {
        return Isolation::Skipped(IsolationSkip::NotARepo);
    }

    let dest = path_for(project_path, session_id);
    if dest.is_dir() {
        if is_worktree_root(&git_path, &dest) {
            return Isolation::Isolated(dest);
        }
        // A failed add or partial teardown leaves a folder that is not a
        // checkout. Reusing it made Diff/Merge no-ops while the UI said Isolated.
        if let Err(error) = std::fs::remove_dir_all(&dest) {
            return add_failed(format!(
                "could not replace a leftover worktree directory: {error}"
            ));
        }
    }

    let Some(parent) = dest.parent() else {
        return add_failed("could not create the worktree directory");
    };
    if let Err(error) = std::fs::create_dir_all(parent) {
        return add_failed(format!("could not create the worktree directory: {error}"));
    }

    let branch = branch_name(session_id);
    let Some(dest_str) = dest.to_str() else {
        return add_failed("the worktree path is not valid UTF-8");
    };
    let output = match git(
        &git_path,
        project_path,
        &["worktree", "add", "-b", &branch, dest_str],
    ) {
        Ok(output) => output,
        Err(error) => return add_failed(error.to_string()),
    };
    if !output.status.success() {
        return add_failed(worktree_stderr(&output));
    }
    let _ = apply_include(project_path, &dest);
    Isolation::Isolated(dest)
}

/// `<project>/.grokspace/worktreeinclude` — one relative path per line.
pub(crate) fn include_file(project_path: &Path) -> PathBuf {
    project_path.join(".grokspace").join("worktreeinclude")
}

/// Copies listed project paths into a fresh worktree.
///
/// Each skip is a reason, not a start failure: a missing `.env.local` must
/// not refuse isolation. `**`, `..`, absolute paths, and anything that
/// leaves the project are refused. Restart reuses a checkout and does not
/// call this.
pub(crate) fn apply_include(project_path: &Path, dest: &Path) -> Vec<String> {
    let mut skips = Vec::new();
    let list = include_file(project_path);
    let text = match fs::read_to_string(&list) {
        Ok(text) => text,
        Err(error) => {
            if list.exists() {
                skips.push(format!(
                    "could not read .grokspace/worktreeinclude: {error}"
                ));
            }
            return skips;
        }
    };
    let Ok(project) = project_path.canonicalize() else {
        skips.push("could not resolve the project path".into());
        return skips;
    };
    let Ok(dest_root) = dest.canonicalize() else {
        skips.push("could not resolve the worktree path".into());
        return skips;
    };

    for line in text.lines() {
        let relative = match parse_include_line(line) {
            Ok(None) => continue,
            Ok(Some(path)) => path,
            Err(reason) => {
                skips.push(reason);
                continue;
            }
        };
        if let Err(reason) = copy_listed(&project, &dest_root, &relative) {
            skips.push(reason);
        }
    }
    skips
}

fn parse_include_line(raw: &str) -> std::result::Result<Option<PathBuf>, String> {
    let line = raw.trim().trim_start_matches('\u{feff}');
    if line.is_empty() || line.starts_with('#') {
        return Ok(None);
    }
    if line.contains("**") {
        return Err(format!("{line}: `**` is not allowed"));
    }
    let path = Path::new(line);
    if path.is_absolute() {
        return Err(format!("{line}: path must be relative to the project"));
    }
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(name) => parts.push(name.to_os_string()),
            Component::ParentDir => {
                return Err(format!("{line}: `..` is not allowed"));
            }
            Component::Prefix(_) | Component::RootDir => {
                return Err(format!("{line}: path must be relative to the project"));
            }
        }
    }
    if parts.is_empty() {
        return Err(format!(
            "{line}: path must be a file or folder inside the project"
        ));
    }
    if parts[0] == ".git" {
        return Err(format!("{line}: `.git` cannot be copied into a worktree"));
    }
    if parts[0] == ".grokspace" && parts.get(1).is_some_and(|part| part == "worktrees") {
        return Err(format!(
            "{line}: worktrees cannot be copied into a worktree"
        ));
    }
    Ok(Some(parts.into_iter().collect()))
}

fn copy_listed(
    project: &Path,
    dest_root: &Path,
    relative: &Path,
) -> std::result::Result<(), String> {
    let display = relative.display().to_string();
    let src = project.join(relative);
    if !src
        .symlink_metadata()
        .is_ok_and(|meta| meta.is_file() || meta.is_dir() || meta.file_type().is_symlink())
    {
        return Err(format!("{display}: missing, skipped"));
    }
    let canonical = match src.canonicalize() {
        Ok(path) => path,
        Err(_) => return Err(format!("{display}: missing, skipped")),
    };
    if canonical.strip_prefix(project).is_err() {
        return Err(format!("{display}: outside the project"));
    }
    let dest = dest_root.join(relative);
    if !dest.starts_with(dest_root) {
        return Err(format!("{display}: outside the project"));
    }
    copy_into(&src, &dest).map_err(|error| format!("{display}: {error}"))
}

fn copy_into(src: &Path, dest: &Path) -> std::io::Result<()> {
    let meta = src.symlink_metadata()?;
    if meta.is_dir() {
        fs::create_dir_all(dest)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            copy_into(&entry.path(), &dest.join(entry.file_name()))?;
        }
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    if meta.file_type().is_symlink() {
        let target = fs::read_link(src)?;
        if dest.exists() {
            fs::remove_file(dest)?;
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, dest)?;
        }
        #[cfg(not(unix))]
        {
            fs::copy(src, dest)?;
        }
        return Ok(());
    }
    fs::copy(src, dest)?;
    Ok(())
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

const UNCOMMITTED: &str =
    "this agent still has uncommitted work — discard it from the Diff panel first";
const UNMERGED: &str = "this agent has unmerged commits — merge or discard them first";

/// Why Close must not delete this worktree. `None` means remove may run.
///
/// Dirty trees and branches that are still ahead of the project are both
/// refused: the latter is committed work whose only copy is this branch.
pub fn close_refusal(project_path: &Path, worktree_path: &Path) -> Result<Option<String>> {
    if !worktree_path.exists() {
        return Ok(None);
    }
    if is_dirty(worktree_path)? {
        return Ok(Some(UNCOMMITTED.into()));
    }
    let Some(git_path) = program::find("git") else {
        return Ok(Some(
            "git is not installed, so the worktree cannot be removed".into(),
        ));
    };
    if has_unmerged_commits(&git_path, project_path, worktree_path)? {
        return Ok(Some(UNMERGED.into()));
    }
    Ok(None)
}

fn has_unmerged_commits(git_path: &str, project_path: &Path, worktree_path: &Path) -> Result<bool> {
    let project_head = rev_parse(git_path, project_path, "HEAD")?;
    let worktree_head = rev_parse(git_path, worktree_path, "HEAD")?;
    Ok(!is_ancestor(
        git_path,
        project_path,
        &worktree_head,
        &project_head,
    ))
}

/// Unregisters the worktree. Without `force`, a dirty tree or an unmerged
/// branch is refused so Close cannot eat work. The branch is deleted
/// afterwards: leaving one per session would pile up `grokspace/` names
/// nobody merges in this half.
pub fn remove(project_path: &Path, worktree_path: &Path, force: bool) -> Result<()> {
    if !worktree_path.exists() {
        return Ok(());
    }
    if !force {
        if let Some(reason) = close_refusal(project_path, worktree_path)? {
            return Err(Error::Invalid(reason));
        }
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
        return Err(commit_error(&commit));
    }
    Ok(())
}

fn commit_error(output: &std::process::Output) -> Error {
    let reason = String::from_utf8_lossy(&output.stderr);
    if reason.contains("user.email")
        || reason.contains("user.name")
        || reason.contains("tell me who you are")
    {
        return Error::Invalid("set git user.name and user.email".into());
    }
    git_error(output, "git could not commit the agent's work")
}

fn is_ancestor(git_path: &str, cwd: &Path, ancestor: &str, descendant: &str) -> bool {
    git(
        git_path,
        cwd,
        &["merge-base", "--is-ancestor", ancestor, descendant],
    )
    .ok()
    .is_some_and(|output| output.status.success())
}

const NO_WORKTREE: &str = "this session has no worktree";
const GIT_MISSING: &str = "git is not installed, so the worktree cannot be merged";
const PROJECT_DIRTY: &str = "commit or stash the project first";
const NOT_ON_A_BRANCH: &str = "this worktree is not on a branch, so there is nothing to merge";
const NOTHING_TO_MERGE: &str = "nothing to merge";
const MERGE_ABORTED: &str = "git could not merge the agent's branch — the merge was aborted";

/// Why Merge would refuse without writing. `None` means leftover commit +
/// `git merge --no-edit` may run. Conflicts are not predicted: they only
/// exist after that merge aborts.
pub fn merge_refusal(project_path: &Path, worktree_path: &Path) -> Result<Option<String>> {
    if !worktree_path.exists() {
        return Ok(Some(NO_WORKTREE.into()));
    }

    let Some(git_path) = program::find("git") else {
        return Ok(Some(GIT_MISSING.into()));
    };

    if is_project_dirty(&git_path, project_path)? {
        return Ok(Some(PROJECT_DIRTY.into()));
    }

    // A detached HEAD is refused even when leftover files would otherwise
    // make a commit. Inspect does not create that commit.
    if current_branch(&git_path, worktree_path).is_none() {
        return Ok(Some(NOT_ON_A_BRANCH.into()));
    }

    if is_dirty(worktree_path)? {
        return Ok(None);
    }

    let project_head = rev_parse(&git_path, project_path, "HEAD")?;
    let worktree_head = rev_parse(&git_path, worktree_path, "HEAD")?;
    if is_ancestor(&git_path, project_path, &worktree_head, &project_head) {
        return Ok(Some(NOTHING_TO_MERGE.into()));
    }

    Ok(None)
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
        return Err(Error::Invalid(NO_WORKTREE.into()));
    }

    let git_path = program::find("git").ok_or_else(|| Error::Invalid(GIT_MISSING.into()))?;

    if is_project_dirty(&git_path, project_path)? {
        return Err(Error::Invalid(PROJECT_DIRTY.into()));
    }

    if is_dirty(worktree_path)? {
        commit_all(&git_path, worktree_path, message)?;
    }

    let branch = current_branch(&git_path, worktree_path)
        .ok_or_else(|| Error::Invalid(NOT_ON_A_BRANCH.into()))?;

    let project_head = rev_parse(&git_path, project_path, "HEAD")?;
    let worktree_head = rev_parse(&git_path, worktree_path, "HEAD")?;
    if is_ancestor(&git_path, project_path, &worktree_head, &project_head) {
        return Err(Error::Invalid(NOTHING_TO_MERGE.into()));
    }

    let merged = git(&git_path, project_path, &["merge", "--no-edit", &branch])?;
    if !merged.status.success() {
        let _ = git(&git_path, project_path, &["merge", "--abort"]);
        return Err(git_error(&merged, MERGE_ABORTED));
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

    fn commit_in(tree: &Path, message: &str) {
        let git = program::find("git").expect("these tests need git");
        for args in [vec!["add", "."], vec!["commit", "-qm", message]] {
            let done = Command::new(&git)
                .args(&args)
                .current_dir(tree)
                .output()
                .expect("git should run");
            assert!(done.status.success(), "git {args:?} failed");
        }
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

    fn checkout(dir: &tempfile::TempDir, session: &str) -> PathBuf {
        add(dir.path(), session)
            .path()
            .expect("a real repo should isolate")
    }

    #[test]
    fn a_folder_that_is_not_a_repository_gets_no_worktree() {
        let dir = tempfile::tempdir().unwrap();
        let outcome = add(dir.path(), "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
        assert_eq!(outcome.clone().path(), None);
        assert_eq!(outcome, Isolation::Skipped(IsolationSkip::NotARepo));
    }

    #[test]
    fn skip_reasons_name_the_miss() {
        assert_eq!(IsolationSkip::GitMissing.as_str(), "git is not installed");
        assert_eq!(
            IsolationSkip::NotARepo.as_str(),
            "this folder is not a git repository"
        );
        assert_eq!(
            IsolationSkip::Failed("fatal: invalid reference: HEAD".into()).as_str(),
            "fatal: invalid reference: HEAD"
        );
    }

    #[test]
    fn a_blocked_worktree_path_gets_no_worktree() {
        let dir = repo();
        let session = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        let dest = path_for(dir.path(), session);
        fs::create_dir_all(dest.parent().unwrap()).unwrap();
        fs::write(&dest, "blocked\n").unwrap();

        let outcome = add(dir.path(), session);
        match outcome {
            Isolation::Skipped(IsolationSkip::Failed(reason)) => {
                assert!(!reason.is_empty(), "git stderr should explain the miss");
            }
            other => panic!("expected a failed add, got {other:?}"),
        }
    }

    #[test]
    fn add_checks_out_head_on_a_session_branch() {
        let dir = repo();
        let session = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        let tree = checkout(&dir, session);

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
        let tree = checkout(&dir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
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
        let first = checkout(&dir, session);
        fs::write(first.join("kept.rs"), "keep\n").unwrap();

        let second = add(dir.path(), session)
            .path()
            .expect("reuse rather than fail");
        assert_eq!(first, second);
        assert_eq!(fs::read_to_string(first.join("kept.rs")).unwrap(), "keep\n");
        assert!(is_checkout(&first));
    }

    #[test]
    fn add_replaces_a_leftover_directory_that_is_not_a_checkout() {
        let dir = repo();
        let session = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        let dest = path_for(dir.path(), session);
        fs::create_dir_all(&dest).unwrap();
        fs::write(dest.join("stale.txt"), "leftover\n").unwrap();

        let tree = add(dir.path(), session)
            .path()
            .expect("recreate rather than trust the leftover");
        assert_eq!(tree, dest);
        assert!(tree.join("README.md").is_file());
        assert!(!tree.join("stale.txt").exists());
        assert!(is_checkout(&tree));
    }

    #[test]
    fn include_lines_refuse_glob_dotdot_and_absolute_paths() {
        assert!(parse_include_line("**").unwrap_err().contains("`**`"));
        assert!(parse_include_line("src/**/lib")
            .unwrap_err()
            .contains("`**`"));
        assert!(parse_include_line("../secret")
            .unwrap_err()
            .contains("`..`"));
        assert!(parse_include_line("/etc/passwd")
            .unwrap_err()
            .contains("relative"));
        assert_eq!(
            parse_include_line(".env.local").unwrap().as_deref(),
            Some(Path::new(".env.local"))
        );
        assert_eq!(parse_include_line("# comment").unwrap(), None);
        assert_eq!(parse_include_line("  ").unwrap(), None);
    }

    #[test]
    fn worktreeinclude_copies_a_listed_file() {
        let dir = repo();
        fs::create_dir_all(dir.path().join(".grokspace")).unwrap();
        fs::write(dir.path().join(".env.local"), "copied=1\n").unwrap();
        fs::write(
            include_file(dir.path()),
            ".env.local\n# ignored\n\nmissing.local\n",
        )
        .unwrap();

        let tree = checkout(&dir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
        let skips = apply_include(dir.path(), &tree);

        assert_eq!(
            fs::read_to_string(tree.join(".env.local")).unwrap(),
            "copied=1\n"
        );
        assert!(
            skips.iter().any(|reason| reason.contains("missing")),
            "missing sources skip with a reason, got {skips:?}"
        );
        assert!(is_checkout(&tree), "copy must leave a worktree");
    }

    #[test]
    fn worktreeinclude_copies_a_listed_directory() {
        let dir = repo();
        fs::create_dir_all(dir.path().join("vendor/lib")).unwrap();
        fs::write(dir.path().join("vendor/lib/pkg.js"), "ok\n").unwrap();
        fs::create_dir_all(dir.path().join(".grokspace")).unwrap();
        fs::write(include_file(dir.path()), "vendor\n").unwrap();

        let tree = checkout(&dir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");

        assert_eq!(
            fs::read_to_string(tree.join("vendor/lib/pkg.js")).unwrap(),
            "ok\n"
        );
        assert!(is_checkout(&tree));
    }

    #[test]
    fn worktreeinclude_refuses_glob_and_dotdot_and_still_isolates() {
        let dir = repo();
        fs::create_dir_all(dir.path().join(".grokspace")).unwrap();
        fs::write(dir.path().join(".env"), "SECRET=1\n").unwrap();
        fs::write(include_file(dir.path()), "**\n../README.md\n/etc/passwd\n").unwrap();

        let tree = checkout(&dir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
        let skips = apply_include(dir.path(), &tree);

        assert!(
            skips.iter().any(|reason| reason.contains("`**`")),
            "{skips:?}"
        );
        assert!(
            skips.iter().any(|reason| reason.contains("`..`")),
            "{skips:?}"
        );
        assert!(
            skips.iter().any(|reason| reason.contains("relative")),
            "{skips:?}"
        );
        assert!(
            !tree.join(".env").exists(),
            "refused lines must not copy, and .env is not default-copied"
        );
        assert!(tree.join("README.md").is_file());
        assert!(is_checkout(&tree));
    }

    #[test]
    fn worktreeinclude_does_not_copy_env_unless_listed() {
        let dir = repo();
        fs::write(dir.path().join(".env"), "SECRET=1\n").unwrap();
        fs::write(dir.path().join(".env.local"), "local=1\n").unwrap();

        let tree = checkout(&dir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");

        assert!(!tree.join(".env").exists());
        assert!(!tree.join(".env.local").exists());
        assert!(is_checkout(&tree));
    }

    #[test]
    fn worktreeinclude_does_not_recopy_when_add_reuses_a_checkout() {
        let dir = repo();
        fs::create_dir_all(dir.path().join(".grokspace")).unwrap();
        fs::write(dir.path().join(".env.local"), "first\n").unwrap();
        fs::write(include_file(dir.path()), ".env.local\n").unwrap();

        let session = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        let first = checkout(&dir, session);
        fs::write(first.join(".env.local"), "kept\n").unwrap();
        fs::write(dir.path().join(".env.local"), "project-changed\n").unwrap();

        let second = add(dir.path(), session)
            .path()
            .expect("reuse rather than fail");
        assert_eq!(first, second);
        assert_eq!(
            fs::read_to_string(first.join(".env.local")).unwrap(),
            "kept\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn worktreeinclude_refuses_a_symlink_that_leaves_the_project() {
        let dir = repo();
        let outside = dir.path().parent().unwrap().join("outside-secret.txt");
        fs::write(&outside, "nope\n").unwrap();
        std::os::unix::fs::symlink(&outside, dir.path().join("escape")).unwrap();
        fs::create_dir_all(dir.path().join(".grokspace")).unwrap();
        fs::write(include_file(dir.path()), "escape\n").unwrap();

        let tree = checkout(&dir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
        let skips = apply_include(dir.path(), &tree);

        assert!(
            skips.iter().any(|reason| reason.contains("outside")),
            "{skips:?}"
        );
        assert!(!tree.join("escape").exists());
        assert!(is_checkout(&tree));
    }

    #[test]
    fn a_clean_worktree_removes() {
        let dir = repo();
        let session = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        let tree = checkout(&dir, session);

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
        let tree = checkout(&dir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
        fs::write(tree.join("agent.rs"), "fn main() {}\n").unwrap();

        let error = remove(dir.path(), &tree, false).unwrap_err();
        assert!(error.to_string().contains("uncommitted"), "got: {error}");
        assert!(tree.exists(), "refusing must leave the files");
    }

    #[test]
    fn a_clean_worktree_with_unmerged_commits_is_refused_without_force() {
        let dir = repo();
        let tree = checkout(&dir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
        fs::write(tree.join("agent.rs"), "fn main() {}\n").unwrap();
        commit_in(&tree, "agent");

        let error = remove(dir.path(), &tree, false).unwrap_err();
        assert!(error.to_string().contains("unmerged"), "got: {error}");
        assert!(tree.exists(), "refusing must leave the files");
        assert_eq!(
            close_refusal(dir.path(), &tree).unwrap().as_deref(),
            Some("this agent has unmerged commits — merge or discard them first")
        );
    }

    #[test]
    fn force_removes_a_worktree_with_unmerged_commits() {
        let dir = repo();
        let tree = checkout(&dir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
        fs::write(tree.join("agent.rs"), "fn main() {}\n").unwrap();
        commit_in(&tree, "agent");

        remove(dir.path(), &tree, true).unwrap();
        assert!(!tree.exists());
    }

    #[test]
    fn force_removes_a_dirty_worktree() {
        let dir = repo();
        let tree = checkout(&dir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
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
        let tree = checkout(&dir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
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
        let tree = checkout(&dir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
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
        let tree = checkout(&dir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
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
        let tree = checkout(&dir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");

        let error = merge_into_project(dir.path(), &tree, "GrokSpace: agent").unwrap_err();
        assert!(
            error.to_string().contains("nothing to merge"),
            "got: {error}"
        );
    }

    #[test]
    fn merge_refuses_when_the_worktree_is_behind_the_project() {
        let dir = repo();
        let tree = checkout(&dir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
        fs::write(dir.path().join("later.md"), "human\n").unwrap();
        let git = program::find("git").unwrap();
        for args in [vec!["add", "."], vec!["commit", "-qm", "later"]] {
            let done = Command::new(&git)
                .args(&args)
                .current_dir(dir.path())
                .output()
                .unwrap();
            assert!(done.status.success(), "git {args:?} failed");
        }

        let error = merge_into_project(dir.path(), &tree, "GrokSpace: agent").unwrap_err();
        assert!(
            error.to_string().contains("nothing to merge"),
            "got: {error}"
        );
        assert!(tree.exists(), "refusing must leave the worktree");
        assert_eq!(
            fs::read_to_string(dir.path().join("later.md")).unwrap(),
            "human\n"
        );
    }

    #[test]
    fn merge_refusal_names_a_dirty_project_without_writing() {
        let dir = repo();
        let tree = checkout(&dir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
        fs::write(tree.join("agent.rs"), "fn main() {}\n").unwrap();
        fs::write(dir.path().join("README.md"), "human edit\n").unwrap();

        assert_eq!(
            merge_refusal(dir.path(), &tree).unwrap().as_deref(),
            Some("commit or stash the project first")
        );
        assert!(
            !dir.path().join("agent.rs").exists(),
            "inspect must not copy the agent's file"
        );
        assert!(is_dirty(&tree).unwrap(), "inspect must not commit");
    }

    #[test]
    fn merge_refusal_names_nothing_to_merge_on_the_same_head() {
        let dir = repo();
        let tree = checkout(&dir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");

        assert_eq!(
            merge_refusal(dir.path(), &tree).unwrap().as_deref(),
            Some("nothing to merge")
        );
    }

    #[test]
    fn merge_refusal_is_silent_when_the_worktree_has_uncommitted_work() {
        let dir = repo();
        let tree = checkout(&dir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
        fs::write(tree.join("agent.rs"), "fn main() {}\n").unwrap();

        assert_eq!(merge_refusal(dir.path(), &tree).unwrap(), None);
        assert!(is_dirty(&tree).unwrap(), "inspect must not commit");
        assert!(
            !dir.path().join("agent.rs").exists(),
            "inspect must not merge"
        );
    }

    #[test]
    fn merge_refusal_names_a_missing_worktree() {
        let dir = repo();
        let missing = dir.path().join("no-such-worktree");

        assert_eq!(
            merge_refusal(dir.path(), &missing).unwrap().as_deref(),
            Some("this session has no worktree")
        );
    }

    #[test]
    fn merge_refusal_names_a_worktree_that_is_behind_the_project() {
        let dir = repo();
        let tree = checkout(&dir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
        fs::write(dir.path().join("later.md"), "human\n").unwrap();
        let git = program::find("git").unwrap();
        for args in [vec!["add", "."], vec!["commit", "-qm", "later"]] {
            let done = Command::new(&git)
                .args(&args)
                .current_dir(dir.path())
                .output()
                .unwrap();
            assert!(done.status.success(), "git {args:?} failed");
        }

        assert_eq!(
            merge_refusal(dir.path(), &tree).unwrap().as_deref(),
            Some("nothing to merge")
        );
        assert!(tree.exists(), "inspect must leave the worktree");
    }
}
