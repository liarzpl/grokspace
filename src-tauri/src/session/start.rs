//! Start a session: resolve the program, isolate an agent, spawn pty or ACP.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use super::db::{
    delete, get, insert, record_live_process, record_permission, sessions_for_pane,
    set_isolation_skip, set_status, set_worktree_path, Session, SessionKind, SessionStatus,
};
use super::worktree_cmds::{close_with, WorktreeTeardown};
use crate::error::{Error, Result};
use crate::pty::{ExitHandler, OutputSink, SpawnOptions};
use crate::{
    acp, graph, memory, policy, program, project, settings, steps, task, worktree, AppState,
};

/// Emitted when a child terminates. Status changes are infrequent, so the event
/// system is the right fit here; the output stream is not, and uses a channel.
const EXIT_EVENT: &str = "session-exited";

/// An agent's status changed. Only ACP sessions report these: a terminal has no
/// way to say what the process inside it is doing.
const STATUS_EVENT: &str = "session-status";

/// An agent is blocked on a permission it wants granted.
const PERMISSION_EVENT: &str = "session-permission";

/// An ACP session produced visible output: a message, a thought, a tool, or a plan.
const UPDATE_EVENT: &str = "session-update";

/// Isolation did not happen. The session still starts; the UI has to say so.
const ISOLATION_EVENT: &str = "session-isolation";

/// Raw bytes reach the webview as an `ArrayBuffer`. Sending a string instead
/// would have to decode UTF-8 in Rust, which corrupts any multi-byte sequence
/// that happens to straddle a read boundary.
pub(crate) struct ChannelSink(Channel<InvokeResponseBody>);

impl ChannelSink {
    pub(crate) fn new(channel: Channel<InvokeResponseBody>) -> Self {
        Self(channel)
    }
}

impl OutputSink for ChannelSink {
    fn emit(&self, bytes: &[u8]) {
        let _ = self.0.send(InvokeResponseBody::Raw(bytes.to_vec()));
    }
}

/// How a session is actually started, once its kind has been resolved to a
/// program. Split from `start` so a program that cannot be found fails before a
/// row is written for it.
pub(crate) enum Launch {
    /// On a pty, drawn in a pane.
    Terminal { program: String, args: Vec<String> },
    /// Over ACP, with no pane at all.
    Agent { program: String },
}

pub(crate) fn command_for(kind: SessionKind) -> Result<Launch> {
    #[cfg(test)]
    if let Some(program) = crate::TEST_LAUNCH_PROGRAM.with(|slot| slot.borrow().clone()) {
        return Ok(match kind {
            SessionKind::Agent => Launch::Agent { program },
            SessionKind::Grok | SessionKind::Shell => Launch::Terminal {
                program,
                args: Vec::new(),
            },
        });
    }

    match kind {
        SessionKind::Grok => Ok(Launch::Terminal {
            program: program::resolve("grok")?,
            // The working directory is set on the process itself, so `--cwd`
            // would be a second source of truth. `--no-auto-update` keeps
            // background update checks out of an automated session.
            args: vec!["--no-auto-update".to_string()],
        }),
        SessionKind::Shell => Ok(Launch::Terminal {
            program: std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string()),
            args: Vec::new(),
        }),
        // The subcommand and its flags belong to the ACP layer, which is what
        // knows the protocol it is about to speak.
        SessionKind::Agent => Ok(Launch::Agent {
            program: program::resolve("grok")?,
        }),
    }
}

/// What a session is told about itself: which graph and steps files are its own
/// to write, and where the project's shared memory is to be read.
///
/// Failing to prepare those directories is not worth refusing to start a terminal
/// over. The variables are still exported, so a writer that creates the directory
/// itself works either way.
pub(crate) fn session_env(project_path: &Path, session_id: &str) -> Vec<(String, String)> {
    let dir = graph::ensure_graph_dir(project_path)
        .unwrap_or_else(|_| graph::project_graph_dir(project_path));
    let file = dir.join(graph::graph_file_name(session_id));
    let steps_dir = steps::ensure_steps_dir(project_path)
        .unwrap_or_else(|_| steps::project_steps_dir(project_path));
    let steps_file = steps_dir.join(steps::steps_file_name(session_id));
    vec![
        ("GROKSPACE_SESSION_ID".to_string(), session_id.to_string()),
        (
            "GROKSPACE_PROJECT_DIR".to_string(),
            project_path.to_string_lossy().into_owned(),
        ),
        (
            "GROKSPACE_GRAPH_DIR".to_string(),
            dir.to_string_lossy().into_owned(),
        ),
        (
            "GROKSPACE_GRAPH_FILE".to_string(),
            file.to_string_lossy().into_owned(),
        ),
        (
            "GROKSPACE_STEPS_DIR".to_string(),
            steps_dir.to_string_lossy().into_owned(),
        ),
        (
            "GROKSPACE_STEPS_FILE".to_string(),
            steps_file.to_string_lossy().into_owned(),
        ),
        (
            "GROKSPACE_MEMORY_FILE".to_string(),
            memory::memory_file(project_path)
                .to_string_lossy()
                .into_owned(),
        ),
    ]
}

