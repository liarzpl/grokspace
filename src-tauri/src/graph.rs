//! Graph documents, one per session.
//!
//! A session's graph is a file an agent writes; GrokSpace only reads it and says
//! when it changed. Two decisions shape this module:
//!
//! - **The file name is the session id.** Nothing has to be stored to remember
//!   which graph belongs to which terminal, and a restarted session — which mints
//!   a new id — correctly starts from no graph rather than inheriting the plan of
//!   the run it replaced.
//! - **The JSON is handed to the frontend unparsed.** The schema is a model's
//!   output, so it is validated by the deliberately forgiving `parseGraph` in
//!   `src/lib/graph.ts`. Parsing here too would mean two sources of truth, and
//!   the stricter one would reject graphs the panel can happily draw.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::error::{Error, Result};
use crate::skill::{Skill, SkillFile, SkillStatus};
use crate::{db, project, session, AppState};

/// Emitted when a session's graph file appears, changes, or goes away. Like the
/// session exit event this is infrequent, which is what the event system is for.
const CHANGE_EVENT: &str = "graph-changed";

/// The most a graph file may be before it is refused unread.
///
/// A graph is a plan: the bundled fixture is a few kilobytes and a thousand-node
/// document still sits well under a megabyte. This is high enough that no real
/// graph meets it, and low enough to stop an agent that redirects a log into
/// `GROKSPACE_GRAPH_FILE` from being carried across the IPC boundary.
const MAX_GRAPH_BYTES: u64 = 4 * 1024 * 1024;

/// The skill GrokSpace installs so `grok` knows to write these files at all.
///
/// Three files rather than one. `SKILL.md` is the runbook; the catalogue and the file
/// contract are read on demand, which is what keeps a two-node graph from costing an
/// agent twenty kilobytes of topology theory it does not need.
const SKILL: Skill = Skill {
    dir: "grokspace-graph",
    files: &[
        SkillFile {
            path: "SKILL.md",
            content: include_str!("../skills/grokspace-graph/SKILL.md"),
        },
        SkillFile {
            path: "references/catalog.md",
            content: include_str!("../skills/grokspace-graph/references/catalog.md"),
        },
        SkillFile {
            path: "references/graph-file.md",
            content: include_str!("../skills/grokspace-graph/references/graph-file.md"),
        },
    ],
};

/// Where a project's graphs live. Kept inside the project so a graph travels with
/// the code it describes, and so `grok` can write it without leaving its cwd.
pub fn project_graph_dir(project_path: &Path) -> PathBuf {
    project_path.join(".grokspace").join("graphs")
}

/// The fallback for a project directory that cannot be written to.
pub fn home_graph_dir() -> Result<PathBuf> {
    Ok(db::data_dir()?.join("graphs"))
}

pub fn graph_file_name(session_id: &str) -> String {
    format!("{session_id}.json")
}

/// Both places a session's graph may be found, in the order they are preferred.
fn graph_dirs(project_path: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![project_graph_dir(project_path)];
    if let Ok(home) = home_graph_dir() {
        if !dirs.contains(&home) {
            dirs.push(home);
        }
    }
    dirs
}

/// Creates the directory the agent will be told to write into, preferring the
/// project and falling back to `~/.grokspace/graphs` when the project folder is
/// read-only.
pub fn ensure_graph_dir(project_path: &Path) -> Result<PathBuf> {
    let preferred = project_graph_dir(project_path);
    if std::fs::create_dir_all(&preferred).is_ok() {
        return Ok(preferred);
    }
    let fallback = home_graph_dir()?;
    std::fs::create_dir_all(&fallback)?;
    Ok(fallback)
}

/// What the panel needs to draw a session's graph: the document, and the path to
/// name in the empty state when there is no document yet.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphSnapshot {
    pub session_id: String,
    /// The file that was read, or the one that is expected to appear.
    pub path: String,
    pub exists: bool,
    /// The file's contents, absent when the file is missing, still empty, or
    /// refused for its size.
    pub json: Option<String>,
    /// True when the file was past `MAX_GRAPH_BYTES` and so was never read. Told
    /// apart from an absent `json` because the panel has something honest to say
    /// about a file that is there but will not be opened.
    pub too_large: bool,
    /// Modification time in milliseconds, matching every other timestamp here.
    pub updated_at: Option<i64>,
}

