//! Close, discard, merge, and merge-readiness for a session worktree.

use std::path::Path;

use super::db::{delete, get, set_worktree_path, Session, SessionStatus};
use crate::error::{Error, Result};
use crate::{graph, project, steps, worktree, AppState};
use serde::{Deserialize, Serialize};

/// Throws away a stopped agent's worktree so Close can proceed.
///
/// Refused while the process is still running: deleting its cwd from under it is
/// not a teardown, it is a crash. Refused when there is no worktree, so the
/// button is not a silent no-op.
pub(crate) fn discard(state: &AppState, id: &str) -> Result<Session> {
    let (session, project_path) = {
        let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
        let session = get(&conn, id)?;
        let project = project::get(&conn, &session.project_id)?;
        (session, project.path)
    };
    if session.status != SessionStatus::Stopped {
        return Err(Error::Invalid("stop the agent first".into()));
    }
    let Some(tree) = session.worktree_path.as_deref() else {
        return Err(Error::Invalid("this session has no worktree".into()));
    };
    worktree::remove(Path::new(&project_path), Path::new(tree), true)?;
    let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
    set_worktree_path(&conn, id, None)
}

/// Result of a merge that already landed the branch. Teardown is separate so
/// the frontend can drop the chip without matching an English error sentence.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeOutcome {
    pub session: Session,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub teardown_error: Option<String>,
}

/// Merges a stopped agent's worktree into the project branch.
///
/// Uncommitted files are committed on the session branch first: merging a
/// branch that has not moved past the project's `HEAD` would bring nothing.
/// Refused while the process is still running — the merge then removes the
/// tree, which is that process's cwd. Refused when the project tree is dirty,
/// so the agent's commit cannot land on top of uncommitted human work.
pub(crate) fn merge(state: &AppState, id: &str) -> Result<MergeOutcome> {
    let (session, project_path) = {
        let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
        let session = get(&conn, id)?;
        let project = project::get(&conn, &session.project_id)?;
        (session, project.path)
    };
    if session.status != SessionStatus::Stopped {
        return Err(Error::Invalid("stop the agent first".into()));
    }
    let Some(tree) = session.worktree_path.as_deref() else {
        return Err(Error::Invalid("this session has no worktree".into()));
    };
    worktree::merge_into_project(
        Path::new(&project_path),
        Path::new(tree),
        &merge_commit_message(&session),
    )?;
    // The work is already on the project. Force-remove so a leftover dirty
    // file cannot block teardown, and clear the path even if git still
    // cannot delete the folder — otherwise a retry hits "nothing to merge".
    let removed = worktree::remove(Path::new(&project_path), Path::new(tree), true);
    let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
    let session = set_worktree_path(&conn, id, None)?;
    Ok(MergeOutcome {
        session,
        teardown_error: removed.err().map(|error| error.to_string()),
    })
}

/// Why Merge would refuse this session, without committing or merging.
///
/// `None` means leftover commit + `git merge --no-edit` may run. Conflicts
/// are not predicted. The Diff panel reads this onto a strip so the reasons
/// are visible before a click, rather than only on the toast afterwards.
pub(crate) fn merge_readiness(state: &AppState, id: &str) -> Result<Option<String>> {
    let (session, project_path) = {
        let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
        let session = get(&conn, id)?;
        let project = project::get(&conn, &session.project_id)?;
        (session, project.path)
    };
    if session.status != SessionStatus::Stopped {
        return Ok(Some("stop the agent first".into()));
    }
    let Some(tree) = session.worktree_path.as_deref() else {
        return Ok(Some("this session has no worktree".into()));
    };
    worktree::merge_refusal(Path::new(&project_path), Path::new(tree))
}

fn merge_commit_message(session: &Session) -> String {
    let label = session
        .title
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .or_else(|| {
            session
                .role
                .as_deref()
                .map(str::trim)
                .filter(|text| !text.is_empty())
        })
        .unwrap_or("agent");
    let label = label.split_whitespace().collect::<Vec<_>>().join(" ");
    format!("GrokSpace: {label}")
}

pub(crate) enum WorktreeTeardown {
    /// `git worktree remove` without `--force`. Dirty trees refuse Close.
    Remove,
    /// Forget-project: the folder is leaving the sidebar, so leftovers must go.
    Force,
    /// Restart: the next row will keep these files.
    Keep,
}

/// Ends the session, kills its process, and drops its graph file.
///
/// `remove_project` calls `close_forgetting` for every session it is about to
/// forget, so a project leaving the sidebar cannot leave `grok` running behind
/// it, or a worktree registered after it is gone.
pub(crate) fn close(state: &crate::AppState, id: &str) -> Result<()> {
    close_with(state, id, WorktreeTeardown::Remove)
}

pub(crate) fn close_forgetting(state: &crate::AppState, id: &str) -> Result<()> {
    close_with(state, id, WorktreeTeardown::Force)
}

pub(crate) fn close_with(
    state: &crate::AppState,
    id: &str,
    teardown: WorktreeTeardown,
) -> Result<()> {
    let snapshot = {
        let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
        let session = get(&conn, id).ok();
        let project_path = session
            .as_ref()
            .and_then(|session| project::get(&conn, &session.project_id).ok())
            .map(|project| project.path);
        (session, project_path)
    };

    // Dirty / unmerged check before kill: Close must not eat a live agent's
    // files or the only copy of a landed-but-unmerged branch, and must not kill
    // it only to then refuse.
    if matches!(teardown, WorktreeTeardown::Remove) {
        if let (Some(session), Some(project_path)) = (&snapshot.0, &snapshot.1) {
            if let Some(tree) = session.worktree_path.as_deref() {
                let tree = Path::new(tree);
                if let Some(reason) = worktree::close_refusal(Path::new(project_path), tree)? {
                    return Err(Error::Invalid(reason));
                }
            }
        }
    }

    // Both are asked without checking which kind this is: whichever manager does
    // not hold the session says so and nothing happens, which is cheaper than
    // reading the row back to find out.
    let _ = state.acp.kill(id);
    state.acp.remove(id);
    let _ = state.pty.kill(id);
    state.pty.remove(id);

    if let (Some(session), Some(project_path)) = (&snapshot.0, &snapshot.1) {
        if let Some(tree) = session.worktree_path.as_deref() {
            let tree = Path::new(tree);
            match teardown {
                WorktreeTeardown::Remove | WorktreeTeardown::Force => {
                    let force = matches!(teardown, WorktreeTeardown::Force);
                    let _ = worktree::remove(Path::new(project_path), tree, force);
                }
                WorktreeTeardown::Keep => {}
            }
        }
    }

    let project_path = {
        let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
        let path = snapshot.1.clone();
        delete(&conn, id)?;
        path
    };

    // Deliberately after the lock is dropped: every command shares this one
    // connection, and remove_file can block on a slow or networked disk. Nothing
    // can surface this file again once the id has left the database, and restarting
    // closes a session too, so leaving it meant every restart added one.
    if let Some(path) = project_path {
        graph::remove_graph(Path::new(&path), id);
        steps::remove_steps_file(Path::new(&path), id);
    }

    Ok(())
}