/// Host credential names a login shell must not inherit. Grok TUI and ACP
/// children still see them: those processes are the ones that call the API.
const SHELL_UNSET_ENV: &[&str] = &[
    "XAI_API_KEY",
    "GROK_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
];

pub(crate) fn env_to_unset(kind: SessionKind) -> Vec<String> {
    match kind {
        SessionKind::Shell => SHELL_UNSET_ENV
            .iter()
            .map(|name| (*name).to_string())
            .collect(),
        SessionKind::Grok | SessionKind::Agent => Vec::new(),
    }
}

/// The role a session was started as, for a skill or a hook to read.
///
/// Kept out of `session_env` because that one is derived from the project and the
/// session id alone, and this comes from the request. Absent rather than empty for a
/// session started by hand: an agent should be able to tell "no role" from a role
/// that happens to be blank.
pub(crate) fn role_env(role: Option<&str>) -> Vec<(String, String)> {
    role.map(str::trim)
        .filter(|role| !role.is_empty())
        .map(|role| vec![("GROKSPACE_SESSION_ROLE".to_string(), role.to_string())])
        .unwrap_or_default()
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionExited {
    id: String,
    exit_code: Option<i32>,
}

fn exit_handler<R: Runtime>(app: AppHandle<R>, id: String) -> ExitHandler {
    Box::new(move |exit| {
        let state = app.state::<AppState>();
        // Dropping the pty handles is what lets the reader thread finish.
        state.pty.remove(&id);
        if let Ok(conn) = state.db.lock() {
            let _ = set_status(&conn, &id, SessionStatus::Stopped, exit.code);
        }
        let _ = app.emit(
            EXIT_EVENT,
            SessionExited {
                id: id.clone(),
                exit_code: exit.code,
            },
        );
    })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionStatusChanged {
    id: String,
    status: SessionStatus,
}

/// What the agent's permission request is called on the frontend. Infrequent, and
/// nothing moves until it is answered, so the event system is the right fit.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PermissionAsked {
    id: String,
    request_id: u64,
    summary: String,
    options: Vec<acp::PermissionOption>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionUpdated {
    id: String,
    kind: acp::UpdateKind,
    text: String,
}

/// Why this agent is on the project tree. Infrequent; the row also stores
/// `isolation_skip` so a reload can say the same thing.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct IsolationFailed {
    id: String,
    reason: String,
}

/// The three things a live agent reports, each landing in the database first and on
/// the event system second, so a webview that reloads reads the same story.
fn acp_callbacks<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    project_path: PathBuf,
) -> acp::Callbacks {
    let status_app = app.clone();
    let status_id = id.clone();
    let permission_app = app.clone();
    let permission_id = id.clone();
    let update_app = app.clone();
    let update_id = id.clone();

    acp::Callbacks {
        on_status: std::sync::Arc::new(move |status| {
            let status = match status {
                acp::AgentStatus::Idle => SessionStatus::Idle,
                acp::AgentStatus::Running => SessionStatus::Running,
                acp::AgentStatus::NeedsInput => SessionStatus::NeedsInput,
            };
            let state = status_app.state::<AppState>();
            let mut reviewed_project = None;
            let mut review_path = None;
            let applied = if let Ok(conn) = state.db.lock() {
                match get(&conn, &status_id) {
                    // The process is gone, or the row already is. A late handshake
                    // Idle must not write or emit and bring a dead agent back.
                    Ok(current) if current.status == SessionStatus::Stopped => false,
                    Err(_) => false,
                    Ok(_) => {
                        // The exit code stays as it is: this is a change of what
                        // the agent is doing, not of whether its process is alive.
                        let _ = set_status(&conn, &status_id, status, None);
                        if status == SessionStatus::Idle {
                            review_path = get(&conn, &status_id)
                                .ok()
                                .and_then(|session| project::get(&conn, &session.project_id).ok())
                                .map(|project| project.path);
                        }
                        true
                    }
                }
            } else {
                false
            };
            if !applied {
                return;
            }
            if let Some(path) = review_path {
                if let Ok(moved) = task::review_on_idle(&state.db, &status_id, Path::new(&path)) {
                    reviewed_project = moved.first().map(|task| task.project_id.clone());
                }
            }
            let _ = status_app.emit(
                STATUS_EVENT,
                SessionStatusChanged {
                    id: status_id.clone(),
                    status,
                },
            );
            if let Some(project_id) = reviewed_project {
                let _ = status_app.emit(task::CHANGE_EVENT, task::TasksChanged { project_id });
            }
        }),
        on_permission: Box::new(move |request| {
            let state = permission_app.state::<AppState>();
            if let Some(allow) = policy::auto_reply_for(
                Some(project_path.as_path()),
                &request.summary,
                &request.options,
            ) {
                // Policy answers before chips. Allow-similar is allow_once only.
                if state
                    .acp
                    .answer_permission(&permission_id, request.id, allow, None)
                    .is_ok()
                {
                    return;
                }
            }
            if let Ok(conn) = state.db.lock() {
                let _ = record_permission(
                    &conn,
                    &permission_id,
                    request.id,
                    &request.summary,
                    &request.options,
                );
            }
            let _ = permission_app.emit(
                PERMISSION_EVENT,
                PermissionAsked {
                    id: permission_id.clone(),
                    request_id: request.id,
                    summary: request.summary,
                    options: request.options,
                },
            );
        }),
        on_update: std::sync::Arc::new(move |update| {
            let _ = update_app.emit(
                UPDATE_EVENT,
                SessionUpdated {
                    id: update_id.clone(),
                    kind: update.kind,
                    text: update.text,
                },
            );
        }),
        on_closed: Box::new(move || {
            let state = app.state::<AppState>();
            state.acp.remove(&id);
            if let Ok(conn) = state.db.lock() {
                let _ = set_status(&conn, &id, SessionStatus::Stopped, None);
            }
            // Reported as an exit like any other, so the frontend needs no second
            // path for an agent going away.
            let _ = app.emit(
                EXIT_EVENT,
                SessionExited {
                    id: id.clone(),
                    exit_code: None,
                },
            );
        }),
    }
}