fn mtime_ms(metadata: &std::fs::Metadata) -> Option<i64> {
    metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|since| since.as_millis() as i64)
}

/// Reads the first of `dirs` that holds a graph for the session. A file that
/// exists but is empty reads as absent: a writer that truncates before writing
/// leaves exactly that, and reporting it as a broken graph would make every
/// update flicker through an error.
fn snapshot_in(dirs: &[PathBuf], session_id: &str) -> GraphSnapshot {
    let file_name = graph_file_name(session_id);
    let mut expected: Option<PathBuf> = None;

    for dir in dirs {
        let candidate = dir.join(&file_name);
        if expected.is_none() {
            expected = Some(candidate.clone());
        }
        let Ok(metadata) = std::fs::metadata(&candidate) else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        // Checked before the read, which is the whole point: the size is already
        // in hand from the metadata above.
        let too_large = metadata.len() > MAX_GRAPH_BYTES;
        let json = if too_large {
            None
        } else {
            match std::fs::read_to_string(&candidate) {
                Ok(text) if !text.trim().is_empty() => Some(text),
                _ => None,
            }
        };
        return GraphSnapshot {
            session_id: session_id.to_string(),
            path: candidate.to_string_lossy().into_owned(),
            exists: true,
            json,
            too_large,
            updated_at: mtime_ms(&metadata),
        };
    }

    GraphSnapshot {
        session_id: session_id.to_string(),
        path: expected.unwrap_or_default().to_string_lossy().into_owned(),
        exists: false,
        json: None,
        too_large: false,
        updated_at: None,
    }
}

pub fn snapshot(project_path: &Path, session_id: &str) -> GraphSnapshot {
    snapshot_in(&graph_dirs(project_path), session_id)
}

/// Removes the graph of a session that is going away for good.
///
/// Both directories are tried, for the same reason reading does: a graph written
/// during a spell when the project folder could not be written to is in the
/// fallback. Only the file named for this session is touched.
///
/// A failure is deliberately not reported. The caller is closing a terminal, and a
/// graph that would not delete is not worth refusing that over.
pub fn remove_graph(project_path: &Path, session_id: &str) {
    let file_name = graph_file_name(session_id);
    for dir in graph_dirs(project_path) {
        let _ = std::fs::remove_file(dir.join(&file_name));
    }
}

/// A graph file's session id, or `None` for anything else in the directory —
/// artifacts, temporary files a writer renames from, and subdirectories.
fn session_id_for(path: &Path, watched: &[PathBuf]) -> Option<String> {
    let parent = path.parent()?;
    if !watched.iter().any(|dir| dir == parent) {
        return None;
    }
    if path.extension()?.to_str()? != "json" {
        return None;
    }
    let stem = path.file_stem()?.to_str()?;
    (!stem.is_empty()).then(|| stem.to_string())
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphChanged {
    pub session_id: String,
    pub path: String,
    /// True when the file went away, so the panel can drop the graph it holds.
    pub removed: bool,
}

/// Watches `dirs` for graph files appearing, changing, and going away.
///
/// Split out from the command so the filtering can be tested against real
/// filesystem events without a webview to emit them to. The returned watcher owns
/// the background thread: dropping it stops the watch.
fn watch_dirs(
    dirs: &[PathBuf],
    on_change: impl Fn(GraphChanged) + Send + 'static,
) -> Result<RecommendedWatcher> {
    let watched = dirs.to_vec();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else { return };
        // Access events fire for reads, which includes GrokSpace's own.
        if !matches!(
            event.kind,
            EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
        ) {
            return;
        }
        for path in &event.paths {
            let Some(session_id) = session_id_for(path, &watched) else {
                continue;
            };
            on_change(GraphChanged {
                session_id,
                path: path.to_string_lossy().into_owned(),
                // A rename away from the path and an outright delete both leave
                // nothing behind, so existence is the honest signal rather than
                // the event kind, which differs per platform.
                removed: !path.exists(),
            });
        }
    })
    .map_err(|error| Error::Invalid(format!("could not watch for graph changes: {error}")))?;

    for dir in dirs {
        // Non-recursive: artifacts a run writes under the graph directory are not
        // graphs, and on a busy run they would be most of the events.
        watcher
            .watch(dir, RecursiveMode::NonRecursive)
            .map_err(|error| {
                Error::Invalid(format!(
                    "could not watch {}: {error}",
                    dir.to_string_lossy()
                ))
            })?;
    }

    Ok(watcher)
}

