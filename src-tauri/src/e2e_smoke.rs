//! TEST-002: one smoke across a fixture folder, a shell pane, and `graph:demo`.
//!
//! This is a host smoke, not a WebView driver. `create_session` needs an
//! `AppHandle`; the pieces a pane actually uses do not: `open_folder` registers
//! the project, `session_env` is what a shell is spawned with, the pty is the
//! pane, and `graph::snapshot` is what the Graph tab reads after a write.
//!
//! A Playwright/WebView pass is skipped when this machine has no display — see
//! `scripts/e2e-smoke.mjs`. Linux CI has WebKitGTK to *link* Tauri, not a window.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use crate::db;
use crate::graph;
use crate::program;
use crate::project;
use crate::pty::{OutputSink, PtyManager, SpawnOptions};
use crate::session::{self, SessionKind};

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[derive(Default)]
struct Collector(Mutex<Vec<u8>>);

impl Collector {
    fn text(&self) -> String {
        String::from_utf8_lossy(&lock(&self.0)).into_owned()
    }
}

impl OutputSink for Collector {
    fn emit(&self, bytes: &[u8]) {
        lock(&self.0).extend_from_slice(bytes);
    }
}

fn wait_for(label: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if done() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("timed out waiting for {label}");
}

fn demo_script() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/demo-graph.mjs")
}

fn node_bin() -> Option<String> {
    match program::find("node") {
        Some(path) => Some(path),
        None if std::env::var_os("GROKSPACE_E2E").is_some() => {
            panic!("TEST-002 needs node on PATH to run scripts/demo-graph.mjs");
        }
        None => {
            eprintln!(
                "skip TEST-002: node is not on PATH (needed for graph:demo). \
                 Run via `npm run test:e2e`."
            );
            None
        }
    }
}

/// Open a fixture folder, start a shell pane, run `graph:demo` in it, then
/// read the file the Graph tab would draw.
#[test]
fn e2e_fixture_shell_pane_then_graph_demo() {
    let Some(node) = node_bin() else {
        return;
    };
    let demo = demo_script()
        .canonicalize()
        .expect("scripts/demo-graph.mjs should exist next to the crate");

    let fixture = tempfile::tempdir().expect("fixture folder");
    std::fs::write(fixture.path().join("README.md"), "e2e-fixture\n")
        .expect("the fixture should be a real folder");

    let conn = db::open_in_memory().expect("in-memory workspace db");
    let project = project::open_folder(
        &conn,
        fixture.path().to_str().expect("fixture path is UTF-8"),
    )
    .expect("open_folder is what Open Project… calls");
    assert!(
        Path::new(&project.path).ends_with(fixture.path().file_name().unwrap()),
        "the registered project should be the fixture, got {}",
        project.path
    );

    let session = session::insert(
        &conn,
        &project.id,
        Some("0"),
        SessionKind::Shell,
        "Shell",
        None,
    )
    .expect("a pane row");

    let mut env = session::session_env(Path::new(&project.path), &session.id);
    env.push(("GRAPH_DEMO_STEP_MS".into(), "1".into()));
    let graph_file = env
        .iter()
        .find(|(name, _)| name == "GROKSPACE_GRAPH_FILE")
        .map(|(_, value)| value.clone())
        .expect("a shell pane is told which graph file is its own");

    let empty = graph::snapshot(Path::new(&project.path), &session.id);
    assert!(
        empty.json.is_none(),
        "Graph should be empty before graph:demo writes"
    );

    let manager = PtyManager::new();
    let collector = Arc::new(Collector::default());
    let command = format!(
        "printf 'PANE_OK '; cat README.md; exec '{}' '{}' \"$GROKSPACE_GRAPH_FILE\"",
        node,
        demo.display()
    );

    manager
        .spawn(
            SpawnOptions {
                id: session.id.clone(),
                program: "/bin/sh".into(),
                args: vec!["-c".into(), command],
                cwd: PathBuf::from(&project.path),
                env,
                unset_env: Vec::new(),
                cols: 80,
                rows: 24,
            },
            Box::new(|_| {}),
        )
        .expect("the shell pane should spawn");
    manager
        .attach(&session.id, collector.clone())
        .expect("the pane should attach");

    wait_for("shell pane output from the fixture", || {
        let text = collector.text();
        text.contains("PANE_OK") && text.contains("e2e-fixture")
    });
    wait_for("graph:demo to finish in the pane", || {
        collector
            .text()
            .contains("Done. The panel keeps drawing the file")
    });

    let snapshot = graph::snapshot(Path::new(&project.path), &session.id);
    manager.remove(&session.id);

    assert_eq!(snapshot.path, graph_file);
    assert!(snapshot.exists, "graph:demo should have written the file");
    let json = snapshot
        .json
        .expect("Graph reads this snapshot; it should be a document, not too-large/empty");
    assert!(
        json.contains("\"name\": \"Demo run\""),
        "Graph header shows the document name, got {json}"
    );
    assert!(
        json.contains("Orchestrator"),
        "Graph draws the demo orchestrator node, got {json}"
    );
}