pub(crate) struct StartRequest {
    pub(crate) project_id: String,
    pub(crate) pane_id: Option<String>,
    pub(crate) kind: SessionKind,
    pub(crate) title: Option<String>,
    pub(crate) role: Option<String>,
    pub(crate) cols: u16,
    pub(crate) rows: u16,
    /// Set on Restart so a new row keeps the files the previous run wrote.
    pub(crate) reuse_worktree: Option<PathBuf>,
    /// When isolation is skipped, start on the project tree only if this is set.
    /// The default is fail-closed: refuse rather than write on the live tree.
    pub(crate) allow_unisolated: bool,
}

/// A clean checkout for an ACP agent, when git will give us one.
///
/// Grok panes and shells stay on the project folder. Missing git, a folder that
/// is not a repository, or a failed `worktree add` is a skip. `start` refuses
/// that skip unless `allow_unisolated` is set. `None` here means "not an agent";
/// a skip is `Some(Skipped(...))`, which is what the UI needs to tell apart from
/// a grok pane that was never meant to isolate.
pub(crate) fn isolate_agent(
    request: &StartRequest,
    session: &Session,
    project_path: &Path,
) -> Option<worktree::Isolation> {
    if request.kind != SessionKind::Agent {
        return None;
    }
    if let Some(existing) = request
        .reuse_worktree
        .as_ref()
        .filter(|path| worktree::is_checkout(path))
    {
        // Restart keeps the files. Do not recopy worktreeinclude over them.
        return Some(worktree::Isolation::Isolated(existing.clone()));
    }
    // Fresh trees copy `.grokspace/worktreeinclude` inside `worktree::add`.
    // A missing or refused line is a skip reason, not an isolation skip.
    // Opt-in setup runs in `start` after this: Restart must not run it again.
    Some(worktree::add(project_path, &session.id))
}

