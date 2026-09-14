//! Shared directory watch for `{session_id}.json` files.
//!
//! Graph and steps each used to copy `session_id_for` and the notify loop.
//! Ingest vs snapshot stay in those modules; this only says which session a
//! create/modify/remove in a watched directory belongs to.

use std::path::{Path, PathBuf};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use crate::error::{Error, Result};

/// A `{session_id}.json` file sitting directly in a watched directory.
///
/// Artifacts, writer temp files, and subdirectories are not sessions. Treating
/// them as one would emit events for ids that do not exist.
pub fn session_id_for(path: &Path, watched: &[PathBuf]) -> Option<String> {
    let parent = path.parent()?;
    if !watched.iter().any(|dir| dir == parent) {
        return None;
    }
    if path.extension()?.to_str()? != "json" {
        return None;
    }
    let stem = path.file_stem()?.to_str()?;
    // Host sidecar `<id>.permissions.json` sits next to the agent graph.
    if stem.is_empty() || stem.ends_with(".permissions") {
        return None;
    }
    Some(stem.to_string())
}

/// Watches `dirs` non-recursively for session JSON appearing, changing, or going
/// away. The returned watcher owns the background thread: dropping it stops the
/// watch.
pub fn watch_session_json_dir(
    dirs: &[PathBuf],
    what: &str,
    on_change: impl Fn(String, PathBuf) + Send + 'static,
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
        for path in event.paths {
            let Some(session_id) = session_id_for(&path, &watched) else {
                continue;
            };
            on_change(session_id, path);
        }
    })
    .map_err(|error| Error::Invalid(format!("could not watch for {what} changes: {error}")))?;

    for dir in dirs {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_json_files_directly_in_a_watched_directory_are_sessions() {
        let watched = vec![PathBuf::from("/w/graphs")];

        assert_eq!(
            session_id_for(Path::new("/w/graphs/s1.json"), &watched).as_deref(),
            Some("s1")
        );
        assert_eq!(
            session_id_for(Path::new("/w/graphs/s1.permissions.json"), &watched),
            None
        );
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
}
