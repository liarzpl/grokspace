//! TEST-006: `create_session` / `watch_project_*` against a mock `AppHandle`.

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::{Listener, Manager};

use crate::db;
use crate::graph::{self, GraphWatchers};
use crate::program;
use crate::project;
use crate::pty::PtyManager;
use crate::session::{self, NewSession};
use crate::steps::{self, StepWatchers};
use crate::worktree;
use crate::{acp, AppState};

const MISSING_PROGRAM: &str = "/grokspace-no-such-launch-program";

struct Emitted {
    name: String,
    payload: String,
}

struct OverrideLaunch(Option<String>);

impl OverrideLaunch {
    fn missing() -> Self {
        let previous =
            crate::TEST_LAUNCH_PROGRAM.with(|slot| slot.replace(Some(MISSING_PROGRAM.into())));
        Self(previous)
    }
}

impl Drop for OverrideLaunch {
    fn drop(&mut self) {
        crate::TEST_LAUNCH_PROGRAM.with(|slot| {
            slot.replace(self.0.take());
        });
    }
}

struct CommandApp {
    app: tauri::App<tauri::test::MockRuntime>,
    _dir: tempfile::TempDir,
    project_id: String,
    project_path: PathBuf,
    events: mpsc::Receiver<Emitted>,
}

impl CommandApp {
    fn new() -> Self {
        Self::at(tempfile::tempdir().expect("temp project"))
    }

    fn with_git_repo() -> Self {
        Self::at(git_repo())
    }

    fn at(dir: tempfile::TempDir) -> Self {
        let conn = db::open_in_memory().expect("in-memory database should open");
        let project = project::upsert_by_path(
            &conn,
            dir.path().to_str().expect("utf-8 path"),
            "command-test",
        )
        .expect("project should be created");
        let project_id = project.id.clone();
        let project_path = dir.path().to_path_buf();

        let app = tauri::test::mock_builder()
            .manage(AppState {
                db: std::sync::Mutex::new(conn),
                pty: PtyManager::new(),
                acp: acp::AcpManager::new(),
                graphs: GraphWatchers::new(),
                steps: StepWatchers::new(),
            })
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock AppHandle");

        let (tx, events) = mpsc::channel();
        let handle = app.handle().clone();
        for name in [
            "session-isolation",
            "session-status",
            "graph-changed",
            "steps-changed",
        ] {
            let tx = tx.clone();
            let name = name.to_string();
            handle.listen(name.clone(), move |event| {
                let _ = tx.send(Emitted {
                    name: name.clone(),
                    payload: event.payload().to_string(),
                });
            });
        }

        Self {
            app,
            _dir: dir,
            project_id,
            project_path,
            events,
        }
    }

    fn create(&self, session: NewSession) -> crate::error::Result<session::Session> {
        session::create_session(self.app.handle().clone(), self.app.state(), session)
    }

    fn drain(&self) -> Vec<Emitted> {
        let mut out = Vec::new();
        while let Ok(event) = self.events.try_recv() {
            out.push(event);
        }
        out
    }

    fn wait_for(&self, name: &str) -> Emitted {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            match self.events.recv_timeout(Duration::from_millis(250)) {
                Ok(event) if event.name == name => return event,
                Ok(_) => continue,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(error) => panic!("emit sink closed: {error}"),
            }
        }
        panic!("timed out waiting for {name}");
    }
}

fn new_session(project_id: &str, kind: &str, pane_id: Option<&str>) -> NewSession {
    serde_json::from_value(serde_json::json!({
        "projectId": project_id,
        "paneId": pane_id,
        "kind": kind,
        "cols": 80,
        "rows": 24,
    }))
    .expect("NewSession fixture")
}

fn git_run(dir: &Path, args: &[&str]) {
    let git = program::find("git").expect("these tests need git");
    let done = std::process::Command::new(git)
        .args(args)
        .current_dir(dir)
        .output()
        .expect("git should run");
    assert!(done.status.success(), "git {args:?} failed");
}

fn git_repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("temp dir should be created");
    git_run(dir.path(), &["init", "-q"]);
    git_run(dir.path(), &["config", "user.email", "test@grokspace.dev"]);
    git_run(dir.path(), &["config", "user.name", "GrokSpace Test"]);
    std::fs::write(dir.path().join("README.md"), "hello\n").unwrap();
    git_run(dir.path(), &["add", "."]);
    git_run(dir.path(), &["commit", "-qm", "first"]);
    dir
}

fn listed(app: &CommandApp) -> Vec<session::Session> {
    session::list_sessions(app.app.state(), app.project_id.clone()).expect("list")
}

