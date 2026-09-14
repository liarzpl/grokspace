//! Local-only file log.
//!
//! Command and UI errors are appended to `~/.grokspace/logs/grokspace.log`.
//! Nothing here opens a network socket; this is not telemetry.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

use crate::db;
use crate::error::{Error, Result};

const LOG_FILE_NAME: &str = "grokspace.log";
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;
const MAX_MESSAGE_CHARS: usize = 8 * 1024;

static LOG: Mutex<Option<File>> = Mutex::new(None);

/// `~/.grokspace/logs/grokspace.log`, next to the database.
pub fn default_path() -> Result<PathBuf> {
    Ok(db::data_dir()?.join("logs").join(LOG_FILE_NAME))
}

/// Opens the default log file. Safe to call more than once; later calls replace
/// the handle. Failures are swallowed so a missing home directory cannot stop
/// the app from starting.
pub fn init() {
    if let Ok(path) = default_path() {
        init_at(&path);
    }
}

pub fn init_at(path: &Path) {
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    rotate_if_needed(path);
    let Ok(file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    if let Ok(mut guard) = LOG.lock() {
        *guard = Some(file);
    }
}

fn rotate_if_needed(path: &Path) {
    let Ok(meta) = fs::metadata(path) else {
        return;
    };
    if meta.len() < MAX_LOG_BYTES {
        return;
    }
    let rotated = path.with_file_name("grokspace.log.1");
    let _ = fs::rename(path, rotated);
}

/// Same string the frontend sees for an `invoke` rejection, except
/// `SessionNotRunning` — that is the expected write/resize-after-exit path.
pub fn command_error(error: &Error) {
    if matches!(error, Error::SessionNotRunning) {
        return;
    }
    self::error("command", &error.to_string());
}

pub fn error(source: &str, message: &str) {
    write("error", source, message);
}

pub fn write(level: &str, source: &str, message: &str) {
    let line = format!("{} {level} {source} {}\n", db::now_ms(), one_line(message));
    if let Ok(mut guard) = LOG.lock() {
        if let Some(file) = guard.as_mut() {
            let _ = file.write_all(line.as_bytes());
            let _ = file.flush();
        }
    }
}

/// Logs a failed host event instead of `let _ = app.emit(...)`.
pub fn emit<R: Runtime, T: Serialize + Clone>(app: &AppHandle<R>, event: &str, payload: T) {
    if let Err(error) = app.emit(event, payload) {
        self::error("emit", &format!("{event}: {error}"));
    }
}

/// Frontend-originated line. The renderer has no other durable place to write.
#[tauri::command]
pub fn log_client_error(source: String, message: String) {
    error(&format!("ui:{source}"), &message);
}

fn one_line(message: &str) -> String {
    let collapsed = message.replace('\r', "\\r").replace('\n', "\\n");
    if collapsed.len() <= MAX_MESSAGE_CHARS {
        return collapsed;
    }
    let mut end = MAX_MESSAGE_CHARS;
    while end > 0 && !collapsed.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &collapsed[..end])
}

#[cfg(test)]
pub(crate) fn reset_for_tests() {
    if let Ok(mut guard) = LOG.lock() {
        *guard = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn with_log(test: impl FnOnce(&Path)) {
        let _guard = TEST_LOCK.lock().expect("log test lock");
        reset_for_tests();
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join(LOG_FILE_NAME);
        init_at(&path);
        test(&path);
        reset_for_tests();
    }

    fn read(path: &Path) -> String {
        fs::read_to_string(path).unwrap_or_default()
    }

    #[test]
    fn default_path_lives_next_to_the_database() {
        let path = default_path().expect("home directory");
        assert!(
            path.ends_with(Path::new(".grokspace").join("logs").join(LOG_FILE_NAME)),
            "{path:?}"
        );
    }

    #[test]
    fn command_error_writes_the_same_string_the_frontend_sees() {
        with_log(|path| {
            let error = Error::Invalid("the branch landed, but leftover files remain".into());
            let json = serde_json::to_string(&error).expect("serialize");
            assert_eq!(json, "\"the branch landed, but leftover files remain\"");
            let text = read(path);
            assert!(text.contains("error command the branch landed, but leftover files remain"));
        });
    }

    #[test]
    fn session_not_running_is_not_written() {
        with_log(|path| {
            let json = serde_json::to_string(&Error::SessionNotRunning).expect("serialize");
            assert_eq!(json, "\"that session is no longer running\"");
            assert!(!read(path).contains("no longer running"));
        });
    }

    #[test]
    fn client_error_is_prefixed_and_collapsed_to_one_line() {
        with_log(|path| {
            log_client_error("error-boundary".into(), "boom\n  at App".into());
            let text = read(path);
            assert!(text.contains("error ui:error-boundary boom\\n  at App"));
            assert_eq!(text.lines().count(), 1);
        });
    }

    #[test]
    fn oversized_files_rotate_on_init() {
        let _guard = TEST_LOCK.lock().expect("log test lock");
        reset_for_tests();
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join(LOG_FILE_NAME);
        fs::write(&path, vec![b'x'; (MAX_LOG_BYTES as usize) + 1]).expect("seed");
        init_at(&path);
        assert!(dir.path().join("grokspace.log.1").is_file());
        assert!(fs::metadata(&path).expect("new log").len() < MAX_LOG_BYTES);
        reset_for_tests();
    }
}