/// The directories a project's watcher covers.
///
/// Exactly one: the directory its sessions are being told to write into, which is
/// what `ensure_graph_dir` decides — creating it on the way, since notify cannot
/// watch a directory that does not exist and the first graph of a run creates the
/// directory along with the file.
///
/// Watching the fallback as well would put a watcher on `~/.grokspace/graphs` for
/// every open project, because they all share it, and so report every write landing
/// there once per project. A graph left in the fallback from a spell when the
/// project folder could not be written to is still found by `snapshot`, which reads
/// both; it is only no longer reported live.
fn watched_dirs(project_path: &Path) -> Vec<PathBuf> {
    ensure_graph_dir(project_path)
        .map(|dir| vec![dir])
        .unwrap_or_default()
}

/// One watcher per project, keyed by project id.
///
/// Asking again replaces that project's watcher rather than stacking a second one
/// that would double every event. Replacing rather than skipping also re-arms a
/// watch whose directory has since been deleted, which on Linux is dead.
///
/// There is deliberately no way to stop watching a single project. Watching is
/// arranged from a React effect, and an effect that both starts and stops the
/// watch races itself: development remounts every component, so the stop for the
/// first mount can reach the backend after the start for the second, leaving a
/// project silently unwatched. A watch left in place costs one directory watch and
/// keeps a project the user switches away from current for when they come back.
#[derive(Default)]
pub struct GraphWatchers {
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
}

impl GraphWatchers {
    pub fn new() -> Self {
        Self::default()
    }

    /// Starts watching a project's graph directory and returns what could be
    /// watched, which is empty when the directory could not be prepared at all.
    fn watch(&self, app: AppHandle, project_id: &str, project_path: &Path) -> Result<Vec<String>> {
        let existing: Vec<PathBuf> = watched_dirs(project_path)
            .into_iter()
            .filter(|dir| dir.is_dir())
            .collect();
        if existing.is_empty() {
            return Ok(Vec::new());
        }

        let watcher = watch_dirs(&existing, move |change| {
            let _ = app.emit(CHANGE_EVENT, change);
        })?;

        let mut watchers = self.watchers.lock().map_err(|_| Error::StatePoisoned)?;
        watchers.insert(project_id.to_string(), watcher);

        Ok(existing
            .into_iter()
            .map(|dir| dir.to_string_lossy().into_owned())
            .collect())
    }

    /// Drops every watcher. Called when the app quits, so no background thread
    /// outlives the window it was reporting to.
    pub fn shutdown(&self) {
        if let Ok(mut watchers) = self.watchers.lock() {
            watchers.clear();
        }
    }
}