/// Creates the row first and spawns second. The other order races: a child that
/// exits immediately would fire its exit handler before the row it needs to
/// update exists.
pub(crate) fn start<R: Runtime>(
    app: &AppHandle<R>,
    state: &State<'_, AppState>,
    request: StartRequest,
) -> Result<Session> {
    let launch = command_for(request.kind)?;

    // The schema does not unique `pane_id`. A Start that races `loadSessions`
    // (or a second Start on a pane that already has a row) would otherwise
    // leave a live pty the UI can no longer see.
    if let Some(pane_id) = request.pane_id.as_deref() {
        let occupants = {
            let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
            sessions_for_pane(&conn, &request.project_id, pane_id)?
        };
        for occupant in occupants {
            close_with(state, &occupant.id, WorktreeTeardown::Remove)?;
        }
    }

    let (session, project_path, remembered, run_setup) = {
        let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
        let project = project::get(&conn, &request.project_id)?;
        // A role makes a better title than the kind does: five agents all called
        // "Agent" are five things nobody can tell apart.
        let title = request
            .title
            .clone()
            .or_else(|| request.role.clone())
            .unwrap_or_else(|| request.kind.default_title().to_string());
        let run_setup = settings::get(&conn)
            .ok()
            .is_some_and(|prefs| prefs.run_worktree_setup == settings::WorktreeSetup::On);
        (
            insert(
                &conn,
                &request.project_id,
                request.pane_id.as_deref(),
                request.kind,
                &title,
                request.role.as_deref(),
            )?,
            project.path,
            memory::list(&conn, &request.project_id)?,
            run_setup,
        )
    };

    let project_path = PathBuf::from(project_path);
    let reused = request
        .reuse_worktree
        .as_ref()
        .is_some_and(|path| worktree::is_checkout(path));
    let isolation = isolate_agent(&request, &session, &project_path).map(|outcome| {
        if reused {
            outcome
        } else {
            worktree::apply_setup_to_isolation(
                &project_path,
                outcome,
                run_setup,
                worktree::SETUP_TIMEOUT,
            )
        }
    });
    if let Some(worktree::Isolation::Skipped(skip)) = &isolation {
        if !request.allow_unisolated {
            // Fail-closed: do not write on the project tree unless the caller
            // confirmed. Drop the row (and any leftover dest) so a refused
            // start looks like it never happened.
            let dest = worktree::path_for(&project_path, &session.id);
            if dest.exists() {
                let _ = worktree::remove(&project_path, &dest, true);
            }
            if let Ok(conn) = state.db.lock() {
                let _ = delete(&conn, &session.id);
            }
            return Err(Error::Invalid(format!(
                "isolation did not happen ({}); confirm to start on the project tree",
                skip.as_str()
            )));
        }
        // Confirmed. The event is how the live UI learns why; isolation_skip
        // is how a reload keeps the same sentence.
        let _ = app.emit(
            ISOLATION_EVENT,
            IsolationFailed {
                id: session.id.clone(),
                reason: skip.as_str().to_string(),
            },
        );
        if let Ok(conn) = state.db.lock() {
            let _ = set_isolation_skip(&conn, &session.id, Some(skip.as_str()));
        }
    }
    let worktree = isolation.and_then(worktree::Isolation::path);
    if let Some(ref path) = worktree {
        // Best-effort: a row without the path still starts, and Diff simply
        // will not offer this session as a scope.
        if let Ok(conn) = state.db.lock() {
            let _ = set_worktree_path(&conn, &session.id, Some(path));
        }
    }

    // Deliberately after the lock is dropped, since this writes a file and every
    // command queues on the one connection. Written even when the memory is empty:
    // the session is about to be told to read this path, and a file saying there is
    // nothing to know is friendlier than one that is missing. Always the project
    // folder, not the worktree: memory is shared.
    let _ = memory::write_projection(&project_path, &remembered);
    let mut env = session_env(&project_path, &session.id);
    env.extend(role_env(session.role.as_deref()));
    if let Some(ref path) = worktree {
        env.push((
            "GROKSPACE_WORKTREE".to_string(),
            path.to_string_lossy().into_owned(),
        ));
    }
    let cwd = worktree.clone().unwrap_or_else(|| project_path.clone());
    // An agent is told where its graph belongs the same way a terminal is, which is
    // what lets the Graph tab draw a plan for a session that has no pane.
    let spawned = match launch {
        Launch::Terminal { program, args } => state.pty.spawn(
            SpawnOptions {
                id: session.id.clone(),
                program,
                args,
                env,
                unset_env: env_to_unset(request.kind),
                cwd,
                cols: request.cols,
                rows: request.rows,
            },
            exit_handler(app.clone(), session.id.clone()),
        ),
        Launch::Agent { program } => state.acp.start(
            acp::StartOptions {
                id: session.id.clone(),
                program,
                cwd,
                env,
            },
            acp_callbacks(app.clone(), session.id.clone(), project_path.clone()),
        ),
    };

    match spawned {
        Ok(process_id) => {
            let became_idle = {
                let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
                record_live_process(&conn, &session.id, request.kind, process_id)?;
                request.kind == SessionKind::Agent
                    && get(&conn, &session.id)?.status == SessionStatus::Idle
            };
            // After the lock is dropped: the webview has to hear that an agent
            // which just finished its handshake is idle, not still `running`.
            if became_idle {
                let _ = app.emit(
                    STATUS_EVENT,
                    SessionStatusChanged {
                        id: session.id.clone(),
                        status: SessionStatus::Idle,
                    },
                );
            }
            let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
            get(&conn, &session.id)
        }
        Err(error) => {
            // Nothing was started, so leave no orphan row behind for a pane
            // that is about to go back to being empty. A worktree created for
            // this attempt would otherwise sit registered until git prune.
            if request.reuse_worktree.is_none() {
                if let Some(ref path) = worktree {
                    let _ = worktree::remove(&project_path, path, true);
                }
            }
            if let Ok(conn) = state.db.lock() {
                let _ = delete(&conn, &session.id);
            }
            Err(error)
        }
    }
}