fn worktree_dirs(project: &Path) -> Vec<PathBuf> {
    let root = worktree::path_for(project, "unused").parent().unwrap();
    std::fs::read_dir(root)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok().map(|e| e.path()))
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn create_session_starts_a_shell_and_keeps_the_row() {
    let app = CommandApp::new();

    let session = app
        .create(new_session(&app.project_id, "shell", Some("0")))
        .expect("a real shell should spawn");

    assert_eq!(session.kind, session::SessionKind::Shell);
    assert_eq!(session.pane_id.as_deref(), Some("0"));
    assert_eq!(listed(&app).len(), 1);
    assert!(
        !app.drain()
            .iter()
            .any(|event| event.name == "session-isolation"),
        "a shell is not isolated"
    );

    session::close_session(app.app.state(), session.id).expect("close");
    assert!(listed(&app).is_empty());
}

#[test]
fn create_session_spawn_failure_emits_isolation_and_deletes_the_row() {
    let app = CommandApp::new();
    let _override = OverrideLaunch::missing();

    let error = app
        .create(new_session(&app.project_id, "agent", None))
        .expect_err("a missing program must not leave a live session");

    assert!(
        error.to_string().contains("could not start"),
        "spawn fail, not command_for: {error}"
    );
    assert!(
        listed(&app).is_empty(),
        "start inserts before spawn; fail must delete the row"
    );

    let isolation = app
        .drain()
        .into_iter()
        .find(|event| event.name == "session-isolation")
        .expect("isolation skip is how the UI learns why");
    let payload: Value = serde_json::from_str(&isolation.payload).expect("isolation json");
    assert_eq!(
        payload["reason"].as_str(),
        Some("this folder is not a git repository")
    );
    assert!(payload["id"].as_str().is_some_and(|id| !id.is_empty()));
}

#[test]
fn create_session_spawn_failure_removes_the_worktree() {
    let app = CommandApp::with_git_repo();
    let _override = OverrideLaunch::missing();

    let error = app
        .create(new_session(&app.project_id, "agent", None))
        .expect_err("spawn should fail after isolation");

    assert!(error.to_string().contains("could not start"), "{error}");
    assert!(listed(&app).is_empty());
    assert!(
        !app.drain()
            .iter()
            .any(|event| event.name == "session-isolation"),
        "a real repo isolates; skip is not the cleanup under test"
    );
    assert!(
        app.project_path
            .join(".grokspace")
            .join("worktrees")
            .is_dir(),
        "add creates the parent before spawn; cleanup should not need to invent it"
    );
    assert!(
        worktree_dirs(&app.project_path).is_empty(),
        "a worktree created for a failed start must not stay registered"
    );
}

#[test]
fn watch_project_graphs_emits_graph_changed() {
    let app = CommandApp::new();
    let session = session::insert(
        &app.app.state().db.lock().expect("db"),
        &app.project_id,
        Some("0"),
        session::SessionKind::Grok,
        "Grok",
        None,
    )
    .unwrap();

    let watched = graph::watch_project_graphs(
        app.app.handle().clone(),
        app.app.state(),
        app.project_id.clone(),
    )
    .expect("watch should start");
    assert!(
        watched.iter().any(|dir| dir.ends_with(".grokspace/graphs")),
        "got {watched:?}"
    );

    let file = PathBuf::from(&watched[0]).join(graph::graph_file_name(&session.id));
    std::fs::write(&file, r#"{"nodes":[]}"#).unwrap();

    let change = app.wait_for("graph-changed");
    let payload: Value = serde_json::from_str(&change.payload).expect("graph-changed json");
    assert_eq!(payload["sessionId"].as_str(), Some(session.id.as_str()));
    assert_eq!(payload["removed"].as_bool(), Some(false));
}

#[test]
fn watch_project_steps_emits_steps_changed() {
    let app = CommandApp::new();
    let session = session::insert(
        &app.app.state().db.lock().expect("db"),
        &app.project_id,
        Some("0"),
        session::SessionKind::Grok,
        "Grok",
        None,
    )
    .unwrap();

    let watched = steps::watch_project_steps(
        app.app.handle().clone(),
        app.app.state(),
        app.project_id.clone(),
    )
    .expect("watch should start");
    assert!(
        watched.iter().any(|dir| dir.ends_with(".grokspace/steps")),
        "got {watched:?}"
    );

    let file = PathBuf::from(&watched[0]).join(steps::steps_file_name(&session.id));
    std::fs::write(&file, r#"{"steps":[{"title":"Read it"}]}"#).unwrap();

    let change = app.wait_for("steps-changed");
    let payload: Value = serde_json::from_str(&change.payload).expect("steps-changed json");
    assert_eq!(payload["sessionId"].as_str(), Some(session.id.as_str()));
}