#[tauri::command]
pub fn watch_project_graphs(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<String>> {
    let project_path = {
        let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
        project::get(&conn, &project_id)?.path
    };
    state
        .graphs
        .watch(app, &project_id, Path::new(&project_path))
}

#[tauri::command]
pub fn read_session_graph(state: State<'_, AppState>, session_id: String) -> Result<GraphSnapshot> {
    let project_path = {
        let conn = state.db.lock().map_err(|_| Error::StatePoisoned)?;
        let session = session::get(&conn, &session_id)?;
        project::get(&conn, &session.project_id)?.path
    };
    Ok(snapshot(Path::new(&project_path), &session_id))
}

#[tauri::command]
pub fn graph_skill_status() -> Result<SkillStatus> {
    SKILL.status()
}

#[tauri::command]
pub fn install_graph_skill() -> Result<SkillStatus> {
    SKILL.install()
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    use super::*;

    fn dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("temp dir should be created")
    }

    #[test]
    fn a_graph_lives_under_the_project_keyed_by_session_id() {
        let path = project_graph_dir(Path::new("/tmp/acme")).join(graph_file_name("abc-123"));

        assert_eq!(
            path,
            PathBuf::from("/tmp/acme/.grokspace/graphs/abc-123.json")
        );
    }

    #[test]
    fn a_missing_graph_still_names_the_file_that_is_expected() {
        let project = dir();

        let snapshot = snapshot(project.path(), "s1");

        assert!(!snapshot.exists);
        assert_eq!(snapshot.json, None);
        assert!(
            snapshot.path.ends_with(".grokspace/graphs/s1.json"),
            "the empty state has to be able to name the path, got {}",
            snapshot.path
        );
    }

    #[test]
    fn a_written_graph_is_read_back_verbatim() {
        let project = dir();
        let graphs = ensure_graph_dir(project.path()).unwrap();
        std::fs::write(graphs.join("s1.json"), r#"{"nodes":[]}"#).unwrap();

        let snapshot = snapshot(project.path(), "s1");

        assert!(snapshot.exists);
        assert_eq!(snapshot.json.as_deref(), Some(r#"{"nodes":[]}"#));
        assert!(snapshot.updated_at.is_some());
    }

    #[test]
    fn an_empty_file_reads_as_no_graph_yet() {
        // A writer that truncates before writing leaves this for a moment, and it
        // must not be reported as a graph that failed to parse.
        let project = dir();
        let graphs = ensure_graph_dir(project.path()).unwrap();
        std::fs::write(graphs.join("s1.json"), "   \n").unwrap();

        let snapshot = snapshot(project.path(), "s1");

        assert!(snapshot.exists);
        assert_eq!(snapshot.json, None);
        assert!(!snapshot.too_large);
    }

    /// The bytes need not be a document: this layer hands JSON to the frontend
    /// unparsed, so only the length decides.
    fn filler(bytes: u64) -> Vec<u8> {
        vec![b'x'; bytes as usize]
    }

    #[test]
    fn a_graph_past_the_size_cap_is_refused_unread() {
        let project = dir();
        let graphs = ensure_graph_dir(project.path()).unwrap();
        std::fs::write(graphs.join("s1.json"), filler(MAX_GRAPH_BYTES + 1)).unwrap();

        let snapshot = snapshot(project.path(), "s1");

        // Reported as present but unread, so the panel can say why rather than
        // waiting for a graph that has already arrived.
        assert!(snapshot.exists);
        assert!(snapshot.too_large);
        assert_eq!(snapshot.json, None);
    }

    #[test]
    fn a_graph_at_the_size_cap_is_still_read() {
        let project = dir();
        let graphs = ensure_graph_dir(project.path()).unwrap();
        std::fs::write(graphs.join("s1.json"), filler(MAX_GRAPH_BYTES)).unwrap();

        let snapshot = snapshot(project.path(), "s1");

        assert!(!snapshot.too_large, "the cap is a ceiling, not a threshold");
        assert_eq!(
            snapshot.json.map(|json| json.len() as u64),
            Some(MAX_GRAPH_BYTES)
        );
    }

    #[test]
    fn sessions_do_not_share_a_graph() {
        let project = dir();
        let graphs = ensure_graph_dir(project.path()).unwrap();
        std::fs::write(graphs.join("s1.json"), r#"{"name":"first"}"#).unwrap();
        std::fs::write(graphs.join("s2.json"), r#"{"name":"second"}"#).unwrap();

        assert_eq!(
            snapshot(project.path(), "s1").json.as_deref(),
            Some(r#"{"name":"first"}"#)
        );
        assert_eq!(
            snapshot(project.path(), "s2").json.as_deref(),
            Some(r#"{"name":"second"}"#)
        );
        assert!(!snapshot(project.path(), "s3").exists);
    }

    #[test]
    fn removing_a_session_takes_its_graph_and_nothing_else() {
        let project = dir();
        let graphs = ensure_graph_dir(project.path()).unwrap();
        std::fs::write(graphs.join("going.json"), r#"{"nodes":[]}"#).unwrap();
        std::fs::write(graphs.join("staying.json"), r#"{"nodes":[]}"#).unwrap();
        std::fs::write(graphs.join("notes.md"), "an artifact").unwrap();

        remove_graph(project.path(), "going");

        assert!(!snapshot(project.path(), "going").exists);
        assert!(
            snapshot(project.path(), "staying").exists,
            "a neighbour's plan is not this session's to delete"
        );
        assert!(graphs.join("notes.md").is_file());
    }

    #[test]
    fn removing_a_session_that_wrote_no_graph_is_quiet() {
        let project = dir();
        ensure_graph_dir(project.path()).unwrap();

        // A session can be closed before an agent ever reports a plan.
        remove_graph(project.path(), "never-wrote-one");
    }

    #[test]
    fn a_graph_is_found_in_the_fallback_directory_too() {
        // The project directory stands in for one that could not be written to,
        // which is what sends a writer to `~/.grokspace/graphs` instead.
        let home = dir();
        let dirs = vec![
            PathBuf::from("/proc/nonexistent-project/.grokspace/graphs"),
            home.path().to_path_buf(),
        ];
        std::fs::write(home.path().join("s1.json"), r#"{"nodes":[]}"#).unwrap();

        let snapshot = snapshot_in(&dirs, "s1");

        assert!(snapshot.exists);
        assert!(snapshot.path.starts_with(home.path().to_str().unwrap()));
    }

    #[test]
    fn ensure_graph_dir_prefers_the_project() {
        let project = dir();

        let graphs = ensure_graph_dir(project.path()).unwrap();

        assert_eq!(graphs, project_graph_dir(project.path()));
        assert!(graphs.is_dir());
    }

    #[test]
    fn a_project_is_watched_in_one_directory_only() {
        let project = dir();

        let watched = watched_dirs(project.path());

        // Not the fallback as well: every project shares it, so a watch on it here
        // would report each write landing there once per open project.
        assert_eq!(watched, vec![project_graph_dir(project.path())]);
    }

    #[test]
    fn a_project_that_cannot_hold_graphs_is_watched_in_the_fallback() {
        // /proc rejects the directory, which is what a read-only project folder
        // does too, and is where the writer will have been sent instead.
        let watched = watched_dirs(Path::new("/proc/nonexistent-project"));

        assert_eq!(watched, vec![home_graph_dir().unwrap()]);
    }

    #[test]
    fn only_json_files_directly_in_a_watched_directory_are_graphs() {
        let watched = vec![PathBuf::from("/w/graphs")];

        assert_eq!(
            session_id_for(Path::new("/w/graphs/s1.json"), &watched).as_deref(),
            Some("s1")
        );
        // A writer's temporary file, an artifact, and a subdirectory are not
        // graphs, and treating them as one would emit events for sessions that
        // do not exist.
        assert_eq!(
            session_id_for(Path::new("/w/graphs/s1.json.tmp"), &watched),
            None
        );
        assert_eq!(
            session_id_for(Path::new("/w/graphs/notes.md"), &watched),
            None
        );
        assert_eq!(
            session_id_for(Path::new("/w/graphs/artifacts/s1.json"), &watched),
            None
        );
        assert_eq!(
            session_id_for(Path::new("/elsewhere/s1.json"), &watched),
            None
        );
    }

    /// Polls rather than sleeping a fixed amount, matching the pty tests: fast
    /// when the platform's watcher is prompt, tolerant when it is not.
    fn next_change(changes: &mpsc::Receiver<GraphChanged>, session_id: &str) -> GraphChanged {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            match changes.recv_timeout(Duration::from_millis(250)) {
                Ok(change) if change.session_id == session_id => return change,
                // Writers produce several events per write; only the one being
                // waited for matters.
                Ok(_) => continue,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(error) => panic!("the watcher stopped: {error}"),
            }
        }
        panic!("timed out waiting for a change to {session_id}");
    }

    #[test]
    fn writing_a_graph_reports_the_session_it_belongs_to() {
        let graphs = dir();
        let (tx, changes) = mpsc::channel();
        let _watcher = watch_dirs(&[graphs.path().to_path_buf()], move |change| {
            let _ = tx.send(change);
        })
        .expect("the watcher should start");

        std::fs::write(graphs.path().join("s1.json"), r#"{"nodes":[]}"#).unwrap();

        let change = next_change(&changes, "s1");
        assert!(!change.removed);
        assert!(change.path.ends_with("s1.json"));
    }

    #[test]
    fn a_graph_renamed_over_its_target_is_reported_as_present() {
        // The skill and the demo script both write a temporary file and rename it
        // over the target, so a reader never sees a half-written document. The
        // rename produces different events per platform, which is why existence
        // rather than the event kind decides whether the file is there.
        let graphs = dir();
        let (tx, changes) = mpsc::channel();
        let _watcher = watch_dirs(&[graphs.path().to_path_buf()], move |change| {
            let _ = tx.send(change);
        })
        .expect("the watcher should start");

        let target = graphs.path().join("s1.json");
        let temporary = graphs.path().join("s1.json.tmp");
        std::fs::write(&temporary, r#"{"nodes":[]}"#).unwrap();
        std::fs::rename(&temporary, &target).unwrap();

        let change = next_change(&changes, "s1");
        assert!(!change.removed, "the graph is there, under its final name");
        assert!(snapshot_in(&[graphs.path().to_path_buf()], "s1").exists);
    }

    #[test]
    fn deleting_a_graph_is_reported_as_removed() {
        let graphs = dir();
        let file = graphs.path().join("s1.json");
        std::fs::write(&file, r#"{"nodes":[]}"#).unwrap();

        let (tx, changes) = mpsc::channel();
        let _watcher = watch_dirs(&[graphs.path().to_path_buf()], move |change| {
            let _ = tx.send(change);
        })
        .expect("the watcher should start");

        std::fs::remove_file(&file).unwrap();

        assert!(next_change(&changes, "s1").removed);
    }

    #[test]
    fn a_watcher_ignores_files_that_are_not_graphs() {
        let graphs = dir();
        let (tx, changes) = mpsc::channel();
        let _watcher = watch_dirs(&[graphs.path().to_path_buf()], move |change| {
            let _ = tx.send(change);
        })
        .expect("the watcher should start");

        std::fs::write(graphs.path().join("plan.md"), "not a graph").unwrap();
        std::fs::create_dir_all(graphs.path().join("artifacts")).unwrap();
        std::fs::write(graphs.path().join("artifacts/s9.json"), "{}").unwrap();
        // Written last, and reported: anything the watcher had queued before it
        // has arrived by the time this one does.
        std::fs::write(graphs.path().join("s1.json"), "{}").unwrap();

        let change = changes
            .recv_timeout(Duration::from_secs(10))
            .expect("the graph write should be reported");
        assert_eq!(change.session_id, "s1");
    }

    /// Installing is `skill.rs`'s job and tested there. What is this module's job is
    /// that the skill it ships names the variable the sessions are given, since a
    /// skill that names the wrong path teaches an agent to write where nobody reads.
    #[test]
    fn the_bundled_skill_names_the_environment_variable_it_relies_on() {
        let runbook = SKILL.content("SKILL.md").expect("a skill needs a SKILL.md");
        let contract = SKILL
            .content("references/graph-file.md")
            .expect("the file contract is what the runbook defers to");

        assert!(
            runbook.starts_with("---\n"),
            "Grok reads the frontmatter first"
        );
        assert!(runbook.contains("name: grokspace-graph"));
        assert_eq!(
            SKILL.dir, "grokspace-graph",
            "the directory is the skill's name"
        );
        assert!(runbook.contains("GROKSPACE_GRAPH_FILE"));
        assert!(contract.contains("GROKSPACE_GRAPH_FILE"));
        assert!(
            contract.contains("GROKSPACE_SESSION_ID"),
            "the fallback path"
        );
    }

    #[test]
    fn the_runbook_points_at_every_reference_that_ships_with_it() {
        // Grok reads SKILL.md and follows what it names. A reference nothing links to
        // is a file installed into the user's home that will never be opened.
        let runbook = SKILL.content("SKILL.md").expect("a skill needs a SKILL.md");

        for file in SKILL.files {
            if file.path == "SKILL.md" {
                continue;
            }
            assert!(
                runbook.contains(file.path),
                "SKILL.md does not mention {}, so nothing will ever read it",
                file.path
            );
        }
    }

    #[test]
    fn the_contract_forbids_the_fixed_filename_that_hid_graphs_from_the_panel() {
        // The whole reason this skill was merged. A skill writing a fixed
        // `current-graph.json` writes somewhere GrokSpace does not watch, and the panel
        // sits empty while the run happens. The fallback is still documented for use
        // outside GrokSpace, so the guard has to be the prohibition, not the absence.
        let contract = SKILL.content("references/graph-file.md").unwrap();

        assert!(contract
            .contains("Never write `current-graph.json` when `$GROKSPACE_GRAPH_FILE` is set."));
    }

    #[test]
    fn the_contract_states_the_statuses_the_parser_actually_accepts() {
        // parseGraph falls back to `agent` for an unknown type and `pending` for an
        // unknown status, so a skill listing a value the parser does not know produces
        // a graph that quietly misreports the run.
        let contract = SKILL.content("references/graph-file.md").unwrap();

        for value in [
            "orchestrator",
            "parallel-group",
            "arena",
            "verifier",
            "human-gate",
            "synthesizer",
            "skipped",
            "partial",
            "smoothstep",
        ] {
            assert!(
                contract.contains(value),
                "the contract does not mention `{value}`"
            );
        }
    }
}
